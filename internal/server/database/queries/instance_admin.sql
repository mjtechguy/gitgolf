-- Only nonsecret local-account metadata crosses the administration boundary.
-- Native account names/emails are not inferred or used to establish a binding.
-- name: ListLocalAccounts :many
SELECT a.id,a.username,a.email,u.forge_user_id,a.is_instance_admin,
       a.disabled_at,a.credential_version,a.created_at,a.user_id
FROM golf_local_accounts a JOIN golf_users u ON u.id = a.user_id
WHERE u.forge_url = sqlc.arg(forge_url)
ORDER BY a.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
