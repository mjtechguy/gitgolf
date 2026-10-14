-- Feature policies. No row means ALLOWED at installation and organization scope and enabled for the repository,
-- so applying this migration changes nothing. Feature names are validated in code, never by CHECK.
CREATE TABLE IF NOT EXISTS feature_policies (
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization')), scope_id TEXT NOT NULL, feature TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('DISABLED','ALLOWED','ENFORCED')), version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,feature)
);
-- A repository's own choice; a row for another artifact enables nothing. Actions keeps its switch in repository_execution_policy.
CREATE TABLE IF NOT EXISTS repository_features (
 repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL, feature TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(repository_id,feature)
);
-- One fence per policy scope: every change in a scope advances it inside the same batch.
CREATE TABLE IF NOT EXISTS policy_revisions (
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')), scope_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), PRIMARY KEY(scope,scope_id)
);
