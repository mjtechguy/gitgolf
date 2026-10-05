package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

// Opt-in supported native proof; the caller owns and purges the supplied fixture.
// Golf sessions/journals live only in the ordinary isolated testDatabase schema.
func TestApiWriteGrantNative(t *testing.T) {
	raw := os.Getenv("GOLF_TEST_API_GRANT_NATIVE")
	if raw == "" {
		t.Skip("requires owned actual native fixture")
	}
	var fixture struct{ NativeURL, Token, Owner, Name, RepositoryID string }
	if json.Unmarshal([]byte(raw), &fixture) != nil || fixture.Token == "" {
		t.Fatal("invalid native fixture")
	}
	db := testDatabase(t)
	s, e := New(testConfig(fixture.NativeURL), db)
	if e != nil {
		t.Fatal("native source setup", e)
	}
	sessions, _, _, httpClient, origin := testRPCClients(t, s)
	login, e := sessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: fixture.Token}))
	if e != nil || login.Msg.User == nil {
		t.Fatal("native source login", connect.CodeOf(e))
	}
	defer sessions.Logout(t.Context(), connect.NewRequest(&golfv1.LogoutRequest{}))
	management := golfv1connect.NewApiCredentialServiceClient(httpClient, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, r)
		}
	})))
	target := &golfv1.RepositoryKey{Owner: fixture.Owner, Name: fixture.Name}
	grant, e := management.CreateApiCredential(t.Context(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "Owned native collaboration bot", WriteScopes: []string{"issues:write"}, WriteRepository: target, WriteRepositoryId: fixture.RepositoryID}))
	if e != nil {
		t.Fatal("native explicit grant", connect.CodeOf(e))
	}
	input := &golfv1.CreateIssueRequest{Repository: target, RepositoryId: fixture.RepositoryID, Title: "Owned scoped native issue", Body: "Actual native delegation proof", IdempotencyKey: discussionKey(801)}
	body, _ := protojson.Marshal(input)
	var issue *golfv1.Issue
	for i := 0; i < 2; i++ {
		response := apiRequest(s, grant.Msg.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(body))
		if response.Code != http.StatusOK {
			t.Fatal("native delegated creation", response.Code)
		}
		var result golfv1.CreateIssueResponse
		if protojson.Unmarshal(response.Body.Bytes(), &result) != nil || result.Mutation.GetState() != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || result.Issue == nil || result.Mutation.GetIdempotencyKey() != input.IdempotencyKey {
			t.Fatal("native creation not independently confirmed")
		}
		issue = result.Issue
	}
	comment := &golfv1.CreateIssueCommentRequest{Repository: target, RepositoryId: fixture.RepositoryID, IssueId: issue.Id, Number: issue.Number, Body: "One journaled native comment", IdempotencyKey: discussionKey(802)}
	body, _ = protojson.Marshal(comment)
	for i := 0; i < 2; i++ {
		r := apiRequest(s, grant.Msg.Token, golfv1connect.RepositoryServiceCreateIssueCommentProcedure, string(body))
		var result golfv1.CreateIssueCommentResponse
		if r.Code != 200 || protojson.Unmarshal(r.Body.Bytes(), &result) != nil || result.Mutation.GetState() != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
			t.Fatal("native comment not confirmed", r.Code)
		}
	}
	if _, e = management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Msg.Credential.Id})); e != nil {
		t.Fatal("native grant revocation")
	}
	comment.IdempotencyKey = discussionKey(803)
	body, _ = protojson.Marshal(comment)
	if r := apiRequest(s, grant.Msg.Token, golfv1connect.RepositoryServiceCreateIssueCommentProcedure, string(body)); r.Code != 401 {
		t.Fatal("native revoked delegation accepted", r.Code)
	}
	t.Log("PASS actual supported native issue/comment writes, original-key replay and delegated revocation; no served deployment claim")
}
