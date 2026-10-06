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
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

type resolutionFixture struct {
	*reviewCommentsFixture
	resolved atomic.Bool
	writes   atomic.Int32
	lost     atomic.Bool
	reply    atomic.Pointer[forgePullReviewComment]
}

func newResolutionFixture(t *testing.T) *resolutionFixture {
	f := &resolutionFixture{reviewCommentsFixture: newReviewCommentsFixture(t)}
	target, _ := url.Parse(f.s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/v1/repos/alice/private"
		if r.URL.Path == base+"/pulls/7/comments/9007199254740995/replies" {
			f.writes.Add(1)
			var input struct {
				Body string `json:"body"`
			}
			json.NewDecoder(r.Body).Decode(&input)
			reply := &forgePullReviewComment{ID: 100, User: &User{ID: 42, Login: "alice"}, ReviewID: 9, Body: input.Body, Path: "space ü/file.go", Position: 2, CommitID: strings.Repeat("b", 40), DiffHunk: "@@ -1,2 +1,2 @@\n line", CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", HTMLURL: "https://forge.invalid/alice/private/pulls/7#issuecomment-100", PullRequestURL: "https://forge.invalid/alice/private/pulls/7"}
			f.reply.Store(reply)
			w.Header().Set("Content-Type", "application/json")
			if f.lost.Load() {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(201)
				json.NewEncoder(w).Encode(reply)
			}
			return
		}
		if r.URL.Path == base+"/pulls/comments/9007199254740995/resolve" || r.URL.Path == base+"/pulls/comments/9007199254740995/unresolve" {
			f.writes.Add(1)
			f.resolved.Store(strings.HasSuffix(r.URL.Path, "/resolve"))
			if f.lost.Load() {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(204)
			}
			return
		}
		if r.URL.Path == "/api/v1/user" || r.URL.Path == base || r.URL.Path == base+"/pulls/7" || r.URL.Path == base+"/pulls/7/reviews/9" || strings.HasSuffix(r.URL.Path, "/reviews/9/comments") {
			recorder := httptest.NewRecorder()
			proxy.ServeHTTP(recorder, r)
			w.Header().Set("Content-Type", "application/json")
			if recorder.Code != 200 {
				w.WriteHeader(recorder.Code)
				w.Write(recorder.Body.Bytes())
				return
			}
			if r.URL.Path == "/api/v1/user" || r.URL.Path == base || r.URL.Path == base+"/pulls/7" || r.URL.Path == base+"/pulls/7/reviews/9" {
				var row map[string]any
				decoder := json.NewDecoder(strings.NewReader(recorder.Body.String()))
				decoder.UseNumber()
				decoder.Decode(&row)
				row["is_admin"] = false
				row["content_version"] = 1
				if r.URL.Path == base+"/pulls/7/reviews/9" && f.reply.Load() != nil {
					row["comments_count"] = 3
				}
				row["archived"] = false
				row["has_pull_requests"] = true
				json.NewEncoder(w).Encode(row)
				return
			}
			var rows []forgePullReviewComment
			json.Unmarshal(recorder.Body.Bytes(), &rows)
			for i := range rows {
				if rows[i].ID == 9007199254740995 {
					if f.resolved.Load() {
						rows[i].Resolver = &User{ID: 42, Login: "alice"}
					} else {
						rows[i].Resolver = nil
					}
				}
			}
			if reply := f.reply.Load(); reply != nil {
				rows = append(rows, *reply)
			}
			json.NewEncoder(w).Encode(rows)
			return
		}
		proxy.ServeHTTP(w, r)
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
func (f *resolutionFixture) resolutionClient(t *testing.T) golfv1connect.PullReviewRequestServiceClient {
	session := f.session(t, "pat")
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewPullReviewRequestServiceClient(transport, origin.String()+"/rpc")
}
func resolutionStateInput() *golfv1.GetPullReviewCommentStateRequest {
	return &golfv1.GetPullReviewCommentStateRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), CommentId: "9007199254740995"}
}
func TestReviewCommentResolutionPostgres(t *testing.T) {
	f := newResolutionFixture(t)
	client := f.resolutionClient(t)
	get := func() *golfv1.GetPullReviewCommentStateResponse {
		req := connect.NewRequest(resolutionStateInput())
		req.Header().Set("Origin", f.s.config.PublicURL)
		r, e := client.GetPullReviewCommentState(t.Context(), req)
		if e != nil {
			t.Fatal(e)
		}
		return r.Msg
	}
	submit := func(m *golfv1.SubmitPullReviewCommentInteractionRequest) (*golfv1.PullReviewCommentOperation, error) {
		req := connect.NewRequest(m)
		req.Header().Set("Origin", f.s.config.PublicURL)
		r, e := client.SubmitPullReviewCommentInteraction(t.Context(), req)
		if e != nil {
			return nil, e
		}
		return r.Msg.Operation, nil
	}
	snap := get()
	if !snap.CanManage || snap.Comment.Resolved {
		t.Fatal("wrong initial authority/state")
	}
	m := &golfv1.SubmitPullReviewCommentInteractionRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), CommentId: "9007199254740995", ExpectedPullRevision: snap.PullRevision, ExpectedCommentRevision: snap.CommentRevision, Resolve: true, OperationId: uuid.NewString()}
	first, e := submit(m)
	if e != nil || first.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
		t.Fatal("resolve", e, first)
	}
	replay, e := submit(m)
	if e != nil || !proto.Equal(first, replay) || f.writes.Load() != 1 {
		t.Fatal("replay", e, replay)
	}
	snap = get()
	if !snap.Comment.Resolved || snap.Comment.Resolver.Id != "42" {
		t.Fatal("missing exact resolver")
	}
	remove := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	remove.Resolve = false
	remove.OperationId = uuid.NewString()
	remove.ExpectedPullRevision = snap.PullRevision
	remove.ExpectedCommentRevision = snap.CommentRevision
	reopened, e := submit(remove)
	if e != nil || reopened.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || get().Comment.Resolved {
		t.Fatal("reopen", e, reopened)
	}
	changed := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	changed.Resolve = false
	if _, e = submit(changed); e == nil {
		t.Fatal("changed original accepted")
	}
	f.commentMode.Store("foreign-pending")
	if _, e = submit(remove); e == nil {
		t.Fatal("hidden pending mutation exposed")
	}
	if f.writes.Load() != 2 {
		t.Fatal("unexpected pending effect")
	}
}
func TestReviewCommentResolutionUnknownPostgres(t *testing.T) {
	f := newResolutionFixture(t)
	client := f.resolutionClient(t)
	read := connect.NewRequest(resolutionStateInput())
	read.Header().Set("Origin", f.s.config.PublicURL)
	snap, e := client.GetPullReviewCommentState(t.Context(), read)
	if e != nil {
		t.Fatal(e)
	}
	m := &golfv1.SubmitPullReviewCommentInteractionRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), CommentId: "9007199254740995", ExpectedPullRevision: snap.Msg.PullRevision, ExpectedCommentRevision: snap.Msg.CommentRevision, Resolve: true, OperationId: uuid.NewString()}
	f.lost.Store(true)
	submit := func(m *golfv1.SubmitPullReviewCommentInteractionRequest) (*golfv1.PullReviewCommentOperation, error) {
		req := connect.NewRequest(m)
		req.Header().Set("Origin", f.s.config.PublicURL)
		r, e := client.SubmitPullReviewCommentInteraction(t.Context(), req)
		if e != nil {
			return nil, e
		}
		return r.Msg.Operation, nil
	}
	r, e := submit(m)
	if e != nil || r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_DISPATCH_UNKNOWN {
		t.Fatal("lost receipt", e, r)
	}
	if _, e = submit(m); e != nil || f.writes.Load() != 1 {
		t.Fatal("unknown resent", e)
	}
	replacement := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	replacement.OperationId = uuid.NewString()
	if _, e = submit(replacement); e == nil || f.writes.Load() != 1 {
		t.Fatal("new key bypassed uncertainty")
	}
	if _, e = f.db.Exec(`UPDATE golf_pull_review_comment_operations SET original='changed' WHERE operation_id=$1`, m.OperationId); e == nil {
		t.Fatal("original mutable")
	}
}

func TestReviewCommentReplyPostgres(t *testing.T) {
	f := newResolutionFixture(t)
	client := f.resolutionClient(t)
	req := connect.NewRequest(resolutionStateInput())
	req.Header().Set("Origin", f.s.config.PublicURL)
	snap, e := client.GetPullReviewCommentState(t.Context(), req)
	if e != nil {
		t.Fatal(e)
	}
	body := "Private first-dispatch reply body"
	m := &golfv1.SubmitPullReviewCommentInteractionRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40), CommentId: "9007199254740995", ExpectedPullRevision: snap.Msg.PullRevision, ExpectedCommentRevision: snap.Msg.CommentRevision, OperationId: uuid.NewString(), ReplyBody: body, ReplyBodyHash: replyBodyHash(body)}
	submit := connect.NewRequest(m)
	submit.Header().Set("Origin", f.s.config.PublicURL)
	r, e := client.SubmitPullReviewCommentInteraction(t.Context(), submit)
	if e != nil || r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || r.Msg.Operation.ReplyId != "100" || r.Msg.Operation.Original.ReplyBody != "" {
		t.Fatal("reply receipt", e, r)
	}
	replayReq := connect.NewRequest(m)
	replayReq.Header().Set("Origin", f.s.config.PublicURL)
	replay, e := client.SubmitPullReviewCommentInteraction(t.Context(), replayReq)
	if e != nil || !proto.Equal(r.Msg.Operation, replay.Msg.Operation) || f.writes.Load() != 1 {
		t.Fatal("reply replay", e)
	}
	var retained []byte
	if e = f.db.QueryRow(`SELECT original FROM golf_pull_review_comment_operations WHERE operation_id=$1`, m.OperationId).Scan(&retained); e != nil || strings.Contains(string(retained), body) {
		t.Fatal("private body persisted")
	}
	changed := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	changed.ReplyBody = "different"
	replacement := connect.NewRequest(changed)
	replacement.Header().Set("Origin", f.s.config.PublicURL)
	if _, e = client.SubmitPullReviewCommentInteraction(t.Context(), replacement); e == nil || f.writes.Load() != 1 {
		t.Fatal("body substitution")
	}
}
