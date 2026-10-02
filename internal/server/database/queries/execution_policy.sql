-- name: GetExecutionPolicy :one
SELECT * FROM golf_execution_policies WHERE forge_url=$1 AND scope=$2 AND scope_id=$3;
-- name: EnsureExecutionPolicy :exec
INSERT INTO golf_execution_policies(forge_url,scope,scope_id,owner_id,mode)
VALUES($1,$2,$3,$4,'disabled') ON CONFLICT DO NOTHING;
-- name: LockExecutionPolicy :one
SELECT * FROM golf_execution_policies WHERE forge_url=$1 AND scope=$2 AND scope_id=$3 FOR UPDATE;
-- name: UpdateExecutionPolicy :one
UPDATE golf_execution_policies SET owner_id=sqlc.arg(owner_id),mode=sqlc.arg(mode),manual_dispatch_enabled=sqlc.arg(manual_dispatch_enabled),push_allowed=sqlc.arg(push_allowed),allow_all_workflows=sqlc.arg(allow_all_workflows),revision=revision+1,revocation_epoch=revocation_epoch+1,updated_at=clock_timestamp()
WHERE forge_url=sqlc.arg(forge_url) AND scope=sqlc.arg(scope) AND scope_id=sqlc.arg(scope_id) AND revision=sqlc.arg(expected_revision)
RETURNING *;
-- name: ListExecutionPolicyRepositories :many
SELECT repository_id,owner_id FROM golf_execution_policy_repositories WHERE forge_url=$1 AND scope=$2 AND scope_id=$3 ORDER BY repository_id;
-- name: ListExecutionPolicyWorkflows :many
SELECT workflow_path FROM golf_execution_policy_workflows WHERE forge_url=$1 AND scope=$2 AND scope_id=$3 ORDER BY workflow_path;
-- name: DeleteExecutionPolicyRepositories :exec
DELETE FROM golf_execution_policy_repositories WHERE forge_url=$1 AND scope=$2 AND scope_id=$3;
-- name: DeleteExecutionPolicyWorkflows :exec
DELETE FROM golf_execution_policy_workflows WHERE forge_url=$1 AND scope=$2 AND scope_id=$3;
-- name: AddExecutionPolicyRepository :exec
INSERT INTO golf_execution_policy_repositories(forge_url,scope,scope_id,repository_id,owner_id)VALUES($1,$2,$3,$4,$5);
-- name: AddExecutionPolicyWorkflow :exec
INSERT INTO golf_execution_policy_workflows(forge_url,scope,scope_id,workflow_path)VALUES($1,$2,$3,$4);
-- name: AppendExecutionPolicyEvent :exec
INSERT INTO golf_execution_policy_events(forge_url,scope,scope_id,revision,revocation_epoch,actor_user_id,actor_session_id,action,mode,manual_dispatch_enabled,allow_all_workflows,selected_repository_count,workflow_count,push_allowed)
VALUES($1,$2,$3,$4,$5,$6,$7,'UPDATED',$8,$9,$10,$11,$12,$13);
