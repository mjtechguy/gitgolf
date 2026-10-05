package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Pinned native assignee inventory has no page/limit contract. Refuse overflow
// rather than representing a partial inventory as complete.
func (s *Server) readRepositoryAssignees(ctx context.Context, token forgeCredential, base string) ([]User, error) {
	var raw json.RawMessage
	_, err := s.forgeJSON(ctx, http.MethodGet, base+"/assignees", token, nil, &raw, http.StatusOK)
	if err != nil {
		return nil, err
	}
	raw = bytes.TrimSpace(raw)
	var rows []*User
	if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &rows) != nil || len(rows) > 1000 {
		return nil, errInvalidForgeResponse
	}
	ids, logins := map[int64]bool{}, map[string]bool{}
	result := make([]User, 0, len(rows))
	for _, row := range rows {
		if row == nil || row.ID <= 0 || !validPullUser(row) || !discussionText(row.FullName, 1024) || ids[row.ID] || logins[strings.ToLower(row.Login)] {
			return nil, errInvalidForgeResponse
		}
		ids[row.ID], logins[strings.ToLower(row.Login)] = true, true
		result = append(result, *row)
	}
	return result, nil
}

func (s *Server) ListRepositoryAssignees(ctx context.Context, req *connect.Request[golfv1.ListRepositoryAssigneesRequest]) (*connect.Response[golfv1.ListRepositoryAssigneesResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryAssigneesResponse{}
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		allowed, err := s.milestoneEditAuthority(ctx, token, base, repo)
		if err != nil {
			return err
		}
		rows, err := s.readRepositoryAssignees(ctx, token, base)
		if err != nil {
			return err
		}
		after, err := s.milestoneEditAuthority(ctx, token, base, repo)
		if err != nil {
			return err
		}
		if allowed != after {
			return errInvalidForgeResponse
		}
		for _, row := range rows {
			result.Assignees = append(result.Assignees, wireUser(row))
		}
		_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
		result.CanEditAssignees = after && !delegated
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
