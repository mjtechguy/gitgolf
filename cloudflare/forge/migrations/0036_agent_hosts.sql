-- Agent hosts and "Assign to agent" (docs/AGENT_HOSTS.md, agents plan phase 1a). Tokens and credentials are stored as
-- SHA-256 only; every route re-checks the `agent-hosts` feature, the requester's grant and the host's scope. Replay-safe.
CREATE TABLE IF NOT EXISTS agent_host_registrations (
 id TEXT PRIMARY KEY,                                   -- UUID v4
 scope TEXT NOT NULL CHECK(scope IN ('personal','organization','installation')),
 scope_id TEXT NOT NULL,                                -- users.id | native_owners.id | '' (decimal text)
 token_digest TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of golfagentreg_…; plaintext shown once
 expires_at INTEGER NOT NULL,                           -- epoch ms, 1–24 h after creation
 uses_left INTEGER NOT NULL CHECK(uses_left BETWEEN 0 AND 10),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_hosts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 uuid TEXT NOT NULL UNIQUE,                             -- the uuid part of golf_agent_host_<uuid>_<hex>
 name TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('personal','organization','installation')),
 scope_id TEXT NOT NULL,
 registered_by INTEGER NOT NULL REFERENCES users(id),
 credential_digest TEXT NOT NULL UNIQUE,                -- SHA-256 hex of the host credential; 'deleted:…' once deleted
 state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DISABLED')),
 share_signins INTEGER NOT NULL DEFAULT 0 CHECK(share_signins IN (0,1)),
 allowed_users TEXT NOT NULL DEFAULT '[]',              -- JSON array of users.id
 allowed_repositories TEXT NOT NULL DEFAULT '[]',       -- JSON array of repositories.id
 enabled_tools TEXT NOT NULL DEFAULT '["codex","claude","opencode","grok"]',
 max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrent BETWEEN 1 AND 4),
 host_version TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,
 last_seen_at TEXT,
 created_at TEXT NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX IF NOT EXISTS agent_hosts_scope ON agent_hosts(scope,scope_id,deleted);
CREATE TABLE IF NOT EXISTS agent_host_tools (
 host_id INTEGER NOT NULL REFERENCES agent_hosts(id),
 tool TEXT NOT NULL CHECK(tool IN ('codex','claude','opencode','grok')),
 version TEXT NOT NULL DEFAULT '',
 signed_in INTEGER CHECK(signed_in IN (0,1)),           -- NULL when the host cannot tell
 account TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL,
 PRIMARY KEY(host_id,tool)
);
CREATE TABLE IF NOT EXISTS agent_tasks (
 id TEXT PRIMARY KEY,                                   -- UUID v4; the branch is golf-agent/<first 8 hex>
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,                           -- a row for another artifact is never served
 host_id INTEGER NOT NULL REFERENCES agent_hosts(id),
 tool TEXT NOT NULL CHECK(tool IN ('codex','claude','opencode','grok')),
 model TEXT NOT NULL DEFAULT '',
 requested_by INTEGER NOT NULL REFERENCES users(id),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('issue','pull_request')),
 target_number INTEGER NOT NULL,
 target_title TEXT NOT NULL DEFAULT '',                -- the issue or pull request title when the task was created
 base_ref TEXT NOT NULL, base_commit TEXT NOT NULL, branch TEXT NOT NULL,
 instructions TEXT NOT NULL DEFAULT '',
 prompt TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','CLAIMED','RUNNING','SUCCEEDED','NO_CHANGES','FAILED','CANCELLED','TIMED_OUT','LOST')),
 token_digest TEXT UNIQUE,                              -- SHA-256 hex of the task token, set at claim
 claim_id TEXT,                                         -- the host's claimId; a retried claim returns the same task
 deadline INTEGER NOT NULL,                             -- epoch ms; reset at claim to the claim time plus the task's duration
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 claimed_at TEXT, started_at TEXT, finished_at TEXT,
 exit_code INTEGER,
 commit_id TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL DEFAULT '{}',                     -- bounded JSON: summary, changedFiles, usage as reported by the CLI
 failure_reason TEXT NOT NULL DEFAULT '',
 log_lines INTEGER NOT NULL DEFAULT 0,                  -- lines accepted from the host (its log offset)
 log_bytes INTEGER NOT NULL DEFAULT 0,                  -- bytes stored
 log_truncated INTEGER NOT NULL DEFAULT 0 CHECK(log_truncated IN (0,1)),
 idempotency_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(requested_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS agent_tasks_host ON agent_tasks(host_id,state,created_at);
CREATE INDEX IF NOT EXISTS agent_tasks_repository ON agent_tasks(repository_id,target_kind,target_number,created_at);
CREATE INDEX IF NOT EXISTS agent_tasks_state ON agent_tasks(state,deadline);
CREATE TABLE IF NOT EXISTS agent_task_logs (
 task_id TEXT NOT NULL REFERENCES agent_tasks(id),
 seq INTEGER NOT NULL,                                  -- line number from 0
 text TEXT NOT NULL,
 PRIMARY KEY(task_id,seq)
);
