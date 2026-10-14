CREATE TABLE IF NOT EXISTS repository_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  artifact_name TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tag_object_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0,1)),
  prerelease INTEGER NOT NULL DEFAULT 0 CHECK(prerelease IN (0,1)),
  author_id INTEGER NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_releases_tag ON repository_releases(repository_id,tag_name) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS repository_releases_inventory ON repository_releases(repository_id,deleted,id);
-- deleted: 0 listed, 1 removed while its R2 object awaits deletion, 2 object confirmed absent.
CREATE TABLE IF NOT EXISTS repository_release_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES repository_releases(id),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK(downloads>=0),
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1,2))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_release_assets_name ON repository_release_assets(release_id,name) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS repository_release_assets_state ON repository_release_assets(deleted,release_id,id);
-- receipt holds the immutable original; phase and result settle once. object names a reserved upload.
CREATE TABLE IF NOT EXISTS repository_release_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('publication','management')),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  result_id INTEGER,
  object TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
