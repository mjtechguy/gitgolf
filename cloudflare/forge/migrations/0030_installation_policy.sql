-- Installation policy inside the deploy allocation (schema 30). A missing row means the deploy value applies, so this migration changes nothing.
-- Keys are validated in code (src/installation.mjs), so new keys need no migration.
CREATE TABLE IF NOT EXISTS installation_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installation_operations (
  operation_id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Append-only record of administration changes at installation, organization and repository scope; before and after are JSON.
CREATE TABLE IF NOT EXISTS installation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  widening INTEGER NOT NULL DEFAULT 0 CHECK(widening IN (0, 1)),
  operation_id TEXT UNIQUE,
  client TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS installation_audit_scope ON installation_audit(scope, scope_id, id);
CREATE TRIGGER IF NOT EXISTS installation_audit_no_update BEFORE UPDATE ON installation_audit
BEGIN SELECT RAISE(ABORT, 'installation audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS installation_audit_no_delete BEFORE DELETE ON installation_audit
BEGIN SELECT RAISE(ABORT, 'installation audit is append-only'); END;
