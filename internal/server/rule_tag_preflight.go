package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errTagAllowlistUnsupported = errors.New("tag allowlist selection is not currently representable")

// These are tag conversion proofs, not branch CODE-write or Git authority.
// v1.27.3 ToTagProtection selects retained explicit Access rows plus members of
// attached teams with CODE/PULLS read access, and the actual personal owner.
func tagTeamEligible(team forgeOrganizationTeam) bool {
	for _, unit := range []string{"repo.code", "repo.pulls"} {
		switch team.UnitPermissions[unit] {
		case "read", "write", "admin", "owner":
			return true
		}
	}
	return false
}

type tagUserProof struct {
	ID                                   int64
	Login, Permission, TeamConfiguration string
	TeamID                               int64
}
type tagTeamProof struct {
	ID                  int64
	Name, Configuration string
}

// No proof is persisted or exposed. Exact selected identities are compared again
// after waits; observations remain non-atomic with the supported native write.
func (s *Server) tagAllowlistProof(ctx context.Context, token forgeCredential, key repositoryKey, m *golfv1.MutateRepositoryRulesRequest, organization bool) (string, error) {
	if m.DesiredTag == nil {
		return "", nil
	}
	row, _, err := s.readRepositorySettings(ctx, token, key)
	if err != nil {
		return "", err
	}
	if strconv.FormatInt(row.ID, 10) != m.RepositoryId || strconv.FormatInt(row.Owner.ID, 10) != m.OwnerId {
		return "", errRepositoryAccessConflict
	}
	proof := struct {
		RepositoryID, OwnerID int64
		Private, Organization bool
		Users                 []tagUserProof
		Teams                 []tagTeamProof
	}{RepositoryID: row.ID, OwnerID: row.Owner.ID, Private: row.Private, Organization: organization}
	base, _ := repositoryPath(key)
	var org forgeOrganization
	var teams []repositoryNativeTeam
	loaded := false
	exactTeams := map[int64]forgeOrganizationTeam{}
	loadTeams := func() error {
		if loaded {
			return nil
		}
		if !organization {
			return errTagAllowlistUnsupported
		}
		if _, e := s.forge(ctx, http.MethodGet, "/orgs/"+key.Owner, token, nil, &org); e != nil {
			return e
		}
		if !validOrganization(org) || org.ID != row.Owner.ID || org.Name != row.Owner.Login {
			return errRepositoryAccessConflict
		}
		headers, e := s.forge(ctx, http.MethodGet, base+"/teams", token, nil, &teams)
		if e != nil {
			return e
		}
		if len(teams) > 500 {
			return errForgeResponseTooLarge
		}
		if teams == nil || headers.Get("Link") != "" {
			return errInvalidForgeResponse
		}
		if total := headers.Get("X-Total-Count"); total != "" && total != strconv.Itoa(len(teams)) {
			return errInvalidForgeResponse
		}
		ids, names := map[int64]bool{}, map[string]bool{}
		for _, team := range teams {
			if ids[team.ID] || names[strings.ToLower(team.Name)] || team.Organization != nil && (team.Organization.ID != org.ID || team.Organization.Name != org.Name) {
				return errInvalidForgeResponse
			}
			ids[team.ID], names[strings.ToLower(team.Name)] = true, true
		}
		slices.SortFunc(teams, func(a, b repositoryNativeTeam) int {
			if a.ID < b.ID {
				return -1
			}
			if a.ID > b.ID {
				return 1
			}
			return 0
		})
		loaded = true
		return nil
	}
	exactTeam := func(observed repositoryNativeTeam) (forgeOrganizationTeam, error) {
		if team, ok := exactTeams[observed.ID]; ok {
			return team, nil
		}
		team, e := s.readRepositoryTeam(ctx, token, org, observed.ID)
		if e != nil {
			return team, e
		}
		if team.Name != observed.Name || repositoryTeamConfiguration(org, team) != repositoryTeamConfiguration(org, observed.forgeOrganizationTeam) {
			return team, errRepositoryAccessConflict
		}
		exactTeams[team.ID] = team
		return team, nil
	}
	for _, name := range m.DesiredTag.AllowedTeams {
		if err = loadTeams(); err != nil {
			return "", err
		}
		found := false
		for _, observed := range teams {
			if observed.Name != name {
				continue
			}
			found = true
			team, e := exactTeam(observed)
			if e != nil {
				return "", e
			}
			if !tagTeamEligible(team) {
				return "", errTagAllowlistUnsupported
			}
			proof.Teams = append(proof.Teams, tagTeamProof{team.ID, team.Name, repositoryTeamConfiguration(org, team)})
		}
		if !found {
			return "", errTagAllowlistUnsupported
		}
	}
	probes := 0
	for _, name := range m.DesiredTag.AllowedUsernames {
		if !repositoryComponent.MatchString(name) || name == "." || name == ".." {
			return "", errTagAllowlistUnsupported
		}
		user, e := s.readTeamTarget(ctx, token, name)
		if e != nil {
			var upstream forgeError
			if errors.As(e, &upstream) && upstream.status == http.StatusNotFound {
				return "", errTagAllowlistUnsupported
			}
			return "", e
		}
		if user.Login != name {
			return "", errTagAllowlistUnsupported
		}
		if !organization && user.ID == row.Owner.ID {
			proof.Users = append(proof.Users, tagUserProof{ID: user.ID, Login: user.Login, Permission: "personal_owner"})
			continue
		}
		direct, e := s.directCollaborator(ctx, token, base, user)
		if e != nil {
			return "", e
		}
		if direct {
			permission, e := s.repositoryPermission(ctx, token, base, user)
			if e != nil {
				return "", e
			}
			// Public personal READ collaboration is not a retained Access row. For
			// private repositories explicit READ is retained by native. Individual
			// public-org grants also use the WRITE threshold in RecalculateUserAccess.
			// An unrelated site-admin has effective OWNER even with public READ;
			// that exceptional aggregate permission does not prove a retained row.
			if permission == "write" || permission == "admin" || (permission == "read" || permission == "owner") && row.Private {
				proof.Users = append(proof.Users, tagUserProof{ID: user.ID, Login: user.Login, Permission: permission})
				continue
			}
		}
		if err = loadTeams(); err != nil {
			return "", err
		}
		found := false
		for _, observed := range teams {
			if !tagTeamEligible(observed.forgeOrganizationTeam) {
				continue
			}
			team, e := exactTeam(observed)
			if e != nil {
				return "", e
			}
			if probes >= 500 {
				return "", errForgeResponseTooLarge
			}
			probes++
			member, e := s.teamContains(ctx, token, strconv.FormatInt(team.ID, 10), user)
			if e != nil {
				return "", e
			}
			if member {
				proof.Users = append(proof.Users, tagUserProof{ID: user.ID, Login: user.Login, TeamID: team.ID, TeamConfiguration: repositoryTeamConfiguration(org, team)})
				found = true
				break
			}
		}
		if !found {
			return "", errTagAllowlistUnsupported
		}
	}
	return accessRevision(proof), nil
}
