-- API tokens for agents (docs/AGENT_ACCESS.md, docs/AGENTIC_MODE_PLAN.md AM-3): golf_pat_ bearer secrets for /mcp, /native/source/*
-- and /git/*, stored as SHA-256 only. A token is bound to its owner's identity version, so changing account access invalidates it, and
-- its permission is capped by the owner's current repository grant on every call. Replay-safe.
CREATE TABLE IF NOT EXISTS api_tokens (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 digest TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
 repositories TEXT,                                     -- JSON array of repositories.id (decimal text); NULL = every repository the owner can access
 permission TEXT NOT NULL CHECK(permission IN ('read','write')),
 branch_pattern TEXT NOT NULL DEFAULT '',               -- write tokens only: exact branch or trailing '*' prefix; '' = any ref
 identity_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,                           -- epoch seconds
 expires_at INTEGER NOT NULL CHECK(expires_at>=created_at+3600 AND expires_at<=created_at+7776000),
 last_used_at INTEGER,
 revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_inventory ON api_tokens(user_id,id);
