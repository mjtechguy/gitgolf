package server

import (
	"context"
	"encoding/json"
	"errors"
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

// The launcher owns disposable native actors and repositories. No live Golf
// state is changed; production RPC handlers use an isolated PostgreSQL schema.
func TestFileWriterNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_FILE_WRITER_NATIVE_PROOF")
	if name == "" {
		t.Skip("native fixture envelope not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private native envelope required")
	}
	f, e := os.Open(name)
	if e != nil {
		t.Fatal("native envelope unavailable")
	}
	defer f.Close()
	var in struct {
		URL, Owner, Writer, OwnerToken, WriterToken, Branch string
		RepositoryID, OwnerID                               int64
	}
	d := json.NewDecoder(io.LimitReader(f, 64<<10+1))
	d.DisallowUnknownFields()
	var extra any
	if d.Decode(&in) != nil || d.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Owner, "golf-writer-probe-") || !strings.HasPrefix(in.Writer, "golf-writer-probe-") || in.RepositoryID <= 0 || in.OwnerID <= 0 {
		t.Fatal("invalid native fixture")
	}
	config := testConfig(in.URL)
	config.GiteaPublicURL = in.URL
	config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = "fixture-client", "fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("native writer server initialization failed")
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Writer, Password: localTestPassword, ForgeToken: in.WriterToken}); e != nil {
		t.Fatal("native writer enrollment failed")
	}
	session, _, _, transport, origin := testRPCClients(t, s)
	s.config.PublicURL = origin.String()
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Writer, Password: localTestPassword})); e != nil {
		t.Fatal("native writer login failed")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("native writer logout failed")
		}
	})
	client := golfv1connect.NewRepositoryFileMutationServiceClient(transport, origin.String()+"/rpc")
	accessClient := golfv1connect.NewRepositoryAccessServiceClient(transport, origin.String()+"/rpc")
	key := &golfv1.RepositoryKey{Owner: in.Owner, Name: "private"}
	id, ownerID := strconv.FormatInt(in.RepositoryID, 10), strconv.FormatInt(in.OwnerID, 10)
	req := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key})
	req.Header().Set("Origin", s.config.PublicURL)
	access, e := accessClient.GetRepositoryAccess(t.Context(), req)
	if e != nil || access.Msg.Access.CanManage || access.Msg.Access.CurrentPermission != "write" {
		t.Fatal("native ordinary writer access unavailable")
	}
	base, _ := repositoryPath(keyFrom(key))
	writer := forgeCredential{Kind: "pat", Token: in.WriterToken}
	owner := forgeCredential{Kind: "pat", Token: in.OwnerToken}
	// Prove this actor cannot enumerate protection administration: no owner credential
	// is borrowed by the production file operation.
	_, e = s.forge(t.Context(), http.MethodGet, base+"/branch_protections", writer, nil, nil)
	var forbidden forgeError
	if !errors.As(e, &forbidden) || forbidden.status != http.StatusForbidden {
		t.Fatal("writer protection administration characterization failed")
	}
	observe := func() *golfv1.GetRepositoryFileMutationAccessResponse {
		r := connect.NewRequest(&golfv1.GetRepositoryFileMutationAccessRequest{Repository: key, RepositoryId: id, OwnerId: ownerID, AccessRevision: access.Msg.Access.Revision, Branch: in.Branch})
		r.Header().Set("Origin", s.config.PublicURL)
		v, e := client.GetRepositoryFileMutationAccess(t.Context(), r)
		if e != nil {
			t.Fatal("native writer branch observation failed")
		}
		return v.Msg
	}
	before := observe()
	if !before.CanWrite || before.Protected {
		t.Fatal("ordinary writer unprotected branch was unavailable")
	}
	data := []byte("Ordinary contributor source change\n")
	m := &golfv1.SubmitRepositoryFileMutationRequest{Repository: key, RepositoryId: id, OwnerId: ownerID, AccessRevision: access.Msg.Access.Revision, OperationId: uuid.NewString(), Kind: golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE, Branch: in.Branch, ExpectedCommitId: before.CommitId, Path: "writer-雪.txt", Content: data, CommitMessage: "Contributor source change"}
	submit := func(m *golfv1.SubmitRepositoryFileMutationRequest) *golfv1.RepositoryFileMutationOperation {
		r := connect.NewRequest(m)
		r.Header().Set("Origin", s.config.PublicURL)
		v, e := client.SubmitRepositoryFileMutation(t.Context(), r)
		if e != nil {
			t.Fatal("native writer submission failed")
		}
		return v.Msg.Operation
	}
	management := golfv1connect.NewApiCredentialServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, req)
		}
	})))
	grant, e := management.CreateApiCredential(t.Context(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "Native contributor machine proof", WriteScopes: []string{"source:write"}, WriteRepository: key, WriteRepositoryId: id}))
	if e != nil {
		t.Fatal("native contributor source delegation")
	}
	var result golfv1.SubmitRepositoryFileMutationResponse
	nativeMachineCLI(t, origin.String(), grant.Msg.Token, []string{"source", "file"}, m, &result)
	first := result.Operation
	if first == nil {
		t.Fatal("native delegated original receipt")
	}
	nativeMachineMCP(t, origin.String(), grant.Msg.Token, "golf_source_file", m, "REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED")
	if first.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_SUCCEEDED || first.ActorId == ownerID || first.BlobId != sourceBlobHash(data, 40) || observe().CommitId != first.CommitId {
		t.Fatal("native contributor effect not verified")
	}
	branch, e := s.readMergeBranch(t.Context(), owner, base, in.Branch)
	if e != nil || branch.Commit.ID != first.CommitId {
		t.Fatal("native owner readback failed")
	}
	entry, _, e := s.sourceObjectAtPath(t.Context(), base, owner, first.CommitId, m.Path)
	if e != nil || entry.SHA != first.BlobId {
		t.Fatal("native exact object readback failed")
	}
	bytes, e := s.sourceBlob(t.Context(), base, owner, entry)
	if e != nil || string(bytes) != string(data) {
		t.Fatal("native contributor bytes differ")
	}
	if _, e = management.RevokeApiCredential(t.Context(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: grant.Msg.Credential.Id})); e != nil {
		t.Fatal("native contributor machine revoke")
	}
	if response := apiRequest(s, grant.Msg.Token, golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure, machineBody(t, m)); response.Code != 401 {
		t.Fatal("native revoked source grant")
	}
	replay := submit(m)
	if replay.CommitId != first.CommitId || observe().CommitId != first.CommitId {
		t.Fatal("native contributor replay changed source")
	}
	// Protect the actual target after a successful writer edit. Both discovery and
	// execution must refuse; unrelated protection rules did not prevent the edit.
	_, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/branch_protections", owner, map[string]any{"rule_name": in.Branch, "enable_push": false}, nil, http.StatusCreated)
	if e != nil {
		t.Fatal("native target protection setup failed")
	}
	protected := observe()
	if !protected.Protected {
		t.Fatal("native effective target protection missing")
	}
	m.OperationId = uuid.NewString()
	m.ExpectedCommitId = first.CommitId
	m.Path = "protected-refused.txt"
	refused := submit(m)
	if refused.Phase != golfv1.RepositoryFileMutationPhase_REPOSITORY_FILE_MUTATION_PHASE_REJECTED || observe().CommitId != first.CommitId {
		t.Fatal("protected contributor change was admitted")
	}
	_, e = s.forgeJSON(t.Context(), http.MethodDelete, base+"/collaborators/"+in.Writer, owner, nil, nil, http.StatusNoContent)
	if e != nil {
		t.Fatal("native writer revocation failed")
	}
	status := connect.NewRequest(&golfv1.GetRepositoryFileMutationOperationRequest{Repository: key, RepositoryId: id, OwnerId: ownerID, OperationId: first.OperationId})
	status.Header().Set("Origin", s.config.PublicURL)
	if _, e = client.GetRepositoryFileMutationOperation(t.Context(), status); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("revoked contributor could inspect original")
	}
	t.Log("native writer file effect, exact bytes, unrelated protection, replay, protected refusal and revocation pass")
}
