package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVerifyPushActivity(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	grant := automationGrantRecord{RepositoryID: 91, RepositoryOwner: "alice", RepositoryName: "example", SponsorNativeUserID: 42, CreatedAt: now.Add(-10 * time.Second)}
	event := pushActivityEvent{SenderID: 42, Ref: "refs/heads/main", After: strings.Repeat("a", 40)}
	for _, tc := range []struct {
		name string
		edit func(map[string]any, *pushActivityEvent)
		date string
		want error
	}{
		{name: "fresh"},
		{name: "historical", edit: func(a map[string]any, _ *pushActivityEvent) { a["created"] = now.Add(-20 * time.Second) }, want: errPushActivityMissing},
		{name: "same second", edit: func(a map[string]any, _ *pushActivityEvent) { a["created"] = grant.CreatedAt }, want: errPushActivityMissing},
		{name: "within clock margin", edit: func(a map[string]any, _ *pushActivityEvent) { a["created"] = grant.CreatedAt.Add(4 * time.Second) }, want: errPushActivityMissing},
		{name: "exact clock margin", edit: func(a map[string]any, _ *pushActivityEvent) {
			a["created"] = grant.CreatedAt.Add(pushActivityClockSkew)
		}, want: errPushActivityMissing},
		{name: "beyond clock margin", edit: func(a map[string]any, _ *pushActivityEvent) { a["created"] = grant.CreatedAt.Add(6 * time.Second) }},
		{name: "foreign sponsor", edit: func(_ map[string]any, e *pushActivityEvent) { e.SenderID = 84 }, want: errPushActivityMissing},
		{name: "foreign actor", edit: func(a map[string]any, _ *pushActivityEvent) { a["act_user_id"] = 84 }, want: errPushActivityMissing},
		{name: "watcher copy", edit: func(a map[string]any, _ *pushActivityEvent) { a["user_id"] = 84 }, want: errPushActivityMissing},
		{name: "foreign repo", edit: func(a map[string]any, _ *pushActivityEvent) { a["repo_id"] = 92 }, want: errPushActivityMissing},
		{name: "foreign branch", edit: func(a map[string]any, _ *pushActivityEvent) { a["ref_name"] = "refs/heads/other" }, want: errPushActivityMissing},
		{name: "mirror", edit: func(a map[string]any, _ *pushActivityEvent) { a["op_type"] = "mirror_sync_push" }, want: errPushActivityMissing},
		{name: "head mismatch", edit: func(a map[string]any, _ *pushActivityEvent) {
			a["content"] = `{"HeadCommit":{"Sha1":"` + strings.Repeat("b", 40) + `"}}`
		}, want: errPushActivityMissing},
		{name: "truncated native content", edit: func(a map[string]any, _ *pushActivityEvent) { a["content"] = `{}` }, want: errPushActivityMissing},
		{name: "malformed content", edit: func(a map[string]any, _ *pushActivityEvent) { a["content"] = `{"HeadCommit":` }, want: errInvalidForgeResponse},
		{name: "duplicate keys", edit: func(a map[string]any, _ *pushActivityEvent) { a["content"] = `{"HeadCommit":null,"HeadCommit":{}}` }, want: errInvalidForgeResponse},
		{name: "oversized content", edit: func(a map[string]any, _ *pushActivityEvent) { a["content"] = strings.Repeat("x", 65536) }, want: errInvalidForgeResponse},
		{name: "future action", edit: func(a map[string]any, _ *pushActivityEvent) { a["created"] = now.Add(time.Hour) }, want: errInvalidForgeResponse},
		{name: "invalid identity", edit: func(a map[string]any, _ *pushActivityEvent) { a["id"] = 0 }, want: errInvalidForgeResponse},
		{name: "clock skew", date: now.Add(-time.Minute).Format(http.TimeFormat), want: errInvalidForgeResponse},
		{name: "bad date", date: "invalid", want: errInvalidForgeResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := map[string]any{"id": 123, "repo_id": 91, "act_user_id": 42, "user_id": 42, "op_type": "commit_repo", "ref_name": event.Ref, "created": now.Add(-time.Second), "content": `{"HeadCommit":{"Sha1":"` + event.After + `"},"Commits":[],"Len":1,"CompareURL":"unused"}`}
			e := event
			if tc.edit != nil {
				tc.edit(a, &e)
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/repos/alice/example/activities/feeds" || r.URL.Query().Get("limit") != "50" || r.Header.Get("Authorization") != "token delegated" {
					t.Error("incorrect authenticated activity request")
				}
				if tc.date != "" {
					w.Header().Set("Date", tc.date)
				}
				json.NewEncoder(w).Encode([]any{a})
			}))
			defer provider.Close()
			s, err := New(testConfig(provider.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			id, err := s.verifyPushActivity(t.Context(), forgeCredential{Kind: "pat", Token: "delegated"}, grant, e)
			if !errors.Is(err, tc.want) || (tc.want == nil && id != 123) || (tc.want != nil && id != 0) {
				t.Fatalf("id=%d error=%v; want %v", id, err, tc.want)
			}
		})
	}
}

func TestVerifyPushActivityPageBound(t *testing.T) {
	for _, success := range []bool{false, true} {
		calls := 0
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			rows := make([]map[string]any, 50)
			for i := range rows {
				rows[i] = map[string]any{"op_type": "create_issue"}
			}
			if success && calls == 2 {
				rows[49] = map[string]any{"id": 99, "repo_id": 91, "act_user_id": 42, "user_id": 42, "op_type": "commit_repo", "ref_name": "refs/heads/main", "created": time.Now().UTC().Add(-time.Second), "content": `{"HeadCommit":{"Sha1":"` + strings.Repeat("a", 40) + `"}}`}
			}
			json.NewEncoder(w).Encode(rows)
		}))
		s, err := New(testConfig(provider.URL), nil)
		if err != nil {
			t.Fatal(err)
		}
		id, err := s.verifyPushActivity(t.Context(), forgeCredential{Kind: "pat", Token: "delegated"}, automationGrantRecord{RepositoryID: 91, RepositoryOwner: "alice", RepositoryName: "example", SponsorNativeUserID: 42, CreatedAt: time.Now().Add(-time.Hour)}, pushActivityEvent{SenderID: 42, Ref: "refs/heads/main", After: strings.Repeat("a", 40)})
		provider.Close()
		if calls != 2 || (success && (err != nil || id != 99)) || (!success && !errors.Is(err, errPushActivityMissing)) {
			t.Fatalf("success=%t calls=%d id=%d error=%v", success, calls, id, err)
		}
	}
}

func TestVerifyPushActivityMalformedFeed(t *testing.T) {
	for _, body := range []string{
		`null`,
		`[{"id":1,"id":2}]`,
		`[` + strings.Repeat(`{},`, 50) + `{}]`,
		strings.Repeat(`[`, 33) + `0` + strings.Repeat(`]`, 33),
	} {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		s, err := New(testConfig(provider.URL), nil)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.verifyPushActivity(t.Context(), forgeCredential{Kind: "pat", Token: "delegated"}, automationGrantRecord{RepositoryID: 91, RepositoryOwner: "alice", RepositoryName: "example", SponsorNativeUserID: 42, CreatedAt: time.Now().Add(-time.Hour)}, pushActivityEvent{SenderID: 42, Ref: "refs/heads/main", After: strings.Repeat("a", 40)})
		provider.Close()
		if !errors.Is(err, errInvalidForgeResponse) {
			t.Fatalf("malformed feed returned %v", err)
		}
	}
}
