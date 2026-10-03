package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

var pullProcedures = []string{
	golfv1connect.RepositoryServiceGetRepositoryImageProcedure,
	golfv1connect.RepositoryServiceListPullRequestsProcedure,
	golfv1connect.RepositoryServiceGetPullRequestProcedure,
	golfv1connect.RepositoryServiceListPullRequestReviewsProcedure,
	golfv1connect.RepositoryServiceCreatePullRequestReviewProcedure,
	golfv1connect.RepositoryServiceGetPullRequestReviewMutationProcedure,
}

func TestPullBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range pullProcedures {
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s body decoded before auth or lost no-store: %d", procedure, w.Code)
			}
		}
	}
}

type pullFixture struct {
	s        *Server
	db       *sql.DB
	mode     atomic.Value
	repoRead atomic.Int32
	entered  chan struct{}
	resume   chan struct{}
}

func newPullFixture(t *testing.T) *pullFixture {
	t.Helper()
	f := &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(f.serveProvider))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *pullFixture) serveProvider(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/api/v1/version" {
		fmt.Fprint(w, `{"version":"1.27.3"}`)
		return
	}
	if r.Header.Get("Authorization") != "token pull-pat" && r.Header.Get("Authorization") != "Bearer pull-oauth" {
		w.WriteHeader(401)
		return
	}
	if r.URL.Path == "/api/v1/settings/api" {
		fmt.Fprint(w, `{"max_response_items":50}`)
		return
	}
	mode := f.mode.Load().(string)
	if mode == "revoked" {
		w.WriteHeader(401)
		return
	}
	if mode == "missing-scope" && r.URL.Path != "/api/v1/user" {
		w.WriteHeader(403)
		return
	}
	write := func(value any) { _ = json.NewEncoder(w).Encode(value) }
	wait := func() {
		f.entered <- struct{}{}
		select {
		case <-f.resume:
		case <-r.Context().Done():
		}
	}
	if r.URL.Path == "/api/v1/user" {
		if mode == "wait-user" {
			wait()
		}
		id := int64(42)
		if mode == "wrong-identity" {
			id = 43
		}
		write(User{ID: id, Login: "alice"})
		return
	}
	repo := Repository{ID: 11, Name: "private", FullName: "alice/private", Private: true, HTMLURL: "https://forge.invalid/alice/private"}
	if r.URL.Path == "/api/v1/repos/alice/private" {
		read := f.repoRead.Add(1)
		if mode == "repository-denied" || (mode == "access-removed" && read > 1) {
			w.WriteHeader(404)
			return
		}
		if mode == "repository-rebound" && read > 1 {
			repo.ID++
		}
		if mode == "wrong-repository-name" {
			repo.FullName = "bob/other"
		}
		write(repo)
		return
	}
	no := false
	row := forgePull{ID: 9007199254740993, Number: 7, Title: "Private change", Body: "<script>plain text</script>", State: "open", User: &User{ID: 42, Login: "alice"},
		CreatedAt: "2026-10-02T12:00:00Z", UpdatedAt: "2026-10-02T12:01:00Z", HTMLURL: repo.HTMLURL + "/pulls/7", Draft: &no, Merged: &no,
		Head: &forgePullRef{RepositoryID: 23, Label: "author:feature/slash", Ref: "feature/slash", SHA: strings.Repeat("a", 40)},
		Base: &forgePullRef{RepositoryID: repo.ID, Label: "main", Ref: "main", SHA: strings.Repeat("b", 40)}}
	yes := true
	switch mode {
	case "wrong-base":
		row.Base.RepositoryID++
	case "wrong-number":
		row.Number++
	case "wrong-url":
		row.HTMLURL = "https://forge.invalid/bob/private/pulls/7"
	case "wrong-head-ref":
		row.Head.Ref = "refs/pull/8/head"
	case "wrong-head-repository":
		row.Head.Repository = &Repository{ID: 24}
	case "bad-commit":
		row.Head.SHA = "not-a-commit"
	case "bad-time":
		row.CreatedAt = "yesterday"
	case "missing-draft":
		row.Draft = nil
	case "missing-head":
		row.Head = nil
	case "unknown-state":
		row.State = "future"
	case "bad-author":
		row.User.ID = 0
	case "ghost":
		row.User.ID = -1
	case "absent-author":
		row.User = nil
	case "draft":
		row.Draft = &yes
	case "retained":
		row.Head.Ref = "refs/pull/7/head"
	case "deleted-source":
		row.Head.RepositoryID, row.Head.Ref = -1, "refs/pull/7/head"
	case "unresolved-base":
		row.Base.SHA = ""
	case "unresolved-source":
		row.Head.Ref, row.Head.SHA = "refs/pull/7/head", ""
	case "merged", "invalid-merged":
		row.Merged = &yes
		row.MergedAt = &row.UpdatedAt
		commit := strings.Repeat("c", 40)
		row.MergeCommitID = &commit
		if mode == "merged" {
			row.State = "closed"
		}
	}
	if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
		if mode == "wait-detail" {
			wait()
		}
		write(row)
		return
	}
	if r.URL.Path == "/api/v1/repos/alice/private/pulls" || r.URL.Path == "/api/v1/repos/alice/private/pulls/7/reviews" {
		w.Header().Set("X-Total-Count", "2")
		switch mode {
		case "malformed":
			fmt.Fprint(w, `[{`)
			return
		case "null":
			fmt.Fprint(w, `null`)
			return
		case "oversized":
			fmt.Fprint(w, strings.Repeat(" ", 2<<20)+"[]")
			return
		case "bad-count":
			w.Header().Set("X-Total-Count", "-1")
		case "missing-count":
			w.Header().Del("X-Total-Count")
		case "last-page-overflow":
			w.Header().Set("X-Total-Count", "1000001")
		case "empty-intermediate":
			write([]forgePullReview{})
			return
		}
	}
	if r.URL.Path == "/api/v1/repos/alice/private/pulls" {
		if mode == "wait-list" {
			wait()
		}
		if filter := r.URL.Query().Get("state"); filter == "closed" && mode != "unknown-state" {
			row.State = "closed"
		}
		rows := []forgePull{row}
		if mode == "too-many" || mode == "duplicate" {
			rows = append(rows, row)
		}
		write(rows)
		return
	}
	if r.URL.Path == "/api/v1/repos/alice/private/pulls/7/reviews" {
		if mode == "wait-reviews" {
			wait()
		}
		review := forgePullReview{ID: 9007199254740995, User: &User{ID: 43, Login: "reviewer"}, Body: "<img src=x onerror=alert(1)>", State: "APPROVED", CommitID: strings.Repeat("a", 40),
			Stale: true, Dismissed: true, Official: true, SubmittedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, HTMLURL: row.HTMLURL + "#issuecomment-9", PullRequestURL: row.HTMLURL}
		switch mode {
		case "review-foreign":
			review.PullRequestURL = repo.HTMLURL + "/pulls/8"
		case "review-unknown":
			review.State = "future"
		case "review-bad-commit":
			review.CommitID = "not-a-commit"
		case "review-ghost":
			review.User.ID = -1
		case "review-request":
			review.User, review.State, review.CommitID = nil, "REQUEST_REVIEW", ""
		case "review-pending":
			review.State = "PENDING"
		case "review-comment":
			review.State = "COMMENT"
		case "review-changes":
			review.State = "REQUEST_CHANGES"
		}
		rows := []forgePullReview{review}
		if mode == "too-many" || mode == "duplicate" {
			rows = append(rows, review)
		}
		write(rows)
		return
	}
	w.WriteHeader(404)
}

func (f *pullFixture) session(t *testing.T, kind string) loginResult {
	t.Helper()
	payload := "pull-pat"
	if kind == "oauth" {
		payload = encodeOAuth(oauthEnvelope{Version: 1, AccessToken: "pull-oauth", RefreshToken: "fixture-refresh", Expiry: time.Now().Add(time.Hour), Verified: true})
	}
	result, err := f.s.createSession(context.Background(), User{ID: 42, Login: "alice"}, kind, payload, "")
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *pullFixture) client(t *testing.T, session loginResult) golfv1connect.RepositoryServiceClient {
	t.Helper()
	_, repo, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return repo
}

var pullKey = &golfv1.RepositoryKey{Owner: "alice", Name: "private"}

func TestPullRPCPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newPullFixture(t)
			client := f.client(t, f.session(t, kind))
			ctx := context.Background()
			for _, state := range []golfv1.IssueState{golfv1.IssueState_ISSUE_STATE_OPEN, golfv1.IssueState_ISSUE_STATE_CLOSED, golfv1.IssueState_ISSUE_STATE_ALL} {
				list, err := client.ListPullRequests(ctx, connect.NewRequest(&golfv1.ListPullRequestsRequest{Repository: pullKey, State: state, Page: &golfv1.PageRequest{Limit: 1}}))
				if err != nil || len(list.Msg.PullRequests) != 1 || list.Msg.Page.NextPage != 2 || list.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("private list/filter/pagination", err)
				}
				if !list.Msg.PullRequests[0].Head.RetainedSnapshot || list.Msg.PullRequests[0].Id != "9007199254740993" {
					t.Fatal("list source snapshot or opaque ID lost")
				}
			}
			detail, err := client.GetPullRequest(ctx, connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: pullKey, Number: 7}))
			if err != nil || detail.Msg.PullRequest.Head.RetainedSnapshot || detail.Msg.PullRequest.Head.Ref != "feature/slash" || detail.Msg.PullRequest.Base.RepositoryId != "11" {
				t.Fatal("detail reference observations", err)
			}
			reviews, err := client.ListPullRequestReviews(ctx, connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: 7, Page: &golfv1.PageRequest{Limit: 1}}))
			if err != nil || len(reviews.Msg.Reviews) != 1 || reviews.Msg.Page.NextPage != 2 {
				t.Fatal("native reviews/count pagination", err)
			}
			review := reviews.Msg.Reviews[0]
			if review.Id != "9007199254740995" || !review.Stale || !review.Dismissed || !review.Official || review.State != golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED {
				t.Fatal("native review observation lost")
			}
			raw, _ := protojson.Marshal(reviews.Msg)
			for _, forbidden := range []string{"pull-pat", "pull-oauth", "eligible", "mergeable", "token", "email"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatal("uncontracted authority or credential escaped")
				}
			}
			f.mode.Store("empty-intermediate")
			empty, err := client.ListPullRequestReviews(ctx, connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: 7, Page: &golfv1.PageRequest{Limit: 1}}))
			if err != nil || len(empty.Msg.Reviews) != 0 || empty.Msg.Page.NextPage != 2 {
				t.Fatal("pending review filtering hid next page", err)
			}
		})
	}
}

func TestPullMetadataPostgres(t *testing.T) {
	f := newPullFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, mode := range []string{"draft", "merged", "ghost", "absent-author", "retained", "deleted-source", "unresolved-base", "unresolved-source"} {
		t.Run(mode, func(t *testing.T) {
			f.mode.Store(mode)
			response, err := client.GetPullRequest(context.Background(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: pullKey, Number: 7}))
			if err != nil {
				t.Fatal("supported provider metadata", err)
			}
			row := response.Msg.PullRequest
			if (mode == "ghost" || mode == "absent-author") && row.User != nil {
				t.Fatal("ghost mapped to ordinary author")
			}
			if mode == "deleted-source" && (row.Head.RepositoryId != "" || !row.Head.RetainedSnapshot) {
				t.Fatal("deleted source concealed")
			}
			if mode == "retained" && !row.Head.RetainedSnapshot {
				t.Fatal("retained source concealed")
			}
			if mode == "merged" && (!row.Merged || row.MergeCommitId == "" || row.State != golfv1.IssueState_ISSUE_STATE_CLOSED) {
				t.Fatal("merged metadata lost")
			}
		})
	}
	for _, mode := range []string{"review-ghost", "review-request", "review-pending", "review-comment", "review-changes"} {
		t.Run(mode, func(t *testing.T) {
			f.mode.Store(mode)
			response, err := client.ListPullRequestReviews(context.Background(), connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: 7}))
			if err != nil || len(response.Msg.Reviews) != 1 {
				t.Fatal("supported native review state", err)
			}
			if (mode == "review-ghost" || mode == "review-request") && response.Msg.Reviews[0].User != nil {
				t.Fatal("missing reviewer mapped to ordinary user")
			}
		})
	}
}

func TestPullProviderDenialsPostgres(t *testing.T) {
	for _, mode := range []string{"wrong-identity", "wrong-base", "wrong-number", "wrong-url", "wrong-head-ref", "wrong-head-repository", "bad-commit", "bad-time", "missing-draft", "missing-head", "unknown-state", "bad-author", "invalid-merged", "malformed", "null", "oversized", "bad-count", "missing-count", "too-many", "duplicate", "repository-denied", "repository-rebound", "wrong-repository-name", "access-removed", "missing-scope", "revoked", "review-foreign", "review-unknown", "review-bad-commit", "last-page-overflow"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode.Store(mode)
			want := connect.CodeUnavailable
			switch mode {
			case "wrong-identity", "revoked":
				want = connect.CodeUnauthenticated
			case "missing-scope":
				want = connect.CodePermissionDenied
			case "repository-denied", "access-removed":
				want = connect.CodeNotFound
			case "too-many", "oversized":
				want = connect.CodeResourceExhausted
			case "last-page-overflow":
				want = connect.CodeInvalidArgument
			}
			paging := &golfv1.PageRequest{}
			if mode == "too-many" {
				paging.Limit = 1
			}
			if mode == "last-page-overflow" {
				paging.Page, paging.Limit = 10000, 100
			}
			var err error
			if strings.HasPrefix(mode, "review-") {
				response, callErr := client.ListPullRequestReviews(context.Background(), connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: 7, Page: paging}))
				err = callErr
				if response != nil {
					t.Fatal("review data returned with invalid upstream contract")
				}
			} else {
				response, callErr := client.ListPullRequests(context.Background(), connect.NewRequest(&golfv1.ListPullRequestsRequest{Repository: pullKey, Page: paging}))
				err = callErr
				if response != nil {
					t.Fatal("PR data returned with invalid upstream contract")
				}
			}
			if connect.CodeOf(err) != want {
				t.Fatalf("want %v, got %v", want, err)
			}
		})
	}
}

func TestPullInputAndIssueSeparationPostgres(t *testing.T) {
	f := newPullFixture(t)
	client := f.client(t, f.session(t, "pat"))
	ctx := context.Background()
	for _, request := range []*golfv1.ListPullRequestsRequest{
		{Repository: &golfv1.RepositoryKey{Owner: "..", Name: "private"}},
		{Repository: pullKey, State: golfv1.IssueState(99)},
		{Repository: pullKey, Page: &golfv1.PageRequest{Page: 10001}},
		{Repository: pullKey, Page: &golfv1.PageRequest{Limit: 101}},
	} {
		if _, err := client.ListPullRequests(ctx, connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid input accepted", err)
		}
	}
	for _, number := range []uint32{0, 2147483648} {
		if _, err := client.GetPullRequest(ctx, connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: pullKey, Number: number})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid detail number accepted", err)
		}
		if _, err := client.ListPullRequestReviews(ctx, connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: number})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid review number accepted", err)
		}
	}
	if _, err := client.GetPullRequest(ctx, connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: pullKey, Number: 8})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("ordinary issue was accepted as PR", err)
	}
	if f.repoRead.Load() != 1 {
		t.Fatal("invalid inputs reached provider repository reads")
	}
}

func TestPullSessionWaitPostgres(t *testing.T) {
	for _, mode := range []string{"wait-user", "wait-list", "wait-detail", "wait-reviews"} {
		for _, revoke := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/revoke=%t", mode, revoke), func(t *testing.T) {
				f := newPullFixture(t)
				session := f.session(t, "pat")
				client := f.client(t, session)
				f.mode.Store(mode)
				outcome := make(chan error, 1)
				go func() {
					var err error
					switch mode {
					case "wait-detail":
						_, err = client.GetPullRequest(context.Background(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: pullKey, Number: 7}))
					case "wait-reviews":
						_, err = client.ListPullRequestReviews(context.Background(), connect.NewRequest(&golfv1.ListPullRequestReviewsRequest{Repository: pullKey, Number: 7}))
					default:
						_, err = client.ListPullRequests(context.Background(), connect.NewRequest(&golfv1.ListPullRequestsRequest{Repository: pullKey}))
					}
					outcome <- err
				}()
				select {
				case <-f.entered:
				case <-time.After(5 * time.Second):
					t.Fatal("provider did not reach wait")
				}
				hash, _ := sessionHash(session.Value)
				statement := "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
				if revoke {
					statement = "DELETE FROM golf_sessions WHERE token_hash=$1"
				}
				if _, err := f.db.Exec(statement, hash); err != nil {
					t.Fatal(err)
				}
				f.resume <- struct{}{}
				select {
				case err := <-outcome:
					if connect.CodeOf(err) != connect.CodeUnauthenticated {
						t.Fatal("private provider data outlived local session", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("request failed to settle")
				}
			})
		}
	}
}
