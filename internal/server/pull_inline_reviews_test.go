package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

type inlineReviewFixture struct {
	*privateDraftFixture
	effect                atomic.Value
	posts, headers, pages atomic.Int32
	mu                    sync.Mutex
	input                 reviewerPublicationInput
	author                int64
	afterPost             func()
	entered, resume       chan struct{}
}

func newInlineReviewFixture(t *testing.T) *inlineReviewFixture {
	t.Helper()
	base := newPrivateDraftFixture(t)
	f := &inlineReviewFixture{privateDraftFixture: base, author: 99, entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.effect.Store("")
	old, _ := url.Parse(base.s.config.ForgeURL)
	proxy := httputil.NewSingleHostReverseProxy(old)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
			// Independently expected author; approval never upgrades self-review.
			recorder := httptest.NewRecorder()
			proxy.ServeHTTP(recorder, r)
			if recorder.Code != 200 {
				w.WriteHeader(recorder.Code)
				return
			}
			var row forgePull
			_ = json.Unmarshal(recorder.Body.Bytes(), &row)
			row.User = &User{ID: f.author, Login: "author"}
			if f.posts.Load() > 0 {
				switch f.effect.Load().(string) {
				case "timestamp-touch":
					row.UpdatedAt = "2026-10-03T12:00:00Z"
				case "semantic-drift":
					row.Body = "Native PR body changed concurrently"
				case "ref-drift":
					row.Head.RepositoryID++
				}
			}
			if f.effect.Load().(string) == "closed" {
				row.State = "closed"
			}
			if f.effect.Load().(string) == "deny-target" {
				w.WriteHeader(404)
				return
			}
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/alice/private/pulls/7/reviews") {
			f.serveInline(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.ForgePublicURL = provider.URL
	config.ForgeOAuthClientID = "fixture-client"
	config.ForgeOAuthClientSecret = "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *inlineReviewFixture) header() forgePullReview {
	f.mu.Lock()
	defer f.mu.Unlock()
	row := forgePullReview{ID: 880, User: &User{ID: 42, Login: "alice"}, Body: f.input.Body, State: f.input.Event, CommitID: f.input.Head, CommentsCount: proto.Int64(int64(len(f.input.Comments))), PullRequestURL: "https://forge.invalid/alice/private/pulls/7", SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z"}
	mode := f.effect.Load().(string)
	switch mode {
	case "wrong-header":
		row.CommitID = strings.Repeat("f", 40)
	case "absorbed":
		row.CommentsCount = proto.Int64(int64(len(f.input.Comments) + 1))
	case "wrong-review-id":
		row.ID++
	case "wrong-summary":
		row.Body = "not the accepted summary"
	case "wrong-author":
		row.User.ID++
	case "dismissed":
		row.Dismissed = true
	}
	return row
}
func (f *inlineReviewFixture) serveInline(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	route := "/api/v1/repos/alice/private/pulls/7/reviews"
	mode := f.effect.Load().(string)
	if r.URL.Path == route && r.Method == "GET" {
		f.pages.Add(1)
		rows := []forgePullReview{}
		total := "0"
		if mode == "pending-hidden" || mode == "cancel-preflight" {
			total = "101"
			if r.URL.Query().Get("page") == "3" {
				rows = append(rows, forgePullReview{ID: 77, User: &User{ID: 42, Login: "alice"}, State: "PENDING", PullRequestURL: "https://forge.invalid/alice/private/pulls/7", SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z"})
			}
		}
		if mode == "cancel-preflight" && r.URL.Query().Get("page") == "2" {
			f.entered <- struct{}{}
			<-r.Context().Done()
			return
		}
		w.Header().Set("X-Total-Count", total)
		_ = json.NewEncoder(w).Encode(rows)
		return
	}
	if r.URL.Path == route && r.Method == "POST" {
		f.posts.Add(1)
		var committed int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_inline_review_mutations m JOIN golf_inline_review_events e USING(user_id,operation_id) WHERE m.phase='DISPATCH_UNKNOWN' AND e.phase='DISPATCH_UNKNOWN'").Scan(&committed); err != nil || committed != 1 {
			panic("POST without committed dispatch")
		}
		var input reviewerPublicationInput
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.input = input
		f.mu.Unlock()
		if mode == "wait-post" {
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
				return
			}
		}
		if f.afterPost != nil {
			f.afterPost()
		}
		if mode == "partial-500" {
			w.WriteHeader(500)
			return
		}
		if mode == "partial-422" {
			w.WriteHeader(422)
			return
		}
		if mode == "lost" {
			w.WriteHeader(502)
			return
		}
		_ = json.NewEncoder(w).Encode(f.header())
		return
	}
	if r.URL.Path == route+"/880" && r.Method == "GET" {
		f.headers.Add(1)
		row := f.header()
		if mode == "header-drift" && f.headers.Load() > 1 {
			row.UpdatedAt = "2026-10-03T01:00:00Z"
		}
		_ = json.NewEncoder(w).Encode(row)
		return
	}
	if r.URL.Path == route+"/880/comments" && r.Method == "GET" {
		f.mu.Lock()
		input := f.input
		f.mu.Unlock()
		rows := []forgePullReviewComment{}
		for i, comment := range input.Comments {
			row := forgePullReviewComment{ID: int64(991 + i), User: &User{ID: 42, Login: "alice"}, Body: comment.Body, Path: comment.Path, Position: uint64(comment.NewLine), OriginalPosition: uint64(comment.OldLine), ReviewID: 880, PullRequestURL: "https://forge.invalid/alice/private/pulls/7", HTMLURL: "https://forge.invalid/alice/private/pulls/7/files#issuecomment-" + strconv.Itoa(991+i), DiffHunk: "@@ -1,2 +1,2 @@\n context\n-old\n+new\n", CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", CommitID: strings.Repeat("d", 40)}
			switch mode {
			case "wrong-child-body":
				row.Body = "not the accepted entry"
			case "wrong-side":
				row.Position, row.OriginalPosition = row.OriginalPosition, row.Position
			case "wrong-context":
				row.DiffHunk = "@@ -1,2 +1,2 @@\n context\n-old\n+different\n"
			case "wrong-child-owner":
				row.User.ID++
			case "wrong-child-review":
				row.ReviewID++
			case "wrong-child-anchor":
				row.HTMLURL = "https://forge.invalid/alice/private/pulls/7/files#issuecomment-1"
			case "duplicate-child":
				row.ID = 991
			}
			rows = append(rows, row)
		}
		if mode == "missing-child" {
			rows = rows[:len(rows)-1]
		}
		// Deliberate independent reverse ordering; response order is not intent.
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
		_ = json.NewEncoder(w).Encode(rows)
		return
	}
	w.WriteHeader(404)
}
func (f *inlineReviewFixture) saved(t *testing.T, c golfv1connect.RepositoryServiceClient) (*golfv1.SavePullRequestReviewDraftResponse, *golfv1.PublishPullRequestReviewDraftRequest) {
	input := f.create(t, c)
	old := proto.Clone(input.Entries[0]).(*golfv1.PullReviewDraftEntry)
	old.Id = uuid.NewString()
	old.Body = "old-side finding"
	old.Coordinate.Side = golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD
	input.Entries = append(input.Entries, old)
	saved := savePrivateDraft(t, c, input)
	m := &golfv1.PublishPullRequestReviewDraftRequest{Target: input.Target, DraftId: input.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
	return saved, m
}
func inlineStatus(t *testing.T, c golfv1connect.RepositoryServiceClient, m *golfv1.PublishPullRequestReviewDraftRequest) *golfv1.PullInlineReviewMutation {
	t.Helper()
	res, err := c.GetPullRequestInlineReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestInlineReviewMutationRequest{Target: m.Target, DraftId: m.DraftId, OperationId: m.OperationId}))
	if err != nil {
		t.Fatal(err)
	}
	return res.Msg.Mutation
}
func TestInlineReviewPublicationPostgres(t *testing.T) {
	for _, decision := range []golfv1.PullRequestReviewState{golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES} {
		t.Run(decision.String(), func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			saved, m := f.saved(t, c)
			m.Decision = decision
			for i := 0; i < 2; i++ {
				out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
				if err != nil {
					t.Fatal(err)
				}
				r := out.Msg.Mutation
				if r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_SUCCEEDED || r.ObservedReviewId != "880" || strings.Join(r.VerifiedCommentIds, ",") != "991,992" || r.AcceptedVersion != "1" || r.AcceptedTargetGeneration != "1" || r.HeadCommitId != saved.Draft.Comparison.Capture.Selection.HeadCommitId || r.MergeBaseCommitId != saved.Draft.Comparison.Capture.MergeBaseCommitId {
					t.Fatal("incomplete native receipt", r)
				}
			}
			if f.posts.Load() != 1 {
				t.Fatal("replay POST", f.posts.Load())
			}
			changed := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			changed.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_PENDING
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatal("pending event", err)
			}
			changed = proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			changed.ExpectedVersion = "2"
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("changed replay", err)
			}
			fresh := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			fresh.OperationId = uuid.NewString()
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(fresh)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("published version duplicated", err)
			}
			get, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId}))
			if err != nil || get.Msg.CurrentVersion != "1" || get.Msg.Deleted {
				t.Fatal("publication modified private draft", err)
			}
		})
	}
}
func TestInlineReviewUnverifiedEffectsPostgres(t *testing.T) {
	for _, mode := range []string{"partial-500", "partial-422", "lost", "wrong-header", "absorbed", "wrong-summary", "wrong-author", "dismissed", "wrong-child-body", "wrong-side", "wrong-context", "wrong-child-owner", "wrong-child-review", "wrong-child-anchor", "duplicate-child", "missing-child", "header-drift"} {
		t.Run(mode, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			_, m := f.saved(t, c)
			f.effect.Store(mode)
			out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			if err != nil {
				t.Fatal(err)
			}
			if out.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN || len(out.Msg.Mutation.VerifiedCommentIds) != 0 || out.Msg.Mutation.FailureCode != "native_effect_unverified" {
				t.Fatal("possible native effect incorrectly released", out.Msg.Mutation)
			}
			f.effect.Store("")
			for i := 0; i < 2; i++ {
				if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
					t.Fatal(err)
				}
				if inlineStatus(t, c, m).Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN {
					t.Fatal("status adopted native effect")
				}
			}
			fresh := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			fresh.OperationId = uuid.NewString()
			if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(fresh)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("fresh key bypassed unknown", err)
			}
			if f.posts.Load() != 1 {
				t.Fatal("uncertainty reposted")
			}
		})
	}
}
func TestInlineReviewPreflightPostgres(t *testing.T) {
	for _, mode := range []string{"pending-hidden", "head-changed", "self-approval", "closed", "draft", "stale-version", "stale-generation"} {
		t.Run(mode, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			_, m := f.saved(t, c)
			switch mode {
			case "pending-hidden":
				f.effect.Store(mode)
			case "head-changed":
				f.head.Store(strings.Repeat("e", 40))
			case "self-approval":
				m.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED
				f.author = 42
			case "closed":
				f.effect.Store("closed")
			case "draft":
				f.mode.Store("draft")
			case "stale-version":
				m.ExpectedVersion = "2"
			case "stale-generation":
				m.ExpectedTargetGeneration = "2"
			}
			out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			if mode == "stale-version" || mode == "stale-generation" {
				if connect.CodeOf(err) != connect.CodeAborted {
					t.Fatal("CAS accepted", err)
				}
			} else if err != nil || out.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED {
				t.Fatal("preflight not terminal", err)
			}
			if f.posts.Load() != 0 {
				t.Fatal("preflight dispatched")
			}
			if mode == "pending-hidden" && f.pages.Load() != 3 {
				t.Fatal("hidden span not exhausted", f.pages.Load())
			}
		})
	}
}
func TestInlineReviewCancellationPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	c := f.client(t, f.session(t, "pat"))
	_, m := f.saved(t, c)
	f.effect.Store("cancel-preflight")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.PublishPullRequestReviewDraft(ctx, connect.NewRequest(m)); done <- err }()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("preflight not entered")
	}
	cancel()
	<-done
	f.effect.Store("")
	deadline := time.Now().Add(3 * time.Second)
	for {
		r := inlineStatus(t, c, m)
		if r.Phase == golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled preflight lost terminal no-dispatch observation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if f.posts.Load() != 0 {
		t.Fatal("canceled preflight POST")
	}
}
func TestInlineReviewConcurrentReservationPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	_, m := f.saved(t, c)
	f.effect.Store("wait-post")
	done := make(chan error, 1)
	go func() {
		_, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
		done <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("POST not entered")
	}
	fresh := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
	fresh.OperationId = uuid.NewString()
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(fresh)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("competing reservation admitted", err)
	}
	if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN {
		t.Fatal("in-flight status did not retain uncertainty")
	}
	f.resume <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.posts.Load() != 1 {
		t.Fatal("concurrent POST")
	}
}

func TestInlineReviewSQLLossAndRestartPostgres(t *testing.T) {
	for _, point := range []string{"dispatch", "receipt", "success"} {
		t.Run(point, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			session := f.session(t, "pat")
			c := f.client(t, session)
			_, m := f.saved(t, c)
			predicate := "NEW.phase='DISPATCH_UNKNOWN'"
			if point == "receipt" {
				predicate = "NEW.observed_review_id>0"
			}
			if point == "success" {
				predicate = "NEW.phase='SUCCEEDED'"
			}
			_, err := f.db.Exec(`CREATE FUNCTION fixture_inline_storage_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ` + predicate + ` THEN RAISE EXCEPTION 'fixture storage loss'; END IF;RETURN NEW;END $$; CREATE TRIGGER fixture_inline_storage_failure BEFORE UPDATE ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION fixture_inline_storage_failure()`)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeUnavailable {
				t.Fatal("storage failure erased", err)
			}
			if _, err = f.db.Exec(`DROP TRIGGER fixture_inline_storage_failure ON golf_inline_review_mutations; DROP FUNCTION fixture_inline_storage_failure()`); err != nil {
				t.Fatal(err)
			}
			restarted, err := New(f.s.config, f.db)
			if err != nil {
				t.Fatal(err)
			}
			f.s = restarted
			c = f.client(t, session)
			for i := 0; i < 2; i++ {
				if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
					t.Fatal(err)
				}
			}
			r := inlineStatus(t, c, m)
			expected := golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN
			posts := int32(1)
			if point == "dispatch" {
				expected = golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_RESERVED
				posts = 0
			}
			if r.Phase != expected || f.posts.Load() != posts || len(r.VerifiedCommentIds) != 0 {
				t.Fatal("restart resumed uncertain writer", r.Phase, f.posts.Load())
			}
			if point == "success" && r.ObservedReviewId != "880" || point == "receipt" && r.ObservedReviewId != "" {
				t.Fatal("receipt loss invented observed identity")
			}
		})
	}
}
func TestInlineReviewOriginalVersionAndUnknownFencePostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	c := f.client(t, f.session(t, "pat"))
	saved, m := f.saved(t, c)
	f.effect.Store("partial-422")
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
		t.Fatal(err)
	}
	edit := &golfv1.SavePullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId, OperationId: uuid.NewString(), ExpectedVersion: "1", ExpectedTargetGeneration: "1", Comparison: &golfv1.SavePullRequestReviewDraftRequest_ComparisonId{ComparisonId: m.ComparisonId}, Summary: "new unpublished summary", Entries: saved.Draft.Entries}
	newer := savePrivateDraft(t, c, edit)
	next := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
	next.ExpectedVersion = newer.CurrentVersion
	next.ExpectedTargetGeneration = newer.TargetGeneration
	next.OperationId = uuid.NewString()
	f.effect.Store("")
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(next)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("new version bypassed uncertainty", err)
	}
	if r := inlineStatus(t, c, m); r.AcceptedVersion != "1" || r.AcceptedTargetGeneration != "1" {
		t.Fatal("original frozen version overwritten")
	}
	if _, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.DeletePullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId, OperationId: uuid.NewString(), ExpectedVersion: "2", ExpectedTargetGeneration: "2"})); err != nil {
		t.Fatal(err)
	}
	if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN {
		t.Fatal("tombstone erased native effect")
	}
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
		t.Fatal("exact original replay after tombstone", err)
	}
	if f.posts.Load() != 1 {
		t.Fatal("deleted draft native effect replayed")
	}
}
func TestInlineReviewHeadAndAuthorityMovePostgres(t *testing.T) {
	for _, mode := range []string{"head", "permission", "owner-session"} {
		t.Run(mode, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			session := f.session(t, "pat")
			c := f.client(t, session)
			_, m := f.saved(t, c)
			f.afterPost = func() {
				switch mode {
				case "head":
					f.head.Store(strings.Repeat("e", 40))
				case "permission":
					f.mode.Store("repository-denied")
				case "owner-session":
					h, _ := sessionHash(session.Value)
					_, _ = f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", h)
				}
			}
			out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			if mode == "head" {
				if err != nil || out.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN {
					t.Fatal("moved snapshot incorrectly successful", err)
				}
			} else if err == nil || out != nil {
				t.Fatal("late private authority leaked mutation", err)
			}
			f.mode.Store("")
			f.afterPost = nil
			if mode == "owner-session" {
				c = f.client(t, f.session(t, "pat"))
			}
			if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN || r.ObservedReviewId != "880" {
				t.Fatal("authority uncertainty lost native receipt")
			}
			if f.posts.Load() != 1 {
				t.Fatal("late authority reposted")
			}
		})
	}
}
func TestInlineReviewPrivacyAndIdentityPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	_, m := f.saved(t, c)
	f.effect.Store("lost")
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
		t.Fatal(err)
	}
	other, err := f.s.createSession(context.Background(), User{ID: 43, Login: "administrator", IsInstanceAdmin: true}, "pat", "other-pat", "")
	if err != nil {
		t.Fatal(err)
	}
	admin := f.client(t, other)
	status := &golfv1.GetPullRequestInlineReviewMutationRequest{Target: m.Target, DraftId: m.DraftId, OperationId: m.OperationId}
	if _, err = admin.GetPullRequestInlineReviewMutation(context.Background(), connect.NewRequest(status)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("admin inspected another owner", err)
	}
	if _, err = admin.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("admin republished another owner", err)
	}
	wrong := proto.Clone(status).(*golfv1.GetPullRequestInlineReviewMutationRequest)
	wrong.Target.PullRequestId = "9007199254740994"
	if _, err = c.GetPullRequestInlineReviewMutation(context.Background(), connect.NewRequest(wrong)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("wrong native target inspected", err)
	}
	for _, procedure := range []string{golfv1connect.RepositoryServicePublishPullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceGetPullRequestInlineReviewMutationProcedure} {
		for _, auth := range []string{"", "Bearer " + apiTokenPrefix + strings.Repeat("A", 43), "Bearer native-pat"} {
			for _, origin := range []string{f.s.config.PublicURL, "https://foreign.invalid"} {
				req := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed-private-body"))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Connect-Protocol-Version", "1")
				req.Header.Set("Origin", origin)
				if auth != "" {
					req.Header.Set("Authorization", auth)
				} else {
					req.AddCookie(f.s.sessionCookie(session.Value, session.Expires, 3600))
				}
				w := httptest.NewRecorder()
				f.s.ServeHTTP(w, req)
				want := 400
				if origin != f.s.config.PublicURL {
					want = 403
				} else if auth != "" {
					want = 401
					if strings.Contains(auth, apiTokenPrefix) {
						want = 403
					}
				}
				if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("delegated/private boundary", procedure, w.Code, want)
				}
			}
		}
	}
	if f.posts.Load() != 1 {
		t.Fatal("private boundary POST")
	}
}

func TestInlineReviewRejectedVersionExplicitNewIntentPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	c := f.client(t, f.session(t, "pat"))
	_, m := f.saved(t, c)
	f.effect.Store("pending-hidden")
	rejected, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
	if err != nil || rejected.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED {
		t.Fatal("no dispatch refusal", err)
	}
	f.effect.Store("")
	replay, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
	if err != nil || replay.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || f.posts.Load() != 0 {
		t.Fatal("same rejected key resumed")
	}
	next := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
	next.OperationId = uuid.NewString()
	res, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(next))
	if err != nil || res.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_SUCCEEDED || f.posts.Load() != 1 {
		t.Fatal("explicit new safely refused version trapped", err)
	}
	if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED {
		t.Fatal("original rejection rewritten")
	}
}
func TestInlineReviewDelayedReservationGenerationPostgres(t *testing.T) {
	for _, kind := range []string{"edit", "delete-recreate"} {
		t.Run(kind, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			session := f.session(t, "pat")
			c := f.client(t, session)
			saved, m := f.saved(t, c)
			tx, err := f.db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			hash, _ := sessionHash(session.Value)
			var user int64
			if err = tx.QueryRow("SELECT u.id FROM golf_users u JOIN golf_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 FOR UPDATE OF u", hash).Scan(&user); err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec("SELECT generation FROM golf_review_draft_targets WHERE user_id=$1 FOR UPDATE", user); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, e := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
				done <- e
			}()
			// Native observations are outside the owner lock, but accepted reservations
			// must wait. This bounded wait asserts no SQL reservation or POST can appear.
			time.Sleep(60 * time.Millisecond)
			var count int
			if err = f.db.QueryRow("SELECT count(*) FROM golf_inline_review_mutations").Scan(&count); err != nil || count != 0 || f.posts.Load() != 0 {
				t.Fatal("reservation escaped held owner/target", err)
			}
			// Commit an actual 036 mutation in the held owner transaction, then release
			// publication. This is the same production acceptance routine used by Save.
			q := database.New(f.db).WithTx(tx)
			d, e := q.GetReviewDraft(t.Context(), database.GetReviewDraftParams{ID: uuid.MustParse(m.DraftId), UserID: user, ForgeURL: f.s.config.ForgeURL, RepositoryID: 11, PullRequestID: 9007199254740993})
			if e != nil {
				t.Fatal(e)
			}
			scope, _ := reviewDraftTarget(m.Target)
			var state *golfv1.GetPullRequestReviewDraftResponse
			edit := &golfv1.SavePullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId, OperationId: uuid.NewString(), ExpectedVersion: "1", ExpectedTargetGeneration: "1", Comparison: &golfv1.SavePullRequestReviewDraftRequest_ComparisonId{ComparisonId: m.ComparisonId}, Summary: "new saved version", Entries: saved.Draft.Entries}
			operation := "SAVE"
			var input proto.Message = edit
			if kind == "delete-recreate" {
				operation = "DELETE"
				input = &golfv1.DeletePullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId, OperationId: edit.OperationId, ExpectedVersion: "1", ExpectedTargetGeneration: "1"}
			}
			if e = f.s.acceptReviewDraftOperation(t.Context(), q, d, m.Target, scope, edit.OperationId, 1, 1, operation, input, &state); e != nil {
				t.Fatal(e)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			if err = <-done; connect.CodeOf(err) != connect.CodeAborted {
				t.Fatal("delayed old version/generation admitted", err)
			}
			if kind == "delete-recreate" {
				fresh := f.create(t, c)
				fresh.ExpectedTargetGeneration = "2"
				savePrivateDraft(t, c, fresh)
				if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeAborted {
					t.Fatal("deleted UUID ABA accepted", err)
				}
			}
			if f.posts.Load() != 0 {
				t.Fatal("delayed intent native POST")
			}
		})
	}
}

func (f *inlineReviewFixture) seedBot(t *testing.T, legacy bool) string {
	t.Helper()
	account, err := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.ForgeURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "pull-pat"})
	if err != nil {
		t.Fatal(err)
	}
	reviewer, run := uuid.NewString(), uuid.NewString()
	_, err = f.db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) VALUES($1,$2,11,42,'alice','private',$3,42,$4,1,42,'{}',true,clock_timestamp()+interval '1 hour')`, reviewer, f.s.config.ForgeURL, account.UserID, account.ID)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(privateDraftDiff))
	_, err = f.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,repository_id,pull_request_id,merge_base_commit,diff_fingerprint,legacy_effect_block) VALUES($1,$2,1,7,$3,$4,'pr_comment',$5,$6,42,'queued',11,9007199254740993,$7,$8,$9)`, run, reviewer, f.base.Load().(string), f.head.Load().(string), uuid.NewString(), privateDraftDiff, f.mergeBase.Load().(string), digest[:], legacy)
	if err != nil {
		t.Fatal(err)
	}
	return run
}
func (f *inlineReviewFixture) overall(m *golfv1.PublishPullRequestReviewDraftRequest, saved *golfv1.SavePullRequestReviewDraftResponse) *golfv1.CreatePullRequestReviewRequest {
	capture := saved.Draft.Comparison.Capture
	return &golfv1.CreatePullRequestReviewRequest{Repository: m.Target.Repository, RepositoryId: m.Target.RepositoryId, PullRequestId: m.Target.PullRequestId, Number: m.Target.Number, ExpectedRevision: capture.ExpectedPullRevision, BaseCommitId: capture.Selection.BaseCommitId, HeadCommitId: capture.Selection.HeadCommitId, State: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT, Body: "separate overall review", IdempotencyKey: uuid.NewString()}
}
func TestInlineReviewSharedFamilyExclusionPostgres(t *testing.T) {
	t.Run("inline blocks overall and bot", func(t *testing.T) {
		f := newInlineReviewFixture(t)
		c := f.client(t, f.session(t, "pat"))
		saved, m := f.saved(t, c)
		f.effect.Store("lost")
		if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
			t.Fatal(err)
		}
		if _, err := c.CreatePullRequestReview(context.Background(), connect.NewRequest(f.overall(m, saved))); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal("overall bypassed inline uncertainty", err)
		}
		run := f.seedBot(t, false)
		digest := sha256.Sum256([]byte("bot"))
		_, err := f.db.Exec(`INSERT INTO golf_reviewer_publications(run_id,forge_url,repository_id,pull_request_id,pull_number,publisher_id,payload_fingerprint,state) VALUES($1,$2,11,9007199254740993,7,42,$3,'reserved')`, run, f.s.config.ForgeURL, digest[:])
		if !errors.Is(reviewAdmissionError(err), errInlineReviewBlocked) {
			t.Fatal("bot bypassed inline uncertainty", err)
		}
		if f.posts.Load() != 1 {
			t.Fatal("cross-family native POST")
		}
	})
	t.Run("overall blocks inline", func(t *testing.T) {
		f := newInlineReviewFixture(t)
		session := f.session(t, "pat")
		c := f.client(t, session)
		saved, m := f.saved(t, c)
		overall := f.overall(m, saved)
		digest := sha256.Sum256([]byte("overall"))
		err := f.s.withManagedSession(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "pull-pat"}, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			_, err := q.ReservePullReviewMutation(t.Context(), database.ReservePullReviewMutationParams{UserID: caller.UserID, ForgeURL: f.s.config.ForgeURL, IdempotencyKey: overall.IdempotencyKey, PayloadFingerprint: digest[:], BodyFingerprint: digest[:], RepositoryID: 11, RepositoryOwner: "alice", RepositoryName: "private", PullRequestID: 9007199254740993, Number: 7, ExpectedRevision: overall.ExpectedRevision, BaseCommitID: overall.BaseCommitId, HeadCommitID: overall.HeadCommitId, ReviewState: "COMMENT"})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal("inline bypassed unresolved overall reservation", err)
		}
		if f.posts.Load() != 0 {
			t.Fatal("unresolved overall native effect reposted")
		}
	})
	for _, legacy := range []bool{false, true} {
		t.Run("bot or legacy blocks humans "+strconv.FormatBool(legacy), func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			saved, m := f.saved(t, c)
			run := f.seedBot(t, legacy)
			if !legacy {
				digest := sha256.Sum256([]byte("bot"))
				_, err := f.db.Exec(`INSERT INTO golf_reviewer_publications(run_id,forge_url,repository_id,pull_request_id,pull_number,publisher_id,payload_fingerprint,state) VALUES($1,$2,11,9007199254740993,7,42,$3,'reserved')`, run, f.s.config.ForgeURL, digest[:])
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("inline bypassed bot", err)
			}
			if _, err := c.CreatePullRequestReview(context.Background(), connect.NewRequest(f.overall(m, saved))); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("overall bypassed bot", err)
			}
			if f.posts.Load() != 0 {
				t.Fatal("bot blocked native POST")
			}
		})
	}
}
func TestInlineReviewConcurrentBotGatePostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	c := f.client(t, f.session(t, "pat"))
	_, m := f.saved(t, c)
	run := f.seedBot(t, false)
	digest := sha256.Sum256([]byte("bot"))
	tx, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO golf_reviewer_publications(run_id,forge_url,repository_id,pull_request_id,pull_number,publisher_id,payload_fingerprint,state) VALUES($1,$2,11,9007199254740993,7,42,$3,'reserved')`, run, f.s.config.ForgeURL, digest[:]); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, e := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
		done <- e
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err = f.db.QueryRow("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cross-family gate was not held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if f.posts.Load() != 0 {
		t.Fatal("publication crossed uncommitted bot gate")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-done; connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("bot reservation did not win exclusion", err)
	}
	if f.posts.Load() != 0 {
		t.Fatal("competing native POST")
	}
}

func TestInlineReviewTimestampVersusSemanticDriftPostgres(t *testing.T) {
	for _, mode := range []string{"timestamp-touch", "semantic-drift", "ref-drift"} {
		t.Run(mode, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			_, m := f.saved(t, c)
			f.effect.Store(mode)
			out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			if err != nil {
				t.Fatal(err)
			}
			expected := golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN
			if mode == "timestamp-touch" {
				expected = golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_SUCCEEDED
			}
			if out.Msg.Mutation.Phase != expected || f.posts.Load() != 1 {
				t.Fatal("timestamp variation and original semantics confused", mode, out.Msg.Mutation.Phase)
			}
		})
	}
}

func TestInlineReviewRetainedEncryptionAndGuardsPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	_, m := f.saved(t, c)
	f.effect.Store("lost")
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.DeletePullRequestReviewDraftRequest{Target: m.Target, DraftId: m.DraftId, ExpectedVersion: "1", ExpectedTargetGeneration: "1", OperationId: uuid.NewString()})); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`UPDATE golf_inline_review_mutations SET phase='REJECTED',failure_code='preflight_refused'`,
		`UPDATE golf_inline_review_mutations SET head_commit=repeat('f',40)`,
		`UPDATE golf_inline_review_mutations SET payload_fingerprint=decode(repeat('aa',32),'hex')`,
		`DELETE FROM golf_inline_review_mutations`,
		`DELETE FROM golf_inline_review_events`,
		`TRUNCATE golf_inline_review_events`,
		`UPDATE golf_review_contents SET content_binding=decode(repeat('aa',32),'hex')`,
	} {
		if _, err := f.db.Exec(sql); err == nil {
			t.Fatal("retained accepted intent/effect could be erased or rebound")
		}
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	rotation, err := RotateCredentials(t.Context(), f.db, keys, 2, 10)
	if err != nil || !rotation.Complete || rotation.RotatedReviewContents != 3 {
		t.Fatal("publication-referenced ciphertext was omitted", err)
	}
	config := keyedConfig(f.s.config)
	config.EncryptionKey = ""
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	c = f.client(t, session)
	if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_DISPATCH_UNKNOWN || r.AcceptedVersion != "1" {
		t.Fatal("rotation/restart erased original effect")
	}
	q := database.New(f.db)
	var user int64
	if err = f.db.QueryRow("SELECT user_id FROM golf_inline_review_mutations").Scan(&user); err != nil {
		t.Fatal(err)
	}
	d, err := q.GetReviewDraft(t.Context(), database.GetReviewDraftParams{ID: uuid.MustParse(m.DraftId), UserID: user, ForgeURL: f.s.config.ForgeURL, RepositoryID: 11, PullRequestID: 9007199254740993})
	if err != nil {
		t.Fatal(err)
	}
	v, err := q.GetReviewDraftVersion(t.Context(), database.GetReviewDraftVersionParams{DraftID: d.ID, Version: 1, UserID: user})
	if err != nil {
		t.Fatal(err)
	}
	_, input, err := f.s.loadReviewOperation(t.Context(), q, d, v)
	if err != nil || input.(*golfv1.SavePullRequestReviewDraftRequest).Entries[0].Body != "private inline body" {
		t.Fatal("frozen original encrypted body no longer verifies")
	}
	if f.posts.Load() != 1 {
		t.Fatal("rotation resumed native publication")
	}
}
func TestInlineReviewEncodedContextBudgetPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	c := f.client(t, f.session(t, "pat"))
	raw := "diff --git a/huge.txt b/huge.txt\n--- a/huge.txt\n+++ b/huge.txt\n@@ -1,20 +1,20 @@\n" + strings.Repeat(" "+strings.Repeat("<", 2000)+"\n", 20)
	f.diff.Store(raw)
	input := f.create(t, c)
	input.Entries = nil
	for i := 1; i <= 20; i++ {
		input.Entries = append(input.Entries, &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Coordinate: &golfv1.PullReviewDraftCoordinate{Path: "huge.txt", Line: uint32(i), Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW}, Body: "bounded ordinary text"})
	}
	out := savePrivateDraft(t, c, input)
	m := &golfv1.PublishPullRequestReviewDraftRequest{Target: input.Target, DraftId: input.DraftId, ExpectedVersion: out.CurrentVersion, ExpectedTargetGeneration: out.TargetGeneration, ComparisonId: out.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
	outcome, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m))
	if err != nil || outcome.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED {
		t.Fatal("aggregate native context/JSON escaping refusal not durably known", err)
	}
	var rows int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_inline_review_mutations").Scan(&rows); err != nil || rows != 1 || f.posts.Load() != 0 {
		t.Fatal("oversized receipt missing refusal or dispatched", err)
	}
}

// The source SAVE is valid even when native publication admission is narrower.
// Refusal fingerprints contain every ordered entry, not just an admitted prefix.
func TestInlineReviewSemanticRefusalPostgres(t *testing.T) {
	for _, kind := range []string{"empty-summary", "zero-entries", "rename", "deleted"} {
		t.Run(kind, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			session := f.session(t, "pat")
			c := f.client(t, session)
			if kind == "rename" {
				f.diff.Store("diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n")
			}
			if kind == "deleted" {
				f.diff.Store("diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n")
			}
			in := f.create(t, c)
			switch kind {
			case "empty-summary":
				in.Summary = " \n"
			case "zero-entries":
				in.Entries = nil
			case "rename":
				in.Entries[0].Coordinate.Path = "new.ts"
			case "deleted":
				in.Entries[0].Coordinate.Path = "deleted.ts"
				in.Entries[0].Coordinate.Side = golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD
			}
			saved := savePrivateDraft(t, c, in)
			m := &golfv1.PublishPullRequestReviewDraftRequest{Target: in.Target, DraftId: in.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
			// Deliberately discard the successful reply: exact status, not the HTTP error
			// or an absent native object, is the positive no-dispatch proof.
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
				t.Fatal(err)
			}
			rejected := inlineStatus(t, c, m)
			if rejected.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || rejected.FailureCode != "preflight_refused" || rejected.ObservedReviewId != "" || len(rejected.VerifiedCommentIds) != 0 || rejected.AcceptedVersion != "1" {
				t.Fatal("semantic refusal missing immutable receipt", rejected.Phase)
			}
			var fingerprint []byte
			if err := f.db.QueryRow("SELECT payload_fingerprint FROM golf_inline_review_mutations WHERE operation_id=$1", m.OperationId).Scan(&fingerprint); err != nil {
				t.Fatal(err)
			}
			frozen, err := frozenInlinePayload(saved.Draft, "COMMENT")
			if err != nil || !bytes.Equal(fingerprint, inlinePayloadFingerprint(frozen)) {
				t.Fatal("refusal lost complete frozen intent", err)
			}
			for i := 0; i < 2; i++ {
				if out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil || out.Msg.Mutation.Phase != rejected.Phase {
					t.Fatal("refused replay changed", err)
				}
			}
			changed := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			changed.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("same-key changed intent accepted", err)
			}
			// A fresh explicit intent is permitted after a known no-dispatch refusal,
			// but must independently pass the unchanged native coordinate predicates.
			next := proto.Clone(changed).(*golfv1.PublishPullRequestReviewDraftRequest)
			next.OperationId = uuid.NewString()
			out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(next))
			wanted := golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED
			posts := int32(0)
			if kind == "empty-summary" {
				wanted = golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_SUCCEEDED
				posts = 1
			}
			if err != nil || out.Msg.Mutation.Phase != wanted || f.posts.Load() != posts {
				t.Fatal("explicit refused-version intent bypassed admission", err)
			}
			if inlineStatus(t, c, m).Phase != rejected.Phase {
				t.Fatal("original refusal rewritten")
			}
		})
	}
}
func TestInlineReviewSemanticRefusalStorageLossPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	in := f.create(t, c)
	in.Summary = ""
	saved := savePrivateDraft(t, c, in)
	m := &golfv1.PublishPullRequestReviewDraftRequest{Target: in.Target, DraftId: in.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
	if _, err := f.db.Exec(`CREATE FUNCTION fixture_refusal_storage_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='REJECTED' THEN RAISE EXCEPTION 'fixture rejection loss';END IF;RETURN NEW;END $$;CREATE TRIGGER fixture_refusal_storage_failure BEFORE UPDATE ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION fixture_refusal_storage_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("lost refusal storage claimed completion", err)
	}
	if r := inlineStatus(t, c, m); r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_RESERVED || r.FailureCode != "" {
		t.Fatal("storage loss invented no-effect receipt")
	}
	if _, err := f.db.Exec(`DROP TRIGGER fixture_refusal_storage_failure ON golf_inline_review_mutations;DROP FUNCTION fixture_refusal_storage_failure()`); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = restarted
	c = f.client(t, session)
	if out, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil || out.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_RESERVED {
		t.Fatal("restart repaired unresolved reservation", err)
	}
	next := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
	next.OperationId = uuid.NewString()
	if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(next)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("semantic refusal bypassed unresolved actor gate", err)
	}
	if f.posts.Load() != 0 {
		t.Fatal("known unsupported intent dispatched")
	}
}

func TestInlineReviewQualifiedActivityPostgres(t *testing.T) {
	for _, mode := range []string{"", "lost", "pending-hidden", "semantic-refusal"} {
		t.Run(mode, func(t *testing.T) {
			f := newInlineReviewFixture(t)
			c := f.client(t, f.session(t, "pat"))
			var m *golfv1.PublishPullRequestReviewDraftRequest
			if mode == "semantic-refusal" {
				in := f.create(t, c)
				in.Summary = ""
				saved := savePrivateDraft(t, c, in)
				m = &golfv1.PublishPullRequestReviewDraftRequest{Target: in.Target, DraftId: in.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
			} else {
				_, m = f.saved(t, c)
				f.effect.Store(mode)
			}
			var before int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&before); err != nil || before != 0 {
				t.Fatal("private save leaked shared activity", err)
			}
			for i := 0; i < 2; i++ {
				if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
					t.Fatal(err)
				}
			}
			rows, err := f.db.Query("SELECT forge_url,repository_id,recipient_user_id,topic FROM golf_repository_activity")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			count := 0
			for rows.Next() {
				var forge, topic string
				var repo, recipient int64
				if err := rows.Scan(&forge, &repo, &recipient, &topic); err != nil {
					t.Fatal(err)
				}
				count++
				if forge != f.s.config.ForgeURL || repo != 11 || recipient != 0 || topic != "pulls" {
					t.Fatal("qualified activity crossed tenant/topic scope")
				}
			}
			wanted := 0
			if mode == "" {
				wanted = 1
			}
			if count != wanted || rows.Err() != nil {
				t.Fatal("replay or unqualified effect leaked activity", count, wanted, rows.Err())
			}
		})
	}
}
func TestInlineReviewOverallQualifiedActivityPostgres(t *testing.T) {
	f := newInlineReviewFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	saved, m := f.saved(t, c)
	overall := f.overall(m, saved)
	digest := sha256.Sum256([]byte("overall fixture"))
	var user, id int64
	if err := f.s.withManagedSession(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "pull-pat"}, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		user = caller.UserID
		row, e := q.ReservePullReviewMutation(t.Context(), database.ReservePullReviewMutationParams{UserID: user, ForgeURL: f.s.config.ForgeURL, IdempotencyKey: overall.IdempotencyKey, PayloadFingerprint: digest[:], BodyFingerprint: digest[:], RepositoryID: 11, RepositoryOwner: "alice", RepositoryName: "private", PullRequestID: 9007199254740993, Number: 7, ExpectedRevision: overall.ExpectedRevision, BaseCommitID: overall.BaseCommitId, HeadCommitID: overall.HeadCommitId, ReviewState: "COMMENT"})
		id = row.ID
		return e
	}); err != nil {
		t.Fatal(err)
	}
	count := func(want int) {
		t.Helper()
		var actual int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&actual); err != nil || actual != want {
			t.Fatal("overall qualified activity count", actual, want, err)
		}
	}
	count(0)
	q := database.New(f.db)
	if _, err := q.RecordPullReviewReceipt(t.Context(), database.RecordPullReviewReceiptParams{ObservedReviewID: 881, UserID: user, ForgeURL: f.s.config.ForgeURL, MutationID: id}); err != nil {
		t.Fatal(err)
	}
	count(0)
	if _, err := q.CompletePullReviewMutation(t.Context(), database.CompletePullReviewMutationParams{State: "SUCCEEDED", UserID: user, ForgeURL: f.s.config.ForgeURL, MutationID: id}); err != nil {
		t.Fatal(err)
	}
	count(1)
	if _, err := q.CompletePullReviewMutation(t.Context(), database.CompletePullReviewMutationParams{State: "SUCCEEDED", UserID: user, ForgeURL: f.s.config.ForgeURL, MutationID: id}); err == nil {
		t.Fatal("terminal replay rewrote overall effect")
	}
	count(1)
	var forge, topic string
	var repo, recipient int64
	if err := f.db.QueryRow("SELECT forge_url,repository_id,recipient_user_id,topic FROM golf_repository_activity").Scan(&forge, &repo, &recipient, &topic); err != nil || forge != f.s.config.ForgeURL || repo != 11 || recipient != 0 || topic != "pulls" {
		t.Fatal("overall event wrong scope", err)
	}
}

func TestInlineReviewSemanticRefusalBoundaryPostgres(t *testing.T) {
	t.Run("malformed request cannot fabricate durable refusal", func(t *testing.T) {
		f := newInlineReviewFixture(t)
		c := f.client(t, f.session(t, "pat"))
		_, m := f.saved(t, c)
		for _, field := range []string{"operation", "version", "decision", "comparison"} {
			bad := proto.Clone(m).(*golfv1.PublishPullRequestReviewDraftRequest)
			switch field {
			case "operation":
				bad.OperationId = "invalid"
			case "version":
				bad.ExpectedVersion = "01"
			case "decision":
				bad.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_PENDING
			case "comparison":
				bad.ComparisonId = "invalid"
			}
			if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(bad)); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatal("malformed identity admitted", field, err)
			}
		}
		var count int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_inline_review_mutations").Scan(&count); err != nil || count != 0 || f.posts.Load() != 0 {
			t.Fatal("malformed request invented journal", err)
		}
	})
	t.Run("unsupported intent cannot bypass managed bot uncertainty", func(t *testing.T) {
		f := newInlineReviewFixture(t)
		c := f.client(t, f.session(t, "pat"))
		in := f.create(t, c)
		in.Summary = ""
		saved := savePrivateDraft(t, c, in)
		m := &golfv1.PublishPullRequestReviewDraftRequest{Target: in.Target, DraftId: in.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
		run := f.seedBot(t, false)
		digest := sha256.Sum256([]byte("pending publisher"))
		if _, err := f.db.Exec(`INSERT INTO golf_reviewer_publications(run_id,forge_url,repository_id,pull_request_id,pull_number,publisher_id,payload_fingerprint,state) VALUES($1,$2,11,9007199254740993,7,42,$3,'reserved')`, run, f.s.config.ForgeURL, digest[:]); err != nil {
			t.Fatal(err)
		}
		if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal("semantic rejection bypassed native actor gate", err)
		}
		var count int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_inline_review_mutations").Scan(&count); err != nil || count != 0 || f.posts.Load() != 0 {
			t.Fatal("blocked domain invented safe refusal", err)
		}
	})
	t.Run("native authority denial withholds refusal receipt", func(t *testing.T) {
		f := newInlineReviewFixture(t)
		c := f.client(t, f.session(t, "pat"))
		in := f.create(t, c)
		in.Summary = ""
		saved := savePrivateDraft(t, c, in)
		m := &golfv1.PublishPullRequestReviewDraftRequest{Target: in.Target, DraftId: in.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
		if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err != nil {
			t.Fatal(err)
		}
		f.effect.Store("deny-target")
		if _, err := c.GetPullRequestInlineReviewMutation(context.Background(), connect.NewRequest(&golfv1.GetPullRequestInlineReviewMutationRequest{Target: m.Target, DraftId: m.DraftId, OperationId: m.OperationId})); err == nil {
			t.Fatal("authority loss exposed private refusal")
		}
		if _, err := c.PublishPullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err == nil {
			t.Fatal("replay bypassed lost native authority")
		}
		f.effect.Store("")
		if inlineStatus(t, c, m).Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || f.posts.Load() != 0 {
			t.Fatal("authority loss erased/reforged known receipt")
		}
	})
}
