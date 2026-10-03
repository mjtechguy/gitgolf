-- First establish an identity without updating/locking an existing account.
-- LockLoginUsers then obtains all affected accounts in immutable ID order.
-- name: EnsureLoginUser :exec
INSERT INTO golf_users (forge_url, forge_user_id, login, full_name, avatar_url)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (forge_url, forge_user_id) DO NOTHING;

-- name: LockLoginUsers :many
SELECT u.id, u.forge_user_id
FROM golf_users u
WHERE u.forge_url = sqlc.arg(forge_url)
  AND (u.forge_user_id = sqlc.arg(forge_user_id) OR u.id = (
    SELECT s.user_id FROM golf_sessions s WHERE s.token_hash = sqlc.arg(old_token_hash)
  ))
ORDER BY u.id
FOR UPDATE OF u;

-- Logout can remove an expired session and never needs a current provider token.
-- name: LockLogoutUser :one
SELECT u.id
FROM golf_users u
JOIN golf_sessions s ON s.user_id = u.id
WHERE s.token_hash = sqlc.arg(token_hash) AND u.forge_url = sqlc.arg(forge_url)
FOR UPDATE OF u;

-- Caller must already hold the subject account lock; this also scopes cookie
-- replacement/logout to this configured forge rather than a global cookie hash.
-- name: DeleteAuditedSession :one
DELETE FROM golf_sessions s
USING golf_users u
WHERE s.token_hash = sqlc.arg(token_hash) AND s.user_id = u.id
  AND u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
RETURNING s.session_id, s.credential_kind;

-- Every application writer holds the subject account lock BEFORE allocating an
-- event ID. Otherwise an older uncommitted ID could enter a previously read snapshot.
-- name: AppendAuditEvent :exec
INSERT INTO golf_audit_events (user_id, action, actor_session_id, target_session_id, credential_kind, revoked_count, operation_id, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: GetAuditSnapshot :one
SELECT COALESCE(max(e.id), 0)::bigint AS snapshot_id
FROM golf_audit_events e
JOIN golf_users u ON u.id = e.user_id
JOIN golf_sessions caller ON caller.user_id = u.id
WHERE u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
  AND caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp();

-- name: ListAuditEvents :many
SELECT e.id, e.occurred_at, e.action, e.actor_session_id, e.target_session_id,
       e.credential_kind, e.revoked_count, e.operation_id, e.expires_at,e.resource_id
FROM golf_audit_events e
JOIN golf_users u ON u.id = e.user_id
JOIN golf_sessions caller ON caller.user_id = u.id
WHERE u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
  AND caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND e.id <= sqlc.arg(snapshot_id)
  AND (sqlc.arg(before_id)::bigint = 0 OR e.id < sqlc.arg(before_id))
ORDER BY e.id DESC
LIMIT sqlc.arg(row_limit);

-- name: OwnAuditCursor :one
SELECT EXISTS (
  SELECT 1 FROM golf_audit_events e
  JOIN golf_users u ON u.id = e.user_id
  JOIN golf_sessions caller ON caller.user_id = u.id
  WHERE e.id = sqlc.arg(event_id) AND u.id = sqlc.arg(user_id)
    AND u.forge_url = sqlc.arg(forge_url)
    AND caller.token_hash = sqlc.arg(caller_token_hash)
    AND caller.expires_at > clock_timestamp()
);

-- name: AppendCodexAuditEvent :exec
INSERT INTO golf_audit_events (user_id,action,actor_session_id,target_session_id,credential_kind,revoked_count,operation_id,expires_at,resource_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);
