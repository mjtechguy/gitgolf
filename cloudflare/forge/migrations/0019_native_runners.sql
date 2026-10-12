-- Workspace-owned outbound runner identities and explicit repository placement.
CREATE TABLE IF NOT EXISTS native_runner_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DRAINING')),
  trust_class TEXT NOT NULL CHECK(trust_class IN ('UNTRUSTED','TRUSTED')),
  max_parallel INTEGER NOT NULL CHECK(max_parallel BETWEEN 1 AND 20),
  image_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_runner_machines (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES native_runner_pools(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DRAINING','REVOKED','QUARANTINED')),
  sponsor_id INTEGER NOT NULL REFERENCES users(id),
  credential_digest TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  last_seen_at TEXT,
  active_job_id TEXT REFERENCES evidence_jobs(id),
  attempt_generation INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  lease_digest TEXT,
  lease_expires_at INTEGER,
  cleanup_state TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(cleanup_state IN ('CONFIRMED','UNKNOWN')),
  created_at TEXT NOT NULL,
  UNIQUE(pool_id,name)
);
CREATE INDEX IF NOT EXISTS native_runner_machine_pool ON native_runner_machines(pool_id,state);
CREATE TABLE IF NOT EXISTS native_runner_placements (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  pool_id TEXT REFERENCES native_runner_pools(id),
  pool_version INTEGER,
  version INTEGER NOT NULL CHECK(version>0),
  updated_at TEXT NOT NULL,
  CHECK((pool_id IS NULL)=(pool_version IS NULL))
);
