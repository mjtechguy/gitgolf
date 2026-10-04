-- name: LockRepositoryLifecycle :exec
SELECT golf_repository_lifecycle_lock(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint,true);
-- name: CountRepositoryLifecycleActive :one
SELECT golf_repository_lifecycle_active(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint)::bigint;
-- name: RepositoryLifecycleUnresolved :one
SELECT EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=$1 AND repository_id=$2 AND phase IN ('RESERVED','DISPATCH_UNKNOWN'));
-- name: ReserveRepositoryLifecycle :one
INSERT INTO golf_repository_lifecycle_operations(user_id,forge_url,actor_id,idempotency_key,repository_id,owner_id,repository_owner,repository_name,expected_revision,from_archived,to_archived,fingerprint)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *;
-- name: GetOwnRepositoryLifecycle :one
SELECT * FROM golf_repository_lifecycle_operations WHERE user_id=$1 AND forge_url=$2 AND idempotency_key=$3;
-- name: AdvanceRepositoryLifecycle :one
UPDATE golf_repository_lifecycle_operations SET phase=$4,failure_code=$5,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND forge_url=$3 RETURNING *;
-- name: RepositoryLifecycleBlocked :one
SELECT golf_repository_lifecycle_blocked(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint)::boolean;

-- name: ReserveRepositoryDeletion :one
INSERT INTO golf_repository_lifecycle_operations(user_id,forge_url,actor_id,idempotency_key,repository_id,owner_id,repository_owner,repository_name,expected_revision,from_archived,to_archived,fingerprint,action,owner_is_organization)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'delete',$12) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *;
