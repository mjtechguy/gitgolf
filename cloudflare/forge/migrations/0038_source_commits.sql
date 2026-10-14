-- Source API commit journal (docs/AGENTIC_MODE_PLAN.md AM-2, docs/SOURCE_API.md). A commit with an idempotencyKey claims the key here
-- before anything is sent, with its input hash; each attempt then records its ref write (git_operations) and the response it returns. A
-- replay with the same inputs returns that response once the write is APPLIED; different inputs are refused. A claim whose write was
-- refused or settled NOT_APPLIED, or one abandoned before any write, is taken over by the next request with the key. Replay-safe.
CREATE TABLE IF NOT EXISTS source_commits (
 user_id INTEGER NOT NULL REFERENCES users(id),
 idempotency_key TEXT NOT NULL,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 input_hash TEXT NOT NULL,
 operation_id TEXT REFERENCES git_operations(id),
 result TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,idempotency_key)
);
