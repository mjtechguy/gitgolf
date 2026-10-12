-- Repository-only Git credentials. Secrets are returned once and only their hashes persist.
CREATE TABLE IF NOT EXISTS git_credentials (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 digest TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,
 label TEXT NOT NULL,
 mode INTEGER NOT NULL CHECK(mode IN (1,2)),
 identity_version INTEGER NOT NULL,
 grant_generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+3600),
 revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS git_credentials_inventory ON git_credentials(user_id,repository_id,id);
