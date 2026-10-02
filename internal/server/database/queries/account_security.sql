-- Own local-password confirmation snapshot. Hashes never cross the API boundary.
-- name: GetOwnPasswordConfirmation :one
SELECT a.id,a.user_id,a.username,a.email,a.password_hash,a.credential_version,
       s.session_id,s.expires_at,u.forge_user_id
FROM golf_local_accounts a JOIN golf_sessions s ON s.local_account_id=a.id AND s.user_id=a.user_id
JOIN golf_users u ON u.id=a.user_id
WHERE s.token_hash=sqlc.arg(token_hash) AND u.forge_url=sqlc.arg(forge_url)
AND s.credential_kind='local' AND a.disabled_at IS NULL
AND a.credential_version=s.local_credential_version AND s.expires_at>clock_timestamp();

-- Actor identity is required, and is the account's immutable Golf owner.
-- name: AppendSelfAccountChange :execrows
INSERT INTO golf_local_account_events(account_id,operation_id,action,credential_version,sessions_revoked,actor_user_id,actor_session_id)
SELECT a.id,sqlc.arg(operation_id),sqlc.arg(action),a.credential_version,sqlc.arg(sessions_revoked),a.user_id,sqlc.arg(actor_session_id)
FROM golf_local_accounts a WHERE a.id=sqlc.arg(account_id) AND a.user_id=sqlc.arg(actor_user_id)
AND a.credential_version=sqlc.arg(credential_version) AND a.disabled_at IS NULL;

-- Self-revocation intentionally removes the caller; only its captured expiry is
-- checked after the writes, with database wall-clock time immediately precommit.
-- name: OwnSecurityExpiryLive :one
SELECT sqlc.arg(expires_at)::timestamptz > clock_timestamp();
