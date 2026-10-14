-- Semantic search. Vectorize holds vectors whose only metadata is the repository and kind; source text stays in Artifacts and D1.
-- One row per indexed repository: the served index (model, dimensions, commit) and the build in progress (target_*).
CREATE TABLE IF NOT EXISTS search_state (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  state TEXT NOT NULL CHECK(state IN ('PENDING','INDEXING','READY','FAILED','REMOVING')),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  commit_id TEXT,
  target_model TEXT,
  target_dimensions INTEGER,
  target_commit TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_by INTEGER REFERENCES users(id),
  indexed_at TEXT,
  verified_at TEXT,
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Default-branch files of the served commit (served=1) and of the commit being indexed (served=0), including skipped ones.
CREATE TABLE IF NOT EXISTS search_files (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  served INTEGER NOT NULL CHECK(served IN (0,1)),
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY(repository_id,served,path)
);
-- One row per vector. id is the Vectorize id; no text is kept here either, only where to read it back.
CREATE TABLE IF NOT EXISTS search_chunks (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('code','issue','pull')),
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','LIVE','RETIRING'))
);
CREATE INDEX IF NOT EXISTS search_chunks_repository ON search_chunks(repository_id,kind,state);
CREATE INDEX IF NOT EXISTS search_chunks_source ON search_chunks(repository_id,source_id);
-- Work still to embed: changed default-branch files, and issues or pull requests created or edited after indexing started.
CREATE TABLE IF NOT EXISTS search_outbox (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('code','discussion')),
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  PRIMARY KEY(repository_id,kind,source)
);
-- Embedding calls per UTC day; user 0 is the background indexer.
CREATE TABLE IF NOT EXISTS search_usage (
  day TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY(day,user_id)
);
CREATE TRIGGER IF NOT EXISTS search_discussion_insert AFTER INSERT ON discussions WHEN EXISTS(SELECT 1 FROM search_state WHERE repository_id=NEW.repository_id AND state!='REMOVING') BEGIN
  INSERT INTO search_outbox(repository_id,kind,source,version,queued_at) VALUES(NEW.repository_id,'discussion',CAST(NEW.id AS TEXT),'',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(repository_id,kind,source) DO UPDATE SET queued_at=excluded.queued_at;
END;
CREATE TRIGGER IF NOT EXISTS search_discussion_update AFTER UPDATE OF title,body ON discussions WHEN EXISTS(SELECT 1 FROM search_state WHERE repository_id=NEW.repository_id AND state!='REMOVING') BEGIN
  INSERT INTO search_outbox(repository_id,kind,source,version,queued_at) VALUES(NEW.repository_id,'discussion',CAST(NEW.id AS TEXT),'',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(repository_id,kind,source) DO UPDATE SET queued_at=excluded.queued_at;
END;
