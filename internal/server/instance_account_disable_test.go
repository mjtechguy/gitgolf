package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func disableAccountRequest(s *Server, session loginResult, account, version, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"accountId": account, "expectedCredentialVersion": version, "passwordConfirmation": password})
	req := httptest.NewRequest(http.MethodPost, "/rpc"+golfv1connect.InstanceAdminServiceDisableLocalAccountProcedure, strings.NewReader(string(body)))
	req.Header.Set("Origin", s.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		req.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	return response
}

func TestInstanceDisableBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response := disableAccountRequest(s, loginResult{}, "1", "1", "private fixture password"); response.Code != 401 {
		t.Fatal("missing session reached body", response.Code)
	}
	if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), golfv1connect.InstanceAdminServiceDisableLocalAccountProcedure, "malformed"); response.Code != 403 {
		t.Fatal("bearer reached disable", response.Code)
	}
	req := httptest.NewRequest("POST", "/rpc"+golfv1connect.InstanceAdminServiceDisableLocalAccountProcedure, strings.NewReader("malformed"))
	req.Header.Set("Origin", "https://other.invalid")
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	if response.Code != 403 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("Origin boundary", response.Code)
	}
}

func TestInstanceDisableAtomicPostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice := enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	bobSession := localLogin(t, f, "bob")
	secondBob := localLogin(t, f, "bob")
	bobDelegate := issueApiCredential(t, apiManagementClient(t, f, bobSession), "target dependent read", 0)
	_, actorUserID, _ := f.id(t, admin)
	actorSessionID, _, _ := f.id(t, admin)
	for _, session := range []loginResult{bobSession, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if response := disableAccountRequest(f.s, session, bob.ID, "1", localTestPassword); response.Code != 403 {
			t.Fatal("non-admin/session kind disabled account", response.Code)
		}
	}
	if response := disableAccountRequest(f.s, admin, bob.ID, "1", "A wrong confirmation password!"); response.Code != 403 {
		t.Fatal("wrong confirmation", response.Code)
	}
	if response := disableAccountRequest(f.s, admin, alice.ID, "1", localTestPassword); response.Code != 403 {
		t.Fatal("administrator target was not protected", response.Code)
	}
	if response := disableAccountRequest(f.s, admin, bob.ID, "2", localTestPassword); response.Code != 400 {
		t.Fatal("stale state was not rejected", response.Code)
	}
	var wait sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			responses <- disableAccountRequest(f.s, admin, bob.ID, "1", localTestPassword)
		}()
	}
	wait.Wait()
	close(responses)
	successes, conflicts := 0, 0
	for response := range responses {
		if response.Code == 200 {
			successes++
			var result golfv1.DisableLocalAccountResponse
			if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Account.Id != bob.ID || !result.Account.Disabled || result.Account.CredentialVersion != "2" || result.SessionsRevoked != 2 || result.OperationId == "" {
				t.Fatal("wrong committed outcome")
			}
			if strings.Contains(response.Body.String(), localTestPassword) || strings.Contains(response.Body.String(), "management-token") {
				t.Fatal("credential exposed")
			}
		} else if response.Code == 400 {
			conflicts++
		} else {
			t.Fatal("unexpected concurrent outcome", response.Code)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("concurrent disables did not version fence")
	}
	for _, session := range []loginResult{bobSession, secondBob} {
		if response := instanceAccountsRequest(f.s, session, "{}"); response.Code != 401 {
			t.Fatal("target session survived", response.Code)
		}
	}
	if response := apiRequest(f.s, bobDelegate.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); response.Code != 401 {
		t.Fatal("dependent credential survived", response.Code)
	}
	if response := instanceAccountsRequest(f.s, admin, "{}"); response.Code != 200 {
		t.Fatal("caller session revoked", response.Code)
	}
	var count int
	var recordedUser, recordedSession int64
	if err := f.db.QueryRow("SELECT count(*),min(actor_user_id),min(actor_session_id) FROM golf_local_account_events WHERE account_id=$1 AND action='ADMIN_DISABLED'", bob.ID).Scan(&count, &recordedUser, &recordedSession); err != nil {
		t.Fatal(err)
	}
	if count != 1 || recordedUser != actorUserID || recordedSession != actorSessionID {
		t.Fatal("missing actor-bound atomic event")
	}
	// Historical actor IDs must not prevent subsequent administrator logout.
	client := f.client(t, admin)
	if _, err := client.Logout(t.Context(), connect.NewRequest(&golfv1.LogoutRequest{})); err != nil {
		t.Fatal("actor audit blocked logout", err)
	}
}

func TestInstanceDisableRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	user := localLogin(t, f, "bob")
	_, err := f.db.Exec(`CREATE FUNCTION reject_admin_disable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ADMIN_DISABLED' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_admin_disable BEFORE INSERT ON golf_local_account_events FOR EACH ROW EXECUTE FUNCTION reject_admin_disable()`)
	if err != nil {
		t.Fatal(err)
	}
	if response := disableAccountRequest(f.s, admin, bob.ID, "1", localTestPassword); response.Code != 503 {
		t.Fatal("audit failure not rejected", response.Code)
	}
	var disabled bool
	var version int64
	if err := f.db.QueryRow("SELECT disabled_at IS NOT NULL,credential_version FROM golf_local_accounts WHERE id=$1", bob.ID).Scan(&disabled, &version); err != nil {
		t.Fatal(err)
	}
	if disabled || version != 1 {
		t.Fatal("audit failure partly disabled target")
	}
	if _, err := f.s.sessionCredential(t.Context(), user.Value); err != nil {
		t.Fatal("rollback removed session", err)
	}
}

func TestInstanceDisableWaitRevocationPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	f.mode.Store(3)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- disableAccountRequest(f.s, admin, bob.ID, "1", localTestPassword) }()
	<-f.entered
	_, _, hash := f.id(t, admin)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	close(f.resume)
	if response := <-done; response.Code != 401 {
		t.Fatal("revoked caller disabled target", response.Code)
	}
	var version string
	if err := f.db.QueryRow("SELECT credential_version::text FROM golf_local_accounts WHERE id=$1", bob.ID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != "1" {
		t.Fatal("revoked caller mutated target")
	}
}
