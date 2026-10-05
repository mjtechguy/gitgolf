package server

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestApiWriteGrantJournalAndRevocationPostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	_, source := f.client(t, "alice")
	management := apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, source)
	read := issueApiCredential(t, management, "reader", 3600)
	create := &golfv1.CreateApiCredentialRequest{Label: "issue bot", WriteScopes: []string{"issues:write"}, WriteRepository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WriteRepositoryId: "10"}
	issued, e := management.CreateApiCredential(t.Context(), connect.NewRequest(create))
	if e != nil {
		t.Fatal(e)
	}
	grant := issued.Msg
	if !strings.HasPrefix(grant.Token, apiWriteTokenPrefix) || grant.Credential.WriteRepositoryId != "10" || len(grant.Credential.WriteScopes) != 1 {
		t.Fatal("missing immutable explicit grant")
	}
	listed, e := management.ListApiCredentials(t.Context(), connect.NewRequest(&golfv1.ListApiCredentialsRequest{}))
	if e != nil || listed.Msg.Credentials[0].WriteRepositoryId != "10" {
		t.Fatal("grant metadata not visible", e)
	}
	if _, e = f.db.Exec("UPDATE golf_api_write_grants SET repository_id=99"); e == nil {
		t.Fatal("grant retargetable")
	}
	if _, e = f.db.Exec("DELETE FROM golf_api_write_grants"); e == nil {
		t.Fatal("grant deletable")
	}
	input := issueCreateInput(discussionKey(701))
	raw, _ := protojson.Marshal(input)
	if r := apiRequest(f.s, read.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(raw)); r.Code != 403 {
		t.Fatal("legacy token gained writes", r.Code)
	}
	for i := 0; i < 2; i++ {
		r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(raw))
		if r.Code != 200 {
			t.Fatal("delegated creation failed", r.Code, r.Body.String())
		}
		var result golfv1.CreateIssueResponse
		if e = protojson.Unmarshal(r.Body.Bytes(), &result); e != nil || result.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
			t.Fatal("missing verified journal", e)
		}
	}
	if f.posts.Load() != 1 {
		t.Fatal("original operation resent")
	}
	input.RepositoryId = "11"
	input.IdempotencyKey = discussionKey(702)
	raw, _ = protojson.Marshal(input)
	if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(raw)); r.Code != 403 || f.posts.Load() != 1 {
		t.Fatal("cross-repository grant", r.Code)
	}
	input.RepositoryId = "10"
	input.Repository.Name = "other"
	raw, _ = protojson.Marshal(input)
	if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(raw)); r.Code != 403 {
		t.Fatal("cross-slug grant", r.Code)
	}
	comment := commentCreateInput(discussionKey(703))
	comment.PullRequest = true
	raw, _ = protojson.Marshal(comment)
	if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreateIssueCommentProcedure, string(raw)); r.Code != 403 {
		t.Fatal("issue grant gained pull unit", r.Code)
	}
	if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreatePullRequestProcedure, "{malformed"); r.Code != 403 {
		t.Fatal("wrong scope decoded", r.Code)
	}
	if _, e = management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Credential.Id})); e != nil {
		t.Fatal(e)
	}
	input = issueCreateInput(discussionKey(704))
	raw, _ = protojson.Marshal(input)
	if r := apiRequest(f.s, grant.Token, golfv1connect.RepositoryServiceCreateIssueProcedure, string(raw)); r.Code != 401 || f.posts.Load() != 1 {
		t.Fatal("revoked grant accepted", r.Code)
	}
}

func TestApiWriteGrantValidationPostgres(t *testing.T) {
	f := newDiscussionFixture(t)
	_, source := f.client(t, "alice")
	management := apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, source)
	base := &golfv1.CreateApiCredentialRequest{Label: "writer", WriteScopes: []string{"issues:write"}, WriteRepository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WriteRepositoryId: "10"}
	for _, modify := range []func(*golfv1.CreateApiCredentialRequest){
		func(r *golfv1.CreateApiCredentialRequest) { r.WriteScopes = []string{"admin:write"} },
		func(r *golfv1.CreateApiCredentialRequest) { r.WriteScopes = []string{"issues:write", "issues:write"} },
		func(r *golfv1.CreateApiCredentialRequest) { r.WriteRepository = nil },
		func(r *golfv1.CreateApiCredentialRequest) { r.WriteRepositoryId = "11" },
		func(r *golfv1.CreateApiCredentialRequest) { r.WriteScopes = nil },
	} {
		r := proto.Clone(base).(*golfv1.CreateApiCredentialRequest)
		modify(r)
		if _, e := management.CreateApiCredential(t.Context(), connect.NewRequest(r)); e == nil {
			t.Fatal("invalid delegation accepted")
		}
	}
	var n int
	if e := f.db.QueryRow("SELECT count(*) FROM golf_api_credentials").Scan(&n); e != nil || n != 0 {
		t.Fatal("invalid grants created credentials", n, e)
	}
}
