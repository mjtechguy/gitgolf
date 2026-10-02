package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errOrganizationAdminConflict = errors.New("organization administration changed")

func ownerTeam(team forgeOrganizationTeam) bool {
	if team.Permission == "owner" || strings.EqualFold(team.Name, "Owners") {
		return true
	}
	for _, permission := range team.UnitPermissions {
		if permission == "owner" {
			return true
		}
	}
	return false
}

func teamAdministrationRevision(org forgeOrganization, team forgeOrganizationTeam) string {
	// Observation only: native member routes do not provide atomic CAS.
	data, _ := json.Marshal(struct {
		Org  forgeOrganization
		Team forgeOrganizationTeam
	}{org, team})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (s *Server) organizationOwner(ctx context.Context, token forgeCredential, org forgeOrganization, caller User) (bool, error) {
	var permissions struct {
		Owner *bool `json:"is_owner"`
	}
	_, err := s.forge(ctx, http.MethodGet, "/users/"+caller.Login+"/orgs/"+org.Name+"/permissions", token, nil, &permissions)
	if err != nil {
		return false, err
	}
	if permissions.Owner == nil {
		return false, errInvalidForgeResponse
	}
	return *permissions.Owner, nil
}

func (s *Server) GetTeamAdministration(ctx context.Context, req *connect.Request[golfv1.GetTeamAdministrationRequest]) (*connect.Response[golfv1.GetTeamAdministrationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	id, err := organizationTeamID(req.Msg.TeamId)
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.GetTeamAdministrationResponse{}
	value := s.cookieValue(req.Header())
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.withOrganization(ctx, value, token, req.Msg.Organization, func(org forgeOrganization) error {
			team, err := s.readOrganizationTeam(ctx, token, org, id)
			if err != nil {
				return err
			}
			owner, err := s.organizationOwner(ctx, token, org, caller)
			if err != nil {
				return err
			}
			// Recheck the same native binding/grants after the permission lookup.
			after, err := s.readOrganizationTeam(ctx, token, org, id)
			if err != nil {
				return err
			}
			if teamAdministrationRevision(org, after) != teamAdministrationRevision(org, team) {
				return errOrganizationAdminConflict
			}
			result.OrganizationId = strconv.FormatInt(org.ID, 10)
			result.Team = wireOrganizationTeam(team)
			result.IsOwnerTeam = ownerTeam(team)
			result.CanManageMembers = owner && !result.IsOwnerTeam
			result.Revision = teamAdministrationRevision(org, team)
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func validateTeamAdministration(organization, orgID, teamID, login, revision string) error {
	if !validOrganizationName(organization) || !validOrganizationName(login) {
		return invalid("Organization and user must be valid name components.")
	}
	if _, err := discussionID(orgID); err != nil {
		return invalid("Organization ID must be a canonical positive decimal identifier.")
	}
	if _, err := organizationTeamID(teamID); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != revision {
		return invalid("Provide the current team administration revision.")
	}
	return nil
}

func (s *Server) readTeamTarget(ctx context.Context, token forgeCredential, login string) (User, error) {
	var user User
	_, err := s.forge(ctx, http.MethodGet, "/users/"+login, token, nil, &user)
	if err == nil && (user.ID <= 0 || !strings.EqualFold(user.Login, login)) {
		err = errInvalidForgeResponse
	}
	return user, err
}

func (s *Server) teamContains(ctx context.Context, token forgeCredential, teamID string, user User) (bool, error) {
	var member User
	_, err := s.forgeJSON(ctx, http.MethodGet, "/teams/"+teamID+"/members/"+user.Login, token, nil, &member, http.StatusOK)
	var upstream forgeError
	if errors.As(err, &upstream) && upstream.status == http.StatusNotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if member.ID != user.ID || !strings.EqualFold(member.Login, user.Login) {
		return false, errInvalidForgeResponse
	}
	return true, nil
}

// No native role mutation or alternate administrator credential. Membership and
// owner proof are fresh; snapshots fence ordinary stale forms, not native races.
func (s *Server) withTeamAdministration(ctx context.Context, value string, token forgeCredential, organization, orgID, teamID, revision string, operation func(User, forgeOrganization, forgeOrganizationTeam) error) error {
	id, _ := organizationTeamID(teamID)
	return s.withForgeCaller(ctx, value, token, func(caller User) error {
		return s.withOrganization(ctx, value, token, organization, func(org forgeOrganization) error {
			if strconv.FormatInt(org.ID, 10) != orgID {
				return errOrganizationAdminConflict
			}
			team, err := s.readOrganizationTeam(ctx, token, org, id)
			if err != nil {
				return err
			}
			if ownerTeam(team) {
				return forgeError{http.StatusForbidden}
			}
			if teamAdministrationRevision(org, team) != revision {
				return errOrganizationAdminConflict
			}
			owner, err := s.organizationOwner(ctx, token, org, caller)
			if err != nil {
				return err
			}
			if !owner {
				return forgeError{http.StatusForbidden}
			}
			if err := operation(caller, org, team); err != nil {
				return err
			}
			after, err := s.readOrganizationTeam(ctx, token, org, id)
			if err != nil {
				return err
			}
			if ownerTeam(after) || teamAdministrationRevision(org, after) != revision {
				return errOrganizationAdminConflict
			}
			owner, err = s.organizationOwner(ctx, token, org, caller)
			if err != nil {
				return err
			}
			if !owner {
				return forgeError{http.StatusForbidden}
			}
			return nil
		})
	})
}

func (s *Server) ResolveTeamMember(ctx context.Context, req *connect.Request[golfv1.ResolveTeamMemberRequest]) (*connect.Response[golfv1.ResolveTeamMemberResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if err := validateTeamAdministration(req.Msg.Organization, req.Msg.OrganizationId, req.Msg.TeamId, req.Msg.UserLogin, req.Msg.ExpectedRevision); err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ResolveTeamMemberResponse{}
	err = s.withTeamAdministration(ctx, s.cookieValue(req.Header()), token, req.Msg.Organization, req.Msg.OrganizationId, req.Msg.TeamId, req.Msg.ExpectedRevision, func(_ User, _ forgeOrganization, _ forgeOrganizationTeam) error {
		target, err := s.readTeamTarget(ctx, token, req.Msg.UserLogin)
		if err != nil {
			return err
		}
		member, err := s.teamContains(ctx, token, req.Msg.TeamId, target)
		if err != nil {
			return err
		}
		result.User = wireUser(target)
		result.IsMember = member
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) changeTeamMember(ctx context.Context, header http.Header, token forgeCredential, organization, orgID, teamID, login, userID, revision string, adding bool) (User, error) {
	if err := validateTeamAdministration(organization, orgID, teamID, login, revision); err != nil {
		return User{}, err
	}
	targetID, err := discussionID(userID)
	if err != nil {
		return User{}, invalid("User ID must be a canonical positive decimal identifier.")
	}
	value := s.cookieValue(header)
	var result User
	err = s.withTeamAdministration(ctx, value, token, organization, orgID, teamID, revision, func(caller User, org forgeOrganization, team forgeOrganizationTeam) error {
		target, err := s.readTeamTarget(ctx, token, login)
		if err != nil {
			return err
		}
		if target.ID != targetID {
			return errOrganizationAdminConflict
		}
		member, err := s.teamContains(ctx, token, teamID, target)
		if err != nil {
			return err
		}
		if member == adding {
			return errOrganizationAdminConflict
		}
		// Recheck immutable bindings, team grants and caller authority after lookups.
		var currentOrg forgeOrganization
		_, err = s.forge(ctx, http.MethodGet, "/orgs/"+org.Name, token, nil, &currentOrg)
		if err != nil {
			return err
		}
		if !validOrganization(currentOrg) || currentOrg.ID != org.ID || !strings.EqualFold(currentOrg.Name, org.Name) {
			return errOrganizationAdminConflict
		}
		currentTeam, err := s.readOrganizationTeam(ctx, token, currentOrg, team.ID)
		if err != nil {
			return err
		}
		if ownerTeam(currentTeam) || teamAdministrationRevision(currentOrg, currentTeam) != revision {
			return errOrganizationAdminConflict
		}
		if err := s.requireOrganizationMember(ctx, token, org.Name, caller.Login); err != nil {
			return err
		}
		owner, err := s.organizationOwner(ctx, token, currentOrg, caller)
		if err != nil {
			return err
		}
		if !owner {
			return forgeError{http.StatusForbidden}
		}
		currentTarget, err := s.readTeamTarget(ctx, token, login)
		if err != nil {
			return err
		}
		if currentTarget.ID != targetID {
			return errOrganizationAdminConflict
		}
		if _, err := s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		method := http.MethodDelete
		if adding {
			method = http.MethodPut
		}
		_, err = s.forgeJSON(ctx, method, "/teams/"+teamID+"/members/"+currentTarget.Login, token, nil, nil, http.StatusNoContent)
		if err != nil {
			return err
		}
		after, err := s.readTeamTarget(ctx, token, login)
		if err != nil {
			return err
		}
		if after.ID != targetID {
			return errInvalidForgeResponse
		}
		actual, err := s.teamContains(ctx, token, teamID, after)
		if err != nil {
			return err
		}
		if actual != adding {
			return errInvalidForgeResponse
		}
		result = after
		return nil
	})
	return result, err
}

func (s *Server) AddTeamMember(ctx context.Context, req *connect.Request[golfv1.AddTeamMemberRequest]) (*connect.Response[golfv1.AddTeamMemberResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	user, err := s.changeTeamMember(ctx, req.Header(), token, req.Msg.Organization, req.Msg.OrganizationId, req.Msg.TeamId, req.Msg.UserLogin, req.Msg.UserId, req.Msg.ExpectedRevision, true)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.AddTeamMemberResponse{User: wireUser(user), IsMember: true}), nil
}
func (s *Server) RemoveTeamMember(ctx context.Context, req *connect.Request[golfv1.RemoveTeamMemberRequest]) (*connect.Response[golfv1.RemoveTeamMemberResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	user, err := s.changeTeamMember(ctx, req.Header(), token, req.Msg.Organization, req.Msg.OrganizationId, req.Msg.TeamId, req.Msg.UserLogin, req.Msg.UserId, req.Msg.ExpectedRevision, false)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RemoveTeamMemberResponse{User: wireUser(user), IsMember: false}), nil
}
