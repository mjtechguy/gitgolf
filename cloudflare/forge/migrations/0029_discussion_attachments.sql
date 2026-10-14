-- comment_id 0 is the issue or pull request description. Comments carry no foreign key, so deleting a comment never fails here.
CREATE TABLE IF NOT EXISTS discussion_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  comment_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS discussion_attachments_name ON discussion_attachments(discussion_id,comment_id,name);
CREATE TABLE IF NOT EXISTS discussion_attachment_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  comment_id INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  original TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  attachment_id INTEGER REFERENCES discussion_attachments(id),
  object TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
