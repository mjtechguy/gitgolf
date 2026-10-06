package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func recoveryFixture(t *testing.T) (*managementFixture, loginResult, []byte, []byte) {
	t.Helper()
	f := newManagementFixture(t)
	saved := f.session(t, "alice", "pat")
	f.session(t, "alice", "oauth")
	f.session(t, "bob", "pat")
	expired := f.session(t, "alice", "pat")
	_, _, expiredHash := f.id(t, expired)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", expiredHash); err != nil {
		t.Fatal(err)
	}
	state, binding, _ := seedAttempt(t, f.s, false)
	seedAttempt(t, f.s, true)
	mustActivate(t, f.db, rotationKeys(t, f.s.config))
	return f, saved, state, binding
}

// Compare actual stored records, not only counts. The closed list contains only
// Golf test-schema tables; credentials/fingerprints are never printed on failure.
func recoverySnapshot(t *testing.T, db *sql.DB, credentials bool) map[string]string {
	t.Helper()
	tables := []string{"golf_users", "golf_audit_events", "golf_crypto_events", "golf_encryption_keys", "golf_encryption_policy"}
	if credentials {
		tables = append(tables, "golf_sessions", "golf_oauth_attempts", "golf_recovery_events", "golf_local_accounts", "golf_local_mfa", "golf_mfa_recovery_codes", "golf_mfa_login_challenges", "golf_mfa_events", "golf_codex_connections", "golf_codex_auth", "golf_agent_tasks", "golf_reviewer_runs", "golf_reviewer_publications", "golf_webhook_deliveries", "golf_email_deliveries")
	}
	result := map[string]string{}
	for _, table := range tables {
		var records string
		if err := db.QueryRow("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM " + table + " t").Scan(&records); err != nil {
			t.Fatal("cannot capture recovery fixture records")
		}
		result[table] = records
	}
	return result
}

func TestRecoveryInvalidArguments(t *testing.T) {
	for _, id := range []string{"", "private-invalid-backup", strings.Repeat("a", 31), strings.Repeat("a", 33), strings.Repeat("A", 32), strings.Repeat("g", 32), " " + strings.Repeat("a", 32), strings.Repeat("a", 32) + "\n"} {
		result, err := InvalidateRestoredSessions(context.Background(), nil, id)
		if err == nil || result != (RecoveryResult{}) || id != "" && strings.Contains(err.Error(), id) {
			t.Fatal("invalid backup ID was accepted or disclosed")
		}
	}
}

func TestRecoveryInvalidationPreservesHistoryPostgres(t *testing.T) {
	f, saved, state, binding := recoveryFixture(t)
	before := recoverySnapshot(t, f.db, false)
	backup := strings.Repeat("a", 32)
	result, err := InvalidateRestoredSessions(context.Background(), f.db, backup)
	if err != nil || result.SessionsCount != 4 || result.OAuthAttemptsCount != 2 || result.BackupID != backup || len(result.OperationID) != 32 || result.OccurredAt.IsZero() || result.Actor == "" {
		t.Fatal("committed invalidation metadata is incorrect")
	}
	if !reflect.DeepEqual(before, recoverySnapshot(t, f.db, false)) {
		t.Fatal("invalidation changed identities, account history, crypto history or key policy/registry")
	}
	var sessions, attempts, events int
	if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_oauth_attempts),(SELECT count(*) FROM golf_recovery_events)").Scan(&sessions, &attempts, &events); err != nil || sessions != 0 || attempts != 0 || events != 1 {
		t.Fatal("invalidation did not remove every credential and append exactly one operator event")
	}
	var stored RecoveryResult
	var actualRole bool
	if err := f.db.QueryRow("SELECT backup_id,operation_id,occurred_at,actor,sessions_count,oauth_attempts_count,actor=current_user FROM golf_recovery_events").Scan(&stored.BackupID, &stored.OperationID, &stored.OccurredAt, &stored.Actor, &stored.SessionsCount, &stored.OAuthAttemptsCount, &actualRole); err != nil || !actualRole || stored.BackupID != result.BackupID || stored.OperationID != result.OperationID || !stored.OccurredAt.Equal(result.OccurredAt) || stored.Actor != result.Actor || stored.SessionsCount != result.SessionsCount || stored.OAuthAttemptsCount != result.OAuthAttemptsCount {
		t.Fatal("recovery event did not preserve exact committed metadata and database actor")
	}
	if _, err := f.s.sessionCredential(context.Background(), saved.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("saved restored session remained usable")
	}
	if _, err := f.s.consumeOAuthVerifier(context.Background(), state, binding); !errors.Is(err, errUnauthenticated) {
		t.Fatal("restored pending OAuth attempt remained usable")
	}
	for _, query := range []string{"UPDATE golf_recovery_events SET backup_id=backup_id", "DELETE FROM golf_recovery_events", "TRUNCATE golf_recovery_events"} {
		if _, err := f.db.Exec(query); err == nil {
			t.Fatal("ordinary recovery-history mutation was accepted")
		}
	}
	again, err := InvalidateRestoredSessions(context.Background(), f.db, backup)
	if err != nil || again.SessionsCount != 0 || again.OAuthAttemptsCount != 0 || again.OperationID == result.OperationID {
		t.Fatal("repeated invalidation did not truthfully record a separate zero-count operation")
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{saved.Value, f.s.config.EncryptionKey, "encrypted_token", "state_hash", "fingerprint", "private-pkce-verifier", "fixture-refresh"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("recovery result disclosed credential or cryptographic material")
		}
	}
}

func TestRecoveryRollbackPostgres(t *testing.T) {
	for _, commitFailure := range []bool{false, true} {
		name := "insert"
		if commitFailure {
			name = "commit"
		}
		t.Run(name, func(t *testing.T) {
			f, _, _, _ := recoveryFixture(t)
			before := recoverySnapshot(t, f.db, true)
			if _, err := f.db.Exec(`CREATE FUNCTION reject_recovery_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-recovery-storage-error'; END $$`); err != nil {
				t.Fatal(err)
			}
			trigger := "CREATE TRIGGER reject_recovery BEFORE INSERT ON golf_recovery_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_fixture()"
			if commitFailure {
				trigger = "CREATE CONSTRAINT TRIGGER reject_recovery AFTER INSERT ON golf_recovery_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_recovery_fixture()"
			}
			if _, err := f.db.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			result, err := InvalidateRestoredSessions(context.Background(), f.db, strings.Repeat("b", 32))
			if err == nil || result != (RecoveryResult{}) || strings.Contains(err.Error(), "private-recovery-storage-error") {
				t.Fatal("failed recovery disclosed database details or reported successful counts")
			}
			if !reflect.DeepEqual(before, recoverySnapshot(t, f.db, true)) {
				t.Fatal("recovery transaction failed to restore all credentials and history after failure")
			}
		})
	}
}

func TestRecoveryCancellationAndInvalidIDPreserveRecordsPostgres(t *testing.T) {
	f, _, _, _ := recoveryFixture(t)
	before := recoverySnapshot(t, f.db, true)
	if result, err := InvalidateRestoredSessions(context.Background(), f.db, "unknown-private-backup"); err == nil || result != (RecoveryResult{}) {
		t.Fatal("invalid recovery ID was accepted")
	}
	locked, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback()
	if _, err := locked.Exec("LOCK TABLE golf_sessions IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result, err := InvalidateRestoredSessions(ctx, f.db, strings.Repeat("c", 32))
	if !errors.Is(err, context.DeadlineExceeded) || result != (RecoveryResult{}) {
		t.Fatal("blocked invalidation did not honor its deadline without successful counts")
	}
	if err := locked.Rollback(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, recoverySnapshot(t, f.db, true)) {
		t.Fatal("canceled or invalid recovery changed stored records")
	}
}
