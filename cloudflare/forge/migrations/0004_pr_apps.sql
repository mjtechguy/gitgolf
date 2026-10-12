ALTER TABLE previews ADD COLUMN kind TEXT NOT NULL DEFAULT 'STATIC' CHECK(kind IN ('STATIC','WORKER'));
ALTER TABLE previews ADD COLUMN policy_hash TEXT;
ALTER TABLE git_operations ADD COLUMN ci_state TEXT NOT NULL DEFAULT 'NONE' CHECK(ci_state IN ('NONE','PENDING','RECORDED','REFUSED'));
CREATE TABLE app_resources (
  preview_id TEXT NOT NULL REFERENCES previews(id), kind TEXT NOT NULL CHECK(kind IN ('database','bucket','cleaner','script','domain','migration')),
  name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('DISPATCHED','READY','DELETED')),
  provider_id TEXT, identity TEXT, PRIMARY KEY(preview_id,kind)
);
CREATE TABLE ci_intake (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES git_operations(id), repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id), number INTEGER NOT NULL, selection TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ADMITTED','REFUSED')),
  job_id TEXT, reason TEXT, created_at TEXT NOT NULL, UNIQUE(operation_id,number)
);
CREATE TABLE app_requests (day TEXT PRIMARY KEY, total INTEGER NOT NULL);
