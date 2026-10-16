package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

func TestForge086NativeActual(t *testing.T) {
	raw := os.Getenv("GOLF_TEST_NATIVE086_CASE")
	if raw == "" {
		t.Skip("owned native086 fixture required")
	}
	var f struct {
		Native, Token, Owner, PrivateRepository, PublicRepository, PrivateID, PublicID, OwnerID, Mirror, MirrorID string
		Source                                                                                                    map[string]any
		Head                                                                                                      map[string]any
	}
	if json.Unmarshal([]byte(raw), &f) != nil {
		t.Fatal("fixture invalid")
	}
	config := testConfig(f.Native)
	config.ForgePublicURL = f.Native
	config.ForgeOAuthClientID = "owned-native086"
	config.ForgeOAuthClientSecret = "owned-native086-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal(e)
	}
	base := s.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			if r.Header.Get("Authorization") != "Bearer "+forge086Token && r.Header.Get("Authorization") != "" {
				t.Error("provider token isolation")
			}
			switch r.URL.Path {
			case "/user":
				return forge086Response(r, 200, map[string]any{"id": 81, "login": "owned-fixture"}), nil
			case "/repos/octocat/Hello-World":
				return forge086Response(r, 200, f.Source), nil
			case "/repos/octocat/Hello-World/branches/master":
				return forge086Response(r, 200, f.Head), nil
			}
			t.Error("unexpected provider source read")
			return forge086Response(r, 404, nil), nil
		}
		return base.RoundTrip(r)
	})
	sessions, _, _, transport, origin := testRPCClients(t, s)
	if _, e = sessions.LoginWithForgeToken(t.Context(), connect.NewRequest(&golfv1.LoginWithForgeTokenRequest{Token: f.Token})); e != nil {
		t.Fatal("owned login failed")
	}
	t.Cleanup(func() { sessions.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})) })
	opts := connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", config.PublicURL)
			return next(ctx, r)
		}
	}))
	providers := golfv1connect.NewProviderImportServiceClient(transport, origin.String()+"/rpc", opts)
	packages := golfv1connect.NewPackagePublicationServiceClient(transport, origin.String()+"/rpc", opts)
	c, e := providers.CreateProviderConnection(t.Context(), connect.NewRequest(&golfv1.CreateProviderConnectionRequest{ConnectionId: randomUUID(), Provider: "github", Name: "Owned fixed-origin qualifier", Token: forge086Token}))
	if e != nil {
		t.Fatal("connection", e)
	}
	preview, e := providers.PreviewProviderImport(t.Context(), connect.NewRequest(&golfv1.PreviewProviderImportRequest{ConnectionId: c.Msg.Connection.Id, ConnectionVersion: c.Msg.Connection.Version, SourceUrl: "https://github.com/octocat/Hello-World"}))
	if e != nil {
		t.Fatal("preview", e)
	}
	input := &golfv1.SubmitProviderImportRequest{Preview: preview.Msg.Preview, OperationId: randomUUID(), DestinationName: "owned-import"}
	imported, e := providers.SubmitProviderImport(t.Context(), connect.NewRequest(input))
	if e != nil || imported.Msg.Operation.Phase != 3 || imported.Msg.Repository == nil || !imported.Msg.Repository.Private {
		t.Fatal("actual native public clone", e, imported)
	}
	replayed, e := providers.SubmitProviderImport(t.Context(), connect.NewRequest(input))
	if e != nil || !proto.Equal(imported.Msg.Operation, replayed.Msg.Operation) {
		t.Fatal("import original", e)
	}
	publicKey := &golfv1.RepositoryKey{Owner: f.Owner, Name: f.PublicRepository}
	privateKey := &golfv1.RepositoryKey{Owner: f.Owner, Name: f.PrivateRepository}
	private, e := packages.GetPackagePublicationAccess(t.Context(), connect.NewRequest(&golfv1.GetPackagePublicationAccessRequest{Repository: privateKey, RepositoryId: f.PrivateID}))
	if e != nil || private.Msg.Allowed {
		t.Fatal("private repository public namespace must refuse", e)
	}
	access, e := packages.GetPackagePublicationAccess(t.Context(), connect.NewRequest(&golfv1.GetPackagePublicationAccessRequest{Repository: publicKey, RepositoryId: f.PublicID}))
	if e != nil || !access.Msg.Allowed || !access.Msg.PublicNamespaceAcknowledgementRequired {
		t.Fatal("public namespace acknowledgement", e)
	}
	data := []byte(strings.Repeat("bounded native generic bytes\n", 8192))
	if len(data) > 256<<10 {
		t.Fatal("fixture cap")
	}
	m := &golfv1.SubmitPackagePublicationRequest{Repository: publicKey, RepositoryId: f.PublicID, OwnerId: f.OwnerID, AccessRevision: access.Msg.Access.Revision, OperationId: randomUUID(), PackageName: "owned-generic086", Version: "1.0", FileName: "fixture.txt", Content: data, PublicNamespaceAcknowledged: true}
	r, e := packages.SubmitPackagePublication(t.Context(), connect.NewRequest(m))
	if e != nil || r.Msg.Operation.Phase != 3 {
		t.Fatal("native publication", e, r)
	}
	again, e := packages.SubmitPackagePublication(t.Context(), connect.NewRequest(m))
	if e != nil || !proto.Equal(r.Msg.Operation, again.Msg.Operation) {
		t.Fatal("publication original", e)
	}
	reads := golfv1connect.NewForgePackageServiceClient(transport, origin.String()+"/rpc", opts)
	inventory, e := reads.ListRepositoryPackages(t.Context(), connect.NewRequest(&golfv1.ListRepositoryPackagesRequest{Repository: publicKey, RepositoryId: f.PublicID, Page: &golfv1.PageRequest{Limit: 20, Page: 1}}))
	if e != nil || len(inventory.Msg.Packages) != 1 {
		t.Fatal("linked package", e)
	}
	dl, e := packages.DownloadGenericPackageFile(t.Context(), connect.NewRequest(&golfv1.DownloadGenericPackageFileRequest{Repository: publicKey, RepositoryId: f.PublicID, Package: inventory.Msg.Packages[0], FileId: r.Msg.Operation.ResultFileId}))
	if e != nil || string(dl.Msg.Content) != string(data) || dl.Msg.Sha256 != r.Msg.Operation.ContentSha256 {
		t.Fatal("native exact package download", e)
	}
	wiki := golfv1connect.NewRepositoryWikiManagementServiceClient(transport, origin.String()+"/rpc", opts)
	wikiRead := golfv1connect.NewRepositoryWikiServiceClient(transport, origin.String()+"/rpc", opts)
	for _, title := range []string{"Home", "_Sidebar", "_Footer"} {
		a, e := wiki.GetRepositoryWikiWriteContext(t.Context(), connect.NewRequest(&golfv1.GetRepositoryWikiWriteContextRequest{Repository: privateKey, RepositoryId: f.PrivateID}))
		if e != nil || !a.Msg.CanWrite {
			t.Fatal("native wiki write", e)
		}
		r, e := wiki.SubmitRepositoryWikiOperation(t.Context(), connect.NewRequest(&golfv1.SubmitRepositoryWikiOperationRequest{Repository: privateKey, RepositoryId: f.PrivateID, OwnerId: f.OwnerID, AccessRevision: a.Msg.Access.Revision, OperationId: randomUUID(), Kind: 1, Title: title, Markdown: "# " + title + "\n[Home](Home)\n", CommitMessage: "Owned wiki qualification"}))
		if e != nil || r.Msg.Operation.Phase != 3 {
			t.Fatal("native wiki attachments", title, e, r)
		}
	}
	page, e := wikiRead.GetRepositoryWikiPage(t.Context(), connect.NewRequest(&golfv1.GetRepositoryWikiPageRequest{Repository: privateKey, RepositoryId: f.PrivateID, Slug: "Home"}))
	if e != nil || page.Msg.SidebarMarkdown == nil || page.Msg.FooterMarkdown == nil || *page.Msg.SidebarMarkdown != "# _Sidebar\n[Home](Home)\n" || *page.Msg.FooterMarkdown != "# _Footer\n[Home](Home)\n" {
		t.Fatal("current native wiki sidebar/footer", e, page)
	}
	mirror := golfv1connect.NewRepositoryMirrorServiceClient(transport, origin.String()+"/rpc", opts)
	observation := golfv1connect.NewMirrorObservationServiceClient(transport, origin.String()+"/rpc", opts)
	mirrorKey := &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Mirror}
	status, e := mirror.GetRepositoryMirrorStatus(t.Context(), connect.NewRequest(&golfv1.GetRepositoryMirrorStatusRequest{Repository: mirrorKey, RepositoryId: f.MirrorID}))
	if e != nil {
		t.Fatal("native mirror status", e)
	}
	syncInput := &golfv1.SubmitRepositoryMirrorOperationRequest{Repository: mirrorKey, RepositoryId: f.MirrorID, OwnerId: f.OwnerID, OperationId: randomUUID(), ExpectedConfigurationRevision: status.Msg.ConfigurationRevision, Kind: 2}
	queued, e := mirror.SubmitRepositoryMirrorOperation(t.Context(), connect.NewRequest(syncInput))
	if e != nil || queued.Msg.Operation.Phase != 3 || !queued.Msg.Operation.SynchronizationRequestAccepted {
		t.Fatal("native mirror queue", e, queued)
	}
	for attempt := 0; attempt < 40; attempt++ {
		o, e := observation.GetMirrorSyncObservation(t.Context(), connect.NewRequest(&golfv1.GetMirrorSyncObservationRequest{Repository: mirrorKey, RepositoryId: f.MirrorID, OwnerId: f.OwnerID, OperationId: syncInput.OperationId}))
		if e != nil {
			t.Fatal("native mirror observation", e)
		}
		if o.Msg.CompletionObserved {
			return
		}
		select {
		case <-t.Context().Done():
			t.Fatal("mirror timeout")
		case <-time.After(250 * time.Millisecond):
		}
	}
	t.Fatal("mirror timestamp/default HEAD completion was not observed")

}
