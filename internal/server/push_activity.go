package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const pushActivityClockSkew = 5 * time.Second

var errPushActivityMissing = errors.New("fresh native push activity is unavailable")

type pushActivityEvent struct {
	SenderID   int64
	Ref, After string
}

// Native webhook headers are unsigned and bodies have no trustworthy push time.
// The initial personal-PAT slice therefore requires independently read native
// sponsor activity. Golf/PostgreSQL and the forge must have synchronized clocks;
// native second precision and the allowed clock skew deliberately exclude the
// first five seconds after grant creation.
// ponytail: only the newest 100 activities are searched; older events fail closed.
func (s *Server) verifyPushActivity(ctx context.Context, credential forgeCredential, g automationGrantRecord, event pushActivityEvent) (int64, error) {
	if event.SenderID <= 0 || event.SenderID != g.SponsorNativeUserID || g.CreatedAt.IsZero() ||
		!strings.HasPrefix(event.Ref, "refs/heads/") || !validRef(event.Ref) || !objectID.MatchString(event.After) || strings.Trim(event.After, "0") == "" {
		return 0, errPushActivityMissing
	}
	base, err := repositoryPath(repositoryKey{Owner: g.RepositoryOwner, Name: g.RepositoryName})
	if err != nil {
		return 0, err
	}
	for page := 1; page <= 2; page++ {
		var raw json.RawMessage
		headers, err := s.forgeJSON(ctx, http.MethodGet, fmt.Sprintf("%s/activities/feeds?page=%d&limit=50", base, page), credential, nil, &raw, http.StatusOK)
		if err != nil {
			return 0, err
		}
		date, err := http.ParseTime(headers.Get("Date"))
		skew := time.Since(date)
		if err != nil || skew < -pushActivityClockSkew || skew > pushActivityClockSkew || !boundedRepositoryEventJSON(raw) {
			return 0, errInvalidForgeResponse
		}
		var activities []struct {
			ID        int64     `json:"id"`
			RepoID    int64     `json:"repo_id"`
			ActorID   int64     `json:"act_user_id"`
			UserID    int64     `json:"user_id"`
			Operation string    `json:"op_type"`
			Ref       string    `json:"ref_name"`
			Created   time.Time `json:"created"`
			Content   string    `json:"content"`
		}
		if json.Unmarshal(raw, &activities) != nil || len(activities) > 50 || activities == nil {
			return 0, errInvalidForgeResponse
		}
		for _, a := range activities {
			if a.Operation != "commit_repo" || a.RepoID != g.RepositoryID || a.ActorID != event.SenderID || a.UserID != a.ActorID || a.Ref != event.Ref || !a.Created.After(g.CreatedAt.Add(pushActivityClockSkew)) {
				continue
			}
			if a.ID <= 0 || a.Created.After(date.Add(time.Second)) || len(a.Content) > 65535 || !boundedRepositoryEventJSON([]byte(a.Content)) {
				return 0, errInvalidForgeResponse
			}
			var content struct {
				HeadCommit *struct{ Sha1 string }
			}
			if json.Unmarshal([]byte(a.Content), &content) != nil {
				return 0, errInvalidForgeResponse
			}
			if content.HeadCommit != nil && content.HeadCommit.Sha1 == event.After {
				return a.ID, nil
			}
		}
		if len(activities) < 50 {
			break
		}
	}
	return 0, errPushActivityMissing
}
