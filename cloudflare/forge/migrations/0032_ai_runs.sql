-- One Workers AI run per (account, operation key). Input snapshots are dropped after 7 days; their hashes stay.
CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  input_snapshot TEXT,
  snapshot_hash TEXT,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('REQUESTED','RESERVED','SUCCEEDED','UNKNOWN','REFUSED')),
  infer_started_at TEXT,
  output TEXT,
  usage TEXT,
  refusal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(user_id,operation_key)
);
CREATE INDEX IF NOT EXISTS ai_runs_created ON ai_runs(created_at);
