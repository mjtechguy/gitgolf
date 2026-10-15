-- Runner shares (docs/RUNNER_CAPACITY.md, S5 slice 2). The installation's share is the installation policy runner-shares
-- (installation_settings, src/capacity-policy.mjs): running pipeline jobs and runs started per UTC day for each organization (all its
-- repositories together) and each personal repository. A row here is one organization's or repository's own value, at or below its parent:
-- organization owners narrow the installation's, repository administrators narrow their organization's (or the installation's for a
-- personal repository). NULL inherits. pipelines.mjs enforces them in the claim and at run creation; no row changes nothing.
-- Not feature_policies: its mode is a CHECKed enum and its scope excludes repositories, and a CHECK cannot be relaxed by a replayable migration.
CREATE TABLE IF NOT EXISTS capacity_shares (
 scope TEXT NOT NULL CHECK(scope IN ('organization','repository')),
 scope_id INTEGER NOT NULL,                             -- native_owners.id of an organization, or repositories.id
 max_running INTEGER CHECK(max_running IS NULL OR max_running BETWEEN 1 AND 1000),
 max_runs_per_day INTEGER CHECK(max_runs_per_day IS NULL OR max_runs_per_day BETWEEN 1 AND 100000),
 -- Organizations only: the installation's higher value for this organization, from a capacity request an operations administrator approved.
 granted_running INTEGER CHECK(granted_running IS NULL OR granted_running BETWEEN 1 AND 1000),
 granted_runs_per_day INTEGER CHECK(granted_runs_per_day IS NULL OR granted_runs_per_day BETWEEN 1 AND 100000),
 version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id),
 CHECK(scope='organization' OR (granted_running IS NULL AND granted_runs_per_day IS NULL))
);
-- Runs started today, per repository, for the daily share.
CREATE INDEX IF NOT EXISTS pipeline_runs_created ON pipeline_runs(repository_id,created_at);
-- An organization owner's request for a higher share is a capacity_requests row (schema 49) with policy_key 'organization:<native_owners.id>'
-- and field maxRunning or maxRunsPerDay. Schema 49 has no scope column, and a migration after 0025 must replay safely, so it gains none; its
-- unique open-request index on (policy_key, field) then allows one open request per organization and field.
