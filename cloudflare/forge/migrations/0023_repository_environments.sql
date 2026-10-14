CREATE TABLE IF NOT EXISTS repository_environments (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  artifact_name TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_environments_live ON repository_environments(repository_id) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS repository_environment_versions (
  environment_id TEXT NOT NULL REFERENCES repository_environments(id),
  version INTEGER NOT NULL CHECK(version>=1),
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  policy TEXT NOT NULL,
  target TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  environment_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(environment_id,version)
);
CREATE TABLE IF NOT EXISTS repository_environment_operations (
  operation_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  environment_id TEXT NOT NULL REFERENCES repository_environments(id),
  version INTEGER NOT NULL CHECK(version>=1),
  action TEXT NOT NULL CHECK(action IN ('save','delete')),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_environment_operations_repository ON repository_environment_operations(repository_id);
