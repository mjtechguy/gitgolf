package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func grantFixtureRequest() *golfv1.CreateAutomationGrantRequest {
	return &golfv1.CreateAutomationGrantRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, ExpectedRepositoryId: "9007199254740993", ExpectedOwnerId: "42", NativeToken: "independent-grant-token", Branches: []string{"main"}, WorkflowPaths: []string{runWorkflowPath}, ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), IdempotencyKey: uuid.NewString()}
}
func TestAutomationGrantValidation(t *testing.T) {
	now := time.Now()
	if _, _, _, err := validateAutomationGrant(grantFixtureRequest(), now); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*golfv1.CreateAutomationGrantRequest){
		func(m *golfv1.CreateAutomationGrantRequest) { m.IdempotencyKey = "" },
		func(m *golfv1.CreateAutomationGrantRequest) { m.ExpectedRepositoryId = "01" },
		func(m *golfv1.CreateAutomationGrantRequest) { m.ExpectedOwnerId = "0" },
		func(m *golfv1.CreateAutomationGrantRequest) { m.NativeToken = "bad token" },
		func(m *golfv1.CreateAutomationGrantRequest) { m.NativeToken = strings.Repeat("x", 513) },
		func(m *golfv1.CreateAutomationGrantRequest) { m.ExpiresAt = now.Format(time.RFC3339Nano) },
		func(m *golfv1.CreateAutomationGrantRequest) {
			m.ExpiresAt = now.Add(31 * 24 * time.Hour).Format(time.RFC3339Nano)
		},
		func(m *golfv1.CreateAutomationGrantRequest) { m.Branches = []string{"*"} },
		func(m *golfv1.CreateAutomationGrantRequest) { m.Branches = []string{"main", "main"} },
		func(m *golfv1.CreateAutomationGrantRequest) { m.Branches = []string{"main..bad"} },
		func(m *golfv1.CreateAutomationGrantRequest) { m.WorkflowPaths = []string{"../../secret"} },
		func(m *golfv1.CreateAutomationGrantRequest) { m.WorkflowPaths = nil },
	} {
		m := grantFixtureRequest()
		edit(m)
		if _, _, _, err := validateAutomationGrant(m, now); err == nil {
			t.Fatal("invalid scope accepted")
		}
	}
	keys, _ := ParseKeyring(testConfig("http://example.invalid").EncryptionKey, "", "")
	binding := automationCredentialBinding(uuid.NewString(), "http://forge.invalid", 42)
	ciphertext, id, err := keys.seal(automationRepositoryDomain, "sensitive", binding)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = keys.open(id, infrastructureConnectionDomain, ciphertext, binding); err == nil {
		t.Fatal("credential domain confusion")
	}
}
func TestAutomationGrantPostgres(t *testing.T) {
	db := testDatabase(t)
	var downgrade, foreign atomic.Bool
	var sourceMode atomic.Value
	sourceMode.Store("ordinary")
	var sourceBlobReads atomic.Int32
	row := settingsFixtureRow()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			id := int64(42)
			if foreign.Load() && r.Header.Get("Authorization") == "token independent-grant-token" {
				id = 84
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
		case "/api/v1/repos/alice/example", "/api/v1/repositories/9007199254740993":
			json.NewEncoder(w).Encode(row)
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{*row.Owner}})
		case "/api/v1/repos/alice/example/collaborators/alice/permission":
			permission := "owner"
			if downgrade.Load() {
				permission = "write"
			}
			json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": *row.Owner})
		case "/api/v1/repos/alice/example/commits":
			json.NewEncoder(w).Encode([]map[string]any{{"sha": strings.Repeat("a", 40)}})

		default:
			text, kind := workflowActionsFixture, ""
			switch sourceMode.Load().(string) {
			case "symlink", "submodule":
				kind = sourceMode.Load().(string)
			case "oversize":
				text = strings.Repeat("x", maxWorkflowBytes+1)
			case "lfs":
				text = "version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("b", 64) + "\nsize 99999999\n"
			}
			objects := workflowSourceObjects(strings.Repeat("a", 40), map[string]string{runWorkflowPath: text}, map[string]string{runWorkflowPath: kind})
			if strings.Contains(r.URL.Path, "/git/blobs/") {
				sourceBlobReads.Add(1)
				if sourceMode.Load().(string) == "corrupt" {
					for id, data := range objects.blobs {
						objects.blobs[id] = []byte(strings.Repeat("z", len(data)))
					}
				}
			}
			if !objects.serve(w, r, "/api/v1/repos/alice/example") {
				w.WriteHeader(404)
			}
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "browser-private-token", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "browser-private-token"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	create := func(m *golfv1.CreateAutomationGrantRequest) (*golfv1.AutomationGrant, error) {
		req := connect.NewRequest(m)
		req.Header().Set("Cookie", cookie)
		res, e := s.CreateAutomationGrant(ctx, req)
		if e != nil {
			return nil, e
		}
		return res.Msg.Grant, nil
	}
	m := grantFixtureRequest()
	foreign.Store(true)
	if _, err = create(m); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("foreign native token admitted", err)
	}
	foreign.Store(false)
	downgrade.Store(true)
	if _, err = create(m); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("writer created admin grant", err)
	}
	downgrade.Store(false)
	for _, mode := range []string{"symlink", "submodule", "oversize", "lfs", "corrupt"} {
		sourceMode.Store(mode)
		sourceBlobReads.Store(0)
		if _, err = create(grantFixtureRequest()); err == nil {
			t.Fatal("unsupported source created grant", mode)
		}
		if (mode == "symlink" || mode == "submodule" || mode == "oversize") && sourceBlobReads.Load() != 0 {
			t.Fatal("unsupported grant source fetched bytes", mode)
		}
		if (mode == "lfs" || mode == "corrupt") && sourceBlobReads.Load() != 1 {
			t.Fatal("bounded selected grant source not checked", mode)
		}
		var persisted int
		if err = db.QueryRow(`SELECT count(*) FROM golf_automation_grants`).Scan(&persisted); err != nil || persisted != 0 {
			t.Fatal("refused source persisted grant", mode, persisted, err)
		}
	}
	sourceMode.Store("ordinary")
	var wait sync.WaitGroup
	grants := make(chan *golfv1.AutomationGrant, 2)
	failures := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			g, e := create(m)
			if e != nil {
				failures <- e
			} else {
				grants <- g
			}
		}()
	}
	wait.Wait()
	close(grants)
	close(failures)
	for e := range failures {
		t.Fatal("concurrent create", e)
	}
	var grant *golfv1.AutomationGrant
	for g := range grants {
		if grant != nil && grant.Id != g.Id {
			t.Fatal("ambiguous replay duplicated grant")
		}
		grant = g
	}
	if grant == nil || grant.ExecutionState != "unavailable" || !grant.Enabled {
		t.Fatal("missing honest grant state")
	}
	var encrypted, binding []byte
	var keyID string
	if err = db.QueryRow(`SELECT encrypted_credential,credential_binding,credential_key_id FROM golf_automation_credentials WHERE grant_id=$1`, grant.Id).Scan(&encrypted, &binding, &keyID); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte(m.NativeToken)) {
		t.Fatal("plaintext credential retained")
	}
	plain, err := s.keyring.open(keyID, automationRepositoryDomain, encrypted, binding)
	if err != nil || plain != m.NativeToken {
		t.Fatal("bound delegated credential", err)
	}
	changed := grantFixtureRequest()
	changed.IdempotencyKey = m.IdempotencyKey
	if _, err = create(changed); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("changed intent replay", err)
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM golf_automation_grant_events`).Scan(&count); err != nil || count != 1 {
		t.Fatal("create audit not atomic", count, err)
	}
	if _, err = db.Exec(`UPDATE golf_automation_credentials SET credential_binding=$1`, bytes.Repeat([]byte{1}, 32)); err == nil {
		t.Fatal("credential binding mutable")
	}
	if _, err = db.Exec(`DELETE FROM golf_automation_grant_events`); err == nil {
		t.Fatal("audit mutable")
	}
	// Grant survives the initiating browser logout, but the logged-out cookie
	// cannot configure or disclose grants. This does not qualify execution.
	if err = s.logoutSession(t.Context(), session.Value); err != nil {
		t.Fatal(err)
	}
	if _, err = create(grantFixtureRequest()); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("dead browser mutated grant", err)
	}
	reloaded, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	s = reloaded
	session, err = s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "browser-private-token", "")
	if err != nil {
		t.Fatal(err)
	}
	cookie = s.sessionCookie(session.Value, session.Expires, 3600).String()
	list := func() (*golfv1.ListAutomationGrantsResponse, error) {
		req := connect.NewRequest(&golfv1.ListAutomationGrantsRequest{Repository: m.Repository})
		req.Header().Set("Cookie", cookie)
		res, e := s.ListAutomationGrants(ctx, req)
		if e != nil {
			return nil, e
		}
		return res.Msg, nil
	}
	inventory, err := list()
	if err != nil || len(inventory.Grants) != 1 || inventory.Grants[0].Id != grant.Id || !inventory.Grants[0].Enabled {
		t.Fatal("restart/logout durability", err)
	}
	downgrade.Store(true)
	if _, err = list(); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("nonadmin inventory disclosed", err)
	}
	downgrade.Store(false)
	revoke := func(revision string) (*golfv1.AutomationGrant, error) {
		req := connect.NewRequest(&golfv1.RevokeAutomationGrantRequest{Repository: m.Repository, GrantId: grant.Id, ExpectedRevision: revision})
		req.Header().Set("Cookie", cookie)
		res, e := s.RevokeAutomationGrant(ctx, req)
		if e != nil {
			return nil, e
		}
		return res.Msg.Grant, nil
	}
	// Roll back revoke if its audit append fails.
	if _, err = db.Exec(`CREATE FUNCTION reject_grant_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_grant_fixture BEFORE INSERT ON golf_automation_grant_events FOR EACH ROW EXECUTE FUNCTION reject_grant_fixture()`); err != nil {
		t.Fatal(err)
	}
	if _, err = revoke("1"); err == nil {
		t.Fatal("unaudited revoke committed")
	}
	if _, err = db.Exec(`DROP TRIGGER reject_grant_fixture ON golf_automation_grant_events`); err != nil {
		t.Fatal(err)
	}
	inventory, err = list()
	if err != nil || !inventory.Grants[0].Enabled || inventory.Grants[0].Revision != "1" {
		t.Fatal("failed revoke retained mutation", err)
	}
	revoked, err := revoke("1")
	if err != nil || revoked.Enabled || revoked.Revision != "2" || revoked.RevocationEpoch != "2" {
		t.Fatal("revoke fencing", err)
	}
	if _, err = revoke("1"); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale revoke", err)
	}
	if _, err = revoke("2"); err != nil {
		t.Fatal("same revocation replay", err)
	}
	// A PAT-only sponsor's remaining grant must be revoked during recovery.
	other, err := create(grantFixtureRequest())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = InvalidateRestoredSessions(t.Context(), db, strings.Repeat("a", 32)); err != nil {
		t.Fatal("recovery grant quarantine", err)
	}
	var enabled bool
	if err = db.QueryRow(`SELECT enabled FROM golf_automation_grants WHERE id=$1`, other.Id).Scan(&enabled); err != nil || enabled {
		t.Fatal("recovery preserved automatic authority", err)
	}
	var action string
	if err = db.QueryRow(`SELECT action FROM golf_automation_grant_events WHERE grant_id=$1 ORDER BY revision DESC LIMIT 1`, other.Id).Scan(&action); err != nil || action != "RECOVERY_REVOKED" {
		t.Fatal("recovery attribution", err)
	}
	// Disable/re-enable a local sponsor cannot revive delegated grants.
	local, err := ManageLocalAccount(t.Context(), db, s.keyring, s.config.ForgeURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "browser-private-token"})
	if err != nil {
		t.Fatal(err)
	}
	session, err = s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "browser-private-token", "")
	if err != nil {
		t.Fatal(err)
	}
	cookie = s.sessionCookie(session.Value, session.Expires, 3600).String()
	active, err := create(grantFixtureRequest())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE golf_local_accounts SET disabled_at=clock_timestamp() WHERE id=$1`, local.ID); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT enabled FROM golf_automation_grants WHERE id=$1`, active.Id).Scan(&enabled); err != nil || enabled {
		t.Fatal("sponsor disable preserved grant", err)
	}
	if _, err = create(grantFixtureRequest()); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("disabled local sponsor delegated via PAT", err)
	}
	if _, err = db.Exec(`UPDATE golf_local_accounts SET disabled_at=NULL WHERE id=$1`, local.ID); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT enabled FROM golf_automation_grants WHERE id=$1`, active.Id).Scan(&enabled); err != nil || enabled {
		t.Fatal("re-enable restored revoked authority", err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatal("grant itself started commands", err)
	}
}

// Test the real HTTP boundary as well as direct domain methods: new procedure
// registration must not accidentally return404 or make it public.
func TestAutomationGrantHTTPBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.AutomationGrantServiceListAutomationGrantsProcedure, golfv1connect.AutomationGrantServiceCreateAutomationGrantProcedure, golfv1connect.AutomationGrantServiceRevokeAutomationGrantProcedure} {
		for _, withOrigin := range []bool{false, true} {
			r := httptest.NewRequest(http.MethodPost, "/rpc"+procedure, strings.NewReader("{}"))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			if withOrigin {
				r.Header.Set("Origin", s.config.PublicURL)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			expected := 403
			if withOrigin {
				expected = 401
			}
			if w.Code != expected || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("grant route/auth boundary", procedure, w.Code)
			}
		}
	}
}
