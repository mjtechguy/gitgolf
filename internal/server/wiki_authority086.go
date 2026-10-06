package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// The wiki unit has its own team grants. Code push and native site administration
// do not substitute for an ordinary current personal/direct/team wiki writer.
func (s *Server) wikiUnitWriter086(ctx context.Context, token forgeCredential, key repositoryKey, caller User) (bool, error) {
	row, _, e := s.readRepositorySettings(ctx, token, key)
	if e != nil {
		return false, e
	}
	if row.HasWiki == nil || !*row.HasWiki || row.ExternalWiki != nil || row.Archived == nil || *row.Archived || row.Mirror == nil || *row.Mirror {
		return false, nil
	}
	base, _ := repositoryPath(key)
	org, e := s.repositoryOwnerKind(ctx, token, *row.Owner)
	if e != nil {
		return false, e
	}
	permission, e := s.repositoryPermission(ctx, token, base, caller)
	if e != nil {
		return false, e
	}
	write := permission == "write" || permission == "admin" || permission == "owner"
	if !org && caller.ID == row.Owner.ID {
		return permission == "owner", nil
	}
	direct, e := s.directCollaborator(ctx, token, base, caller)
	if e != nil {
		return false, e
	}
	if direct && write {
		return true, nil
	}
	if !org {
		return false, nil
	}
	var organization forgeOrganization
	if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+row.Owner.Login, token, nil, &organization); e != nil {
		return false, e
	}
	if !validOrganization(organization) || organization.ID != row.Owner.ID || !strings.EqualFold(organization.Name, row.Owner.Login) {
		return false, errInvalidForgeResponse
	}
	if _, e = s.forgeJSON(ctx, http.MethodGet, "/orgs/"+organization.Name+"/members/"+caller.Login, token, nil, nil, http.StatusNoContent); e != nil {
		return false, e
	}
	teams, e := s.repositoryTeamAssociations(ctx, token, key, organization)
	if e != nil {
		return false, e
	}
	for id := range teams {
		team, e := s.readRepositoryTeam(ctx, token, organization, id)
		if e != nil {
			return false, e
		}
		grant := team.UnitPermissions["repo.wiki"]
		if grant != "write" && grant != "admin" && grant != "owner" {
			continue
		}
		member, e := s.teamContains(ctx, token, strconv.FormatInt(id, 10), caller)
		if e != nil {
			return false, e
		}
		if member {
			return true, nil
		}
	}
	return false, nil
}
