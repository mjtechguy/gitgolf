package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func rotationKeys(t *testing.T, config Config) *Keyring {
	t.Helper()
	return parseTestKeys(t, config.EncryptionKey, map[string]string{"next": keyFixture(9)}, "next")
}
func keyedConfig(config Config) Config {
	config.EncryptionKeysJSON = keyConfigJSON(map[string]string{"next": keyFixture(9)})
	config.EncryptionActiveKeyID = "next"
	return config
}
func seedAttempt(t *testing.T, s *Server, expired bool) ([]byte, []byte, string) {
	t.Helper()
	state, binding := randomOpaque(), randomOpaque()
	hash, _ := sessionHash(state)
	bindingHash, _ := sessionHash(binding)
	plain := "private-pkce-verifier"
	encrypted, keyID, err := s.keyring.seal(oauthAttemptDomain, plain, hash)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	if expired {
		expires = time.Now().Add(-time.Hour)
	}
	if err := database.New(s.db).CreateKeyedOAuthAttempt(context.Background(), database.CreateKeyedOAuthAttemptParams{StateHash: hash, BindingHash: bindingHash, EncryptedVerifier: encrypted, ExpiresAt: expires, CredentialKeyID: keyID}); err != nil {
		t.Fatal(err)
	}
	return hash, bindingHash, plain
}
func mustActivate(t *testing.T, db *sql.DB, keys *Keyring) {
	t.Helper()
	result, err := ActivateKey(context.Background(), db, keys)
	if err != nil || !result.Complete || result.Status.ActiveKeyID != keys.active {
		t.Fatal("activate", err)
	}
}
func countKeyUses(status CredentialKeyStatus, id string) uint64 {
	for _, usage := range status.Keys {
		if usage.KeyID == id {
			return usage.Sessions + usage.OAuthAttempts + usage.LocalAccounts + usage.InfrastructureConnections + usage.AutomationCredentials
		}
	}
	return 0
}

func TestKeyRotationAllCredentialsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	pat, oauth := f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")
	expired := f.session(t, "alice", "pat")
	_, _, expiredHash := f.id(t, expired)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", expiredHash); err != nil {
		t.Fatal(err)
	}
	pending, binding, verifier := seedAttempt(t, f.s, false)
	seedAttempt(t, f.s, true)
	keys := rotationKeys(t, f.s.config)
	status, err := KeyStatus(ctx, f.db, keys)
	if err != nil || status.ActiveKeyID != "legacy" || countKeyUses(status, "legacy") != 5 {
		t.Fatal("all rows including expired", err)
	}
	mustActivate(t, f.db, keys)
	missing := keyedConfig(f.s.config)
	missing.EncryptionKey = ""
	if _, err := New(missing, f.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("startup hid missing expired credential key", err)
	}
	if result, err := CheckKeyRetirement(ctx, f.db, keys, "legacy"); err == nil || result.Complete {
		t.Fatal("in-use key retired")
	}
	f.s, err = New(keyedConfig(f.s.config), f.db)
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range []loginResult{pat, oauth} {
		if _, err := f.s.sessionCredential(ctx, session.Value); err != nil {
			t.Fatal("mixed legacy read", err)
		}
	}
	first, err := RotateCredentials(ctx, f.db, keys, 2, 1)
	if err != nil || first.Complete || first.Batches != 1 || first.RotatedSessions != 2 || first.RotatedOAuthAttempts != 0 || countKeyUses(first.Status, "legacy") != 3 {
		t.Fatal("bounded first batch", err)
	}
	resumed, err := RotateCredentials(ctx, f.db, keys, 2, 3)
	if err != nil || !resumed.Complete || resumed.RotatedSessions != 1 || resumed.RotatedOAuthAttempts != 2 || countKeyUses(resumed.Status, "legacy") != 0 {
		t.Fatal("resumed credential families", err)
	}
	if result, err := CheckKeyRetirement(ctx, f.db, keys, "legacy"); err != nil || !result.Complete {
		t.Fatal("zero-use retirement", err)
	}
	withoutLegacy := keyedConfig(f.s.config)
	withoutLegacy.EncryptionKey = ""
	f.s, err = New(withoutLegacy, f.db)
	if err != nil {
		t.Fatal("retired legacy key removal", err)
	}
	for _, session := range []loginResult{pat, oauth} {
		if _, err := f.s.sessionCredential(ctx, session.Value); err != nil {
			t.Fatal("rotation/restart lost existing session", err)
		}
	}
	if got, err := f.s.consumeOAuthVerifier(ctx, pending, binding); err != nil || got != verifier {
		t.Fatal("pending verifier did not survive rotation", err)
	}
	if _, err := f.s.consumeOAuthVerifier(ctx, pending, binding); !errors.Is(err, errUnauthenticated) {
		t.Fatal("rotated verifier replay accepted", err)
	}
	var history, actors int
	if err := f.db.QueryRow("SELECT count(*),count(*) FILTER (WHERE actor=current_user) FROM golf_crypto_events").Scan(&history, &actors); err != nil || history != 5 || actors != history {
		t.Fatal("operator history actor/batches", err)
	}
	for _, statement := range []string{"UPDATE golf_crypto_events SET action=action", "DELETE FROM golf_crypto_events", "TRUNCATE golf_crypto_events", "UPDATE golf_encryption_keys SET fingerprint=fingerprint", "DELETE FROM golf_encryption_keys", "TRUNCATE golf_encryption_keys"} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("operator history/key binding mutable")
		}
	}
	raw, _ := json.Marshal(resumed)
	for _, secret := range []string{f.s.config.EncryptionKeysJSON, pat.Value, oauth.Value, "fingerprint", "encrypted_token", "state_hash", verifier} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("operator metadata disclosed secret")
		}
	}
}

func TestKeyMaterialBindingsAndFreshFullKeyringPostgres(t *testing.T) {
	f := newManagementFixture(t)
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	wrong := keyedConfig(f.s.config)
	wrong.EncryptionKeysJSON = keyConfigJSON(map[string]string{"next": keyFixture(8)})
	if _, err := New(wrong, f.db); !errors.Is(err, errKeyMaterial) {
		t.Fatal("reused active label accepted different material", err)
	}
	wrongKeys := parseTestKeys(t, wrong.EncryptionKey, map[string]string{"next": keyFixture(8)}, "next")
	if _, err := ActivateKey(context.Background(), f.db, wrongKeys); !errors.Is(err, errKeyMaterial) {
		t.Fatal("activation relabeled incompatible material", err)
	}
	retiredWrong := keyedConfig(f.s.config)
	retiredWrong.EncryptionKey = keyFixture(6)
	if _, err := New(retiredWrong, f.db); !errors.Is(err, errKeyMaterial) {
		t.Fatal("retired zero-use label reused", err)
	}
	fresh := testDatabase(t)
	onlyNew := parseTestKeys(t, "", map[string]string{"next": keyFixture(9)}, "next")
	mustActivate(t, fresh, onlyNew)
	config := keyedConfig(testConfig("https://forge.invalid"))
	config.EncryptionKey = ""
	if _, err := New(config, fresh); err != nil {
		t.Fatal("fresh full keyring requires phantom legacy key", err)
	}
}

func TestKeyLegacyBootstrapAuthenticatesAllRowsPostgres(t *testing.T) {
	for _, kind := range []string{"session", "attempt"} {
		t.Run(kind, func(t *testing.T) {
			db := testDatabase(t)
			ctx := context.Background()
			q := database.New(db)
			correct := parseTestKeys(t, keyFixture(1), nil, "")
			hash := bytes.Repeat([]byte{3}, 32)
			domain := sessionDomain
			if kind == "attempt" {
				domain = oauthAttemptDomain
			}
			encrypted, _, err := correct.seal(domain, "existing-private-credential", hash)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "session" {
				id, err := q.UpsertUser(ctx, database.UpsertUserParams{ForgeURL: "https://forge.invalid", ForgeUserID: 42, Login: "alice"})
				if err != nil {
					t.Fatal(err)
				}
				if err := q.CreateSession(ctx, database.CreateSessionParams{TokenHash: hash, UserID: id, EncryptedToken: encrypted, ExpiresAt: time.Now().Add(-time.Hour), CredentialKind: "pat"}); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := q.CreateOAuthAttempt(ctx, database.CreateOAuthAttemptParams{StateHash: hash, BindingHash: hash, EncryptedVerifier: encrypted, ExpiresAt: time.Now().Add(-time.Hour)}); err != nil {
					t.Fatal(err)
				}
			}
			config := testConfig("https://forge.invalid")
			config.EncryptionKey = keyFixture(2)
			if _, err := New(config, db); !errors.Is(err, errKeyBootstrap) {
				t.Fatal("first upgrade trusted wrong legacy key", err)
			}
			if _, err := q.GetKeyFingerprint(ctx, "legacy"); !errors.Is(err, sql.ErrNoRows) {
				t.Fatal("failed scan bound incorrect key")
			}
			config.EncryptionKey = keyFixture(1)
			if _, err := New(config, db); err != nil {
				t.Fatal("correct legacy bootstrap failed", err)
			}
			status, err := KeyStatus(ctx, db, correct)
			if err != nil || countKeyUses(status, "legacy") != 1 {
				t.Fatal("bootstrap purged old/expired credential", err)
			}
		})
	}
}

func TestKeyReadFailurePreservesCredentialsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	old := f.s
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	var err error
	f.s, err = New(keyedConfig(f.s.config), f.db)
	if err != nil {
		t.Fatal(err)
	}
	session := f.session(t, "alice", "pat")
	_, _, hash := f.id(t, session)
	pending, binding, _ := seedAttempt(t, f.s, false)
	if _, err := old.sessionCredential(ctx, session.Value); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("unknown key fallback", err)
	}
	if _, err := old.consumeOAuthVerifier(ctx, pending, binding); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("unknown verifier key fallback", err)
	}
	if _, err := f.db.Exec("UPDATE golf_sessions SET encrypted_token=set_byte(encrypted_token,0,get_byte(encrypted_token,0)#1) WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE golf_oauth_attempts SET encrypted_verifier=set_byte(encrypted_verifier,0,get_byte(encrypted_verifier,0)#1) WHERE state_hash=$1", pending); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.sessionCredential(ctx, session.Value); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("tampered credential accepted", err)
	}
	if _, err := f.s.consumeOAuthVerifier(ctx, pending, binding); !errors.Is(err, errCredentialUnavailable) {
		t.Fatal("tampered verifier accepted", err)
	}
	var sessions, attempts int
	if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_oauth_attempts)").Scan(&sessions, &attempts); err != nil || sessions != 1 || attempts != 1 {
		t.Fatal("unreadable credential destructively removed", err)
	}
	// The old running instance cannot reintroduce retired-ID ciphertext.
	if _, err := old.createSession(ctx, User{ID: 42, Login: "alice"}, "pat", "old-writer-token", ""); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("stale old-key writer bypassed policy", err)
	}
	if _, err := f.db.Exec("UPDATE golf_sessions SET credential_key_id='legacy' WHERE token_hash=$1", hash); err == nil {
		t.Fatal("old-key update bypassed fence")
	}
	if err := database.New(f.db).CreateOAuthAttempt(ctx, database.CreateOAuthAttemptParams{StateHash: bytes.Repeat([]byte{4}, 32), BindingHash: binding, EncryptedVerifier: []byte("opaque"), ExpiresAt: time.Now().Add(time.Hour)}); err == nil {
		t.Fatal("old-key verifier insert bypassed fence")
	}
}

func TestKeyRotationBatchRollbackAndBusyRowsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	session := f.session(t, "alice", "pat")
	_, _, hash := f.id(t, session)
	pending, _, _ := seedAttempt(t, f.s, false)
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	var originalSession, originalAttempt []byte
	f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", hash).Scan(&originalSession)
	f.db.QueryRow("SELECT encrypted_verifier FROM golf_oauth_attempts WHERE state_hash=$1", pending).Scan(&originalAttempt)
	if _, err := f.db.Exec(`CREATE FUNCTION reject_crypto_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test crypto history failure'; END $$;
CREATE TRIGGER reject_crypto_event BEFORE INSERT ON golf_crypto_events FOR EACH ROW EXECUTE FUNCTION reject_crypto_event()`); err != nil {
		t.Fatal(err)
	}
	failed, err := RotateCredentials(ctx, f.db, keys, 10, 1)
	if !errors.Is(err, errStorageUnavailable) || failed.Batches != 0 || failed.Complete || failed.RotatedSessions+failed.RotatedOAuthAttempts != 0 {
		t.Fatal("failed batch reported success", err)
	}
	var sessionAfter, attemptAfter []byte
	var sessionKey, attemptKey string
	f.db.QueryRow("SELECT encrypted_token,credential_key_id FROM golf_sessions WHERE token_hash=$1", hash).Scan(&sessionAfter, &sessionKey)
	f.db.QueryRow("SELECT encrypted_verifier,credential_key_id FROM golf_oauth_attempts WHERE state_hash=$1", pending).Scan(&attemptAfter, &attemptKey)
	if !bytes.Equal(originalSession, sessionAfter) || !bytes.Equal(originalAttempt, attemptAfter) || sessionKey != "legacy" || attemptKey != "legacy" {
		t.Fatal("history failure left partial ciphertext/metadata rewrite")
	}
	if _, err := f.db.Exec("DROP TRIGGER reject_crypto_event ON golf_crypto_events"); err != nil {
		t.Fatal(err)
	}
	held, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := database.New(f.db).WithTx(held).LockSessionCredential(ctx, database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: f.s.config.ForgeURL}); err != nil {
		t.Fatal(err)
	}
	partial, err := RotateCredentials(ctx, f.db, keys, 10, 2)
	if err != nil || partial.Complete || partial.RotatedSessions != 0 || partial.RotatedOAuthAttempts != 1 || countKeyUses(partial.Status, "legacy") != 1 {
		t.Fatal("busy row hidden or blocked batch", err)
	}
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	resumed, err := RotateCredentials(ctx, f.db, keys, 10, 1)
	if err != nil || !resumed.Complete || resumed.RotatedSessions != 1 {
		t.Fatal("busy-row resume", err)
	}
}

func TestKeyRotationConcurrentOAuthRefreshPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	var err error
	f.s, err = New(keyedConfig(f.s.config), f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.mode.Store(7) // Real refresh fixture holds the session row during provider wait.
	var group sync.WaitGroup
	errs := make(chan error, 2)
	group.Add(2)
	go func() {
		defer group.Done()
		_, err := f.s.sessionCredential(context.Background(), session.Value)
		errs <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for f.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	go func() {
		defer group.Done()
		_, err := RotateCredentials(context.Background(), f.db, keys, 10, 1)
		errs <- err
	}()
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal("refresh/rotation contention", err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("rotation replayed provider refresh")
	}
	if _, err := f.s.sessionCredential(context.Background(), session.Value); err != nil {
		t.Fatal("refresh result lost during rotation", err)
	}
	status, err := KeyStatus(context.Background(), f.db, keys)
	if err != nil || countKeyUses(status, "legacy") != 0 {
		t.Fatal("refresh did not atomically save active key", err)
	}
}

func TestKeyOperatorMetadataNeverIncludesCiphertext(t *testing.T) {
	typeName := CredentialKeyOperation{OperationID: strings.Repeat("a", 32), Status: CredentialKeyStatus{Keys: []CredentialKeyUsage{}}}
	data, err := json.Marshal(typeName)
	if err != nil || bytes.Contains(data, []byte("fingerprint")) || bytes.Contains(data, []byte("cipher")) {
		t.Fatal("operator serialization", err)
	}
}

func TestKeyActivationHistoryFailureRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	f.session(t, "alice", "pat")
	keys := rotationKeys(t, f.s.config)
	if _, err := f.db.Exec(`CREATE FUNCTION reject_activation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test activation event failure'; END $$;
CREATE TRIGGER reject_activation_event BEFORE INSERT ON golf_crypto_events FOR EACH ROW EXECUTE FUNCTION reject_activation_event()`); err != nil {
		t.Fatal(err)
	}
	result, err := ActivateKey(context.Background(), f.db, keys)
	if !errors.Is(err, errStorageUnavailable) || result.Complete {
		t.Fatal("activation reported success without history", err)
	}
	q := database.New(f.db)
	active, err := q.GetEncryptionPolicy(context.Background())
	if err != nil || active != "legacy" {
		t.Fatal("activation history failure retained policy change", err)
	}
	if _, err := q.GetKeyFingerprint(context.Background(), "next"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("failed activation retained candidate label registration", err)
	}
	var events int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_crypto_events").Scan(&events); err != nil || events != 0 {
		t.Fatal("failed activation left success history", err)
	}
}

func TestKeyLegacyBootstrapReachesLaterPagePostgres(t *testing.T) {
	db := testDatabase(t)
	ctx := context.Background()
	q := database.New(db)
	keys := parseTestKeys(t, keyFixture(1), nil, "")
	id, err := q.UpsertUser(ctx, database.UpsertUserParams{ForgeURL: "https://forge.invalid", ForgeUserID: 42, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	queries := q.WithTx(tx)
	var lastHash, lastValid []byte
	for i := 0; i < 501; i++ {
		hash := make([]byte, 32)
		hash[0] = byte(i >> 8)
		hash[1] = byte(i)
		encrypted, _, err := keys.seal(sessionDomain, "legacy-page-credential", hash)
		if err != nil {
			t.Fatal(err)
		}
		if i == 500 {
			lastHash = hash
			lastValid = append([]byte{}, encrypted...)
			encrypted[0] ^= 1
		}
		if err := queries.CreateSession(ctx, database.CreateSessionParams{TokenHash: hash, UserID: id, EncryptedToken: encrypted, ExpiresAt: time.Now().Add(time.Hour), CredentialKind: "pat"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	config := testConfig("https://forge.invalid")
	config.EncryptionKey = keyFixture(1)
	if _, err := New(config, db); !errors.Is(err, errKeyBootstrap) {
		t.Fatal("bootstrap failed to authenticate second page", err)
	}
	if _, err := q.GetKeyFingerprint(ctx, "legacy"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("partial bootstrap registered legacy label")
	}
	if _, err := db.Exec("UPDATE golf_sessions SET encrypted_token=$2 WHERE token_hash=$1", lastHash, lastValid); err != nil {
		t.Fatal(err)
	}
	if _, err := New(config, db); err != nil {
		t.Fatal("fixed later-page ciphertext did not recover", err)
	}
	status, err := KeyStatus(ctx, db, keys)
	if err != nil || countKeyUses(status, "legacy") != 501 {
		t.Fatal("bootstrap rewrote/purged history", err)
	}
}

func TestKeyPendingVerifierLockExpiryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	state, binding, _ := seedAttempt(t, f.s, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := f.db.ExecContext(ctx, "UPDATE golf_oauth_attempts SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE state_hash=$1", state); err != nil {
		t.Fatal(err)
	}
	held, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.ExecContext(ctx, "SELECT state_hash FROM golf_oauth_attempts WHERE state_hash=$1 FOR UPDATE", state); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := f.s.consumeOAuthVerifier(ctx, state, binding); done <- err }()
	waitManagementLock(t, f.db, "LockOAuthAttempt", 1)
	for {
		var expired bool
		if err := f.db.QueryRowContext(ctx, "SELECT expires_at<=clock_timestamp() FROM golf_oauth_attempts WHERE state_hash=$1", state).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, errUnauthenticated) {
		t.Fatal("callback consumed verifier after expiry during row-lock wait", err)
	}
	var retained int
	if err := f.db.QueryRowContext(ctx, "SELECT count(*) FROM golf_oauth_attempts WHERE state_hash=$1", state).Scan(&retained); err != nil || retained != 1 {
		t.Fatal("expired wait destructively consumed verifier", err)
	}
}

func seedAutomationCredential(t *testing.T, db *sql.DB, keys *Keyring, forge, id string, expired bool) ([]byte, []byte) {
	t.Helper()
	userID, err := database.New(db).UpsertUser(t.Context(), database.UpsertUserParams{ForgeURL: forge, ForgeUserID: 42, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	binding := sha256.Sum256([]byte(id))
	encrypted, keyID, err := keys.seal(automationRepositoryDomain, "private-automation-native-token", binding[:])
	if err != nil {
		t.Fatal(err)
	}
	created, expires := time.Now(), time.Now().Add(time.Hour)
	if expired {
		created = time.Now().Add(-2 * time.Hour)
		expires = time.Now().Add(-time.Hour)
	}
	if _, err = db.Exec(`INSERT INTO golf_automation_grants(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,sponsor_user_id,sponsor_native_user_id,enabled,created_at,expires_at,idempotency_key,input_hash,branches,workflow_paths) VALUES($1,$2,99,42,'alice','project',false,$3,42,false,$4,$5,$1,$6,'["main"]','[".github/workflows/check.yml"]')`, id, forge, userID, created, expires, binding[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO golf_automation_credentials(grant_id,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4)`, id, encrypted, binding[:], keyID); err != nil {
		t.Fatal(err)
	}
	return binding[:], encrypted
}

func TestAutomationCredentialKeyLifecyclePostgres(t *testing.T) {
	f := newManagementFixture(t)
	f.session(t, "alice", "pat")
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i, id := range ids {
		seedAutomationCredential(t, f.db, f.s.keyring, f.s.config.ForgeURL, id, i == 2)
	}
	keys := rotationKeys(t, f.s.config)
	status, err := KeyStatus(t.Context(), f.db, keys)
	if err != nil || countKeyUses(status, "legacy") != 4 {
		t.Fatal("retained automation count missing", err)
	}
	var automation uint64
	for _, usage := range status.Keys {
		if usage.KeyID == "legacy" {
			automation = usage.AutomationCredentials
		}
	}
	if automation != 3 {
		t.Fatal("disabled/expired automation credentials not counted", automation)
	}
	mustActivate(t, f.db, keys)
	config := keyedConfig(f.s.config)
	config.EncryptionKey = ""
	if _, err := New(config, f.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("missing automation encryption key accepted", err)
	}
	if _, err := CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("in-use automation key eligible", err)
	}
	first, err := RotateCredentials(t.Context(), f.db, keys, 2, 1)
	if err != nil || first.Complete || first.Batches != 1 || first.RotatedSessions != 1 || first.RotatedAutomationCredentials != 1 || countKeyUses(first.Status, "legacy") != 2 {
		t.Fatal("fifth family exceeded global batch or ignored", err, first)
	}
	resumed, err := RotateCredentials(t.Context(), f.db, keys, 1, 2)
	if err != nil || !resumed.Complete || resumed.Batches != 2 || resumed.RotatedAutomationCredentials != 2 {
		t.Fatal("bounded automation resume", err, resumed)
	}
	for _, id := range ids {
		var encrypted, binding []byte
		var label string
		var version int64
		if err := f.db.QueryRow(`SELECT encrypted_credential,credential_binding,credential_key_id,version FROM golf_automation_credentials WHERE grant_id=$1`, id).Scan(&encrypted, &binding, &label, &version); err != nil {
			t.Fatal(err)
		}
		plain, err := keys.open(label, automationRepositoryDomain, encrypted, binding)
		if err != nil || plain != "private-automation-native-token" || label != "next" || version != 1 {
			t.Fatal("rotation altered credential identity", err)
		}
		if _, err := keys.open(label, infrastructureConnectionDomain, encrypted, binding); err == nil {
			t.Fatal("automation ciphertext opened in another domain")
		}
	}
	var activated, rotated int64
	if err := f.db.QueryRow(`SELECT coalesce(sum(automation_credentials_count) FILTER(WHERE action='ACTIVE_KEY_CHANGED'),0),coalesce(sum(automation_credentials_count) FILTER(WHERE action='CREDENTIAL_BATCH_REENCRYPTED'),0) FROM golf_crypto_events`).Scan(&activated, &rotated); err != nil || activated != 3 || rotated != 3 {
		t.Fatal("automation operator audit counts", err, activated, rotated)
	}
	if _, err := CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); err != nil {
		t.Fatal("zero-use automation key retirement", err)
	}
	if _, err := New(config, f.db); err != nil {
		t.Fatal("startup after removal of rotated key", err)
	}
	raw, _ := json.Marshal(resumed)
	for _, secret := range []string{"private-automation-native-token", "credential_binding", "encrypted_credential", keyFixture(9)} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("automation rotation output exposed private data")
		}
	}
}

func TestAutomationCredentialKeyRollbackAndBusyPostgres(t *testing.T) {
	db := testDatabase(t)
	config := testConfig("https://forge.invalid")
	s, err := New(config, db)
	if err != nil {
		t.Fatal(err)
	}
	firstID, secondID := uuid.NewString(), uuid.NewString()
	_, before := seedAutomationCredential(t, db, s.keyring, config.ForgeURL, firstID, false)
	seedAutomationCredential(t, db, s.keyring, config.ForgeURL, secondID, false)
	keys := rotationKeys(t, config)
	mustActivate(t, db, keys)
	if _, err := db.Exec(`CREATE FUNCTION reject_automation_crypto_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_automation_crypto_fixture BEFORE INSERT ON golf_crypto_events FOR EACH ROW EXECUTE FUNCTION reject_automation_crypto_fixture()`); err != nil {
		t.Fatal(err)
	}
	failed, err := RotateCredentials(t.Context(), db, keys, 10, 1)
	if !errors.Is(err, errStorageUnavailable) || failed.Batches != 0 || failed.RotatedAutomationCredentials != 0 {
		t.Fatal("unaudited automation rotation reported success", err)
	}
	var after []byte
	var label string
	if err := db.QueryRow(`SELECT encrypted_credential,credential_key_id FROM golf_automation_credentials WHERE grant_id=$1`, firstID).Scan(&after, &label); err != nil || !bytes.Equal(before, after) || label != "legacy" {
		t.Fatal("failed audit left partial automation rewrite", err)
	}
	if _, err := db.Exec("DROP TRIGGER reject_automation_crypto_fixture ON golf_crypto_events"); err != nil {
		t.Fatal(err)
	}
	held, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.Exec(`SELECT grant_id FROM golf_automation_credentials WHERE grant_id=$1 FOR UPDATE`, firstID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	partial, err := RotateCredentials(ctx, db, keys, 10, 1)
	if err != nil || partial.Complete || partial.RotatedAutomationCredentials != 1 || countKeyUses(partial.Status, "legacy") != 1 {
		t.Fatal("busy automation row was blocked or hidden", err, partial)
	}
	if _, err := CheckKeyRetirement(ctx, db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("busy retained key retired", err)
	}
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	resumed, err := RotateCredentials(t.Context(), db, keys, 10, 1)
	if err != nil || !resumed.Complete || resumed.RotatedAutomationCredentials != 1 {
		t.Fatal("busy automation resume failed", err)
	}
}

func TestAutomationCredentialLegacyBootstrapPagesPostgres(t *testing.T) {
	db := testDatabase(t)
	keys := parseTestKeys(t, keyFixture(1), nil, "")
	var last string
	var original []byte
	for i := 1; i <= 501; i++ {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012x", i)
		_, encrypted := seedAutomationCredential(t, db, keys, "https://forge.invalid", id, false)
		if i == 501 {
			last = id
			original = encrypted
		}
	}
	damaged := append([]byte(nil), original...)
	damaged[0] ^= 1
	if _, err := db.Exec(`UPDATE golf_automation_credentials SET encrypted_credential=$2 WHERE grant_id=$1`, last, damaged); err != nil {
		t.Fatal(err)
	}
	config := testConfig("https://forge.invalid")
	config.EncryptionKey = keyFixture(1)
	if _, err := New(config, db); !errors.Is(err, errKeyBootstrap) {
		t.Fatal("bootstrap skipped fifth-family second page", err)
	}
	if _, err := database.New(db).GetKeyFingerprint(t.Context(), "legacy"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("failed automation bootstrap registered key label", err)
	}
	if _, err := db.Exec(`UPDATE golf_automation_credentials SET encrypted_credential=$2 WHERE grant_id=$1`, last, original); err != nil {
		t.Fatal(err)
	}
	if _, err := New(config, db); err != nil {
		t.Fatal("repaired automation bootstrap failed", err)
	}
	status, err := KeyStatus(t.Context(), db, keys)
	if err != nil || countKeyUses(status, "legacy") != 501 {
		t.Fatal("bootstrap rewrote or discarded automation history", err)
	}
}
