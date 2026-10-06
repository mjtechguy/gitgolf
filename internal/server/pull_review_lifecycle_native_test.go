package server

import (
	"context"
	"encoding/base64"
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

func TestReviewLifecycleNativeProof(t *testing.T) {
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
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-review077-") || !strings.HasPrefix(in.Organization, "golf-review077-") {
		t.Fatal("invalid owned review fixture")
	}
	config := testConfig(in.URL)
	config.GiteaPublicURL = in.URL
	config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("review server initialization")
	}
	owner, reviewer := forgeCredential{Kind: "pat", Token: in.OwnerToken}, forgeCredential{Kind: "pat", Token: in.ReviewerToken}
	key := &golfv1.RepositoryKey{Owner: in.Organization, Name: "private"}
	base, _ := repositoryPath(keyFrom(key))
	id := strconv.FormatInt(in.RepositoryID, 10)
	native := func(method, path string, token forgeCredential, input, output any, status int) {
		t.Helper()
		if _, e := s.forgeJSON(t.Context(), method, path, token, input, output, status); e != nil {
			t.Fatalf("owned native setup %s %s failed (%v)", method, path, e)
		}
	}
	head, e := s.exactSourceBranch(t.Context(), base, owner, in.Branch)
	if e != nil {
		t.Fatal("base identity")
	}
	native("POST", base+"/branches", owner, map[string]string{"new_branch_name": "review-lifecycle", "old_ref_name": head}, nil, 201)
	native("POST", base+"/contents/review-change.txt", owner, map[string]string{"branch": "review-lifecycle", "content": base64.StdEncoding.EncodeToString([]byte("Review this exact change\n")), "message": "Owned review change"}, nil, 201)
	var pull forgePull
	native("POST", base+"/pulls", owner, map[string]string{"base": in.Branch, "head": "review-lifecycle", "title": "Owned review lifecycle fixture"}, &pull, 201)
	pid := strconv.FormatInt(pull.ID, 10)
	number := uint32(pull.Number)
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Owner, Password: localTestPassword, ForgeToken: in.OwnerToken}); e != nil {
		t.Fatal("owner enrollment")
	}
	session, _, _, transport, origin := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Owner, Password: localTestPassword})); e != nil {
		t.Fatal("owner login")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("owner logout")
		}
	})
	client := golfv1connect.NewPullReviewRequestServiceClient(transport, origin.String()+"/rpc")
	var prior forgePullReview
	native("POST", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews", reviewer, map[string]any{"event": "APPROVED", "body": "Owned prior approval", "commit_id": pull.Head.SHA, "comments": []any{}}, &prior, 200)
	var review forgePullReview
	native("POST", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews", reviewer, map[string]any{"event": "APPROVED", "body": "Owned exact-head approval", "commit_id": pull.Head.SHA, "comments": []any{}}, &review, 200)
	var priorBaseline forgePullReview
	if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews/"+strconv.FormatInt(prior.ID, 10), owner, nil, &priorBaseline); e != nil {
		t.Fatal("prior review baseline unavailable")
	}
	if prior.ID == review.ID {
		t.Fatal("native did not retain separate review history")
	}
	selection := &golfv1.GetPullReviewLifecycleStateRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ReviewId: strconv.FormatInt(review.ID, 10), ReviewCommitId: review.CommitID}
	get := func() *golfv1.GetPullReviewLifecycleStateResponse {
		req := connect.NewRequest(selection)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.GetPullReviewLifecycleState(t.Context(), req)
		if e != nil {
			t.Fatal("native visible review lifecycle state")
		}
		return r.Msg
	}
	submit := func(m *golfv1.SubmitPullReviewLifecycleRequest) *golfv1.PullReviewLifecycleOperation {
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.SubmitPullReviewLifecycle(t.Context(), req)
		if e != nil {
			t.Fatal("native review lifecycle submission")
		}
		return r.Msg.Operation
	}
	original := func(dismiss bool) *golfv1.SubmitPullReviewLifecycleRequest {
		snap := get()
		m := &golfv1.SubmitPullReviewLifecycleRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ReviewId: selection.ReviewId, ReviewCommitId: selection.ReviewCommitId, ExpectedPullRevision: snap.PullRevision, ExpectedReviewRevision: snap.ReviewRevision, Dismiss: dismiss, OperationId: uuid.NewString()}
		if dismiss {
			m.Reason = "Owned single-review dismissal"
			m.ReasonHash = replyBodyHash(m.Reason)
		}
		return m
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Reviewer, Password: localTestPassword, ForgeToken: in.ReviewerToken}); e != nil {
		t.Fatal("reviewer enrollment")
	}
	otherSession, _, _, otherTransport, otherOrigin := testRPCClients(t, s)
	if _, e = otherSession.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Reviewer, Password: localTestPassword})); e != nil {
		t.Fatal("reviewer login")
	}
	t.Cleanup(func() {
		if _, e := otherSession.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("reviewer logout")
		}
	})
	otherClient := golfv1connect.NewPullReviewRequestServiceClient(otherTransport, otherOrigin.String()+"/rpc")
	readOther := connect.NewRequest(selection)
	readOther.Header().Set("Origin", s.config.PublicURL)
	otherState, e := otherClient.GetPullReviewLifecycleState(t.Context(), readOther)
	if e != nil || otherState.Msg.CanManage {
		if e != nil {
			t.Fatalf("ordinary reviewer lifecycle read code %s", connect.CodeOf(e))
		}
		t.Fatal("ordinary reviewer acquired admin lifecycle authority")
	}
	deniedIntent := connect.NewRequest(original(true))
	deniedIntent.Header().Set("Origin", s.config.PublicURL)
	if _, e = otherClient.SubmitPullReviewLifecycle(t.Context(), deniedIntent); e == nil {
		t.Fatal("ordinary writer dismissed review")
	}
	for _, dismiss := range []bool{true, false, true} {
		m := original(dismiss)
		r := submit(m)
		if r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || get().Review.Dismissed != dismiss || r.Original.Reason != "" {
			t.Fatal("native dismissal/restoration unqualified")
		}
		var priorAfter forgePullReview
		if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews/"+strconv.FormatInt(prior.ID, 10), owner, nil, &priorAfter); e != nil || priorAfter.Dismissed != priorBaseline.Dismissed || priorAfter.State != priorBaseline.State || priorAfter.Body != priorBaseline.Body || priorAfter.CommitID != priorBaseline.CommitID {
			t.Fatal("single review mutation changed prior approval")
		}
		if !proto.Equal(r, submit(m)) {
			t.Fatal("native lifecycle original replay")
		}
		var raw []byte
		if e = s.db.QueryRow(`SELECT original FROM golf_pull_review_lifecycle_operations WHERE operation_id=$1`, m.OperationId).Scan(&raw); e != nil || m.Reason != "" && strings.Contains(string(raw), m.Reason) {
			t.Fatal("dismissal reason persisted")
		}
	}
	// Publish another source commit through the native API. Earlier approval cannot restore.
	native("POST", base+"/contents/next-change.txt", owner, map[string]string{"branch": "review-lifecycle", "content": base64.StdEncoding.EncodeToString([]byte("A newer source head\n")), "message": "Owned head advance"}, nil, 201)
	sourceHead, e := s.exactSourceBranch(t.Context(), base, owner, "review-lifecycle")
	if e != nil || sourceHead == review.CommitID {
		t.Fatal("owned source head did not advance")
	}
	stale := get()
	deadline := time.Now().Add(20 * time.Second)
	for stale.CurrentHeadCommitId != sourceHead && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		stale = get()
	}
	if stale.CurrentHeadCommitId == review.CommitID || stale.CanRestore {
		t.Fatal("older review advertised restorable")
	}
	bad := original(false)
	refusal := submit(bad)
	if refusal.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED || !get().Review.Dismissed {
		t.Fatal("older approval restoration accepted")
	}
	// Existing072 requested-review contract can request the same published reviewer again.
	requestsReq := connect.NewRequest(&golfv1.GetPullReviewRequestsRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number})
	requestsReq.Header().Set("Origin", s.config.PublicURL)
	requests, e := client.GetPullReviewRequests(t.Context(), requestsReq)
	if e != nil {
		t.Fatal("native re-request inventory")
	}
	var reviewerUser User
	if _, e = s.forge(t.Context(), "GET", "/users/"+in.Reviewer, owner, nil, &reviewerUser); e != nil {
		t.Fatal("native reviewer identity")
	}
	requestReview := connect.NewRequest(&golfv1.SubmitPullReviewRequestRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ExpectedPullRevision: requests.Msg.PullRevision, ExpectedRequestsRevision: requests.Msg.RequestsRevision, ReviewerId: strconv.FormatInt(reviewerUser.ID, 10), ReviewerLogin: reviewerUser.Login, RequestReview: true, OperationId: uuid.NewString()})
	requestReview.Header().Set("Origin", s.config.PublicURL)
	requested, e := client.SubmitPullReviewRequest(t.Context(), requestReview)
	if e != nil || requested.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
		if e != nil {
			t.Fatalf("native published reviewer re-request RPC code %s", connect.CodeOf(e))
		}
		t.Fatalf("native published reviewer re-request phase %d", requested.Msg.Operation.Phase)
	}
	t.Log("actual native single-review dismissal/restoration/replay, body-free reason journal, stale restoration refusal and published reviewer re-request pass")
}
