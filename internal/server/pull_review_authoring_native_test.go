package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func TestReviewAuthoringNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_REVIEW_INTERACTIONS_NATIVE_PROOF")
	if name == "" {
		t.Skip("owned native fixture not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private review envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native envelope unavailable")
	}
	defer file.Close()
	var in struct {
		URL, Owner, Reviewer, OwnerToken, ReviewerToken, Organization, Branch string
		RepositoryID, TeamID                                                  int64
	}
	d := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-review084-") || !strings.HasPrefix(in.Organization, "golf-review084-") {
		t.Fatal("invalid owned review fixture")
	}
	config := testConfig(in.URL)
	config.GiteaPublicURL = in.URL
	config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("review server initialization")
	}
	owner := forgeCredential{Kind: "pat", Token: in.OwnerToken}
	key := &golfv1.RepositoryKey{Owner: in.Organization, Name: "private"}
	base, _ := repositoryPath(keyFrom(key))
	native := func(method, path string, input, output any, status int) {
		t.Helper()
		if _, e := s.forgeJSON(t.Context(), method, path, owner, input, output, status); e != nil {
			t.Fatalf("Owned fixture setup %s failed (%v)", method, e)
		}
	}
	head, e := s.exactSourceBranch(t.Context(), base, owner, in.Branch)
	if e != nil {
		t.Fatal("base identity")
	}
	native("POST", base+"/branches", map[string]string{"new_branch_name": "review-authoring", "old_ref_name": head}, nil, 201)
	native("POST", base+"/contents/review-authoring.txt", map[string]string{"branch": "review-authoring", "content": base64.StdEncoding.EncodeToString([]byte("Review this exact change\n")), "message": "Owned authoring change"}, nil, 201)
	var pull forgePull
	native("POST", base+"/pulls", map[string]string{"base": in.Branch, "head": "review-authoring", "title": "Owned review authoring fixture"}, &pull, 201)
	target := &golfv1.PullReviewDraftTarget{Repository: key, RepositoryId: strconv.FormatInt(in.RepositoryID, 10), PullRequestId: strconv.FormatInt(pull.ID, 10), Number: uint32(pull.Number)}
	for _, actor := range []struct{ name, token string }{{in.Owner, in.OwnerToken}, {in.Reviewer, in.ReviewerToken}} {
		if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: actor.name, Password: localTestPassword, ForgeToken: actor.token}); e != nil {
			t.Fatal("ordinary local enrollment")
		}
	}
	session, repos, _, transport, origin := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Reviewer, Password: localTestPassword})); e != nil {
		t.Fatal("reviewer login")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("reviewer logout")
		}
	})
	client := golfv1connect.NewPullReviewAuthoringServiceClient(transport, origin.String()+"/rpc")
	selection := &golfv1.GetPullReviewAuthoringStateRequest{Target: target}
	stable := func() *golfv1.GetPullReviewAuthoringStateResponse {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		var settled time.Time
		var previous *golfv1.GetPullReviewAuthoringStateResponse
		for time.Now().Before(deadline) {
			req := connect.NewRequest(selection)
			req.Header().Set("Origin", s.config.PublicURL)
			r, e := client.GetPullReviewAuthoringState(t.Context(), req)
			if e != nil {
				if connect.CodeOf(e) != connect.CodeFailedPrecondition {
					t.Fatalf("Native state %s (%s)", connect.CodeOf(e), e.Error())
				}
				previous = nil
				settled = time.Time{}
			} else {
				if previous != nil && r.Msg.PullRevision == previous.PullRevision && r.Msg.SnapshotRevision == previous.SnapshotRevision {
					if !settled.IsZero() && time.Since(settled) >= time.Second {
						return r.Msg
					}
				} else {
					settled = time.Now()
				}
				previous = r.Msg
			}
			time.Sleep(150 * time.Millisecond)
		}
		t.Fatal("Native observations did not settle")
		return nil
	}
	proposal := func(kind golfv1.PullReviewAuthoringKind, body string) *golfv1.SubmitPullReviewAuthoringOperationRequest {
		t.Helper()
		snap := stable()
		m := &golfv1.SubmitPullReviewAuthoringOperationRequest{Target: target, Kind: kind, ReviewId: selection.ReviewId, ReviewCommitId: selection.ReviewCommitId, CommentId: selection.CommentId, ExpectedPullRevision: snap.PullRevision, ExpectedSnapshotRevision: snap.SnapshotRevision, OperationId: uuid.NewString(), Body: body}
		if kind == authorCreate || kind == authorUpdate || kind == authorSubmit || kind == authorEdit {
			m.BodyHash = replyBodyHash(body)
		}
		return m
	}
	submit := func(m *golfv1.SubmitPullReviewAuthoringOperationRequest) *golfv1.PullReviewAuthoringOperation {
		t.Helper()
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.SubmitPullReviewAuthoringOperation(t.Context(), req)
		if e != nil {
			var phase string
			_ = s.db.QueryRow(`SELECT phase FROM golf_pull_review_authoring_operations WHERE operation_id=$1`, m.OperationId).Scan(&phase)
			t.Fatalf("Native operation %s %s phase=%s (%s)", m.Kind, connect.CodeOf(e), phase, e.Error())
		}
		if r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			t.Fatalf("Native %s phase %s", m.Kind, r.Msg.Operation.Phase)
		}
		replay := connect.NewRequest(reviewAuthoringRetained(m))
		replay.Header().Set("Origin", s.config.PublicURL)
		again, e := client.SubmitPullReviewAuthoringOperation(t.Context(), replay)
		if e != nil || !proto.Equal(r.Msg.Operation, again.Msg.Operation) {
			t.Fatalf("Native original replay %s", m.Kind)
		}
		return r.Msg.Operation
	}
	selectOwn := func() {
		snap := stable()
		if snap.Review == nil || !snap.OwnPending {
			t.Fatal("Own pending unavailable")
		}
		selection.ReviewId = snap.Review.Id
		selection.ReviewCommitId = snap.Review.CommitId
	}
	submit(proposal(authorCreate, "Owned pending summary"))
	selectOwn()
	submit(proposal(authorUpdate, "Owned edited pending summary"))
	submit(proposal(authorDiscard, ""))
	selection.ReviewId = ""
	selection.ReviewCommitId = ""
	emptyPending := proposal(authorCreate, "")
	emptyRequest := connect.NewRequest(emptyPending)
	emptyRequest.Header().Set("Origin", s.config.PublicURL)
	if _, e = client.SubmitPullReviewAuthoringOperation(t.Context(), emptyRequest); connect.CodeOf(e) != connect.CodeInvalidArgument {
		t.Fatalf("Unsupported empty pending shape was not withheld (%s)", connect.CodeOf(e))
	}
	if stable().Review != nil {
		t.Fatal("Empty pending refusal dispatched or adopted a native draft")
	}
	// Save the real bounded comparison once, then transfer the exact immutable encrypted version.
	snap := stable()
	var nativePull forgePull
	if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.Itoa(int(target.Number)), owner, nil, &nativePull); e != nil {
		t.Fatal("Pull capture")
	}
	raw, e := s.readCommitDiff(t.Context(), base+"/pulls/"+strconv.Itoa(int(target.Number))+".diff", owner)
	if e != nil {
		t.Fatal("Diff capture")
	}
	hash := sha256.Sum256([]byte(raw))
	save := &golfv1.SavePullRequestReviewDraftRequest{Target: target, DraftId: uuid.NewString(), OperationId: uuid.NewString(), ExpectedVersion: "0", ExpectedTargetGeneration: "0", Summary: "Owned saved inline review", Entries: []*golfv1.PullReviewDraftEntry{{Id: uuid.NewString(), Coordinate: &golfv1.PullReviewDraftCoordinate{Path: "review-authoring.txt", Line: 1, Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW}, Body: "Owned saved inline finding"}}, Comparison: &golfv1.SavePullRequestReviewDraftRequest_Capture{Capture: &golfv1.PullReviewDraftCapture{Selection: &golfv1.PullRequestSelection{Repository: key, RepositoryId: target.RepositoryId, PullRequestId: target.PullRequestId, Number: target.Number, BaseCommitId: nativePull.Base.SHA, HeadCommitId: nativePull.Head.SHA}, ExpectedPullRevision: snap.PullRevision, MergeBaseCommitId: nativePull.MergeBase, DiffSha256: hex.EncodeToString(hash[:])}}}
	saved, e := repos.SavePullRequestReviewDraft(t.Context(), connect.NewRequest(save))
	if e != nil {
		t.Fatalf("Encrypted private capture %s", connect.CodeOf(e))
	}
	transfer := proposal(authorPrivate, "")
	transfer.GolfDraftId = saved.Msg.Draft.Id
	transfer.ExpectedDraftVersion = saved.Msg.CurrentVersion
	transfer.ExpectedTargetGeneration = saved.Msg.TargetGeneration
	submit(transfer)
	selectOwn()
	pending := stable()
	if len(pending.Comments) != 1 || !pending.CanSubmit {
		t.Fatal("Native inline pending context unavailable")
	}
	selection.CommentId = pending.Comments[0].Id
	// Native owner knowledge of a private pending ID must not grant Golf visibility.
	otherSession, ownerRepos, _, otherTransport, otherOrigin := testRPCClients(t, s)
	if _, e = otherSession.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Owner, Password: localTestPassword})); e != nil {
		t.Fatal("owner login")
	}
	t.Cleanup(func() {
		_, e := otherSession.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{}))
		if e != nil {
			t.Error("owner logout")
		}
	})
	other := golfv1connect.NewPullReviewAuthoringServiceClient(otherTransport, otherOrigin.String()+"/rpc")
	private := connect.NewRequest(selection)
	private.Header().Set("Origin", s.config.PublicURL)
	if _, e = other.GetPullReviewAuthoringState(t.Context(), private); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatalf("Hidden pending was readable (%s)", connect.CodeOf(e))
	}
	submit(proposal(authorEdit, "Owned edited pending finding"))
	selection.CommentId = ""
	publication := proposal(authorSubmit, "Owned exact pending publication")
	publication.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT
	submit(publication)
	published := stable()
	if published.OwnPending || published.Review.State != golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT {
		t.Fatal("Pending did not publish")
	}
	selection.CommentId = published.Comments[0].Id
	submit(proposal(authorEdit, "Owned edited published finding"))
	submit(proposal(authorDelete, ""))
	selection.CommentId = ""
	if len(stable().Comments) != 0 {
		t.Fatal("Deleted native inline still visible")
	}
	unchanged, e := repos.GetPullRequestReviewDraft(t.Context(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: target, DraftId: saved.Msg.Draft.Id}))
	if e != nil || unchanged.Msg.CurrentVersion != saved.Msg.CurrentVersion || unchanged.Msg.Draft == nil || unchanged.Msg.Draft.Entries[0].Body != "Owned saved inline finding" {
		t.Fatal("Native transfer consumed or mutated private draft")
	}
	for _, decision := range []golfv1.PullRequestReviewState{golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED, golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES} {
		selection.ReviewId = ""
		selection.ReviewCommitId = ""
		submit(proposal(authorCreate, "Owned pending decision"))
		selectOwn()
		m := proposal(authorSubmit, "Owned final decision")
		m.Decision = decision
		if decision == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED {
			m.Body = ""
			m.BodyHash = replyBodyHash("")
		}
		submit(m)
	}
	// A PR author may prepare native pending inline comments and publish COMMENT,
	// while Golf still refuses approval/change-request self-review.
	client = other
	repos = ownerRepos
	selection.ReviewId = ""
	selection.ReviewCommitId = ""
	selection.CommentId = ""
	ownerCapture := stable()
	ownerSave := proto.Clone(save).(*golfv1.SavePullRequestReviewDraftRequest)
	ownerSave.DraftId = uuid.NewString()
	ownerSave.OperationId = uuid.NewString()
	ownerSave.GetCapture().ExpectedPullRevision = ownerCapture.PullRevision
	ownedDraft, e := repos.SavePullRequestReviewDraft(t.Context(), connect.NewRequest(ownerSave))
	if e != nil {
		t.Fatalf("Owned PR private capture %s", connect.CodeOf(e))
	}
	ownedTransfer := proposal(authorPrivate, "")
	ownedTransfer.GolfDraftId = ownedDraft.Msg.Draft.Id
	ownedTransfer.ExpectedDraftVersion = ownedDraft.Msg.CurrentVersion
	ownedTransfer.ExpectedTargetGeneration = ownedDraft.Msg.TargetGeneration
	submit(ownedTransfer)
	selectOwn()
	ownComment := proposal(authorSubmit, "PR author inline comment")
	ownComment.Decision = golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT
	submit(ownComment)

}
