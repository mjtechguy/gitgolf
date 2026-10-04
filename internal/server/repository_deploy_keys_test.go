package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"golang.org/x/crypto/ssh"
	"google.golang.org/protobuf/proto"
)

func deployKeyFixture(t *testing.T) forgeRepositoryDeployKey {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := true
	return forgeRepositoryDeployKey{ID: 9007199254740993, KeyID: 9007199254740994, Title: "Deployment", Key: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), Fingerprint: ssh.FingerprintSHA256(key), CreatedAt: "2026-10-03T12:00:00Z", ReadOnly: &readOnly}
}
func TestRepositoryDeployKeyProjection(t *testing.T) {
	row := deployKeyFixture(t)
	wire, err := wireRepositoryDeployKey(row, "17")
	if err != nil || wire.Id != "9007199254740993" || wire.PublicKeyId != "9007199254740994" || !wire.ReadOnly || !validAccessRevision(wire.Revision) {
		t.Fatal("exact association projection", err)
	}
	for _, mutate := range []func(*forgeRepositoryDeployKey){func(r *forgeRepositoryDeployKey) { r.ReadOnly = nil }, func(r *forgeRepositoryDeployKey) { r.ID = 0 }, func(r *forgeRepositoryDeployKey) { r.KeyID = 0 }, func(r *forgeRepositoryDeployKey) { r.Fingerprint = "SHA256:wrong" }, func(r *forgeRepositoryDeployKey) { r.Key = "-----BEGIN PRIVATE KEY-----" }, func(r *forgeRepositoryDeployKey) { r.CreatedAt = "" }, func(r *forgeRepositoryDeployKey) { r.Repository = &Repository{ID: 18} }, func(r *forgeRepositoryDeployKey) { r.Title = "bad\x00title" }} {
		changed := row
		mutate(&changed)
		if _, err := wireRepositoryDeployKey(changed, "17"); err == nil {
			t.Fatal("malformed native grant accepted")
		}
	}
	rw := false
	changed := row
	changed.ReadOnly = &rw
	next, _ := wireRepositoryDeployKey(changed, "17")
	if next.Revision == wire.Revision {
		t.Fatal("grant omitted from stale preview")
	}
	next, _ = wireRepositoryDeployKey(row, "18")
	if next.Revision == wire.Revision {
		t.Fatal("target omitted from stale preview")
	}
}
func TestRepositoryDeployKeyBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"ListRepositoryDeployKeys", "AddRepositoryDeployKey", "DeleteRepositoryDeployKey"} {
		path := "/golf.v1.RepositoryDeployKeyService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s boundary %d", method, w.Code)
			}
		}
		if got := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); got.Code != 403 {
			t.Fatal("read delegation reached key grant", got.Code)
		}
	}
}
func TestRepositoryDeployKeysPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := settingsFixtureRow()
	caller := User{ID: 42, Login: "alice"}
	permission := "owner"
	direct := false
	keyRow := deployKeyFixture(t)
	exists := false
	writes := 0
	mode := ""
	listMode := ""
	limitObserved := ""
	lookupCalls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 50})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(caller)
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{*row.Owner}})
		case "/api/v1/repos/alice/example":
			json.NewEncoder(w).Encode(row)
		case "/api/v1/repos/alice/example/collaborators/alice/permission", "/api/v1/repos/alice/example/collaborators/bob/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": caller})
		case "/api/v1/repos/alice/example/collaborators/bob":
			if direct {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
		case "/api/v1/repos/alice/example/keys":
			if r.Method == "POST" {
				var body struct {
					Title, Key string
					ReadOnly   *bool `json:"read_only"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || body.ReadOnly == nil {
					t.Error("bad key input")
					w.WriteHeader(400)
					return
				}
				writes++
				exists = true
				keyRow.Title = body.Title
				keyRow.Key = body.Key
				keyRow.ReadOnly = body.ReadOnly
				if mode == "lost-post" {
					w.WriteHeader(500)
					return
				}
				if mode == "wrong-mode" {
					other := !*body.ReadOnly
					keyRow.ReadOnly = &other
				}
				w.WriteHeader(201)
				json.NewEncoder(w).Encode(keyRow)
				return
			}
			limitObserved = r.URL.Query().Get("limit")
			rows := []forgeRepositoryDeployKey{}
			total := "0"
			if exists {
				rows = append(rows, keyRow)
				total = "1"
			}
			switch listMode {
			case "duplicate":
				rows = append(rows, keyRow)
				total = "2"
			case "missing-row":
				rows = nil
				total = "1"
			case "missing-mode":
				rows[0].ReadOnly = nil
			case "bad-count":
				total = "01"
			case "revoke":
				permission = "read"
				row.Permissions.Admin = false
			case "replace":
				row.ID++
			}
			w.Header().Set("X-Total-Count", total)
			json.NewEncoder(w).Encode(rows)
		case "/api/v1/repos/alice/example/keys/9007199254740993":
			if r.Method == "DELETE" {
				writes++
				exists = false
				if mode == "lost-delete" {
					w.WriteHeader(500)
				} else {
					w.WriteHeader(204)
				}
				return
			}
			lookupCalls++
			if !exists {
				w.WriteHeader(404)
				return
			}
			if mode == "readback-denied" {
				w.WriteHeader(403)
				return
			}
			if mode == "readback-revoke" {
				permission = "read"
				row.Permissions.Admin = false
			}
			json.NewEncoder(w).Encode(keyRow)
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), caller, "pat", "deploy-keys-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "deploy-keys-fixture"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	nativeKey := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	get := func() *golfv1.RepositoryAccess {
		r := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: nativeKey})
		r.Header().Set("Cookie", cookie)
		got, e := s.GetRepositoryAccess(ctx, r)
		if e != nil {
			t.Fatal(e)
		}
		return got.Msg.Access
	}
	access := get()
	add := func(a *golfv1.RepositoryAccess, ro *bool) (*connect.Response[golfv1.AddRepositoryDeployKeyResponse], error) {
		r := connect.NewRequest(&golfv1.AddRepositoryDeployKeyRequest{Repository: nativeKey, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, Title: "Deployment", PublicKey: keyRow.Key, ReadOnly: ro})
		r.Header().Set("Cookie", cookie)
		return s.AddRepositoryDeployKey(ctx, r)
	}
	list := func(a *golfv1.RepositoryAccess) (*connect.Response[golfv1.ListRepositoryDeployKeysResponse], error) {
		r := connect.NewRequest(&golfv1.ListRepositoryDeployKeysRequest{Repository: nativeKey, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, Page: &golfv1.PageRequest{Page: 1, Limit: 100}})
		r.Header().Set("Cookie", cookie)
		return s.ListRepositoryDeployKeys(ctx, r)
	}
	remove := func(a *golfv1.RepositoryAccess, k *golfv1.RepositoryDeployKey) (*connect.Response[golfv1.DeleteRepositoryDeployKeyResponse], error) {
		r := connect.NewRequest(&golfv1.DeleteRepositoryDeployKeyRequest{Repository: nativeKey, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, KeyId: k.Id, ExpectedKeyRevision: k.Revision})
		r.Header().Set("Cookie", cookie)
		return s.DeleteRepositoryDeployKey(ctx, r)
	}
	ro := true
	rw := false
	if _, err = add(access, nil); connect.CodeOf(err) != connect.CodeInvalidArgument || writes != 0 {
		t.Fatal("undeclared access dispatched", err)
	}
	got, err := add(access, &ro)
	if err != nil || !got.Msg.Key.ReadOnly || writes != 1 || lookupCalls != 1 {
		t.Fatal("read-only grant/readback", err)
	}
	inventory, err := list(access)
	if err != nil || len(inventory.Msg.Keys) != 1 || limitObserved != "50" || inventory.Msg.RepositoryId != access.RepositoryId {
		t.Fatal("bounded list", err)
	}
	for _, kind := range []string{"duplicate", "missing-row", "missing-mode", "bad-count"} {
		mu.Lock()
		listMode = kind
		mu.Unlock()
		if _, err = list(access); err == nil {
			t.Fatal("malformed inventory accepted", kind)
		}
	}
	mu.Lock()
	listMode = ""
	mu.Unlock()
	stale := proto.Clone(got.Msg.Key).(*golfv1.RepositoryDeployKey)
	stale.Revision = accessRevision("stale")
	if _, err = remove(access, stale); connect.CodeOf(err) != connect.CodeFailedPrecondition || writes != 1 {
		t.Fatal("stale association dispatched", err)
	}
	shared := proto.Clone(got.Msg.Key).(*golfv1.RepositoryDeployKey)
	shared.Id = shared.PublicKeyId
	if _, err = remove(access, shared); connect.CodeOf(err) != connect.CodeNotFound || writes != 1 {
		t.Fatal("shared public-key ID dispatched removal", err)
	}
	removed, err := remove(access, got.Msg.Key)
	if err != nil || removed.Msg.KeyId != got.Msg.Key.Id || writes != 2 || exists {
		t.Fatal("association removal", err)
	}
	mu.Lock()
	mode = "lost-post"
	mu.Unlock()
	if _, err = add(access, &rw); err == nil || writes != 3 || !exists {
		t.Fatal("accepted lost POST hidden or retried", err)
	}
	mu.Lock()
	mode = ""
	mu.Unlock()
	inventory, err = list(access)
	if err != nil || inventory.Msg.Keys[0].ReadOnly {
		t.Fatal("explicit inspection of uncertain write", err)
	}
	mu.Lock()
	mode = "lost-delete"
	mu.Unlock()
	if _, err = remove(access, inventory.Msg.Keys[0]); err == nil || writes != 4 || exists {
		t.Fatal("accepted lost DELETE hidden or retried", err)
	}
	mu.Lock()
	mode = "wrong-mode"
	mu.Unlock()
	if _, err = add(access, &ro); err == nil || writes != 5 {
		t.Fatal("read-only mismatch called success", err)
	}
	mu.Lock()
	mode = "readback-denied"
	mu.Unlock()
	if _, err = add(access, &ro); err == nil || writes != 6 {
		t.Fatal("denied readback called success", err)
	}
	mu.Lock()
	mode = "readback-revoke"
	mu.Unlock()
	if _, err = add(access, &ro); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 7 {
		t.Fatal("post-write authority loss leaked receipt", err)
	}
	mu.Lock()
	mode = ""
	permission = "owner"
	row.Permissions.Admin = true
	listMode = "replace"
	mu.Unlock()
	if _, err = list(access); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("replacement native repository disclosed", err)
	}
	mu.Lock()
	listMode = ""
	row.ID--
	caller = User{ID: 77, Login: "bob"}
	permission = "owner"
	direct = true
	mu.Unlock()
	// An exceptional native site-admin owner permission is not the actual owner.
	session2, e := s.createSession(t.Context(), caller, "pat", "deploy-keys-fixture", "")
	if e != nil {
		t.Fatal(e)
	}
	cookie = s.sessionCookie(session2.Value, session2.Expires, 3600).String()
	if _, err = add(access, &ro); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 7 {
		t.Fatal("site admin bypass dispatched", err)
	}
	mu.Lock()
	permission = "admin"
	mu.Unlock()
	adminAccess := get()
	if !adminAccess.CanManage {
		t.Fatal("direct admin denied")
	}
	if _, err = list(adminAccess); err != nil {
		t.Fatal("direct admin read denied", err)
	}
	if _, err = add(adminAccess, &rw); err != nil || writes != 8 {
		t.Fatal("qualified direct admin could not add", err)
	}
	mu.Lock()
	direct = false
	mu.Unlock()
	if _, err = add(adminAccess, &ro); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 8 {
		t.Fatal("inherited admin bypass dispatched", err)
	}
	if strconv.FormatInt(keyRow.KeyID, 10) == strconv.FormatInt(keyRow.ID, 10) {
		t.Fatal("fixture must distinguish association from public key")
	}
}
