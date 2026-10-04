package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Keep required native configuration presence here without changing legacy
// organization browsing. Unknown inheritance or unit permissions cannot become
// a mutable repository grant. Pinned ToTeams(false) omits organization identity;
// the exact GetTeam read below supplies it independently.
type repositoryNativeTeam struct{ forgeOrganizationTeam }

func (r *repositoryNativeTeam) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if len(fields["includes_all_repositories"]) == 0 || strings.TrimSpace(string(fields["includes_all_repositories"])) == "null" || len(fields["units_map"]) == 0 || strings.TrimSpace(string(fields["units_map"])) == "null" {
		return errInvalidForgeResponse
	}
	type plain forgeOrganizationTeam
	var row plain
	if err := json.Unmarshal(data, &row); err != nil {
		return err
	}
	if !validOrganizationTeam(forgeOrganizationTeam(row)) || row.UnitPermissions == nil || !discussionText(row.Description, 2048) || !discussionText(row.Name, 255) || strings.ContainsAny(row.Name, "\r\n\t") {
		return errInvalidForgeResponse
	}
	r.forgeOrganizationTeam = forgeOrganizationTeam(row)
	return nil
}

func repositoryTeamConfiguration(org forgeOrganization, team forgeOrganizationTeam) string {
	team.Organization = nil
	return teamAdministrationRevision(org, team)
}
func repositoryTeamProjection(access *golfv1.RepositoryAccess, org forgeOrganization, team forgeOrganizationTeam, attached, manage bool) *golfv1.RepositoryTeamAccess {
	protected := ownerTeam(team) || team.IncludesAllRepositories
	return &golfv1.RepositoryTeamAccess{Team: wireOrganizationTeam(team), Attached: attached, IsOwnerTeam: ownerTeam(team), CanAttach: manage && !protected && !attached, CanDetach: manage && !protected && attached, Revision: accessRevision(struct {
		RepositoryID, OrganizationID, AccessRevision, Configuration string
		Attached                                                    bool
	}{access.RepositoryId, access.OwnerId, access.Revision, repositoryTeamConfiguration(org, team), attached})}
}
func (s *Server) readRepositoryTeam(ctx context.Context, token forgeCredential, org forgeOrganization, id int64) (forgeOrganizationTeam, error) {
	var row repositoryNativeTeam
	_, err := s.forge(ctx, http.MethodGet, "/teams/"+strconv.FormatInt(id, 10), token, nil, &row)
	if err != nil {
		return forgeOrganizationTeam{}, err
	}
	if row.ID != id || row.Organization == nil || !validOrganization(*row.Organization) {
		return forgeOrganizationTeam{}, errInvalidForgeResponse
	}
	if row.Organization.ID != org.ID || !strings.EqualFold(row.Organization.Name, org.Name) {
		return forgeOrganizationTeam{}, errResourceNotFound
	}
	return row.forgeOrganizationTeam, nil
}

// v1.27.3 repo.ListTeams returns the whole GetRepoTeams collection, not a
// default first page: no ListOptions, total header or Link pagination. Never use
// the visibility-trimmed team-repositories 404 as evidence of non-association.
// ponytail: bounded whole collection; native paging is required beyond 500.
func (s *Server) repositoryTeamAssociations(ctx context.Context, token forgeCredential, key repositoryKey, org forgeOrganization) (map[int64]bool, error) {
	base, _ := repositoryPath(key)
	var rows []repositoryNativeTeam
	headers, err := s.forge(ctx, http.MethodGet, base+"/teams", token, nil, &rows)
	if err != nil {
		return nil, err
	}
	if len(rows) > 500 {
		return nil, errForgeResponseTooLarge
	}
	if rows == nil || headers.Get("Link") != "" {
		return nil, errInvalidForgeResponse
	}
	result := make(map[int64]bool, len(rows))
	for _, row := range rows {
		if result[row.ID] || row.Organization != nil && (row.Organization.ID != org.ID || !strings.EqualFold(row.Organization.Name, org.Name)) {
			return nil, errInvalidForgeResponse
		}
		result[row.ID] = true
	}
	return result, nil
}

// Organization membership and an exact native owner binding are mandatory even
// for public repositories. Org owner AND native repository admin is deliberate;
// the native optional repository-admin policy/site-admin bypass is not granted.
// These observations do not implement native atomic compare-and-swap.
func (s *Server) withRepositoryTeamAccess(ctx context.Context, value string, token forgeCredential, key repositoryKey, repoID, orgID, revision string, operation func(*golfv1.RepositoryAccess, forgeOrganization, bool) error) error {
	return s.withForgeCaller(ctx, value, token, func(caller User) error {
		before, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		if !before.OrganizationOwned || before.RepositoryId != repoID || before.OwnerId != orgID || before.Revision != revision {
			return errRepositoryAccessConflict
		}
		return s.withOrganization(ctx, value, token, key.Owner, func(org forgeOrganization) error {
			if strconv.FormatInt(org.ID, 10) != orgID {
				return errRepositoryAccessConflict
			}
			observe := func() (bool, error) {
				owner, e := s.organizationOwner(ctx, token, org, caller)
				if e != nil {
					return false, e
				}
				row, _, e := s.readRepositorySettings(ctx, token, key)
				if e != nil {
					return false, e
				}
				if strconv.FormatInt(row.ID, 10) != repoID || strconv.FormatInt(row.Owner.ID, 10) != orgID {
					return false, errRepositoryAccessConflict
				}
				return owner && row.Permissions.Admin && !*row.Archived && !*row.Mirror && (before.CurrentPermission == "admin" || before.CurrentPermission == "owner"), nil
			}
			manage, e := observe()
			if e != nil {
				return e
			}
			if e = operation(before, org, manage); e != nil {
				return e
			}
			after, e := s.readRepositoryAccess(ctx, token, key, caller)
			if e != nil {
				return e
			}
			if after.RepositoryId != repoID || after.OwnerId != orgID || after.Revision != revision || !after.OrganizationOwned || after.CurrentPermission != before.CurrentPermission {
				return errRepositoryAccessConflict
			}
			current, e := observe()
			if e != nil {
				return e
			}
			if current != manage {
				return errRepositoryAccessConflict
			}
			return nil
		})
	})
}

func (s *Server) ListRepositoryTeamAccess(ctx context.Context, req *connect.Request[golfv1.ListRepositoryTeamAccessRequest]) (*connect.Response[golfv1.ListRepositoryTeamAccessResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if err = validateRepositoryAccess(key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, ""); err != nil {
		return nil, rpcError(err)
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	if limit > 20 {
		return nil, rpcError(invalid("Load at most 20 organization teams per page."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryTeamAccessResponse{RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision}
	err = s.withRepositoryTeamAccess(ctx, s.cookieValue(req.Header()), token, key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(access *golfv1.RepositoryAccess, org forgeOrganization, manage bool) error {
		attached, e := s.repositoryTeamAssociations(ctx, token, key, org)
		if e != nil {
			return e
		}
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			var rows []repositoryNativeTeam
			headers, e := s.forge(ctx, http.MethodGet, "/orgs/"+org.Name+"/teams?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if e != nil {
				return e
			}
			next, e := repositoryCollaboratorNextPage(headers, page, limit)
			if e != nil {
				return e
			}
			total, _ := strconv.ParseUint(headers.Get("X-Total-Count"), 10, 63)
			start := (uint64(page) - 1) * uint64(limit)
			expected := uint64(0)
			if start < total {
				expected = min(uint64(limit), total-start)
			}
			if rows == nil || uint64(len(rows)) != expected {
				return errInvalidForgeResponse
			}
			seen := map[int64]bool{}
			for _, row := range rows {
				if seen[row.ID] || row.Organization != nil && (!validOrganization(*row.Organization) || row.Organization.ID != org.ID || !strings.EqualFold(row.Organization.Name, org.Name)) {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				full, e := s.readRepositoryTeam(ctx, token, org, row.ID)
				if e != nil {
					return e
				}
				if repositoryTeamConfiguration(org, full) != repositoryTeamConfiguration(org, row.forgeOrganizationTeam) {
					return errRepositoryAccessConflict
				}
				result.Teams = append(result.Teams, repositoryTeamProjection(access, org, full, attached[row.ID], manage))
			}
			after, e := s.repositoryTeamAssociations(ctx, token, key, org)
			if e != nil {
				return e
			}
			if accessRevision(after) != accessRevision(attached) {
				return errRepositoryAccessConflict
			}
			result.CanManage = manage
			result.Page = wirePage(next)
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) changeRepositoryTeam(ctx context.Context, headers http.Header, key repositoryKey, repoID, orgID, revision, teamID, teamRevision string, attach bool) (*golfv1.RepositoryTeamAccess, error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if err = validateRepositoryAccess(key, repoID, orgID, revision, ""); err != nil {
		return nil, rpcError(err)
	}
	id, err := organizationTeamID(teamID)
	if err != nil {
		return nil, rpcError(err)
	}
	if !validAccessRevision(teamRevision) {
		return nil, rpcError(invalid("Provide the current team association revision."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.RepositoryTeamAccess
	err = s.withRepositoryTeamAccess(ctx, s.cookieValue(headers), token, key, repoID, orgID, revision, func(access *golfv1.RepositoryAccess, org forgeOrganization, manage bool) error {
		if !manage {
			return forgeError{http.StatusForbidden}
		}
		team, e := s.readRepositoryTeam(ctx, token, org, id)
		if e != nil {
			return e
		}
		if ownerTeam(team) || team.IncludesAllRepositories {
			return forgeError{http.StatusForbidden}
		}
		associations, e := s.repositoryTeamAssociations(ctx, token, key, org)
		if e != nil {
			return e
		}
		before := repositoryTeamProjection(access, org, team, associations[id], manage)
		if before.Revision != teamRevision || before.Attached == attach {
			return errRepositoryAccessConflict
		}
		method := http.MethodDelete
		if attach {
			method = http.MethodPut
		}
		// Exactly one native dispatch. A lost/error acknowledgement or failed
		// postflight remains uncertain; there is no retry, journal or attribution.
		route := "/teams/" + teamID + "/repos/" + key.Owner + "/" + key.Name
		if _, e = s.forgeJSON(ctx, method, route, token, nil, nil, http.StatusNoContent); e != nil {
			return e
		}
		full, e := s.readRepositoryTeam(ctx, token, org, id)
		if e != nil {
			return e
		}
		if repositoryTeamConfiguration(org, full) != repositoryTeamConfiguration(org, team) {
			return errRepositoryAccessConflict
		}
		observed, e := s.repositoryTeamAssociations(ctx, token, key, org)
		if e != nil {
			return e
		}
		if observed[id] != attach {
			return errInvalidForgeResponse
		}
		// Other associations are not asserted unchanged: native concurrent changes
		// are independent. The receipt acknowledges only this selected relationship.
		result = repositoryTeamProjection(access, org, full, attach, manage)
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return result, nil
}
func (s *Server) AttachRepositoryTeam(ctx context.Context, req *connect.Request[golfv1.AttachRepositoryTeamRequest]) (*connect.Response[golfv1.AttachRepositoryTeamResponse], error) {
	row, err := s.changeRepositoryTeam(ctx, req.Header(), keyFrom(req.Msg.Repository), req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, req.Msg.TeamId, req.Msg.ExpectedTeamRevision, true)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.AttachRepositoryTeamResponse{RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision, Team: row}), nil
}
func (s *Server) DetachRepositoryTeam(ctx context.Context, req *connect.Request[golfv1.DetachRepositoryTeamRequest]) (*connect.Response[golfv1.DetachRepositoryTeamResponse], error) {
	row, err := s.changeRepositoryTeam(ctx, req.Header(), keyFrom(req.Msg.Repository), req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, req.Msg.TeamId, req.Msg.ExpectedTeamRevision, false)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.DetachRepositoryTeamResponse{RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision, Team: row}), nil
}
