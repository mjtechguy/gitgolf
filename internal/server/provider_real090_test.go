package server

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

// Real provider identity + public selected clone only. Private fidelity requires
// a separately authorized owned source and its independent content/ref oracle.
func TestProviderReal090GitHubPublicNative(t *testing.T) {
	path := os.Getenv("GOLF_REAL_PROVIDER090_FIXTURE")
	if path == "" {
		t.Skip("owned native actor and actual provider credential fixture required")
	}
	stat, e := os.Lstat(path)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 16<<10 {
		t.Fatal("private owned fixture required")
	}
	file, e := os.Open(path)
	if e != nil {
		t.Fatal("fixture unavailable")
	}
	defer file.Close()
	var f struct{ NativeURL, NativeToken, GitHubToken, Owner string }
	decoder := json.NewDecoder(io.LimitReader(file, 16<<10+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&f) != nil || decoder.Decode(new(any)) != io.EOF || f.NativeURL != "http://localhost:3001" || !strings.HasPrefix(f.Owner, "golf-real-provider090-") {
		t.Fatal("owned fixture invalid")
	}
	db := testDatabase(t)
	s, e := New(testConfig(f.NativeURL), db)
	if e != nil {
		t.Fatal("server unavailable")
	}
	sessions, _, _, transport, origin := testRPCClients(t, s)
	if _, e = sessions.LoginWithForgeToken(t.Context(), connect.NewRequest(&golfv1.LoginWithForgeTokenRequest{Token: f.NativeToken})); e != nil {
		t.Fatal("owned session failed")
	}
	t.Cleanup(func() { sessions.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})) })
	options := connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, r)
		}
	}))
	client := golfv1connect.NewProviderImportServiceClient(transport, origin.String()+"/rpc", options)
	connection, e := client.CreateProviderConnection(t.Context(), connect.NewRequest(&golfv1.CreateProviderConnectionRequest{ConnectionId: uuid.NewString(), Provider: "github", Name: "Owned actual public provider proof", Token: f.GitHubToken}))
	if e != nil {
		t.Fatal("actual provider identity unavailable")
	}
	if connection.Msg.Connection.ProviderAccountId == "" || connection.Msg.Connection.ProviderLogin == "" {
		t.Fatal("actual identity absent")
	}
	preview, e := client.PreviewProviderImport(t.Context(), connect.NewRequest(&golfv1.PreviewProviderImportRequest{ConnectionId: connection.Msg.Connection.Id, ConnectionVersion: connection.Msg.Connection.Version, SourceUrl: "https://github.com/octocat/Hello-World"}))
	if e != nil || preview.Msg.Preview.SourcePrivate {
		t.Fatal("actual selected public source unavailable")
	}
	input := &golfv1.SubmitProviderImportRequest{Preview: preview.Msg.Preview, OperationId: uuid.NewString(), DestinationName: "connected-public90"}
	result, e := client.SubmitProviderImport(t.Context(), connect.NewRequest(input))
	if e != nil || result.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED || result.Msg.Repository == nil || !result.Msg.Repository.Private || result.Msg.Repository.FullName != f.Owner+"/connected-public90" {
		t.Fatal("actual selected clone unavailable")
	}
	replay, e := client.SubmitProviderImport(t.Context(), connect.NewRequest(input))
	if e != nil || !proto.Equal(result.Msg.Operation, replay.Msg.Operation) {
		t.Fatal("original public import replay changed")
	}
	if _, e = client.UpdateProviderConnection(t.Context(), connect.NewRequest(&golfv1.UpdateProviderConnectionRequest{ConnectionId: connection.Msg.Connection.Id, ExpectedVersion: connection.Msg.Connection.Version, Name: connection.Msg.Connection.Name, Revoke: true})); e != nil {
		t.Fatal("owned connection revocation failed")
	}
	if _, e = client.PreviewProviderImport(t.Context(), connect.NewRequest(&golfv1.PreviewProviderImportRequest{ConnectionId: connection.Msg.Connection.Id, ConnectionVersion: connection.Msg.Connection.Version, SourceUrl: "https://github.com/octocat/Hello-World"})); e == nil {
		t.Fatal("revoked connection still authorized preview")
	}
}
