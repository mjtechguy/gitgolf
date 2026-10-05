package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func nativeLabel(raw json.RawMessage) (*golfv1.DiscussionLabel, error) {
	metadata, err := discussionMetadata(forgeDiscussionMetadata{Labels: append(append(json.RawMessage("["), raw...), ']')})
	if err != nil {
		return nil, err
	}
	if metadata == nil || len(metadata.Labels) != 1 {
		return nil, errInvalidForgeResponse
	}
	return metadata.Labels[0], nil
}

func (s *Server) readRepositoryLabel(ctx context.Context, token forgeCredential, base string, id int64) (*golfv1.DiscussionLabel, error) {
	var raw json.RawMessage
	_, err := s.forge(ctx, http.MethodGet, base+"/labels/"+strconv.FormatInt(id, 10), token, nil, &raw)
	if err != nil {
		return nil, err
	}
	label, err := nativeLabel(raw)
	if err != nil {
		return nil, err
	}
	if label.Id != strconv.FormatInt(id, 10) {
		return nil, errInvalidForgeResponse
	}
	return label, nil
}

func (s *Server) ListRepositoryLabels(ctx context.Context, req *connect.Request[golfv1.ListRepositoryLabelsRequest]) (*connect.Response[golfv1.ListRepositoryLabelsResponse], error) {
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
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryLabelsResponse{}
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
			var raw json.RawMessage
			headers, err := s.forge(ctx, http.MethodGet, base+"/labels?"+query.Encode(), token, nil, &raw)
			if err != nil {
				return err
			}
			var rows []json.RawMessage
			raw = bytes.TrimSpace(raw)
			if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &rows) != nil || len(rows) > int(effective) {
				return errInvalidForgeResponse
			}
			next, err := pullNextPage(headers, page, effective)
			if err != nil {
				return err
			}
			seen := map[string]bool{}
			for _, raw := range rows {
				label, err := nativeLabel(raw)
				if err != nil {
					return err
				}
				if seen[label.Id] {
					return errInvalidForgeResponse
				}
				seen[label.Id] = true
				result.Labels = append(result.Labels, label)
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
		result.CanEditLabels = after && !delegated
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
