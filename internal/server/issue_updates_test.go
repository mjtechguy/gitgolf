package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func updateIssueInput(f *discussionFixture, key string) *golfv1.UpdateIssueRequest {
	f.mu.Lock()
	row := f.issues[1]
	f.mu.Unlock()
	return &golfv1.UpdateIssueRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", IssueId: "41", Number: 1, ExpectedRevision: issueRevision(row.Issue), IdempotencyKey: key}
}
func TestIssueUpdateLifecycle(t *testing.T) {
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	ctx := t.Context()
	for i, field := range []string{"title", "body", "close", "reopen"} {
		input := updateIssueInput(f, discussionKey(i+1))
		switch field {
		case "title":
			input.Title = proto.String("Edited title")
		case "body":
			input.Body = proto.String("")
		case "close":
			input.State = golfv1.IssueState_ISSUE_STATE_CLOSED
		case "reopen":
			input.State = golfv1.IssueState_ISSUE_STATE_OPEN
		}
		var wg sync.WaitGroup
		for j := 0; j < 5; j++ {
			wg.Go(func() {
				r, err := client.UpdateIssue(ctx, connect.NewRequest(input))
				if err != nil {
					t.Error(err)
					return
				}
				if r.Msg.Mutation.Kind != golfv1.IssueMutationKind_ISSUE_MUTATION_KIND_UPDATE_ISSUE {
					t.Error("wrong kind")
				}
			})
		}
		wg.Wait()
		r, err := client.GetIssueMutation(ctx, connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: input.IdempotencyKey}))
		if err != nil {
			t.Fatal(err)
		}
		if r.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || r.Msg.Issue == nil || r.Msg.Mutation.ObservedResultId != "41" {
			t.Fatalf("not verified: %v", r.Msg.Mutation)
		}
		if field == "body" && r.Msg.Issue.Body != "" {
			t.Fatal("explicit empty body was lost")
		}
		if f.patches.Load() != int32(i+1) {
			t.Fatal("duplicate PATCH")
		}
	}
	var events int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutation_events").Scan(&events); err != nil || events != 12 {
		t.Fatal("missing journal events", events, err)
	}
	if _, err := f.db.Exec("UPDATE golf_issue_mutations SET issue_id=99"); err == nil {
		t.Fatal("terminal identity mutable")
	}
	var activity int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE topic='issues'").Scan(&activity); err != nil || activity != 4 {
		t.Fatal("missing live invalidation", activity, err)
	}
}
func TestIssueUpdatePreflightAndConflict(t *testing.T) {
	f := newDiscussionFixture(t)
	client, _ := f.client(t, "alice")
	ctx := t.Context()
	input := updateIssueInput(f, discussionKey(1))
	input.Title = proto.String("Edited title")
	input.Body = proto.String("mixed")
	if _, err := client.UpdateIssue(ctx, connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("multi-field PATCH accepted", err)
	}
	input.Body = nil
	input.ExpectedRevision = "bad"
	if _, err := client.UpdateIssue(ctx, connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("invalid revision", err)
	}
	input = updateIssueInput(f, discussionKey(1))
	input.Title = proto.String("Edited title")
	f.mu.Lock()
	row := f.issues[1]
	row.Title = "Concurrent edit"
	f.issues[1] = row
	f.mu.Unlock()
	r, err := client.UpdateIssue(ctx, connect.NewRequest(input))
	if err != nil || r.Msg.Mutation.FailureCode != "revision_changed" || f.patches.Load() != 0 {
		t.Fatal("stale edit dispatched", err)
	}
	input.ExpectedRevision = issueRevision(row.Issue)
	if _, err := client.UpdateIssue(ctx, connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("key allowed changed revision", err)
	}
	input.IdempotencyKey = discussionKey(2)
	input.Title = proto.String(row.Title)
	r, err = client.UpdateIssue(ctx, connect.NewRequest(input))
	if err != nil || r.Msg.Mutation.FailureCode != "unchanged" || f.patches.Load() != 0 {
		t.Fatal("no-op sent", err)
	}
	input = updateIssueInput(f, discussionKey(3))
	input.Title = proto.String("New title")
	f.mu.Lock()
	row = f.issues[1]
	row.ID = 99
	f.issues[1] = row
	f.mu.Unlock()
	r, err = client.UpdateIssue(ctx, connect.NewRequest(input))
	if err != nil || r.Msg.Mutation.FailureCode != "target_changed" || f.patches.Load() != 0 {
		t.Fatal("replaced target sent", err)
	}
}
func TestIssueUpdateUnknownAndNativeDenials(t *testing.T) {
	for _, status := range []int{403, 409, 412, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, _ := f.client(t, "alice")
			input := updateIssueInput(f, discussionKey(1))
			input.State = golfv1.IssueState_ISSUE_STATE_CLOSED
			f.patchStatus.Store(int32(status))
			r, err := client.UpdateIssue(t.Context(), connect.NewRequest(input))
			if err != nil {
				t.Fatal(err)
			}
			expected := golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
			if status == 500 {
				expected = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN
			}
			if r.Msg.Mutation.State != expected {
				t.Fatal("wrong failure state", r.Msg.Mutation)
			}
			if _, err := client.UpdateIssue(t.Context(), connect.NewRequest(input)); err != nil || f.patches.Load() != 1 {
				t.Fatal("denial replay sent", err)
			}
		})
	}
	for _, mode := range []string{"lost", "changed", "wrong-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, _ := f.client(t, "alice")
			input := updateIssueInput(f, discussionKey(1))
			input.Body = proto.String("New body")
			f.patchHook = func(w http.ResponseWriter, _ *http.Request, row discussionIssue) bool {
				switch mode {
				case "lost":
					w.WriteHeader(500)
				case "changed":
					f.mu.Lock()
					changed := f.issues[1]
					changed.Body = "Changed after receipt"
					f.issues[1] = changed
					f.mu.Unlock()
					w.WriteHeader(201)
					_ = json.NewEncoder(w).Encode(row)
				case "wrong-receipt":
					row.ID = 99
					w.WriteHeader(201)
					_ = json.NewEncoder(w).Encode(row)
				}
				return true
			}
			r, err := client.UpdateIssue(t.Context(), connect.NewRequest(input))
			if err != nil || r.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("unknown became success", err)
			}
			if _, err := client.UpdateIssue(t.Context(), connect.NewRequest(input)); err != nil || f.patches.Load() != 1 {
				t.Fatal("unknown replay sent", err)
			}
			foreign, _ := f.client(t, "bob")
			if _, err := foreign.GetIssueMutation(context.Background(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: input.IdempotencyKey})); connect.CodeOf(err) != connect.CodeNotFound {
				t.Fatal("foreign receipt exposed", err)
			}
		})
	}
}

func TestIssueUpdateRPCBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	path := "/golf.v1.RepositoryService/UpdateIssue"
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
		r := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("pre-decode auth/origin boundary", w.Code)
		}
	}
	if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); response.Code != 403 {
		t.Fatal("read-only API credential reached update", response.Code)
	}
}

func TestIssueUpdateTargetRevisionAndRevocation(t *testing.T) {
	for _, mode := range []string{"pull-request", "missing-version", "negative-version", "changed-user", "revoked-after-patch"} {
		t.Run(mode, func(t *testing.T) {
			f := newDiscussionFixture(t)
			client, source := f.client(t, "alice")
			other, _ := f.client(t, "alice")
			input := updateIssueInput(f, discussionKey(1))
			input.Title = proto.String("Edited title")
			f.mu.Lock()
			row := f.issues[1]
			switch mode {
			case "pull-request":
				row.PullRequest = json.RawMessage(`{"url":"native PR"}`)
			case "missing-version":
				row.ContentVersion = nil
			case "negative-version":
				row.ContentVersion = proto.Int64(-1)
			}
			f.issues[1] = row
			f.mu.Unlock()
			if mode == "changed-user" {
				f.userMode.Store(2)
			}
			if mode == "revoked-after-patch" {
				f.patchHook = func(_ http.ResponseWriter, _ *http.Request, _ discussionIssue) bool {
					if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
						t.Error(err)
					}
					return false
				}
			}
			result, err := client.UpdateIssue(t.Context(), connect.NewRequest(input))
			if mode == "changed-user" || mode == "revoked-after-patch" {
				if connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("changed/revoked identity accepted", err)
				}
			} else if err != nil || result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED {
				t.Fatal("unverifiable target accepted", err)
			}
			if mode != "revoked-after-patch" && f.patches.Load() != 0 {
				t.Fatal("invalid target dispatched")
			}
			if mode == "revoked-after-patch" {
				observed, err := other.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: input.IdempotencyKey}))
				if err != nil || observed.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN || observed.Msg.Mutation.ObservedResultId != "41" {
					t.Fatal("revoked caller promoted receipt", err)
				}
				if _, err := other.UpdateIssue(t.Context(), connect.NewRequest(input)); err != nil || f.patches.Load() != 1 {
					t.Fatal("new session redispatched uncertain update", err)
				}
			}
		})
	}
}
