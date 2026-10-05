package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
)

type releaseOperationTransport func(*http.Request) (*http.Response, error)

func (f releaseOperationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func newReleaseOperationsFixture(t *testing.T) (*releasePublicationFixture, *sync.Mutex, *[]byte) {
	f := newReleasePublicationFixture(t)
	state := &sync.Mutex{}
	content := []byte("ok")
	row := releaseFixtureRow()
	two := int64(2)
	row.Assets[0].Size = &two
	f.published = &row
	uuid := "12e12345-1234-4234-8234-123456789abc"
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state.Lock()
		defer state.Unlock()
		w.Header().Set("Content-Type", "application/json")
		base := "/api/v1/repos/alice/private/releases/9007199254740993"
		mode := f.mode.Load().(string)
		if strings.Contains(r.URL.Path, "/releases/attachments/") {
			if r.Header.Get("Authorization") != "Bearer pull-pat" {
				w.WriteHeader(401)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(content)
			return
		}
		if r.Method != http.MethodGet {
			f.calls.Add(1)
		}
		if f.published == nil {
			w.WriteHeader(404)
			return
		}
		switch {
		case r.URL.Path == base:
			switch r.Method {
			case http.MethodGet:
				json.NewEncoder(w).Encode(f.published)
			case http.MethodPatch:
				var v struct {
					Name, Body        string
					Draft, Prerelease bool
				}
				if json.NewDecoder(r.Body).Decode(&v) != nil {
					t.Error("invalid native payload")
				}
				f.published.Title = v.Name
				f.published.Body = v.Body
				f.published.Draft = &v.Draft
				f.published.Prerelease = &v.Prerelease
				if mode == "lost" {
					w.WriteHeader(503)
					return
				}
				json.NewEncoder(w).Encode(f.published)
			case http.MethodDelete:
				f.published = nil
				if mode == "lost" {
					w.WriteHeader(503)
					return
				}
				w.WriteHeader(204)
			}
		case r.URL.Path == base+"/assets" && r.Method == http.MethodPost:
			if e := r.ParseMultipartForm(512 << 10); e != nil {
				t.Error(e)
				w.WriteHeader(400)
				return
			}
			file, header, e := r.FormFile("attachment")
			if e != nil {
				t.Error(e)
				w.WriteHeader(400)
				return
			}
			defer file.Close()
			content, _ = io.ReadAll(file)
			size := int64(len(content))
			zero := int64(0)
			asset := forgeReleaseAsset{ID: 19, Name: header.Filename, Size: &size, DownloadCount: &zero, CreatedAt: "2026-10-05T10:00:00Z"}
			f.published.Assets = append(f.published.Assets, asset)
			if mode == "lost" {
				w.WriteHeader(503)
				return
			}
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(forgeReleaseDownloadAsset{forgeReleaseAsset: asset, UUID: uuid})
		case strings.HasPrefix(r.URL.Path, base+"/assets/"):
			id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/assets/"), 10, 64)
			index := -1
			for i, a := range f.published.Assets {
				if a.ID == id {
					index = i
					break
				}
			}
			if index < 0 {
				w.WriteHeader(404)
				return
			}
			switch r.Method {
			case http.MethodGet:
				json.NewEncoder(w).Encode(forgeReleaseDownloadAsset{forgeReleaseAsset: f.published.Assets[index], UUID: uuid})
			case http.MethodPatch:
				var v struct{ Name string }
				json.NewDecoder(r.Body).Decode(&v)
				f.published.Assets[index].Name = v.Name
				if mode == "lost" {
					w.WriteHeader(503)
					return
				}
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(f.published.Assets[index])
			case http.MethodDelete:
				f.published.Assets = append(f.published.Assets[:index], f.published.Assets[index+1:]...)
				if mode == "lost" {
					w.WriteHeader(503)
					return
				}
				w.WriteHeader(204)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(native.Close)
	target, _ := url.Parse(native.URL)
	f.s.client.Transport = releaseOperationTransport(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "/releases/") {
			copy := r.Clone(r.Context())
			u := *r.URL
			u.Scheme = target.Scheme
			u.Host = target.Host
			copy.URL = &u
			return http.DefaultTransport.RoundTrip(copy)
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	return f, state, &content
}
func releaseOperationRequest(t *testing.T, f *releasePublicationFixture, session loginResult, k golfv1.RepositoryReleaseOperationKind) *golfv1.SubmitRepositoryReleaseOperationRequest {
	t.Helper()
	publication := f.request(t, session)
	m := &golfv1.SubmitRepositoryReleaseOperationRequest{Repository: publication.Repository, RepositoryId: publication.RepositoryId, OwnerId: publication.OwnerId, AccessRevision: publication.AccessRevision, OperationId: randomUUID(), ReleaseId: "9007199254740993", ExpectedRevision: releaseRevision(*f.published), Kind: k}
	switch int32(k) {
	case 1:
		m.Title = "Edited release"
		m.BodyMarkdown = "New **notes**"
		m.Prerelease = true
	case 3:
		m.AssetName = "bundle.bin"
		m.AssetContent = []byte{0, 1, 2, 255}
	case 4:
		m.AssetId = "9007199254740993"
		m.AssetName = "renamed.zip"
	case 5:
		m.AssetId = "9007199254740993"
	}
	return m
}
func submitReleaseOperation(t *testing.T, f *releasePublicationFixture, session loginResult, m *golfv1.SubmitRepositoryReleaseOperationRequest) (*connect.Response[golfv1.SubmitRepositoryReleaseOperationResponse], error) {
	t.Helper()
	ctx, _, header := f.scope(session)
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", header.Get("Cookie"))
	req.Header().Set("Origin", header.Get("Origin"))
	return f.s.SubmitRepositoryReleaseOperation(ctx, req)
}
func TestReleaseOperationValidationAndRevision(t *testing.T) {
	m := &golfv1.SubmitRepositoryReleaseOperationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: randomUUID(), ReleaseId: "17", ExpectedRevision: strings.Repeat("b", 64), Kind: golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_UPLOAD_ASSET, AssetName: "bundle.bin", AssetContent: []byte{0, 255}}
	if e := validateReleaseOperation(m); e != nil {
		t.Fatal(e)
	}
	h := releaseOperationFingerprint(m)
	m.OperationId = randomUUID()
	if !bytes.Equal(h, releaseOperationFingerprint(m)) {
		t.Fatal("original key changed semantic fingerprint")
	}
	c := proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)
	c.AssetContent[0] = 1
	if bytes.Equal(h, releaseOperationFingerprint(c)) {
		t.Fatal("bytes not bound")
	}
	for name, change := range map[string]func(*golfv1.SubmitRepositoryReleaseOperationRequest){"filename": func(m *golfv1.SubmitRepositoryReleaseOperationRequest) { m.AssetName = "../bad" }, "id": func(m *golfv1.SubmitRepositoryReleaseOperationRequest) { m.ReleaseId = "017" }, "revision": func(m *golfv1.SubmitRepositoryReleaseOperationRequest) { m.ExpectedRevision = "bad" }, "oversize": func(m *golfv1.SubmitRepositoryReleaseOperationRequest) {
		m.AssetContent = make([]byte, releaseUploadMaxBytes+1)
	}, "mixed": func(m *golfv1.SubmitRepositoryReleaseOperationRequest) { m.Title = "Unexpected" }} {
		t.Run(name, func(t *testing.T) {
			v := proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)
			change(v)
			if validateReleaseOperation(v) == nil {
				t.Fatal("invalid request admitted")
			}
		})
	}
	row := releaseFixtureRow()
	first := releaseRevision(row)
	count := int64(8)
	row.Assets[0].DownloadCount = &count
	if releaseRevision(row) != first {
		t.Fatal("download changed immutable revision")
	}
	row.Title += "x"
	if releaseRevision(row) == first {
		t.Fatal("metadata not bound")
	}
}
func TestReleaseOperationsOriginalDispatch(t *testing.T) {
	for k := int32(1); k <= 5; k++ {
		t.Run(strconv.Itoa(int(k)), func(t *testing.T) {
			f, _, content := newReleaseOperationsFixture(t)
			session := f.session(t, "pat")
			m := releaseOperationRequest(t, f, session, golfv1.RepositoryReleaseOperationKind(k))
			r, e := submitReleaseOperation(t, f, session, m)
			if e != nil || r.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED {
				t.Fatalf("original release operation: %+v %v", r, e)
			}
			again, e := submitReleaseOperation(t, f, session, m)
			if e != nil || again.Msg.Operation.OperationId != m.OperationId || f.calls.Load() != 1 {
				t.Fatalf("original replay resent: %v calls%d", e, f.calls.Load())
			}
			if k == 3 && !bytes.Equal(*content, m.AssetContent) {
				t.Fatal("multipart bytes changed")
			}
			changed := proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)
			changed.ExpectedRevision = strings.Repeat("f", 64)
			_, e = submitReleaseOperation(t, f, session, changed)
			if connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatalf("changed original intent: %v", e)
			}
		})
	}
}
func TestReleaseOperationsUnknownNoReplay(t *testing.T) {
	for k := int32(1); k <= 5; k++ {
		t.Run(strconv.Itoa(int(k)), func(t *testing.T) {
			f, _, _ := newReleaseOperationsFixture(t)
			session := f.session(t, "pat")
			m := releaseOperationRequest(t, f, session, golfv1.RepositoryReleaseOperationKind(k))
			f.mode.Store("lost")
			r, e := submitReleaseOperation(t, f, session, m)
			if e != nil || r.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN {
				t.Fatalf("lost result %+v %v", r, e)
			}
			for i := 0; i < 2; i++ {
				_, e = submitReleaseOperation(t, f, session, m)
				if e != nil {
					t.Fatal(e)
				}
			}
			if f.calls.Load() != 1 {
				t.Fatal("unknown resent")
			}
			ctx, _, header := f.scope(session)
			request := connect.NewRequest(&golfv1.GetRepositoryReleaseOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
			request.Header().Set("Cookie", header.Get("Cookie"))
			request.Header().Set("Origin", header.Get("Origin"))
			got, e := f.s.GetRepositoryReleaseOperation(ctx, request)
			if e != nil || got.Msg.Operation.Phase != r.Msg.Operation.Phase || f.calls.Load() != 1 {
				t.Fatal("inspection changed original unknown", e)
			}
			next := proto.Clone(m).(*golfv1.SubmitRepositoryReleaseOperationRequest)
			next.OperationId = randomUUID()
			if _, e = submitReleaseOperation(t, f, session, next); e == nil {
				t.Fatal("new intent bypassed unresolved repository")
			}
			var events int
			if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_release_operation_events`).Scan(&events); e != nil || events != 2 {
				t.Fatal("outcome event history", events, e)
			}
		})
	}
}
func TestReleaseOperationsCurrentAuthorityAndRevision(t *testing.T) {
	for _, mode := range []string{"reader", "replacement", "transfer", "archived", "mirror", "disabled", "unknown-unit", "stale"} {
		t.Run(mode, func(t *testing.T) {
			f, _, _ := newReleaseOperationsFixture(t)
			session := f.session(t, "pat")
			m := releaseOperationRequest(t, f, session, golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_EDIT)
			if mode == "stale" {
				m.ExpectedRevision = strings.Repeat("f", 64)
			} else {
				f.mode.Store(mode)
			}
			r, e := submitReleaseOperation(t, f, session, m)
			if e == nil && r.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_REJECTED {
				t.Fatal("invalid preflight succeeded")
			}
			if f.calls.Load() != 0 {
				t.Fatal("denied authority dispatched")
			}
		})
	}
}
func TestReleaseOperationsManagedBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RepositoryReleaseManagementServiceSubmitRepositoryReleaseOperationProcedure, golfv1connect.RepositoryReleaseManagementServiceGetRepositoryReleaseOperationProcedure} {
		for _, kind := range []string{"anonymous", "origin", "bearer"} {
			r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/rpc"+procedure, strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			r.Header.Set("Origin", s.config.PublicURL)
			want := 401
			if kind == "origin" {
				r.Header.Set("Origin", "https://other.invalid")
				want = 403
			}
			if kind == "bearer" {
				r.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
				want = 403
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("managed boundary", kind, w.Code)
			}
		}
	}
	_ = context.Background()
}

// The launcher provisions and purges an owned native fixture; this test runs
// real production HTTP handlers and a disposable real PostgreSQL schema.
func TestReleaseOperationsActualNative(t *testing.T) {
	raw := os.Getenv("GOLF_TEST_RELEASE_OPERATION_NATIVE_CASE")
	if raw == "" {
		t.Skip("set owned native release qualification fixture")
	}
	var fixture struct{ Native, Token, Owner, Repository, RepositoryID, OwnerID, ReleaseID string }
	if json.Unmarshal([]byte(raw), &fixture) != nil {
		t.Fatal("fixture invalid")
	}
	config := testConfig(fixture.Native)
	config.GiteaPublicURL = fixture.Native
	config.GiteaOAuthClientID = "owned-source-fixture"
	config.GiteaOAuthClientSecret = "owned-source-fixture-secret"
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal(e)
	}
	sessions, repos, _, httpClient, origin := testRPCClients(t, s)
	if _, e = sessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: fixture.Token})); e != nil {
		t.Fatal("owned native login failed")
	}
	t.Cleanup(func() {
		_, e := sessions.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{}))
		if e != nil {
			t.Error("owned source session logout failed")
		}
	})
	options := connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", config.PublicURL)
			return next(ctx, r)
		}
	}))
	manager := golfv1connect.NewRepositoryReleaseManagementServiceClient(httpClient, origin.String()+"/rpc", options)
	accessClient := golfv1connect.NewRepositoryAccessServiceClient(httpClient, origin.String()+"/rpc", options)
	key := &golfv1.RepositoryKey{Owner: fixture.Owner, Name: fixture.Repository}
	credential := forgeCredential{Kind: "pat", Token: fixture.Token}
	base, _ := repositoryPath(keyFrom(key))
	assetID := ""
	for _, kind := range []golfv1.RepositoryReleaseOperationKind{golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_EDIT, golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_UPLOAD_ASSET, golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_RENAME_ASSET, golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_DELETE_ASSET, golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_DELETE} {
		current, e := repos.GetRepositoryRelease(t.Context(), connect.NewRequest(&golfv1.GetRepositoryReleaseRequest{Repository: key, RepositoryId: fixture.RepositoryID, ReleaseId: fixture.ReleaseID}))
		if e != nil {
			t.Fatal("native release read failed")
		}
		access, e := accessClient.GetRepositoryAccess(t.Context(), connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key}))
		if e != nil {
			t.Fatal("native authority failed")
		}
		m := &golfv1.SubmitRepositoryReleaseOperationRequest{Repository: key, RepositoryId: fixture.RepositoryID, OwnerId: fixture.OwnerID, AccessRevision: access.Msg.Access.Revision, OperationId: randomUUID(), ReleaseId: fixture.ReleaseID, ExpectedRevision: current.Msg.Release.Revision, Kind: kind}
		switch int32(kind) {
		case 1:
			m.Title = "Native qualified notes"
			m.BodyMarkdown = "Literal **release** notes\n"
			m.Prerelease = true
		case 3:
			m.AssetName = "literal.bin"
			m.AssetContent = []byte{0, 1, 2, 255, 10}
		case 4:
			m.AssetId = assetID
			m.AssetName = "renamed.bin"
		case 5:
			m.AssetId = assetID
		}
		result, e := manager.SubmitRepositoryReleaseOperation(t.Context(), connect.NewRequest(m))
		if e != nil {
			t.Fatalf("native operation%d failed: %v", kind, e)
		}
		if result.Msg.Operation.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED {
			t.Fatalf("native operation%d unresolved phase%s; inspect original only", kind, result.Msg.Operation.Phase)
		}
		again, e := manager.SubmitRepositoryReleaseOperation(t.Context(), connect.NewRequest(m))
		if e != nil || !proto.Equal(again.Msg.Operation, result.Msg.Operation) {
			t.Fatal("native same-key outcome differs")
		}
		inspected, e := manager.GetRepositoryReleaseOperation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryReleaseOperationRequest{Repository: key, RepositoryId: fixture.RepositoryID, OwnerId: fixture.OwnerID, OperationId: m.OperationId}))
		if e != nil || !proto.Equal(inspected.Msg.Operation, result.Msg.Operation) {
			t.Fatal("native original inspection differs")
		}
		if kind == golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_UPLOAD_ASSET {
			assetID = result.Msg.Operation.AssetId
		}
		if kind != golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_DELETE {
			var observed forgeRepositoryRelease
			if _, e = s.forge(t.Context(), http.MethodGet, base+"/releases/"+fixture.ReleaseID, credential, nil, &observed); e != nil {
				t.Fatal("independent native read failed")
			}
			if kind == golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_EDIT && (observed.Title != m.Title || observed.Body != m.BodyMarkdown || !*observed.Prerelease) {
				t.Fatal("independent native metadata differs")
			}
			if kind == golfv1.RepositoryReleaseOperationKind_REPOSITORY_RELEASE_OPERATION_KIND_DELETE_ASSET && len(observed.Assets) != 0 {
				t.Fatal("deleted asset remains")
			}
		}
	}
	// The supported release DELETE removed release data but preserved the Git tag.
	if _, e = s.exactSourceTag(t.Context(), base, credential, "v1"); e != nil {
		t.Fatal("release deletion removed original tag")
	}
	if os.Getenv("GOLF_TEST_PUBLIC_IMPORT_NATIVE") == "1" {
		// Verify public GitHub/GitLab cloning and a native pull mirror using tiny
		// owned imports. This does not qualify provider metadata migration or CI.
		mirrors := golfv1connect.NewRepositoryMirrorServiceClient(httpClient, origin.String()+"/rpc", options)
		for _, input := range []struct {
			Name, Source string
			Mirror       bool
		}{{"github-import", "https://github.com/octocat/Hello-World", false}, {"gitlab-import", "https://gitlab.com/gitlab-examples/nodejs", false}, {"github-mirror", "https://github.com/octocat/Hello-World", true}} {
			private := true
			m := &golfv1.CreateRepositoryRequest{Name: input.Name, Description: "Owned native public import qualification", Private: &private, IdempotencyKey: randomUUID(), SourceUrl: input.Source, PullMirror: input.Mirror}
			r, e := repos.CreateRepository(t.Context(), connect.NewRequest(m))
			if e != nil {
				t.Fatalf("actual%s import failed: %v", input.Name, e)
			}
			if r.Msg.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_SUCCEEDED {
				t.Fatalf("actual%s import unresolved; inspect original only", input.Name)
			}
			replay, e := repos.CreateRepository(t.Context(), connect.NewRequest(m))
			if e != nil || !proto.Equal(replay.Msg.Creation, r.Msg.Creation) {
				t.Fatal("actual import original replay changed")
			}
			observed, e := repos.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: m.IdempotencyKey}))
			if e != nil || !proto.Equal(observed.Msg.Creation, r.Msg.Creation) {
				t.Fatal("actual import inspection changed")
			}
			if r.Msg.Repository == nil || r.Msg.Repository.Empty {
				t.Fatal("actual imported repository has no code")
			}
			status, e := mirrors.GetRepositoryMirrorStatus(t.Context(), connect.NewRequest(&golfv1.GetRepositoryMirrorStatusRequest{Repository: &golfv1.RepositoryKey{Owner: fixture.Owner, Name: input.Name}, RepositoryId: r.Msg.Repository.Id}))
			if e != nil || status.Msg.PullMirror != input.Mirror {
				t.Fatal("actual mirror status differs", e)
			}
			if input.Mirror && status.Msg.SourceHost != "github.com" {
				t.Fatal("actual mirror source host differs")
			}
			t.Logf("Qualified actual public import %s; pull mirror=%t", input.Name, input.Mirror)
		}

	}
}
