-- name: LockRepositoryEnvironments :exec
SELECT golf_repository_environment_lock(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint);
-- name: GetRepositoryEnvironment :one
SELECT v.* FROM golf_repository_environment_versions v JOIN golf_repository_environments e ON e.forge_url=v.forge_url AND e.id=v.environment_id AND e.current_version=v.version
WHERE e.forge_url=$1 AND e.id=$2 AND e.repository_id=$3 AND e.owner_id=$4;
-- name: GetRepositoryEnvironmentVersion :one
SELECT * FROM golf_repository_environment_versions WHERE forge_url=$1 AND environment_id=$2 AND version=$3 AND repository_id=$4 AND owner_id=$5;
-- name: ListRepositoryEnvironments :many
SELECT v.* FROM golf_repository_environment_versions v JOIN golf_repository_environments e ON e.forge_url=v.forge_url AND e.id=v.environment_id AND e.current_version=v.version
WHERE e.forge_url=$1 AND e.repository_id=$2 AND e.owner_id=$3 AND NOT e.deleted ORDER BY e.name_key,e.id LIMIT $4 OFFSET $5;
-- name: CountRepositoryEnvironments :one
SELECT count(*)::bigint FROM golf_repository_environments WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND NOT deleted;
-- name: CountRepositoryEnvironmentOperations :one
SELECT count(*)::bigint FROM golf_repository_environment_operations WHERE forge_url=$1 AND repository_id=$2;
-- name: GetOwnRepositoryEnvironmentOperation :one
SELECT * FROM golf_repository_environment_operations WHERE user_id=$1 AND operation_id=$2 AND forge_url=$3;
-- name: InsertRepositoryEnvironment :exec
INSERT INTO golf_repository_environments(forge_url,id,repository_id,owner_id,name_key,current_version,deleted) VALUES($1,$2,$3,$4,lower($5::text),1,false);
-- name: AdvanceRepositoryEnvironment :execrows
UPDATE golf_repository_environments SET name_key=lower($5::text),current_version=current_version+1,deleted=$6 WHERE forge_url=$1 AND id=$2 AND repository_id=$3 AND owner_id=$4 AND current_version=$7 AND NOT deleted;
-- name: InsertRepositoryEnvironmentVersion :one
INSERT INTO golf_repository_environment_versions(forge_url,environment_id,repository_id,owner_id,version,name,deleted,policy,creator_user_id,creator_native_id,actor_user_id,actor_native_id,repository_owner,repository_name,access_revision,environment_created_at,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *;
-- name: InsertRepositoryEnvironmentOperation :one
INSERT INTO golf_repository_environment_operations(user_id,operation_id,forge_url,environment_id,repository_id,owner_id,action,expected_version,version,input_fingerprint,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *;
