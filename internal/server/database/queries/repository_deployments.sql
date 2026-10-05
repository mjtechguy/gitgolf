-- name: LockRepositoryDeploymentEnvironment :exec
SELECT golf_deployment_lock(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint);
-- name: CountLiveEnvironmentDeployments :one
SELECT count(*)::bigint FROM golf_repository_deployments WHERE environment_id=$1 AND state='READY' AND expires_at>clock_timestamp();
-- name: DeleteExpiredPreviewCredentials :execrows
DELETE FROM golf_preview_credentials WHERE token_hash IN (SELECT token_hash FROM golf_preview_credentials WHERE expires_at<=clock_timestamp() ORDER BY expires_at,token_hash LIMIT 100);
