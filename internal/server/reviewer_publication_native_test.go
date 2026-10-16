package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Opt-in supported-native proof. The launcher owns and purges all forge actors;
// this test creates Golf records only in testDatabase's disposable PG schema.
// No provider, workflow, served worker or protected merge is exercised.
func TestReviewerPublicationNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_REVIEW_PUBLICATION_NATIVE_PROOF")
	if path == "" {
		t.Skip("supported native fixture input not provided")
	}
	stat, err := os.Lstat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 1<<20 {
		t.Fatal("native publication input must be bounded and owner-only")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal("native publication input unavailable")
	}
	defer f.Close()
	var in struct {
		URL, Owner, Repository, SponsorToken, PublisherToken string
		RepositoryID, PullID, Number, OwnerID, PublisherID   int64
		Base, Head, MergeBase, Diff                          string
		PendingID, PendingChildID                            int64
	}
	d := json.NewDecoder(io.LimitReader(f, 1<<20+1))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-bot-pub-probe-") || in.Repository != "private" || in.PendingID <= 0 || in.Base == in.MergeBase {
		t.Fatal("invalid disposable native publication envelope")
	}
	config := testConfig(in.URL)
	config.ForgePublicURL = in.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	config.ReviewPublisherToken = in.PublisherToken
	s, err := New(config, testDatabase(t))
	if err != nil {
		t.Fatal("native publication server initialization failed")
	}
	account, err := ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Owner, Password: localTestPassword, ForgeToken: in.SponsorToken})
	if err != nil {
		t.Fatal("native sponsor binding failed")
	}
	local, _ := strconv.ParseInt(account.ID, 10, 64)
	user, _ := strconv.ParseInt(account.UserID, 10, 64)
	p := reviewerRecord{ID: uuid.NewString(), RepoID: in.RepositoryID, OwnerID: in.OwnerID, UserID: user, NativeID: in.OwnerID, LocalID: local, LocalVersion: 1, PublisherID: in.PublisherID, Revision: 1, Enabled: true, Expiry: time.Now().Add(time.Hour), Config: &golfv1.Reviewer{Name: "Native publication qualifier", Repository: &golfv1.RepositoryKey{Owner: in.Owner, Name: in.Repository}}}
	raw, _ := json.Marshal(p.Config)
	_, err = s.db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$4,$8,1,$9,$10,true,clock_timestamp()+interval '1 hour')`, p.ID, in.URL, in.RepositoryID, in.OwnerID, in.Owner, in.Repository, user, local, in.PublisherID, raw)
	if err != nil {
		t.Fatal("native reviewer metadata initialization failed")
	}
	makeRun := func(intent string) reviewerRunRecord {
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(in.Diff))
		_, err := s.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,repository_id,pull_request_id,merge_base_commit,diff_fingerprint) VALUES($1,$2,1,$3,$4,$5,'pr_comment',$6,$7,$8,'queued',$9,$10,$11,$12)`, id, p.ID, in.Number, in.Base, in.Head, intent, in.Diff, in.PublisherID, in.RepositoryID, in.PullID, in.MergeBase, hash[:])
		if err != nil {
			t.Fatal("native run initialization failed")
		}
		r, err := scanReviewRun(s.db.QueryRow(`SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE id=$1`, id))
		if err != nil {
			t.Fatal("native run read failed")
		}
		return r
	}
	result := reviewResult{Summary: "Deterministic integration fixture; no AI execution.", Findings: []reviewFinding{{Path: "context.txt", Line: 1, Severity: "low", Title: "Native context verification", Evidence: "This is synthetic fixture content.", Suggestion: "Retain the exact selected comparison."}}}
	before := makeRun("pending-preflight")
	authority := func(ctx context.Context) error { return s.reviewerCurrent(ctx, p) }
	if s.publishReviewer(t.Context(), p, before, result, authority) == nil {
		t.Fatal("existing native pending review permitted publication")
	}
	var state string
	if s.db.QueryRow(`SELECT state FROM golf_reviewer_publications WHERE run_id=$1`, before.ID).Scan(&state) != nil || state != "rejected" {
		t.Fatal("native pending refusal did not retain terminal preflight evidence")
	}
	base, repo, pull, err := s.reviewerPublisherTarget(t.Context(), p, before)
	if err != nil {
		t.Fatal("native target observation failed")
	}
	token := forgeCredential{Kind: "pat", Token: in.PublisherToken}
	route := base + "/pulls/" + strconv.FormatInt(in.Number, 10) + "/reviews/" + strconv.FormatInt(in.PendingID, 10)
	var pending forgePullReview
	if _, err = s.forge(t.Context(), http.MethodGet, route, token, nil, &pending); err != nil || pending.ID != in.PendingID || pending.User == nil || pending.User.ID != in.PublisherID || pending.State != "PENDING" || pending.CommentsCount == nil || *pending.CommentsCount != 1 {
		t.Fatal("preflight changed original native pending review")
	}
	var pendingChildren []forgePullReviewComment
	if _, err = s.forge(t.Context(), http.MethodGet, route+"/comments", token, nil, &pendingChildren); err != nil || len(pendingChildren) != 1 || pendingChildren[0].ID != in.PendingChildID || pendingChildren[0].Path != "context.txt" || pendingChildren[0].Position != 1 || pendingChildren[0].OriginalPosition != 0 || pendingChildren[0].Body != "Preserve this pending child during preflight refusal." {
		t.Fatal("preflight changed original native pending child")
	}
	if _, err = s.forgeJSON(t.Context(), http.MethodDelete, route, token, nil, nil, http.StatusNoContent); err != nil {
		t.Fatal("explicit supported native pending cleanup failed")
	}
	if s.publishReviewer(t.Context(), p, before, result, authority) == nil {
		t.Fatal("rejected original intent replayed after native pending cleanup")
	}
	r := makeRun("qualified-publication")
	if err = s.publishReviewer(t.Context(), p, r, result, authority); err != nil {
		t.Fatal("production helper did not independently verify native publication")
	}
	var receipt int64
	if s.db.QueryRow(`SELECT state,observed_review_id FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&state, &receipt) != nil || state != "published" || receipt <= 0 {
		t.Fatal("native publication receipt not durable")
	}
	comparison, err := parseReviewComparison(in.Diff)
	if err != nil || s.verifyReviewerPublication(t.Context(), base, repo, pull, r, reviewerPublicationPayload(p, r, result), receipt, comparison) != nil {
		t.Fatal("second independent native child/context readback failed")
	}
	if s.publishReviewer(t.Context(), p, r, result, authority) == nil {
		t.Fatal("published original intent replayed")
	}
	var reviews []forgePullReview
	headers, err := s.forge(t.Context(), http.MethodGet, base+"/pulls/"+strconv.FormatInt(in.Number, 10)+"/reviews?limit=50", token, nil, &reviews)
	if err != nil || headers.Get("X-Total-Count") != "1" || len(reviews) != 1 || reviews[0].ID != receipt {
		t.Fatal("native once-only publication inventory mismatch")
	}
	// Actual native PR comments can request bounded read-only work only while
	// the exact captured author/body remains associated with this PR.
	actor, err := s.reviewerActor(t.Context(), p)
	if err != nil {
		t.Fatal("native command actor unavailable")
	}
	publisher, err := s.reviewPublisher(t.Context())
	if err != nil {
		t.Fatal("native command bot unavailable")
	}
	p.Config.PublisherLogin = publisher.Login
	p.Config.RespondToMentions = true
	body := "@" + publisher.Login + " review captured comparison"
	var comment struct {
		ID int64 `json:"id"`
	}
	commentRoute := base + "/issues/" + strconv.FormatInt(in.Number, 10) + "/comments"
	if _, err = s.forgeJSON(t.Context(), http.MethodPost, commentRoute, actor.Credential, map[string]string{"body": body}, &comment, http.StatusCreated); err != nil || comment.ID <= 0 {
		t.Fatal("owned native command creation failed")
	}
	intent := "comment/" + strconv.FormatInt(comment.ID, 10)
	command, err := s.agentCommentSnapshot(t.Context(), p, actor, pull, intent, body)
	if err != nil || command == nil || command.Author != in.OwnerID {
		t.Fatal("native command exact author/body capture failed")
	}
	commandRun := makeRun(intent)
	if s.recordReviewComment(t.Context(), commandRun.ID, *command) != nil || s.revalidateReviewComment(t.Context(), p, actor, pull, commandRun.ID, intent) != nil {
		t.Fatal("native original command receipt invalid")
	}
	editRoute := base + "/issues/comments/" + strconv.FormatInt(comment.ID, 10)
	if _, err = s.forgeJSON(t.Context(), http.MethodPatch, editRoute, actor.Credential, map[string]string{"body": body + " changed"}, &struct{}{}, http.StatusOK); err != nil {
		t.Fatal("owned native command edit failed")
	}
	if s.revalidateReviewComment(t.Context(), p, actor, pull, commandRun.ID, intent) == nil {
		t.Fatal("edited native command retained authority")
	}
	if _, err = s.forgeJSON(t.Context(), http.MethodDelete, editRoute, actor.Credential, nil, nil, http.StatusNoContent); err != nil {
		t.Fatal("owned native command delete failed")
	}
	if s.revalidateReviewComment(t.Context(), p, actor, pull, commandRun.ID, intent) == nil {
		t.Fatal("deleted native command retained authority")
	}
	var sessions int
	if s.db.QueryRow(`SELECT count(*) FROM golf_sessions`).Scan(&sessions) != nil || sessions != 0 {
		t.Fatal("temporary native proof session remained")
	}
}
