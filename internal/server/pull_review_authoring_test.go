package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type authoringFixture struct {
	*reviewRequestFixture
	mu       sync.Mutex
	review   *forgePullReview
	comments []forgePullReviewComment
	writes   atomic.Int32
	lost     atomic.Bool
}

func newAuthoringFixture(t *testing.T) *authoringFixture {
	f := &authoringFixture{reviewRequestFixture: newReviewRequestFixture(t), comments: []forgePullReviewComment{}}
	target, _ := url.Parse(f.s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		base := "/api/v1/repos/alice/private"
		reviews := base + "/pulls/7/reviews"
		if r.URL.Path == "/api/v1/user" {
			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, r)
			if rec.Code != 200 {
				w.WriteHeader(rec.Code)
				w.Write(rec.Body.Bytes())
				return
			}
			var raw map[string]any
			json.Unmarshal(rec.Body.Bytes(), &raw)
			raw["is_admin"] = false
			json.NewEncoder(w).Encode(raw)
			return
		}
		if !strings.HasPrefix(r.URL.Path, reviews) && r.URL.Path != base+"/issues/comments/90" {
			proxy.ServeHTTP(w, r)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodGet {
			if r.URL.Path == reviews {
				rows := []forgePullReview{}
				if f.review != nil {
					rows = append(rows, *f.review)
				}
				w.Header().Set("X-Total-Count", strconv.Itoa(len(rows)))
				json.NewEncoder(w).Encode(rows)
				return
			}
			if f.review == nil {
				w.WriteHeader(404)
				return
			}
			if r.URL.Path == reviews+"/9" {
				json.NewEncoder(w).Encode(f.review)
				return
			}
			if r.URL.Path == reviews+"/9/comments" {
				json.NewEncoder(w).Encode(f.comments)
				return
			}
			w.WriteHeader(404)
			return
		}
		f.writes.Add(1)
		var payload struct {
			Body, Event, Head string
			CommitID          string `json:"commit_id"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		switch {
		case r.URL.Path == reviews && r.Method == "POST":
			if f.review == nil {
				f.review = &forgePullReview{ID: 9, User: &User{ID: 42, Login: "alice"}, State: "PENDING", CommitID: payload.CommitID, SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", PullRequestURL: "https://forge.invalid/alice/private/pulls/7", CommentsCount: proto.Int64(0)}
			}
			f.review.Body = payload.Body
		case r.URL.Path == reviews+"/9" && r.Method == "POST":
			if f.review == nil {
				w.WriteHeader(404)
				return
			}
			f.review.State = payload.Event
			f.review.Body = payload.Body
		case r.URL.Path == reviews+"/9" && r.Method == "DELETE":
			f.review = nil
			f.comments = []forgePullReviewComment{}
		case r.URL.Path == base+"/issues/comments/90" && r.Method == "PATCH":
			if len(f.comments) != 1 {
				w.WriteHeader(404)
				return
			}
			f.comments[0].Body = payload.Body
		case r.URL.Path == base+"/issues/comments/90" && r.Method == "DELETE":
			f.comments = []forgePullReviewComment{}
			f.review.CommentsCount = proto.Int64(0)
		default:
			w.WriteHeader(405)
			return
		}
		if f.lost.Load() {
			w.WriteHeader(500)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		if r.Method == "PATCH" {
			json.NewEncoder(w).Encode(f.comments[0])
			return
		}
		json.NewEncoder(w).Encode(f.review)
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
func authoringTarget() *golfv1.PullReviewDraftTarget {
	return &golfv1.PullReviewDraftTarget{Repository: pullKey, RepositoryId: "11", PullRequestId: "101", Number: 7}
}
func (f *authoringFixture) input(t *testing.T, session loginResult, kind golfv1.PullReviewAuthoringKind, body string) *golfv1.SubmitPullReviewAuthoringOperationRequest {
	selection := &golfv1.GetPullReviewAuthoringStateRequest{Target: authoringTarget()}
	if kind != authorCreate && kind != authorPrivate {
		selection.ReviewId = "9"
		selection.ReviewCommitId = strings.Repeat("a", 40)
	}
	if kind == authorEdit || kind == authorDelete {
		selection.CommentId = "90"
	}
	ctx, token, _ := f.scope(session)
	snap, e := f.s.authoringState(ctx, session.Value, token, selection)
	if e != nil {
		t.Fatal(e)
	}
	m := &golfv1.SubmitPullReviewAuthoringOperationRequest{Target: selection.Target, Kind: kind, ReviewId: selection.ReviewId, ReviewCommitId: selection.ReviewCommitId, CommentId: selection.CommentId, Body: body, ExpectedPullRevision: snap.wire.PullRevision, ExpectedSnapshotRevision: snap.wire.SnapshotRevision, OperationId: uuid.NewString()}
	if body != "" {
		m.BodyHash = replyBodyHash(body)
	}
	if kind == authorSubmit {
		m.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT
	}
	return m
}
func (f *authoringFixture) submit(session loginResult, m *golfv1.SubmitPullReviewAuthoringOperationRequest) (*golfv1.PullReviewAuthoringOperation, error) {
	ctx, _, h := f.scope(session)
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", h.Get("Cookie"))
	req.Header().Set("Origin", h.Get("Origin"))
	out, e := f.s.SubmitPullReviewAuthoringOperation(ctx, req)
	if e != nil {
		return nil, e
	}
	return out.Msg.Operation, nil
}
func (f *authoringFixture) published() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.review = &forgePullReview{ID: 9, User: &User{ID: 42, Login: "alice"}, State: "COMMENT", Body: "Review summary", CommitID: strings.Repeat("a", 40), SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", PullRequestURL: "https://forge.invalid/alice/private/pulls/7", CommentsCount: proto.Int64(1)}
	f.comments = []forgePullReviewComment{{ID: 90, User: &User{ID: 42, Login: "alice"}, ReviewID: 9, Body: "Original inline comment", Path: "file.go", Position: 2, DiffHunk: "@@ -1 +1 @@\n line", CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", HTMLURL: "https://forge.invalid/alice/private/pulls/7#issuecomment-90", PullRequestURL: f.review.PullRequestURL}}
}
func TestReviewAuthoringPendingLifecyclePostgres(t *testing.T) {
	for _, finish := range []golfv1.PullReviewAuthoringKind{authorSubmit, authorDiscard} {
		t.Run(finish.String(), func(t *testing.T) {
			f := newAuthoringFixture(t)
			session := f.session(t, "pat")
			for _, op := range []struct {
				kind golfv1.PullReviewAuthoringKind
				body string
			}{{authorCreate, "Private summary"}, {authorUpdate, "Edited private summary"}, {finish, ""}} {
				if op.kind == authorSubmit {
					op.body = "Publish exact reviewed summary"
				}
				m := f.input(t, session, op.kind, op.body)
				r, e := f.submit(session, m)
				if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || r.Original.Body != "" || r.ObservedReviewId != "9" {
					t.Fatal(op.kind, e, r)
				}
				before := f.writes.Load()
				replay := reviewAuthoringRetained(m)
				again, e := f.submit(session, replay)
				if e != nil || !proto.Equal(r, again) || f.writes.Load() != before {
					t.Fatal("Replay changed outcome or dispatched", e, again)
				}
				var original []byte
				if e = f.db.QueryRow(`SELECT original FROM golf_pull_review_authoring_operations WHERE operation_id=$1`, m.OperationId).Scan(&original); e != nil || op.body != "" && strings.Contains(string(original), op.body) {
					t.Fatal("Retained plaintext", e)
				}
			}
			if f.writes.Load() != 3 {
				t.Fatal("Wrong number of native writes")
			}
		})
	}
}
func TestReviewAuthoringInlineEditDeletePostgres(t *testing.T) {
	f := newAuthoringFixture(t)
	f.published()
	session := f.session(t, "pat")
	for _, op := range []struct {
		kind golfv1.PullReviewAuthoringKind
		body string
	}{{authorEdit, "Edited inline body"}, {authorDelete, ""}} {
		m := f.input(t, session, op.kind, op.body)
		r, e := f.submit(session, m)
		if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			t.Fatal(op.kind, e, r)
		}
		again, e := f.submit(session, reviewAuthoringRetained(m))
		if e != nil || !proto.Equal(r, again) {
			t.Fatal("Terminal deleted target cannot be inspected", e)
		}
	}
	if f.writes.Load() != 2 {
		t.Fatal("unexpected resends")
	}
}
func TestReviewAuthoringUnknownNoResendPostgres(t *testing.T) {
	f := newAuthoringFixture(t)
	session := f.session(t, "pat")
	m := f.input(t, session, authorCreate, "Exact private text")
	f.lost.Store(true)
	r, e := f.submit(session, m)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN {
		t.Fatal(e, r)
	}
	again, e := f.submit(session, reviewAuthoringRetained(m))
	if e != nil || !proto.Equal(r, again) || f.writes.Load() != 1 {
		t.Fatal("unknown adopted or resent", e)
	}
	f.lost.Store(false)
	different := f.input(t, session, authorUpdate, "A different operation")
	if _, e = f.submit(session, different); e == nil || f.writes.Load() != 1 {
		t.Fatal("unknown allowed overlapping mutation")
	}
}
func TestReviewAuthoringPrivacyAndStalePostgres(t *testing.T) {
	for _, mode := range []string{"stale", "foreign", "self-approval", "cross-repository", "body-rebind"} {
		t.Run(mode, func(t *testing.T) {
			f := newAuthoringFixture(t)
			session := f.session(t, "pat")
			create := f.input(t, session, authorCreate, "Private text")
			if _, e := f.submit(session, create); e != nil {
				t.Fatal(e)
			}
			m := f.input(t, session, authorSubmit, "Review text")
			switch mode {
			case "stale":
				m.ExpectedSnapshotRevision = strings.Repeat("f", 64)
			case "foreign":
				f.mu.Lock()
				f.review.User.ID = 43
				f.mu.Unlock()
			case "self-approval":
				m.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED
			case "cross-repository":
				m.Target.RepositoryId = "12"
			case "body-rebind":
				m.Body = "different"
			}
			if _, e := f.submit(session, m); e == nil || f.writes.Load() != 1 {
				t.Fatal("unsafe operation sent", e)
			}
		})
	}
}
