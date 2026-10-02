package server

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

var recoveryBackupID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var errRecovery = errors.New("Restored session invalidation failed; verify database availability and recovery history before retrying.")

func ValidRecoveryBackupID(value string) bool { return recoveryBackupID.MatchString(value) }

// RecoveryResult contains committed operator metadata, never session identifiers
// or credentials. The actor is the PostgreSQL role, not a claimed Golf user.
type RecoveryResult struct {
	BackupID                   string    `json:"backup_id"`
	OperationID                string    `json:"operation_id"`
	OccurredAt                 time.Time `json:"occurred_at"`
	Actor                      string    `json:"actor"`
	SessionsCount              uint64    `json:"sessions_count"`
	OAuthAttemptsCount         uint64    `json:"oauth_attempts_count"`
	LocalAccountsDisabledCount uint64    `json:"local_accounts_disabled_count"`
}

// InvalidateRestoredSessions requires ALL writers to be stopped and drained.
// Its table locks protect only this transaction, not future writes. It neither
// reconciles Gitea/provider revocations nor authorizes reopening restored traffic.
// No keys are needed: invalidation deletes ciphertext without decrypting it.
func InvalidateRestoredSessions(ctx context.Context, db *sql.DB, backupID string) (RecoveryResult, error) {
	if !ValidRecoveryBackupID(backupID) {
		return RecoveryResult{}, errors.New("Recovery requires a canonical 32-character lowercase hexadecimal backup ID.")
	}
	fail := func() (RecoveryResult, error) {
		if ctx.Err() != nil {
			return RecoveryResult{}, ctx.Err()
		}
		return RecoveryResult{}, errRecovery
	}
	if db == nil {
		return fail()
	}
	operation, err := newAuditOperation()
	if err != nil {
		return fail()
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fail()
	}
	defer tx.Rollback()
	queries := database.New(db).WithTx(tx)
	if err := queries.LockRecoveryCredentials(ctx); err != nil {
		return fail()
	}
	if _, err := tx.ExecContext(ctx, `LOCK TABLE golf_workflow_runs IN ACCESS EXCLUSIVE MODE`); err != nil {
		return fail()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason='Restored instance quarantined; no automatic replay.',lease_token_hash=NULL WHERE state IN ('queued','running')`); err != nil {
		return fail()
	}
	sessions, err := queries.DeleteRecoverySessions(ctx)
	if err != nil {
		return fail()
	}
	attempts, err := queries.DeleteRecoveryOAuthAttempts(ctx)
	if err != nil {
		return fail()
	}
	locals, err := queries.DisableRecoveryLocalAccounts(ctx)
	if err != nil {
		return fail()
	}
	for _, account := range locals {
		if err := queries.AppendLocalAccountEvent(ctx, database.AppendLocalAccountEventParams{AccountID: account.ID, OperationID: operation, Action: "RECOVERY_DISABLED", CredentialVersion: account.CredentialVersion}); err != nil {
			return fail()
		}
	}
	event, err := queries.AppendRecoveryEvent(ctx, database.AppendRecoveryEventParams{BackupID: backupID, OperationID: operation, SessionsCount: sessions, OauthAttemptsCount: attempts, LocalAccountsDisabledCount: int64(len(locals))})
	if err != nil {
		return fail()
	}
	if err := tx.Commit(); err != nil {
		// A lost commit response is not proof of rollback. Return no successful
		// counts; the operator must inspect recovery history before retrying.
		return fail()
	}
	return RecoveryResult{BackupID: event.BackupID, OperationID: event.OperationID, OccurredAt: event.OccurredAt.UTC(), Actor: event.Actor, SessionsCount: uint64(event.SessionsCount), OAuthAttemptsCount: uint64(event.OauthAttemptsCount), LocalAccountsDisabledCount: uint64(event.LocalAccountsDisabledCount)}, nil
}
