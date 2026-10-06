package server

import (
	"bytes"
	"encoding/base32"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestMFATOTP(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	// RFC6238 SHA1 test vectors, truncated to the six digits used in provisioning.
	for _, v := range []struct {
		at   int64
		code string
	}{{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"}, {1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"}} {
		got, e := totpCode(secret, v.at/30)
		if e != nil || got != v.code {
			t.Fatal("RFC vector", v.at, got, e)
		}
		if _, ok := totpCounter(secret, v.code, time.Unix(v.at, 0), v.at/30); ok {
			t.Fatal("consumed counter accepted")
		}
	}
	if _, ok := totpCounter(secret, "<bad>", time.Now(), -1); ok {
		t.Fatal("malformed factor accepted")
	}
	c, e := totpCode(secret, 100)
	if e != nil {
		t.Fatal(e)
	}
	if _, ok := totpCounter(secret, c, time.Unix(3300, 0), -1); ok {
		t.Fatal("outside window accepted")
	}
}
func mfaLoginRequest(s *Server, method string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	payload, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/rpc/golf.v1.SessionService/"+method, bytes.NewReader(payload))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func beginMFAChallenge(t *testing.T, s *Server) *http.Cookie {
	t.Helper()
	w := mfaLoginRequest(s, "LoginWithPassword", map[string]string{"username": "alice", "password": localTestPassword}, nil)
	var out golfv1.LoginWithPasswordResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || !out.MfaRequired || out.User != nil {
		t.Fatal("password did not produce only challenge", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != s.mfaCookie("", time.Time{}, 0).Name || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].MaxAge != 300 {
		t.Fatal("pre-auth cookie boundary")
	}
	return cookies[0]
}
func TestLocalMFAPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	first := localLogin(t, f, "alice")
	other := localLogin(t, f, "alice")
	w := accountSecurityRequest(f.s, first, "GetOwnMFA", map[string]string{})
	var empty golfv1.GetOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &empty) != nil || empty.Mfa.Version != "0" || empty.Mfa.Enabled {
		t.Fatal("initial state", w.Code)
	}
	setup := map[string]string{"expectedVersion": "0", "passwordConfirmation": localTestPassword}
	w = accountSecurityRequest(f.s, first, "BeginOwnMFA", setup)
	var begun golfv1.BeginOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &begun) != nil || begun.Mfa.Version != "1" || len(begun.Secret) != 32 || !strings.HasPrefix(begun.ProvisioningUri, "otpauth://totp/") {
		t.Fatal("begin setup", w.Code)
	}
	var raw string
	if e := f.db.QueryRow(`SELECT encrypted_content::text FROM golf_notification_contents WHERE kind='mfa'`).Scan(&raw); e != nil || strings.Contains(raw, begun.Secret) {
		t.Fatal("plaintext secret persisted", e)
	}
	code, e := totpCode(begun.Secret, time.Now().Unix()/30)
	if e != nil {
		t.Fatal(e)
	}
	w = accountSecurityRequest(f.s, first, "ConfirmOwnMFA", map[string]string{"expectedVersion": "1", "passwordConfirmation": localTestPassword, "code": code})
	var enabled golfv1.ChangeOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &enabled) != nil || !enabled.RequiresLogin || !enabled.Mfa.Enabled || enabled.Mfa.Version != "2" || len(enabled.RecoveryCodes) != 10 || enabled.SessionsRevoked != 2 {
		t.Fatal("enable proof", w.Code, w.Body.String())
	}
	if _, e = f.s.sessionCredential(t.Context(), other.Value); e == nil {
		t.Fatal("old session survived MFA enable")
	}
	challenge := beginMFAChallenge(t, f.s)
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": code}, challenge)
	if w.Code != 401 {
		t.Fatal("enrollment counter reused", w.Code)
	}
	// Recovery factor produces a session and is consumed atomically.
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": enabled.RecoveryCodes[0]}, challenge)
	var signed golfv1.LoginWithPasswordResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &signed) != nil || signed.User == nil || signed.MfaRequired {
		t.Fatal("recovery login", w.Code)
	}
	var sessionCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == f.s.sessionCookie("", time.Time{}, 0).Name {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("missing authenticated cookie")
	}
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": enabled.RecoveryCodes[1]}, challenge)
	if w.Code != 401 {
		t.Fatal("consumed challenge replay", w.Code)
	}
	replay := beginMFAChallenge(t, f.s)
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": enabled.RecoveryCodes[0]}, replay)
	if w.Code != 401 {
		t.Fatal("recovery reused", w.Code)
	}
	// Two independent challenges race the same recovery digest; exactly one wins.
	left, right := beginMFAChallenge(t, f.s), beginMFAChallenge(t, f.s)
	var successes atomic.Int32
	var group sync.WaitGroup
	for _, c := range []*http.Cookie{left, right} {
		group.Add(1)
		go func(c *http.Cookie) {
			defer group.Done()
			if mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": enabled.RecoveryCodes[1]}, c).Code == 200 {
				successes.Add(1)
			}
		}(c)
	}
	group.Wait()
	if successes.Load() != 1 {
		t.Fatal("factor race", successes.Load())
	}
	// Metadata contains counts only, never secret/recovery plaintext.
	var expires time.Time
	if e = f.db.QueryRow(`SELECT expires_at FROM golf_sessions WHERE user_id=1 ORDER BY session_id LIMIT 1`).Scan(&expires); e != nil {
		expires = time.Now().Add(time.Hour)
	}
	current := loginResult{Value: sessionCookie.Value, Expires: expires}
	w = accountSecurityRequest(f.s, current, "GetOwnMFA", map[string]string{})
	var state golfv1.GetOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &state) != nil || state.Mfa.RemainingRecoveryCodes != 8 || strings.Contains(w.Body.String(), begun.Secret) {
		t.Fatal("safe current inventory", w.Code)
	}
	// Disable requires password and a fresh factor and invalidates current sessions.
	w = accountSecurityRequest(f.s, current, "DisableOwnMFA", map[string]string{"expectedVersion": "2", "passwordConfirmation": localTestPassword, "code": enabled.RecoveryCodes[2]})
	var disabled golfv1.ChangeOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &disabled) != nil || disabled.Mfa.Enabled || !disabled.RequiresLogin {
		t.Fatal("disable", w.Code)
	}
	if _, e = f.s.sessionCredential(t.Context(), current.Value); e == nil {
		t.Fatal("disable session retained")
	}
	legacy := mfaLoginRequest(f.s, "LoginWithPassword", map[string]string{"username": "alice", "password": localTestPassword}, nil)
	if legacy.Code != 200 || strings.Contains(legacy.Body.String(), "mfaRequired") {
		t.Fatal("password accounts regressed", legacy.Code)
	}
}
func TestLocalMFABoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"GetOwnMFA", "BeginOwnMFA", "ConfirmOwnMFA", "DisableOwnMFA", "RegenerateOwnMFARecovery"} {
		if w := accountSecurityRequest(s, loginResult{}, method, map[string]string{}); w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("unauthenticated MFA", method, w.Code)
		}
		if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.AccountSecurityService/"+method, "{}"); w.Code != 403 {
			t.Fatal("bearer reached own MFA", method, w.Code)
		}
	}
	w := mfaLoginRequest(s, "CompletePasswordMFA", map[string]string{"code": "123456"}, nil)
	if w.Code != 401 {
		t.Fatal("missing challenge", w.Code)
	}
	s.config.AllowInsecureCookies = false
	c := s.mfaCookie("test", time.Now(), 300)
	if c.Name != "__Host-golf_mfa_challenge" || !c.Secure || !c.HttpOnly || c.Path != "/" || c.Domain != "" {
		t.Fatal("production pre-auth cookie")
	}
}

func enableMFATest(t *testing.T, f *managementFixture, username string) (string, []string) {
	t.Helper()
	session := localLogin(t, f, username)
	w := accountSecurityRequest(f.s, session, "BeginOwnMFA", map[string]string{"expectedVersion": "0", "passwordConfirmation": localTestPassword})
	var setup golfv1.BeginOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &setup) != nil {
		t.Fatal("MFA fixture setup", w.Code)
	}
	code, e := totpCode(setup.Secret, time.Now().Unix()/30)
	if e != nil {
		t.Fatal(e)
	}
	w = accountSecurityRequest(f.s, session, "ConfirmOwnMFA", map[string]string{"expectedVersion": "1", "passwordConfirmation": localTestPassword, "code": code})
	var out golfv1.ChangeOwnMFAResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.RecoveryCodes) != 10 {
		t.Fatal("MFA fixture enable", w.Code)
	}
	return setup.Secret, out.RecoveryCodes
}
func TestLocalMFAFencesPostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice := enrollLocal(t, f, "alice", false)
	bob := enrollLocal(t, f, "bob", false)
	_, codes := enableMFATest(t, f, "alice")
	_, _ = enableMFATest(t, f, "bob")
	var original, foreign string
	if e := f.db.QueryRow(`SELECT active_content_id::text FROM golf_local_mfa WHERE account_id=$1`, alice.ID).Scan(&original); e != nil {
		t.Fatal(e)
	}
	if e := f.db.QueryRow(`SELECT active_content_id::text FROM golf_local_mfa WHERE account_id=$1`, bob.ID).Scan(&foreign); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`UPDATE golf_local_mfa SET active_content_id=$2 WHERE account_id=$1`, alice.ID, foreign); e != nil {
		t.Fatal(e)
	}
	challenge := beginMFAChallenge(t, f.s)
	if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[0]}, challenge); w.Code == 200 {
		t.Fatal("cross-account encrypted-secret pointer accepted")
	}
	if _, e := f.db.Exec(`UPDATE golf_local_mfa SET active_content_id=$2 WHERE account_id=$1`, alice.ID, original); e != nil {
		t.Fatal(e)
	}
	expired := beginMFAChallenge(t, f.s)
	hash, _ := sessionHash(expired.Value)
	if _, e := f.db.Exec(`UPDATE golf_mfa_login_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, hash); e != nil {
		t.Fatal(e)
	}
	if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[0]}, expired); w.Code != 401 {
		t.Fatal("expired pre-authentication accepted", w.Code)
	}
	// Invalid attempts consume the challenge-wide budget even when multiple callers race.
	bounded := beginMFAChallenge(t, f.s)
	for i := 0; i < 5; i++ {
		if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": "wrong"}, bounded); w.Code != 401 {
			t.Fatal("invalid factor", w.Code)
		}
	}
	if w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[0]}, bounded); w.Code != 401 {
		t.Fatal("exhausted challenge accepted", w.Code)
	}
	// A new challenge does not reset the account-wide factor guessing window.
	var attempts int
	if e := f.db.QueryRow(`SELECT attempts FROM golf_mfa_attempts WHERE account_id=$1`, alice.ID).Scan(&attempts); e != nil {
		t.Fatal(e)
	}
	for i := attempts; i < 10; i++ {
		if e := f.s.reserveMFAAttempt(t.Context(), mfaTestID(t, alice.ID)); e != nil {
			t.Fatal(e)
		}
	}
	if e := f.s.reserveMFAAttempt(t.Context(), mfaTestID(t, alice.ID)); e != errLocalRateLimited {
		t.Fatal("global factor budget", e)
	}
	if _, e := f.db.Exec(`UPDATE golf_mfa_attempts SET window_start=clock_timestamp()-interval '6 minutes' WHERE account_id=$1`, alice.ID); e != nil {
		t.Fatal(e)
	}
	if e := f.s.reserveMFAAttempt(t.Context(), mfaTestID(t, alice.ID)); e != nil {
		t.Fatal("new factor window", e)
	}
	// Password-verified requests remain bounded metadata, not unlimited active rows.
	if _, e := f.db.Exec(`DELETE FROM golf_mfa_login_challenges WHERE account_id=$1`, alice.ID); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 10; i++ {
		beginMFAChallenge(t, f.s)
	}
	w := mfaLoginRequest(f.s, "LoginWithPassword", map[string]string{"username": "alice", "password": localTestPassword}, nil)
	if w.Code != 429 {
		t.Fatal("active challenge capacity", w.Code)
	}
}
func mfaTestID(t *testing.T, v string) int64 {
	t.Helper()
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil {
		t.Fatal(e)
	}
	return n
}

func TestLocalMFAOwnCredentialAndRotationPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	_, codes := enableMFATest(t, f, "alice")
	challenge := beginMFAChallenge(t, f.s)
	w := mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[0]}, challenge)
	if w.Code != 200 {
		t.Fatal("MFA own-security session", w.Code)
	}
	var cookie *http.Cookie
	for _, v := range w.Result().Cookies() {
		if v.Name == f.s.sessionCookie("", time.Time{}, 0).Name {
			cookie = v
		}
	}
	if cookie == nil {
		t.Fatal("authenticated cookie missing")
	}
	current := loginResult{Value: cookie.Value, Expires: time.Now().Add(time.Hour)}
	account := ownSecurityFields(LocalAccountResult{ID: "1"}, "1")
	account["newPassword"] = "new-golf-password-after-mfa"
	w = accountSecurityRequest(f.s, current, "ChangeOwnPassword", account)
	if w.Code != 401 {
		t.Fatal("password change bypassed enrolled factor", w.Code)
	}
	account["mfaCode"] = codes[1]
	w = accountSecurityRequest(f.s, current, "ChangeOwnPassword", account)
	if w.Code != 200 {
		t.Fatal("factor-authorized password change", w.Code)
	}
	w = mfaLoginRequest(f.s, "LoginWithPassword", map[string]string{"username": "alice", "password": account["newPassword"]}, nil)
	var login golfv1.LoginWithPasswordResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &login) != nil || !login.MfaRequired {
		t.Fatal("password change removed MFA", w.Code)
	}
	// Generic encrypted-content key inventory/rotation must cover MFA secrets.
	var secretCount int64
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_notification_contents WHERE kind='mfa'`).Scan(&secretCount); e != nil || secretCount != 1 {
		t.Fatal("MFA encrypted inventory", e)
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	rotation, e := RotateCredentials(t.Context(), f.db, keys, 2, 20)
	if e != nil || !rotation.Complete || rotation.RotatedNotificationContents != 1 {
		t.Fatal("MFA key rotation", e)
	}
	f.s.keyring = keys
	var challengeCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == f.s.mfaCookie("", time.Time{}, 0).Name {
			challengeCookie = c
		}
	}
	if challengeCookie == nil {
		t.Fatal("post-password challenge missing")
	}
	w = mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": codes[2]}, challengeCookie)
	if w.Code != 200 {
		t.Fatal("rotated MFA secret/recovery consumer", w.Code)
	}
}

func TestLocalMFARevokesPriorTokenBrowserSessionsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	pat := f.session(t, "alice", "pat")
	oauth := f.session(t, "alice", "oauth")
	delegated := issueApiCredential(t, apiManagementClient(t, f, pat), "old token browser delegate", 0)
	if w := apiRequest(f.s, delegated.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); w.Code != 200 {
		t.Fatal("pre-enrollment delegate", w.Code)
	}
	_, _ = enableMFATest(t, f, "alice")
	if _, e := f.s.sessionCredential(t.Context(), pat.Value); e == nil {
		t.Fatal("prior native-token browser session retained after MFA enable")
	}
	if w := apiRequest(f.s, delegated.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); w.Code != 401 {
		t.Fatal("prior token-browser API delegation retained", w.Code)
	}
	if _, e := f.s.sessionCredential(t.Context(), oauth.Value); e != nil {
		t.Fatal("independent provider OAuth session revoked", e)
	}
}
