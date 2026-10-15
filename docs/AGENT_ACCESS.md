# Agent access: API tokens and remote MCP

Status: Cloudflare-native (schema 39), agentic mode AM-3 ([plan](AGENTIC_MODE_PLAN.md)).
Unit and integration tests run locally; a hosted run with a real coding agent is still
outstanding (see [What is not verified yet](#what-is-not-verified-yet)).

Coding agents reach Golf with a personal API token:
- the remote MCP endpoint `POST /mcp`;
- the [Source API](SOURCE_API.md) `POST /native/source/{commit,branch,files,tree}`;
- HTTPS Git `/git/<owner>/<name>.git/…`, so an agent needs no separate Git credential.

## API tokens

- **Format:** `golf_pat_` followed by 32 random bytes in base64url (43 characters).
  Golf shows the secret once, when it is created. Only its SHA-256 is stored
  (`api_tokens.digest`, migration `0039_api_tokens.sql`).
- **Fields:** a label (up to 64 bytes), the owner, an expiry from 1 hour to 90 days,
  last used (updated at most once a minute) and revoked.
- **Scope:**
  - repositories: a list (up to 100), or all repositories the owner can access,
    including ones granted later;
  - permission: `read` or `write`;
  - write branch pattern (write tokens only): an exact branch name, or a prefix
    ending in `*` such as `agent/*`. With a pattern, pushes and Source API writes to
    other branches and to tags are refused. Empty means any ref the account and the
    repository's rules allow.
- **Never more than the owner:** every call checks the owner's current grant. A
  `read` token caps the role at read. A `write` token caps it at write, never
  administration. A write token on a repository the owner only reads cannot write.
- **Ended by account changes:** a token is bound to the owner's identity version
  (`native_identity_versions`). Changing the account's login, email or active state
  ends every token at once (shown as "Ended by an account change").
- **Limit:** 50 active tokens per account.
- **Feature policy:** the `agent-access` feature ("API tokens and MCP", Integrations).
  The installation, an organization or a repository administrator can turn it off.
  Token calls on that repository are then refused with the policy's reason. People
  signed in through Access are not affected.
- **Capability:** `agents.mcp` is ready once the schema 39 migration is applied, and
  disabled when the installation policy turns the feature off.

### Managing tokens

Settings → Developer → **API tokens** (`/account/api-tokens`) lists your tokens first:
repositories, permission, write branches, expiry, last use and state. **New token**
opens the form. After creation the page shows the secret once, with ready-to-paste
setups for Claude Code, Codex, OpenCode and Git.

The user API is `POST /native/api-tokens` with `action`:

| Action | Request | Response |
| --- | --- | --- |
| `list` | `{}` | `{ tokens: [token], active, limit: 50, mcpUrl, origin }` (newest 200) |
| `create` | `{ label, repositories: null \| [id], permission, branchPattern?, lifetimeHours }` (1–2160) | `{ token, secret, mcpUrl, origin }` |
| `revoke` | `{ id }` | `{ id, revoked: true }` |

A `token` is `{ id, label, permission, branchPattern, state, repositories: null | [{ id, fullName }], createdAt, expiresAt, lastUsedAt, revokedAt }`.
`state` is `active`, `expired`, `revoked` or `invalidated`.

This route accepts only a signed-in browser session. It refuses any `Authorization`
header (an API token gets 401) and Access service-token headers, and it requires
`Origin` to equal the public origin and an Access identity.

Create and revoke are audited at installation scope (`api_token.create`,
`api_token.revoke`, category "API tokens"). The audit row never holds the secret. When
a valid token is refused by its own scope (a repository outside it, a read-only token
writing, a branch outside its pattern), Golf records `api_token.use_denied` at
repository scope, with the reason.

## Where a token is accepted

`actor()` (`core.mjs`) accepts `Authorization: Bearer golf_pat_…` only on:
- `/mcp`;
- `/native/source/*`;
- the three Smart HTTP Git routes `/git/<owner>/<name>.git/{info/refs,git-upload-pack,git-receive-pack}`.
  Git also accepts Basic auth with any user name and the token as the password,
  because Git clients send Basic.

It also accepts a token on an explicit allowlist of repository RPCs, but only on the
MCP tools' own internal requests. Those requests are marked by an environment flag
that only `mcp.mjs` sets (`env.mcpInternal === true`), never by a header, query or
body.

Everywhere else a token is refused with 401. This includes browser and account routes
and `/native/api-tokens`.

For a push or a Source API write, the D1 statement that reserves the ref also checks
the token (`person.token_guard`): not revoked, not expired, still a write token, the
account active and its identity version unchanged. A token revoked in the middle of a
request writes nothing.

## Machine routes outside Access

When Cloudflare Access protects the installation, the public Worker (`public.mjs`)
treats these as machine routes:
- `/mcp` and `/native/source/*` with `Authorization: Bearer golf_pat_…`;
- `/git/*` with a `golf_pat_` Bearer or Basic password.

Like runner and agent host routes, it skips the Access check for them and leaves the
credential check to the Workspace. On these requests:
- the `Cookie` header is removed;
- no Access identity header is ever added;
- any client-sent `X-Golf-Native-Access-*` header is dropped, as on every request.

The same paths without a token, or with another credential, still require Access.

Operators: if the Access application covers the whole hostname, add bypass (or
service-auth) policies for `/mcp`, `/native/source/` and `/git/` so that agent
requests reach the Worker. The Worker still requires Access on those paths for any
request without a token.

## Remote MCP endpoint

`POST <origin>/mcp` is a Streamable HTTP MCP server. It is stateless and answers with
JSON (`Content-Type: application/json`); there is no SSE stream, and `GET` returns
405. JSON-RPC batches are not supported.

- **Auth:** `Authorization: Bearer golf_pat_…`. A Golf native credential
  (`golf_native_…`) also works, with that account's full authority. Without a bearer
  the response is 401 with `WWW-Authenticate: Bearer realm="Golf MCP"`. A browser
  session alone is refused.
- **Methods:**
  - `initialize` echoes the client's `protocolVersion` when it is `2025-11-25`,
    `2025-06-18`, `2025-03-26` or `2024-11-05`; otherwise it answers `2025-06-18`.
    The server is `serverInfo { name: "golf", version: <release> }` with
    `capabilities { tools: {} }`.
  - notifications (no `id`), such as `notifications/initialized`, get 202 with no
    body.
  - `ping`, `tools/list` and `tools/call`.
- **Tools call the UI's own handlers.** Each tool builds an internal request to the
  route the web UI uses, with the caller's own `Authorization`, and runs it through
  `handle()`. Grants, token scope, feature policy, limits, branch rules, the ref fence
  and audit are therefore exactly the UI's.
- **Admission:** the Workspace reads the JSON-RPC body before admission
  (`admitMCP`). `initialize`, `ping`, `tools/list` and read tools are admitted as
  reads and overlap. `commit_changes` and `create_branch` are transfers, ordered by the
  D1 ref fence like pushes. Other write tools are exclusive. Internal requests call
  `handle()` directly and never re-enter the queue.
- **Results:** text content, either pretty JSON or a diff. A result is capped at
  256 KiB; a longer one is cut and ends with
  `{"truncated": true, "limitBytes": 262144, …}`.
- **Errors:** Golf's refusals become MCP tool errors,
  `{ isError: true, content: [{ type: "text", text: <Golf's message> }] }`. A refusal
  that carries data follows the message as JSON, for example `currentHead` for a stale
  head, or `conflicts` for overlapping paths. An unknown tool is JSON-RPC `-32602`,
  and an unknown method is `-32601`.
- **Request size:** a request body is limited to 12 MiB.
- **Live updates:** write tools publish live activity for their repository, as the UI
  does.

### Tools

Every tool takes `owner` and `name`. A `ref` defaults to the default branch.

| Tool | Arguments | Calls |
| --- | --- | --- |
| `repo_overview` | — | `GetRepository`, `GetRepositoryOverview` |
| `list_tree` | `ref?`, `path?` | `/native/source/tree` (recursive) |
| `read_files` | `ref?`, `paths[]` (≤ 100) | `/native/source/files` |
| `search_code` | `query` | `/native/search/read` (semantic search; needs the index) |
| `list_commits` | `ref?`, `limit?` (≤ 100) | `ListCommits` |
| `compare` | `base`, `head` (branches) | `ResolveRepositorySource` ×2, `GetRepositoryComparison` |
| `get_issue` | `number` | `GetIssue`, `ListIssueComments` (≤ 100) |
| `list_issues` | `state?` (`open`/`closed`/`all`), `limit?` | `ListIssues` |
| `get_pull_request` | `number` | `GetPullRequest` |
| `pull_request_diff` | `number` | `GetPullRequest`, `GetPullRequestDiff` |
| `pipeline_status` | `ref?` | `/native/pipelines` `listRuns` (latest 10) |
| `commit_changes` (write) | `branch`, `expectedHead`, `message`, `changes[]`, `base?`, `onStale?` | `/native/source/commit` |
| `create_branch` (write) | `branch`, `from` | `/native/source/branch` |
| `open_pull_request` (write) | `head`, `base`, `title`, `body?`, `draft?` | `ResolveRepositorySource` ×2, `CreatePullRequest` |
| `comment` (write) | `number`, `body` | `GetIssue` or `GetPullRequestDiscussion`, `CreateIssueComment` |

A change for `commit_changes` is one of:
- `{path, content}` (UTF-8);
- `{path, contentBase64, mode?}`, where `mode` is `file`, `executable` or `symlink`;
- `{path, delete: true}`;
- `{path, from}` (a move).

`expectedHead` is the head SHA you read. To create the branch, pass it empty together
with `base`. With `onStale: "merge"`, a head that moved since is merged three ways
when the paths do not overlap. See [SOURCE_API.md](SOURCE_API.md).

`tools/list` shows write tools only to write tokens and native credentials. A read
token calling a write tool gets a tool error before anything runs.

## Client setup

Replace `<origin>` with the installation origin and `<token>` with the secret.

Claude Code:

```sh
claude mcp add --transport http golf <origin>/mcp --header "Authorization: Bearer <token>"
```

Codex (`~/.codex/config.toml`, with `GOLF_API_TOKEN` set to the token in the
environment):

```toml
[mcp_servers.golf]
url = "<origin>/mcp"
bearer_token_env_var = "GOLF_API_TOKEN"
```

OpenCode (`opencode.json`):

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "golf": { "type": "remote", "url": "<origin>/mcp", "enabled": true,
    "headers": { "Authorization": "Bearer <token>" } } } }
```

Git:

```sh
git clone https://x:<token>@<host>/git/<owner>/<name>.git
```

A token in a clone URL is saved in `.git/config`. On shared machines, prefer a
credential helper.

## Rate budgets (AM-6)

Each API token and each agent-host task has two budgets a minute: requests, and
writes. The defaults are:

| Caller | Requests a minute | Writes a minute |
| --- | --- | --- |
| API token (`golf_pat_`) | 600 | 60 |
| Agent task (task token) | 600 | 120 |

**What counts**
- **API token requests:** each `/mcp` message that has an id, each
  `/native/source/*` call and each `/git/` request (advertisement, fetch, the
  pre-push probe or push).
- **API token writes:** a push (`git-receive-pack` with a command),
  `/native/source/commit` and `/native/source/branch`, and the MCP write tools
  (`commit_changes`, `create_branch`, `open_pull_request`, `comment`). A write is also
  one request. Tokens cannot reach `/native/land`, so landing is not counted.
- **Agent task requests:** `start`, `log` and `finish`, and each request on the
  task's Git route. **Writes:** pushes on the task's Git route.
- An MCP tool's internal requests are not counted again; the tool call was.
  Notifications, batches and malformed MCP messages run nothing and are not counted.
- **Never counted:** people. Browser sessions (Access), `golf_native_` credentials
  and `golf_git_` Git credentials are not budgeted. Neither are runners or agent host
  credentials (`register`, `heartbeat`, `claim`).

**Over budget** the answer names the budget and when to retry:
- **Git push:** Git's own report, `! [remote rejected] <ref> (budget: 60 writes per
  minute for this api token reached; retry in 12 s)`, with `Retry-After`.
- **Git fetch or advertisement:** HTTP 429, `text/plain`, which Git prints as
  `remote: API token budget: 600 requests per minute reached; retry in 12 s.`
- **MCP:** HTTP 200 with a JSON-RPC result `{"isError": true}` whose text is the
  message, so the agent sees a tool error, plus `Retry-After`.
- **Source API and the task JSON routes:** HTTP 429,
  `{"code": "resource_exhausted", "message": "…", "retryAfter": 12}`, with
  `Retry-After`.

**How it counts.** `cloudflare/forge/src/agent-budgets.mjs`. Each key (`token` or
`task`, and its id) has a fixed one-minute window that opens with its first request.
`Retry-After` is the number of seconds until that window closes. A refused request
counts against nothing.

The counters live in the Workspace Durable Object's memory, which every token
request already passes through. So there is no new binding and no D1 write per
request. Memory is bounded: a key idle for two minutes is dropped, and at most 10,000
keys are kept, dropping the least recently used.

**This is a throttle, not a quota.** A Workspace restart (a deploy, or eviction)
starts every window again, and a dropped key starts afresh. Counts are not kept
anywhere durable.

**Setting the budgets.** Operations administrators edit **Agent rate budgets** in
Admin → Installation (installation setting `agent-budgets`). The value has `enabled`
and the four limits, each a whole number from 1 to 100,000. It needs no migration.
- Narrowing saves at once.
- Raising a limit, or turning enforcement off, widens. That needs the typed setting
  name and an Access sign-in from the last 10 minutes.
- Every change is versioned and audited like other installation settings.
- With enforcement off, use is still counted and shown, but never refused.
- A locked installation (`policy_editing: false`) uses the defaults.
- The Workspace reads the setting at most once a minute (one indexed D1 read). A
  change saved through the admin page drops that cache, so it applies to the next
  request.

**Seeing use.** Settings → API tokens shows each active token's current window, for
example "41 of 600 requests · 3 of 60 writes", and marks a token that is at its
budget. The list route (`/native/api-tokens`, `list`) returns `usage` for each token
and the `budget` in force. Where no counter exists (a runtime other than the
Workspace), `budget` is `null` and the page says use is not counted.

## Security notes

- Secrets are never stored, logged or audited. Agent host logs redact `golf_pat_`
  values as they do other Golf credentials.
- A token can only narrow what its owner can do: scope × current grant × feature
  policy × the repository's branch rules.
- A token is a bearer credential. Anyone who holds it acts as you within its scope
  until it expires or you revoke it. Prefer short expiries, selected repositories,
  read-only tokens for reading agents, and an `agent/*` branch pattern for writing
  agents, so that changes land through pull requests.
- Revocation, expiry and account changes take effect on the next request. A write
  already admitted is still refused at its reservation.
- MCP internal requests carry only the caller's credential and a few request facts
  (user agent, client IP, Ray ID, colo and country) for the audit row, never an Access
  identity.

## What is not verified yet

- The AM-3 exit run is outstanding: Claude Code connected to the hosted `/mcp` with a
  branch-restricted token, reading files, committing to `agent/demo` and opening a
  pull request. So is the Access bypass policy on the hosted demo.
- The agent host task prompt does not mention the MCP endpoint yet (AM-3 item 4).
- Codex and OpenCode configuration snippets follow those tools' documented remote MCP
  settings, but they have not been run against Golf.
- Rate budgets (AM-6) are covered by local tests only (`agent-budgets.test.mjs` and
  the `agent-budgets.spec.ts` browser spec). They have not been run on the hosted
  demo, and the bench has not been re-run to measure them.
