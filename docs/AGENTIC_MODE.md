# Agentic mode

Agentic mode is a per-repository setting on the Cloudflare-native runtime. It decides
when a pull request may land without a person. It implements AM-4 items 2 and 3 of
`docs/AGENTIC_MODE_PLAN.md`. Schema 41 adds it (migration `0041_agentic_mode.sql`).

Golf **evaluates** pull requests against the policy and shows the result. It does not
land, queue or revert anything on its own yet. Those are AM-4 items 4 and 5.

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
| `revertOnFailure` | on | Stored for automatic reverts (AM-4 item 5). Golf does not revert anything yet. |

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
- **Pull request sidebar → Landing.** It is shown only while agentic mode is on for the
  repository and the pull request is open. It is read-only and lists:
  - the decision, the risk and the reasons;
  - the matched sensitive paths;
  - the number of changed paths and how the pull request was opened.

  It says that Golf does not land pull requests on its own yet.

## Not yet implemented

- The land queue: landing on decision `land` and compare-and-swap retries (AM-4 item 4).
- Merging diverged branches (AM-4 item 1).
- Reverting landed changes whose checks fail (AM-4 item 5, `revertOnFailure`).
- The agentic inbox and batch approval (AM-5).
- Organization-level agentic policies beyond on/off.
