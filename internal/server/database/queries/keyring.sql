-- name: CreateKeyedSession :one
INSERT INTO golf_sessions (token_hash, user_id, encrypted_token, expires_at, credential_kind, credential_key_id)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING session_id;

-- name: CreateKeyedOAuthAttempt :exec
INSERT INTO golf_oauth_attempts (state_hash, binding_hash, encrypted_verifier, expires_at, credential_key_id)
VALUES ($1, $2, $3, $4, $5);

-- name: LockOAuthAttempt :one
SELECT encrypted_verifier, credential_key_id, expires_at
FROM golf_oauth_attempts
WHERE state_hash = $1 AND binding_hash = $2 AND expires_at > clock_timestamp()
FOR UPDATE;

-- name: DeleteOAuthAttempt :execrows
DELETE FROM golf_oauth_attempts
WHERE state_hash = $1 AND binding_hash = $2 AND expires_at > clock_timestamp();

-- name: UpdateKeyedSessionCredential :exec
UPDATE golf_sessions SET encrypted_token = $2, credential_key_id = $3 WHERE token_hash = $1;

-- name: GetEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton;

-- name: LockEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton FOR UPDATE;

-- name: ShareEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton FOR SHARE;

-- name: SetEncryptionPolicy :exec
UPDATE golf_encryption_policy SET active_key_id = $1 WHERE singleton;

-- Serialize operators per transaction, not an entire unbounded rotate command.
-- name: LockEncryptionOperator :exec
SELECT pg_advisory_xact_lock(74191526730202002);

-- name: CountCredentialKeys :many
SELECT credential_key_id, sum(session_count)::bigint AS sessions, sum(attempt_count)::bigint AS oauth_attempts
FROM (
    SELECT credential_key_id, count(*) AS session_count, 0::bigint AS attempt_count FROM golf_sessions GROUP BY credential_key_id
    UNION ALL
    SELECT credential_key_id, 0::bigint, count(*) FROM golf_oauth_attempts GROUP BY credential_key_id
) counts
GROUP BY credential_key_id ORDER BY credential_key_id;

-- name: LockRotationSessions :many
SELECT token_hash, encrypted_token, credential_key_id
FROM golf_sessions
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY session_id LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: LockRotationOAuthAttempts :many
SELECT state_hash, encrypted_verifier, credential_key_id
FROM golf_oauth_attempts
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY state_hash LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedOAuthAttempt :exec
UPDATE golf_oauth_attempts SET encrypted_verifier = $2, credential_key_id = $3 WHERE state_hash = $1;

-- name: AppendCryptoEvent :exec
INSERT INTO golf_crypto_events (operation_id, action, key_id, sessions_count, oauth_attempts_count)
VALUES ($1, $2, $3, $4, $5);

-- name: GetKeyFingerprint :one
SELECT fingerprint FROM golf_encryption_keys WHERE key_id = $1;

-- The operator lock serializes registration with activation/bootstrap.
-- name: RegisterKeyFingerprint :exec
INSERT INTO golf_encryption_keys (key_id, fingerprint) VALUES ($1, $2);

-- name: BootstrapLegacySessions :many
SELECT session_id, token_hash, encrypted_token
FROM golf_sessions
WHERE credential_key_id = 'legacy' AND session_id > sqlc.arg(after_id)
ORDER BY session_id LIMIT 500;

-- name: BootstrapLegacyOAuthAttempts :many
SELECT state_hash, encrypted_verifier
FROM golf_oauth_attempts
WHERE credential_key_id = 'legacy' AND state_hash > sqlc.arg(after_hash)::bytea
ORDER BY state_hash LIMIT 500;
