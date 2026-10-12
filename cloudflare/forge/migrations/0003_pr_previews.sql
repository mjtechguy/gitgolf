CREATE TABLE previews (
  id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id), job_id TEXT NOT NULL REFERENCES evidence_jobs(id),
  operation_key TEXT NOT NULL, input_hash TEXT NOT NULL, selection TEXT NOT NULL, pr_revision TEXT NOT NULL,
  commit_id TEXT NOT NULL, tree_id TEXT NOT NULL, source_path TEXT NOT NULL,
  bundle_key TEXT NOT NULL, bundle_hash TEXT NOT NULL, bundle_bytes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PUBLISHING','READY','REVOKED','EXPIRED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
  capture_state TEXT NOT NULL DEFAULT 'NONE' CHECK(capture_state IN ('NONE','DISPATCHED','READY','UNKNOWN')),
  capture_key TEXT, capture_hash TEXT, capture_bytes INTEGER, browser_ms INTEGER,
  UNIQUE(user_id,operation_key)
);
CREATE INDEX previews_cleanup ON previews(purged,state,expires_at);
CREATE TABLE preview_credentials (
  digest TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES previews(id), user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('grant','session')), expires_at TEXT NOT NULL
);
CREATE INDEX preview_credentials_expiry ON preview_credentials(expires_at);
