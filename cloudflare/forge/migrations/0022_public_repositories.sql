CREATE TABLE IF NOT EXISTS repository_visibility (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE INDEX IF NOT EXISTS repository_visibility_public ON repository_visibility(is_public,repository_id);
CREATE TABLE IF NOT EXISTS public_profiles (
  owner_id INTEGER PRIMARY KEY REFERENCES native_owners(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  readme TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
