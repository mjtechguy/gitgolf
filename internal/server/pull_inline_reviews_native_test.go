package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

// Opt-in actual supported-native proof of the production HTTP handlers. Golf
// lives only in testDatabase's disposable schema; the launcher owns/purges forge
// fixtures. This is not the deployed Golf UI or a protected-write/recovery proof.
func TestInlineReviewNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_INLINE_REVIEW_NATIVE_PROOF")
	if path == "" {
		t.Skip("supported native fixture input not provided")
	}
	stat, err := os.Lstat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 1<<20 {
		t.Fatal("bounded owner-only fixture envelope required")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal("fixture input unavailable")
	}
	defer f.Close()
	var in struct {
		URL, Owner, Repository, Reviewer, ReviewerToken, Path, Base, Head, MergeBase, Diff string
		RepositoryID, PullID, Number, ReviewerID, PendingID, PendingChildID                int64
	}
	decoder := json.NewDecoder(io.LimitReader(f, 1<<20+1))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-inline-pub-probe-") || !strings.HasPrefix(in.Reviewer, "golf-inline-pub-probe-") || in.Repository != "private" || in.Path != "src/context ü.txt" || in.PendingID <= 0 || in.MergeBase == in.Base {
		t.Fatal("invalid disposable native envelope")
	}
	config := testConfig(in.URL)
	config.ForgePublicURL = in.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	s, err := New(config, testDatabase(t))
	if err != nil {
		t.Fatal("native handler initialization failed")
	}
	if _, err = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Reviewer, Password: localTestPassword, ForgeToken: in.ReviewerToken}); err != nil {
		t.Fatal("ordinary managed reviewer enrollment failed")
	}
	session, c, _, _, _ := testRPCClients(t, s)
	if _, err = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Reviewer, Password: localTestPassword})); err != nil {
		t.Fatal("ordinary Golf password login failed")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("temporary Golf session logout failed")
		}
	})
	target := &golfv1.PullReviewDraftTarget{Repository: &golfv1.RepositoryKey{Owner: in.Owner, Name: in.Repository}, RepositoryId: strconv.FormatInt(in.RepositoryID, 10), PullRequestId: strconv.FormatInt(in.PullID, 10), Number: uint32(in.Number)}
	token := forgeCredential{Kind: "pat", Token: in.ReviewerToken}
	base, _ := repositoryPath(keyFrom(target.Repository))
	route := base + "/pulls/" + strconv.FormatInt(in.Number, 10)
	readNative := func() []forgePullReview {
		var rows []forgePullReview
		headers, e := s.forge(t.Context(), http.MethodGet, route+"/reviews?limit=50", token, nil, &rows)
		if e != nil || rows == nil || headers.Get("X-Total-Count") != strconv.Itoa(len(rows)) {
			t.Fatal("native review inventory unavailable")
		}
		return rows
	}
	generation := "0"
	var saved *golfv1.SavePullRequestReviewDraftResponse
	newCapture := func() *golfv1.PublishPullRequestReviewDraftRequest {
		if saved != nil {
			del, e := c.DeletePullRequestReviewDraft(t.Context(), connect.NewRequest(&golfv1.DeletePullRequestReviewDraftRequest{Target: target, DraftId: saved.Draft.Id, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, OperationId: uuid.NewString()}))
			if e != nil {
				t.Fatal("explicit private collection tombstone failed")
			}
			generation = del.Msg.TargetGeneration
		}
		pull, e := c.GetPullRequest(t.Context(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: target.Repository, Number: target.Number}))
		if e != nil {
			t.Fatal("current native pull unavailable")
		}
		diff, e := c.GetPullRequestDiff(t.Context(), connect.NewRequest(&golfv1.GetPullRequestDiffRequest{Repository: target.Repository, RepositoryId: target.RepositoryId, PullRequestId: target.PullRequestId, Number: target.Number, BaseCommitId: in.Base, HeadCommitId: in.Head}))
		if e != nil || diff.Msg.RawDiff != in.Diff || diff.Msg.MergeBaseCommitId != in.MergeBase {
			t.Fatal("original independently observed comparison differs")
		}
		hash := sha256.Sum256([]byte(in.Diff))
		input := &golfv1.SavePullRequestReviewDraftRequest{Target: target, DraftId: uuid.NewString(), OperationId: uuid.NewString(), ExpectedVersion: "0", ExpectedTargetGeneration: generation, Comparison: &golfv1.SavePullRequestReviewDraftRequest_Capture{Capture: &golfv1.PullReviewDraftCapture{Selection: &golfv1.PullRequestSelection{Repository: target.Repository, RepositoryId: target.RepositoryId, PullRequestId: target.PullRequestId, Number: target.Number, BaseCommitId: in.Base, HeadCommitId: in.Head}, ExpectedPullRevision: pull.Msg.PullRequest.Revision, MergeBaseCommitId: in.MergeBase, DiffSha256: hex.EncodeToString(hash[:])}}, Summary: "Deterministic human inline qualification; no AI or workflow execution.", Entries: []*golfv1.PullReviewDraftEntry{}}
		for _, side := range []golfv1.PullReviewDraftSide{golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD, golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW} {
			input.Entries = append(input.Entries, &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Coordinate: &golfv1.PullReviewDraftCoordinate{Path: in.Path, Line: 1, Side: side}, Body: "Synthetic native " + side.String() + " finding."})
		}
		out, e := c.SavePullRequestReviewDraft(t.Context(), connect.NewRequest(input))
		if e != nil {
			t.Fatal("exact native old/new private capture failed")
		}
		saved = out.Msg
		return &golfv1.PublishPullRequestReviewDraftRequest{Target: target, DraftId: input.DraftId, ExpectedVersion: saved.CurrentVersion, ExpectedTargetGeneration: saved.TargetGeneration, ComparisonId: saved.Draft.Comparison.Id, OperationId: uuid.NewString(), Decision: golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT}
	}
	rejected := newCapture()
	out, err := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(rejected))
	if err != nil || out.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || len(readNative()) != 1 {
		t.Fatal("native own pending preflight was not nondispatch refusal")
	}
	var pendingChildren []forgePullReviewComment
	pendingRoute := route + "/reviews/" + strconv.FormatInt(in.PendingID, 10)
	if _, err = s.forge(t.Context(), http.MethodGet, pendingRoute+"/comments", token, nil, &pendingChildren); err != nil || len(pendingChildren) != 1 || pendingChildren[0].ID != in.PendingChildID || pendingChildren[0].Body != "Preserve this pending control." {
		t.Fatal("preflight modified native pending child")
	}
	if _, err = s.forgeJSON(t.Context(), http.MethodDelete, pendingRoute, token, nil, nil, http.StatusNoContent); err != nil {
		t.Fatal("explicit native fixture pending discard failed")
	}
	if replay, e := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(rejected)); e != nil || replay.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || len(readNative()) != 0 {
		t.Fatal("rejected key resumed after explicit cleanup")
	}
	// A native-valid saved OLD/NEW collection with an empty COMMENT summary is
	// a known semantic refusal, not a missing-operation/status404 dead end.
	semantic := newCapture()
	empty := editPrivateDraft(saved)
	empty.Summary = ""
	edited, e := c.SavePullRequestReviewDraft(t.Context(), connect.NewRequest(empty))
	if e != nil {
		t.Fatal("native empty-summary private edit failed")
	}
	saved = edited.Msg
	semantic.ExpectedVersion = saved.CurrentVersion
	semantic.ExpectedTargetGeneration = saved.TargetGeneration
	if _, e := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(semantic)); e != nil {
		t.Fatal("native semantic refusal returned transport uncertainty")
	}
	status, e := c.GetPullRequestInlineReviewMutation(t.Context(), connect.NewRequest(&golfv1.GetPullRequestInlineReviewMutationRequest{Target: target, DraftId: semantic.DraftId, OperationId: semantic.OperationId}))
	if e != nil || status.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || status.Msg.Mutation.FailureCode != "preflight_refused" || status.Msg.Mutation.AcceptedVersion != "2" || len(readNative()) != 0 {
		t.Fatal("native semantic refusal missing exact inspectable no-dispatch receipt")
	}
	if replay, e := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(semantic)); e != nil || replay.Msg.Mutation.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_REJECTED || len(readNative()) != 0 {
		t.Fatal("native semantic rejection replay dispatched")
	}
	var priorActivity int
	if e := s.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&priorActivity); e != nil || priorActivity != 0 {
		t.Fatal("private save or nondispatch refusal leaked shared invalidation")
	}
	for i, decision := range []golfv1.PullRequestReviewState{golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES} {
		// These are explicit new captures, not unknown retries, retained-draft remaps
		// or automatic pending adoption. Native activity may alter PR timestamps.
		m := newCapture()
		m.Decision = decision
		published, e := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(m))
		if e != nil {
			t.Fatal("native batch publication returned transport refusal")
		}
		r := published.Msg.Mutation
		if r.Phase != golfv1.PullInlineReviewPhase_PULL_INLINE_REVIEW_PHASE_SUCCEEDED || len(r.VerifiedCommentIds) != 2 || r.MergeBaseCommitId != in.MergeBase || r.HeadCommitId != in.Head {
			t.Fatal("native header/full children/context not independently verified")
		}
		id, e := strconv.ParseInt(r.ObservedReviewId, 10, 64)
		if e != nil {
			t.Fatal("native receipt identity absent")
		}
		var children []forgePullReviewComment
		if _, e = s.forge(t.Context(), http.MethodGet, route+"/reviews/"+strconv.FormatInt(id, 10)+"/comments", token, nil, &children); e != nil || len(children) != 2 {
			t.Fatal("independent native child inventory failed")
		}
		old, newSide := 0, 0
		for _, child := range children {
			if child.Path != in.Path || !strings.Contains(child.DiffHunk, "-merge-base one") || child.Position > 0 && !strings.Contains(child.DiffHunk, "+selected-head one") || strings.Contains(child.DiffHunk, "base-tip one") {
				t.Fatal("original M/H context was mixed with target B")
			}
			if child.OriginalPosition == 1 && child.Position == 0 {
				old++
			}
			if child.Position == 1 && child.OriginalPosition == 0 {
				newSide++
			}
		}
		if old != 1 || newSide != 1 {
			t.Fatal("old/new receipt side mapping differs")
		}
		for j := 0; j < 2; j++ {
			again, e := c.PublishPullRequestReviewDraft(t.Context(), connect.NewRequest(m))
			if e != nil || again.Msg.Mutation.ObservedReviewId != r.ObservedReviewId {
				t.Fatal("same native publication replay differs")
			}
		}
		if len(readNative()) != i+1 {
			t.Fatal("native once-only inventory count differs")
		}
		t.Log("qualified decision", decision.String(), "exact old/new same-path batch; historical receipt only")
	}
	var shared int
	if err = s.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2 AND recipient_user_id=0 AND topic='pulls'", s.config.ForgeURL, in.RepositoryID).Scan(&shared); err != nil || shared != 3 {
		t.Fatal("qualified native effects did not produce exactly scoped shared invalidations")
	}
	_ = golfv1connect.RepositoryServicePublishPullRequestReviewDraftProcedure
}
