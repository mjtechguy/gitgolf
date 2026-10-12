-- Review routing and administration are collaboration state, not merge authority.
CREATE TABLE IF NOT EXISTS pull_review_versions (
  pull_request_id INTEGER PRIMARY KEY REFERENCES pull_requests(id),
  version INTEGER NOT NULL CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS pull_review_requests (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  identity_version INTEGER NOT NULL,
  grant_generation INTEGER NOT NULL,
  PRIMARY KEY(pull_request_id,user_id)
);
CREATE TABLE IF NOT EXISTS pull_review_lifecycle (
  review_id INTEGER PRIMARY KEY REFERENCES pull_reviews(id),
  version INTEGER NOT NULL CHECK(version>0),
  dismissed INTEGER NOT NULL CHECK(dismissed IN (0,1)),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_review_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  kind TEXT NOT NULL CHECK(kind IN ('request','lifecycle','authoring')),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS pull_review_drafts (
  review_id INTEGER PRIMARY KEY REFERENCES pull_reviews(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING','PUBLISHED','DISCARDED')),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_review_one_pending ON pull_review_drafts(pull_request_id,author_id) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS pull_review_draft_versions (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version>0),
  PRIMARY KEY(pull_request_id,author_id)
);
