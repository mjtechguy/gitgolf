-- No role is inferred from can_create or repository grants on existing installs.
CREATE TABLE IF NOT EXISTS operations_admins (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS operations_maintenance (
  stage TEXT PRIMARY KEY CHECK(stage IN ('ci','previews','evidence','indexes')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_success_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','degraded','failed')),
  processed INTEGER CHECK(processed IS NULL OR processed >= 0),
  pending INTEGER CHECK(pending IS NULL OR pending >= 0)
);
CREATE INDEX IF NOT EXISTS evidence_operations ON evidence_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS app_resources_operations ON app_resources(state,kind);
CREATE TABLE IF NOT EXISTS operations_provider (
  service TEXT PRIMARY KEY CHECK(service IN ('workers','artifacts','r2')),
  attempted_at TEXT NOT NULL, observed_at TEXT,
  window_start TEXT, window_end TEXT,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
  requests INTEGER, errors INTEGER, subrequests INTEGER
);
CREATE TABLE IF NOT EXISTS operations_delivery_failures (
  message_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES evidence_jobs(id),
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_delivery_expiry ON operations_delivery_failures(observed_at);
