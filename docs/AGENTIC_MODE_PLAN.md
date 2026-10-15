# Agentic mode: plan

Agreed with the owner on 2026-10-14. This plan makes the Cloudflare-native Golf fast
enough, and easy enough to reach, for many coding agents to work in one repository
at once. It replaces stages 2–5 of `docs/AGENT_WORKSPACE_PLAN.md`. That plan's
delivered first increment (the `/agents` view) and its constraints still apply.
It runs before phase 1b and phase 2 of `docs/AGENTS_AND_AUTOMATIONS_PLAN.md`,
because those phases build on its API and landing path.

Nothing here is complete until `docs/IMPLEMENTATION_STATUS.md` records it with
runnable evidence.

## Why

GitHub and GitLab were built for people pushing a few times an hour. Agents push,
read and land changes continuously. Two pieces of writing frame the problem:

- Anthropic, [Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control):
  - Treat source control as an API: the server commits, merges and answers
    history questions, and clients do not need a clone.
  - Moving a branch is a cheap compare-and-swap.
  - Do not use a global merge lock: land changes, then test after merge and
    before deploy.
  - Review rules know what kind of change they are looking at.
- Enroute, [Everyone is doing Git on S3 wrong](https://enroute.sh/blog/everyone-is-doing-git-on-s3-wrong):
  - Store Git on object storage, with only branch updates ordered.
  - Pushes to different branches never wait for each other.

Golf does not need to build storage: Cloudflare Artifacts already keeps Git on
Cloudflare's storage. The limits are in Golf's own control path.

## Where Golf stands (2026-10-14)

| Area | Today | Code |
| --- | --- | --- |
| Request admission | One `Workspace` Durable Object serves the whole deployment. Reads overlap, up to 8. Any request not on the read allowlist runs alone. That includes every clone, fetch and push to every repository. Over 128 queued requests get a 429 "Workspace is busy". | `core.mjs` `serialize`, `concurrentRead`; `worker.mjs` `Workspace.fetch` |
| Push fence | A push reserves the whole repository (`repositories.write_pending`). A second push to any branch of the same repository gets 409. Only one ref per push, up to 8 MiB. | `core.mjs` `git()` |
| Unknown push outcome | If the provider call fails or the ref reads back wrong, `write_pending` stays set. Nothing clears it automatically, so the repository stays locked. | `core.mjs` `git()` |
| Server-side writes | Only a pull request merge where the head already contains the base. It builds one commit and pack by hand. Squash, rebase and diverged branches are refused. | `pull-merge.mjs` |
| Reads without a clone | Files, trees, commits, diffs, comparisons, path history and semantic search. No blame, no exact text search, no multi-file read. | `core.mjs`, `repository-reads.mjs`, `repository-diff.mjs`, `search.mjs` |
| Machine access | People sign in through Cloudflare Access. Native Golf cannot issue API tokens. Git credentials are per repository, last at most an hour, and only work on `/git/`. Agent-host task tokens work only on the host routes. | `git-credentials.mjs`, `agent-host-protocol.mjs` |
| MCP | Only a local, read-only stdio server in the Go CLI (24 tools). The Worker has no MCP endpoint. | `docs/MCP_CONTRACT.md` |
| Review and landing | Branch rules can only lock a branch. Required approvals must be 0. CODEOWNERS only suggests reviewers. There is no merge queue or auto-merge. | `repository-rules.mjs`, `codeowners.mjs` |
| Agent work | The `/agents` view, agent hosts with assign-to-agent, and pull request agents running on Cloudflare. | `agent-hosts.mjs`, `agents.mjs` |

## Decisions (owner, 2026-10-14)

1. Agentic mode is a **per-repository setting**. It is off by default.
2. A change may land without a person only when:
   - the repository turned that on, which is off by default, and
   - the change touches only paths the repository marked low-risk, and
   - every required check passed.
   Paths marked sensitive always need a person. People review a summary of what the
   change is for and what it risks, and can approve a batch at once.
3. Golf stays Git. No custom protocol or storage engine. Clients that speak Git
   keep working unchanged.
4. Measure before and after each speed change, and record the numbers.

## Target

At least 100 agents working in one repository without the forge or the reviewers
becoming the bottleneck. The milestone exit criteria below make this concrete.
Anthropic's monorepo scale (30,000 merges a day, 25 million checkouts) is not the
target.

## Milestones

Each milestone ships as one or more pull requests, each with local tests. Hosted
evidence is recorded in `docs/IMPLEMENTATION_STATUS.md`.

### AM-0 Measure

**Status (2026-10-14): done.** #75 (bench), #97 (hosted evidence for AM-0 to AM-3).

A load tool that runs the same scenarios against the hosted demo or a local
`wrangler dev`.

- `scripts/agent_speed_bench.mjs`, using Node's built-in `fetch` and the system `git`.
  Hosted credentials come only from environment variables (Access service token
  and Git or API token). They are never written to output or evidence.
- Scenarios, each at concurrency 1, 4, 16 and 64:
  - **S1** one repository, one branch: fast-forward pushes that race (contention).
  - **S2** one repository, a branch per pusher.
  - **S3** a repository per pusher.
  - **S4** clones and fetches of a small repository during S2.
  - **S5** API reads (`GetContents`, `ListCommits`, compare) during S2.
  - **S6** server-side commits through the Source API (after AM-2), with a branch
    per writer and with all writers on one branch.
- Records per scenario:
  - successes per second;
  - p50, p95 and p99 latency;
  - counts of each status code (200, 409, 413, 429, 503);
  - the release header of each response.
- Writes JSON to `docs/compatibility/evidence/agent-speed-<date>-<label>.json`.
- **Exit:** a baseline for S1–S5 on hosted is checked in.

#### Running the bench

The bench uses repositories you create first. It never creates or deletes
repositories. It pushes only to branches under `bench/<run id>/` and deletes them at
the end; the evidence file reports any it could not delete.

```sh
export GOLF_BENCH_ORIGIN=https://demo.gitgolf.mjtechguy.com
export GOLF_BENCH_REPOS=owner/bench-a,owner/bench-b   # small, pre-existing repositories
export GOLF_BENCH_GIT_TOKEN=...      # golf_git_ credential (Basic user "golf"), or
export GOLF_BENCH_GIT_TOKENS='owner/bench-a=...,owner/bench-b=...'   # one per repository
export GOLF_BENCH_API_TOKEN=...      # golf_pat_ (Bearer): S5 reads, S6, and Git if no Git token
export GOLF_BENCH_ACCESS_ID=... GOLF_BENCH_ACCESS_SECRET=...   # optional Access service token
node scripts/agent_speed_bench.mjs --dry-run --scenarios S1,S2,S3,S4,S5 --concurrency 1,4,16,64
node scripts/agent_speed_bench.mjs --scenarios S1,S2,S3,S4,S5 --concurrency 1,4,16,64 \
  --duration 30 --label baseline   # or --out path
```

- `--dry-run` checks the environment and prints the plan without network calls.
- Git receives the headers through `GIT_CONFIG_*` environment variables, so
  credentials never appear in process arguments, output or evidence.
- Latency is per attempt of the network operation (push, clone, `ls-remote`, RPC or
  Source API call). Local commit plumbing is reported separately as `localGitMs`.
- S5 reports `skipped: no read identity` if the RPC answers 401 or 403. S6 reports
  `unavailable` without an API token, or if `/native/source/commit` answers 404.
- Local check, with no deployment needed:
  `node --test scripts/agent_speed_bench.test.mjs`. It serves bare repositories
  through `git http-backend` with fake RPC and Source API endpoints.

### AM-1 Concurrent Git traffic

**Status (2026-10-14): done, hosted-verified.** #77, #82 (provider retry), #88 (branch-only fence for unknown outcomes, schema 40). Exit met: S2/S3 at 16 succeed without 409/429 (48/48, 2.19 writes/s across repositories against 0.38 before). The `RepositoryWrites` split (item 5) is still conditional; the deployment tops out near 2 writes/s.

1. **Admission classes** (`core.mjs` `serialize`):
   - **read:** overlaps.
   - **transfer:** clone, fetch and push. Overlaps with reads and with other
     transfers.
   - **exclusive:** everything else.

   An exclusive request still waits for every running request to finish and
   blocks later admissions. A revocation or settings change never overlaps a push,
   as today. Limits:
   - up to 8 reads at once;
   - up to 24 transfers at once;
   - a queue of up to 512.
   - Clone and fetch (`info/refs`, `git-upload-pack`) become transfers. They need no
     write fence.
2. **Branch-level push fence** (migration `0037`):
   - Add a unique partial index on `git_operations(repository_id, ref)` for rows
     still `DISPATCHED` and unsettled. Two pushes to the same branch conflict, and
     pushes to different branches proceed.
   - A plain push no longer sets `repositories.write_pending` while it is in flight.
     It still refuses to start while `write_pending` is set, because a merge or an
     unknown outcome holds the whole repository.
   - If a push's outcome is unknown (the provider failed, or the ref reads back
     wrong), only its branch stays fenced. A `git_ref_unknown` row (schema 40)
     keeps rule, settings and merge changes waiting until maintenance settles it;
     pushes to other branches proceed. *(Changed 2026-10-14 after hosted
     measurements; it first set `write_pending`.)*
   - Before giving up, Golf resends the same compare-and-swap while the ref still
     reads back as the old commit: 5 attempts over about 3 seconds.
   - A push Golf refuses (a busy branch, a merge in progress, an unknown outcome)
     is answered in Git's own report: `! [remote rejected] <ref> (<reason>)`.
   - Pull request merges keep reserving the whole repository.
   - One helper, `reserveRefWrite` / `finishRefWrite`, is shared by:
     - plain pushes,
     - the Source API,
     - agent-host task pushes.
3. **Settling unknown outcomes:**
   - Add a column `git_operations.outcome` (`NULL` or `NOT_APPLIED`).
   - The maintenance sweep picks up `DISPATCHED` rows older than 2 minutes that are
     not part of a pull request merge, and reads the ref:
     - If the ref equals `new_sha`: the row becomes `APPLIED`, and a pipeline push
       intake is recorded once.
     - Otherwise: `outcome='NOT_APPLIED'`.
     - Either way, `write_pending` is cleared if it holds this operation.
   - Each settlement is audited.
4. **Exit:**
   - S2 and S3 at concurrency 16 succeed with no 409 or 429, and with at least 4×
     the baseline throughput.
   - S4 latency stays within 2× the idle number while S2 runs.
   - Existing push, merge and rule tests pass.
5. **Then, only if AM-1 numbers show the single Workspace object's CPU is the
   limit:** move transfers into a per-repository `RepositoryWrites` Durable Object.
   - The D1 fence and grant/version checks stay authoritative.
   - Revocations bump the version that each reservation re-checks.
   - This is a separate design note before any code.

### AM-2 Source API: change code without a clone

**Status (2026-10-14): done, hosted-verified.** #74 (object writer, tree merge), #79 (routes, schema 38). S6: a branch per writer 48/48 at 16; many writers merging onto one shared branch mostly run out of their 3 attempts (13/63) — AM-4 landing is the answer there.

A JSON API for agents and tools, in a new `source-api.mjs`, backed by a Git object
writer in a new `git-objects.mjs`.

1. **`git-objects.mjs`:**
   - Encodes blobs, trees and commits exactly as Git does.
   - Builds a pack of many undeltified objects. This generalizes `pull-merge.mjs`
     `commitPack`, and the merge code moves onto the shared writer.
   - Plans tree edits: reads only the directories on changed paths, rewrites them
     and keeps every other tree hash.
2. **`tree-merge.mjs`:** three-way merge of trees by path.
   - When only one side changed a path, take that side.
   - Identical changes on both sides are taken once.
   - Different changes to the same path are a conflict. The conflicting paths are
     listed.
   - Mode changes and deletes follow the same rule.
   - Merging text line by line (diff3) came later (AM-6, done 2026-10-15). The first version did
     not attempt it.
3. **Routes** (`POST /native/source/<action>`, JSON):
   - **`commit`:**
     - Request: `repository`, `branch`, `expectedHead` (a SHA, or empty plus `base`
       to create the branch), `message` and `changes[]`.
     - A change is `{path, content}` (UTF-8) or `{path, contentBase64}`, with
       optional `mode` (`file`, `executable` or `symlink`). Delete with
       `{path, delete: true}`; move with `{path, from}`.
     - Also `onStale` (`fail` or `merge`, default `fail`) and `idempotencyKey`.
     - Response: `commitId`, `treeId`, `previousHead`, `merged` (true when it was
       rebased onto a newer head).
     - When the head moved: with `onStale: merge`, Golf three-way merges this change
       onto the current head and commits with the current head as parent. If paths
       overlap it returns 409 with the conflicting paths. With `fail` it returns 409
       with the current head.
     - Branch rules, the same fence and pipeline intake apply as for a push.
   - **`branch`:** create a branch from a commit, or delete it, with an expected head.
   - **`files`:** read up to 100 files at one commit in one call, at most 4 MiB in
     total. Each file returns content or a reason it was skipped (too large,
     binary, missing).
   - **`tree`:** a recursive listing of a commit, up to 10,000 entries, with
     truncation shown.
4. **Limits:**
   - up to 500 changes, 8 MiB of content in total and 4 MiB per file;
   - paths go through `literalPath`;
   - no `.git` path segment;
   - author name and email come from the caller's account. Agent-task commits
     use the agent identity plus the `Golf-Agent-Task:` trailer.
   - Every limit refusal names the limit.
5. **Callers:**
   - a signed-in person (browser);
   - an API token (AM-3);
   - an agent-host task token, limited to its own task branch.
6. **Exit:**
   - Runtime check against real `git receive-pack`, with the
     `merge-runtime-check.mjs` fixture. Commits from the API must equal what `git`
     writes for the same changes: the same tree hash for the same files.
   - An `onStale: merge` race with disjoint paths succeeds, and one with
     overlapping paths returns the conflict list.
   - S6 numbers recorded.

### AM-3 Agent access: API tokens and remote MCP

**Status (2026-10-14): done, hosted-verified.** #83, #86 (schema 39). Exit met: Claude Code via hosted `/mcp` with an `agent/*` token opened PR #4 in `mj/actions-demo`; a commit to `main` was refused. The agent host prompt does not mention MCP yet.

1. **API tokens** (migration `0037` or `0038`, table `api_tokens`):
   - Prefix `golf_pat_`; only the SHA-256 is stored.
   - Fields: owner user, label, expiry (1 hour to 90 days), last used.
   - **Scope:**
     - repositories: a list, or "all I can access";
     - permission: `read` or `write`;
     - optional write branch pattern, for example `agent/*` (exact or trailing `*`).
   - Bound to the identity version, so changing account access revokes them,
     like Git credentials.
   - Up to 50 active tokens per user.
   - The token's permission is capped by the user's current grant on every call.
   - Accepted on:
     - `/native/source/*`;
     - `/mcp`;
     - `/git/*`, so agents need no separate Git credential.
   - Never on browser-only or account routes.
   - Settings → Developer → API tokens: shows the current tokens first. "New
     token" opens a form, and the secret is shown once.
   - Every create, use-denied and revoke is audited.
2. **Machine routes outside Access:**
   - `/mcp` and `/native/source/*` with a `golf_pat_` or agent task bearer are
     added to the Worker's machine-route list.
   - A request with no bearer goes through Access as today.
   - Cookies and the Access email header are ignored on bearer requests.
3. **Remote MCP** (`POST /mcp`, Streamable HTTP, stateless JSON responses):
   - Methods: `initialize`, `ping`, `tools/list`, `tools/call`.
   - Tools call the same handlers as the UI with the caller's authority.
   - **Read tools:**
     - `repo_overview`, `list_tree`, `read_files`, `search_code` (semantic,
       labeled as such), `list_commits`, `compare`;
     - `get_issue`, `list_issues`, `get_pull_request`, `pull_request_diff`;
     - `pipeline_status`.
   - **Write tools**, only with a write token or task:
     - `commit_changes` (Source API `commit`), `create_branch`;
     - `open_pull_request`;
     - `comment` on an issue or pull request.
   - Each tool result has a size cap and a "truncated" flag.
   - Errors are MCP tool errors carrying Golf's own message.
   - The docs page gives a `claude mcp add --transport http golf <url> --header "Authorization: Bearer …"`
     example and the equivalents for Codex and OpenCode.
4. **Agent hosts:** the task prompt tells the CLI about the MCP endpoint and a task
   token. The host keeps its Git push path; using the API is optional for the CLI.
5. **Exit:**
   - Claude Code, connected to hosted `/mcp` with a branch-restricted token,
     reads files, commits to `agent/demo` and opens a pull request.
   - A token cannot write outside its pattern or repositories.
   - Revoking a token stops access within one request.

### AM-4 Landing at agent speed

**Status (2026-10-15): done, hosted-verified.** Exit met on `mj/agent-bench-3`: ten concurrent lands all landed after #103; a sensitive `.github/` change waits for a person; a policy-landed change whose required check then failed was reverted automatically with an issue (see `docs/IMPLEMENTATION_STATUS.md`). #94 (diverged merge and squash, hosted-verified: merge commit tree equals `git merge-tree`), #96 (setting and policy, schema 41), #100 (land queue, landing without a person, revert on failure, schema 42).

1. **Better merges** (`pull-merge.mjs` on `tree-merge.mjs`):
   - Merge diverged branches with a real three-way tree merge.
   - Squash: a single parent, with the tree from the merge.
   - Conflicts are listed by path.
   - These lift the `base_not_ancestor` and `squash_unsupported` refusals.
2. **Agentic mode setting** (feature `agentic-mode` under the existing feature
   policy hierarchy; repository settings page):
   - `enabled`, off by default.
   - `lowRiskPaths`: globs, for example `docs/**`, `**/*.md`, `**/*_test.go`,
     `**/*.test.*`.
   - `sensitivePaths`: globs, for example `.github/**`, `deploy/**`, `**/auth/**`,
     `CODEOWNERS`.
   - `landWithoutPerson`: off by default. Allowed only for changes whose paths all
     match `lowRiskPaths`.
   - `requiredChecks`: names of pipeline checks that must pass before landing. An
     empty list means "the repository's pipelines for that commit".
   - `revertOnFailure`: on by default. Revert a landed change automatically if the
     same checks fail on the base branch after it lands.
3. **Policy evaluation** (`land-policy.mjs`, a pure function with tests): it takes
   changed paths, author kind (person or agent), check states and review states, and
   returns one of:
   - `land`: may land now;
   - `needs_person`: lists the reason;
   - `waiting_checks`;
   - `blocked`: lists the reason.
   Sensitive paths always need approval from a writer who is not the author and
   not an agent.
4. **Land queue without a global lock:**
   - "Land" on a pull request or agent proposal merges onto the current base head
     with `tree-merge`.
   - The base update is a compare-and-swap. If it is stale, Golf retries up to 5
     times against the new head.
   - Overlapping paths go to `needs_rebase`. For an agent task, a follow-up task to
     resolve the conflict is offered.
   - Different branches never wait on each other.
5. **Checks after landing:**
   - The base push starts pipelines as usual.
   - If a required check fails on a landed agent change and `revertOnFailure` is
     on, Golf commits a revert through the Source API, comments on the pull
     request, and raises an issue assigned to the original requester.
6. **Exit:**
   - Local runtime checks for diverged merge, squash and conflicts.
   - Hosted:
     - ten agent proposals touching different files land concurrently without a
       person while `landWithoutPerson` and low-risk paths are on;
     - a change touching a sensitive path waits for a person;
     - a deliberately failing change is reverted automatically.

### AM-5 Agentic inbox and intent summaries

**Status (2026-10-15): first slice done, hosted walkthrough recorded.** #101 (inbox, AI intent summaries, schema 43); on hosted the inbox sorted a sensitive PR into Needs a person and listed 16 landings with the policy revert, and an AI intent summary was generated and shown marked AI-written. Not yet: revert action in the inbox, batch approval, hiding agent branches, all-layout browser coverage.

1. Repository page `/:owner/:repo/agents` becomes the inbox. It is linked from the
   repository navigation when agentic mode is on. Sections, each in the shared
   DataTable:
   - **In progress:** running agent tasks.
   - **Ready to land:** policy says `land` or `waiting_checks`.
   - **Needs a person:** sensitive paths, conflicts or failed checks.
   - **Landed:** recent, with revert.
   - Batch approve and land selected items.
   - Live updates come from the existing repository activity stream.
2. **Intent and risk summary:**
   - Workers AI, through the existing model selection, writes for each agent pull
     request:
     - what the change is for;
     - which areas it touches;
     - which risks it may have.
   - The summary is stored with the pull request revision and marked as AI
     written. It is regenerated on a new head. It never replaces the diff.
3. **Agent branches:**
   - `golf-agent/*` and token-pattern branches are hidden from the default branch
     list, with a "Show agent branches" toggle.
   - They are deleted automatically after landing or closing.
4. **Exit:** the browser spec covers the inbox in all 9 layouts, and the hosted
   walkthrough is recorded.

### AM-6 Budgets and later work

**Status (2026-10-15): line-level merge done locally, not hosted-verified.**
- `text-merge.mjs` matches `git merge-file` on more than 700 cases.
- `tree-merge.mjs` uses it in every three-way merge (see "Line-level merges" in
  `docs/AGENTIC_MODE.md`).
- The rest of AM-6 is open. So is re-measuring S6 shared-branch commits with
  line-level merges.

- **Rate budgets** for each API token and agent task: requests and pushes per
  minute.
  - They use the Workers Rate Limiting binding that already throttles anonymous
    reads.
  - A 429 names the budget.
  - Administrators set defaults in installation policy.
- **Line-level three-way merge (diff3)** for text files in `tree-merge.mjs`.
- **Blame and exact text search** as Source API reads.
- **Push size:** stream receive-pack bodies above 8 MiB, if the `RepositoryWrites`
  split happens.
- **Re-measure everything.** Update the Cloudflare speed qualification.

## Order and parallel work

1. AM-0 and AM-1 together.
   - The bench tool is a new file; AM-1 changes `core.mjs`, `worker.mjs` and a
     migration.
   - The pure `git-objects.mjs` and `tree-merge.mjs` from AM-2 can be built at the
     same time; they touch no existing file.
2. Wire AM-2 routes after AM-1's shared fence helper lands.
3. AM-3 after AM-2.
4. AM-4 and AM-5 after AM-3. AM-4's merge work can start once `tree-merge.mjs`
   lands.
5. AM-6 last, guided by numbers.

## Constraints

- Authorization stays explicit. Every write rechecks the caller's current grant,
  identity version and token scope in the same D1 statement that reserves the write.
- Tokens, Access secrets and Git credentials never appear in repository files, logs,
  evidence or pull requests.
- No repository CI workflows. Checks run locally and their results are recorded.
- Capabilities report honestly. A refused or unavailable feature says why, and
  nothing reports success for work that did not happen.
- UI follows the settings rules in `AGENTS.md`: inventory first, explicit
  Add/New/Edit, TanStack Form, the shared DataTable, and global `styles.css`.
