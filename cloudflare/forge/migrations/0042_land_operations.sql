-- Land operations (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-4 items 4 and 5). One row per attempt to land a pull request
-- through the native merge path, by a person (trigger 'person', actor_id the account) or by the agentic mode policy (trigger 'policy',
-- actor_id 0). state: QUEUED, LANDING, then LANDED, NEEDS_REBASE (conflicting paths in detail), BLOCKED or FAILED; a landed change
-- whose required checks then fail on the base branch can become REVERTED with revert_commit_id. base_commit_id is the base tip it
-- landed on. detail is a JSON object (reasons, conflicts, check names, revert progress). At most one QUEUED or LANDING row per pull
-- request. A person's request may carry an idempotency key (UUID v4): a replay returns the original operation. Replay-safe.
CREATE TABLE IF NOT EXISTS land_operations (
 id TEXT PRIMARY KEY,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
 number INTEGER NOT NULL,
 trigger TEXT NOT NULL CHECK(trigger IN ('person','policy')),
 actor_id INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','LANDING','LANDED','NEEDS_REBASE','BLOCKED','FAILED','REVERTED')),
 method TEXT NOT NULL DEFAULT 'merge' CHECK(method IN ('merge','squash')),
 head_commit_id TEXT NOT NULL DEFAULT '',
 base_commit_id TEXT NOT NULL DEFAULT '',
 landed_commit_id TEXT NOT NULL DEFAULT '',
 revert_commit_id TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0,
 detail TEXT NOT NULL DEFAULT '{}',
 idempotency_key TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS land_operations_repository ON land_operations(repository_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS land_operations_one_active ON land_operations(pull_request_id) WHERE state IN ('QUEUED','LANDING');
CREATE UNIQUE INDEX IF NOT EXISTS land_operations_idempotency ON land_operations(actor_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
