-- Native identity has been verified before this transaction; this read does
-- not lock it ahead of the ordered actor/target user lock.
-- name: GetLifecycleNativeUser :one
SELECT id FROM golf_users WHERE forge_url = $1 AND forge_user_id = $2;

-- name: GetLifecycleEnrollment :one
SELECT * FROM golf_local_accounts WHERE user_id = $1;

-- Retain disabled_at: resetting a password must never reactivate an account.
-- name: ResetRegularLocalPassword :execrows
UPDATE golf_local_accounts SET password_hash = $3, credential_version = credential_version + 1
WHERE id = $1 AND credential_version = $2 AND NOT is_instance_admin;

-- name: EnableRegularLocalAccount :execrows
UPDATE golf_local_accounts SET password_hash = $3, encrypted_forge_token = $4,
credential_key_id = $5, disabled_at = NULL, credential_version = credential_version + 1
WHERE id = $1 AND credential_version = $2 AND NOT is_instance_admin AND disabled_at IS NOT NULL;

-- name: AppendAdminAccountLifecycle :exec
INSERT INTO golf_local_account_events(account_id,operation_id,action,credential_version,sessions_revoked,actor_user_id,actor_session_id)
VALUES ($1,$2,$3,$4,$5,$6,$7);
