-- name: UpsertUser :one
INSERT INTO golf_users (forge_url, forge_user_id, login, full_name, avatar_url)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (forge_url, forge_user_id) DO UPDATE SET
    login = EXCLUDED.login,
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url
RETURNING id;

-- name: CreateSession :exec
INSERT INTO golf_sessions (token_hash, user_id, encrypted_token, expires_at, credential_kind)
VALUES ($1, $2, $3, $4, $5);

-- name: DeleteExpiredSessions :exec
DELETE FROM golf_sessions WHERE expires_at < now();

-- name: DeleteSession :exec
DELETE FROM golf_sessions WHERE token_hash = $1;

-- name: GetSessionCredential :one
SELECT s.encrypted_token, s.credential_kind, u.forge_user_id, s.expires_at, s.credential_key_id
FROM golf_sessions s
JOIN golf_users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp() AND u.forge_url = $2
AND (s.local_account_id IS NULL OR EXISTS (SELECT 1 FROM golf_local_accounts a WHERE a.id=s.local_account_id AND a.user_id=s.user_id AND a.credential_version=s.local_credential_version AND a.disabled_at IS NULL));

-- name: LockSessionCredential :one
SELECT s.encrypted_token, s.credential_kind, u.forge_user_id, s.expires_at, s.credential_key_id
FROM golf_sessions s
JOIN golf_users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp() AND u.forge_url = $2
AND (s.local_account_id IS NULL OR EXISTS (SELECT 1 FROM golf_local_accounts a WHERE a.id=s.local_account_id AND a.user_id=s.user_id AND a.credential_version=s.local_credential_version AND a.disabled_at IS NULL))
FOR UPDATE OF s;

-- name: CreateOAuthAttempt :exec
INSERT INTO golf_oauth_attempts (state_hash, binding_hash, encrypted_verifier, expires_at)
VALUES ($1, $2, $3, $4);

-- name: DeleteExpiredOAuthAttempts :exec
DELETE FROM golf_oauth_attempts WHERE expires_at <= now();
