package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type reviewMutationFixture struct {
	*pullMutationFixture
	reviews      map[int64]forgePullReview
	reviewMode   atomic.Value
	reviewPosts  atomic.Int32
	pages        atomic.Int32
	afterReceipt func()
	scanEntered  chan struct{}
}

func newReviewMutationFixture(t *testing.T) *reviewMutationFixture {
	t.Helper()
	base := newPullMutationFixture(t)
	f := &reviewMutationFixture{pullMutationFixture: base, reviews: map[int64]forgePullReview{}, scanEntered: make(chan struct{})}
	f.reviewMode.Store("")
	f.row.User = &User{ID: 99, Login: "author"}
	provider := httptest.NewServer(http.HandlerFunc(f.serveReview))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *reviewMutationFixture) serveReview(w http.ResponseWriter, r *http.Request) {
	base := "/api/v1/repos/alice/private/pulls/7/reviews"
	if !strings.HasPrefix(r.URL.Path, base) {
		f.serve(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	mode := f.reviewMode.Load().(string)
	if r.Method == "GET" && r.URL.Path == base {
		f.pages.Add(1)
		rows := []forgePullReview{}
		total := "0"
		if mode == "pending-interrupt" {
			total = "101"
			if r.URL.Query().Get("page") == "2" {
				close(f.scanEntered)
				<-r.Context().Done()
				return
			}
		}
		if mode == "pending-hidden" {
			total = "101"
			if r.URL.Query().Get("page") == "3" {
				rows = append(rows, forgePullReview{ID: 60, User: &User{ID: 42, Login: "alice"}, State: "PENDING", SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", PullRequestURL: f.row.HTMLURL})
			}
		}
		if mode == "too-many" {
			total = "2001"
		}
		w.Header().Set("X-Total-Count", total)
		json.NewEncoder(w).Encode(rows)
		return
	}
	if r.Method == "POST" && r.URL.Path == base {
		f.reviewPosts.Add(1)
		var reserved int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_pull_review_mutations m JOIN golf_pull_review_mutation_events e ON e.mutation_id=m.id WHERE e.phase='RESERVED' AND m.state='OUTCOME_UNKNOWN'").Scan(&reserved); err != nil || reserved == 0 {
			panic("review dispatched without committed reservation")
		}
		var input struct {
			Event  string `json:"event"`
			Body   string `json:"body"`
			Commit string `json:"commit_id"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		if mode == "denied" {
			w.WriteHeader(403)
			return
		}
		f.mu.Lock()
		id := int64(100 + len(f.reviews))
		row := forgePullReview{ID: id, User: &User{ID: 42, Login: "alice"}, Body: input.Body, State: input.Event, CommitID: input.Commit, SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", PullRequestURL: f.row.HTMLURL, CommentsCount: proto.Int64(0)}
		if mode == "absorbed" {
			row.CommentsCount = proto.Int64(2)
		}
		if mode == "wrong-commit" {
			row.CommitID = strings.Repeat("f", 40)
		}
		f.reviews[id] = row
		f.mu.Unlock()
		if f.afterReceipt != nil {
			f.afterReceipt()
		}
		if mode == "lost" {
			w.WriteHeader(502)
			return
		}
		json.NewEncoder(w).Encode(row)
		return
	}
	if r.Method == "GET" && strings.HasPrefix(r.URL.Path, base+"/") {
		if mode == "read-denied" {
			w.WriteHeader(404)
			return
		}
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/"), 10, 64)
		f.mu.Lock()
		row, ok := f.reviews[id]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		if mode == "read-wrong-body" {
			row.Body = "another review"
		}
		json.NewEncoder(w).Encode(row)
		return
	}
	w.WriteHeader(404)
}
func (f *reviewMutationFixture) input(key string, state golfv1.PullRequestReviewState) *golfv1.CreatePullRequestReviewRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &golfv1.CreatePullRequestReviewRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: strconv.FormatInt(f.row.ID, 10), Number: 7, ExpectedRevision: pullRevision(f.row), BaseCommitId: f.row.Base.SHA, HeadCommitId: f.row.Head.SHA, State: state, Body: "## Human review\n\nExact selected snapshot.", IdempotencyKey: key}
}

const reviewTestKey = "da524815-fc53-408d-ae96-40c81c4bcdaa"

func TestPullReviewMutationPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newReviewMutationFixture(t)
			client := f.client(t, f.session(t, kind))
			input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED)
			input.Body = ""
			for i := 0; i < 2; i++ {
				result, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input))
				if err != nil {
					t.Fatal(err)
				}
				if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || result.Msg.Review == nil || result.Msg.Review.CommitId != input.HeadCommitId || result.Msg.Review.State != input.State || result.Msg.Review.CommentsCount != 0 {
					t.Fatal("unbound review success", result.Msg)
				}
			}
			if f.reviewPosts.Load() != 1 {
				t.Fatal("review replay dispatched twice")
			}
			changed := proto.Clone(input).(*golfv1.CreatePullRequestReviewRequest)
			changed.Body = "changed"
			if _, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("changed replay accepted", err)
			}
			own, err := client.GetPullRequestReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewMutationRequest{IdempotencyKey: reviewTestKey}))
			if err != nil || own.Msg.Review == nil {
				t.Fatal("independent own outcome", err)
			}
			f.mu.Lock()
			row := f.reviews[100]
			row.Dismissed = true
			f.reviews[100] = row
			f.mu.Unlock()
			dismissed, err := client.GetPullRequestReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewMutationRequest{IdempotencyKey: reviewTestKey}))
			if err != nil || dismissed.Msg.Review == nil || !dismissed.Msg.Review.Dismissed || dismissed.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
				t.Fatal("dismissal lost historical success", err)
			}
			for _, query := range []string{"UPDATE golf_pull_review_mutations SET head_commit_id=repeat('f',40)", "UPDATE golf_pull_review_mutations SET state='OUTCOME_UNKNOWN'", "DELETE FROM golf_pull_review_mutations", "TRUNCATE golf_pull_review_mutation_events", "UPDATE golf_pull_review_mutation_events SET phase='COMPLETED'"} {
				if _, err := f.db.Exec(query); err == nil {
					t.Fatal("journal guard lost", query)
				}
			}
			var phases int
			f.db.QueryRow("SELECT count(*) FROM golf_pull_review_mutation_events").Scan(&phases)
			if phases != 3 {
				t.Fatal("missing once-only phases", phases)
			}
			f.reviewMode.Store("read-denied")
			hidden, err := client.GetPullRequestReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewMutationRequest{IdempotencyKey: reviewTestKey}))
			if err != nil || hidden.Msg.Review != nil || hidden.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
				t.Fatal("historic receipt granted target access", err)
			}
		})
	}
}
func TestPullReviewMutationPreflightPostgres(t *testing.T) {
	for _, mode := range []string{"pending-hidden", "too-many", "stale", "wrong-id", "draft", "self", "closed"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewMutationFixture(t)
			client := f.client(t, f.session(t, "pat"))
			input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES)
			expected := "review_unavailable"
			switch mode {
			case "pending-hidden":
				f.reviewMode.Store(mode)
				expected = "pending_review"
			case "too-many":
				f.reviewMode.Store(mode)
				expected = "preflight_unavailable"
			case "stale":
				input.HeadCommitId = strings.Repeat("c", 40)
				expected = "revision_changed"
			case "wrong-id":
				input.RepositoryId = "12"
				expected = "target_changed"
			case "draft":
				f.row.Draft = proto.Bool(true)
				input.ExpectedRevision = pullRevision(f.row)
			case "self":
				f.row.User = &User{ID: 42, Login: "alice"}
				input.ExpectedRevision = pullRevision(f.row)
			case "closed":
				f.row.State = "closed"
				input.ExpectedRevision = pullRevision(f.row)
			}
			response, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input))
			if err != nil {
				t.Fatal(err)
			}
			if response.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || response.Msg.Mutation.FailureCode != expected || f.reviewPosts.Load() != 0 {
				t.Fatal("incorrect preflight", response.Msg)
			}
			if mode == "pending-hidden" && f.pages.Load() != 3 {
				t.Fatal("stopped on empty hidden page", f.pages.Load())
			}
		})
	}
}
func TestPullReviewMutationUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "absorbed", "wrong-commit", "read-wrong-body"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewMutationFixture(t)
			f.reviewMode.Store(mode)
			client := f.client(t, f.session(t, "pat"))
			input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT)
			for i := 0; i < 2; i++ {
				response, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input))
				if err != nil {
					t.Fatal(err)
				}
				if response.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN || response.Msg.Review != nil {
					t.Fatal("unknown became success", response.Msg)
				}
			}
			if f.reviewPosts.Load() != 1 {
				t.Fatal("unknown review was resent")
			}
			result, err := client.GetPullRequestReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewMutationRequest{IdempotencyKey: reviewTestKey}))
			if err != nil || result.Msg.Review != nil {
				t.Fatal("unknown inspection returned guessed text", err)
			}
		})
	}
}
func TestPullReviewMutationConcurrentPostgres(t *testing.T) {
	f := newReviewMutationFixture(t)
	client := f.client(t, f.session(t, "pat"))
	input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input))
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if f.reviewPosts.Load() != 1 {
		t.Fatal("concurrent review duplicate", f.reviewPosts.Load())
	}
}
func TestPullReviewMutationRevocationPostgres(t *testing.T) {
	f := newReviewMutationFixture(t)
	source := f.session(t, "pat")
	client := f.client(t, source)
	f.afterReceipt = func() {
		if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
			t.Error(err)
		}
	}
	if _, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT))); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked submission returned private review", err)
	}
	var state string
	var observed int64
	if err := f.db.QueryRow("SELECT state,observed_review_id FROM golf_pull_review_mutations").Scan(&state, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "OUTCOME_UNKNOWN" || observed <= 0 || f.reviewPosts.Load() != 1 {
		t.Fatal("post-dispatch authority loss erased uncertainty", state, observed)
	}
}
func TestPullReviewValidationPostgres(t *testing.T) {
	f := newReviewMutationFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, mode := range []string{"event", "empty", "body", "sha", "revision", "id"} {
		input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT)
		switch mode {
		case "event":
			input.State = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_PENDING
		case "empty":
			input.Body = "  "
		case "body":
			input.Body = strings.Repeat("x", 6001)
		case "sha":
			input.HeadCommitId = "main"
		case "revision":
			input.ExpectedRevision = ""
		case "id":
			input.RepositoryId = "011"
		}
		if _, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid selection dispatched", mode, err)
		}
	}
	var count int
	f.db.QueryRow("SELECT count(*) FROM golf_pull_review_mutations").Scan(&count)
	if count != 0 || f.reviewPosts.Load() != 0 {
		t.Fatal("invalid review reserved/dispatched")
	}
}

func TestPullReviewInterruptedPreflightPostgres(t *testing.T) {
	f := newReviewMutationFixture(t)
	f.reviewMode.Store("pending-interrupt")
	client := f.client(t, f.session(t, "pat"))
	input := f.input(reviewTestKey, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := client.CreatePullRequestReview(ctx, connect.NewRequest(input)); done <- err }()
	select {
	case <-f.scanEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("did not reach partial native scan")
	}
	cancel()
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeCanceled {
			t.Fatal("unexpected interrupted result", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("interrupted call did not settle")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var state, failure string
		err := f.db.QueryRow("SELECT state,failure_code FROM golf_pull_review_mutations WHERE idempotency_key=$1", reviewTestKey).Scan(&state, &failure)
		if err == nil && state == "REJECTED" && failure == "preflight_unavailable" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("partial scan was not durably rejected", state, failure, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	replay, err := client.CreatePullRequestReview(context.Background(), connect.NewRequest(input))
	if err != nil || replay.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.reviewPosts.Load() != 0 {
		t.Fatal("interrupted scan/replay dispatched", err)
	}
}
