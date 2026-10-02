-- Account locks are acquired by withManagedSession before reservation. The
-- immutable Golf user encodes forge identity; every query also verifies its URL.
-- name: ReserveRepositoryCreation :one
INSERT INTO golf_repository_creations (user_id, idempotency_key, payload_fingerprint, requested_name, private, state)
SELECT u.id, sqlc.arg(idempotency_key), sqlc.arg(payload_fingerprint), sqlc.arg(requested_name), sqlc.arg(private), 'OUTCOME_UNKNOWN'
FROM golf_users u WHERE u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING *;

-- name: GetRepositoryCreation :one
SELECT c.* FROM golf_repository_creations c
JOIN golf_users u ON u.id = c.user_id
WHERE u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
  AND c.idempotency_key = sqlc.arg(idempotency_key);

-- Completion is evidence of an already dispatched native call and must survive
-- caller revocation. No active-session predicate belongs on this update.
-- name: CompleteRepositoryCreation :one
UPDATE golf_repository_creations c
SET state = sqlc.arg(state), repository_id = sqlc.narg(repository_id),
    repository_full_name = sqlc.narg(repository_full_name), failure_code = sqlc.arg(failure_code),
    updated_at = clock_timestamp()
FROM golf_users u
WHERE c.user_id = u.id AND u.id = sqlc.arg(user_id) AND u.forge_url = sqlc.arg(forge_url)
  AND c.id = sqlc.arg(creation_id) AND c.state = 'OUTCOME_UNKNOWN'
RETURNING c.*;

-- name: AppendRepositoryCreationEvent :exec
INSERT INTO golf_repository_creation_events (creation_id, state) VALUES ($1, $2);
