package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/encoding/protojson"
)

func accountSecurityRequest(s *Server, session loginResult, method string, body any) *httptest.ResponseRecorder {
	payload, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/rpc/golf.v1.AccountSecurityService/"+method, strings.NewReader(string(payload)))
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
func ownSecurityFields(account LocalAccountResult, version string) map[string]string {
	return map[string]string{"accountId": account.ID, "userId": "42", "expectedCredentialVersion": version, "passwordConfirmation": localTestPassword}
}
func TestAccountSecurityBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetAccountSecurity", "ChangeOwnPassword", "ChangeOwnLoginEmail"} {
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc/golf.v1.AccountSecurityService/"+method, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("credential boundary", method, w.Code)
			}
		}
		if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.AccountSecurityService/"+method, "malformed"); w.Code != 403 {
			t.Fatal("bearer reached own security", method, w.Code)
		}
	}
	if _, err := ownSecurityInput("01", "42", "1", localTestPassword); err == nil {
		t.Fatal("noncanonical own account accepted")
	}
}
func TestAccountSecurityPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := t.Context()
	actor := enrollLocal(t, f, "alice", false)
	other := enrollLocal(t, f, "bob", false)
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.GiteaURL, "set-email", LocalAccountInput{Username: "alice", Email: "alice@example.invalid"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.GiteaURL, "set-email", LocalAccountInput{Username: "bob", Email: "bob@example.invalid"}); err != nil {
		t.Fatal(err)
	}
	first, second := localLogin(t, f, "alice"), localLogin(t, f, "alice")
	response := accountSecurityRequest(f.s, first, "GetAccountSecurity", map[string]string{})
	var security golfv1.GetAccountSecurityResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &security) != nil {
		t.Fatal("own metadata", response.Code)
	}
	if !security.Security.CanManage || security.Security.LoginEmail != "alice@example.invalid" || security.Security.Username != "alice" || security.Security.CredentialVersion != "2" {
		t.Fatal("local alias projection invalid")
	}
	pat := f.session(t, "alice", "pat")
	response = accountSecurityRequest(f.s, pat, "GetAccountSecurity", map[string]string{})
	var nonlocal golfv1.GetAccountSecurityResponse
	if response.Code != 200 || protojson.Unmarshal(response.Body.Bytes(), &nonlocal) != nil || nonlocal.Security.CanManage || nonlocal.Security.LoginEmail != "" || nonlocal.Security.AccountId != "" {
		t.Fatal("PAT session received enrolled alias")
	}
	request := ownSecurityFields(actor, "2")
	request["newPassword"] = "Replacement own password!"
	if w := accountSecurityRequest(f.s, pat, "ChangeOwnPassword", request); w.Code != 403 {
		t.Fatal("nonlocal credential changed", w.Code)
	}
	request["accountId"] = other.ID
	if w := accountSecurityRequest(f.s, first, "ChangeOwnPassword", request); w.Code != 403 {
		t.Fatal("foreign account accepted", w.Code)
	}
	request["accountId"] = actor.ID
	request["expectedCredentialVersion"] = "1"
	if w := accountSecurityRequest(f.s, first, "ChangeOwnPassword", request); w.Code != 400 || !strings.Contains(w.Body.String(), "failed_precondition") {
		t.Fatal("stale version accepted", w.Code)
	}
	request["expectedCredentialVersion"] = "2"
	request["passwordConfirmation"] = "A wrong but bounded password"
	if w := accountSecurityRequest(f.s, first, "ChangeOwnPassword", request); w.Code != 403 {
		t.Fatal("wrong step-up accepted", w.Code)
	}
	request["passwordConfirmation"] = localTestPassword
	alias := ownSecurityFields(actor, "2")
	alias["loginEmail"] = "BOB@EXAMPLE.INVALID"
	if w := accountSecurityRequest(f.s, first, "ChangeOwnLoginEmail", alias); w.Code != 400 {
		t.Fatal("duplicate canonical email accepted", w.Code)
	}
	if _, err := f.s.sessionCredential(ctx, first.Value); err != nil {
		t.Fatal("failed email update revoked caller")
	}
	// A delegation keeps metadata but loses authority when its exact local source is removed.
	tokenCtx := context.WithValue(ctx, sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true})
	create := connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "Before self change"})
	create.Header().Set("Cookie", f.s.sessionCookie(second.Value, second.Expires, 3600).String())
	delegation, err := f.s.CreateApiCredential(tokenCtx, create)
	if err != nil {
		t.Fatal(err)
	}
	actorSession, actorUser, _ := f.id(t, first)
	changed := accountSecurityRequest(f.s, first, "ChangeOwnPassword", request)
	var receipt golfv1.ChangeOwnPasswordResponse
	if changed.Code != 200 || protojson.Unmarshal(changed.Body.Bytes(), &receipt) != nil || !receipt.RequiresLogin || receipt.CredentialVersion != "3" || receipt.SessionsRevoked != 2 || receipt.OperationId == "" {
		t.Fatal("self password outcome", changed.Code)
	}
	cookies := changed.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != -1 || !cookies[0].HttpOnly {
		t.Fatal("confirmed self change didn't expire hardened cookie")
	}
	for _, session := range []loginResult{first, second} {
		if _, err := f.s.sessionCredential(ctx, session.Value); !errors.Is(err, errUnauthenticated) {
			t.Fatal("old local session retained authority", err)
		}
	}
	if _, err := f.s.sessionCredential(ctx, pat.Value); err != nil {
		t.Fatal("independent native PAT session accidentally revoked", err)
	}
	hash, _ := apiTokenHash(delegation.Msg.Token)
	if _, err := database.New(f.db).GetLiveApiCredential(ctx, database.GetLiveApiCredentialParams{TokenHash: hash, ForgeURL: f.s.config.GiteaURL}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("dependent bearer survived", err)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("old password still valid", err)
	}
	fresh, err := f.s.loginLocalSession(ctx, "alice@example.invalid", request["newPassword"], "")
	if err != nil {
		t.Fatal("new password login", err)
	}
	var recordedUser, recordedSession, version, revoked int64
	if err := f.db.QueryRow("SELECT actor_user_id,actor_session_id,credential_version,sessions_revoked FROM golf_local_account_events WHERE account_id=$1 AND action='SELF_PASSWORD_CHANGED'", actor.ID).Scan(&recordedUser, &recordedSession, &version, &revoked); err != nil || recordedUser != actorUser || recordedSession != actorSession || version != 3 || revoked != 2 {
		t.Fatal("atomic self actor evidence", err)
	}
	// One explicit email edit changes only the local alias and signs the caller out.
	alias = ownSecurityFields(actor, "3")
	alias["passwordConfirmation"] = request["newPassword"]
	alias["loginEmail"] = "NEW-ALICE@EXAMPLE.INVALID"
	changed = accountSecurityRequest(f.s, fresh, "ChangeOwnLoginEmail", alias)
	var emailReceipt golfv1.ChangeOwnLoginEmailResponse
	if changed.Code != 200 || protojson.Unmarshal(changed.Body.Bytes(), &emailReceipt) != nil || emailReceipt.CredentialVersion != "4" || !emailReceipt.RequiresLogin {
		t.Fatal("self alias outcome", changed.Code)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice@example.invalid", request["newPassword"], ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("old alias still accepted", err)
	}
	if _, err := f.s.loginLocalSession(ctx, "new-alice@example.invalid", request["newPassword"], ""); err != nil {
		t.Fatal("new canonical alias login", err)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice", request["newPassword"], ""); err != nil {
		t.Fatal("username fallback lost", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_account_events WHERE account_id=$1 AND action='SELF_EMAIL_CHANGED' AND actor_user_id=$2 AND actor_session_id>0", actor.ID, actorUser).Scan(&count); err != nil || count != 1 {
		t.Fatal("self email actor history", err)
	}
}
func TestAccountSecurityProviderWaitPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	// Hold the second provider call: both KDFs have completed, no account lock held.
	base := http.DefaultTransport
	var calls atomic.Int32
	entered, resume := make(chan struct{}), make(chan struct{})
	f.s.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1/user" && calls.Add(1) == 2 {
			close(entered)
			select {
			case <-resume:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return base.RoundTrip(r)
	})
	input := ownSecurityChange{accountID: mustProfileID(t, actor.ID), userID: 42, version: 1, confirmation: localTestPassword, password: "Replacement self password", action: "SELF_PASSWORD_CHANGED"}
	result := make(chan error, 1)
	go func() {
		_, err := f.s.changeOwnSecurity(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true}, input)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("provider wait not reached")
	}
	logoutContext, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if err := f.s.logoutSession(logoutContext, session.Value); err != nil {
		t.Fatal("provider wait held account lock", err)
	}
	close(resume)
	select {
	case err := <-result:
		if !errors.Is(err, errUnauthenticated) {
			t.Fatal("revoked step-up snapshot committed", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("revocation stalled")
	}
	var version int64
	if err := f.db.QueryRow("SELECT credential_version FROM golf_local_accounts WHERE id=$1", actor.ID).Scan(&version); err != nil || version != 1 {
		t.Fatal("revoked request changed credential", err)
	}
}
func mustProfileID(t *testing.T, value string) int64 {
	t.Helper()
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func TestAccountSecurityConcurrentPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	request := ownSecurityFields(actor, "1")
	request["newPassword"] = "Concurrent replacement password"
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- accountSecurityRequest(f.s, session, "ChangeOwnPassword", request).Code
		}()
	}
	wg.Wait()
	close(results)
	successes := 0
	for code := range results {
		if code == 200 {
			successes++
		} else if code != 401 && code != 400 {
			t.Fatal("unexpected concurrent denial", code)
		}
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_account_events WHERE account_id=$1 AND action='SELF_PASSWORD_CHANGED'", actor.ID).Scan(&count); err != nil || count != 1 || successes != 1 {
		t.Fatal("concurrent credential mutation duplicated", err, count, successes)
	}
}

func TestAccountSecurityExpiryRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	_, _, hash := f.id(t, session)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	// Delay only the audit insert, after credentials/session mutations. The final
	// database-clock check must roll back every change if the caller expires.
	_, err := f.db.Exec(`CREATE FUNCTION golf_test_self_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='SELF_PASSWORD_CHANGED' THEN PERFORM pg_sleep(4); END IF; RETURN NEW; END $$;
 CREATE TRIGGER golf_test_self_expiry BEFORE INSERT ON golf_local_account_events FOR EACH ROW EXECUTE FUNCTION golf_test_self_expiry();`)
	if err != nil {
		t.Fatal(err)
	}
	request := ownSecurityFields(actor, "1")
	request["newPassword"] = "Must never become current password"
	if response := accountSecurityRequest(f.s, session, "ChangeOwnPassword", request); response.Code != 401 {
		t.Fatal("expired caller committed", response.Code)
	}
	var version, events, sessions int64
	if err := f.db.QueryRow("SELECT credential_version FROM golf_local_accounts WHERE id=$1", actor.ID).Scan(&version); err != nil || version != 1 {
		t.Fatal("credential changed despite expiry rollback", err)
	}
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_account_events WHERE account_id=$1 AND action='SELF_PASSWORD_CHANGED'", actor.ID).Scan(&events); err != nil || events != 0 {
		t.Fatal("rollback retained success actor evidence", err)
	}
	if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions WHERE token_hash=$1", hash).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatal("rollback deleted original session", err)
	}
	if _, err := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, ""); err != nil {
		t.Fatal("rolled-back password became invalid", err)
	}
}
func TestAccountSecurityThrottlePostgres(t *testing.T) {
	f := newManagementFixture(t)
	actor := enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	input := ownSecurityChange{accountID: mustProfileID(t, actor.ID), userID: 42, version: 1, confirmation: "Wrong but valid-length password", password: "Unused replacement password", action: "SELF_PASSWORD_CHANGED"}
	for range 9 {
		if _, err := f.s.changeOwnSecurity(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true}, input); !errors.Is(err, errPasswordConfirmation) {
			t.Fatal("wrong confirmation not charged correctly", err)
		}
	}
	input.confirmation = localTestPassword
	if _, err := f.s.changeOwnSecurity(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true}, input); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("step-up got independent password-guess budget", err)
	}
	// Reconstructing the server does not reset the database bucket.
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.changeOwnSecurity(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true}, input); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("server restart reset shared limiter", err)
	}
}
