-- Public ownership is separate from the stable installation/DO partition.
CREATE TABLE IF NOT EXISTS native_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('PERSONAL','ORGANIZATION')),
  user_id INTEGER UNIQUE REFERENCES users(id),
  full_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  creator_id INTEGER NOT NULL REFERENCES users(id),
  creation_key TEXT,
  input_hash TEXT,
  UNIQUE(creator_id,creation_key),
  CHECK((kind='PERSONAL' AND user_id IS NOT NULL) OR (kind='ORGANIZATION' AND user_id IS NULL))
);
CREATE TABLE IF NOT EXISTS native_owner_members (
  owner_id INTEGER NOT NULL REFERENCES native_owners(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  PRIMARY KEY(owner_id,user_id)
);
CREATE TABLE IF NOT EXISTS repository_owners (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  owner_id INTEGER NOT NULL REFERENCES native_owners(id)
);
CREATE INDEX IF NOT EXISTS repository_owners_owner ON repository_owners(owner_id,repository_id);
