package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Star is an own-account preference, not repository write/delegation authority.
// No URLs, actor discovery, original-effect journal or executable permit.
type forgeStarRepository struct {
	Repository
	Owner      *User  `json:"owner"`
	StarsCount *int64 `json:"stars_count"`
}

var errRepositoryStarUnavailable = errors.New("repository star preference unavailable")

func repositoryStarForbidden(err error) bool {
	var upstream forgeError
	return errors.As(err, &upstream) && upstream.status == http.StatusForbidden
}

func validateStarRepository(row forgeStarRepository, key repositoryKey, id int64) error {
	owner, name, ok := strings.Cut(row.FullName, "/")
	if !validRepository(row.Repository) || !ok || !validOrganizationName(owner) || !validOrganizationName(name) || row.Name != name || row.ID != id || !strings.EqualFold(row.FullName, key.Owner+"/"+key.Name) || row.Owner == nil || row.Owner.ID <= 0 || !validOrganizationName(row.Owner.Login) || row.Owner.Login != owner || (row.StarsCount != nil && *row.StarsCount < 0) {
		return errIssueTargetChanged
	}
	return nil
}
func (s *Server) readStarRepository(ctx context.Context, token forgeCredential, key repositoryKey, id int64) (forgeStarRepository, error) {
	var row forgeStarRepository
	base, err := repositoryPath(key)
	if err != nil {
		return row, err
	}
	if _, err = s.forgeJSON(ctx, http.MethodGet, base, token, nil, &row, http.StatusOK); err != nil {
		return row, err
	}
	return row, validateStarRepository(row, key, id)
}
func (s *Server) readRepositoryStar(ctx context.Context, token forgeCredential, key repositoryKey) (bool, error) {
	// Pinned native IsStarring returns204/404. Disabled stars and missing token
	// scopes return403, never false. A404 is usable only inside current exact repo
	// and managed actor/session before/after fences in repositoryStar below.
	_, err := s.forgeJSON(ctx, http.MethodGet, "/user/starred/"+key.Owner+"/"+key.Name, token, nil, nil, http.StatusNoContent)
	if err == nil {
		return true, nil
	}
	var upstream forgeError
	if errors.As(err, &upstream) && upstream.status == http.StatusNotFound {
		return false, nil
	}
	return false, err
}
func wireRepositoryStar(row forgeStarRepository, actor User, starred bool) *golfv1.RepositoryStarPreference {
	owner, name, _ := strings.Cut(row.FullName, "/")
	result := &golfv1.RepositoryStarPreference{Repository: &golfv1.RepositoryKey{Owner: owner, Name: name}, RepositoryId: strconv.FormatInt(row.ID, 10), OwnerId: strconv.FormatInt(row.Owner.ID, 10), NativeUserId: strconv.FormatInt(actor.ID, 10), Starred: &starred}
	if row.StarsCount != nil {
		value := strconv.FormatInt(*row.StarsCount, 10)
		result.StarsCount = &value
	}
	return result
}

func repositoryStarError(err error, attempted bool) error {
	if errors.Is(err, errRepositoryStarUnavailable) && !attempted {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Star preference is unavailable for this account or repository."))
	}
	mapped := rpcError(err)
	if !attempted {
		return mapped
	}
	// Preserve authority/session denials so private UI and managed-session
	// clearing still work. Every error leaves the desired change unconfirmed.
	switch connect.CodeOf(mapped) {
	case connect.CodeUnauthenticated, connect.CodePermissionDenied, connect.CodeNotFound:
		return mapped
	default:
		return connect.NewError(connect.CodeUnavailable, errors.New("Star change could not be confirmed. Inspect the current preference before another explicit change."))
	}
}

func (s *Server) repositoryStar(ctx context.Context, cookie string, token forgeCredential, key repositoryKey, id, ownerID, actorID int64, desired *bool) (*golfv1.RepositoryStarPreference, error) {
	var result *golfv1.RepositoryStarPreference
	attempted := false
	optionalUnavailable := false
	err := s.withForgeCaller(ctx, cookie, token, func(actor User) error {
		if actorID != 0 && actor.ID != actorID {
			return errUnauthenticated
		}
		before, err := s.readStarRepository(ctx, token, key, id)
		if err != nil {
			return err
		}
		if ownerID != 0 && before.Owner.ID != ownerID {
			return errIssueTargetChanged
		}
		if desired != nil {
			method := http.MethodDelete
			if *desired {
				method = http.MethodPut
			}
			// Exactly one supported desired-state write. No replay, retry or rollback
			// write occurs even when the acknowledgement/readback/late fence is lost.
			attempted = true
			if _, err := s.forgeJSON(ctx, method, "/user/starred/"+key.Owner+"/"+key.Name, token, nil, nil, http.StatusNoContent); err != nil {
				if !repositoryStarForbidden(err) {
					return err
				}
				optionalUnavailable = true
			}
		}
		starred := false
		if !optionalUnavailable {
			starred, err = s.readRepositoryStar(ctx, token, key)
			if err != nil {
				if !repositoryStarForbidden(err) {
					return err
				}
				optionalUnavailable = true
			}
			if !optionalUnavailable && desired != nil && starred != *desired {
				return errInvalidForgeResponse
			}
		}
		after, err := s.readStarRepository(ctx, token, key, id)
		if err != nil {
			return err
		}
		if before.Owner.ID != after.Owner.ID || before.Owner.Login != after.Owner.Login || before.FullName != after.FullName {
			return errIssueTargetChanged
		}
		// Native stars-disabled/scope403 is an optional-feature failure only after
		// the current repository, owner, actor and managed session still verify.
		// Returning nil here allows withForgeCaller to finish its late fences;
		// their authority denial takes precedence over optional unavailability.
		if !optionalUnavailable {
			result = wireRepositoryStar(after, actor, starred)
		}
		return nil
	})
	if err != nil {
		return nil, repositoryStarError(err, attempted)
	}
	if optionalUnavailable {
		return nil, repositoryStarError(errRepositoryStarUnavailable, attempted)
	}
	return result, nil
}
func (s *Server) GetRepositoryStar(ctx context.Context, req *connect.Request[golfv1.GetRepositoryStarRequest]) (*connect.Response[golfv1.GetRepositoryStarResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err := repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	token, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	preference, err := s.repositoryStar(ctx, s.cookieValue(req.Header()), token, key, id, 0, 0, nil)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.GetRepositoryStarResponse{Preference: preference}), nil
}
func (s *Server) SetRepositoryStar(ctx context.Context, req *connect.Request[golfv1.SetRepositoryStarRequest]) (*connect.Response[golfv1.SetRepositoryStarResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	ownerID, err := discussionID(req.Msg.OwnerId)
	if err != nil {
		return nil, rpcError(err)
	}
	actorID, err := discussionID(req.Msg.NativeUserId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err := repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	if req.Msg.Starred == nil {
		return nil, rpcError(invalid("Choose an explicit Star or Unstar preference."))
	}
	token, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	preference, err := s.repositoryStar(ctx, s.cookieValue(req.Header()), token, key, id, ownerID, actorID, req.Msg.Starred)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&golfv1.SetRepositoryStarResponse{Preference: preference}), nil
}
