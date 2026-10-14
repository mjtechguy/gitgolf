-- Repository execution values and exact-source approvals. Values are AES-GCM ciphertext and plaintext is never stored.
CREATE TABLE IF NOT EXISTS execution_value_brokers (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS execution_values (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('secret','variable')), version INTEGER NOT NULL CHECK(version>0),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), value_bytes INTEGER NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository_id,name)
);
CREATE TABLE IF NOT EXISTS execution_value_versions (
 id TEXT NOT NULL REFERENCES execution_values(id), version INTEGER NOT NULL CHECK(version>0), value_bytes INTEGER NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 encrypted TEXT NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS execution_bindings (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 workflow_path TEXT NOT NULL, commit_id TEXT NOT NULL, blob_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, engine_catalog TEXT NOT NULL,
 event TEXT NOT NULL, event_ref TEXT NOT NULL, value_refs TEXT NOT NULL, sponsor_id INTEGER NOT NULL REFERENCES users(id),
 identity_version INTEGER NOT NULL, grant_generation INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_bindings_source ON execution_bindings(repository_id,commit_id);
CREATE TABLE IF NOT EXISTS execution_value_operations (
 operation_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('save_value','delete_value','save_binding','delete_binding')), item_id TEXT NOT NULL,
 accepted_version INTEGER NOT NULL, accepted_broker_revision INTEGER NOT NULL, input_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
-- One release per job: which approval version let its values leave storage, and when. Never the values.
CREATE TABLE IF NOT EXISTS execution_value_releases (
 job_id TEXT PRIMARY KEY REFERENCES evidence_jobs(id), binding_id TEXT NOT NULL REFERENCES execution_bindings(id), binding_version INTEGER NOT NULL, released_at TEXT NOT NULL
);
