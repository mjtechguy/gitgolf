package server

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type activityLimits struct {
	sync.Mutex
	users map[int64]int
	total int
}

func (s *Server) admitActivity(user int64) bool {
	s.activity.Lock()
	defer s.activity.Unlock()
	if s.activity.total >= 32 || s.activity.users[user] >= 4 {
		return false
	}
	if s.activity.users == nil {
		s.activity.users = make(map[int64]int)
	}
	s.activity.users[user]++
	s.activity.total++
	return true
}
func (s *Server) releaseActivity(user int64) {
	s.activity.Lock()
	defer s.activity.Unlock()
	s.activity.users[user]--
	if s.activity.users[user] == 0 {
		delete(s.activity.users, user)
	}
	s.activity.total--
}

// One short-lived Connect server stream. Keeping each response below the
// existing HTTP/chi deadlines preserves unary protections and bounds blocked
// proxy writes. The client resumes with the last authorized durable cursor.
func (s *Server) WatchRepository(ctx context.Context, req *connect.Request[golfv1.WatchRepositoryRequest], stream *connect.ServerStream[golfv1.WatchRepositoryResponse]) error {
	token, e := rpcToken(ctx)
	if e != nil {
		return e
	}
	repoID, e := strconv.ParseInt(req.Msg.RepositoryId, 10, 64)
	if e != nil || repoID <= 0 || strconv.FormatInt(repoID, 10) != req.Msg.RepositoryId {
		return rpcError(invalid("Select an exact repository identity."))
	}
	cursor := int64(0)
	if req.Msg.Cursor != "" {
		cursor, e = strconv.ParseInt(req.Msg.Cursor, 10, 64)
		if e != nil || cursor < 0 || strconv.FormatInt(cursor, 10) != req.Msg.Cursor {
			return rpcError(invalid("Invalid activity cursor."))
		}
	}
	topics := []string{}
	var actor, last int64
	read := func(initial bool) error {
		topics = nil
		return s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(_ string, repo Repository) error {
			if repo.ID != repoID {
				return errResourceNotFound
			}
			hash, e := s.authSessionHash(ctx, s.cookieValue(req.Header()), nil)
			if e != nil {
				return e
			}
			var current int64
			if s.db.QueryRowContext(ctx, "SELECT user_id FROM golf_sessions WHERE token_hash=$1", hash).Scan(&current) != nil {
				return errUnauthenticated
			}
			if actor != 0 && current != actor {
				return errUnauthenticated
			}
			actor = current
			if initial && cursor > 0 {
				var owned bool
				e = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2 AND id=$3 AND recipient_user_id IN (0,$4))`, s.config.GiteaURL, repoID, cursor, actor).Scan(&owned)
				if e != nil {
					return errStorageUnavailable
				}
				if !owned {
					return invalid("Activity cursor does not belong to this repository and caller.")
				}
			}
			if initial && req.Msg.Cursor == "" {
				e = s.db.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2 AND recipient_user_id IN (0,$3)`, s.config.GiteaURL, repoID, actor).Scan(&last)
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			}
			rows, e := s.db.QueryContext(ctx, `SELECT id,topic FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2 AND recipient_user_id IN (0,$3) AND id>$4 ORDER BY id LIMIT 100`, s.config.GiteaURL, repoID, actor, cursor)
			if e != nil {
				return errStorageUnavailable
			}
			defer rows.Close()
			seen := make(map[string]bool)
			last = cursor
			for rows.Next() {
				var id int64
				var topic string
				if rows.Scan(&id, &topic) != nil {
					return errStorageUnavailable
				}
				last = id
				if !seen[topic] {
					seen[topic] = true
					topics = append(topics, topic)
				}
			}
			if rows.Err() != nil {
				return errStorageUnavailable
			}
			return nil
		})
	}
	if e = read(true); e != nil {
		return rpcError(e)
	}
	if !s.admitActivity(actor) {
		return connect.NewError(connect.CodeResourceExhausted, errors.New("Too many live repository connections. Close another tab and reconnect."))
	}
	defer s.releaseActivity(actor)
	send := func(kind string) error {
		if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
			if e := s.checkApiCaller(ctx, token); e != nil {
				return rpcError(e)
			}
		}
		// Zero is a real empty-history watermark. Only an omitted request cursor
		// starts a fresh observation; resuming zero must replay the first event.
		message := &golfv1.WatchRepositoryResponse{RepositoryId: req.Msg.RepositoryId, Kind: kind, Topics: topics, Cursor: strconv.FormatInt(last, 10)}
		if e := stream.Send(message); e != nil {
			return e
		}
		cursor = last
		return nil
	}
	stream.ResponseHeader().Set("Cache-Control", "no-store")
	stream.ResponseHeader().Set("X-Accel-Buffering", "no")
	kind := "reset"
	if req.Msg.Cursor != "" {
		kind = "change"
		if len(topics) == 0 {
			kind = "heartbeat"
		}
	}
	if e = send(kind); e != nil {
		return e
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	end := time.NewTimer(10 * time.Second)
	defer end.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-end.C:
			if e = read(false); e != nil {
				return rpcError(e)
			}
			if len(topics) > 0 {
				if e = send("change"); e != nil {
					return e
				}
			}
			topics = nil
			return send("reconnect")
		case <-ticker.C:
			if e = read(false); e != nil {
				return rpcError(e)
			}
			kind = "heartbeat"
			if len(topics) > 0 {
				kind = "change"
			}
			if e = send(kind); e != nil {
				return e
			}
		}
	}
}
