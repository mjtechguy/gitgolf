-- Current local admin confirmation snapshot. Never returned over the API.
-- name: GetAdminPasswordConfirmation :one
SELECT a.id,a.user_id,a.username,a.password_hash,a.credential_version,s.session_id
FROM golf_local_accounts a JOIN golf_sessions s ON s.local_account_id = a.id AND s.user_id = a.user_id
JOIN golf_users u ON u.id = a.user_id
WHERE s.token_hash = $1 AND u.forge_url = $2 AND s.credential_kind = 'local'
AND a.is_instance_admin AND a.disabled_at IS NULL AND a.credential_version = s.local_credential_version
AND s.expires_at > clock_timestamp();

-- name: GetAdminAccountTarget :one
SELECT a.id,a.user_id,u.forge_user_id,a.username,a.email,a.is_instance_admin,a.disabled_at,a.credential_version,a.created_at
FROM golf_local_accounts a JOIN golf_users u ON u.id = a.user_id
WHERE a.id = $1 AND u.forge_url = $2;

-- Follow the existing Golf-user -> local-account -> session lock order.
-- name: LockAdminAccountUsers :many
SELECT id FROM golf_users WHERE id IN (sqlc.arg(first_user_id), sqlc.arg(second_user_id)) ORDER BY id FOR UPDATE;

-- name: DisableRegularLocalAccount :execrows
UPDATE golf_local_accounts SET disabled_at = clock_timestamp(), credential_version = credential_version + 1
WHERE id = $1 AND credential_version = $2 AND NOT is_instance_admin AND disabled_at IS NULL;

-- name: AppendAdminAccountDisable :exec
INSERT INTO golf_local_account_events(account_id,operation_id,action,credential_version,sessions_revoked,actor_user_id,actor_session_id)
VALUES ($1,$2,'ADMIN_DISABLED',$3,$4,$5,$6);
