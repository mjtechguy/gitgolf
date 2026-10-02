-- Lock the immutable Golf identity before any session row. Concurrent account
-- revocations must not each hold their own session while deleting the other.
-- name: LockSessionUser :one
SELECT u.id, u.forge_user_id
FROM golf_users u
JOIN golf_sessions caller ON caller.user_id = u.id
WHERE caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND u.forge_url = sqlc.arg(forge_url)
FOR UPDATE OF u;

-- Re-read and lock the caller after waiting for the identity lock.
-- name: LockManagedSession :one
SELECT caller.session_id, caller.user_id, caller.expires_at, caller.credential_kind
FROM golf_sessions caller
JOIN golf_users u ON u.id = caller.user_id
WHERE caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND u.id = sqlc.arg(user_id)
  AND u.forge_url = sqlc.arg(forge_url)
FOR UPDATE OF caller;

-- name: ListManagedSessions :many
SELECT s.session_id, s.created_at, s.expires_at, s.credential_kind,
       s.session_id = caller.session_id AS is_current
FROM golf_sessions s
JOIN golf_users u ON u.id = s.user_id
JOIN golf_sessions caller ON caller.user_id = u.id
WHERE caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND s.expires_at > clock_timestamp()
  AND u.id = sqlc.arg(user_id)
  AND u.forge_url = sqlc.arg(forge_url)
ORDER BY s.created_at DESC, s.session_id DESC
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: RevokeManagedSession :execrows
DELETE FROM golf_sessions target
USING golf_users u, golf_sessions caller
WHERE target.user_id = u.id AND caller.user_id = u.id
  AND caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND target.expires_at > clock_timestamp()
  AND u.id = sqlc.arg(user_id)
  AND u.forge_url = sqlc.arg(forge_url)
  AND target.session_id = sqlc.arg(session_id);

-- name: RevokeOtherManagedSessions :execrows
DELETE FROM golf_sessions target
USING golf_users u, golf_sessions caller
WHERE target.user_id = u.id AND caller.user_id = u.id
  AND caller.token_hash = sqlc.arg(caller_token_hash)
  AND caller.expires_at > clock_timestamp()
  AND target.expires_at > clock_timestamp()
  AND u.id = sqlc.arg(user_id)
  AND u.forge_url = sqlc.arg(forge_url)
  AND target.session_id <> caller.session_id;
