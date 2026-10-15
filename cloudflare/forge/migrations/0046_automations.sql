-- Automations (docs/AUTOMATIONS.md, agents plan phase 2): a built-in tool or a custom one, pointed at a repository, an organization or
-- the installation, run by events, a schedule or a person, on an engine (a model or a coding CLI on an agent host). Each automation is
-- off when created and acts as owner_id, re-checked on every run. Instructions are versioned: automation_instructions keeps every
-- version and automations.instructions_version names the current one. automation_runs is one row per triggered run; dedupe_key makes a
-- replayed or repeated event (the same pull request head, the same issue) record nothing new. Output is advisory: comments, labels,
-- private review drafts, issues, reports and draft pull requests that a person publishes; an automation never merges. Replay-safe.
CREATE TABLE IF NOT EXISTS automations (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('repository','organization','installation')),
 scope_id TEXT NOT NULL,                                -- repository id, organization owner id, or '' for the installation
 owner_id INTEGER NOT NULL,                             -- the person it acts as: whoever last saved or enabled it
 tool TEXT NOT NULL CHECK(tool IN ('pr-reviewer','issue-triage','issue-to-pr','ci-fixer','custom')),
 name TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 kill_switch INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch IN (0,1)),
 trigger TEXT NOT NULL DEFAULT '{"events":[]}',         -- JSON {events:[...], schedule?:{everyMinutes}}
 target TEXT NOT NULL DEFAULT '{}',                     -- JSON {repositories:[ids] (empty: every repository in scope), branches:[glob], paths:[glob]}
 engine TEXT NOT NULL DEFAULT 'default',                -- 'default' (model selection), an engine id, or a coding CLI (codex, claude, opencode, grok)
 place TEXT NOT NULL DEFAULT 'cloud' CHECK(place IN ('cloud','agent-host','ssh-host')),
 host_id TEXT NOT NULL DEFAULT '',                      -- the agent host for place 'agent-host'
 instructions_version INTEGER NOT NULL DEFAULT 0,
 output TEXT NOT NULL DEFAULT '{}',                     -- JSON {kinds:[comment|review|labels|issue|draft-pr|report]}
 limits TEXT NOT NULL DEFAULT '{}',                     -- JSON {perDay, concurrency, maxOpenPRs, dedupeWindow}
 approvals TEXT NOT NULL DEFAULT '{"draftOnly":true,"allowLanding":false}',
 version INTEGER NOT NULL DEFAULT 1,
 next_run_at INTEGER,                                   -- the next scheduled run (epoch ms), or NULL without a schedule
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 created_by INTEGER NOT NULL,
 updated_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automations_scope ON automations(scope,scope_id,deleted);
CREATE INDEX IF NOT EXISTS automations_due ON automations(next_run_at) WHERE next_run_at IS NOT NULL AND deleted=0;
CREATE TABLE IF NOT EXISTS automation_instructions (
 automation_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1),
 text TEXT NOT NULL,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(automation_id,version)
);
CREATE TABLE IF NOT EXISTS automation_runs (
 id TEXT PRIMARY KEY,
 automation_id TEXT NOT NULL,
 repository_id INTEGER,
 trigger TEXT NOT NULL,                                 -- the event: pull_request.opened, issue.opened, pipeline.failed, push, schedule, manual, …
 event TEXT NOT NULL DEFAULT '{}',                      -- JSON facts of the event (numbers, refs, commits, run ids); never repository text
 target_kind TEXT NOT NULL DEFAULT '' CHECK(target_kind IN ('','issue','pull_request','pipeline_run','commit','repository')),
 target_number INTEGER,
 target_commit TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','SKIPPED','REFUSED')),
 phase TEXT NOT NULL DEFAULT '',                        -- RUNNING only: wait-ai, wait-task, infer, apply
 reason TEXT NOT NULL DEFAULT '',
 engine TEXT NOT NULL DEFAULT '',
 place TEXT NOT NULL DEFAULT '',
 instructions_version INTEGER NOT NULL DEFAULT 0,
 requested_by INTEGER,                                  -- the person who pressed Run now, or NULL
 usage TEXT NOT NULL DEFAULT '{}',                      -- JSON {inputTokens, outputTokens, costUsd?, reported}
 outputs TEXT NOT NULL DEFAULT '{}',                    -- JSON refs: aiRunId, agentTaskId, commentId, pullNumber, issueNumber, labels, report
 input TEXT,                                            -- prepared engine input while phase is infer; cleared when the run finishes
 dedupe_key TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 started_at TEXT,
 finished_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id,created_at);
CREATE INDEX IF NOT EXISTS automation_runs_state ON automation_runs(state,phase);
CREATE INDEX IF NOT EXISTS automation_runs_repository ON automation_runs(repository_id,created_at);
