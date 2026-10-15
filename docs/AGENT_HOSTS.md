# Agent hosts and "Assign to agent" (agents plan, phase 1a)

Contract for phase 1a of `docs/AGENTS_AND_AUTOMATIONS_PLAN.md`: a machine the user
connects runs the coding CLIs that are already installed and signed in there (Codex,
Claude Code, OpenCode, Grok), and Golf assigns it work from an issue or a pull
request. The result is a proposal branch in the repository with a live log; a person
opens the pull request, or the agent opens it through Golf's MCP tools with its task
token ([Golf MCP for the task](#golf-mcp-for-the-task)). SSH hosts reached from Golf (phase 1b) are specified in [SSH_HOSTS.md](SSH_HOSTS.md); they reuse this model, its admission rules, task states and task protocol. Everything in later
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
  share_signins INTEGER DEFAULT 0, allowed_users TEXT DEFAULT '[]', allowed_repositories TEXT DEFAULT '[]', -- JSON ids
  enabled_tools TEXT DEFAULT '["codex","claude","opencode","grok"]', max_concurrent INTEGER DEFAULT 1,
  host_version TEXT DEFAULT '', os TEXT DEFAULT '', arch TEXT DEFAULT '', version INTEGER DEFAULT 1,
  last_seen_at TEXT, created_at TEXT, deleted INTEGER DEFAULT 0)
agent_host_tools(host_id INTEGER, tool TEXT, version TEXT, signed_in INTEGER,          -- 1, 0 or NULL
  account TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(host_id, tool))
agent_tasks(id TEXT PRIMARY KEY, repository_id INTEGER, artifact_name TEXT, host_id INTEGER, tool TEXT,
  model TEXT DEFAULT '', requested_by INTEGER, target_kind TEXT, target_number INTEGER,     -- issue | pull_request
  target_title TEXT DEFAULT '',                                                            -- title at create
  base_ref TEXT, base_commit TEXT, branch TEXT, instructions TEXT DEFAULT '', prompt TEXT,
  state TEXT,          -- QUEUED CLAIMED RUNNING SUCCEEDED NO_CHANGES FAILED CANCELLED TIMED_OUT LOST
  token_digest TEXT UNIQUE, claim_id TEXT, deadline INTEGER, cancel_requested INTEGER DEFAULT 0,
  claimed_at TEXT, started_at TEXT, finished_at TEXT, exit_code INTEGER, commit_id TEXT DEFAULT '',
  result TEXT DEFAULT '{}', failure_reason TEXT DEFAULT '', log_lines INTEGER DEFAULT 0,
  log_bytes INTEGER DEFAULT 0, log_truncated INTEGER DEFAULT 0, idempotency_key TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(requested_by, idempotency_key))
agent_task_logs(task_id TEXT, seq INTEGER, text TEXT, PRIMARY KEY(task_id, seq))
```

The migration adds `NOT NULL` and `CHECK` constraints to these columns and indexes on
hosts by scope and tasks by host, repository and state. `claim_id` makes a retried
claim return the same task; `log_truncated` marks a log cut at its bound;
`target_title` keeps the issue or pull request title at create.

Limits: 50 open registration tokens per scope; registration tokens have 1–10 uses;
100 hosts per scope; 4 queued or running tasks per host and 20 per repository (429
`resource_exhausted`); prompt ≤ 32 KiB; stored log ≤ 512 KiB and
10,000 lines per task (later lines are dropped and the log is marked truncated);
default deadline 30 minutes, maximum 2 hours. The deadline counts from the claim:
time spent queued does not shorten it. Lost tasks: a CLAIMED or RUNNING task
whose host has not called in for 3 minutes, or past its deadline, becomes `LOST` or
`TIMED_OUT` in the maintenance sweep.

Rate budgets (AM-6): each task token may make 600 requests and 120 pushes a minute by
default (installation setting `agent-budgets`). Over budget, `start`, `log` and
`finish` answer 429 with `Retry-After`. Task Git fetches answer 429 `text/plain`, and
a push is refused in Git's own report. See the rate budgets section of
`docs/AGENT_ACCESS.md`.

## Credentials

- Registration token: `golfagentreg_<64 hex>`, one-time or few-use, 1–24 hours,
  stored as SHA-256.
- Host credential: `golf_agent_host_<uuid>_<64 hex>`, stored as SHA-256, returned once
  at registration, rotated by re-registering. Never sent to a tool.
- Task token: `golf_agent_task_<uuid>_<64 hex>` (uuid = task id), stored as SHA-256,
  valid until the task is terminal or its deadline passes. It authorizes that task's
  start, log, finish and Git routes and, while the task is `RUNNING`, `/mcp` and
  `/native/source/*` limited to the task's repository and branch
  ([Golf MCP for the task](#golf-mcp-for-the-task)). Nothing else, and never `/git/`.

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
  "mcp": { "url": "https://ORIGIN/mcp" },
  "target": { "kind": "issue", "number": 12, "title": "…", "url": "https://ORIGIN/owner/name/issues/12" } }
```

`mcp` is `null` while the `agent-access` feature policy is off for the repository.
A host refuses a task whose `mcp.url` is not `<registered origin>/mcp`.

A retried claim (same `claimId`, task still `CLAIMED`) returns the same task with a
fresh token, and the earlier token stops working; the host always uses the token
from the latest claim response. A claim returns `{ task: null }` when the host already
runs `maxConcurrent` tasks, and 403 when the host is disabled (heartbeat reports
`state`). A queued task that no longer passes the admission rules at claim becomes
`FAILED` with `failureReason` `refused_<rule code>` and is skipped.

`start` moves `CLAIMED` to `RUNNING`; if a cancel was requested it answers
`{ ok: true, cancel: true }` without starting. A task token works for start, log and
Git while the task is `CLAIMED` or `RUNNING` and before its deadline (401 after the
deadline, 409 once finished). `finish` is accepted from `CLAIMED` (a host may refuse a
task without starting it) or `RUNNING`; a finish for a task that already finished
answers `{ ok: true, state }` with the state it has.

Log `offset` is the number of lines already accepted; a retried chunk with an old
offset is ignored for the lines already stored. An offset past the accepted count is
409 `{ code, message, nextOffset }`; resend from `nextOffset`. Golf credentials
(`golf_agent_task_…`, `golf_agent_host_…`, `golfagentreg_…`, `golf_native_…`,
`golf_git_…`) are replaced with `***` in stored lines and failure text. Heartbeat's
`cancel` lists every `CLAIMED` or `RUNNING` task of the host with a cancel request; the
host learns of a cancel there (it never sends empty log chunks). `cancel: true` (from heartbeat,
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
Precisely: upload-pack works while the task is `CLAIMED` or `RUNNING`; a push must
create the branch, or move it from the commit this same task pushed before (any other
old value is 403, a stale one 409); deletes are 403; repository branch rules apply;
over 8 MiB is 413; git's 4-byte `0000` probe answers 200. The push is journaled and
fenced like a `/git/` push (as the requester), and does not start Actions workflows.
Send the credentials up front (`Authorization: Basic golf:<token>`); a request
without them gets 401 with `WWW-Authenticate: Basic`. Ancestry is checked at
`finish`, not at push.

## Host binary behaviour (`cmd/golf-agent-host`)

- `golf-agent-host register --origin URL --name NAME --state DIR` reads the
  registration token from `GOLF_AGENT_REGISTRATION_TOKEN`, writes `DIR/host.json`
  (mode 0600, dir 0700) with the credential.
- `golf-agent-host run --state DIR [--config FILE]` heartbeats every 15 s, claims when
  below `maxConcurrent`, and per task:
  1. creates `DIR/work/<task id>` (0700), clones `cloneUrl` with the task token at
     `baseCommit`, checks out a new branch `branch`;
  2. runs the tool headless in that directory with a scrubbed environment (no Golf
     credential and no task token, except `GOLF_MCP_TOKEN` when the task has `mcp`;
     the user's own tool sign-in is whatever the host user already has), streaming
     stdout and stderr lines to `log` every second;
  3. on exit, if the tool published `branch` itself through MCP, takes that branch as
     the proposal (below); otherwise, if the tree changed, commits as
     `Golf agent (<tool>) <agent@golf.invalid>` with a message that names the issue or
     pull request and ends with `Golf-Agent-Task: <id>`, pushes the branch with the
     task token and finishes `succeeded`; no change → `no_changes`; non-zero exit with
     no change → `failed`;
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
- `createToken` `{ scope, organization?, ttlHours, uses }` → `{ token, registration: { id, expiresAt, usesLeft }, commands: [string] }`
  (the exact `register` and `run` commands; `ttlHours` 1–24 and `uses` 1–10, both
  default 1).
- `revokeToken` `{ id }` (a `scope` sent with it is ignored).
- Organization members who are not owners may `list` their organization's hosts with
  `canManage: false` and no tokens.
- `update` `{ id, expectedVersion, name?, state?, shareSignins?, allowedUsers?, allowedRepositories?,
  enabledTools?, maxConcurrent? }` → `{ host }`.
- `delete` `{ id }`: credential stops at once; queued tasks are cancelled, running
  tasks are cancelled on the next call.

Who manages: personal → the owner; organization → its owners; installation →
operations administrators.

`POST /native/agent-tasks` (`{ action, repository: { owner, name }, repositoryId, … }`):

- `available` → `{ hosts: [{ id, name, scope, online, tools: [{ tool, version, signedIn, usable,
  reason }] }], featureOn, reason }` for this repository and caller. Hosts are listed only
  for writers when the feature is on; `reason` says why the list is empty otherwise.
- `create` `{ target: { kind, number }, hostId, tool, model?, instructions?, idempotencyKey }`
  → `{ task }`. `instructions` ≤ 4 KiB. The server builds the prompt from the issue or
  pull request title and body, up to the 20 most recent comments, and the
  instructions (total ≤ 32 KiB, truncated with a marker), plus a fixed preamble that
  says to change files in the working copy only and not to push.
  Issue → base is the default branch head. Pull request → base is the pull request's
  head commit and branch.
- `list` `{ target? }` → `{ tasks, canAssign }` (newest first, 50).
- `get` `{ id }` → `{ task }`; `log` `{ id, offset }` → `{ lines, nextOffset, complete, truncated, state }`
  (at most 1,000 lines per read).
- `cancel` `{ id }` → `{ task }`: by the requester, a repository administrator, or a
  manager of the task's host (its owner, the organization's owners, or operations
  administrators). A queued task is `CANCELLED` at once; a claimed or running task
  gets a cancel request and stops on the host's next call.

Task view: `{ id, state, tool, model, host: { id, name }, requestedBy: { id, login },
target: { kind, number, title, url }, branch, baseRef, baseCommit, commitId, changedFiles,
summary, usage, exitCode, failureReason, cancelRequested, createdAt, claimedAt, startedAt,
finishedAt, deadline, logLines, logTruncated }`. `usage` is the host's report with
`reported: true`, or null; `costUsd` is present only when the tool reported it.

`failureReason` codes the Worker writes: `proposal_unverified` (finish check failed),
`timed_out` (deadline passed, sweep), `lost` (host silent for 3 minutes, sweep),
`host_deleted` (queued when its host was deleted), `cancelled` (cancelled while queued),
`refused_<code>` (admission failed at claim; codes `feature_off`, `not_writer`,
`host_unavailable`, `host_scope`, `not_allowed`, `repository_not_allowed`,
`tool_disabled`, `tool_missing`, `tool_signed_out`, `repository_unavailable`). For
`failed`, `cancelled` and `timed_out` finishes it is the host's own `failure` text
(≤ 512 characters, credentials masked), or empty.

"Open pull request" in the UI uses the existing `CreatePullRequest` RPC from
`branch` into the issue's default branch, or into the pull request's head branch.
The agent may open that pull request itself through MCP (below); it never merges.

## Golf MCP for the task

The claim's `mcp.url` is Golf's remote MCP endpoint (`docs/AGENT_ACCESS.md`), and the
credential is the task token the host already holds. Server side (`api-tokens.mjs`
`taskTokenActor`), the token acts as the requester, scoped to the task's repository,
`write`, and exactly `branch`; only while the task is `RUNNING`, not cancel-requested,
before its deadline, and while the requester can still write. Source API writes re-check
that in the D1 statement that reserves the ref. `open_pull_request` accepts only
`head = branch` and records the pull request's origin as `agent-task` with the task id;
`comment` accepts only the task's own issue or pull request and pull requests whose head
is `branch`. Calls count against the task's rate budget. Not on `/git/`.

Host side (`cmd/golf-agent-host`), per task and per tool, never changing the user's own
tool configuration, and never putting the token in argv, a file or a log:

| Tool | How it reaches `/mcp` |
| --- | --- |
| Claude Code | `--mcp-config <task dir>/golf-mcp.json --allowedTools mcp__golf`; the file (0600, created exclusively in the task's private directory, removed after the run) holds `{"mcpServers":{"golf":{"type":"http","url":…,"headers":{"Authorization":"Bearer ${GOLF_MCP_TOKEN}"}}}}` |
| Codex | `-c mcp_servers.golf.url="…" -c mcp_servers.golf.bearer_token_env_var="GOLF_MCP_TOKEN" -c mcp_servers.golf.default_tools_approval_mode="approve" -c shell_environment_policy.ignore_default_excludes=false` |
| OpenCode | `OPENCODE_CONFIG_CONTENT={"mcp":{"golf":{"type":"remote","url":…,"headers":{"Authorization":"Bearer {env:GOLF_MCP_TOKEN}"},"enabled":true}}}` |
| Grok | not configured: Grok reads MCP servers only from its `config.toml` (user or project scope), which the host does not change. The task runs without Golf MCP tools. |

The token is in the tool's environment as `GOLF_MCP_TOKEN`. The host appends a "Golf
MCP tools" section to the prompt: read with the tools; or publish the change yourself
with `commit_changes` to `branch` (from `baseCommit`) and `open_pull_request` from it;
comment only on the task's issue or pull request. That section overrides the server
preamble's "do not commit or open pull requests" for the MCP tools only.

If `refs/heads/<branch>` exists in Golf when the tool exits (the tool published it), the
host fetches it and finishes `succeeded` with that commit and its changed files, pushing
nothing; if the working copy also holds changes the branch does not, it finishes
`failed` with `branch_published: …` and the branch keeps what was published.
`finish` verifies the branch as for a pushed proposal.

## Policy, capability and audit

- Feature policy id `agent-hosts`, label "Coding agents on your machines", group
  Automation, requires `issues`, always allocated (it needs no operator binding).
- Capability `agents.hosts`: READY when the schema is present (DISABLED with the
  reason when an installation policy turns the feature off).
- Audit descriptors: `agent_host.token_create`, `agent_host.token_revoke`,
  `agent_host.update`, `agent_host.delete`, `agent_task.create`, `agent_task.cancel`
  (category "Coding agents"). Never the token, credential, prompt or instructions text.
  Organization hosts and tokens are recorded at their organization; personal and
  installation ones at installation scope. `update`, `delete` and `revokeToken` carry
  only `id`; the scope comes from the stored host or token.

## Acceptance

Worker tests for every rule above; the Go binary's tests against a fake server; a
real runtime check (local workerd and D1, the real binary, and at least Codex and
Claude Code on this machine) that assigns an issue, sees the live log, verifies the
branch commit and opens the pull request; Playwright specs for the host settings,
the assign dialog and the task panel. Hosted acceptance is recorded separately.
