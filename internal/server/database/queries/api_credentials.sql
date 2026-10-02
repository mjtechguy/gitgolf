-- name: CreateApiCredential :one
INSERT INTO golf_api_credentials (user_id, token_hash, label, source_session_id, source_token_hash, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: AppendApiCredentialEvent :exec
INSERT INTO golf_api_credential_events (credential_id, actor_session_id, action, operation_id)
VALUES ($1, $2, $3, $4);

-- The hash+ID+owner binding prevents session-ID reuse from reviving authority.
-- Include the configured forge in every lookup; neither metadata nor a cookie
-- string supplied by the client can select another upstream installation.
-- name: GetLiveApiCredential :one
SELECT c.source_token_hash, c.source_session_id, c.user_id, u.forge_user_id
FROM golf_api_credentials c
JOIN golf_users u ON u.id = c.user_id
JOIN golf_sessions s ON s.token_hash = c.source_token_hash
  AND s.session_id = c.source_session_id AND s.user_id = c.user_id
WHERE c.token_hash = sqlc.arg(token_hash) AND u.forge_url = sqlc.arg(forge_url)
  AND c.revoked_at IS NULL AND c.expires_at > clock_timestamp()
  AND s.expires_at > clock_timestamp();

-- name: CountActiveApiCredentials :one
SELECT count(*) FROM golf_api_credentials c
JOIN golf_users u ON u.id = c.user_id
JOIN golf_sessions s ON s.token_hash = c.source_token_hash
  AND s.session_id = c.source_session_id AND s.user_id = c.user_id
WHERE c.user_id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
  AND c.revoked_at IS NULL AND c.expires_at > clock_timestamp()
  AND s.expires_at > clock_timestamp();

-- name: ListApiCredentials :many
SELECT c.id, c.label, c.created_at, c.expires_at, c.revoked_at, c.source_session_id,
  EXISTS (SELECT 1 FROM golf_sessions s WHERE s.token_hash = c.source_token_hash
    AND s.session_id = c.source_session_id AND s.user_id = c.user_id
    AND s.expires_at > clock_timestamp()) AS source_session_active
FROM golf_api_credentials c JOIN golf_users u ON u.id = c.user_id
WHERE c.user_id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
ORDER BY c.id DESC LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: GetOwnApiCredential :one
SELECT c.*,
  EXISTS (SELECT 1 FROM golf_sessions s WHERE s.token_hash = c.source_token_hash
    AND s.session_id = c.source_session_id AND s.user_id = c.user_id
    AND s.expires_at > clock_timestamp()) AS source_session_active
FROM golf_api_credentials c JOIN golf_users u ON u.id = c.user_id
WHERE c.id = sqlc.arg(id) AND c.user_id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url);

-- name: RevokeApiCredential :execrows
UPDATE golf_api_credentials c SET revoked_at = clock_timestamp()
FROM golf_users u
WHERE c.user_id = u.id AND c.id = sqlc.arg(id) AND c.user_id = sqlc.arg(user_id)
  AND u.forge_url = sqlc.arg(forge_url) AND c.revoked_at IS NULL;
