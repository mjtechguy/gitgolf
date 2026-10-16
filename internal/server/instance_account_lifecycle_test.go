package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/encoding/protojson"
)

const lifecyclePassword = "Replacement Golf password 84!"

func lifecycleRequest(s *Server, session loginResult, procedure string, input map[string]string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(input)
	req := httptest.NewRequest(http.MethodPost, "/rpc"+procedure, bytes.NewReader(body))
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

func lifecycleEnrollment() map[string]string {
	return map[string]string{"username": "bob", "email": "BOB@example.test", "password": localTestPassword, "forgeToken": "bob-management-token", "expectedNativeUserId": "84", "passwordConfirmation": localTestPassword}
}
func lifecycleChange(account, version string) map[string]string {
	return map[string]string{"accountId": account, "expectedCredentialVersion": version, "password": lifecyclePassword, "passwordConfirmation": localTestPassword}
}

func TestInstanceLifecycleBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure} {
		if response := lifecycleRequest(s, loginResult{}, procedure, nil); response.Code != 401 {
			t.Fatal("anonymous reached lifecycle", response.Code)
		}
		if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), procedure, "malformed"); response.Code != 403 {
			t.Fatal("delegated credential reached lifecycle", response.Code)
		}
		req := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
		req.Header.Set("Origin", "https://other.invalid")
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, req)
		if response.Code != 403 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("origin boundary", response.Code)
		}
	}
}

func TestInstanceLifecycleEnrollmentResetEnablePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	actorSession, actorUser, _ := f.id(t, admin)
	response := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, lifecycleEnrollment())
	if response.Code != 200 {
		t.Fatal("enrollment failed", response.Code)
	}
	var created golfv1.EnrollRegularLocalAccountResponse
	if err := protojson.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Account.NativeUserId != "84" || created.Account.Username != "bob" || created.Account.Email != "bob@example.test" || created.Account.IsInstanceAdmin || created.Account.Disabled || created.Account.CredentialVersion != "1" || created.SessionsRevoked != 0 || created.OperationId == "" {
		t.Fatal("incorrect ordinary enrollment metadata")
	}
	row, err := database.New(f.db).GetLocalAccount(t.Context(), database.GetLocalAccountParams{Username: "bob", ForgeURL: f.s.config.ForgeURL})
	if err != nil {
		t.Fatal(err)
	}
	if row.PasswordHash == localTestPassword || bytes.Contains(row.EncryptedForgeToken, []byte("bob-management-token")) {
		t.Fatal("plaintext persisted")
	}
	decrypted, err := f.s.keyring.open(row.CredentialKeyID, localAccountDomain, row.EncryptedForgeToken, row.CredentialBinding)
	if err != nil || decrypted != "bob-management-token" {
		t.Fatal("mapped token did not round-trip")
	}
	bob := localLogin(t, f, "bob")
	secondBob := localLogin(t, f, "bob")
	delegate := issueApiCredential(t, apiManagementClient(t, f, bob), "dependent fixture", 0)
	response = lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, lifecycleChange(created.Account.Id, "1"))
	var reset golfv1.ResetRegularLocalPasswordResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &reset) != nil || reset.SessionsRevoked != 2 || reset.Account.CredentialVersion != "2" || reset.Account.Disabled {
		t.Fatal("reset did not retain state and revoke exact sessions", response.Code)
	}
	for _, session := range []loginResult{bob, secondBob} {
		if _, err := f.s.sessionCredential(t.Context(), session.Value); !errors.Is(err, errUnauthenticated) {
			t.Fatal("reset retained local session")
		}
	}
	if r := apiRequest(f.s, delegate.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); r.Code != 401 {
		t.Fatal("reset retained dependent bearer", r.Code)
	}
	if _, err := f.s.loginLocalSession(t.Context(), "bob", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("old password survived reset")
	}
	if _, err := f.s.loginLocalSession(t.Context(), "bob@example.test", lifecyclePassword, ""); err != nil {
		t.Fatal("replacement password/alias rejected", err)
	}
	if r := disableAccountRequest(f.s, admin, created.Account.Id, "2", localTestPassword); r.Code != 200 {
		t.Fatal("disable before re-enable", r.Code)
	}
	response = lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, lifecycleChange(created.Account.Id, "3"))
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &reset) != nil || !reset.Account.Disabled || reset.Account.CredentialVersion != "4" || reset.Account.DisabledAt == nil {
		t.Fatal("password reset reactivated disabled account", response.Code)
	}
	input := lifecycleChange(created.Account.Id, "4")
	input["forgeToken"] = "alice-management-token"
	if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure, input); r.Code != 400 {
		t.Fatal("enable replaced immutable native identity", r.Code)
	}
	input["forgeToken"] = "bob-management-token"
	response = lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure, input)
	var enabled golfv1.EnableRegularLocalAccountResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &enabled) != nil || enabled.Account.Disabled || enabled.Account.DisabledAt != nil || enabled.Account.CredentialVersion != "5" || enabled.Account.NativeUserId != "84" || enabled.Account.IsInstanceAdmin {
		t.Fatal("re-enable did not preserve immutable ordinary identity", response.Code)
	}
	after, err := database.New(f.db).GetLocalAccount(t.Context(), database.GetLocalAccountParams{Username: "bob", ForgeURL: f.s.config.ForgeURL})
	if err != nil || !bytes.Equal(after.CredentialBinding, row.CredentialBinding) || after.UserID != row.UserID {
		t.Fatal("historical credential binding changed")
	}
	if _, err := f.s.loginLocalSession(t.Context(), "bob", lifecyclePassword, ""); err != nil {
		t.Fatal("enabled account could not sign in", err)
	}
	var events, bound int
	if err := f.db.QueryRow(`SELECT count(*),count(*) FILTER (WHERE actor_user_id=$1 AND actor_session_id=$2) FROM golf_local_account_events WHERE account_id=$3 AND action IN ('ADMIN_CREATED','ADMIN_PASSWORD_RESET','ADMIN_ENABLED')`, actorUser, actorSession, row.ID).Scan(&events, &bound); err != nil || events != 4 || bound != events {
		t.Fatal("actor lifecycle audit mismatch", err, events, bound)
	}
	for _, secret := range []string{localTestPassword, lifecyclePassword, "management-token", "password_hash", "encrypted_forge_token"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatal("secret response projection")
		}
	}
}

func TestInstanceLifecycleRoleAndIdentityGuardsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice := enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	member := localLogin(t, f, "bob")
	for _, session := range []loginResult{member, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		for _, procedure := range []string{golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure} {
			if r := lifecycleRequest(f.s, session, procedure, lifecycleChange(bob.ID, "1")); r.Code != 403 {
				t.Fatal("non-local-admin reached lifecycle", r.Code)
			}
		}
	}
	input := lifecycleChange(alice.ID, "1")
	input["forgeToken"] = "alice-management-token"
	for _, procedure := range []string{golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure} {
		if r := lifecycleRequest(f.s, admin, procedure, input); r.Code != 403 {
			t.Fatal("administrator/self target changed", r.Code)
		}
	}
	input = lifecycleEnrollment()
	input["expectedNativeUserId"] = "42"
	if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, input); r.Code != 400 {
		t.Fatal("enrollment accepted wrong expected native identity", r.Code)
	}
	input["forgeToken"] = "alice-management-token"
	if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, input); r.Code != 403 {
		t.Fatal("enrollment adopted actor native identity", r.Code)
	}
	input = lifecycleChange(bob.ID, "1")
	input["passwordConfirmation"] = "This is not the actor password!"
	if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, input); r.Code != 403 {
		t.Fatal("wrong administrator password accepted", r.Code)
	}
	input = lifecycleChange(bob.ID, "1")
	input["forgeToken"] = "bob-management-token"
	if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure, input); r.Code != 400 {
		t.Fatal("already enabled target accepted", r.Code)
	}
}

func TestInstanceLifecycleConcurrentResetPostgres(t *testing.T) {
	f := newManagementFixture(t)
	// Lower target ID exercises sorted user locking rather than actor-first.
	bob := enrollLocal(t, f, "bob", false)
	enrollLocal(t, f, "alice", true)
	admin := localLogin(t, f, "alice")
	localLogin(t, f, "bob")
	var wait sync.WaitGroup
	responses := make(chan int, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			responses <- lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, lifecycleChange(bob.ID, "1")).Code
		}()
	}
	wait.Wait()
	close(responses)
	statuses := map[int]int{}
	for status := range responses {
		statuses[status]++
	}
	if statuses[200] != 1 || statuses[400] != 1 {
		t.Fatal("concurrent reset did not fence stale version", statuses)
	}
	var count, version, revoked int
	if err := f.db.QueryRow(`SELECT count(*),max(credential_version),sum(sessions_revoked) FROM golf_local_account_events WHERE account_id=$1 AND action='ADMIN_PASSWORD_RESET'`, bob.ID).Scan(&count, &version, &revoked); err != nil || count != 1 || version != 2 || revoked != 1 {
		t.Fatal("duplicate or incorrect reset audit", err)
	}
}

func TestInstanceLifecycleAuditRollbackPostgres(t *testing.T) {
	for _, action := range []string{"ADMIN_CREATED", "ADMIN_PASSWORD_RESET", "ADMIN_ENABLED"} {
		t.Run(action, func(t *testing.T) {
			f := newManagementFixture(t)
			enrollLocal(t, f, "alice", true)
			admin := localLogin(t, f, "alice")
			procedure, input := golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, lifecycleEnrollment()
			var bob LocalAccountResult
			var session loginResult
			if action != "ADMIN_CREATED" {
				bob = enrollLocal(t, f, "bob", false)
				session = localLogin(t, f, "bob")
				procedure, input = golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, lifecycleChange(bob.ID, "1")
				if action == "ADMIN_ENABLED" {
					var err error
					bob, err = ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "bob"})
					if err != nil {
						t.Fatal(err)
					}
					procedure, input = golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure, lifecycleChange(bob.ID, bob.CredentialVersion)
					input["forgeToken"] = "bob-management-token"
				}
			}
			if _, err := f.db.Exec(`CREATE FUNCTION reject_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'ADMIN_%' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_lifecycle BEFORE INSERT ON golf_local_account_events FOR EACH ROW EXECUTE FUNCTION reject_lifecycle()`); err != nil {
				t.Fatal(err)
			}
			if r := lifecycleRequest(f.s, admin, procedure, input); r.Code != 503 {
				t.Fatal("audit write failure accepted", r.Code)
			}
			var count int
			if err := f.db.QueryRow(`SELECT count(*) FROM golf_local_account_events WHERE action LIKE 'ADMIN_%'`).Scan(&count); err != nil || count != 0 {
				t.Fatal("failed transaction left audit")
			}
			if action == "ADMIN_CREATED" {
				if err := f.db.QueryRow(`SELECT count(*) FROM golf_users WHERE forge_user_id=84`).Scan(&count); err != nil || count != 0 {
					t.Fatal("failed enrollment left partial identity")
				}
				return
			}
			var version string
			var disabled bool
			if err := f.db.QueryRow(`SELECT credential_version::text,disabled_at IS NOT NULL FROM golf_local_accounts WHERE id=$1`, bob.ID).Scan(&version, &disabled); err != nil || version != bob.CredentialVersion || disabled != bob.Disabled {
				t.Fatal("failed audit changed account", err)
			}
			if action == "ADMIN_PASSWORD_RESET" {
				if _, err := f.s.sessionCredential(t.Context(), session.Value); err != nil {
					t.Fatal("failed audit removed session", err)
				}
			}
		})
	}
}

func TestInstanceLifecycleProviderWaitRevocationPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	f.mode.Store(3)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, lifecycleChange(bob.ID, "1"))
	}()
	<-f.entered
	_, _, hash := f.id(t, admin)
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	close(f.resume)
	if r := <-done; r.Code != 401 {
		t.Fatal("revoked actor mutated after provider wait", r.Code)
	}
	var version int
	if err := f.db.QueryRow("SELECT credential_version FROM golf_local_accounts WHERE id=$1", bob.ID).Scan(&version); err != nil || version != 1 {
		t.Fatal("revoked actor changed target", err)
	}
}

func TestInstanceLifecycleValidationPostgres(t *testing.T) {
	for _, change := range []struct{ field, value string }{{"username", "UPPERCASE"}, {"email", "Name <mail@example.test>"}, {"expectedNativeUserId", "084"}, {"password", "short"}, {"forgeToken", "bad token"}} {
		t.Run(change.field, func(t *testing.T) {
			f := newManagementFixture(t)
			enrollLocal(t, f, "alice", true)
			admin := localLogin(t, f, "alice")
			input := lifecycleEnrollment()
			input[change.field] = change.value
			if r := lifecycleRequest(f.s, admin, golfv1connect.InstanceAdminServiceEnrollRegularLocalAccountProcedure, input); r.Code != 400 {
				t.Fatal("invalid enrollment accepted", r.Code)
			}
			var count int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_local_accounts").Scan(&count); err != nil || count != 1 {
				t.Fatal("invalid enrollment persisted")
			}
		})
	}
}

func TestInstanceLifecycleForeignForgePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	if _, err := f.db.Exec(`UPDATE golf_users SET forge_url='https://different.invalid' WHERE id=$1`, bob.UserID); err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.InstanceAdminServiceResetRegularLocalPasswordProcedure, golfv1connect.InstanceAdminServiceEnableRegularLocalAccountProcedure} {
		if r := lifecycleRequest(f.s, admin, procedure, lifecycleChange(bob.ID, "1")); r.Code != 404 {
			t.Fatal("foreign forge target reached lifecycle", r.Code)
		}
	}
}
