-- Native D1 only. Existing repository identities and Git authority are preserved.
CREATE TABLE IF NOT EXISTS repository_settings (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  description TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0
);
