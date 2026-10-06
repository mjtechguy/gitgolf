package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestWikiOperationInputs(t *testing.T) {
	m := &golfv1.SubmitRepositoryWikiOperationRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: randomUUID(), Kind: 1, Title: "Home", Markdown: "# Docs\n", CommitMessage: "Create docs"}
	if e := validateWikiOperation(m); e != nil {
		t.Fatal(e)
	}
	h := wikiOperationFingerprint(m)
	m.OperationId = randomUUID()
	if !bytes.Equal(h, wikiOperationFingerprint(m)) {
		t.Fatal("UUID bound fingerprint")
	}
	for _, field := range []string{"slash", "empty", "nul", "stale", "wide", "delete-payload"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryWikiOperationRequest)
		switch field {
		case "slash":
			c.Title = "x/y"
		case "empty":
			c.Markdown = ""
		case "nul":
			c.Markdown = "x\x00"
		case "stale":
			c.Kind = 2
			c.Slug = "Home"
		case "wide":
			c.Markdown = strings.Repeat("x", 262145)
		case "delete-payload":
			c.Kind = 3
			c.Slug = "Home"
			c.ExpectedCommitId = strings.Repeat("a", 40)
		}
		if validateWikiOperation(c) == nil {
			t.Fatal("invalid admitted", field)
		}
	}
}
func TestNative078Actual(t *testing.T) {
	raw := os.Getenv("GOLF_TEST_NATIVE078_CASE")
	if raw == "" {
		t.Skip("owned native078 fixture required")
	}
	var f struct{ Native, Token, Owner, Repository, RepositoryID, OwnerID string }
	if json.Unmarshal([]byte(raw), &f) != nil {
		t.Fatal("fixture invalid")
	}
	config := testConfig(f.Native)
	config.GiteaPublicURL = f.Native
	config.GiteaOAuthClientID = "owned-native078"
	config.GiteaOAuthClientSecret = "owned-native078-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal(e)
	}
	sessions, _, _, transport, origin := testRPCClients(t, s)
	if _, e = sessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: f.Token})); e != nil {
		t.Fatal("login failed")
	}
	t.Cleanup(func() {
		if _, e := sessions.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("logout failed")
		}
	})
	opts := connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", config.PublicURL)
			return next(ctx, r)
		}
	}))
	client := golfv1connect.NewRepositoryWikiManagementServiceClient(transport, origin.String()+"/rpc", opts)
	key := &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Repository}
	slug, sha := "", ""
	for _, kind := range []golfv1.RepositoryWikiOperationKind{1, 2, 3} {
		ctx, e := client.GetRepositoryWikiWriteContext(t.Context(), connect.NewRequest(&golfv1.GetRepositoryWikiWriteContextRequest{Repository: key, RepositoryId: f.RepositoryID}))
		if e != nil {
			t.Fatal("authority failed", e)
		}
		m := &golfv1.SubmitRepositoryWikiOperationRequest{Repository: key, RepositoryId: f.RepositoryID, OwnerId: f.OwnerID, AccessRevision: ctx.Msg.Access.Revision, OperationId: randomUUID(), Kind: kind, Slug: slug, ExpectedCommitId: sha}
		if kind != 3 {
			m.Title = "Useful docs 雪"
			m.Markdown = "# Docs\n\nLiteral **markdown**\n"
			m.CommitMessage = "Qualified wiki change"
			if kind == 2 {
				m.Markdown += "Edited second version\n"
			}
		}
		result, e := client.SubmitRepositoryWikiOperation(t.Context(), connect.NewRequest(m))
		if e != nil {
			t.Fatal("native wiki operation failed", kind, e)
		}
		if result.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED {
			t.Fatal("native wiki outcome unresolved", kind, result.Msg.Operation.Phase)
		}
		again, e := client.SubmitRepositoryWikiOperation(t.Context(), connect.NewRequest(m))
		if e != nil || !proto.Equal(again.Msg.Operation, result.Msg.Operation) {
			t.Fatal("original replay changed")
		}
		inspected, e := client.GetRepositoryWikiOperation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryWikiOperationRequest{Repository: key, RepositoryId: f.RepositoryID, OwnerId: f.OwnerID, OperationId: m.OperationId}))
		if e != nil || !proto.Equal(inspected.Msg.Operation, result.Msg.Operation) {
			t.Fatal("original inspection changed")
		}
		if kind != 3 {
			slug, sha = result.Msg.Operation.ResultSlug, result.Msg.Operation.ResultCommitId
			history, e := client.ListRepositoryWikiRevisions(t.Context(), connect.NewRequest(&golfv1.ListRepositoryWikiRevisionsRequest{Repository: key, RepositoryId: f.RepositoryID, Slug: slug}))
			if e != nil || len(history.Msg.Revisions) != int(kind) || history.Msg.ObservedCommitId != sha {
				t.Fatal("history differs", e)
			}
		}
	}
	packages := golfv1connect.NewForgePackageServiceClient(transport, origin.String()+"/rpc", opts)
	inventory, e := packages.ListRepositoryPackages(t.Context(), connect.NewRequest(&golfv1.ListRepositoryPackagesRequest{Repository: key, RepositoryId: f.RepositoryID}))
	if e != nil || len(inventory.Msg.Packages) != 1 {
		t.Fatal("native package inventory failed", e)
	}
	p := inventory.Msg.Packages[0]
	files, e := packages.GetRepositoryPackageFiles(t.Context(), connect.NewRequest(&golfv1.GetRepositoryPackageFilesRequest{Repository: key, RepositoryId: f.RepositoryID, Package: p}))
	if e != nil || len(files.Msg.Files) != 1 || files.Msg.Files[0].Name != "hello.txt" || files.Msg.Files[0].SizeBytes != "15" {
		t.Fatal("native package files differ", e)
	}
	_ = http.StatusOK
}
