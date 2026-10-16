package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	golfv1connect "github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

type engagementFixture struct {
	*resourceFixture
	reacted, subscribed bool
	engagementWrites    int
	fault               string
}

func newEngagementFixture(t *testing.T) *engagementFixture {
	t.Helper()
	f := &engagementFixture{resourceFixture: newResourceFixture(t)}
	provider := httptest.NewServer(http.HandlerFunc(f.serveEngagement))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *engagementFixture) serveEngagement(w http.ResponseWriter, r *http.Request) {
	const base = "/api/v1/repos/alice/private"
	w.Header().Set("Content-Type", "application/json")
	if strings.HasSuffix(r.URL.Path, "/reactions") || strings.Contains(r.URL.Path, "/subscriptions/") {
		f.lock.Lock()
		defer f.lock.Unlock()
		if r.Method == http.MethodGet {
			if strings.HasSuffix(r.URL.Path, "/subscriptions/check") {
				_ = json.NewEncoder(w).Encode(map[string]bool{"subscribed": f.subscribed, "ignored": !f.subscribed})
				return
			}
			rows := []nativeDiscussionReaction{}
			if f.reacted {
				rows = append(rows, nativeDiscussionReaction{User: &User{ID: 42, Login: "alice"}, Content: "+1", Created: "2026-10-05T00:00:00Z"})
			}
			if f.fault == "duplicate" {
				rows = append(rows, rows...)
			}
			w.Header().Set("X-Total-Count", "0")
			if len(rows) > 0 {
				w.Header().Set("X-Total-Count", "1")
			}
			_ = json.NewEncoder(w).Encode(rows)
			return
		}
		f.engagementWrites++
		if f.fault != "ignored" {
			if strings.HasSuffix(r.URL.Path, "/reactions") {
				f.reacted = r.Method == http.MethodPost
			} else {
				f.subscribed = r.Method == http.MethodPut
			}
		}
		if f.fault == "lost" {
			h, _, _ := w.(http.Hijacker).Hijack()
			_ = h.Close()
			return
		}
		if r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/reactions") {
			w.WriteHeader(http.StatusNoContent)
		} else {
			w.WriteHeader(http.StatusCreated)
		}
		return
	}
	if strings.HasSuffix(r.URL.Path, "/timeline") {
		w.Header().Set("X-Total-Count", "1")
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": 91, "type": "change_title", "user": map[string]any{"id": 42, "login": "alice"}, "created_at": "2026-10-05T00:00:00Z", "issue_url": "https://forge.invalid/alice/private/issues/7", "pull_request_url": "https://forge.invalid/alice/private/pulls/7", "old_title": "Before", "new_title": "After", "body": "private external event body", "ref_issue": map[string]any{"id": 800, "number": 88, "repository": map[string]any{"id": 999}, "title": "secret cross-repo title"}}})
		return
	}
	f.serveResources(w, r)
}
func engagementRequest(f *engagementFixture, kind golfv1.DiscussionResourceOperationKind, revision string, comment bool) *golfv1.SubmitDiscussionResourceOperationRequest {
	m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", IssueId: "77", ResourceId: "77", Number: 7, PullRequest: true, OperationId: randomUUID(), Kind: kind, ExpectedRevision: revision}
	if comment {
		m.ResourceId = "31"
		m.ReactionComment = true
	}
	if kind == 9 || kind == 10 {
		m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_Reaction{Reaction: "+1"}
	} else {
		m.SubscriptionLogin = "alice"
	}
	return m
}
func (f *engagementFixture) engagementClient(t *testing.T, session loginResult) golfv1connect.DiscussionCollaborationServiceClient {
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewDiscussionCollaborationServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", f.s.config.PublicURL)
			return next(ctx, req)
		}
	})))
}
func TestDiscussionEngagementLifecyclePostgres(t *testing.T) {
	for _, comment := range []bool{false, true} {
		t.Run(map[bool]string{false: "description", true: "comment"}[comment], func(t *testing.T) {
			f := newEngagementFixture(t)
			session := f.session(t, "pat")
			reads := f.engagementClient(t, session)
			writes := f.client(t, session)
			target := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}
			if comment {
				target.CommentId = "31"
			}
			kinds := []golfv1.DiscussionResourceOperationKind{9, 10}
			if !comment {
				kinds = append(kinds, 11, 12)
			}
			for i, kind := range kinds {
				current, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
				if e != nil || len(current.Msg.Reactions) != 8 {
					t.Fatalf("read %v %v", current, e)
				}
				m := engagementRequest(f, kind, current.Msg.Revision, comment)
				result, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e != nil || result.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
					t.Fatalf("write %v %v", result, e)
				}
				replay, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e != nil || replay.Msg.Operation.Phase != result.Msg.Operation.Phase || f.engagementWrites != i+1 {
					t.Fatalf("replay %v %v writes%d", replay, e, f.engagementWrites)
				}
			}
			var events int
			if e := f.db.QueryRow(`SELECT count(*) FROM golf_discussion_resource_events`).Scan(&events); e != nil || events != len(kinds)*3 {
				t.Fatal(events, e)
			}
		})
	}
}
func TestDiscussionEngagementUnknownPostgres(t *testing.T) {
	for _, fault := range []string{"lost", "ignored"} {
		t.Run(fault, func(t *testing.T) {
			f := newEngagementFixture(t)
			session := f.session(t, "pat")
			writes := f.client(t, session)
			reads := f.engagementClient(t, session)
			target := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}
			current, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
			if e != nil {
				t.Fatal(e)
			}
			m := engagementRequest(f, 9, current.Msg.Revision, false)
			f.fault = fault
			result, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
			if e != nil || result.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN {
				t.Fatalf("uncertain %v %v", result, e)
			}
			for range 2 {
				result, e = writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e != nil || f.engagementWrites != 1 || result.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN {
					t.Fatalf("resend %v %v %d", result, e, f.engagementWrites)
				}
			}
		})
	}
}
func TestDiscussionEngagementOwnTargetAndTimelinePostgres(t *testing.T) {
	f := newEngagementFixture(t)
	session := f.session(t, "pat")
	reads := f.engagementClient(t, session)
	writes := f.client(t, session)
	target := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}
	current, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
	if e != nil {
		t.Fatal(e)
	}
	m := engagementRequest(f, 11, current.Msg.Revision, false)
	m.SubscriptionLogin = "bob"
	result, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
	if e != nil || result.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED || f.engagementWrites != 0 {
		t.Fatalf("other-user %v %v", result, e)
	}
	m = engagementRequest(f, 9, strings.Repeat("a", 64), false)
	result, e = writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
	if e != nil || result.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED || f.engagementWrites != 0 {
		t.Fatalf("stale %v %v", result, e)
	}
	rebound := proto.Clone(target).(*golfv1.DiscussionTarget)
	rebound.IssueId = "78"
	if _, e = reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: rebound})); e == nil {
		t.Fatal("rebound accepted")
	}
	timeline, e := reads.ListDiscussionTimeline(t.Context(), connect.NewRequest(&golfv1.ListDiscussionTimelineRequest{Target: target}))
	if e != nil || len(timeline.Msg.Events) != 1 || timeline.Msg.Events[0].ReferencedNumber != 0 || timeline.Msg.Events[0].Body != "" || strings.Contains(timeline.Msg.String(), "secret") {
		t.Fatalf("timeline leakage %v %v", timeline, e)
	}
}
