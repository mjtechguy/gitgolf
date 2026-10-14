# Native Actions and CI pipelines (RUN-A/RUN-B/RUN-C contract)

Status: contract for the Cloudflare-native pipeline core. RUN-A/RUN-B (GitHub/Forgejo Actions on the stock
Forgejo Runner) and RUN-C (GitLab CI on the stock GitLab Runner) share this model. The existing PR evidence path
(`evidence_jobs`, `native_runner_*`, `gitlab_runner_jobs`, `/native/runner-machine/*`) is separate and unchanged.

Everything here is gated by the `actions` feature policy (installation → organization → repository). The feature
is checked at trigger intake, at claim/fetch, on every runner update and on every UI mutation. Turning it off never
deletes runs, logs or artifacts.

## Allocation and bindings

`forge.json` gains an optional `pipelines` allocation:

```json
"pipelines": { "bucket": "golf-pipelines", "queue": "golf-pipeline-intake", "dead_letter": "golf-pipeline-intake-failed" }
```

| Binding | Type | Required | Use |
| --- | --- | --- | --- |
| `PIPELINE_BUCKET` | R2 | yes | job logs (chunked), step summaries, artifacts |
| `PipelineRun` | Durable Object (SQLite) | yes | per-run coordinator: DAG advance, cancel, timeouts (alarm) |
| `PIPELINE_QUEUE` | Queue producer + consumer | optional | trigger intake fan-out; without it intake runs in `waitUntil` and the cron sweep |
| `PIPELINES_ENABLED` | text `true` | set by setup | `pipelinePolicy(env)` is true only with this and `PIPELINE_BUCKET` |
| `ACTIONS_DEFAULT_URL` | text | optional | where bare `uses: owner/action@ref` resolves; default `https://github.com` |

Capability ids (honest: READY only when the route exists and the binding is present):
`actions.pipelines` (runs, triggers, UI), `actions.forgejo-runner` (stock Forgejo Runner protocol),
`actions.gitlab-runner` (RUN-C), `actions.artifacts` (v4 Twirp artifacts in R2), `settings.pipeline-runners`.

## D1 schema — migration `0032_actions_pipelines.sql` (also appended to `schema.sql`; schema version 32)

```sql
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
```

## State machines

Job:

```
BLOCKED ──needs/stage satisfied──▶ QUEUED ──claimed by runner──▶ RUNNING ──▶ SUCCESS | FAILURE | CANCELLED
   │                                  │                              └─ retry (retry_count < retry_max, FAILURE only) ─▶ QUEUED
   ├─needs failed and when_mode=on_success──▶ SKIPPED
   ├─when_mode=manual and predecessors done──▶ MANUAL ──play──▶ QUEUED
   └─run cancelled──▶ CANCELLED
```

- `when_mode`: `on_success` (default; needs every predecessor SUCCESS, or FAILURE with `allow_failure=1`);
  `on_failure` (runs only if some predecessor failed); `always`; `manual` (GitLab `when: manual`: becomes
  MANUAL, never blocks the run from finishing unless `allow_failure=0`); `conditional` (Forgejo job with an
  `if:`: becomes QUEUED once predecessors are terminal, whatever their result — the runner evaluates the `if:`
  with the `needs` context and reports SKIPPED/SUCCESS).
- GitLab stages: a job without `needs` is blocked until every job with a lower `stage_index` is terminal
  (GitLab semantics). A job with explicit `needs` (`needs: []` included) ignores stage order.
- Timeouts: a RUNNING job past `started_at + timeout_seconds` becomes FAILURE (`failure_reason='timeout'`);
  a RUNNING job whose runner has not reported for 10 minutes becomes FAILURE (`failure_reason='runner_lost'`).

Run:

```
QUEUED ─first job claimed─▶ RUNNING ─all jobs terminal─▶ SUCCESS | FAILURE | CANCELLED
  │                           └─only MANUAL jobs left─▶ WAITING ─play─▶ RUNNING
  ├─concurrency group busy──▶ (stays QUEUED, jobs BLOCKED)
REFUSED: discovery/parse failed; `reason` holds the visible explanation; no jobs.
```

Run result: FAILURE if any non-`allow_failure` job is FAILURE; CANCELLED if cancellation was requested;
SUCCESS otherwise (SKIPPED jobs do not fail a run).

Rerun: `attempt` increments; *all* re-creates every job of the previous attempt; *failed* re-creates the
FAILURE/CANCELLED/SKIPPED jobs and jobs that need them, and copies the others as SUCCESS rows (outputs kept,
logs still readable from the original job id). Previous attempts stay readable.

Concurrency (Forgejo `concurrency:` at workflow level): `group` (subset of `${{ }}` expressions: `github.*`
string fields, `inputs.*`, `||`) and `cancel-in-progress`. A new run in a busy group cancels other runs in that
group that have not started (and running ones when `cancel-in-progress: true`) and waits. Job-level concurrency
is refused with a visible note.

## Internal module API — `cloudflare/forge/src/pipelines.mjs`

All functions take a D1 session `db` (`env.DB.withSession('first-primary')`) and the Worker/DO `env`. They throw
`Fault` (common.mjs) for refusals; anything else is an unconfirmed outcome. Times are ISO strings in rows.

```js
export const pipelineEngines = ['forgejo-actions', 'gitlab-ci'];
export function pipelinePolicy(env);                       // true when PIPELINES_ENABLED==='true' && PIPELINE_BUCKET
export async function pipelineAllowed(db, env, repositoryId); // false when `actions` is off by policy for the repository

// Runs and jobs (used by RUN-A intake and RUN-C gitlab-pipeline.mjs)
export async function createPipelineRun(db, env, run, jobs);
//   run  = { repositoryId, engine, workflowPath, workflowName, workflowBlob, event, ref, commitId, beforeSha?, pullNumber?,
//            headRef?, baseRef?, actorId, trusted, inputs?, eventPayload?, title?, intakeId?, concurrency?: { group, cancelInProgress }, reason? }
//   jobs = [{ key, name, stage?, stageIndex?, needs: [key], runsOn: [label], payload: string, when?: 'on_success'|'on_failure'|'always'|'manual'|'conditional',
//            allowFailure?, timeoutSeconds?, retryMax? }]          (1..256 jobs, names unique, needs refer to keys in this run)
//   → { runId, number, replayed, jobs: [{ id, key, name }] }      (replayed when intakeId+workflowPath already exists)
export async function refusePipelineRun(db, env, run, reason);    // same `run` shape; records a REFUSED run, no jobs → { runId, number }

// Runner identity (both engines)
export async function createRegistrationToken(db, env, person, { engine, scope, scopeId, labels, ttlHours, uses }); // → { token, row }
export async function registerPipelineRunner(db, env, { engine, registrationToken, name, labels, version, info, ephemeral }); // → { runner, token }
export async function runnerByToken(db, env, engine, token, uuid?); // ACTIVE, not deleted, digest match; updates last_seen_at → runner row or Fault 401/403

// Claiming and running (runner-facing)
export async function claimPipelineJob(db, env, runner, { requestKey? }); // → null | { job, run, repository, token, tokenExpiresAt }
//   Picks the oldest QUEUED job of runner.engine whose runs_on ⊆ runner label names and whose repository is in the runner's scope
//   (installation: any; organization: repositories owned by that organization; repository: that repository), with `actions`
//   effective and the run not cancel_requested. Atomically sets RUNNING, runner_id, started_at, token digest. The run becomes RUNNING.
export async function jobByToken(db, env, token);                 // job token → { job, run, repository } or Fault (expired / not RUNNING / feature off)
export async function runnerJob(db, env, runner, jobId);          // the RUNNING job this runner holds, re-checking `actions` → { job, run, repository }

// Logs (R2 chunks, server-side secret redaction of values ≥ 4 characters for trusted runs)
export async function appendJobLogLines(db, env, job, index, lines);   // Forgejo: rows at line index → { ack } (next expected line)
export async function appendJobLogBytes(db, env, job, offset, bytes);  // GitLab: Content-Range trace at byte offset → { ack } (next expected byte) or Fault 416
export async function readJobLog(db, env, job, { fromLine?, fromByte?, limit? }); // UI and GitLab GET trace → { text, nextLine, nextByte, complete }
export async function updateJobSteps(db, job, steps);             // [{ number, name, state, startedAt, finishedAt, logIndex, logLength }]

// Completion and DAG
export async function finishPipelineJob(db, env, job, { result: 'success'|'failure'|'cancelled'|'skipped', exitCode?, outputs?, failureReason? });
//   Revokes the job token, completes the log, then advances the run (below). Idempotent for the same terminal result.
export async function advancePipelineRun(env, runId);             // serialized through the PipelineRun Durable Object when bound
export async function cancelPipelineRun(db, env, person, runId);  // UI; RUNNING jobs see CANCELLED on their next runner call
export async function rerunPipelineRun(db, env, person, runId, { failedOnly });
export async function playManualJob(db, env, person, jobId);

// Values (secrets only when run.trusted; variables always)
export async function pipelineValues(db, env, run);               // → { secrets: {NAME: value}, variables: {NAME: value} }

// Artifacts (R2)
export async function putJobArtifact(db, env, job, { name, kind, contentType, expiresAt }, body /* ReadableStream|ArrayBuffer */, size);
export async function listRunArtifacts(db, env, runId);
export async function openArtifact(db, env, artifactId);          // → { row, body: ReadableStream } (blocks concatenated)
```

Job tokens: `golf_job_<jobId>_<64 hex>` is not used by Forgejo; Forgejo jobs get a JWT-shaped token
`<header>.<payload>.<random>` whose payload carries `scp: "Actions.Results:<runId>:<jobId>"` because
`@actions/artifact` reads it. Both are opaque to Golf: only `SHA-256(token)` is stored. GitLab jobs use the
token RUN-C chooses, stored the same way (`claimPipelineJob` returns it). A token is valid only while its job is
RUNNING and before `token_expires_at` (= start + timeout + 10 minutes); it reads exactly the run's repository
and writes only that job's logs, status and artifacts.

Runner credentials: Forgejo runners present `x-runner-uuid` + `x-runner-token`; GitLab runners present
`glrt-golf_<uuid hex>_<64 hex>` (the `glrt-golf_` prefix keeps them apart from the evidence path's
`glrt-<uuid>_…` machine credentials). Registration tokens are `golfreg_<64 hex>`, at most 24 h, one or a few
uses, scoped and revocable.

## Public routes (outside Access, like `/api/v4`)

| Route | Owner | Authority |
| --- | --- | --- |
| `POST /api/actions/ping.v1.PingService/Ping` | RUN-B | none |
| `POST /api/actions/runner.v1.RunnerService/{Register,Declare,FetchTask,UpdateTask,UpdateLog,UpdateStepSummary}` | RUN-B | registration token / runner uuid+token; job held by this runner |
| `POST /twirp/github.actions.results.api.v1.ArtifactService/*` | RUN-B | job runtime token (`Authorization: Bearer`) for the same run |
| `PUT/GET /twirp/github.actions.results.api.v1.ArtifactService/{UploadArtifact,DownloadArtifact}?sig=…` | RUN-B | HMAC-signed, 60-minute URL bound to job + artifact |
| `GET /{owner}/{repo}(.git)/info/refs?service=git-upload-pack`, `POST …/git-upload-pack` with `Authorization: Basic x-access-token:<job token>` | RUN-B | read-only, exactly the run's repository |
| `/api/v4/*` for `glrt-golf_` runners | RUN-C | as above |

Runner protocol requests are handled by the stateless Worker against D1 and R2; they never enter the
workspace Durable Object queue. Run advancement is serialized per run by the `PipelineRun` Durable Object.

## UI routes (Access; repository authority)

`POST /native/pipelines` with `action` ∈ `listRuns`, `getRun`, `jobLog`, `cancel`, `rerun`, `dispatch`,
`workflows`, `artifacts`, `play`; `GET /native/pipelines/artifact/<id>` (download). `POST /native/pipeline-runners`
with `action` ∈ `list`, `createToken`, `revokeToken`, `update`, `delete` at `installation` (operations
administrators), `organization` (organization owners) or `repository` (repository administrators) scope.

## Pinned runners

| Runner | Version | Artifact | SHA-256 |
| --- | --- | --- | --- |
| Forgejo Runner | v13.2.0 | `forgejo-runner-13.2.0-linux-amd64` from code.forgejo.org/forgejo/runner releases | `fadaec897f5e6641c363f87ecaf75f866f99c81b7097ec6b433e4c48123fcad1` |
| actions-proto | v0.8.0 (`runner.v1`, `ping.v1`, as vendored by runner v13.2.0) | — | — |
| GitLab Runner | 18.5.0 (RUN-C may bump and record) | — | — |
