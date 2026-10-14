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

## D1 schema — migration `0035_actions_pipelines.sql` (also appended to `schema.sql`; schema version 35)

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
 state TEXT NOT NULL CHECK(state IN ('BLOCKED','QUEUED','RUNNING','SUCCESS','FAILURE','CANCELLED','SKIPPED','MANUAL','APPROVAL')),
 environment TEXT,                                      -- JSON { name, url, action } or NULL
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
-- Deployment environments for Actions/CI jobs (`environment:`). Separate from the single preview-policy row in
-- repository_environments. A name used by a job and not configured is created unprotected, as on GitHub.
CREATE TABLE IF NOT EXISTS pipeline_environments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,
 name TEXT NOT NULL,
 reviewers TEXT NOT NULL DEFAULT '[]',                  -- JSON array of user ids; empty = no approval needed
 prevent_self_review INTEGER NOT NULL DEFAULT 1 CHECK(prevent_self_review IN (0,1)),
 branches TEXT NOT NULL DEFAULT '[]',                   -- JSON array of branch patterns; empty = any ref
 url TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_environments_name ON pipeline_environments(repository_id,name) WHERE deleted=0;
-- Environment-scoped secrets and variables, sealed with the repository value key under their own additional-data domain.
CREATE TABLE IF NOT EXISTS pipeline_environment_values (
 environment_id INTEGER NOT NULL REFERENCES pipeline_environments(id),
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('secret','variable')),
 version INTEGER NOT NULL CHECK(version>0),
 value_bytes INTEGER NOT NULL CHECK(value_bytes BETWEEN 1 AND 65536),
 encrypted TEXT NOT NULL, key_id TEXT NOT NULL,
 updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(environment_id,name)
);
CREATE TABLE IF NOT EXISTS pipeline_approvals (
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id),
 environment_id INTEGER NOT NULL REFERENCES pipeline_environments(id),
 reviewer_id INTEGER NOT NULL REFERENCES users(id),
 decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REJECTED')),
 comment TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 PRIMARY KEY(job_id)
);
CREATE TABLE IF NOT EXISTS pipeline_deployments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 environment_id INTEGER NOT NULL REFERENCES pipeline_environments(id),
 run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 job_id INTEGER NOT NULL UNIQUE REFERENCES pipeline_jobs(id),
 action TEXT NOT NULL,
 commit_id TEXT NOT NULL, ref TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('SUCCESS','FAILURE','CANCELLED')),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_deployments_environment ON pipeline_deployments(environment_id,id);
```

## State machines

Job:

```
BLOCKED ──needs satisfied──▶ (APPROVAL ──reviewer approves──▶) QUEUED ──claimed by runner──▶ RUNNING ──▶ SUCCESS | FAILURE | CANCELLED
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
- The core knows only `needs`. GitLab stage order is expanded by `gitlab-pipeline.mjs`: a job without
  explicit `needs` gets every job of all earlier stages as its `needs`; a job with explicit `needs`
  (`needs: []` included) keeps exactly those. Jobs whose predecessors were SKIPPED still run for GitLab
  (`engine='gitlab-ci'`), as GitLab does; for Forgejo a SKIPPED predecessor skips an `on_success` job.
- Environments (`jobs[].environment = { name, url, action }`, action start|prepare|stop|verify|access): when a job
  with an environment would become QUEUED, a missing `pipeline_environments` row is created unprotected (GitHub
  behaviour); a non-empty `branches` list that does not match the ref name fails the job
  (`failure_reason='environment_branch'`); an environment with reviewers holds start/prepare/stop jobs in APPROVAL
  until `approveEnvironmentJob` (approve → QUEUED, reject → FAILURE `environment_rejected`; the run's actor
  cannot approve when `prevent_self_review`). `pipelineValues(db, env, run, job)` adds the environment's variables,
  and its secrets for trusted runs, only after approval. start/stop jobs record a `pipeline_deployments` row.
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
export async function finishPipelineJob(db, env, job, { result: 'success'|'failure'|'cancelled'|'skipped', exitCode?, outputs?, failureReason?, url? });
//   Revokes the job token, completes the log, then advances the run (below). Idempotent for the same terminal result.
export async function advancePipelineRun(env, runId);             // serialized through the PipelineRun Durable Object when bound
export async function cancelPipelineRun(db, env, person, runId);  // UI; RUNNING jobs see CANCELLED on their next runner call
export async function rerunPipelineRun(db, env, person, runId, { failedOnly });
export async function playManualJob(db, env, person, jobId);

// Values (secrets only when run.trusted; variables always)
export async function pipelineValues(db, env, run, job?);         // → { secrets, variables }; job adds approved environment values
export async function approveEnvironmentJob(db, env, person, jobId, { approve, comment });
export async function saveEnvironmentValue(db, env, person, environmentRow, { name, kind, value });

// Artifacts (R2)
export async function putJobArtifact(db, env, job, { name, kind, contentType, expiresAt }, body /* ReadableStream|ArrayBuffer */, size);
export async function listRunArtifacts(db, env, runId);
export async function openArtifact(db, env, artifactId);          // → { row, body: ReadableStream } (blocks concatenated)
```

Job tokens are minted by `claimPipelineJob`. Forgejo jobs get a JWT-shaped token
`<header>.<payload>.<random>` whose payload carries `scp: "Actions.Results:<runId>:<jobId>"` because
`@actions/artifact` reads it; GitLab jobs get `golfjob_<64 hex>` (the prefix tells pipeline job tokens apart
from evidence-path leases). Only `SHA-256(token)` is stored. A token is valid only while its job is
RUNNING and before `token_expires_at` (= start + timeout + 10 minutes); `jobByToken` throws
`Fault('cancelled', 409)` for a job that was cancelled while running (its token is kept until expiry so the
runner can be told), and `Fault('unauthenticated', 401)` otherwise. A running job of a run whose cancellation
was requested reads `run.cancel_requested = 1`. It reads exactly the run's repository
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

`POST /native/pipelines` with `action` ∈ `listRuns`, `getRun`, `jobLog`, `cancel`, `rerun`, `play`, `dispatch`,
`workflows`, `approve`, `environments`, `saveEnvironment`, `saveEnvironmentValue`, `downloadArtifact` (streams the
artifact). Reads need repository read access; cancel, re-run, play and dispatch need write; approve needs to be a required
reviewer; environment changes need admin. `POST /native/pipeline-runners`
with `action` ∈ `list`, `createToken`, `revokeToken`, `update`, `delete` at `installation` (operations
administrators), `organization` (organization owners) or `repository` (repository administrators) scope.

## RUN-A / RUN-B implementation notes (GitHub/Forgejo Actions on the stock Forgejo Runner)

Modules: `pipeline-policy.mjs` (allocation, capabilities, pins), `pipelines.mjs` (core), `actions-workflow.mjs` +
`actions-expressions.mjs` (discovery, `on:` filters, expansion), `actions-intake.mjs` (triggers), `protobuf.mjs` +
`forgejo-runner.mjs` (connect-rpc and the job-token Git source), `actions-artifacts.mjs` (artifacts v4),
`pipeline-api.mjs` (Actions tab and runner administration), `PipelineRun` in `worker.mjs`. Web: `NativeActions.tsx`,
`NativePipelineRunners.tsx`.

Coordination choice: a **Durable Object per run** (`PipelineRun`), not a Workflow. Runs are driven by runner callbacks
and can wait indefinitely on manual jobs and approvals; the object serializes DAG advancement, and its alarm (60 s)
times out lost and overdue jobs. Runner traffic (`/api/actions/*`, artifacts, job-token Git) is handled by the stateless
Worker against D1 and R2 and never enters the workspace object's queue. Trigger intake is recorded in D1 first, then
fanned out on `PIPELINE_QUEUE` when bound, else after the response (`waitUntil`); the scheduled sweep retries intakes
left PENDING and advances runs whose alarm was lost.

Triggers: `push` (branches and tags; the commit Golf just confirmed), `pull_request` `opened` (CreatePullRequest),
`reopened` (UpdatePullRequest to open) and `synchronize` (a push to the head branch of an open same-repository pull
request), `workflow_dispatch` with typed inputs (string, boolean, number, choice, environment) from the Actions tab.
`.forgejo/workflows` wins over `.github/workflows` when both exist (Forgejo rule). At most 32 workflow files of 256 KiB
each are read per commit. Not triggered (never matched, no refusal): `schedule`, `pull_request_target`, `release`,
`workflow_call`, `issues` and other events. Fork pull requests do not exist on native.

`on:` filter subset: `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore` (GitHub glob
semantics with `*`, `**`, `?`, `+`, `[]` and `!`), pull_request `types`. Other filter keys refuse the run with the key
named. Path filters use the changed files between the push's before/after (or PR base/head); a new branch, a missing
base or more than 256 changed files runs the workflow, as GitHub does past its file limit.

Expansion: matrices with `include`/`exclude` (GitHub algorithm, YAML anchors and merge keys allowed), job names and
`runs-on` evaluated server-side with the expression subset (literals, `github.*`, `inputs.*`, `vars.*`, `matrix.*`,
`!`, comparisons, `&&`, `||`, `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`). Each
combination becomes one job whose payload is a single-job workflow with a one-value matrix, as Forgejo's jobparser does.
`if:` on a job makes it `conditional` (the runner evaluates it with the `needs` context). Refused with a visible reason:
reusable workflows (`jobs.<id>.uses`), runner groups, matrices built from `needs` outputs. Job-level `concurrency` is
recorded as a note and not applied. Workflow `concurrency` groups cancel earlier unstarted runs (and running ones with
`cancel-in-progress`); a later run waits for an earlier running one.

Task payload: single-job YAML, a `github` context Struct like Forgejo's (`server_url` = the public origin,
`repository`, `ref`, `sha`, `event`, `run_id`, `run_number`, `run_attempt`, `token`, `forgejo_runtime_token`,
`forgejo_default_actions_url`), `secrets` (repository secrets only for trusted, same-repository runs, plus
`GITHUB_TOKEN`/`GITEA_TOKEN`/`FORGEJO_TOKEN` = the job token), `vars`, and `needs` (merged outputs and aggregate result).
`uses: owner/action@ref` resolves from `ACTIONS_DEFAULT_URL` (default `https://github.com`).

Checkout: `actions/checkout` fetches `${server_url}/${owner}/${repo}` with `AUTHORIZATION: basic x-access-token:<job
token>`. Golf serves `GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack` (with or without `.git`) for
exactly the run's repository, read-only, while the job is RUNNING. Protocol v2 and gzip request bodies pass through.

Artifacts: the v4 Twirp `ArtifactService` (`CreateArtifact`, signed block `UploadArtifact` with `comp=block|blocklist`,
`FinalizeArtifact`, `ListArtifacts`, `GetSignedArtifactURL`, `DeleteArtifact`, signed `DownloadArtifact`) into R2 for 30
days. Signed URLs are HMAC'd with the requesting job's stored token digest, so they end with the job. **The unmodified
`actions/upload-artifact@v4` and `download-artifact@v4` refuse every server that is not github.com, *.ghe.com or
*.localhost** (their `isGhes()` check in `@actions/artifact` 2.x). That is the same on Forgejo; use
`https://code.forgejo.org/forgejo/upload-artifact@v4` and `…/download-artifact@v4`, which differ only by that check. The
v3 artifact API (`ACTIONS_RUNTIME_URL=/api/actions_pipeline/`) is not implemented. Cache: the runner's own cache server
(`ACTIONS_CACHE_URL`, Forgejo Runner default); Golf stores no caches.

Logs: `UpdateLog` rows are stored as immutable R2 chunks indexed in D1, with exact secret values (and each line of a
multi-line secret) of 4 or more characters replaced by `***` before storage (the runner masks too). The Actions tab polls
the job log from the last line every 1.5 s while a job runs and folds it by step using the runner's step log ranges;
WebSocket fan-out is not implemented. Step summaries (`UpdateStepSummary`) are stored in R2 but not yet shown.

Runner registration: `forgejo-runner register --no-interactive --instance <origin> --token <golfreg_…> --name … --labels …`
then `forgejo-runner daemon`. v13 prints a deprecation notice for `register` (it prefers connections declared in the
runner configuration) but registers normally. Runners declare their labels at start; Golf stores what the runner
declares. A job runs only on a runner carrying all of its `runs-on` labels; jobs for labels no runner carries
(windows-latest, macos-latest) stay QUEUED with "Waiting for a runner with …" and are cancelled with `no_runner` after
24 h. Running the stock runner as a Kubernetes Deployment with a DinD sidecar uses the same protocol: the runner needs
outbound HTTPS to the Golf origin; job containers need to reach the origin too (checkout, artifacts) and the runner's
cache server, so the DinD network must route to the origin and to the runner pod.

Deploy: `forge.json` `"pipelines": { "bucket": …, "queue": …, "dead_letter": …, "default_actions_url"?: … }` (the
Alchemy stack creates `<name>-pipelines`, `<name>-pipeline-intake` and `<name>-pipeline-intake-failed` and the
`PipelineRun` class when `settings.pipelines` is present), then apply migration 0035 (`cloudflare_release.py` applies
it after 0034 and checks the columns). Repository secrets for pipelines reuse `execution_values.key`.

Proof: `node cloudflare/forge/actions-runtime-check.mjs "$(command -v cf)" --repos=demo,chalk,node-postgres,itsdangerous`
runs the real Worker in workerd with D1, R2 and Durable Objects, downloads and checksums the pinned runner, registers
it through the registration-token API, pushes each repository's real HEAD through Golf's Smart HTTP push and waits for
the runs (only the Artifacts binding is a local `git http-backend` fixture). `--image=` maps `ubuntu-latest`.

## Pinned runners

| Runner | Version | Artifact | SHA-256 |
| --- | --- | --- | --- |
| Forgejo Runner | v13.2.0 | `forgejo-runner-13.2.0-linux-amd64` from code.forgejo.org/forgejo/runner releases | `fadaec897f5e6641c363f87ecaf75f866f99c81b7097ec6b433e4c48123fcad1` |
| actions-proto | v0.8.0 (`runner.v1`, `ping.v1`, as vendored by runner v13.2.0) | — | — |
| GitLab Runner | 18.5.0 | `gitlab-runner-linux-amd64` | `4f84c2995cff1aaff89ce8639426bf1219cb3770d9360ce8783e9b5fde628762` |


<!-- RUN-C section: owned by gitlab-runner.mjs / gitlab-pipeline.mjs; append-only. -->
## GitLab CI pipelines on the stock GitLab Runner (RUN-C)

Modules: `cloudflare/forge/src/gitlab-pipeline.mjs` (`.gitlab-ci.yml` → jobs, and the runner job payload) and
`cloudflare/forge/src/gitlab-runner.mjs` (`/api/v4` for stock runners). The evidence one-job coordinator in the same file
keeps its `glrt-<uuid>_…` machine credentials and `gitlab_runner_jobs`; requests are routed to the pipeline protocol only
for `glrt-golf_` runner tokens, `golfreg_` registration tokens on `POST /api/v4/runners` and `golfjob_` job tokens.

Runner: GitLab Runner **18.5.0**, `gitlab-runner-linux-amd64` from
`https://gitlab-runner-downloads.s3.amazonaws.com/v18.5.0/binaries/gitlab-runner-linux-amd64`, SHA-256
`4f84c2995cff1aaff89ce8639426bf1219cb3770d9360ce8783e9b5fde628762` (matches the release's `release.sha256`). Any
executor works (the runner owner chooses Docker, Kubernetes, shell …); Golf records the reported version, executor,
platform and architecture.

### Registration

- `gitlab-runner register --url <origin> --registration-token golfreg_… [--tag-list a,b] --executor …` calls
  `POST /api/v4/runners` → `registerPipelineRunner` → `glrt-golf_<uuid hex>_<64 hex>` (tags become labels; a token's
  labels apply when no tags are given). `gitlab-runner register --token glrt-golf_…` (`POST /api/v4/runners/verify`)
  works for credentials created in the runner settings. `DELETE /api/v4/runners` is refused: delete runners in Golf.
- `POST /api/v4/jobs/request` claims the oldest QUEUED job whose tags ⊆ runner labels (untagged jobs run anywhere),
  within the runner's scope and with `actions` effective. The job token is `golfjob_<64 hex>` (digest only in D1).

### Job payload

`id`, `token`, `job_info` (`project_full_path` = `<owner>/<repo>`), `git_info` (`repo_url` =
`<origin>/<owner>/<repo>.git` with `gitlab-ci-token:<job token>`, read-only via the shared Smart HTTP route, exact
repository and commit; `refspecs` fetch the run's SHA; the runner's `CI_PROJECT_DIR` is `/builds/<owner>/<repo>`),
`runner_info.timeout`, `steps` (`script` = `before_script` + `script`; `after_script` with `when: always`), `image`,
`services` (name, alias, command, entrypoint, variables, pull_policy, docker platform/user), `artifacts` (archive +
one entry per report type), `cache` (key, paths, policy, when, untracked, fallback_keys — stored by the runner),
`dependencies` (job id, name, size of each dependency's archive; downloaded with the current job's token) and
`variables`, de-duplicated in GitLab precedence: predefined `CI_*` < YAML global < YAML job/matrix/rules <
dotenv from dependencies < repository variables < repository secrets (masked) < pipeline variables; `CI_JOB_TOKEN`,
`CI_BUILD_TOKEN` (masked) and `CI_REPOSITORY_URL` cannot be overridden. Environment-scoped values come from
`pipelineValues(db, env, run, job)` only after the environment's approval holds.

Predefined variables: `CI`, `GITLAB_CI`, `CI_SERVER*`, `CI_API_V4_URL`, `CI_PROJECT_{ID,NAME,PATH,PATH_SLUG,NAMESPACE,
ROOT_NAMESPACE,TITLE,URL,VISIBILITY}`, `CI_DEFAULT_BRANCH`, `CI_PIPELINE_{ID,IID,SOURCE,URL,CREATED_AT,NAME}`,
`CI_COMMIT_{SHA,SHORT_SHA,BEFORE_SHA,REF_NAME,REF_SLUG,REF_PROTECTED,BRANCH,TAG,MESSAGE,TITLE,DESCRIPTION}`,
`CI_MERGE_REQUEST_*` (merge request pipelines), `CI_JOB_{ID,NAME,NAME_SLUG,STAGE,URL,STARTED_AT,TIMEOUT,MANUAL,TOKEN}`,
`CI_NODE_{INDEX,TOTAL}` (parallel), `CI_ENVIRONMENT_{NAME,SLUG,URL,ACTION,TIER}`, `CI_RUNNER_ID`. `CI_SERVER_NAME` is
`Golf`. `CI_REGISTRY*`, `CI_DEPENDENCY_PROXY*` and `CI_PAGES*` are not provided.

### Runner routes

| Route | Behaviour |
| --- | --- |
| `PATCH /api/v4/jobs/:id/trace` (`Content-Range: start-end`, ≤ 4 MiB) | `appendJobLogBytes` into R2 chunks; `202` + `Range: 0-<next byte>`; a wrong offset is `416` + `Range: 0-<next byte>` so the runner resends |
| `PUT /api/v4/jobs/:id` | `running` keeps the job; `success`/`failed`/`canceled` → `finishPipelineJob` (exit code, `failure_reason`; GitLab `retry` re-queues); `coverage` is the last match of the job's regex in the last MiB of the log, stored in `outputs.coverage` |
| `POST /api/v4/jobs/:id/artifacts?artifact_type=&artifact_format=&expire_in=` | multipart `file`; archive (zip) → `gitlab-archive`, reports (gzip/raw) → `gitlab-report` named by type; at most `GITLAB_ARTIFACT_MAX_BYTES` (default 64 MiB, at most 96 MiB; buffered in the Worker) else `413`; `expire_in` honoured up to 90 days (`never` = 90 days) |
| `GET /api/v4/jobs/:id/artifacts` | the archive of a job named in the caller's `dependencies`, same run, streamed from R2 |
| Cancellation | when the run is cancelled, trace and `PUT running` answer `Job-Status: canceled`; the runner aborts and its terminal update records `CANCELLED` (`job_canceled`). A runner that never calls back is timed out by the coordinator |

Any other token, a finished job's token or a token of another job is `403` with `Job-Status: failed` (the runner aborts).

### `.gitlab-ci.yml` subset

Executed: `stages` (`types`), `.pre`/`.post`, `variables` (global/job; `value`/`description`/`expand`/`options`),
`default` (image, services, before/after_script, cache, artifacts, retry, timeout, interruptible, tags) and the
deprecated top-level image/services/before_script/after_script/cache, `workflow:rules` (if/changes/exists/when/
variables) and `workflow:name`, `include:local` (same repository and commit; wildcards; `include:rules`; at most 32
files, 8 levels, 1 MiB), hidden `.jobs`, `extends` (multiple, 11 levels), `!reference`, YAML anchors and merge keys,
`stage`, `script`/`before_script`/`after_script` (nested lists flattened), `image`, `services`, `needs` (names,
`job`/`artifacts`/`optional`/`parallel:matrix`, `needs: []`, same-stage needs), `dependencies`, `rules`
(`if`/`changes`/`exists`/`when`/`allow_failure`/`variables`/`needs`), `only`/`except` (refs keywords, regexes,
`ref@project/path`, `variables`, `changes`), `when` (on_success/on_failure/always/manual/never), `allow_failure`
(manual jobs default to allowed without rules, as in GitLab), `artifacts` (paths, exclude, name, untracked, when,
expire_in, reports), `cache` (key, `key:files` + prefix, paths, policy, when, untracked, fallback_keys, up to 4),
`retry` (0–2, `when: always`), `timeout` (1 minute–6 hours), `parallel: N`, `parallel:matrix`, `tags`, `coverage`,
`inherit`, `interruptible` (accepted; no effect because Golf does not auto-cancel redundant pipelines — noted on
the run) and `environment` (name/url/action/deployment_tier on Golf deployment environments: protected
environments hold the job in APPROVAL, also after a manual play; deployments are recorded).

Stage order becomes `needs`: a job without `needs` needs every job of all earlier stages; explicit `needs` stay as
written. Rules see predefined, pipeline, global and job variables; expressions support `$VAR`, `${VAR}`, quoted
strings, `null`, `/regex/flags` (and a variable holding `/regex/`), `==`, `!=`, `=~`, `!~`, `&&` (binds tighter),
`||` and parentheses. `changes` with no before-SHA diff (new branch, tag, web, schedule) is true, as in GitLab.
Without `rules` or `only`, jobs default to `only: [branches, tags]`, so merge request pipelines only contain jobs
that opt in. A job excluded by its rules never refuses the pipeline.

Refused at pipeline creation with the reason shown on the run (never silently ignored): `include:remote/project/
template/component/inputs`, `spec:inputs`, `trigger` (child/multi-project pipelines), GitLab Pages (`pages:` keyword
or a job named `pages`), `release`, `secrets`, `id_tokens`, `resource_group`, `hooks`, `identity`, `run` steps,
`manual_confirmation`, `when: delayed`/`start_in`, `retry:when` other than `always`, `retry:exit_codes`,
`allow_failure:exit_codes`, cross-project `needs`, `environment:on_stop/auto_stop_in/kubernetes`,
`image/services:kubernetes`, `artifacts:expose_as/public/access`, `workflow:auto_cancel`, `rules:changes:compare_to`,
`exists:project`, unknown keywords, YAML errors and custom tags. Bounds: 256 KiB per file, 256 jobs after
`parallel` expansion, 50 needs, 200 parallel instances, 128 KiB job definition.

Deviations recorded as run notes: `cache:key:files` hashes the files' content at the commit (GitLab uses the last
commit that changed them); report artifacts are stored and downloadable but not rendered as widgets;
`artifacts:reports:dotenv` variables reach jobs that depend on the producing job.

### Evidence (2026-10-14, local)

`node cloudflare/forge/gitlab-pipeline-runtime-check.mjs "$(command -v cf)" <gitlab-runner-18.5.0> --phases …` runs the
production modules in the qualified CLI's workerd with real D1, R2 and Secrets Store bindings (Artifacts is the only
stand-in: bare repositories behind `git http-backend` at the provider URL) and drives the unmodified runner:

- `demo` (`fixtures/gitlab/demo.gitlab-ci.yml`, Docker executor, 4 concurrent jobs): build → test → deploy. `build`
  uploads `dist/` (zip, 421 B) and a dotenv report; `package` (`needs: [build]`) starts before the test stage ends
  and downloads the build archive; `unit` downloads it, inherits `BUILD_VERSION=1.0.1` from dotenv, restores the
  cache saved by `build` (host `/cache` directory: the runner's default per-slot cache volume is not shared between
  concurrent jobs) and records coverage `87.5`; `postgres-service` (`services: postgres:16-alpine`, alias `db`)
  creates a table and reads 42 back; `flaky-check` fails with exit 3 and `allow_failure` (run stays green);
  `report 1/2`, `report 2/2` (`parallel: 2`) run with `after_script`; the manual `deploy` into protected
  `production` (reviewer: user 2) waits in MANUAL (run SUCCESS), enters APPROVAL when played, refuses the run's own
  actor as approver, runs after user 2 approves, receives the environment secret masked (`[MASKED]`, length 29) and
  records a `start` deployment. Run: SUCCESS.
- `cancel`: a `sleep 300` job; cancelling the run makes the runner abort on its next trace; job CANCELLED
  (`job_canceled`), run CANCELLED.
- `pages/hugo` (gitlab.com, unchanged): on `main` the pipeline is REFUSED — `job "create-pages": pages — GitLab Pages
  deployment is not supported on Golf.`; on a feature branch `test` runs in `hugomods/hugo:exts`
  (`default:before_script`, `rules: if: $CI_COMMIT_REF_NAME != $CI_DEFAULT_BRANCH`), `hugo mod get -u` upgrades the
  PaperMod theme from GitHub and `hugo --minify` then FAILS upstream-caused (`mapping key "aliases" already defined`
  in the theme's example content with Hugo v0.154.5), exit 1.
- `inkscape/extensions` (gitlab.com, unchanged, `master`): `image: ${IMAGE}` expanded by the runner, `workflow:rules`,
  `GIT_DEPTH: "1"` (clone and submodules at depth 1), `GIT_SUBMODULE_STRATEGY: recursive` (5 submodules fetched from
  gitlab.com), hidden `.artifacts` + `extends`, `parallel:matrix` → `test:linux: [3.10]` … `[3.14]` each SUCCESS
  (1448 passed, 10 skipped) with `coverage.zip` (~2.0 MB) uploaded `when: always`; `codestyle:ci`, `mypy`,
  `sphinx` (6.5 MB HTML artifact), `archive` (5.4 MB `extensions.zip`, built with `cd ..; zip $CI_PROJECT_NAME`)
  SUCCESS; `pages` excluded by `only: master@inkscape/extensions` (the project here is `mj/extensions`);
  `test:windows: [3.11]`/`[3.12]` stay QUEUED (tag `saas-windows-medium-amd64`, no matching runner) and
  `test:coverage` stays BLOCKED behind them, as on GitLab; the run was then cancelled (remaining jobs CANCELLED).
- `kubernetes` (`fixtures/gitlab/kubernetes.gitlab-ci.yml`): the same runner binary with the Kubernetes executor in
  the local kind cluster (`kind-golf-ci`, namespace `golf-gitlab-test`, created and deleted by the check): job pods
  with build, helper and `svc-0` containers (3/3); `build` uploads `dist/`, `service-sidecar` downloads it and reaches
  the postgres sidecar as `db` (answer 42). Run SUCCESS. The Worker listened on the host's LAN address because the
  kind cluster runs on rootless Docker.

Unit tests: `node --test cloudflare/forge/gitlab-pipeline.test.mjs cloudflare/forge/gitlab-runner.test.mjs`
(parser, refusals, expressions, the `/api/v4` protocol against the pipeline core, cancellation, size bounds and
evidence-path separation). The evidence coordinator's own real-runner test
(`GOLF_TEST_GITLAB_RUNNER=<binary> node --test cloudflare/forge/gitlab-runner.test.mjs`) still passes.

Not yet verified: hosted installation, the Actions UI against GitLab runs, a runner inside the cluster (Helm chart),
distributed (S3) runner cache, Windows/macOS runners, schedule triggers.
