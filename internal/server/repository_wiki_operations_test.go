package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"encoding/base64"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
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
	var f struct{ Native, Token, Owner, Repository, RepositoryID, OwnerID, Organization, OrganizationID, Mirror, MirrorID string }
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

	labels := golfv1connect.NewOrganizationLabelServiceClient(transport, origin.String()+"/rpc", opts)
	labelID, revision := "", ""
	for _, kind := range []golfv1.OrganizationLabelOperationKind{1, 2, 3} {
		m := &golfv1.SubmitOrganizationLabelOperationRequest{Organization: f.Organization, OrganizationId: f.OrganizationID, OperationId: randomUUID(), Kind: kind, LabelId: labelID, ExpectedRevision: revision}
		if kind != 3 {
			m.Name = "Qualified inherited label"
			m.Color = "abcdef"
			m.Description = "Actual native org label"
			m.Exclusive = kind == 2
			m.Archived = kind == 2
		}
		r, e := labels.SubmitOrganizationLabelOperation(t.Context(), connect.NewRequest(m))
		if e != nil || r.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED {
			t.Fatal("org label mutation failed", kind, e)
		}
		again, e := labels.SubmitOrganizationLabelOperation(t.Context(), connect.NewRequest(m))
		if e != nil || !proto.Equal(again.Msg.Operation, r.Msg.Operation) {
			t.Fatal("org label original replay changed")
		}
		inspected, e := labels.GetOrganizationLabelOperation(t.Context(), connect.NewRequest(&golfv1.GetOrganizationLabelOperationRequest{Organization: f.Organization, OrganizationId: f.OrganizationID, OperationId: m.OperationId}))
		if e != nil || !proto.Equal(inspected.Msg.Operation, r.Msg.Operation) {
			t.Fatal("org label original inspection changed")
		}
		inventory, e := labels.ListOrganizationLabels(t.Context(), connect.NewRequest(&golfv1.ListOrganizationLabelsRequest{Organization: f.Organization}))
		if e != nil || !inventory.Msg.CanManage {
			t.Fatal("org label inventory failed", e)
		}
		if kind != 3 {
			if len(inventory.Msg.Labels) != 1 {
				t.Fatal("org label inventory differs")
			}
			labelID = inventory.Msg.Labels[0].Label.Id
			revision = inventory.Msg.Labels[0].Revision
		} else if len(inventory.Msg.Labels) != 0 {
			t.Fatal("deleted org label retained")
		}
	}
	mirror := golfv1connect.NewRepositoryMirrorServiceClient(transport, origin.String()+"/rpc", opts)
	mirrorKey := &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Mirror}
	for _, kind := range []golfv1.RepositoryMirrorOperationKind{1, 2} {
		status, e := mirror.GetRepositoryMirrorStatus(t.Context(), connect.NewRequest(&golfv1.GetRepositoryMirrorStatusRequest{Repository: mirrorKey, RepositoryId: f.MirrorID}))
		if e != nil || !status.Msg.PullMirror || status.Msg.OwnerId != f.OwnerID || !validAccessRevision(status.Msg.ConfigurationRevision) {
			t.Fatal("mirror current context failed", e)
		}
		m := &golfv1.SubmitRepositoryMirrorOperationRequest{Repository: mirrorKey, RepositoryId: f.MirrorID, OwnerId: f.OwnerID, OperationId: randomUUID(), Kind: kind, ExpectedConfigurationRevision: status.Msg.ConfigurationRevision}
		if kind == 1 {
			m.Interval = "2h"
		}
		r, e := mirror.SubmitRepositoryMirrorOperation(t.Context(), connect.NewRequest(m))
		if e != nil || r.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED {
			t.Fatal("mirror mutation failed", kind, e)
		}
		if r.Msg.Operation.SynchronizationRequestAccepted != (kind == 2) {
			t.Fatal("sync acceptance confused with completion")
		}
		again, e := mirror.SubmitRepositoryMirrorOperation(t.Context(), connect.NewRequest(m))
		if e != nil || !proto.Equal(again.Msg.Operation, r.Msg.Operation) {
			t.Fatal("mirror replay changed")
		}
		inspected, e := mirror.GetRepositoryMirrorOperation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryMirrorOperationRequest{Repository: mirrorKey, RepositoryId: f.MirrorID, OwnerId: f.OwnerID, OperationId: m.OperationId}))
		if e != nil || !proto.Equal(inspected.Msg.Operation, r.Msg.Operation) {
			t.Fatal("mirror inspection changed")
		}
	}
	_ = http.StatusOK
}

func TestWikiOperationJournalPostgres(t *testing.T) {
	for _, mode := range []string{"success", "unknown", "wrong-content", "stale", "reader", "lost-authority"} {
		t.Run(mode, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			target, _ := url.Parse(f.s.config.GiteaURL)
			proxy := httputil.NewSingleHostReverseProxy(target)
			var writes atomic.Int32
			var row nativeWikiPage
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/wiki/") {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == http.MethodPost {
						writes.Add(1)
						var input struct {
							Title, Message string
							Content        string `json:"content_base64"`
						}
						if json.NewDecoder(r.Body).Decode(&input) != nil {
							w.WriteHeader(400)
							return
						}
						row = wikiFixturePage("Useful-page")
						row.Title = input.Title
						row.Content = input.Content
						if mode == "wrong-content" {
							row.Content = base64.StdEncoding.EncodeToString([]byte("foreign content"))
						}
						if mode == "unknown" {
							w.WriteHeader(502)
							return
						}
						if mode == "lost-authority" {
							f.mode.Store("reader")
						}
						w.WriteHeader(201)
						json.NewEncoder(w).Encode(row)
						return
					}
					if row.Slug == "" {
						row = wikiFixturePage("Home")
					}
					json.NewEncoder(w).Encode(row)
					return
				}
				proxy.ServeHTTP(w, r)
			}))
			t.Cleanup(provider.Close)
			config := f.s.config
			config.GiteaURL = provider.URL
			config.GiteaPublicURL = provider.URL
			var e error
			f.s, e = New(config, f.db)
			if e != nil {
				t.Fatal(e)
			}
			session := f.session(t, "pat")
			_, _, _, transport, origin := testRPCClients(t, f.s)
			transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
			client := golfv1connect.NewRepositoryWikiManagementServiceClient(transport, origin.String()+"/rpc")
			contextReq := connect.NewRequest(&golfv1.GetRepositoryWikiWriteContextRequest{Repository: pullKey, RepositoryId: "11"})
			contextReq.Header().Set("Origin", config.PublicURL)
			authority, e := client.GetRepositoryWikiWriteContext(t.Context(), contextReq)
			if e != nil {
				t.Fatal(e)
			}
			m := &golfv1.SubmitRepositoryWikiOperationRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", AccessRevision: authority.Msg.Access.Revision, OperationId: randomUUID(), Kind: 1, Title: "Useful page", Markdown: "# Qualified\n", CommitMessage: "Qualified"}
			if mode == "stale" {
				m.Kind = 2
				m.Slug = "Home"
				m.ExpectedCommitId = strings.Repeat("b", 40)
			}
			if mode == "reader" {
				f.mode.Store("reader")
			}
			req := connect.NewRequest(m)
			req.Header().Set("Origin", config.PublicURL)
			result, e := client.SubmitRepositoryWikiOperation(t.Context(), req)
			if mode == "reader" || mode == "lost-authority" {
				if e == nil {
					t.Fatal("lost authority admitted")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			want := golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN
			if mode == "success" {
				want = golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED
			}
			if mode == "stale" {
				want = golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_REJECTED
			}
			if result.Msg.Operation.Phase != want {
				t.Fatal("phase differs", result.Msg.Operation.Phase)
			}
			replay := connect.NewRequest(m)
			replay.Header().Set("Origin", config.PublicURL)
			again, e := client.SubmitRepositoryWikiOperation(t.Context(), replay)
			if e != nil || !proto.Equal(result.Msg.Operation, again.Msg.Operation) {
				t.Fatal("original outcome changed", e, result.Msg.Operation, again)
			}
			expectedWrites := int32(1)
			if mode == "stale" {
				expectedWrites = 0
			}
			if writes.Load() != expectedWrites {
				t.Fatal("native effect resent")
			}
			changed := proto.Clone(m).(*golfv1.SubmitRepositoryWikiOperationRequest)
			changed.Markdown += "changed"
			other := connect.NewRequest(changed)
			other.Header().Set("Origin", config.PublicURL)
			if _, e = client.SubmitRepositoryWikiOperation(t.Context(), other); e == nil {
				t.Fatal("same key different intent admitted")
			}
			if writes.Load() != expectedWrites {
				t.Fatal("conflicting intent dispatched")
			}
			if _, e = f.db.Exec(`UPDATE golf_repository_wiki_operations SET input_fingerprint=decode(repeat('ff',32),'hex')`); e == nil {
				t.Fatal("journal identity mutated")
			}
			if _, e = f.db.Exec(`DELETE FROM golf_repository_wiki_operation_events`); e == nil {
				t.Fatal("journal events erased")
			}
		})
	}
}
func TestNative078ManagedBoundaries(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RepositoryWikiManagementServiceGetRepositoryWikiWriteContextProcedure, golfv1connect.RepositoryWikiManagementServiceSubmitRepositoryWikiOperationProcedure, golfv1connect.RepositoryWikiManagementServiceGetRepositoryWikiOperationProcedure, golfv1connect.OrganizationLabelServiceSubmitOrganizationLabelOperationProcedure, golfv1connect.OrganizationLabelServiceGetOrganizationLabelOperationProcedure, golfv1connect.RepositoryMirrorServiceSubmitRepositoryMirrorOperationProcedure, golfv1connect.RepositoryMirrorServiceGetRepositoryMirrorOperationProcedure} {
		for _, mode := range []string{"anonymous", "cross-origin", "api"} {
			r := httptest.NewRequest(http.MethodPost, s.config.PublicURL+"/rpc"+procedure, strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			r.Header.Set("Origin", s.config.PublicURL)
			want := 401
			if mode == "cross-origin" {
				r.Header.Set("Origin", "https://foreign.invalid")
				want = 403
			}
			if mode == "api" {
				r.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
				want = 403
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("managed mutation boundary", mode, w.Code)
			}
		}
	}
}
