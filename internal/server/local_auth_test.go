package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const localTestPassword = "Golf independent password 42!"

func enrollLocal(t *testing.T, f *managementFixture, name string, admin bool) LocalAccountResult {
	t.Helper()
	result, err := ManageLocalAccount(context.Background(), f.db, f.s.keyring, f.s.config.ForgeURL, "create", LocalAccountInput{Username: name, Password: localTestPassword, ForgeToken: name + "-management-token", IsInstanceAdmin: admin})
	if err != nil {
		t.Fatal("enrollment", err)
	}
	return result
}
func localLogin(t *testing.T, f *managementFixture, name string) loginResult {
	t.Helper()
	result, err := f.s.loginLocalSession(context.Background(), name, localTestPassword, "")
	if err != nil {
		t.Fatal("local login", err)
	}
	return result
}
func TestLocalPasswordFixedKDF(t *testing.T) {
	ctx := context.Background()
	first, err := hashLocalPassword(ctx, localTestPassword)
	if err != nil {
		t.Fatal(err)
	}
	second, err := hashLocalPassword(ctx, localTestPassword)
	if err != nil || first == second || !strings.HasPrefix(first, localPasswordPrefix) {
		t.Fatal("random fixed Argon2id encoding")
	}
	for _, input := range []struct {
		password, hash string
		want           bool
	}{{localTestPassword, first, true}, {" " + localTestPassword, first, false}, {localTestPassword, "", false}, {localTestPassword, "$argon2id$v=19$m=999999999,t=999,p=99$invalid", false}} {
		valid, err := verifyLocalPassword(ctx, input.password, input.hash)
		if err != nil || valid != input.want {
			t.Fatal("fixed-cost verification", err)
		}
	}
	if validLocalPassword("12345678901234") || validLocalPassword(strings.Repeat("x", 1025)) || validLocalPassword(string([]byte{255})+localTestPassword) || !validLocalPassword(strings.Repeat("é", 15)) {
		t.Fatal("password length/UTF8 boundary")
	}
	for range cap(localKDFSlots) {
		localKDFSlots <- struct{}{}
	}
	_, err = deriveLocalPassword(ctx, localTestPassword, make([]byte, 16))
	for range cap(localKDFSlots) {
		<-localKDFSlots
	}
	if !errors.Is(err, errLocalRateLimited) {
		t.Fatal("KDF concurrency limit", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := deriveLocalPassword(cancelled, localTestPassword, make([]byte, 16)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled KDF", err)
	}
}
func TestLocalAccountLifecyclePostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	account := enrollLocal(t, f, "alice", true)
	for _, name := range []string{"alice", "missing"} {
		if _, err := f.s.loginLocalSession(ctx, name, "incorrect Golf password", ""); !errors.Is(err, errLocalCredentials) {
			t.Fatal("generic failure", err)
		}
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "create", LocalAccountInput{Username: "another", Password: localTestPassword, ForgeToken: "alice-management-token"}); err == nil {
		t.Fatal("immutable identity silently linked twice")
	}
	session := localLogin(t, f, "alice")
	if !session.User.IsInstanceAdmin || time.Until(session.Expires) < 11*time.Hour {
		t.Fatal("local role/lifetime")
	}
	cred, err := f.s.sessionCredential(ctx, session.Value)
	if err != nil || !cred.Local || cred.Kind != "pat" {
		t.Fatal("native credential family", err)
	}
	source := issueApiCredential(t, apiManagementClient(t, f, session), "local-source", 3600)
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = restarted
	if response := apiRequest(f.s, source.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); response.Code != 200 {
		t.Fatal("restart lost local bearer", response.Code)
	}
	client := f.client(t, session)
	current, err := client.GetSession(ctx, connect.NewRequest(&golfv1.GetSessionRequest{}))
	if err != nil || !current.Msg.User.IsInstanceAdmin {
		t.Fatal("restart role", err)
	}
	reset, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "reset-password", LocalAccountInput{Username: "alice", Password: "Replacement Golf password!"})
	if err != nil || reset.SessionsRevoked != 1 || reset.CredentialVersion == account.CredentialVersion {
		t.Fatal("reset", err)
	}
	if _, err := f.s.sessionCredential(ctx, session.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("reset retained source", err)
	}
	if response := apiRequest(f.s, source.Token, golfv1connect.SessionServiceGetSessionProcedure, "{}"); response.Code != 401 {
		t.Fatal("reset retained bearer", response.Code)
	}
	disabled, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "alice"})
	if err != nil || !disabled.Disabled {
		t.Fatal("disable", err)
	}
	_, err = ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "reset-password", LocalAccountInput{Username: "alice", Password: localTestPassword})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("reset reenabled disabled", err)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "enable", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "bob-management-token"}); err == nil {
		t.Fatal("enable replaced immutable identity")
	}
	enabled, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "enable", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "alice-management-token"})
	if err != nil || enabled.Disabled || !enabled.IsInstanceAdmin {
		t.Fatal("enable", err)
	}
	session = localLogin(t, f, "alice")
	id, _, _ := f.id(t, session)
	reply, err := f.client(t, session).RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(id, 10)}))
	if err != nil || !reply.Msg.CurrentSessionRevoked {
		t.Fatal("current local revoke acknowledgement", err)
	}
	if _, err := f.s.sessionCredential(ctx, session.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("current revoke retained session")
	}
	f.mode.Store(1)
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("native identity changed", err)
	}
	f.mode.Store(2)
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("revoked provider accepted", err)
	}
}
func TestLocalLoginReplicaThrottlePostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	enrollLocal(t, f, "alice", false)
	other, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		s := f.s
		if i%2 == 0 {
			s = other
		}
		if _, err := s.loginLocalSession(ctx, "alice", "A deliberately wrong password", ""); !errors.Is(err, errLocalCredentials) {
			t.Fatal("early throttle", err)
		}
	}
	if _, err := other.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalRateLimited) {
		t.Fatal("shared throttle", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_login_limits").Scan(&count); err != nil || count != 1025 {
		t.Fatal("unbounded limiter table", err)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "reset-password", LocalAccountInput{Username: "alice", Password: localTestPassword}); err != nil {
		t.Fatal(err)
	}
	localLogin(t, f, "alice")
}
func TestLocalLoginAndReadDisableRacePostgres(t *testing.T) {
	for _, read := range []bool{false, true} {
		t.Run(strconv.FormatBool(read), func(t *testing.T) {
			f := newManagementFixture(t)
			ctx := context.Background()
			enrollLocal(t, f, "alice", false)
			var client golfv1connect.SessionServiceClient
			if read {
				client = f.client(t, localLogin(t, f, "alice"))
			}
			f.mode.Store(3)
			done := make(chan error, 1)
			go func() {
				if read {
					_, err := client.GetSession(ctx, connect.NewRequest(&golfv1.GetSessionRequest{}))
					done <- err
				} else {
					_, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, "")
					done <- err
				}
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("provider did not block")
			}
			if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "alice"}); err != nil {
				t.Fatal(err)
			}
			close(f.resume)
			select {
			case err := <-done:
				if read {
					if connect.CodeOf(err) != connect.CodeUnauthenticated {
						t.Fatal("read escaped disable", err)
					}
				} else if !errors.Is(err, errLocalCredentials) {
					t.Fatal("login escaped disable", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("account/session lock deadlock")
			}
			var count int
			f.db.QueryRow("SELECT count(*) FROM golf_sessions").Scan(&count)
			if count != 0 {
				t.Fatal("disable race created session")
			}
		})
	}
}
func TestLocalAccountAtomicRollbackAndGuardsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	if _, err := f.db.Exec(`CREATE FUNCTION reject_local_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_local_event BEFORE INSERT ON golf_local_account_events FOR EACH ROW EXECUTE FUNCTION reject_local_event()`); err != nil {
		t.Fatal(err)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "reset-password", LocalAccountInput{Username: "alice", Password: "Changed password that rolls back"}); err == nil {
		t.Fatal("reset claimed success despite event failure")
	}
	if _, err := f.s.sessionCredential(ctx, session.Value); err != nil {
		t.Fatal("rollback lost session", err)
	}
	localLogin(t, f, "alice")
	for _, statement := range []string{`UPDATE golf_local_accounts SET username='renamed'`, `UPDATE golf_local_accounts SET is_instance_admin=true`, `UPDATE golf_local_account_events SET action='DISABLED'`, `DELETE FROM golf_local_account_events`, `TRUNCATE golf_local_account_events`, `UPDATE golf_sessions SET local_credential_version=NULL WHERE credential_kind='local'`} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("guard allowed", statement)
		}
	}
}
func TestLocalCredentialsRotationAndRecoveryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	localLogin(t, f, "alice")
	seedAttempt(t, f.s, false)
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "bob"}); err != nil {
		t.Fatal(err)
	}
	row, err := database.New(f.db).GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.keyring.open("legacy", sessionDomain, row.EncryptedForgeToken, row.CredentialBinding); err == nil {
		t.Fatal("legacy local family not domain-separated")
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	if _, err := CheckKeyRetirement(ctx, f.db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("retired mapped PAT", err)
	}
	result, err := RotateCredentials(ctx, f.db, keys, 2, 3)
	if err != nil || !result.Complete || result.RotatedLocalAccounts != 2 || result.RotatedSessions != 1 || result.RotatedOAuthAttempts != 1 {
		t.Fatal("all credential families rotation", err)
	}
	config := keyedConfig(f.s.config)
	config.EncryptionKey = ""
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal("restart without retired key", err)
	}
	before, err := database.New(f.db).GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := InvalidateRestoredSessions(ctx, f.db, strings.Repeat("a", 32))
	if err != nil || recovered.LocalAccountsDisabledCount != 2 || recovered.SessionsCount != 1 || recovered.OAuthAttemptsCount != 1 {
		t.Fatal("recovery local fencing", err)
	}
	after, err := database.New(f.db).GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil || !after.DisabledAt.Valid || after.CredentialVersion != before.CredentialVersion+1 || before.PasswordHash != after.PasswordHash || !bytes.Equal(before.EncryptedForgeToken, after.EncryptedForgeToken) {
		t.Fatal("recovery changed retained credential or failed version fence", err)
	}
	var events int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_account_events WHERE action='RECOVERY_DISABLED' AND operation_id=$1", recovered.OperationID).Scan(&events); err != nil || events != 2 {
		t.Fatal("recovery journal correlation", err)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("restored password resurrected access", err)
	}
	status, err := KeyStatus(ctx, f.db, f.s.keyring)
	if err != nil {
		t.Fatal(err)
	}
	var locals uint64
	for _, usage := range status.Keys {
		locals += usage.LocalAccounts
	}
	if locals != 2 {
		t.Fatal("disabled local credentials hidden from inventory")
	}
}
func TestLocalLoginRPCNoCredentialReflectionPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	for _, name := range []string{"alice", "missing"} {
		body, _ := json.Marshal(map[string]string{"username": name, "password": "Wrong private password canary"})
		r := httptest.NewRequest(http.MethodPost, "/rpc"+golfv1connect.SessionServiceLoginWithPasswordProcedure, bytes.NewReader(body))
		r.Header.Set("Origin", f.s.config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		f.s.ServeHTTP(w, r)
		if w.Code != 401 || strings.Contains(w.Body.String(), name) || strings.Contains(w.Body.String(), "canary") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("local sign-in disclosure", w.Code)
		}
	}
}

func TestLocalCredentialFailuresPreserveAuthorityRecordsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	enrollLocal(t, f, "alice", false)
	session := localLogin(t, f, "alice")
	q := database.New(f.db)
	before, err := q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil {
		t.Fatal(err)
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	missing := keyedConfig(f.s.config)
	missing.EncryptionKey = ""
	if _, err := New(missing, f.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("missing persistent key not detected", err)
	}
	if _, err := f.db.Exec(`CREATE FUNCTION local_reject_crypto() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER local_reject_crypto BEFORE INSERT ON golf_crypto_events FOR EACH ROW EXECUTE FUNCTION local_reject_crypto()`); err != nil {
		t.Fatal(err)
	}
	failed, err := RotateCredentials(ctx, f.db, keys, 10, 1)
	if err == nil || failed.Complete || failed.RotatedLocalAccounts != 0 || failed.RotatedSessions != 0 {
		t.Fatal("failed rotation reported committed rows", err)
	}
	after, err := q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil || after.CredentialKeyID != "legacy" || !bytes.Equal(after.EncryptedForgeToken, before.EncryptedForgeToken) {
		t.Fatal("rotation audit failure partially rewrote local account", err)
	}
	if _, err := f.db.Exec(`DROP TRIGGER local_reject_crypto ON golf_crypto_events`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`CREATE FUNCTION local_reject_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER local_reject_recovery BEFORE INSERT ON golf_recovery_events FOR EACH ROW EXECUTE FUNCTION local_reject_recovery()`); err != nil {
		t.Fatal(err)
	}
	if _, err := InvalidateRestoredSessions(ctx, f.db, strings.Repeat("b", 32)); err == nil {
		t.Fatal("failed recovery reported success")
	}
	after, err = q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: "alice", ForgeURL: f.s.config.ForgeURL})
	if err != nil || after.DisabledAt.Valid || after.CredentialVersion != before.CredentialVersion {
		t.Fatal("failed recovery partly disabled local account", err)
	}
	if _, err := f.s.sessionCredential(ctx, session.Value); err != nil {
		t.Fatal("failed recovery deleted source session", err)
	}
	if _, err := RotateCredentials(ctx, f.db, keys, 10, 1); err != nil {
		t.Fatal(err)
	}
	f.s, err = New(keyedConfig(f.s.config), f.db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE golf_local_accounts SET encrypted_forge_token=set_byte(encrypted_forge_token,0,get_byte(encrypted_forge_token,0)#1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.loginLocalSession(ctx, "alice", localTestPassword, ""); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("tampered mapped credential accepted", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_local_accounts").Scan(&count); err != nil || count != 1 {
		t.Fatal("unreadable enrollment destructively removed", err)
	}
}

func TestLocalPersistentCredentialAloneBlocksKeyRetirementPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	enrollLocal(t, f, "alice", false)
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	config := keyedConfig(f.s.config)
	config.EncryptionKey = ""
	if _, err := New(config, f.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("startup ignored sole persistent credential family", err)
	}
	if _, err := CheckKeyRetirement(ctx, f.db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("local-only legacy key retired", err)
	}
	result, err := RotateCredentials(ctx, f.db, keys, 1, 1)
	if err != nil || !result.Complete || result.RotatedLocalAccounts != 1 || result.RotatedSessions+result.RotatedOAuthAttempts != 0 {
		t.Fatal("local-only batch", err)
	}
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal("startup after persistent-family rotation", err)
	}
	localLogin(t, f, "alice")
}

func TestLocalEmailAliasPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	input := LocalAccountInput{Username: "alice", Email: "Alice@Example.invalid", Password: localTestPassword, ForgeToken: "alice-management-token", IsInstanceAdmin: true}
	enrolled, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "create", input)
	if err != nil || enrolled.Email != "alice@example.invalid" {
		t.Fatal("email enrollment", err)
	}
	byEmail, err := f.s.loginLocalSession(ctx, " ALICE@EXAMPLE.INVALID ", localTestPassword, "")
	if err != nil || !byEmail.User.IsInstanceAdmin {
		t.Fatal("email login", err)
	}
	if _, err := f.s.loginLocalSession(ctx, "unknown@example.invalid", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("generic email denial", err)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "create", LocalAccountInput{Username: "bob", Email: "ALICE@example.invalid", Password: localTestPassword, ForgeToken: "bob-management-token"}); err == nil {
		t.Fatal("duplicate email enrolled")
	}
	changed, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.ForgeURL, "set-email", LocalAccountInput{Username: "alice", Email: "new@example.invalid"})
	if err != nil || changed.Email != "new@example.invalid" || changed.SessionsRevoked != 1 {
		t.Fatal("email change fencing", err)
	}
	if _, err := f.s.sessionCredential(ctx, byEmail.Value); err == nil {
		t.Fatal("email change retained old session")
	}
	if _, err := f.s.loginLocalSession(ctx, "alice@example.invalid", localTestPassword, ""); !errors.Is(err, errLocalCredentials) {
		t.Fatal("old email survived change", err)
	}
	for i := 0; i < 11; i++ {
		name := "alice"
		if i%2 == 0 {
			name = "NEW@example.invalid"
		}
		_, err := f.s.loginLocalSession(ctx, name, "deliberately wrong password", "")
		if i < 10 && !errors.Is(err, errLocalCredentials) {
			t.Fatal("shared alias limit rejected early", i, err)
		}
		if i == 10 && !errors.Is(err, errLocalRateLimited) {
			t.Fatal("email/username bypassed account limit", err)
		}
	}
}

func TestLocalEmailCanonicalization(t *testing.T) {
	for _, value := range []string{"Alice@Example.COM", "alice+golf@example.com", "a.b@example.com"} {
		email, ok := canonicalLocalEmail(value)
		if !ok || email != strings.ToLower(value) {
			t.Fatal("valid email rejected")
		}
	}
	for _, value := range []string{"", " alice@example.com", "Alice <alice@example.com>", "alice@localhost", "alice@-example.com", "alice@example-.com", "a..b@example.com", "é@example.com", "alice@example.com\n", strings.Repeat("a", 65) + "@example.com"} {
		if _, ok := canonicalLocalEmail(value); ok {
			t.Fatal("invalid email accepted")
		}
	}
}
