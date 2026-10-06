package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type reviewLifecycleFixture struct {
	*reviewRequestFixture
	dismissed atomic.Bool
	stale     atomic.Bool
	writes    atomic.Int32
	lost      atomic.Bool
	pending   atomic.Bool
}

func newReviewLifecycleFixture(t *testing.T) *reviewLifecycleFixture {
	f := &reviewLifecycleFixture{reviewRequestFixture: newReviewRequestFixture(t)}
	target, _ := url.Parse(f.s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := "/api/v1/repos/alice/private/pulls/7/reviews/9"
		if !strings.HasPrefix(r.URL.Path, route) {
			proxy.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			f.writes.Add(1)
			if strings.HasSuffix(r.URL.Path, "/dismissals") {
				var p map[string]any
				json.NewDecoder(r.Body).Decode(&p)
				if p["priors"] != false || p["message"] != "Selected review dismissal reason" {
					t.Error("unbound dismissal reason or broad prior mutation")
				}
				f.dismissed.Store(true)
			} else if strings.HasSuffix(r.URL.Path, "/undismissals") {
				f.dismissed.Store(false)
			} else {
				w.WriteHeader(404)
				return
			}
			if f.lost.Load() {
				w.WriteHeader(500)
				return
			}
		}
		row := forgePullReview{ID: 9, User: &User{ID: 43, Login: "bob"}, Body: "Exact review body", State: "APPROVED", CommitID: strings.Repeat("a", 40), Stale: f.stale.Load(), Dismissed: f.dismissed.Load(), Official: true, SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", PullRequestURL: "https://forge.invalid/alice/private/pulls/7", CommentsCount: proto.Int64(0)}
		if f.pending.Load() {
			row.State = "PENDING"
		}
		json.NewEncoder(w).Encode(row)
	}))
	t.Cleanup(provider.Close)
	config := f.s.config
	config.GiteaURL, config.GiteaPublicURL = provider.URL, provider.URL
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *reviewLifecycleFixture) lifecycleInput(t *testing.T, session loginResult, dismiss bool) *golfv1.SubmitPullReviewLifecycleRequest {
	ctx, token, _ := f.scope(session)
	snap, e := f.s.reviewLifecycleSnapshot(ctx, session.Value, token, &golfv1.GetPullReviewLifecycleStateRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "101", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40)})
	if e != nil {
		t.Fatal(e)
	}
	m := &golfv1.SubmitPullReviewLifecycleRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "101", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), ExpectedPullRevision: snap.PullRevision, ExpectedReviewRevision: snap.ReviewRevision, Dismiss: dismiss, OperationId: uuid.NewString()}
	if dismiss {
		m.Reason = "Selected review dismissal reason"
		m.ReasonHash = replyBodyHash(m.Reason)
	}
	return m
}
func (f *reviewLifecycleFixture) lifecycleSubmit(session loginResult, m *golfv1.SubmitPullReviewLifecycleRequest) (*golfv1.PullReviewLifecycleOperation, error) {
	ctx, _, h := f.scope(session)
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", h.Get("Cookie"))
	req.Header().Set("Origin", h.Get("Origin"))
	r, e := f.s.SubmitPullReviewLifecycle(ctx, req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func TestReviewLifecyclePostgres(t *testing.T) {
	f := newReviewLifecycleFixture(t)
	session := f.session(t, "pat")
	m := f.lifecycleInput(t, session, true)
	r, e := f.lifecycleSubmit(session, m)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || r.Original.Reason != "" || !f.dismissed.Load() {
		t.Fatal("dismissal", e, r)
	}
	replay, e := f.lifecycleSubmit(session, m)
	if e != nil || !proto.Equal(r, replay) || f.writes.Load() != 1 {
		t.Fatal("dismissal replay", e)
	}
	var raw []byte
	if e = f.db.QueryRow(`SELECT original FROM golf_pull_review_lifecycle_operations WHERE operation_id=$1`, m.OperationId).Scan(&raw); e != nil || strings.Contains(string(raw), m.Reason) {
		t.Fatal("reason retained")
	}
	restore := f.lifecycleInput(t, session, false)
	restored, e := f.lifecycleSubmit(session, restore)
	if e != nil || restored.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || f.dismissed.Load() {
		t.Fatal("restore", e, restored)
	}
	changed := proto.Clone(m).(*golfv1.SubmitPullReviewLifecycleRequest)
	changed.Dismiss = false
	changed.Reason = ""
	changed.ReasonHash = ""
	if _, e = f.lifecycleSubmit(session, changed); e == nil || f.writes.Load() != 2 {
		t.Fatal("rebound original")
	}
	f.mode.Store("reader")
	if _, e = f.lifecycleSubmit(session, restore); e == nil {
		t.Fatal("reader can inspect admin intent")
	}
}
func TestReviewLifecycleUnknownAndStalePostgres(t *testing.T) {
	for _, mode := range []string{"lost", "stale", "pending"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewLifecycleFixture(t)
			session := f.session(t, "pat")
			m := f.lifecycleInput(t, session, true)
			if mode == "lost" {
				f.lost.Store(true)
			}
			if mode == "stale" {
				m.ExpectedReviewRevision = strings.Repeat("d", 64)
			}
			if mode == "pending" {
				f.pending.Store(true)
			}
			r, e := f.lifecycleSubmit(session, m)
			if mode == "pending" {
				if e == nil || f.writes.Load() != 0 {
					t.Fatal("pending dismissal exposed")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			want := golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED
			if mode == "lost" {
				want = golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN
			}
			if r.Phase != want {
				t.Fatal("wrong outcome", r)
			}
			if mode == "lost" {
				if _, e = f.lifecycleSubmit(session, m); e != nil || f.writes.Load() != 1 {
					t.Fatal("unknown resend", e)
				}
				copy := proto.Clone(m).(*golfv1.SubmitPullReviewLifecycleRequest)
				copy.OperationId = uuid.NewString()
				if _, e = f.lifecycleSubmit(session, copy); e == nil || f.writes.Load() != 1 {
					t.Fatal("unknown bypass")
				}
			}
		})
	}
	f := newReviewLifecycleFixture(t)
	session := f.session(t, "pat")
	m := f.lifecycleInput(t, session, true)
	if _, e := f.lifecycleSubmit(session, m); e != nil {
		t.Fatal(e)
	}
	f.stale.Store(true)
	restore := f.lifecycleInput(t, session, false)
	r, e := f.lifecycleSubmit(session, restore)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED || f.writes.Load() != 1 {
		t.Fatal("stale approval restored", e, r)
	}
}
