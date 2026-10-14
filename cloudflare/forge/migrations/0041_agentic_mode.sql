-- Agentic mode (docs/AGENTIC_MODE.md, docs/AGENTIC_MODE_PLAN.md AM-4). One row per repository whose administrator saved the setting;
-- no row reads as the defaults: off, low-risk docs/** and **/*.md, the CI, deploy and CODEOWNERS paths sensitive, no landing without
-- a person, the pipelines of the head commit required and revert on failure on. Path and check lists are JSON arrays of strings.
-- pull_request_origins records how each pull request was opened: by a person, through an API token (MCP or a direct call), or from
-- a finished agent task. Pull requests opened before this migration have no row and read as opened by a person. Replay-safe.
CREATE TABLE IF NOT EXISTS repository_agentic_settings (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 low_risk_paths TEXT NOT NULL DEFAULT '["docs/**","**/*.md"]',
 sensitive_paths TEXT NOT NULL DEFAULT '[".github/**",".forgejo/**",".gitlab-ci.yml","deploy/**","**/CODEOWNERS"]',
 land_without_person INTEGER NOT NULL DEFAULT 0 CHECK(land_without_person IN (0,1)),
 required_checks TEXT NOT NULL DEFAULT '[]',
 revert_on_failure INTEGER NOT NULL DEFAULT 1 CHECK(revert_on_failure IN (0,1)),
 version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_request_origins (
 pull_request_id INTEGER PRIMARY KEY REFERENCES pull_requests(id),
 kind TEXT NOT NULL CHECK(kind IN ('person','api-token','agent-task')),
 api_token_id INTEGER REFERENCES api_tokens(id),
 agent_task_id TEXT REFERENCES agent_tasks(id),
 created_at TEXT NOT NULL
);
