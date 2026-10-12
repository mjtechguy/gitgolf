-- Apply only to Golf's native D1 workspace; seed its configured workspace separately.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  artifact_namespace TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS repository_stars (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(repository_id,user_id)
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  full_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0
);
