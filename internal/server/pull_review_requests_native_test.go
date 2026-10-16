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

// Same owned native actors/envelope as the writer launcher, but independent
// disposable Golf state. The launcher purges every native repository and actor.
func TestReviewRequestNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_FILE_WRITER_NATIVE_PROOF")
	if name == "" {
		t.Skip("owned native fixture not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private reviewer envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native envelope unavailable")
	}
	defer file.Close()
	var in struct {
		URL, Owner, Writer, OwnerToken, WriterToken, Branch string
		RepositoryID, OwnerID                               int64
	}
	d := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-writer-probe-") || !strings.HasPrefix(in.Writer, "golf-writer-probe-") {
		t.Fatal("invalid native reviewer fixture")
	}
	config := testConfig(in.URL)
	config.ForgePublicURL = in.URL
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("native review server initialization failed")
	}
	owner := forgeCredential{Kind: "pat", Token: in.OwnerToken}
	key := &golfv1.RepositoryKey{Owner: in.Owner, Name: "private"}
	base, _ := repositoryPath(keyFrom(key))
	// Restore the launcher's ordinary writer grant if the file proof already revoked it.
	if _, e = s.forgeJSON(t.Context(), http.MethodPut, base+"/collaborators/"+in.Writer, owner, map[string]string{"permission": "write"}, nil, http.StatusNoContent); e != nil {
		t.Fatal("owned reviewer grant setup failed")
	}
	head, e := s.exactSourceBranch(t.Context(), base, owner, in.Branch)
	if e != nil {
		t.Fatal("owned reviewer branch lookup failed")
	}
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/branches", owner, map[string]string{"new_branch_name": "review-change", "old_ref_name": head}, nil, http.StatusCreated); e != nil {
		t.Fatal("owned reviewer branch setup failed")
	}
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/contents/review-change.txt", owner, map[string]string{"branch": "review-change", "content": base64.StdEncoding.EncodeToString([]byte("Review this exact change\n")), "message": "Owned review fixture"}, nil, http.StatusCreated); e != nil {
		t.Fatal("owned reviewer content setup failed")
	}
	var pull forgePull
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/pulls", owner, map[string]string{"base": in.Branch, "head": "review-change", "title": "Owned requested review fixture"}, &pull, http.StatusCreated); e != nil {
		t.Fatal("owned native PR setup failed")
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Owner, Password: localTestPassword, ForgeToken: in.OwnerToken}); e != nil {
		t.Fatal("review owner enrollment failed")
	}
	session, _, _, transport, origin := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Owner, Password: localTestPassword})); e != nil {
		t.Fatal("review owner login failed")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("review owner logout failed")
		}
	})
	client := golfv1connect.NewPullReviewRequestServiceClient(transport, origin.String()+"/rpc")
	id, pullID := strconv.FormatInt(in.RepositoryID, 10), strconv.FormatInt(pull.ID, 10)
	get := func() *golfv1.GetPullReviewRequestsResponse {
		req := connect.NewRequest(&golfv1.GetPullReviewRequestsRequest{Repository: key, RepositoryId: id, PullRequestId: pullID, Number: uint32(pull.Number)})
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.GetPullReviewRequests(t.Context(), req)
		if e != nil {
			t.Fatal("native requested reviewer read failed")
		}
		return r.Msg
	}
	var reviewer User
	if _, e = s.forge(t.Context(), http.MethodGet, "/users/"+in.Writer, owner, nil, &reviewer); e != nil {
		t.Fatal("native reviewer identity failed")
	}
	submit := func(m *golfv1.SubmitPullReviewRequestRequest) *golfv1.PullReviewRequestOperation {
		req := connect.NewRequest(m)
		req.Header().Set("Origin", s.config.PublicURL)
		r, e := client.SubmitPullReviewRequest(t.Context(), req)
		if e != nil {
			t.Fatal("native review request submission failed")
		}
		return r.Msg.Operation
	}
	snap := get()
	if !snap.CanManage || len(snap.Reviewers) != 0 {
		t.Fatal("native empty request inventory failed")
	}
	m := &golfv1.SubmitPullReviewRequestRequest{Repository: key, RepositoryId: id, PullRequestId: pullID, Number: uint32(pull.Number), ExpectedPullRevision: snap.PullRevision, ExpectedRequestsRevision: snap.RequestsRevision, ReviewerId: strconv.FormatInt(reviewer.ID, 10), ReviewerLogin: reviewer.Login, RequestReview: true, OperationId: uuid.NewString()}
	first := submit(m)
	if first.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
		t.Fatal("native requested reviewer outcome unqualified")
	}
	observed := get()
	if len(observed.Reviewers) != 1 || observed.Reviewers[0].Id != m.ReviewerId || observed.Reviewers[0].Login != m.ReviewerLogin {
		t.Fatal("native reviewer identity readback differs")
	}
	replay := submit(m)
	if !proto.Equal(replay, first) {
		t.Fatal("native original review request replay differs")
	}
	status := connect.NewRequest(&golfv1.GetPullReviewRequestOperationRequest{Repository: key, RepositoryId: id, PullRequestId: pullID, Number: uint32(pull.Number), OperationId: m.OperationId})
	status.Header().Set("Origin", s.config.PublicURL)
	inspected, e := client.GetPullReviewRequestOperation(t.Context(), status)
	if e != nil || !proto.Equal(inspected.Msg.Operation, first) {
		t.Fatal("native original review request inspection differs")
	}
	remove := proto.Clone(m).(*golfv1.SubmitPullReviewRequestRequest)
	remove.OperationId = uuid.NewString()
	remove.RequestReview = false
	remove.ExpectedPullRevision = observed.PullRevision
	remove.ExpectedRequestsRevision = observed.RequestsRevision
	removed := submit(remove)
	if removed.Phase != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED || len(get().Reviewers) != 0 {
		t.Fatal("native reviewer removal differs")
	}
	// Current PR closure removes mutation authority without inventing an eligible approval.
	if _, e = s.forgeJSON(t.Context(), http.MethodPatch, base+"/pulls/"+strconv.FormatInt(pull.Number, 10), owner, map[string]string{"state": "closed"}, nil, http.StatusCreated); e != nil {
		t.Fatal("native closure setup failed")
	}
	if get().CanManage {
		t.Fatal("closed PR exposed reviewer writes")
	}
	t.Log("native requested reviewer add/remove, identity inventory, original inspection/replay and closed-PR refusal pass")
}
