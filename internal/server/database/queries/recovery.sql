-- Drained writers are an operator prerequisite. These locks protect this one
-- transaction only; they do not fence writers after the transaction commits.
-- name: LockRecoveryCredentials :exec
LOCK TABLE golf_sessions, golf_oauth_attempts, golf_local_accounts IN ACCESS EXCLUSIVE MODE;

-- Include all restored credentials, including expired records.
-- name: DeleteRecoverySessions :execrows
DELETE FROM golf_sessions;

-- name: DeleteRecoveryOAuthAttempts :execrows
DELETE FROM golf_oauth_attempts;

-- Actor/time come from PostgreSQL, never a caller-supplied Golf identity.
-- name: AppendRecoveryEvent :one
INSERT INTO golf_recovery_events (backup_id, operation_id, sessions_count, oauth_attempts_count, local_accounts_disabled_count, quarantine_counts)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING backup_id, operation_id, occurred_at, actor, sessions_count, oauth_attempts_count, local_accounts_disabled_count;
