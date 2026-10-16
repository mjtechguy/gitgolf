package server

import (
	"context"
	"encoding/base64"
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
	"google.golang.org/protobuf/proto"
)

func TestReviewInteractionsNativeProof(t *testing.T) {
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
	config.ForgePublicURL = in.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("review server initialization")
	}
	baseTransport := s.client.Transport
	if baseTransport == nil {
		baseTransport = http.DefaultTransport
	}
	s.client.Transport = reviewProofTransport{baseTransport, t}
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
	// Native CODEOWNERS regex and exact immutable base object.
	native("POST", base+"/contents/CODEOWNERS", owner, map[string]string{"branch": in.Branch, "content": base64.StdEncoding.EncodeToString([]byte(".* @" + in.Owner + "\n")), "message": "Owned code owner fixture"}, nil, 201)
	head, e := s.exactSourceBranch(t.Context(), base, owner, in.Branch)
	if e != nil {
		t.Fatal("base identity")
	}
	native("POST", base+"/branches", owner, map[string]string{"new_branch_name": "review-change", "old_ref_name": head}, nil, 201)
	native("POST", base+"/contents/review-change.txt", owner, map[string]string{"branch": "review-change", "content": base64.StdEncoding.EncodeToString([]byte("Review this exact change\n")), "message": "Owned review change"}, nil, 201)
	var pull forgePull
	native("POST", base+"/pulls", owner, map[string]string{"base": in.Branch, "head": "review-change", "title": "Owned review interaction fixture"}, &pull, 201)
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
	requests := func() *golfv1.GetPullReviewRequestsResponse {
		req := connect.NewRequest(&golfv1.GetPullReviewRequestsRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number})
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.GetPullReviewRequests(t.Context(), req)
		if e != nil {
			t.Fatal("native team requests read")
		}
		return r.Msg
	}
	candidatesReq := connect.NewRequest(&golfv1.GetPullReviewTeamCandidatesRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number})
	candidatesReq.Header().Set("Origin", s.config.PublicURL)
	candidates, e := client.GetPullReviewTeamCandidates(t.Context(), candidatesReq)
	if e != nil || len(candidates.Msg.Teams) == 0 {
		t.Fatal("native team candidates unavailable")
	}
	foundTeam := false
	for _, team := range candidates.Msg.Teams {
		if team.Id == strconv.FormatInt(in.TeamID, 10) && team.Name == "reviewers" {
			foundTeam = true
		}
	}
	if !foundTeam {
		t.Fatal("native exact attached team omitted")
	}
	snap := requests()
	teamAlready := false
	for _, team := range snap.Teams {
		if team.Id == strconv.FormatInt(in.TeamID, 10) {
			teamAlready = true
		}
	}
	// Native CODEOWNERS may already request the team during PR creation; remove then add.
	for _, add := range []bool{!teamAlready, teamAlready} {
		snap = requests()
		m := &golfv1.SubmitPullReviewRequestRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ExpectedPullRevision: snap.PullRevision, ExpectedRequestsRevision: snap.RequestsRevision, ReviewerId: strconv.FormatInt(in.TeamID, 10), ReviewerLogin: "reviewers", ReviewerTeam: true, RequestReview: add, OperationId: uuid.NewString()}
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.SubmitPullReviewRequest(t.Context(), req)
		if e != nil || r.Msg.Operation.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			if e != nil {
				t.Fatalf("native team change RPC code %s", connect.CodeOf(e))
			}
			t.Fatalf("native team change phase %d; preflight classification: %v", r.Msg.Operation.Phase, s.reviewTeamPreflight(t.Context(), owner, m, snap))
		}
		again := connect.NewRequest(m)
		again.Header().Set("Origin", s.config.PublicURL)
		replay, e := client.SubmitPullReviewRequest(t.Context(), again)
		if e != nil || !proto.Equal(r.Msg.Operation, replay.Msg.Operation) {
			t.Fatal("native team original replay")
		}
	}
	pull, e = s.readPull(t.Context(), owner, base, Repository{ID: in.RepositoryID, Name: "private", FullName: in.Organization + "/private", HTMLURL: pull.Base.Repository.HTMLURL}, number)
	if e != nil {
		t.Fatal("current PR identity")
	}
	ownersReq := connect.NewRequest(&golfv1.GetPullCodeOwnersRequest{Selection: &golfv1.PullRequestSelection{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, BaseCommitId: pull.Base.SHA, HeadCommitId: pull.Head.SHA}, ExpectedPullRevision: pullRevision(pull)})
	ownersReq.Header().Set("Origin", s.config.PublicURL)
	owners, e := client.GetPullCodeOwners(t.Context(), ownersReq)
	if e != nil || owners.Msg.Path != "CODEOWNERS" || !owners.Msg.RoutingComplete || len(owners.Msg.Matches) != 1 || len(owners.Msg.Matches[0].Owners) != 1 || owners.Msg.Matches[0].Owners[0] != "@"+in.Owner {
		t.Fatal("native exact base CODEOWNERS routing unqualified")
	}
	var review forgePullReview
	native("POST", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews", reviewer, map[string]any{"event": "COMMENT", "commit_id": pull.Head.SHA, "comments": []map[string]any{{"path": "review-change.txt", "body": "Original inline finding", "new_position": 1}}}, &review, 200)
	var rows []forgePullReviewComment
	if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews/"+strconv.FormatInt(review.ID, 10)+"/comments", owner, nil, &rows); e != nil || len(rows) != 1 {
		t.Fatal("native published parent")
	}
	parent := rows[0]
	selection := &golfv1.GetPullReviewCommentStateRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ReviewId: strconv.FormatInt(review.ID, 10), ReviewCommitId: review.CommitID, CommentId: strconv.FormatInt(parent.ID, 10)}
	get := func() *golfv1.GetPullReviewCommentStateResponse {
		req := connect.NewRequest(selection)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.GetPullReviewCommentState(t.Context(), req)
		if e != nil {
			t.Fatal("native visible parent")
		}
		return r.Msg
	}
	submit := func(m *golfv1.SubmitPullReviewCommentInteractionRequest) *golfv1.PullReviewCommentOperation {
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.SubmitPullReviewCommentInteraction(t.Context(), req)
		if e != nil {
			t.Fatal("native interaction submission")
		}
		return r.Msg.Operation
	}
	original := func(resolve bool) *golfv1.SubmitPullReviewCommentInteractionRequest {
		state := get()
		return &golfv1.SubmitPullReviewCommentInteractionRequest{Repository: key, RepositoryId: id, PullRequestId: pid, Number: number, ReviewId: selection.ReviewId, ReviewCommitId: selection.ReviewCommitId, CommentId: selection.CommentId, ExpectedPullRevision: state.PullRevision, ExpectedCommentRevision: state.CommentRevision, Resolve: resolve, OperationId: uuid.NewString()}
	}
	for _, resolve := range []bool{true, false} {
		m := original(resolve)
		r := submit(m)
		if r.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || get().Comment.Resolved != resolve {
			t.Fatal("native resolution/reopen unqualified")
		}
		if !proto.Equal(r, submit(m)) {
			t.Fatal("native resolution replay")
		}
	}
	reply := original(false)
	reply.ReplyBody = "Owned reply with exact visible parent"
	reply.ReplyBodyHash = replyBodyHash(reply.ReplyBody)
	receipt := submit(reply)
	if receipt.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || receipt.ReplyId == "" || receipt.Original.ReplyBody != "" || receipt.Original.ReplyBodyHash != reply.ReplyBodyHash {
		t.Fatal("native reply receipt unqualified")
	}
	if !proto.Equal(receipt, submit(reply)) {
		t.Fatal("native reply replay")
	}
	var stored []byte
	if e = s.db.QueryRow(`SELECT original FROM golf_pull_review_comment_operations WHERE operation_id=$1`, reply.OperationId).Scan(&stored); e != nil || strings.Contains(string(stored), reply.ReplyBody) {
		t.Fatal("private reply body retained in journal")
	}
	// Native route accepts known hidden pending parent; Golf must refuse it first.
	var pending forgePullReview
	native("POST", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews", reviewer, map[string]any{"event": "PENDING", "body": "Owned hidden pending review", "commit_id": pull.Head.SHA, "comments": []map[string]any{{"path": "review-change.txt", "body": "Hidden pending finding", "new_position": 1}}}, &pending, 200)
	var hidden []forgePullReviewComment
	if _, e = s.forge(t.Context(), "GET", base+"/pulls/"+strconv.Itoa(int(number))+"/reviews/"+strconv.FormatInt(pending.ID, 10)+"/comments", reviewer, nil, &hidden); e != nil || len(hidden) != 1 {
		t.Fatal("hidden pending setup")
	}
	bad := proto.Clone(reply).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	bad.ReviewId = strconv.FormatInt(pending.ID, 10)
	bad.ReviewCommitId = pending.CommitID
	bad.CommentId = strconv.FormatInt(hidden[0].ID, 10)
	bad.OperationId = uuid.NewString()
	req := connect.NewRequest(bad)
	req.Header().Set("Origin", s.config.PublicURL)
	if _, e = client.SubmitPullReviewCommentInteraction(t.Context(), req); e == nil {
		t.Fatal("hidden pending reply accepted")
	}
	t.Log("actual native team request/replay, CODEOWNERS base routing, published resolve/reopen/reply, body-free journal and hidden-pending refusal pass")
}

type reviewProofTransport struct {
	base http.RoundTripper
	t    *testing.T
}

func (r reviewProofTransport) RoundTrip(q *http.Request) (*http.Response, error) {
	res, e := r.base.RoundTrip(q)
	if strings.HasSuffix(q.URL.Path, "/requested_reviewers") && q.Method != "GET" {
		if e != nil {
			r.t.Log("native requested-review transport unavailable")
		} else {
			r.t.Logf("native requested-review %s status %d", q.Method, res.StatusCode)
		}
	}
	return res, e
}
