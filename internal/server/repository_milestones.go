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

// Initial milestone edits deliberately require native repository administrator
// authority. Generic code push and issue authorship do not imply unit writes.
func (s *Server) milestoneEditAuthority(ctx context.Context, token forgeCredential, base string, repo Repository) (bool, error) {
	var row struct {
		Repository
		Permissions *struct {
			Admin *bool `json:"admin"`
		} `json:"permissions"`
		Archived *bool `json:"archived"`
	}
	_, err := s.forge(ctx, http.MethodGet, base, token, nil, &row)
	if err != nil {
		return false, err
	}
	if row.ID != repo.ID || !strings.EqualFold(row.FullName, repo.FullName) || row.Permissions == nil || row.Permissions.Admin == nil || row.Archived == nil || row.IssuesEnabled == nil {
		return false, errInvalidForgeResponse
	}
	return *row.Permissions.Admin && !*row.Archived && *row.IssuesEnabled, nil
}

func nativeMilestone(raw json.RawMessage) (*golfv1.DiscussionMilestone, error) {
	metadata, err := discussionMetadata(forgeDiscussionMetadata{Milestone: raw})
	if err != nil {
		return nil, err
	}
	if metadata == nil || metadata.Milestone == nil {
		return nil, errInvalidForgeResponse
	}
	return metadata.Milestone, nil
}

func (s *Server) readRepositoryMilestone(ctx context.Context, token forgeCredential, base string, id int64) error {
	var raw json.RawMessage
	_, err := s.forge(ctx, http.MethodGet, base+"/milestones/"+strconv.FormatInt(id, 10), token, nil, &raw)
	if err != nil {
		return err
	}
	milestone, err := nativeMilestone(raw)
	if err != nil {
		return err
	}
	if milestone.Id != strconv.FormatInt(id, 10) {
		return errInvalidForgeResponse
	}
	return nil
}

func (s *Server) ListRepositoryMilestones(ctx context.Context, req *connect.Request[golfv1.ListRepositoryMilestonesRequest]) (*connect.Response[golfv1.ListRepositoryMilestonesResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	state, err := pullState(req.Msg.State)
	if err != nil {
		return nil, rpcError(err)
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryMilestonesResponse{}
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		allowed, err := s.milestoneEditAuthority(ctx, token, base, repo)
		if err != nil {
			return err
		}
		err = s.withNativePageSize(ctx, token, limit, func(effective uint32) error {
			query := pageQuery(page, effective)
			query.Set("state", state)
			var rows []json.RawMessage
			headers, err := s.forge(ctx, http.MethodGet, base+"/milestones?"+query.Encode(), token, nil, &rows)
			if err != nil {
				return err
			}
			if len(rows) > int(effective) {
				return errInvalidForgeResponse
			}
			next, err := pullNextPage(headers, page, effective)
			if err != nil {
				return err
			}
			seen := map[string]bool{}
			for _, raw := range rows {
				milestone, err := nativeMilestone(raw)
				if err != nil {
					return err
				}
				if seen[milestone.Id] || state != "all" && (state == "open") != (milestone.State == golfv1.IssueState_ISSUE_STATE_OPEN) {
					return errInvalidForgeResponse
				}
				seen[milestone.Id] = true
				result.Milestones = append(result.Milestones, milestone)
			}
			result.Page = wirePage(next)
			return nil
		})
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
		_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
		result.CanEditMilestone = after && !delegated
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
