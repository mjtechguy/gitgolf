package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/pressly/goose/v3"
	"google.golang.org/protobuf/proto"
)

const reviewerTestDiff = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1,2 @@\n keep\n+new\n"

type reviewerPublicationFixture struct {
	s           *Server
	p           reviewerRecord
	mode        atomic.Value
	posts       atomic.Int32
	pages       atomic.Int32
	mu          sync.Mutex
	input       reviewerPublicationInput
	postEntered chan struct{}
	postResume  chan struct{}
}

func newReviewerPublicationFixture(t *testing.T) *reviewerPublicationFixture {
	t.Helper()
	return newReviewerPublicationFixtureOnDatabase(t, testDatabase(t))
}
func newReviewerPublicationFixtureOnDatabase(t *testing.T, db *sql.DB) *reviewerPublicationFixture {
	t.Helper()
	f := &reviewerPublicationFixture{postEntered: make(chan struct{}, 1), postResume: make(chan struct{})}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL = provider.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	config.ReviewPublisherToken = "publisher-fixture"
	var err error
	f.s, err = New(config, db)
	if err != nil {
		t.Fatal(err)
	}
	account, err := ManageLocalAccount(t.Context(), f.s.db, f.s.keyring, config.ForgeURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "sponsor-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	local, _ := strconv.ParseInt(account.ID, 10, 64)
	user, _ := strconv.ParseInt(account.UserID, 10, 64)
	f.p = reviewerRecord{ID: uuid.NewString(), RepoID: 11, OwnerID: 42, UserID: user, NativeID: 42, LocalID: local, LocalVersion: 1, PublisherID: 43, Revision: 1, Enabled: true, Expiry: time.Now().Add(time.Hour), Config: &golfv1.Reviewer{Name: "Security Reviewer", PublisherLogin: "golf-bot", RespondToMentions: true, Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}}}
	raw, _ := json.Marshal(f.p.Config)
	_, err = f.s.db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) VALUES($1,$2,11,42,'alice','example',$3,42,$4,1,43,$5,true,clock_timestamp()+interval '1 hour')`, f.p.ID, config.ForgeURL, user, local, raw)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *reviewerPublicationFixture) run(t *testing.T, intent string) reviewerRunRecord {
	t.Helper()
	return f.runWithDiff(t, intent, reviewerTestDiff)
}
func (f *reviewerPublicationFixture) runWithDiff(t *testing.T, intent, diff string) reviewerRunRecord {
	t.Helper()
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(diff))
	_, err := f.s.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,repository_id,pull_request_id,merge_base_commit,diff_fingerprint) VALUES($1,$2,1,7,$3,$4,'pr_comment',$5,$6,43,'queued',11,99,$7,$8)`, id, f.p.ID, strings.Repeat("b", 40), strings.Repeat("a", 40), intent, diff, strings.Repeat("c", 40), hash[:])
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(intent, "comment/") {
		cid, _ := strconv.ParseInt(strings.TrimPrefix(intent, "comment/"), 10, 64)
		digest := sha256.Sum256([]byte("@golf-bot review"))
		if err := f.s.recordReviewComment(t.Context(), id, reviewCommentReceipt{ID: cid, Author: 42, Digest: digest[:]}); err != nil {
			t.Fatal(err)
		}
	}
	r, err := scanReviewRun(f.s.db.QueryRow(`SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE id=$1`, id))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func reviewerTestResult() reviewResult {
	return reviewResult{Summary: "Introduced defect", Findings: []reviewFinding{{Path: "a.go", Line: 2, Severity: "high", Title: "SQL injection", Evidence: "Untrusted query enters dynamic SQL.", Suggestion: "Bind parameters."}}}
}
func (f *reviewerPublicationFixture) serve(w http.ResponseWriter, r *http.Request) {
	mode := f.mode.Load().(string)
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	if r.URL.Path == "/api/v1/version" {
		write(map[string]string{"version": "1.27.3"})
		return
	}
	token := r.Header.Get("Authorization")
	if token != "token sponsor-fixture" && token != "token publisher-fixture" {
		w.WriteHeader(401)
		return
	}
	if r.URL.Path == "/api/v1/user" {
		id, login := int64(42), "alice"
		if token == "token publisher-fixture" {
			id, login = 43, "golf-bot"
			if mode == "publisher-changed" && f.posts.Load() > 0 {
				id = 44
			}
		}
		write(User{ID: id, Login: login})
		return
	}
	if r.URL.Path == "/api/v1/settings/api" {
		write(map[string]int{"max_response_items": 50})
		return
	}
	if r.URL.Path == "/api/v1/users/search" {
		write(map[string]any{"ok": true, "data": []User{{ID: 42, Login: "alice"}}})
		return
	}
	base := "/api/v1/repos/alice/example"
	url := "https://forge.invalid/alice/example"
	if r.URL.Path == base {
		write(map[string]any{"id": 11, "name": "example", "full_name": "alice/example", "html_url": url, "private": true, "owner": User{ID: 42, Login: "alice"}, "permissions": map[string]bool{"admin": true, "push": true, "pull": true}, "archived": false, "mirror": false, "default_branch": "main", "has_issues": true, "has_wiki": true, "has_pull_requests": true, "topics": []string{}, "internal_tracker": forgeInternalTracker{}})
		return
	}
	if r.URL.Path == base+"/collaborators/alice/permission" {
		write(map[string]any{"permission": "owner", "user": User{ID: 42, Login: "alice"}})
		return
	}
	if strings.HasPrefix(r.URL.Path, base+"/issues/comments/") {
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/issues/comments/"), 10, 64)
		body := "@golf-bot review"
		if mode == "comment-edited" {
			body = "@golf-bot changed"
		}
		if mode == "comment-deleted" {
			w.WriteHeader(404)
			return
		}
		write(map[string]any{"id": id, "body": body, "user": User{ID: 42, Login: "alice"}})
		return
	}
	if r.URL.Path == base+"/issues/7/comments" {
		rows := []map[string]any{}
		for id := int64(501); id <= 510; id++ {
			rows = append(rows, map[string]any{"id": id, "body": "@golf-bot review", "user": User{ID: 42, Login: "alice"}})
		}
		write(rows)
		return
	}
	no := false
	pull := forgePull{ID: 99, Number: 7, State: "open", Title: "Review", Body: "", User: &User{ID: 42, Login: "alice"}, CreatedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", HTMLURL: url + "/pulls/7", Draft: &no, Merged: &no, MergeBase: strings.Repeat("c", 40), Head: &forgePullRef{RepositoryID: 11, Ref: "feature", SHA: strings.Repeat("a", 40)}, Base: &forgePullRef{RepositoryID: 11, Ref: "main", SHA: strings.Repeat("b", 40)}}
	if mode == "head-moved" && f.posts.Load() > 0 {
		pull.Head.SHA = strings.Repeat("d", 40)
	}
	if r.URL.Path == base+"/pulls/7" {
		write(pull)
		return
	}
	if r.URL.Path == base+"/commits" {
		write([]forgeCommit{{SHA: pull.Head.SHA}})
		return
	}
	if r.URL.Path == base+"/pulls/7.diff" {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, reviewerTestDiff)
		return
	}
	route := base + "/pulls/7/reviews"
	if strings.HasPrefix(r.URL.Path, route) && token != "token publisher-fixture" {
		w.WriteHeader(403)
		return
	}
	if r.URL.Path == route && r.Method == "GET" {
		f.pages.Add(1)
		if mode == "pending-hidden" {
			w.Header().Set("X-Total-Count", "101")
			rows := []forgePullReview{}
			if r.URL.Query().Get("page") == "3" {
				rows = append(rows, forgePullReview{ID: 81, User: &User{ID: 43, Login: "golf-bot"}, State: "PENDING", PullRequestURL: pull.HTMLURL})
			}
			write(rows)
			return
		}
		w.Header().Set("X-Total-Count", "0")
		write([]forgePullReview{})
		return
	}
	f.mu.Lock()
	input := f.input
	f.mu.Unlock()
	if r.URL.Path == route && r.Method == "POST" {
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.input = input
		f.mu.Unlock()
		f.posts.Add(1)
		if mode == "held" {
			f.postEntered <- struct{}{}
			select {
			case <-f.postResume:
			case <-r.Context().Done():
				return
			}
		}
		if mode == "http500" {
			w.WriteHeader(500)
			return
		}
		if mode == "http422" {
			w.WriteHeader(422)
			return
		}
		if mode == "lost-receipt" {
			fmt.Fprint(w, "{")
			return
		}
	}
	review := forgePullReview{ID: 91, User: &User{ID: 43, Login: "golf-bot"}, Body: input.Body, State: "COMMENT", CommitID: input.Head, PullRequestURL: pull.HTMLURL, SubmittedAt: "2026-10-03T00:00:00Z", UpdatedAt: "2026-10-03T00:00:00Z", CommentsCount: proto.Int64(int64(len(input.Comments)))}
	switch mode {
	case "wrong-event":
		review.State = "APPROVED"
	case "wrong-body":
		review.Body += "changed"
	case "absorbed":
		review.CommentsCount = proto.Int64(int64(len(input.Comments) + 1))
	}
	if r.URL.Path == route || r.URL.Path == route+"/91" {
		write(review)
		return
	}
	if r.URL.Path == route+"/91/comments" {
		if mode == "child-denied" {
			w.WriteHeader(403)
			return
		}
		rows := []forgePullReviewComment{}
		for i, c := range input.Comments {
			rows = append(rows, forgePullReviewComment{ID: int64(101 + i), User: &User{ID: 43, Login: "golf-bot"}, Body: c.Body, Path: c.Path, Position: uint64(c.NewLine), ReviewID: 91, CommitID: strings.Repeat("c", 40), DiffHunk: "@@ -1 +1,2 @@\n keep\n+new\n", CreatedAt: review.SubmittedAt, UpdatedAt: review.UpdatedAt, HTMLURL: pull.HTMLURL + "#issuecomment-" + strconv.Itoa(101+i), PullRequestURL: pull.HTMLURL})
		}
		if mode == "mixed-context" {
			rows[0].DiffHunk = strings.ReplaceAll(rows[0].DiffHunk, "+new", "+different head")
		}
		if mode == "changed-child" {
			rows[0].Body += " changed"
		}
		write(rows)
		return
	}
	w.WriteHeader(404)
}
func (f *reviewerPublicationFixture) state(t *testing.T, r reviewerRunRecord, want string) {
	t.Helper()
	var state string
	if err := f.s.db.QueryRow(`SELECT state FROM golf_reviewer_runs WHERE id=$1`, r.ID).Scan(&state); err != nil || state != want {
		t.Fatalf("state %s want %s: %v", state, want, err)
	}
}
func TestReviewerPublicationPostgres(t *testing.T) {
	for _, mode := range []string{"", "http500", "http422", "lost-receipt", "wrong-event", "wrong-body", "absorbed", "mixed-context", "changed-child", "child-denied", "publisher-changed", "head-moved", "pending-hidden"} {
		t.Run(mode, func(t *testing.T) {
			f := newReviewerPublicationFixture(t)
			f.mode.Store(mode)
			r := f.run(t, "manual/"+uuid.NewString())
			err := f.s.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), func(context.Context) error { return nil })
			if mode == "" {
				if err != nil {
					t.Fatal(err)
				}
				f.state(t, r, "published")
			} else {
				if err == nil {
					t.Fatal("accepted unsafe publication")
				}
				want := "publication_unknown"
				if mode == "pending-hidden" {
					want = "failed"
					if f.posts.Load() != 0 || f.pages.Load() != 3 {
						t.Fatal("pending scan did not cover hidden configured pages", f.posts.Load(), f.pages.Load())
					}
				}
				f.state(t, r, want)
				if mode != "pending-hidden" {
					if f.posts.Load() != 1 {
						t.Fatal("dispatch count", f.posts.Load())
					}
					f.mode.Store("")
					next := f.run(t, "manual/"+uuid.NewString())
					if f.s.publishReviewer(t.Context(), f.p, next, reviewerTestResult(), func(context.Context) error { return nil }) == nil || f.posts.Load() != 1 {
						t.Fatal("replacement key bypassed uncertainty")
					}
					if f.s.reviewerEffectClear(t.Context(), f.p, 7, 99) == nil {
						t.Fatal("admission bypassed uncertainty")
					}
				}
			}
			if err := f.s.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), func(context.Context) error { return nil }); err == nil {
				t.Fatal("same run republished")
			}
		})
	}
}
func TestReviewerPublicationConcurrentPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	f.mode.Store("held")
	first := f.run(t, "manual/"+uuid.NewString())
	second := f.run(t, "comment/501")
	done := make(chan error, 1)
	go func() {
		done <- f.s.publishReviewer(context.Background(), f.p, first, reviewerTestResult(), func(context.Context) error { return nil })
	}()
	select {
	case <-f.postEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("publication did not enter")
	}
	if f.s.publishReviewer(t.Context(), f.p, second, reviewerTestResult(), func(context.Context) error { return nil }) == nil {
		t.Fatal("concurrent intent admitted")
	}
	close(f.postResume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.posts.Load() != 1 {
		t.Fatal("duplicate dispatch")
	}
}
func TestReviewerPublicationJournalPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	r := f.run(t, "manual/"+uuid.NewString())
	result := reviewerTestResult()
	payload := reviewerPublicationPayload(f.p, r, result)
	if owned, err := f.s.reserveReviewerPublication(t.Context(), f.p, r, result, payload); err != nil || !owned {
		t.Fatal(err)
	}
	for _, statement := range []string{`UPDATE golf_reviewer_runs SET diff='changed' WHERE id=$1`, `UPDATE golf_reviewer_runs SET findings='{}' WHERE id=$1`, `DELETE FROM golf_reviewer_runs WHERE id=$1`, `UPDATE golf_reviewer_publications SET payload_fingerprint=decode(repeat('ff',32),'hex') WHERE run_id=$1`, `DELETE FROM golf_reviewer_publication_events WHERE run_id=$1`, `UPDATE golf_reviewer_publications SET state='published',observed_review_id=91 WHERE run_id=$1`} {
		if _, err := f.s.db.Exec(statement, r.ID); err == nil {
			t.Fatal("mutable publication evidence", statement)
		}
	}
	for _, table := range []string{"golf_reviewer_publication_events", "golf_reviewer_publications", "golf_reviewer_runs"} {
		if _, err := f.s.db.Exec(`TRUNCATE ` + table + ` CASCADE`); err == nil {
			t.Fatal("truncated effect evidence", table)
		}
	}
	if err := f.s.advanceReviewerPublication(t.Context(), r, "dispatch_unknown", "", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.db.Exec(`UPDATE golf_reviewer_runs SET state='outdated' WHERE id=$1`, r.ID); err == nil {
		t.Fatal("unknown dispatch lost effect")
	}
	// Simulate process loss after committed intent. A fresh Server cannot replay.
	restarted, err := New(f.s.config, f.s.db)
	if err != nil {
		t.Fatal(err)
	}
	next := f.run(t, "comment/502")
	if restarted.publishReviewer(t.Context(), f.p, next, result, func(context.Context) error { return nil }) == nil || f.posts.Load() != 0 {
		t.Fatal("restart released unresolved intent")
	}
}
func TestReviewerPublicationAuthorityPostgres(t *testing.T) {
	for _, afterPost := range []bool{false, true} {
		t.Run(fmt.Sprint(afterPost), func(t *testing.T) {
			f := newReviewerPublicationFixture(t)
			r := f.run(t, "manual/"+uuid.NewString())
			check := func(context.Context) error {
				if !afterPost || f.posts.Load() > 0 {
					return errUnauthenticated
				}
				return nil
			}
			if f.s.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), check) == nil {
				t.Fatal("lost authority published")
			}
			want := "failed"
			posts := int32(0)
			if afterPost {
				want = "publication_unknown"
				posts = 1
			}
			f.state(t, r, want)
			if f.posts.Load() != posts {
				t.Fatal("authority dispatch boundary")
			}
		})
	}
}

func TestReviewerPublicationLostSQLPostgres(t *testing.T) {
	for _, phase := range []string{"receipt", "published"} {
		t.Run(phase, func(t *testing.T) {
			f := newReviewerPublicationFixture(t)
			r := f.run(t, "manual/"+uuid.NewString())
			predicate := "NEW.observed_review_id IS NOT NULL"
			if phase == "published" {
				predicate = "NEW.state='published'"
			}
			_, err := f.s.db.Exec(`CREATE FUNCTION fixture_drop_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ` + predicate + ` THEN RAISE EXCEPTION 'fixture SQL loss'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_drop_publication BEFORE UPDATE ON golf_reviewer_publications FOR EACH ROW EXECUTE FUNCTION fixture_drop_publication()`)
			if err != nil {
				t.Fatal(err)
			}
			if f.s.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), func(context.Context) error { return nil }) == nil {
				t.Fatal("SQL loss reported success")
			}
			f.state(t, r, "publishing")
			var state string
			var id *int64
			if err = f.s.db.QueryRow(`SELECT state,observed_review_id FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&state, &id); err != nil || state != "dispatch_unknown" {
				t.Fatal("lost durable uncertainty", state, err)
			}
			if phase == "published" && (id == nil || *id != 91) {
				t.Fatal("correlated receipt lost")
			}
			if f.posts.Load() != 1 {
				t.Fatal("native dispatch count")
			}
			if _, err = f.s.db.Exec(`DROP TRIGGER fixture_drop_publication ON golf_reviewer_publications; DROP FUNCTION fixture_drop_publication()`); err != nil {
				t.Fatal(err)
			}
			restarted, err := New(f.s.config, f.s.db)
			if err != nil {
				t.Fatal(err)
			}
			if restarted.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), func(context.Context) error { return nil }) == nil || f.posts.Load() != 1 {
				t.Fatal("lost SQL replayed native effect")
			}
			next := f.run(t, "comment/503")
			if restarted.publishReviewer(t.Context(), f.p, next, reviewerTestResult(), func(context.Context) error { return nil }) == nil || f.posts.Load() != 1 {
				t.Fatal("SQL loss allowed fresh key")
			}
		})
	}
}
func TestReviewerPublicationLegacyBlockPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	// Legacy evidence intentionally has no invented native PR/comparison IDs.
	_, err := f.s.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,legacy_effect_block) VALUES($1,$2,1,7,$3,$4,'push','change','',43,'outdated',true)`, uuid.NewString(), f.p.ID, strings.Repeat("e", 40), strings.Repeat("f", 40))
	if err != nil {
		t.Fatal(err)
	}
	r := f.run(t, "manual/"+uuid.NewString())
	if f.s.reviewerEffectClear(t.Context(), f.p, 7, 99) == nil || f.s.publishReviewer(t.Context(), f.p, r, reviewerTestResult(), func(context.Context) error { return nil }) == nil || f.posts.Load() != 0 {
		t.Fatal("legacy ambiguity bypassed")
	}
	var ids int
	if err = f.s.db.QueryRow(`SELECT count(*) FROM golf_reviewer_runs WHERE legacy_effect_block AND (repository_id IS NOT NULL OR pull_request_id IS NOT NULL OR merge_base_commit IS NOT NULL OR review_id IS NOT NULL)`).Scan(&ids); err != nil || ids != 0 {
		t.Fatal("invented legacy binding")
	}
}
func TestReviewerPublicationCancelledPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	f.mode.Store("held")
	r := f.run(t, "manual/"+uuid.NewString())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- f.s.publishReviewer(ctx, f.p, r, reviewerTestResult(), func(context.Context) error { return nil })
	}()
	select {
	case <-f.postEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch did not enter")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled publication succeeded")
	}
	f.state(t, r, "publication_unknown")
	if f.posts.Load() != 1 {
		t.Fatal("cancelled dispatch count")
	}
	next := f.run(t, "comment/504")
	if f.s.publishReviewer(t.Context(), f.p, next, reviewerTestResult(), func(context.Context) error { return nil }) == nil {
		t.Fatal("cancellation released effect")
	}
}

// Exercise the real forward migration with pre-035 rows. This schema is created
// only in the disposable test database; neither a live schema nor forge is used.
func TestReviewerPublicationMigrationPostgres(t *testing.T) {
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	t.Cleanup(func() { admin.Close() })
	schema := "golf_review_upgrade_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`) })
	config.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.UpTo(t.Context(), 202610030034); err != nil {
		t.Fatal(err)
	}
	// Seed Golf-owned pre035 rows without constructing the latest runtime
	// against an intentionally old schema. Latest key-family queries must not
	// learn a downgrade fallback merely to support this migration fixture.
	runtimeConfig := testConfig("http://migration-fixture.invalid")
	keys, err := ParseKeyring(runtimeConfig.EncryptionKey, "", "")
	if err != nil {
		t.Fatal(err)
	}
	q := database.New(db)
	user, err := q.UpsertUser(t.Context(), database.UpsertUserParams{ForgeURL: runtimeConfig.ForgeURL, ForgeUserID: 42, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	binding := sha256.Sum256([]byte("owned pre035 migration account"))
	encrypted, key, err := keys.seal(localAccountDomain, "sponsor-fixture", binding[:])
	if err != nil {
		t.Fatal(err)
	}
	password, err := hashLocalPassword(t.Context(), localTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	account, err := q.CreateLocalAccount(t.Context(), database.CreateLocalAccountParams{UserID: user, Username: "alice", PasswordHash: password, EncryptedForgeToken: encrypted, CredentialBinding: binding[:], CredentialKeyID: key})
	if err != nil {
		t.Fatal(err)
	}
	f := &reviewerPublicationFixture{p: reviewerRecord{ID: uuid.NewString(), RepoID: 11, OwnerID: 42, UserID: user, NativeID: 42, LocalID: account.ID, LocalVersion: 1, PublisherID: 43, Revision: 1, Enabled: true, Expiry: time.Now().Add(time.Hour), Config: &golfv1.Reviewer{Name: "Security Reviewer", PublisherLogin: "golf-bot", RespondToMentions: true, Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}}}}
	raw, _ := json.Marshal(f.p.Config)
	if _, err = db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) VALUES($1,$2,11,42,'alice','example',$3,42,$4,1,43,$5,true,clock_timestamp()+interval '1 hour')`, f.p.ID, runtimeConfig.ForgeURL, user, account.ID, raw); err != nil {
		t.Fatal(err)
	}
	states := []string{"publishing", "publication_unknown", "outdated", "published", "queued", "failed"}
	for _, state := range states {
		var native any
		if state == "published" {
			native = int64(91)
		}
		_, err = db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,review_id) VALUES($1,$2,1,7,$3,$4,'push',$5,'',43,$6,$7)`, uuid.NewString(), f.p.ID, strings.Repeat("b", 40), strings.Repeat("a", 40), "migration/"+state, state, native)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.s, err = New(runtimeConfig, db)
	if err != nil {
		t.Fatal("latest runtime after complete upgrade", err)
	}
	for _, state := range states {
		var blocked bool
		var native *int64
		var bindings int
		err = db.QueryRow(`SELECT legacy_effect_block,review_id,(repository_id IS NOT NULL)::int+(pull_request_id IS NOT NULL)::int+(merge_base_commit IS NOT NULL)::int+(diff_fingerprint IS NOT NULL)::int FROM golf_reviewer_runs WHERE state=$1`, state).Scan(&blocked, &native, &bindings)
		want := state == "publishing" || state == "publication_unknown" || state == "outdated"
		if err != nil || blocked != want || bindings != 0 {
			t.Fatal("migration rewrote or invented selection", state, err)
		}
		if state == "published" && (native == nil || *native != 91) {
			t.Fatal("existing receipt lost")
		}
	}
	var evidence int
	if err = db.QueryRow(`SELECT (SELECT count(*) FROM golf_reviewer_publications)+(SELECT count(*) FROM golf_reviewer_publication_events)`).Scan(&evidence); err != nil || evidence != 0 {
		t.Fatal("invented dispatch history", err)
	}
	if f.s.reviewerEffectClear(t.Context(), f.p, 7, 99) == nil {
		t.Fatal("migrated ambiguity bypassed")
	}
	if _, err = provider.DownTo(t.Context(), 202610030034); err == nil {
		t.Fatal("unsafe journal downgrade allowed")
	}
}

func TestReviewerPublicationEscapedBodyPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	r := f.run(t, "manual/"+uuid.NewString())
	result := reviewerTestResult()
	result.Findings[0].Evidence = strings.Repeat("<", 2000)
	result.Findings[0].Suggestion = strings.Repeat("<", 2000)
	raw, _ := json.Marshal(result)
	if _, err := validateReviewResult(string(raw), r.Diff); err != nil {
		t.Fatal("raw bounded result should validate", err)
	}
	if f.s.publishReviewer(t.Context(), f.p, r, result, func(context.Context) error { return nil }) == nil {
		t.Fatal("expanded native body accepted")
	}
	if f.posts.Load() != 0 {
		t.Fatal("oversize body dispatched")
	}
	var reservations int
	if err := f.s.db.QueryRow(`SELECT count(*) FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&reservations); err != nil || reservations != 0 {
		t.Fatal("oversize body reserved effect", err)
	}
	f.state(t, r, "queued")
}

func TestReviewerPublicationReservedSupersessionPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	r := f.run(t, "manual/"+uuid.NewString())
	// Another intake can have passed its effect guard before this reservation.
	if err := f.s.reviewerEffectClear(t.Context(), f.p, 7, 99); err != nil {
		t.Fatal(err)
	}
	reserved, resume := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- f.s.publishReviewer(context.Background(), f.p, r, reviewerTestResult(), func(context.Context) error {
			close(reserved)
			<-resume
			return errUnauthenticated
		})
	}()
	select {
	case <-reserved:
	case <-time.After(5 * time.Second):
		t.Fatal("reservation not reached")
	}
	// Defence in depth: even an unguarded old writer cannot erase the reservation.
	for _, state := range []string{"outdated", "failed", "published"} {
		if _, err := f.s.db.Exec(`UPDATE golf_reviewer_runs SET state=$2 WHERE id=$1`, r.ID, state); err == nil {
			t.Fatal("reserved run superseded", state)
		}
	}
	changed, err := f.s.db.Exec(`UPDATE golf_reviewer_runs SET state='outdated',reason='PR commits changed; this review is historical.' WHERE reviewer_id=$1 AND pull_number=$2 AND (base_commit<>$3 OR head_commit<>$4) AND state IN ('queued','running','failed') AND NOT EXISTS(SELECT 1 FROM golf_reviewer_publications x WHERE x.run_id=golf_reviewer_runs.id AND x.state IN ('reserved','dispatch_unknown'))`, f.p.ID, 7, strings.Repeat("d", 40), strings.Repeat("e", 40))
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := changed.RowsAffected(); n != 0 {
		t.Fatal("in-flight intake erased reserved run")
	}
	f.state(t, r, "queued")
	close(resume)
	if err := <-done; err == nil {
		t.Fatal("preflight authority denial accepted")
	}
	f.state(t, r, "failed")
	var phase string
	if err := f.s.db.QueryRow(`SELECT state FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&phase); err != nil || phase != "rejected" {
		t.Fatal("preflight refusal did not precede failed state", phase, err)
	}
	if f.posts.Load() != 0 {
		t.Fatal("rejected reservation posted")
	}
	// Only a known pre-dispatch rejection releases the PR effect exclusion.
	next := f.run(t, "comment/505")
	if err := f.s.publishReviewer(t.Context(), f.p, next, reviewerTestResult(), func(context.Context) error { return nil }); err != nil {
		t.Fatal("rejected reservation remained blocked", err)
	}
	f.state(t, next, "published")
	if f.posts.Load() != 1 {
		t.Fatal("dispatch count after refusal")
	}
}

func TestReviewerPublicationEncodedReceiptPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	diff := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-keep\n+" + strings.Repeat("<>&", 15000) + "\n"
	r := f.runWithDiff(t, "manual/"+uuid.NewString(), diff)
	result := reviewerTestResult()
	result.Findings = nil
	for i := 0; i < 10; i++ {
		finding := reviewerTestResult().Findings[0]
		finding.Line = 1
		finding.Title = fmt.Sprintf("Defect %d", i)
		result.Findings = append(result.Findings, finding)
	}
	raw, _ := json.Marshal(result)
	if len(diff) >= 262144 {
		t.Fatal("fixture exceeds existing frozen diff bound")
	}
	if _, err := validateReviewResult(string(raw), diff); err != nil {
		t.Fatal("supported raw comparison/result rejected", err)
	}
	comparison, err := parseReviewComparison(diff)
	if err != nil {
		t.Fatal(err)
	}
	one, supported := comparison.NativeContextJSONBound("a.go", 1)
	if !supported || one*10 <= maxForgeResponse {
		t.Fatal("fixture does not exceed encoded transport budget", one)
	}
	if err := f.s.publishReviewer(t.Context(), f.p, r, result, func(context.Context) error { return nil }); err == nil {
		t.Fatal("known oversized receipt dispatched")
	}
	if f.posts.Load() != 0 {
		t.Fatal("oversized receipt posted")
	}
	var reservations int
	if err := f.s.db.QueryRow(`SELECT count(*) FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&reservations); err != nil || reservations != 0 {
		t.Fatal("oversized receipt reserved", err)
	}
	f.state(t, r, "queued")
}
