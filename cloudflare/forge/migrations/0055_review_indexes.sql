-- Indexes for reads the 2026-10-16 review fixes left as scans or in a weaker order (docs/IMPLEMENTATION_STATUS.md).
-- AI impact reads the earliest successful merges of a period by settle time (src/contributions.mjs, 'merges').
CREATE INDEX IF NOT EXISTS pull_merge_operations_settled ON pull_merge_operations(updated_at,actor_id,operation_id) WHERE phase='SUCCEEDED';
-- Recent landings list the most recently updated land operations of a repository (src/land-queue.mjs, 'list').
CREATE INDEX IF NOT EXISTS land_operations_updated ON land_operations(repository_id,updated_at,id);
-- A repository's evidence jobs and previews, newest first (src/evidence.mjs, src/delivery.mjs).
CREATE INDEX IF NOT EXISTS evidence_jobs_repository ON evidence_jobs(repository_id,created_at,id);
CREATE INDEX IF NOT EXISTS previews_repository ON previews(repository_id,created_at,id);
