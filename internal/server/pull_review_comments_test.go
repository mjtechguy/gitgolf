package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type reviewCommentsFixture struct {
	*pullFixture
	commentMode  atomic.Value
	headers      atomic.Int32
	commentReads atomic.Int32
}

func newReviewCommentsFixture(t *testing.T) *reviewCommentsFixture {
	t.Helper()
	base := newPullFixture(t)
	f := &reviewCommentsFixture{pullFixture: base}
	f.commentMode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(f.serveComments))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *reviewCommentsFixture) serveComments(w http.ResponseWriter, r *http.Request) {
	route := "/api/v1/repos/alice/private/pulls/7/reviews/9"
	if !strings.HasPrefix(r.URL.Path, route) {
		f.serveProvider(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method != "GET" || r.URL.RawQuery != "" {
		w.WriteHeader(405)
		return
	}
	mode := f.commentMode.Load().(string)
	url := "https://forge.invalid/alice/private/pulls/7"
	if r.URL.Path == route {
		n := f.headers.Add(1)
		review := forgePullReview{ID: 9, User: &User{ID: 43, Login: "reviewer"}, State: "COMMENT", CommitID: strings.Repeat("a", 40), PullRequestURL: url, SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", CommentsCount: proto.Int64(2)}
		switch mode {
		case "count-mismatch":
			review.CommentsCount = proto.Int64(3)
		case "oversized":
			review.CommentsCount = proto.Int64(101)
		case "missing-count":
			review.CommentsCount = nil
		case "wrong-review":
			review.ID = 10
		case "wrong-head":
			review.CommitID = strings.Repeat("b", 40)
		case "foreign-review":
			review.PullRequestURL = "https://forge.invalid/alice/private/pulls/8"
		case "own-pending":
			review.State = "PENDING"
			review.User.ID = 42
		case "foreign-pending":
			review.State = "PENDING"
		case "drift":
			if n > 1 {
				review.Dismissed = true
			}
		case "empty":
			review.CommentsCount = proto.Int64(0)
		}
		json.NewEncoder(w).Encode(review)
		return
	}
	if r.URL.Path != route+"/comments" {
		w.WriteHeader(404)
		return
	}
	f.commentReads.Add(1)
	if mode == "denied" {
		w.WriteHeader(403)
		return
	}
	if mode == "wait" {
		f.entered <- struct{}{}
		select {
		case <-f.resume:
		case <-r.Context().Done():
			return
		}
	}
	rows := []forgePullReviewComment{}
	for _, id := range []int64{9007199254740995, 9007199254740994} {
		rows = append(rows, forgePullReviewComment{ID: id, User: &User{ID: 43, Login: "reviewer"}, ReviewID: 9, Body: "## Inline\n\n<script>untrusted</script>", Path: "space ü/file.go", Position: 2, CommitID: strings.Repeat("b", 40), DiffHunk: "@@ -1,2 +1,2 @@\n line", CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", HTMLURL: url + "#issuecomment-" + strconv.FormatInt(id, 10), PullRequestURL: url})
	}
	rows[1].Position = 0
	rows[1].OriginalPosition = 1
	rows[1].Resolver = &User{ID: 42, Login: "alice"}
	switch mode {
	case "empty":
		rows = []forgePullReviewComment{}
	case "null":
		json.NewEncoder(w).Encode(nil)
		return
	case "duplicate":
		rows[1] = rows[0]
	case "wrong-parent":
		rows[0].ReviewID = 10
	case "both-sides":
		rows[0].OriginalPosition = 1
	case "no-side":
		rows[0].Position = 0
	case "invalid-path":
		rows[0].Path = "../private"
	case "bad-line":
		rows[0].Position = 2147483648
	case "bad-commit":
		rows[0].CommitID = "branch"
	case "foreign-url":
		rows[0].HTMLURL = "https://forge.invalid/other/private/pulls/7#issuecomment-" + strconv.FormatInt(rows[0].ID, 10)
	case "bad-time":
		rows[0].CreatedAt = "yesterday"
	case "bad-author":
		rows[0].User = &User{ID: 0, Login: "unknown"}
	case "bad-resolver":
		rows[0].Resolver = &User{ID: 0, Login: "unknown"}
	case "large-body":
		rows[0].Body = strings.Repeat("x", (256<<10)+1)
	case "large-hunk":
		rows[0].DiffHunk = strings.Repeat("x", (64<<10)+1)
	case "ghost-resolver":
		rows[0].Resolver = &User{ID: -1}
	case "ghost":
		rows[0].User = &User{ID: -1}
		rows[0].CommitID = ""
	case "post-access":
		f.mode.Store("repository-denied")
	}
	json.NewEncoder(w).Encode(rows)
}
func reviewCommentsInput() *golfv1.GetPullRequestReviewCommentsRequest {
	return &golfv1.GetPullRequestReviewCommentsRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ReviewId: "9", ReviewCommitId: strings.Repeat("a", 40)}
}
func TestPullReviewCommentsPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newReviewCommentsFixture(t)
			client := f.client(t, f.session(t, kind))
			response, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(reviewCommentsInput()))
			if err != nil {
				t.Fatal(err)
			}
			result := response.Msg
			if result.RepositoryId != "11" || result.PullRequestId != "9007199254740993" || result.Review.Id != "9" || result.CurrentHeadCommitId != strings.Repeat("a", 40) || len(result.Comments) != 2 || result.Comments[0].Id != "9007199254740994" || result.Comments[0].OldLine != 1 || result.Comments[0].Resolver.Id != "42" || result.Comments[1].CommitId == result.Review.CommitId || result.Comments[1].Resolver != nil || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unbound or misleading collection", result)
			}
			for _, mode := range []string{"empty", "own-pending", "ghost", "ghost-resolver"} {
				f.headers.Store(0)
				f.commentMode.Store(mode)
				result, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(reviewCommentsInput()))
				if err != nil {
					t.Fatal(mode, err)
				}
				if mode == "empty" && len(result.Msg.Comments) != 0 {
					t.Fatal("empty collection altered")
				}
				if mode == "ghost-resolver" && (!result.Msg.Comments[1].Resolved || result.Msg.Comments[1].Resolver != nil) {
					t.Fatal("deleted resolver lost native observation")
				}
				if mode == "ghost" && result.Msg.Comments[1].User != nil {
					t.Fatal("ghost author invented")
				}
			}
		})
	}
}
func TestPullReviewCommentsUnresolvedCurrentHeadPostgres(t *testing.T) {
	f := newReviewCommentsFixture(t)
	f.mode.Store("unresolved-source")
	client := f.client(t, f.session(t, "pat"))
	result, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(reviewCommentsInput()))
	if err != nil {
		t.Fatal(err)
	}
	if result.Msg.CurrentHeadCommitId != "" || result.Msg.Review.CommitId != strings.Repeat("a", 40) || len(result.Msg.Comments) != 2 || result.Msg.Comments[0].Id != "9007199254740994" || result.Msg.Comments[1].CommitId != strings.Repeat("b", 40) {
		t.Fatal("missing current metadata altered the selected review or comment observation")
	}
}
func TestPullReviewCommentsDenialsPostgres(t *testing.T) {
	for _, mode := range []string{"count-mismatch", "oversized", "missing-count", "wrong-review", "wrong-head", "foreign-review", "foreign-pending", "drift", "denied", "null", "duplicate", "wrong-parent", "both-sides", "no-side", "invalid-path", "bad-line", "bad-commit", "foreign-url", "bad-time", "bad-author", "bad-resolver", "large-body", "large-hunk", "post-access"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewCommentsFixture(t)
			f.commentMode.Store(mode)
			client := f.client(t, f.session(t, "pat"))
			result, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(reviewCommentsInput()))
			if err == nil || result != nil {
				t.Fatal("unsafe collection disclosed", mode)
			}
			if mode == "foreign-pending" && f.commentReads.Load() != 0 {
				t.Fatal("foreign draft comments fetched")
			}
		})
	}
}
func TestPullReviewCommentsInputPostgres(t *testing.T) {
	f := newReviewCommentsFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, change := range []func(*golfv1.GetPullRequestReviewCommentsRequest){func(r *golfv1.GetPullRequestReviewCommentsRequest) { r.RepositoryId = "011" }, func(r *golfv1.GetPullRequestReviewCommentsRequest) { r.PullRequestId = "0" }, func(r *golfv1.GetPullRequestReviewCommentsRequest) { r.ReviewId = "-9" }, func(r *golfv1.GetPullRequestReviewCommentsRequest) { r.ReviewCommitId = "main" }, func(r *golfv1.GetPullRequestReviewCommentsRequest) { r.Number = 0 }} {
		r := reviewCommentsInput()
		change(r)
		_, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(r))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid identity accepted", err)
		}
	}
	if f.commentReads.Load() != 0 {
		t.Fatal("invalid request reached comments")
	}
}
func TestPullReviewCommentsSessionWaitPostgres(t *testing.T) {
	f := newReviewCommentsFixture(t)
	f.commentMode.Store("wait")
	session := f.session(t, "pat")
	client := f.client(t, session)
	done := make(chan error, 1)
	go func() {
		_, err := client.GetPullRequestReviewComments(context.Background(), connect.NewRequest(reviewCommentsInput()))
		done <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("read never waited")
	}
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.resume <- struct{}{}
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("private comments survived logout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("read did not settle")
	}
}
