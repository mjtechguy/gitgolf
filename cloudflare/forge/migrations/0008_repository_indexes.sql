-- Replaceable immutable read models; no credentials or permission decisions are cached.
CREATE TABLE repository_indexes (
  key TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
  commit_id TEXT NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','READY')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX repository_indexes_expiry ON repository_indexes(expires_at,state);
