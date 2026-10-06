package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func adminMFARequest(s *Server, session loginResult, body map[string]any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/rpc"+golfv1connect.InstanceAdminServiceResetRegularLocalMFAProcedure, strings.NewReader(string(data)))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		r.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func recoverySession(t *testing.T, f *managementFixture, name, code string) (loginResult, *http.Cookie) {
	t.Helper()
	w := mfaLoginRequest(f.s, "LoginWithPassword", map[string]string{"username": name, "password": localTestPassword}, nil)
	var result golfv1.LoginWithPasswordResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &result) != nil || !result.MfaRequired {
		t.Fatal("owned challenge", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("challenge cookie")
	}
	challenge := cookies[0]
	if code == "" {
		return loginResult{}, challenge
	}
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": code}, challenge)
	if w.Code != 200 {
		t.Fatal("owned factor session", w.Code)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == f.s.sessionCookie("", time.Time{}, 0).Name {
			return loginResult{Value: c.Value, Expires: time.Now().Add(time.Hour)}, challenge
		}
	}
	t.Fatal("authenticated session cookie missing")
	return loginResult{}, nil
}
func mfaResetFields(account LocalAccountResult) map[string]any {
	return map[string]any{"accountId": account.ID, "golfUserId": account.UserID, "nativeUserId": "84", "expectedCredentialVersion": "1", "expectedMfaVersion": "2", "expectedAdminMfaVersion": "0", "passwordConfirmation": localTestPassword, "reason": "Lost authenticator; support identity verified", "acknowledgeWarning": true}
}
func TestAdminMFARecoveryBoundary(t *testing.T) {
	s, e := New(testConfig("http://native.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	if w := adminMFARequest(s, loginResult{}, nil); w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("anonymous MFA reset", w.Code)
	}
	for _, prefix := range []string{apiTokenPrefix, apiWriteTokenPrefix} {
		if w := apiRequest(s, prefix+strings.Repeat("A", 43), golfv1connect.InstanceAdminServiceResetRegularLocalMFAProcedure, "malformed"); w.Code != 403 {
			t.Fatal("delegation reached MFA admin", w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/rpc"+golfv1connect.InstanceAdminServiceResetRegularLocalMFAProcedure, strings.NewReader("malformed"))
	r.Header.Set("Origin", "https://foreign.invalid")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("foreign origin", w.Code)
	}
}
func TestAdminMFARecoveryAuthorityAndEffectsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", true)
	subject := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	before := localLogin(t, f, "bob")
	_, codes := enableMFATest(t, f, "bob")
	if _, e := f.s.sessionCredential(t.Context(), before.Value); e == nil {
		t.Fatal("MFA setup session retained")
	}
	bob, _ := recoverySession(t, f, "bob", codes[0])
	second, _ := recoverySession(t, f, "bob", codes[1])
	_, pending := recoverySession(t, f, "bob", "")
	fields := mfaResetFields(subject)
	// Local users, matching native-token sessions and OAuth sessions cannot gain
	// Golf instance authority, even when mapped to the same administrator identity.
	for _, session := range []loginResult{bob, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if w := adminMFARequest(f.s, session, fields); w.Code != 403 {
			t.Fatal("non-global-admin recovery", w.Code)
		}
	}
	for _, change := range []struct {
		key    string
		value  any
		status int
	}{{"passwordConfirmation", "wrong Golf administrator password", 403}, {"acknowledgeWarning", false, 400}, {"reason", "", 400}, {"golfUserId", actor.UserID, 400}, {"nativeUserId", "999", 400}, {"expectedCredentialVersion", "2", 400}, {"expectedMfaVersion", "3", 400}, {"expectedAdminMfaVersion", "1", 400}} {
		copy := map[string]any{}
		for k, v := range fields {
			copy[k] = v
		}
		copy[change.key] = change.value
		if w := adminMFARequest(f.s, admin, copy); w.Code != change.status {
			t.Fatal("reset fence", change.key, w.Code)
		}
	}
	self := mfaResetFields(actor)
	self["nativeUserId"] = "42"
	if w := adminMFARequest(f.s, admin, self); w.Code != 403 {
		t.Fatal("self target", w.Code)
	}
	w := adminMFARequest(f.s, admin, fields)
	var out golfv1.ResetRegularLocalMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || out.Account.MfaEnabled || out.Account.MfaVersion != "3" || out.Account.CredentialVersion != "2" || out.SessionsRevoked != 2 || out.ChallengesRevoked != 1 || out.RecoveryCodesRevoked != 10 || out.OperationId == "" {
		t.Fatal("recovery effect", w.Code)
	}
	for _, session := range []loginResult{bob, second} {
		if _, e := f.s.sessionCredential(t.Context(), session.Value); e == nil {
			t.Fatal("target session retained")
		}
	}
	if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[2]}, pending); w.Code != 401 {
		t.Fatal("old target challenge retained", w.Code)
	}
	if _, e := f.s.sessionCredential(t.Context(), admin.Value); e != nil {
		t.Fatal("administrator session revoked", e)
	}
	if w := adminMFARequest(f.s, admin, fields); w.Code != 400 {
		t.Fatal("stale request repeated reset", w.Code)
	}
	legacy := mfaLoginRequest(f.s, "LoginWithPassword", map[string]string{"username": "bob", "password": localTestPassword}, nil)
	var logged golfv1.LoginWithPasswordResponse
	if legacy.Code != 200 || protojson.Unmarshal(legacy.Body.Bytes(), &logged) != nil || logged.User == nil || logged.MfaRequired {
		t.Fatal("password unexpectedly changed", legacy.Code)
	}
	var count int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_mfa_events WHERE action='admin_reset' AND account_id=$1 AND user_id=$2 AND actor_user_id=$3 AND actor_session_id IS NOT NULL AND operation_id=$4 AND reason=$5`, subject.ID, subject.UserID, actor.UserID, out.OperationId, fields["reason"]).Scan(&count); e != nil || count != 1 {
		t.Fatal("MFA actor/subject audit", e)
	}
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_local_account_events WHERE account_id=$1 AND action='ADMIN_MFA_RESET' AND actor_user_id=$2 AND operation_id=$3`, subject.ID, actor.UserID, out.OperationId).Scan(&count); e != nil || count != 1 {
		t.Fatal("account recovery audit", e)
	}
}
func TestAdminMFARecoveryEnrolledActorAndConcurrencyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", true)
	subject := enrollLocal(t, f, "bob", false)
	_, adminCodes := enableMFATest(t, f, "alice")
	_, _ = enableMFATest(t, f, "bob")
	admin, _ := recoverySession(t, f, "alice", adminCodes[0])
	fields := mfaResetFields(subject)
	fields["expectedAdminMfaVersion"] = "2"
	if w := adminMFARequest(f.s, admin, fields); w.Code != 401 {
		t.Fatal("admin missing own factor", w.Code)
	}
	fields["adminMfaCode"] = "wrong"
	if w := adminMFARequest(f.s, admin, fields); w.Code != 401 {
		t.Fatal("admin wrong factor", w.Code)
	}
	fields["expectedAdminMfaVersion"] = "1"
	fields["adminMfaCode"] = adminCodes[1]
	if w := adminMFARequest(f.s, admin, fields); w.Code != 400 {
		t.Fatal("admin stale own factor version", w.Code)
	}
	fields["expectedAdminMfaVersion"] = "2"
	var group sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() { defer group.Done(); codes <- adminMFARequest(f.s, admin, fields).Code }()
	}
	group.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code != 400 {
			t.Fatal("concurrent stale reset", code)
		}
	}
	if success != 1 {
		t.Fatal("reset dispatched twice", success)
	}
	var unused int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE account_id=$1 AND version=2 AND used_at IS NULL`, actor.ID).Scan(&unused); e != nil || unused != 8 {
		t.Fatal("admin factor consumption rollback/race", unused, e)
	}
	// The success keeps the administrator's current session, unlike own factor changes.
	if _, e := f.s.sessionCredential(t.Context(), admin.Value); e != nil {
		t.Fatal("admin factor-confirmed session lost", e)
	}
}
func TestAdminMFARecoveryDisabledTargetPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	subject := enrollLocal(t, f, "bob", false)
	_, _ = enableMFATest(t, f, "bob")
	admin := localLogin(t, f, "alice")
	if _, e := f.db.Exec(`UPDATE golf_local_accounts SET disabled_at=clock_timestamp(),credential_version=credential_version+1 WHERE id=$1`, subject.ID); e != nil {
		t.Fatal(e)
	}
	fields := mfaResetFields(subject)
	fields["expectedCredentialVersion"] = "2"
	w := adminMFARequest(f.s, admin, fields)
	var out golfv1.ResetRegularLocalMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || !out.Account.Disabled || out.Account.CredentialVersion != "3" {
		t.Fatal("disabled account reactivated", w.Code)
	}
	if _, e := f.s.loginLocalSession(t.Context(), "bob", localTestPassword, ""); e == nil {
		t.Fatal("disabled user signed in after MFA reset")
	}
}
func TestAdminMFAInventoryMetadataPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	subject := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	_, _ = enableMFATest(t, f, "bob")
	w := instanceAccountsRequest(f.s, admin, `{}`)
	var out golfv1.ListLocalAccountsResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || out.AdminMfaVersion != "0" || out.AdminMfaEnabled {
		t.Fatal("admin factor metadata", w.Code)
	}
	found := false
	for _, account := range out.Accounts {
		if account.Id == subject.ID {
			found = true
			if !account.MfaEnabled || account.MfaVersion != "2" || account.GolfUserId != subject.UserID {
				t.Fatal("subject MFA metadata")
			}
		}
	}
	if !found {
		t.Fatal("subject missing")
	}
	if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "recoveryCodes") {
		t.Fatal("MFA secrets in global inventory")
	}
}

func TestAdminMFARecoveryProtectedAdminTargetPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	target := enrollLocal(t, f, "bob", true)
	admin := localLogin(t, f, "alice")
	if w := adminMFARequest(f.s, admin, mfaResetFields(target)); w.Code != 403 {
		t.Fatal("protected administrator target", w.Code)
	}
}

func TestAdminMFARecoveryAuditFailureRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", true)
	subject := enrollLocal(t, f, "bob", false)
	_, adminCodes := enableMFATest(t, f, "alice")
	_, targetCodes := enableMFATest(t, f, "bob")
	admin, _ := recoverySession(t, f, "alice", adminCodes[0])
	target, _ := recoverySession(t, f, "bob", targetCodes[0])
	fields := mfaResetFields(subject)
	fields["expectedAdminMfaVersion"] = "2"
	fields["adminMfaCode"] = adminCodes[1]
	if _, e := f.db.Exec(`CREATE FUNCTION reject_admin_mfa_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin_reset' THEN RAISE EXCEPTION 'owned audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_admin_mfa_event BEFORE INSERT ON golf_mfa_events FOR EACH ROW EXECUTE FUNCTION reject_admin_mfa_event()`); e != nil {
		t.Fatal(e)
	}
	if w := adminMFARequest(f.s, admin, fields); w.Code != 503 {
		t.Fatal("audit failure accepted", w.Code)
	}
	var enabled bool
	var credential, factor int
	if e := f.db.QueryRow(`SELECT a.credential_version,m.version,m.enabled FROM golf_local_accounts a JOIN golf_local_mfa m ON m.account_id=a.id WHERE a.id=$1`, subject.ID).Scan(&credential, &factor, &enabled); e != nil || credential != 1 || factor != 2 || !enabled {
		t.Fatal("recovery partially committed", e)
	}
	if _, e := f.s.sessionCredential(t.Context(), target.Value); e != nil {
		t.Fatal("audit rollback removed target session", e)
	}
	var unused int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE account_id=$1 AND version=2 AND used_at IS NULL`, actor.ID).Scan(&unused); e != nil || unused != 9 {
		t.Fatal("failed reset consumed administrator recovery factor", unused, e)
	}
}
