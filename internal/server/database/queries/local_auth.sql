-- name: GetLocalAccount :one
SELECT a.*, u.forge_url, u.forge_user_id
FROM golf_local_accounts a JOIN golf_users u ON u.id = a.user_id
WHERE a.username = $1 AND u.forge_url = $2;

-- name: GetLocalAccountByEmail :one
SELECT a.*, u.forge_url, u.forge_user_id
FROM golf_local_accounts a JOIN golf_users u ON u.id = a.user_id
WHERE a.email = $1 AND u.forge_url = $2;

-- name: ChangeLocalEmail :exec
UPDATE golf_local_accounts SET email = $2, credential_version = credential_version + 1 WHERE id = $1;

-- Account/user lock order matches login, logout and all managed sessions.
-- name: LockLocalAccountUser :one
SELECT u.id FROM golf_users u JOIN golf_local_accounts a ON a.user_id = u.id
WHERE a.username = $1 AND u.forge_url = $2 FOR UPDATE OF u;

-- name: LockLocalAccount :one
SELECT * FROM golf_local_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: CreateLocalAccount :one
INSERT INTO golf_local_accounts(user_id,username,password_hash,encrypted_forge_token,credential_binding,credential_key_id,is_instance_admin,email)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;

-- name: ChangeLocalPassword :exec
UPDATE golf_local_accounts SET password_hash = $2, credential_version = credential_version + 1 WHERE id = $1;

-- name: DisableLocalAccount :exec
UPDATE golf_local_accounts SET disabled_at = clock_timestamp(), credential_version = credential_version + 1 WHERE id = $1;

-- name: EnableLocalAccount :exec
UPDATE golf_local_accounts SET password_hash = $2, encrypted_forge_token = $3, credential_key_id = $4,
disabled_at = NULL, credential_version = credential_version + 1 WHERE id = $1;

-- name: DeleteLocalAccountSessions :execrows
DELETE FROM golf_sessions WHERE local_account_id = $1;

-- name: AppendLocalAccountEvent :exec
INSERT INTO golf_local_account_events(account_id,operation_id,action,credential_version,sessions_revoked)
VALUES ($1,$2,$3,$4,$5);

-- name: CreateLocalSession :one
INSERT INTO golf_sessions(token_hash,user_id,encrypted_token,expires_at,credential_kind,credential_key_id,local_account_id,local_credential_version)
VALUES ($1,$2,$3,$4,'local',$5,$6,$7) RETURNING session_id;

-- name: LocalSessionAuthority :one
SELECT s.local_account_id,s.local_credential_version,s.expires_at,u.forge_user_id,
       a.credential_version,a.disabled_at,a.is_instance_admin
FROM golf_sessions s JOIN golf_users u ON u.id = s.user_id
LEFT JOIN golf_local_accounts a ON a.id = s.local_account_id AND a.user_id = s.user_id
WHERE s.token_hash = $1 AND u.forge_url = $2;

-- Counters commit before KDF/provider work and are shared by every replica.
-- name: ConsumeLocalLoginLimit :one
UPDATE golf_local_login_limits SET
attempts = CASE WHEN resets_at <= clock_timestamp() THEN 1 ELSE LEAST(attempts + 1,sqlc.arg(max_attempts)::integer + 1) END,
resets_at = CASE WHEN resets_at <= clock_timestamp() THEN clock_timestamp() + make_interval(secs => sqlc.arg(window_seconds)::double precision) ELSE resets_at END
WHERE bucket = sqlc.arg(bucket) RETURNING attempts;

-- A successful verification releases only its own exact-window reservation.
-- name: ConsumeReservedLocalLoginLimit :one
UPDATE golf_local_login_limits SET
attempts = CASE WHEN resets_at <= clock_timestamp() THEN 1 ELSE LEAST(attempts + 1,sqlc.arg(max_attempts)::integer + 1) END,
resets_at = CASE WHEN resets_at <= clock_timestamp() THEN clock_timestamp() + make_interval(secs => sqlc.arg(window_seconds)::double precision) ELSE resets_at END
WHERE bucket = sqlc.arg(bucket) RETURNING attempts,resets_at;

-- Saturation preserves denied/failed overflow charges; no decrement in a new window.
-- name: ReleaseReservedLocalLoginLimit :execrows
UPDATE golf_local_login_limits SET attempts=attempts-1
WHERE bucket=sqlc.arg(bucket) AND bucket BETWEEN 1 AND 1024
AND resets_at=sqlc.arg(resets_at) AND attempts BETWEEN 1 AND sqlc.arg(max_attempts)::integer;

-- name: LockRotationLocalAccounts :many
SELECT id,encrypted_forge_token,credential_key_id,credential_binding
FROM golf_local_accounts WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY id LIMIT sqlc.arg(row_limit) FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedLocalAccount :exec
UPDATE golf_local_accounts SET encrypted_forge_token = $2, credential_key_id = $3 WHERE id = $1;

-- name: BootstrapLegacyLocalAccounts :many
SELECT id,encrypted_forge_token,credential_binding FROM golf_local_accounts
WHERE credential_key_id = 'legacy' AND id > sqlc.arg(after_id) ORDER BY id LIMIT 500;

-- name: DisableRecoveryLocalAccounts :many
UPDATE golf_local_accounts SET disabled_at = clock_timestamp(), credential_version = credential_version + 1
RETURNING id,credential_version;

-- name: ResetLocalLoginLimit :exec
UPDATE golf_local_login_limits SET attempts = 0, resets_at = 'epoch' WHERE bucket = $1;
