# Agentic mode

Agentic mode is a per-repository setting on the Cloudflare-native runtime. It decides
when a pull request may land without a person. It implements AM-4 items 2 to 5 of
`docs/AGENTIC_MODE_PLAN.md`. Schema 41 adds the setting (migration
`0041_agentic_mode.sql`); schema 42 adds landing (migration `0042_land_operations.sql`).

Golf **evaluates** pull requests against the policy and shows the result. Writers the
policy allows can **land** a pull request. With **Land without a person** on, Golf lands
low-risk changes on its own once their required checks pass. When the required checks
of a change Golf landed then fail on the base branch, Golf **reverts** it. See
[Landing](#landing-schema-42).

## The setting

Repository administrators change it in **Settings → Agentic mode**. The page shows the
current values first; **Edit agentic mode** opens the form.

| Field | Default (no saved row) | Meaning |
| --- | --- | --- |
| `enabled` | off | Evaluate pull requests against this policy. While off, every pull request needs a person. |
| `lowRiskPaths` | `docs/**`, `**/*.md` | Patterns for low-risk paths. |
| `sensitivePaths` | `.github/**`, `.forgejo/**`, `.gitlab-ci.yml`, `deploy/**`, `**/CODEOWNERS` | Patterns for sensitive paths. These always need approval by a writer who is not the author and not an agent. |
| `landWithoutPerson` | off | A change may land without a reviewer only if every changed path is low-risk and every required check passed. |
| `requiredChecks` | `[]` | Names of checks that must pass. Empty means every pipeline that ran on the head commit. |
| `revertOnFailure` | on | Revert a change Golf landed on its own when its required checks fail on the base branch. People's landings are only commented on. |

Limits:
- at most 50 patterns in each list, each up to 200 characters;
- at most 50 required checks, each up to 100 characters.

Duplicates are refused. Every change needs the version it read (compare-and-swap).

### Feature policy

The `agentic-mode` feature ("Agentic mode", Automation) sits in the admin → organization →
repository feature policy hierarchy and requires `pull-requests`.

- **Allowed** (the default): each repository's own setting applies. It is off until
  an administrator turns it on.
- **Off**: agentic mode is off for every repository in scope. Saved settings are
  kept, and turning it on is refused with the policy's reason.
- **Required** is refused, as for public repositories. A policy cannot turn agentic
  mode on for a repository.

On the admin Features page, the repository count is the number of repositories that
turned agentic mode on.

## Path patterns

Patterns are matched by a small anchored matcher in `land-policy.mjs`. It never builds
a regular expression.

- Each pattern is a `/`-separated path from the repository root. It has no leading or
  trailing slash, no empty, `.` or `..` segment, and no backslash or control character.
- `*` matches any run of characters within one segment, including an empty run and a
  leading dot.
- `?` matches exactly one character within one segment.
- A whole segment `**` matches zero or more segments. `docs/**` matches `docs` and
  everything under it. `**/CODEOWNERS` matches at any depth, including the root.
- Everything else is literal and case-sensitive: `.`, `[`, `{`, `(`, `+`, `|` and so on.
- A pattern without `**` matches only at the root. `CODEOWNERS` does not match
  `.github/CODEOWNERS`.

## Policy evaluation (`land-policy.mjs`)

`evaluateLanding({ settings, changedPaths, authorKind, checks, reviews, draft, mergeable })`
is a pure function. It returns `{ decision, reasons, risk, matched }`:
- `decision` is one of `land`, `needs_person`, `waiting_checks` or `blocked`;
- `risk` is `sensitive` if any path matches a sensitive pattern, `low` if every path
  (at least one) matches a low-risk pattern, and `normal` otherwise;
- `matched` lists the paths that matched each kind.

Inputs:
- **Checks:** `success`, `neutral` and `skipped` pass. `failure`, `error`, `cancelled`,
  `timed_out`, `refused` and `action_required` fail. Anything else is pending.
  - Several checks with one name combine: any failure fails, then any pending waits.
  - With `requiredChecks` empty, the required checks are those of kind `pipeline`.
  - A named check that has not reported is missing, which counts as pending.
- **Reviews:** only writers' reviews count.
  - A qualifying approval is `APPROVED` from a writer who is not the author and not an
    agent.
  - Any writer's `CHANGES_REQUESTED` is outstanding and cancels approvals.

Rules, in order:
1. Not enabled (by the setting or by policy): `needs_person`, reason `agentic mode off`.
2. A required check failed, or `mergeable.ok === false`: `blocked`. Every such reason
   is listed.
3. A person is needed, and every reason is listed, followed by any pending checks:
   - the pull request is a draft;
   - a writer requested changes;
   - sensitive paths have no qualifying approval;
   - there is no qualifying approval, and the change is not low-risk with
     `landWithoutPerson` on.
4. A required check is pending or missing, or a landing without a person has no
   reported check at all: `waiting_checks`.
5. Otherwise: `land`.

Truth table for an enabled repository with a mergeable, non-draft pull request (all
of these are in `land-policy.test.mjs`):

| Risk | Land without a person | Checks | Reviews | Decision |
| --- | --- | --- | --- | --- |
| low | on | all pass | none | land |
| low | on | pending, missing or none reported | none | waiting_checks |
| low | on | a failure | any | blocked |
| low | off | all pass | none | needs_person |
| low | off | all pass, or none reported | qualifying approval | land |
| low | any | pending | qualifying approval | waiting_checks |
| low | on | all pass | changes requested | needs_person |
| normal | any | all pass | none, author's, agent's or a reader's approval | needs_person |
| normal | any | all pass | qualifying approval | land |
| normal | any | pending | none | needs_person (pending checks listed) |
| sensitive | any | all pass | none, author's or agent's approval | needs_person |
| sensitive | any | all pass | qualifying approval | land |
| sensitive | any | all pass | qualifying approval and changes requested | needs_person |
| sensitive | any | pending | qualifying approval | waiting_checks |
| any | any | a failure | any | blocked |

`authorKind` (`person` or `agent`) is reported in the reasons. It never lowers the bar:
approvals from the author or from an agent never count.

## How the evaluation gathers its inputs (`agentic-mode.mjs`)

- **Changed paths:**
  - read the base and head branch tips;
  - take their merge base (`repository-diff.mjs` `comparison`);
  - compare the merge base tree with the head tree (`tree-merge.mjs` `changedPaths`).
- **Checks of the head commit:**
  - the latest pipeline run for each workflow and event, of kind `pipeline` and named
    by the workflow name;
  - its current jobs, of kind `job` and named `workflow / job` (a failing job with
    `allow_failure` is neutral);
  - the latest reported check for each context, of kind `reported`.
- **Reviews:**
  - the latest published, undismissed, non-comment review of each reviewer;
  - an approval counts only for the current head commit;
  - writer status is the reviewer's current grant;
  - no review is an agent's, because API tokens and agent hosts cannot reach
    `CreatePullRequestReview`.
- **Author kind:** `agent` when `pull_request_origins.kind` is `api-token` or
  `agent-task`, `person` otherwise. Pull requests opened before schema 41 have no row
  and read as `person`.
- **Merge observation:**
  - the existing native merge blocker (`pull-merge.mjs` `mergeBlocker`) and the base
    branch lock;
  - a draft is left to the policy;
  - until AM-4 item 1 lands, a diverged branch reports `base_not_ancestor` and is
    `blocked`.

## Pull request origins

`CreatePullRequest` records how a pull request was opened in `pull_request_origins`,
in the same D1 batch and under the same admission guard:

- `agent-task`: the request carries `agentTaskId`. Golf checks that it names a
  `SUCCEEDED` agent task of this repository whose proposal branch is `headBranch`.
  Otherwise the request is refused (412; 400 for a malformed ID). The agent task
  panel's **Open pull request** sends it.
- `api-token`: the caller used a `golf_pat_` token, for example through the MCP
  `open_pull_request` tool. `api_token_id` is kept.
- `person`: every other caller.

Before schema 41 nothing is recorded, and `agentTaskId` is ignored.

## API

Both routes need a signed-in browser session: the Access email header, `Origin`
equal to the public origin, and no `Authorization` or service-token headers. Golf
refuses other callers with 403; an API token gets 401.

Each request names `repository: { owner, name }` and `repositoryId`. A caller without
access, or a public visitor, gets 404. Before schema 41 every action returns 412.

`POST /native/agentic-mode/read` serves reads, which overlap other requests:

- `{ action: 'get' }` (any reader) returns:

  ```text
  { repositoryId, settings: { enabled, lowRiskPaths, sensitivePaths, landWithoutPerson, requiredChecks,
    revertOnFailure, version, updatedBy, updatedAt }, feature: { allowed, reason, decidedBy }, canEdit, limits }
  ```

  `version` is 0 when no row is saved; the defaults are returned then.

- `{ action: 'evaluate', number }` (any reader) needs pull requests on for the
  repository. It returns:

  ```text
  { repositoryId, number, pullRequestId, baseCommitId, headCommitId, mergeBaseCommitId, enabled,
    origin, evaluation: { decision, reasons, risk, matched }, changedPathCount,
    checks: [{ name, kind, state }], mergeable: { ok, reason }, evaluatedAt }
  ```

  It refuses with 404 for an unknown number or an issue, and with 412 for a closed or
  merged pull request or a deleted branch.

`POST /native/agentic-mode` is exclusive and serves `{ action: 'set', expectedVersion,
enabled, lowRiskPaths, sensitivePaths, landWithoutPerson, requiredChecks,
revertOnFailure }`:
- Every field is required, and unknown fields are refused (400).
- Only a current repository administrator may call it (403 otherwise).
- It returns 412 in three cases:
  - turning agentic mode on while a policy turned it off;
  - a stale `expectedVersion`;
  - a grant or identity change between the read and the write. The write rechecks
    them in the same statement.
- It returns the same shape as `get`.

Capability `repository.agentic-mode` is READY at schema ≥ 41.

## Audit

A successful `set` is recorded at repository scope as `agentic_mode.update`, in the
"Agentic mode" category. The row holds:
- before: the stored setting, or `null` when no row was saved;
- after: the saved values.

Denied attempts are recorded as denied. Validation and stale-version refusals,
reads and evaluations are not recorded.

## UI

- **Settings → Agentic mode** (Automation group). It shows the current values, then
  the path rules in the shared DataTable; all rules are loaded, and search and sort
  cover that list.
  - **Edit agentic mode** opens a TanStack Form. The paths and checks are one per line.
  - Turning on **Land without a person** shows a warning about broad low-risk patterns.
  - **Recent landings** (schema 42): up to the 50 most recently updated land operations
    in the shared DataTable (pull request, state, who landed it, outcome, last update).
    An older landing reverted or retried later is brought forward; the
    `(repository_id, updated_at, id)` index (schema 55) covers the order. The page says how
    many were loaded and, only when older ones exist, that they are omitted and that
    search and sorting cover only the loaded ones.
- **Pull request sidebar → Landing.** It is shown while agentic mode is on for the
  repository. For an open pull request it lists:
  - the decision, the risk and the reasons;
  - the matched sensitive paths;
  - the number of changed paths and how the pull request was opened;
  - whether low-risk changes land on their own.

  When the caller may land it (`canLand` in the evaluation, capability
  `repository.agentic-landing`), it shows **Land**. Land opens a TanStack Form
  confirmation with **Merge** or **Squash**. Each confirmation sends its own
  idempotency key. The panel also shows the latest land operation of the pull request,
  also after it was merged.

## Landing (schema 42)

`land-queue.mjs`. Capability `repository.agentic-landing` is READY at schema ≥ 42.

### What "land" does

- Landing is the **native merge** (`pull-merge.mjs` `standardPullMerge`), onto the base
  tip current at that moment. It uses the same journal (`pull_merge_operations`), merge
  plan (three-way tree merge for diverged branches), reservation, branch rules and
  readback as the Merge button. Golf has no second merge implementation.
- There is **no global merge lock**. Every land is its own operation in
  `land_operations`. `POST /native/land` is a transfer in the Workspace admission
  queue, like a push: lands of different pull requests run side by side with pushes,
  Source API commits and reads.
- Only the base update is ordered. A merge still reserves the whole repository for its
  few seconds (`repositories.write_pending`), as before.
- **Retries.** A land re-reads the pull request on every attempt. It retries when:
  - the base moved between its read and the merge (`pull_request_changed`);
  - another write holds the repository (`write_unresolved`, or the fence).

  It makes up to **5 attempts**. The waits between them are jittered: 200 ms first,
  doubling up to 2 s, each between half and all of its cap.
- **Other outcomes:**
  - The head moved after the land was requested: `BLOCKED`. The new head needs a new
    land.
  - The merge would conflict (lines or paths both sides changed differently; see
    "Line-level merges" below): `NEEDS_REBASE`.
    The conflicting paths (at most 50) and their count are in `detail`. For a pull
    request opened from an agent task (`pull_request_origins.kind = 'agent-task'`),
    Golf comments on the pull request. The comment names the paths and says a
    follow-up agent task can resolve them. Golf never starts that task itself.
  - Any other refusal of the merge path (a locked base branch, a draft, a branch that
    no longer exists): `BLOCKED`, with the reason.
  - After 5 attempts: `FAILED`.
  - The merge was sent but not confirmed: the land stays `LANDING`. Maintenance
    inspects the merge journal, which reads the branch back, and then records
    `LANDED`, `FAILED` or `NEEDS_REBASE`.
- **After landing,** the base push records a pipeline push intake once (key
  `push:<git operation>`), so push pipelines run on the landed commit. These are the
  checks after landing. A plain Merge button merge records none, as before.

### `land_operations`

| Column | Meaning |
| --- | --- |
| `id` | UUID |
| `repository_id`, `pull_request_id`, `number` | The pull request |
| `trigger` | `person` or `policy` |
| `actor_id` | The person; `0` for the policy |
| `state` | `QUEUED`, `LANDING`, `LANDED`, `NEEDS_REBASE`, `BLOCKED`, `FAILED` or `REVERTED` |
| `method` | `merge` or `squash` (the policy always merges) |
| `head_commit_id` | The head that was evaluated and landed |
| `base_commit_id` | The base tip it landed on |
| `landed_commit_id`, `revert_commit_id` | The merge commit and the revert commit |
| `attempts` | Merge attempts made |
| `detail` | JSON: `reasons`, `conflicts`, `conflictCount`, `merge` (the journal key), `postLand`, `revert`, `revertConflict`, `issue`, `commented` |
| `idempotency_key` | A person's request key (UUID v4), unique per account |
| `created_at`, `updated_at` | |

At most one `QUEUED` or `LANDING` row exists per pull request (a unique partial index).

### API

Both routes need a signed-in browser session, as for `/native/agentic-mode`. A caller
without access, or a public visitor, gets 404. Before schema 42 every action returns 412.

`POST /native/land`, transfer admission:

```text
{ action: 'land', repository: { owner, name }, repositoryId, number, headCommitId, method?, idempotencyKey? }
→ { operation: LandOperation, phase: 'LANDED' | 'LANDING' | 'LAND_REFUSED' }
```

- `headCommitId` is the head the caller reviewed. `expectedHeadCommitId` is accepted
  with the same meaning. A head that moved is refused with 412.
- `method` is `merge` (the default) or `squash`.
- `idempotencyKey` is a UUID v4. A replay with the same key returns the original
  operation and sends nothing. The same key with a different request gets 409.
- The caller needs a write or admin grant (403 otherwise).
- Agentic mode must be on and allowed by the feature policy (412 otherwise).
- The policy is evaluated first, as `evaluate` does. A person may land when:
  - the decision is `land`; or
  - the decision is `needs_person` and every reason is a missing qualifying approval,
    and the caller is not the pull request's author. The caller is then that approval.

  Anything else is refused with 412 and the policy's reasons:
  - `blocked` (a failed required check, a locked base);
  - `waiting_checks`, or pending checks listed with `needs_person`;
  - a draft;
  - changes requested;
  - the author landing their own change where approval is needed.

  A pull request blocked only by a merge conflict, which the policy would otherwise
  let land, is recorded as `NEEDS_REBASE` without a merge attempt.

`POST /native/land/read`, a read that overlaps other requests:

- `{ action: 'list', limit?, number? }` (`limit` 1 to 100, default 20) returns
  `{ repositoryId, operations, limit }`, newest first.
- `{ action: 'get', id }` returns `{ operation }`.

`LandOperation` is:

```text
{ id, repositoryId, pullRequestId, number, trigger, actorId, actor, state, method, headCommitId, baseCommitId,
  landedCommitId, revertCommitId, attempts, detail, createdAt, updatedAt }
```

`actor` is the login of the person; it is empty for the policy.

The `evaluate` read also returns `canLand`: whether this caller may land the pull
request now, by the rules above.

### Landing without a person

When agentic mode is on, **Land without a person** is on and the feature policy allows
agentic mode, Golf lands open, non-draft pull requests whose evaluation is `land`. Two
hooks evaluate them:
- **A finished pipeline run** (`pipelines.mjs` `advanceRunNow` →
  `env.pipelineFinished`, wired in the `PipelineRun` Durable Object). Golf evaluates
  the open pull requests whose head is that run's commit. The same hook decides the
  checks of landed changes at that commit (below).
- **Maintenance** (the `indexes` stage, beside the agent task sweep and push
  settlement). It evaluates at most 20 pull requests per sweep, across repositories,
  in an order that rotates every 5 minutes. It also settles interrupted lands and
  reverts, and checks recent landings.

Other rules:
- Each head is tried once. A head that ended `NEEDS_REBASE`, `BLOCKED` or `LANDED` waits
  for a new push. A `FAILED` attempt is retried after 10 minutes.
- **Accountable account.** Native Golf has no service account. The administrator who
  last saved the agentic mode setting (`updated_by`) is the account that:
  - the merge journal and the push journal name (`pull_merge_operations.actor_id`,
    `git_operations.user_id`);
  - authors Golf's comments and issues. Their text starts with "Golf agentic mode".

  `land_operations.actor_id` is `0` and `detail.principal` names that administrator.
- **The policy's authority** replaces the writer authority. It is checked in the same
  statement as each reservation:
  - that account still has an active write or admin grant;
  - its identity version is unchanged;
  - the setting is still on, at the version evaluated, with Land without a person on
    (Revert on failure on, for reverts).

  An administrator who loses write access, or any change to the setting, stops
  landing until it is saved again.
- **Commit identity.** Commits Golf writes on its own have author and committer
  `Golf (agentic mode) <agentic@golf.invalid>`, never a person.
- **Audit.** Each policy landing is recorded as `agentic_mode.auto_land` (actor 0,
  via `agentic-mode`).

### Checks after landing and automatic revert

For a `LANDED` operation, Golf evaluates the required checks of the **landed commit**
by the same rules as landing: the named `requiredChecks`, or every pipeline that ran
on that commit. It does this when a pipeline run on that commit finishes, and during
maintenance for 24 hours.

- **All passed:** `detail.postLand = { verdict: 'passed' }`.
- **No check reported after 6 hours:** `no_checks`.
- **A required check failed:** the first caller claims `detail.postLand` with a
  conditional update. So there is one verdict, and at most one revert, per land
  operation.
  - **Landed by a person,** or Revert on failure off: Golf only comments on the pull
    request with the failed checks.
  - **Landed by the policy,** with Revert on failure on: Golf reverts it.

How the revert works:
- It is a three-way merge onto the current base tip:
  `mergeTrees(landedTree, currentTipTree, landedFirstParentTree)`. This gives the tree
  that `git revert -m 1 <landed>` writes, also after later commits.
- It is committed through the Source API internals (`source-api.mjs` `commitTree`):
  - the same exact objects;
  - the branch fence (`git_ref_writes`);
  - the provider readback;
  - the push pipeline intake.

  The message is:

  ```text
  Revert "<title>" (#N)

  Automatic revert: required checks failed after landing: <names>.

  This reverts commit <landed>.
  ```

- A base that moves meanwhile is retried up to 3 times.
- Branch rules apply: a locked base branch is not reverted.

Then:
- **Reverted:** the state becomes `REVERTED`, with `revert_commit_id`. Golf comments
  on the pull request and opens an issue titled **"Automatic revert of #N: checks
  failed"**.
  - The issue mentions the original requester: the requester of the agent task that
    opened the pull request, else its author.
  - It is assigned to them when the accountable account is an administrator, as
    assignment needs.
  - The issue's number and assignee are kept in `detail.issue`.
- **Conflicts:** later commits changed the same lines (or the same non-text paths). The land stays `LANDED`, with
  `detail.revertConflict` (the paths) and `detail.revert.state = 'conflict'`. Golf
  comments and opens the same issue, which lists the paths, instead.
- **Refused** (a locked branch, lost authority, a base that kept moving): the land stays
  `LANDED` with the reason, and the comment and issue say so.
- **Not confirmed:** `detail.revert.state = 'unknown'`. The branch fence is settled by
  `settleRefWrites`, then maintenance reports the revert as applied or not.
- **Audit:** each revert outcome is recorded as `agentic_mode.revert` (actor 0).
  People's lands are recorded as `agentic_mode.land` (key: the idempotency key).

### Limits and what is not done

- The policy always lands with a merge commit.
- A land of a pull request whose evaluation is `waiting_checks` is refused. A person
  cannot queue it to land later; landing without a person does that for low-risk
  changes.
- Merges still reserve the whole repository briefly. Lands of different pull requests
  overlap everywhere except that moment, and they retry it.
- Text files merge line by line (AM-6, below). Lines or paths both sides changed
  differently are still a conflict, and Golf never writes conflict markers.
- Golf never starts the follow-up agent task for a conflict.
- Comments and issues are recorded under the accountable administrator, because native
  Golf has no service account.
- No hosted evidence yet. The AM-4 exit criteria (ten concurrent agent landings, a
  sensitive change waiting, a failing change reverted on the hosted demo) are still
  open.

## Inbox and intent summaries

AM-5 of `docs/AGENTIC_MODE_PLAN.md`, first slice. Schema 43 adds `pull_intent_summaries`
(migration `0043_intent_summaries.sql`). Capability `repository.agent-inbox` is READY at
schema ≥ 43; its reason says whether intent summaries can run (Workers AI allocated).

### The inbox (`agent-inbox.mjs`)

`POST /native/agent-inbox/read` with `{ action: 'inbox', limit? }` (any reader; reads overlap)
returns, for the repository:

```text
{ repositoryId, enabled, feature, generatedAt, limit,
  inProgress: [{ id, state, tool, model, host, requestedBy, target: { kind, number, title }, branch, createdAt, startedAt }],
  readyToLand: [Item], needsPerson: [Item],
  landed: [{ id, pullRequestId, number, title, trigger, actor, state, method, headCommitId, landedCommitId, revertCommitId, createdAt, updatedAt }],
  landingHistory: 'available' | 'unavailable',
  pulls: { state: 'evaluated' | 'agentic_mode_off' | 'pull_requests_off', reason, open, evaluated, evaluateLimit: 25 },
  truncated: { inProgress, pulls, landed }, summaries: { available, reason } }
Item = { number, title, author, pullRequestId, origin, headCommitId, baseCommitId, decision, risk, reasons, sensitivePaths,
  conflicts: [{ path, reason }], mergeable, changedPathCount, checks: { passed, pending, failed }, intent: Summary | null,
  landing: { state, updatedAt } | null }
```

- `limit` (1–100, default 50) bounds the rows of **In progress** and **Landed**.
- **In progress:** this repository's agent tasks in `QUEUED`, `CLAIMED` or `RUNNING`, newest first.
- **Open pull requests** are evaluated only while agentic mode is on (setting and policy)
  and pull requests are on. At most `min(limit, 25)` are evaluated per read, newest
  (highest number) first, with the same `evaluate` as `/native/agentic-mode/read`, under
  one artifact handle. `pulls.open` counts every open pull request and
  `truncated.pulls` says when older ones were not evaluated.
  - **Ready to land:** decision `land` or `waiting_checks`.
  - **Needs a person:** `needs_person` or `blocked` with their reasons, the matched
    sensitive paths and the merge conflicts. A pull request whose evaluation is
    refused (for example a deleted branch) is listed with decision `unavailable` and
    the refusal as its reason.
- **Landed:** recent `LANDED` and `REVERTED` rows of `land_operations`, the land
  queue's table (AM-4 item 4, another migration). The inbox reads it only when
  `PRAGMA table_info(land_operations)` shows the columns it selects. Otherwise
  `landed` is empty and `landingHistory` is `unavailable`. With the table, each open
  item also carries its latest land operation's state.
- An intent summary is attached only when one is stored for the item's current head.

### Intent summaries (`ai-intent.mjs`)

An intent summary is a Workers AI run of kind `intent-summary` through the existing
AI runs (`ai-workflow.mjs`): the same admission, daily and per-person limits, private
gateway, model check before inference, and usage recorded on the run (it shows in AI
usage as "Intent summaries"). It runs under the **AI review drafts** feature and the
model chosen for the `review-drafts` use ("Summaries and review drafts").

- **Input:** the current base and head of an open pull request. Whole files of its diff,
  in diff order, up to 48 KiB of annotated text; the other files are named as not
  read. The title and the first 4 KiB of the description. No review comments. All of
  it is marked as untrusted data. When no changed text file fits in 48 KiB, the run is
  refused at prepare ("nothing was billed").
- **Output:** strict JSON with exactly `intent` (≤ 600 characters), `areas` (≤ 8, each
  ≤ 80), `risks` (≤ 8, each ≤ 300) and `confidence` (`high`, `medium` or `low`). Plain
  text without control characters. Anything else fails validation whole: the run ends
  `UNKNOWN` and nothing is stored.
- **Storage:** when the run settles `SUCCEEDED`, the workspace inserts one row per
  `(pull_request_id, head_commit_id)` with the model id. A row is never replaced: a
  head that has one is refused at admission, and a new head commit gets its own row.
  `summary` holds `{ intent, areas, risks, confidence, coverage, runId }`. Reads
  return it with `aiWritten: true`.

Routes (signed-in browser sessions only, like agentic mode; other callers get 403, an
API token 401; outsiders 404):
- `POST /native/agent-inbox/read` `{ action: 'summary', number }` (any reader) returns
  `{ number, pullRequestId, baseCommitId, headCommitId, summary | null, run, inFlight,
  summaries }` for the current head; `run` is the caller's own latest run for that head.
- `POST /native/agent-inbox` `{ action: 'summarize', number, idempotencyKey }` (write or
  admin; 403 otherwise) returns the same pull request fields with `state`:
  - `STORED` with the summary when the head already has one (no AI call);
  - `RUNNING` when a run for this head is already in flight, or the new run was admitted;
  - `REFUSED` when the run was refused at admission.

  Without Workers AI, or with AI review drafts turned off by a policy, it is refused
  with 412 and the reason; nothing is admitted. Closed pull requests and deleted
  branches are refused with 412.

A successful `summarize` is audited like other AI requests, as `ai.run_request` with
subject `intent-summary`. Inbox and summary reads are not recorded.

### UI

`/:owner/:repo/agents` is the inbox while the capability is ready and agentic mode is on
for the repository. Otherwise it stays the Agent workspace view, as does
`/agents/:number`.
- Counts for the four sections, and how many open pull requests were evaluated.
- **In progress**, **Ready to land**, **Needs a person** and **Landed**, each in the
  shared DataTable. Search and sort cover the loaded rows. Pull requests link to their
  pages.
- **Summarize intent** (writers, when summaries are available) and **Show intent** open
  an advisory panel marked **AI-written**, with the model, what it read and the head
  commit. The panel links to the diff; it never replaces it. Readers see why they
  cannot ask.
- Live updates use the repository activity stream (topics `source`, `pulls`, `actions`,
  `agents`). Without a live connection the inbox is read again every 30 seconds while
  the page is visible.
- **Approve and land selected** (writers, while the Worker reports capability
  `repository.agentic-landing` ready and the inbox's `actions.land` is true). Rows the
  caller may land carry `canLand` from the same evaluation as the pull request's Land
  button: the policy says land, or it waits only for a writer who is not the author
  (that writer's land request is the approval; no review is recorded). A TanStack Form
  confirmation lists the selection with each head and asks for merge or squash. It then
  sends one `POST /native/land { action: 'land', number, headCommitId, method,
  idempotencyKey }` per pull request, three at a time, with one key per pull request
  fixed for that confirmation. Each answer is shown as the land queue gave it: landed,
  queued, needs a rebase (with paths), blocked or failed (with reasons), refused (the
  Worker's message) or unknown. Without the capability the inbox says that Golf does
  not land pull requests from it.
- **Revert…** on a **Landed** row that is still LANDED (writers, `actions.revert`). See
  "Reverting from the inbox" below. The **Revert** column describes a landing's revert:
  automatic, by a person, in progress, conflicting or refused.

### Reverting from the inbox

`POST /native/land { action: 'revert', id, number, landedCommitId, reason?,
idempotencyKey }` (`land-queue.mjs`), for a signed-in browser session with a write or
admin grant.
- **What it does.** It runs the same inverse three-way merge as the automatic revert
  (`git revert -m 1` of the landed commit onto the current base tip). The commit is
  written through the branch fence (`source-api.mjs` `commitTree`) as the person, under
  the push fence's authority guard: grant, access and identity versions, and branch
  rules. Pipelines run on the revert push, and the pull request gets a comment naming
  the person and the reason.
- **One revert per landing.** The claim is `detail.revert` with the request's key. It is
  refused while another revert of the landing is in flight, and while an automatic revert
  claimed it within the last ten minutes without recording an attempt. The claim also
  takes the post-landing check (`detail.postLand.verdict = 'person_revert'`), so failing
  checks cannot start an automatic revert alongside it. A revert that does not apply
  gives that check back.
- **Answers.** `phase` is REVERTED, REVERTING (sent, not confirmed; maintenance settles it
  from the branch fence) or REVERT_REFUSED, with `revert.state` `conflict` (paths),
  `noop` or `refused` (reason). A replayed key returns the original answer.
- **Audit.** Recorded as `agentic_mode.revert_landing`; a refused revert is recorded as
  refused.

### Agent branches (`agent-branches.mjs`)

An agent branch is either of these:
- a coding agent task's proposal branch, `golf-agent/*`;
- a branch matching the write branch pattern of an API token whose scope includes the
  repository and whose owner holds a grant there (for example `agent/*`). This counts
  revoked and expired tokens; `*` alone never counts.

The default branch is never an agent branch.
- **Branch list.** The Branches page hides agent branches among the loaded branches and
  says how many. **Show agent branches** lists them. Where the inbox capability is
  ready, the patterns come from `POST /native/agent-inbox/read { action: 'branches' }`;
  otherwise only `golf-agent/*` is known.
- **Deletion.** While agentic mode is on (setting and feature policy), Golf deletes the
  head branch of a pull request after it lands (`land-queue.mjs` `landed`), merges (the
  standard native merge) or is closed (`UpdatePullRequest`). It runs after the response
  where the runtime offers `waitUntil`. The delete is one ref update to zero through the
  branch fence (`source-api.mjs` `deleteBranchAt`, `ref-writes.mjs`) and is read back.
  It runs under the administrator whose saved setting authorizes Golf's own writes.
  The guard, evaluated with the reservation, rechecks:
  - that administrator's grant and identity version;
  - the setting and rules versions;
  - that no open pull request uses the branch as head or base;
  - that no queued or running agent task writes to it.

  Golf deletes a branch only when all of these hold:
  - it is an agent branch, not the default branch and not the pull request's base;
  - no branch rule covers it;
  - its head is still the head the pull request landed, merged or was closed at.

  A compare-and-swap on that head keeps a later push. Each deletion is audited as
  `agentic_mode.branch_delete` (actor Golf, via agentic mode), with the full head commit,
  so the branch can be recreated from it (Source API `branch` `create` with `from`) while
  Git storage keeps the commit. Each skipped deletion is logged as
  `golf.agent_branch_kept` with the reason.

### Limits of this slice

- Hidden agent branches are filtered on the loaded pages of the branch list (the list is
  paginated by the Worker), and the branch picker still lists every branch.
- Deleting a branch is best-effort after the response. A repository that stays busy, or
  an unconfirmed delete, leaves the branch and logs why. No sweep retries it later.
- Closing an unmerged agent pull request deletes its branch. Its commits are then only
  reachable from the audit entry's head commit.
- No hosted walkthrough of batch landing, reverts or branch cleanup yet.

## Line-level merges

AM-6, first slice. Every three-way merge in `tree-merge.mjs` merges text files line by
line. That covers pull request merges and squashes, lands, automatic reverts and Source
API commits with `onStale: "merge"`. Two changes to different lines of one file merge.

- **When:** both sides changed a regular file differently, and it has the same mode on
  every side (`file` or `executable`). A file added on both sides merges against an
  empty file, as in Git.
- **How (`text-merge.mjs`):** the outcome of `git merge-file` with its default Myers
  diff and the default conflict style. A clean merge gives the same bytes. Lines keep
  their endings (LF, CRLF, or no final newline).
- **Conflicts:** a change that overlaps or touches the other side's change. Touching
  means editing adjacent lines, or inserting at the same place. These are conflicts in
  Git too, unless both sides end up with the same lines. The path is listed with
  `both_modified` (or `both_added`). Golf never writes conflict markers.
- **Not merged:**
  - `binary`: a NUL in the first 8000 bytes, or text that is not UTF-8;
  - `too_large_to_merge`: over 1 MiB or 50,000 lines on any side;
  - `merge_budget`: past 200 files or 16 MiB read in one merge;
  - mode changes on one side with content changes on the other, symlinks and
    submodules, which still conflict by path.
- **Differences from Git:**
  - `git merge` uses histogram diff, while Golf uses Myers like `git merge-file`. Where
    the two diffs align repeated lines differently, a merge can differ from Git's or
    conflict where Git's does not.
  - Golf conflicts where Git would still merge: non-UTF-8 text, files over the bounds,
    and a mode change on one side combined with a content change on the other.
  - The worst case for adversarial 50,000-line files is about one second of CPU per
    file in Node.

## Not yet implemented

- Batch approval, a revert action in the inbox and hiding agent branches (AM-5).
- Policy landings that squash; queuing a pull request that is still waiting for checks.
- A dedicated service account for comments and issues Golf writes (they use the admin who saved the setting).
- Organization-level agentic policies beyond on/off.
- Hosted measurement of line-level merges on shared branches (AM-6).
