# Agent hosts and "Assign to agent" (agents plan, phase 1a)

Contract for phase 1a of `docs/AGENTS_AND_AUTOMATIONS_PLAN.md`: a machine the user
connects runs the coding CLIs that are already installed and signed in there (Codex,
Claude Code, OpenCode, Grok), and Golf assigns it work from an issue or a pull
request. The result is a proposal branch in the repository with a live log; a person
opens the pull request. SSH hosts reached from Golf (phase 1b) and everything in later
phases are out of scope here.

Three parts are built against this contract in parallel: the Worker (schema, host
protocol, user API), the host binary `cmd/golf-agent-host`, and the web UI. Change
this file first when the contract must change.

Deviation from the plan: the host is a separate binary, `cmd/golf-agent-host`, not an
agent mode of `cmd/golf-native-runner`. The native runner carries the evidence
path's guarantees (approved image, network-less execution, receipts); a coding agent
needs the network, the user's own tools and a writable working copy, so sharing the
binary would weaken one or complicate both.

## Model

- **Host:** one registered machine. Scope `personal` (owned by the user who
  registered it), `organization` (managed by organization owners) or
  `installation` (managed by operations administrators).
- **Tool:** `codex`, `claude`, `opencode` or `grok`. The host reports each tool's
  version and whether it is signed in (`true`, `false`, or `null` when the host cannot
  tell); never a credential, and an account label only if the CLI prints one.
- **Task:** one run of one tool on one host for one issue or pull request. It produces
  at most one commit on a new branch `golf-agent/<first 8 hex of the task id>`.

## Who may use a host

A task is admitted only if all hold, checked at create and again at claim:

1. The `agent-hosts` feature policy is on for the repository (installation →
   organization → repository).
2. The requester has `write` or `admin` on the repository.
3. The host is `ACTIVE`, not deleted, and its scope covers the repository:
   `personal` → any repository the owner can write; `organization` → repositories
   owned by that organization; `installation` → every repository.
4. The requester is allowed on the host:
   - `personal`: the owner, or a user listed in `allowedUsers` when `shareSignins`
     is true. Without `shareSignins`, only the owner.
   - `organization` and `installation`: everyone in scope when `allowedUsers` is
     empty, otherwise the listed users. If `shareSignins` is false, only the user who
     registered the host may run tools that use subscription sign-ins; phase 1a
     treats every tool as possibly using a sign-in, so a non-sharing shared host
     serves only its registrant.
5. `allowedRepositories` is empty or lists the repository.
6. The tool is in `enabledTools` and the host last reported it as installed.
   `signedIn: false` refuses; `null` is allowed and labelled "unknown" in the UI.

Every refusal says which rule failed.

## Schema (migration `0036_agent_hosts.sql`)

`CREATE TABLE/INDEX IF NOT EXISTS` only (the guarded migrate step accepts nothing
else).

```sql
agent_host_registrations(id TEXT PRIMARY KEY, scope TEXT, scope_id TEXT, token_digest TEXT UNIQUE,
  expires_at INTEGER, uses_left INTEGER, revoked INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT)
agent_hosts(id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, name TEXT, scope TEXT, scope_id TEXT,
  registered_by INTEGER, credential_digest TEXT UNIQUE, state TEXT DEFAULT 'ACTIVE',   -- ACTIVE | DISABLED
  share_signins INTEGER DEFAULT 0, allowed_users TEXT DEFAULT '[]', allowed_repositories TEXT DEFAULT '[]',
  enabled_tools TEXT DEFAULT '["codex","claude","opencode","grok"]', max_concurrent INTEGER DEFAULT 1,
  host_version TEXT DEFAULT '', os TEXT DEFAULT '', arch TEXT DEFAULT '', version INTEGER DEFAULT 1,
  last_seen_at TEXT, created_at TEXT, deleted INTEGER DEFAULT 0)
agent_host_tools(host_id INTEGER, tool TEXT, version TEXT, signed_in INTEGER,          -- 1, 0 or NULL
  account TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(host_id, tool))
agent_tasks(id TEXT PRIMARY KEY, repository_id INTEGER, artifact_name TEXT, host_id INTEGER, tool TEXT,
  model TEXT DEFAULT '', requested_by INTEGER, target_kind TEXT, target_number INTEGER,     -- issue | pull_request
  base_ref TEXT, base_commit TEXT, branch TEXT, instructions TEXT DEFAULT '', prompt TEXT,
  state TEXT,          -- QUEUED CLAIMED RUNNING SUCCEEDED NO_CHANGES FAILED CANCELLED TIMED_OUT LOST
  token_digest TEXT UNIQUE, deadline INTEGER, cancel_requested INTEGER DEFAULT 0,
  claimed_at TEXT, started_at TEXT, finished_at TEXT, exit_code INTEGER, commit_id TEXT DEFAULT '',
  result TEXT DEFAULT '{}', failure_reason TEXT DEFAULT '', log_lines INTEGER DEFAULT 0,
  log_bytes INTEGER DEFAULT 0, idempotency_key TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(requested_by, idempotency_key))
agent_task_logs(task_id TEXT, seq INTEGER, text TEXT, PRIMARY KEY(task_id, seq))
```

Limits: 50 open registration tokens; 100 hosts per scope; 4 queued or running
tasks per host and 20 per repository; prompt ≤ 32 KiB; stored log ≤ 512 KiB and
10,000 lines per task (later lines are dropped and the log is marked truncated);
default deadline 30 minutes, maximum 2 hours. Lost tasks: a CLAIMED or RUNNING task
whose host has not called in for 3 minutes, or past its deadline, becomes `LOST` or
`TIMED_OUT` in the maintenance sweep.

## Credentials

- Registration token: `golfagentreg_<64 hex>`, one-time or few-use, 1–24 hours,
  stored as SHA-256.
- Host credential: `golf_agent_host_<uuid>_<64 hex>`, stored as SHA-256, returned once
  at registration, rotated by re-registering. Never sent to a tool.
- Task token: `golf_agent_task_<uuid>_<64 hex>` (uuid = task id), stored as SHA-256,
  valid until the task is terminal or its deadline passes. It authorizes only that
  task's log, finish and Git routes.

## Host protocol

All routes are `POST` JSON unless noted, outside Cloudflare Access (machine routes,
like `/native/runner-machine/`), and check the credential against D1 on every call.
Errors are `{ "code", "message" }` with the HTTP status used elsewhere (401 bad
credential, 403 not allowed, 409 conflict, 412 refused precondition, 413 too large).

| Route | Auth | Request | Response |
| --- | --- | --- | --- |
| `/native/agent-host/register` | none (token in body) | `{ registrationToken, name, hostVersion, os, arch }` | `{ hostId, uuid, credential }` |
| `/native/agent-host/heartbeat` | `Bearer` host credential | `{ tools: [{ tool, version, signedIn, account }] }` (≤ 8) | `{ ok: true, cancel: [taskId…], state }` |
| `/native/agent-host/claim` | host credential | `{ claimId }` (uuid; a retried claim returns the same task) | `{ task: null }` or `{ task }` below |
| `/native/agent-host/tasks/<id>/start` | `Bearer` task token | `{}` | `{ ok: true, cancel: false }` |
| `/native/agent-host/tasks/<id>/log` | task token | `{ offset, lines: [string] }` (≤ 200 lines, ≤ 64 KiB) | `{ nextOffset, cancel }` |
| `/native/agent-host/tasks/<id>/finish` | task token | see below | `{ ok: true, state }` |
| `/native/agent-host/tasks/<id>/git/info/refs?service=…` (GET), `…/git-upload-pack`, `…/git-receive-pack` | Basic `golf:<task token>` | Smart HTTP | Smart HTTP |

Claimed task:

```json
{ "id": "uuid", "repository": "owner/name", "cloneUrl": "https://ORIGIN/native/agent-host/tasks/<id>/git",
  "branch": "golf-agent/1a2b3c4d", "baseRef": "refs/heads/main", "baseCommit": "<40 hex>",
  "tool": "codex", "model": "", "prompt": "…", "deadline": 1792000000000, "token": "golf_agent_task_…",
  "target": { "kind": "issue", "number": 12, "title": "…", "url": "https://ORIGIN/owner/name/issues/12" } }
```

Log `offset` is the number of lines already accepted; a retried chunk with an old
offset is ignored for the lines already stored. `cancel: true` (from heartbeat,
start or log) means the host must stop the tool's process group, discard the working
copy and finish with `cancelled`.

Finish:

```json
{ "state": "succeeded|no_changes|failed|cancelled|timed_out", "exitCode": 0, "commitId": "<40 hex or empty>",
  "summary": "≤ 4 KiB, what the tool said it did", "changedFiles": ["path", "…"],
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 }, "failure": "≤ 512 chars" }
```

On `succeeded` the Worker checks that `refs/heads/<branch>` in the repository points
at `commitId` and that `baseCommit` is an ancestor (first parent chain, at most 50
commits); otherwise the task becomes `FAILED` with `failure_reason = 'proposal_unverified'`.
`usage` is what the CLI reported, labelled as reported.

Git through the task route: upload-pack reads the repository; receive-pack accepts
exactly one update of `refs/heads/<branch>`, create or fast-forward from
`baseCommit`, ≤ 8 MiB, only while the task is `RUNNING`. Everything else is 403.

## Host binary behaviour (`cmd/golf-agent-host`)

- `golf-agent-host register --origin URL --name NAME --state DIR` reads the
  registration token from `GOLF_AGENT_REGISTRATION_TOKEN`, writes `DIR/host.json`
  (mode 0600, dir 0700) with the credential.
- `golf-agent-host run --state DIR [--config FILE]` heartbeats every 15 s, claims when
  below `maxConcurrent`, and per task:
  1. creates `DIR/work/<task id>` (0700), clones `cloneUrl` with the task token at
     `baseCommit`, checks out a new branch `branch`;
  2. runs the tool headless in that directory with a scrubbed environment (no Golf
     credential, no task token; the user's own tool sign-in is whatever the host user
     already has), streaming stdout and stderr lines to `log` every second;
  3. on exit, if the tree changed, commits as `Golf agent (<tool>) <agent@golf.invalid>`
     with a message that names the issue or pull request and ends with
     `Golf-Agent-Task: <id>`, pushes the branch with the task token and finishes
     `succeeded`; no change → `no_changes`; non-zero exit with no change → `failed`;
  4. removes the working copy (keep with `--keep-work` for debugging).
- Tool commands are built from a fixed table (never a shell string): Codex
  `codex exec`, Claude Code `claude -p`, OpenCode `opencode run`, Grok `grok -p`, each
  with the non-interactive flags that let it edit files in the working directory and
  nothing outside it, verified against the installed versions and documented in the
  binary's README. A model is passed only when the task names one.
- Signed-in detection uses each CLI's own status command where one exists; otherwise
  `null`.

## User API (Cloudflare Access sign-in)

`POST /native/agent-hosts` (`{ action, … }`):

- `list` `{ scope, organization? }` → `{ hosts: [{ id, uuid, name, scope, scopeId, state, online,
  lastSeenAt, shareSignins, allowedUsers: [login], allowedRepositories: ["owner/name"],
  enabledTools, maxConcurrent, hostVersion, os, arch, tools: [{ tool, version, signedIn, account }],
  activeTasks, version }], tokens: [{ id, expiresAt, usesLeft }], canManage }`.
  `scope: "personal"` lists the caller's own hosts.
- `createToken` `{ scope, organization?, ttlHours, uses }` → `{ token, commands: [string] }`
  (the exact `register` and `run` commands).
- `revokeToken` `{ scope, organization?, id }`.
- `update` `{ id, expectedVersion, name?, state?, shareSignins?, allowedUsers?, allowedRepositories?,
  enabledTools?, maxConcurrent? }` → `{ host }`.
- `delete` `{ id }`: credential stops at once; queued tasks are cancelled, running
  tasks are cancelled on the next call.

Who manages: personal → the owner; organization → its owners; installation →
operations administrators.

`POST /native/agent-tasks` (`{ action, repository: { owner, name }, repositoryId, … }`):

- `available` → `{ hosts: [{ id, name, scope, online, tools: [{ tool, version, signedIn, usable,
  reason }] }], featureOn, reason }` for this repository and caller.
- `create` `{ target: { kind, number }, hostId, tool, model?, instructions?, idempotencyKey }`
  → `{ task }`. `instructions` ≤ 4 KiB. The server builds the prompt from the issue or
  pull request title and body, up to the 20 most recent comments, and the
  instructions (total ≤ 32 KiB, truncated with a marker), plus a fixed preamble that
  says to change files in the working copy only and not to push.
  Issue → base is the default branch head. Pull request → base is the pull request's
  head commit and branch.
- `list` `{ target? }` → `{ tasks }` (newest first, 50).
- `get` `{ id }` → `{ task }`; `log` `{ id, offset }` → `{ lines, nextOffset, complete, truncated }`.
- `cancel` `{ id }`.

Task view: `{ id, state, tool, model, host: { id, name }, requestedBy, target, branch, baseRef,
baseCommit, commitId, changedFiles, summary, usage, exitCode, failureReason, createdAt,
startedAt, finishedAt, logLines }`.

"Open pull request" in the UI uses the existing `CreatePullRequest` RPC from
`branch` into the issue's default branch, or into the pull request's head branch.
The agent never opens or merges anything.

## Policy, capability and audit

- Feature policy id `agent-hosts`, label "Coding agents on your machines", group
  Automation, requires `issues`, always allocated (it needs no operator binding).
- Capability `agents.hosts`: READY when the schema is present.
- Audit descriptors: `agent_host.token_create`, `agent_host.token_revoke`,
  `agent_host.update`, `agent_host.delete`, `agent_task.create`, `agent_task.cancel`.
  Never the token, credential, prompt or instructions text.

## Acceptance

Worker tests for every rule above; the Go binary's tests against a fake server; a
real runtime check (local workerd and D1, the real binary, and at least Codex and
Claude Code on this machine) that assigns an issue, sees the live log, verifies the
branch commit and opens the pull request; Playwright specs for the host settings,
the assign dialog and the task panel. Hosted acceptance is recorded separately.
