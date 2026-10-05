package server

import (
	"connectrpc.com/connect"
	"context"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Server) GetRepositoryMirrorStatus(ctx context.Context, req *connect.Request[golfv1.GetRepositoryMirrorStatusRequest]) (*connect.Response[golfv1.GetRepositoryMirrorStatusResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	key := keyFrom(req.Msg.Repository)
	base, e := repositoryPath(key)
	if e != nil {
		return nil, rpcError(e)
	}
	id, e := discussionID(req.Msg.RepositoryId)
	if e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetRepositoryMirrorStatusResponse
	e = s.withForgeCaller(ctx, session, token, func(actor User) error {
		before, e := s.rulesAuthority(ctx, token, key, actor)
		if e != nil {
			return e
		}
		if before.RepositoryId != req.Msg.RepositoryId {
			return errRepositoryAccessConflict
		}
		var row struct {
			ID          int64  `json:"id"`
			Mirror      *bool  `json:"mirror"`
			Interval    string `json:"mirror_interval"`
			Updated     string `json:"mirror_updated"`
			OriginalURL string `json:"original_url"`
		}
		if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &row); e != nil {
			return e
		}
		if row.ID != id || row.Mirror == nil || !profileText(row.Interval, 100, false) || (row.Updated != "" && !validRuleTime(row.Updated)) {
			return errInvalidForgeResponse
		}
		host := ""
		if *row.Mirror && row.OriginalURL != "" {
			u, e := url.Parse(row.OriginalURL)
			if e != nil || u.Hostname() == "" || !profileText(u.Hostname(), 255, false) {
				return errInvalidForgeResponse
			}
			host = strings.ToLower(u.Hostname())
		}
		updated := row.Updated
		if strings.HasPrefix(updated, "0001-") {
			updated = ""
		}
		result = &golfv1.GetRepositoryMirrorStatusResponse{Repository: req.Msg.Repository, RepositoryId: req.Msg.RepositoryId, PullMirror: *row.Mirror, Interval: row.Interval, LastUpdatedAt: updated, SourceHost: host}
		after, e := s.rulesAuthority(ctx, token, key, actor)
		if e != nil {
			return e
		}
		if before.RepositoryId != after.RepositoryId || before.OwnerId != after.OwnerId || before.Revision != after.Revision {
			return errRepositoryAccessConflict
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(result), nil
}
