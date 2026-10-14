-- Actions/CI pipelines on the native backend (docs/NATIVE_ACTIONS_PIPELINES.md). Separate from evidence_jobs;
-- every route that reads or writes these rows checks the `actions` feature policy. Replay-safe.
CREATE TABLE IF NOT EXISTS pipeline_registration_tokens (
 id TEXT PRIMARY KEY,                                   -- UUID v4
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')),
 scope_id TEXT NOT NULL,                                -- '' | native_owners.id | repositories.id (decimal text)
 labels TEXT NOT NULL DEFAULT '[]',                     -- JSON array, default labels for runners registered with it
 token_digest TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the plaintext; plaintext shown once
 expires_at INTEGER NOT NULL,                           -- epoch ms, at most 24 h after creation
 uses_left INTEGER NOT NULL CHECK(uses_left BETWEEN 0 AND 100),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_runners (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- Forgejo Runner.id / GitLab runner id
 uuid TEXT NOT NULL UNIQUE,                             -- Forgejo x-runner-uuid; GitLab token id part
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')),
 scope_id TEXT NOT NULL,
 name TEXT NOT NULL,
 labels TEXT NOT NULL DEFAULT '[]',                     -- JSON array; Forgejo labels keep "name:schema://image"; matching uses the name part
 token_digest TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the runner credential
 state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DISABLED')),
 version TEXT NOT NULL DEFAULT '',                      -- reported runner version
 info TEXT NOT NULL DEFAULT '{}',                       -- engine-specific bounded JSON (GitLab: executor/platform/architecture)
 ephemeral INTEGER NOT NULL DEFAULT 0 CHECK(ephemeral IN (0,1)),
 registration_id TEXT REFERENCES pipeline_registration_tokens(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 last_seen_at TEXT,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX IF NOT EXISTS pipeline_runners_scope ON pipeline_runners(engine,scope,scope_id,state);
CREATE TABLE IF NOT EXISTS pipeline_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- github.run_id / GitLab pipeline id
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,                           -- a row for another artifact is never served
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 number INTEGER NOT NULL,                               -- per repository and engine, starts at 1
 workflow_path TEXT NOT NULL,                           -- .github/workflows/x.yml | .forgejo/workflows/x.yml | .gitlab-ci.yml
 workflow_name TEXT NOT NULL,
 workflow_blob TEXT NOT NULL DEFAULT '',
 event TEXT NOT NULL CHECK(event IN ('push','pull_request','workflow_dispatch','merge_request_event','web','schedule')),
 ref TEXT NOT NULL,                                     -- refs/heads/x | refs/tags/x | refs/pull/N/head
 commit_id TEXT NOT NULL,
 before_sha TEXT NOT NULL DEFAULT '',
 pull_number INTEGER,
 head_ref TEXT NOT NULL DEFAULT '',
 base_ref TEXT NOT NULL DEFAULT '',
 actor_id INTEGER NOT NULL REFERENCES users(id),
 trusted INTEGER NOT NULL CHECK(trusted IN (0,1)),      -- 1 = same-repository trigger; secrets are released only then
 inputs TEXT NOT NULL DEFAULT '{}',                     -- workflow_dispatch inputs / GitLab pipeline variables (non-secret)
 event_payload TEXT NOT NULL DEFAULT '{}',              -- github.event, at most 32 KiB
 title TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','WAITING','SUCCESS','FAILURE','CANCELLED','SKIPPED','REFUSED')),
 reason TEXT NOT NULL DEFAULT '',                       -- visible refusal or note (unsupported syntax, concurrency, …)
 attempt INTEGER NOT NULL DEFAULT 1,
 concurrency_group TEXT,
 concurrency_cancel INTEGER NOT NULL DEFAULT 0,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 intake_id TEXT,                                        -- trigger idempotency: UNIQUE with the workflow path
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
 UNIQUE(repository_id,engine,number),
 UNIQUE(intake_id,workflow_path)
);
CREATE INDEX IF NOT EXISTS pipeline_runs_repository ON pipeline_runs(repository_id,id);
CREATE INDEX IF NOT EXISTS pipeline_runs_state ON pipeline_runs(state,concurrency_group);
CREATE TABLE IF NOT EXISTS pipeline_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- Forgejo task id / GitLab job id
 run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 attempt INTEGER NOT NULL,                              -- current jobs: attempt = pipeline_runs.attempt
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 job_key TEXT NOT NULL,                                 -- YAML job id (Forgejo) / job name (GitLab)
 name TEXT NOT NULL,                                    -- display name; matrix values or "name 1/3" included
 stage TEXT NOT NULL DEFAULT '',
 stage_index INTEGER NOT NULL DEFAULT 0,
 needs TEXT NOT NULL DEFAULT '[]',                      -- JSON array of job_key (Forgejo) or job name (GitLab) in the same run
 runs_on TEXT NOT NULL DEFAULT '[]',                    -- JSON array of labels a runner must all carry (GitLab: tags)
 payload TEXT NOT NULL,                                 -- Forgejo: single-job workflow YAML; GitLab: JSON job spec (gitlab-pipeline.mjs owns it)
 state TEXT NOT NULL CHECK(state IN ('BLOCKED','QUEUED','RUNNING','SUCCESS','FAILURE','CANCELLED','SKIPPED','MANUAL')),
 when_mode TEXT NOT NULL DEFAULT 'on_success' CHECK(when_mode IN ('on_success','on_failure','always','manual','conditional')),
 allow_failure INTEGER NOT NULL DEFAULT 0 CHECK(allow_failure IN (0,1)),
 timeout_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(timeout_seconds BETWEEN 60 AND 21600),
 retry_max INTEGER NOT NULL DEFAULT 0 CHECK(retry_max BETWEEN 0 AND 2),
 retry_count INTEGER NOT NULL DEFAULT 0,
 runner_id INTEGER REFERENCES pipeline_runners(id),
 request_key TEXT,                                      -- Forgejo x-runner-request-key idempotency
 token_digest TEXT UNIQUE,                              -- job token (SHA-256 hex); NULL when not running
 token_expires_at INTEGER,
 outputs TEXT NOT NULL DEFAULT '{}',                    -- job outputs (Forgejo) / dotenv reports (GitLab), at most 64 KiB
 exit_code INTEGER,
 failure_reason TEXT NOT NULL DEFAULT '',
 log_lines INTEGER NOT NULL DEFAULT 0,
 log_bytes INTEGER NOT NULL DEFAULT 0,
 log_chunks INTEGER NOT NULL DEFAULT 0,
 log_complete INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, queued_at TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
 UNIQUE(run_id,attempt,name)
);
CREATE INDEX IF NOT EXISTS pipeline_jobs_queue ON pipeline_jobs(engine,state,id);
CREATE INDEX IF NOT EXISTS pipeline_jobs_run ON pipeline_jobs(run_id,attempt);
CREATE TABLE IF NOT EXISTS pipeline_steps (
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id), number INTEGER NOT NULL, name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','SUCCESS','FAILURE','CANCELLED','SKIPPED')),
 started_at TEXT, finished_at TEXT, log_index INTEGER NOT NULL DEFAULT 0, log_length INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job_id,number)
);
-- R2 key of a chunk: pipelines/<run_id>/<job_id>/log/<seq zero-padded to 8>. Chunks are immutable; seq is dense from 0.
CREATE TABLE IF NOT EXISTS pipeline_log_chunks (
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id), seq INTEGER NOT NULL,
 first_line INTEGER NOT NULL, lines INTEGER NOT NULL, first_byte INTEGER NOT NULL, bytes INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(job_id,seq)
);
CREATE TABLE IF NOT EXISTS pipeline_artifacts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id),
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('actions-v4','gitlab-archive','gitlab-report')),
 state TEXT NOT NULL CHECK(state IN ('UPLOADING','READY','EXPIRED','DELETED')),
 size INTEGER NOT NULL DEFAULT 0,
 sha256 TEXT NOT NULL DEFAULT '',
 blocks TEXT NOT NULL DEFAULT '[]',                     -- ordered R2 keys under pipelines/<run>/artifacts/<id>/; download concatenates
 content_type TEXT NOT NULL DEFAULT 'application/zip',
 created_at TEXT NOT NULL, finalized_at TEXT, expires_at TEXT NOT NULL,
 UNIQUE(job_id,name)
);
CREATE INDEX IF NOT EXISTS pipeline_artifacts_run ON pipeline_artifacts(run_id,name);
-- Durable trigger intake: a push/PR/dispatch is recorded first, then discovered; a lost intake is retried by the sweep.
CREATE TABLE IF NOT EXISTS pipeline_intake (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), kind TEXT NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','DONE','REFUSED')), reason TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_intake_pending ON pipeline_intake(state,created_at);
