-- Native merge journal. Commit title/message are fingerprinted in input_hash, never stored.
CREATE TABLE IF NOT EXISTS pull_merge_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  input_hash TEXT NOT NULL,
  original TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  detail TEXT NOT NULL DEFAULT '',
  git_operation_id TEXT REFERENCES git_operations(id),
  merge_commit_id TEXT NOT NULL DEFAULT '',
  actual_base_commit_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_merge_one_unresolved ON pull_merge_operations(pull_request_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE UNIQUE INDEX IF NOT EXISTS pull_merge_one_success ON pull_merge_operations(pull_request_id) WHERE phase='SUCCEEDED';
