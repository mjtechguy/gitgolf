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

var errRepositoryAccessConflict = errors.New("repository access changed")

func accessRevision(value any) string {
	data, _ := json.Marshal(value)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
func validAccessRevision(value string) bool {
	data, err := hex.DecodeString(value)
	return err == nil && len(data) == sha256.Size && hex.EncodeToString(data) == value
}
func validRepositoryPermission(value string) bool {
	return value == "none" || value == "read" || value == "write" || value == "admin" || value == "owner"
}

// Individual search is a positive native type proof. An organization 404 can
// mean a hidden organization and must never be interpreted as an individual.
func (s *Server) repositoryOwnerKind(ctx context.Context, token forgeCredential, owner User) (bool, error) {
	var result struct {
		OK   *bool  `json:"ok"`
		Data []User `json:"data"`
	}
	_, err := s.forge(ctx, http.MethodGet, "/users/search?uid="+strconv.FormatInt(owner.ID, 10)+"&limit=1", token, nil, &result)
	if err != nil {
		return false, err
	}
	if result.OK == nil || !*result.OK || len(result.Data) > 1 {
		return false, errInvalidForgeResponse
	}
	if len(result.Data) == 1 {
		if result.Data[0].ID != owner.ID || !strings.EqualFold(result.Data[0].Login, owner.Login) {
			return false, errInvalidForgeResponse
		}
		return false, nil
	}
	var org forgeOrganization
	_, err = s.forge(ctx, http.MethodGet, "/orgs/"+owner.Login, token, nil, &org)
	if err != nil {
		return false, err
	}
	if !validOrganization(org) || org.ID != owner.ID || !strings.EqualFold(org.Name, owner.Login) {
		return false, errInvalidForgeResponse
	}
	return true, nil
}

func (s *Server) directCollaborator(ctx context.Context, token forgeCredential, base string, user User) (bool, error) {
	_, err := s.forgeJSON(ctx, http.MethodGet, base+"/collaborators/"+user.Login, token, nil, nil, http.StatusNoContent)
	var upstream forgeError
	if errors.As(err, &upstream) && upstream.status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}
func (s *Server) repositoryPermission(ctx context.Context, token forgeCredential, base string, user User) (string, error) {
	var result struct {
		Permission string `json:"permission"`
		User       *User  `json:"user"`
	}
	_, err := s.forgeJSON(ctx, http.MethodGet, base+"/collaborators/"+user.Login+"/permission", token, nil, &result, http.StatusOK)
	if err != nil {
		return "", err
	}
	if result.User == nil || result.User.ID != user.ID || !strings.EqualFold(result.User.Login, user.Login) || !validRepositoryPermission(result.Permission) {
		return "", errInvalidForgeResponse
	}
	return result.Permission, nil
}
func (s *Server) readRepositoryAccess(ctx context.Context, token forgeCredential, key repositoryKey, caller User) (*golfv1.RepositoryAccess, error) {
	row, _, err := s.readRepositorySettings(ctx, token, key)
	if err != nil {
		return nil, err
	}
	org, err := s.repositoryOwnerKind(ctx, token, *row.Owner)
	if err != nil {
		return nil, err
	}
	base, _ := repositoryPath(key)
	permission, err := s.repositoryPermission(ctx, token, base, caller)
	if err != nil {
		return nil, err
	}
	manage := false
	if !org && row.Permissions.Admin && !*row.Archived && !*row.Mirror {
		if caller.ID == row.Owner.ID {
			manage = permission == "owner"
		} else if permission == "admin" {
			manage, err = s.directCollaborator(ctx, token, base, caller)
			if err != nil {
				return nil, err
			}
		}
	}
	access := &golfv1.RepositoryAccess{RepositoryId: strconv.FormatInt(row.ID, 10), OwnerId: strconv.FormatInt(row.Owner.ID, 10), Owner: wireUser(*row.Owner), OrganizationOwned: org, CanManage: manage, CurrentPermission: permission}
	// Observation fence only. Native collaborator routes have no atomic CAS.
	access.Revision = accessRevision(struct {
		ID, OwnerID                    int64
		Name                           string
		Private, Archived, Mirror, Org bool
	}{row.ID, row.Owner.ID, strings.ToLower(row.FullName), row.Private, *row.Archived, *row.Mirror, org})
	return access, nil
}
func accessMatches(access *golfv1.RepositoryAccess, repoID, ownerID, revision string) error {
	if !access.CanManage {
		return forgeError{http.StatusForbidden}
	}
	if access.RepositoryId != repoID || access.OwnerId != ownerID || access.Revision != revision {
		return errRepositoryAccessConflict
	}
	return nil
}
func validateRepositoryAccess(key repositoryKey, repoID, ownerID, revision, login string) error {
	if _, err := repositoryPath(key); err != nil {
		return err
	}
	if _, err := discussionID(repoID); err != nil {
		return invalid("Repository ID must be a canonical positive decimal identifier.")
	}
	if _, err := discussionID(ownerID); err != nil {
		return invalid("Owner ID must be a canonical positive decimal identifier.")
	}
	if !validAccessRevision(revision) {
		return invalid("Provide the current repository access revision.")
	}
	if login != "" && !validOrganizationName(login) {
		return invalid("Account username must be a valid name component.")
	}
	return nil
}
func (s *Server) readRepositoryCollaborator(ctx context.Context, token forgeCredential, key repositoryKey, access *golfv1.RepositoryAccess, login string) (*golfv1.RepositoryCollaborator, error) {
	user, err := s.readTeamTarget(ctx, token, login)
	if err != nil {
		return nil, err
	}
	base, _ := repositoryPath(key)
	direct, err := s.directCollaborator(ctx, token, base, user)
	if err != nil {
		return nil, err
	}
	permission, err := s.repositoryPermission(ctx, token, base, user)
	if err != nil {
		return nil, err
	}
	result := &golfv1.RepositoryCollaborator{User: wireUser(user), Permission: permission, IsDirect: direct}
	result.Revision = accessRevision(struct {
		RepoID, OwnerID, UserID, Login, Permission string
		Direct                                     bool
	}{access.RepositoryId, access.OwnerId, result.User.Id, strings.ToLower(user.Login), permission, direct})
	return result, nil
}
func (s *Server) withRepositoryAccess(ctx context.Context, value string, token forgeCredential, key repositoryKey, repoID, ownerID, revision string, operation func(User, *golfv1.RepositoryAccess) error) error {
	return s.withForgeCaller(ctx, value, token, func(caller User) error {
		before, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		if err = accessMatches(before, repoID, ownerID, revision); err != nil {
			return err
		}
		if err = operation(caller, before); err != nil {
			return err
		}
		after, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		return accessMatches(after, repoID, ownerID, revision)
	})
}
func (s *Server) GetRepositoryAccess(ctx context.Context, req *connect.Request[golfv1.GetRepositoryAccessRequest]) (*connect.Response[golfv1.GetRepositoryAccessResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.GetRepositoryAccessResponse{}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(caller User) error {
		access, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		after, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		if access.Revision != after.Revision || access.CanManage != after.CanManage || access.CurrentPermission != after.CurrentPermission {
			return errRepositoryAccessConflict
		}
		result.Access = after
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

// This native route emits X-Total-Count rather than a Link header.
func repositoryCollaboratorNextPage(headers http.Header, page, limit uint32) (uint32, error) {
	raw := headers.Get("X-Total-Count")
	total, err := strconv.ParseUint(raw, 10, 63)
	if err != nil || strconv.FormatUint(total, 10) != raw {
		return 0, errInvalidForgeResponse
	}
	if uint64(page)*uint64(limit) >= total {
		return 0, nil
	}
	if page == 10000 {
		return 0, invalid("Collaborator browsing exceeds the 10000-page limit. Increase the page size and refresh.")
	}
	return page + 1, nil
}

func (s *Server) ListRepositoryCollaborators(ctx context.Context, req *connect.Request[golfv1.ListRepositoryCollaboratorsRequest]) (*connect.Response[golfv1.ListRepositoryCollaboratorsResponse], error) {
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
	result := &golfv1.ListRepositoryCollaboratorsResponse{}
	err = s.withRepositoryAccess(ctx, s.cookieValue(req.Header()), token, key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(_ User, access *golfv1.RepositoryAccess) error {
		base, _ := repositoryPath(key)
		var users []User
		headers, err := s.forge(ctx, http.MethodGet, base+"/collaborators?"+pageQuery(page, limit).Encode(), token, nil, &users)
		if err != nil {
			return err
		}
		next, err := repositoryCollaboratorNextPage(headers, page, limit)
		if err != nil {
			return err
		}
		if len(users) > int(limit) {
			return errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, user := range users {
			if user.ID <= 0 || !validOrganizationName(user.Login) || seen[user.ID] {
				return errInvalidForgeResponse
			}
			seen[user.ID] = true
			member, err := s.readRepositoryCollaborator(ctx, token, key, access, user.Login)
			if err != nil {
				return err
			}
			if member.User.Id != strconv.FormatInt(user.ID, 10) || !member.IsDirect {
				return errRepositoryAccessConflict
			}
			result.Collaborators = append(result.Collaborators, member)
		}
		result.Page = wirePage(next)
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) ResolveRepositoryCollaborator(ctx context.Context, req *connect.Request[golfv1.ResolveRepositoryCollaboratorRequest]) (*connect.Response[golfv1.ResolveRepositoryCollaboratorResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if req.Msg.UserLogin == "" {
		return nil, rpcError(invalid("Account username is required."))
	}
	if err = validateRepositoryAccess(key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, req.Msg.UserLogin); err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ResolveRepositoryCollaboratorResponse{}
	err = s.withRepositoryAccess(ctx, s.cookieValue(req.Header()), token, key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(_ User, access *golfv1.RepositoryAccess) error {
		result.Collaborator, err = s.readRepositoryCollaborator(ctx, token, key, access, req.Msg.UserLogin)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) mutateRepositoryCollaborator(ctx context.Context, value string, token forgeCredential, key repositoryKey, repoID, ownerID, revision, login, userID, targetRevision, permission string, remove bool) (*golfv1.RepositoryCollaborator, error) {
	if login == "" {
		return nil, invalid("Account username is required.")
	}
	if err := validateRepositoryAccess(key, repoID, ownerID, revision, login); err != nil {
		return nil, err
	}
	if _, err := discussionID(userID); err != nil {
		return nil, invalid("User ID must be a canonical positive decimal identifier.")
	}
	if !validAccessRevision(targetRevision) {
		return nil, invalid("Resolve the account and review its current access before saving.")
	}
	if !remove && permission != "read" && permission != "write" && permission != "admin" {
		return nil, invalid("Permission must be read, write, or admin.")
	}
	var result *golfv1.RepositoryCollaborator
	err := s.withRepositoryAccess(ctx, value, token, key, repoID, ownerID, revision, func(caller User, access *golfv1.RepositoryAccess) error {
		if userID == ownerID || userID == strconv.FormatInt(caller.ID, 10) {
			return forgeError{http.StatusForbidden}
		}
		validateTarget := func(target *golfv1.RepositoryCollaborator) error {
			if target.User.Id != userID || target.Revision != targetRevision {
				return errRepositoryAccessConflict
			}
			if target.Permission == "owner" {
				return forgeError{http.StatusForbidden}
			}
			if remove && !target.IsDirect || !remove && target.IsDirect && target.Permission == permission {
				return errRepositoryAccessConflict
			}
			return nil
		}
		before, err := s.readRepositoryCollaborator(ctx, token, key, access, login)
		if err != nil {
			return err
		}
		if err = validateTarget(before); err != nil {
			return err
		}
		current, err := s.readRepositoryAccess(ctx, token, key, caller)
		if err != nil {
			return err
		}
		if err = accessMatches(current, repoID, ownerID, revision); err != nil {
			return err
		}
		fresh, err := s.readRepositoryCollaborator(ctx, token, key, current, login)
		if err != nil {
			return err
		}
		if err = validateTarget(fresh); err != nil {
			return err
		}
		if _, err = s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		base, _ := repositoryPath(key)
		method := http.MethodPut
		var body any = map[string]string{"permission": permission}
		if remove {
			method = http.MethodDelete
			body = nil
		}
		// Exactly one dispatch. A lost/invalid receipt is uncertain, never retried.
		_, err = s.forgeJSON(ctx, method, base+"/collaborators/"+fresh.User.Login, token, body, nil, http.StatusNoContent)
		if err != nil {
			return err
		}
		observed, err := s.readRepositoryCollaborator(ctx, token, key, current, login)
		if err != nil {
			return err
		}
		if observed.User.Id != userID || (remove && observed.IsDirect) || (!remove && (!observed.IsDirect || observed.Permission != permission)) {
			return errInvalidForgeResponse
		}
		result = observed
		return nil
	})
	return result, err
}
func (s *Server) SetRepositoryCollaborator(ctx context.Context, req *connect.Request[golfv1.SetRepositoryCollaboratorRequest]) (*connect.Response[golfv1.SetRepositoryCollaboratorResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	result, err := s.mutateRepositoryCollaborator(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.ExpectedRevision, m.UserLogin, m.UserId, m.ExpectedCollaboratorRevision, m.Permission, false)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.SetRepositoryCollaboratorResponse{Collaborator: result}), nil
}
func (s *Server) RemoveRepositoryCollaborator(ctx context.Context, req *connect.Request[golfv1.RemoveRepositoryCollaboratorRequest]) (*connect.Response[golfv1.RemoveRepositoryCollaboratorResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	result, err := s.mutateRepositoryCollaborator(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.ExpectedRevision, m.UserLogin, m.UserId, m.ExpectedCollaboratorRevision, "", true)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RemoveRepositoryCollaboratorResponse{Collaborator: result}), nil
}
