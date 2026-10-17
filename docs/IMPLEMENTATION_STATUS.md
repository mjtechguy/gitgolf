# Golf implementation status

## 2026-10-17 — First Forgejo backup/restore drill: the core drill passes, Access-core059 cannot run

- **Core drill passes:** `python3 scripts/recovery-smoke.py --image golf-recovery-drill:976f8de-labeled` exited 0 three times in a row. The last run used the final scripts in this change.
  - Golf image `sha256:445160f727bfea6dfeeadd40833653131d680cd46b3ac76516ea3c319b0c38ec`, built locally from commit `976f8de` with `deploy/docker/Dockerfile`; Golf schema 202610110095.
  - Forgejo 15.0.9 rootless (`caf1bca332f9`), PostgreSQL 18.4, local RustFS 1.0.0.
  - It covers an encrypted backup of the stopped core plus RustFS and restore into a fresh quarantined project. It also covers every refusal case: live writers, overwrite, the 1 MiB cap (the fixture is now over 1 MiB, so this no longer skips), wrong identity, truncated ciphertext, damaged payload, mislabeled schema, and existing or non-empty targets.
  - After restore it checks the invalidation ledger, revoked grants, cancelled runs and quarantined materializations. Old sessions, API keys and attempt tokens are denied. It re-enrolls local accounts, rotates and retires a key, and checks the repository-creation and issue journals. Git refs and signatures, LFS bytes, release attachments, branch protection, the SSH host key and the GnuPG key survive. A signed push after restore works, force-push is denied and the data survives a restart.
  - All disposable projects, volumes and networks were removed.
- **Fixes needed before it passed:**
  - **Schema allowlist:** `recovery.py` accepted only 202610020008/009/019/021, which predate Forgejo. Every Forgejo-era image is at 202610110095, so every Forgejo backup was refused. 202610110095 is now accepted; the older labels stay for historical archives.
  - **SSH host key:** the drill required at least two host keys, which matched OpenSSH on the old topology. The rootless image's built-in SSH server has one RSA key (`ssh/gitea.rsa`). The drill now requires at least one; it still compares the keys before and after restore.
  - **Runner poll:** the drill polled with an empty body. Golf answers 204 to a poll that does not declare `golf.runner.job-limits.v1`, so no run was leased. That also meant the post-restore "no run replays" check (which expects 204) passed without proving anything. Both polls now declare the capability.
- **Also changed:**
  - **Harness fence:** the plan keeps managed agent harness state (schema022–025) out of qualified recovery until a drill covers it. At 202610110095, backup and restore now refuse any row in `golf_codex_connections`. The drill has none.
  - **Release creation retry:** one run failed once creating the fixture release; the status code was not recorded and later runs did not repeat it. The drill now retries only 409, 422 or 500, up to 20 times, and prints only the status codes. The retry has not been triggered since.
  - Journal comparisons print the names of differing fields, never values.
- **Access-core059 fails:** `scripts/repository-access-recovery-smoke.py` with the same image, `--proxy-image sha256:62eafe52c91cad83c2c74e630bfde917da8c253673e695665d454def84fc9a13` (python:3.13-bookworm) and `--source-revision 976f8de8601b3f04a165d9c31ef3d23aada4e7d6`. It failed at line 658, stage "fresh canonical core and ordinary supported native identities". The profile requires schema 202610040059, but the fresh core migrated to 202610110095. Owned cleanup passed and foreign containers were unchanged. Running it on Forgejo needs a new closed profile for the current schema, with the exclusion inventory re-derived for everything added since schema059. Changing the pinned label alone would not be qualification.
- **Checks:** `python3 scripts/recovery-test.py` passes, including new schema-profile and harness-fence cases. `python3 scripts/repository-access-recovery-smoke.py --self-check` passes.
- **Host tools:** `git-lfs` 3.4.1 was installed from Ubuntu's apt repository for the drill.
- **Still open:** Access-core059 on Forgejo; a core-only backup without RustFS; managed agent harness state; large fixtures, capacity and RPO/RTO; Kubernetes, external stores and the rest of P1.6.

## 2026-10-16 — Indexes for the review's reads; recent landings by last update (schema 55)

- **Migration 0055** adds four indexes, all `CREATE INDEX IF NOT EXISTS`:
  - `pull_merge_operations(updated_at, actor_id, operation_id)` for successful merges, used by AI impact's merge read;
  - `land_operations(repository_id, updated_at, id)`;
  - `evidence_jobs(repository_id, created_at, id)`;
  - `previews(repository_id, created_at, id)`.
- **Query plans:** `EXPLAIN QUERY PLAN` on `schema.sql` shows each read searching its new index with no temporary sort. Before, the merge read scanned successful merges; the other three read every row of the repository and then sorted.
- **Recent landings** now lists the most recently updated land operations first, as the review suggested, so a landing reverted or retried later is brought forward. The page text and `docs/AGENTIC_MODE.md` say so.
- **Schema version:** the release manifest says 55. Diagnostics detect schema versions by table, so they keep reporting 54, the same as after the index-only migrations 0050 and 0051.
- **Checks:** forge suite 801 pass, 0 fail. `land` and `agentic-mode` specs 12 of 12. Typecheck passes.

## 2026-10-16 — An external review's 26 findings checked and fixed (#163–#166, no migration, on hosted)

- **Source:** an external review listed 26 findings, mostly lists whose caps, order or labels did not match what they read, plus some races and one secret-handling gap. Each was checked against the code first; 24 were real, 2 were partly real. All have a fix, each with a test that fails on the old code.
- **Security and authority:**
  - GitLab trace uploads redacted each upload on its own, so a secret split across two uploads was stored. The possible start of a secret at the end of an upload is now held back, sealed with the repository value key, and decided by the next upload or the job's end. Actions log rows were already whole lines (now tested).
  - Accepting an invitation re-checks the rank in the write and only ever raises a grant. The existing grant-generation fence already blocked the race; this makes the rule explicit.
  - A stale SSH host-key confirm can no longer pin a key that a move cleared (version, probe and test result are checked in the write).
- **Behaviour:**
  - Runner claims page past jobs they cannot take; capacity reads queued jobs longest-waiting first.
  - The runner admin disables New pool and Enroll host only at their real limits.
  - A workflow log write that crosses the cap keeps the part that fits.
  - Long agent prompts trim the description first so the newest comments survive.
  - Inherited automations are filtered to this repository before the limit.
  - PR previews and per-PR runs are matched by number before their caps.
  - Clef ignores archived labels.
  - On Cloudflare-native, a tag rule blocks release notes only for the tags it names.
  - The token repository picker lists exactly what a token can name, with Load more.
  - Profile pins outside the newest 100 can be cleared.
  - The notification inbox reads up to 3 forge pages past inaccessible threads.
  - Assignee edits keep rows for people the panel hid.
  - Saving a paused email subscription resumes it.
  - Failed semantic searches refund the daily allowance when the model never ran.
  - A truncated source tree is now exactly the first 10,000 paths, so grep's order claim holds.
  - AI impact reads the earliest 20,000 merges.
  - Package tags follow the registry cursor and ignore digest aliases.
- **Labels made honest instead:**
  - recent landings and automation runs (an index would allow ordering by update);
  - the Actions pull list ("the 100 newest, open and closed");
  - the agent task log footnote;
  - webhook and email cancellation. Cancelling queued deliveries on disable or save is kept deliberately and now documented.
- **Checks:** forge suite 801 pass, 0 fail, 1 skipped. `go test ./internal/runner/ ./internal/server/` passes, but the PostgreSQL cases are skipped without a database. Web typecheck and builds pass. Targeted Playwright specs pass.
- **Hosted:** deployed to the demo at ae2980e. The plan showed 12 updates and no create, replace or delete; Login, ControlAccess and PreviewAccess stayed noop.
- **Open:**
  - **Optional indexes for later:** `pull_merge_operations(updated_at)` for successful merges, `land_operations(repository_id, updated_at)`, and `(repository_id, created_at)` on `evidence_jobs` and `previews`.
  - **Orphaned fragments:** a held log fragment of a GitLab job ended by timeout or a lost runner stays in R2. It is sealed, but nothing cleans it up.
  - **Notification pages:** they can still be short. Exact pages need a cursor that can stop mid-page.

## 2026-10-16 — Forgejo is the only portable backend; the earlier backend is retired

- **Decision:** the owner retired the earlier backend. No Golf installation was backed by it, so there was nothing to migrate. The planned data transfer and identity migration (FJ-4), the dress rehearsal (FJ-6) and the existing-install cutover (FJ-7) are superseded by this decision; they were not done. Forgejo 15.0.9, the default for fresh Compose, Helm and `install.sh` installs since 2026-10-12/13, is the only portable backend. Cloudflare-native Golf keeps Artifacts/D1/Workers.
- **Record:** [ADR 0009](decisions/0009-forgejo-portable-backend.md) now carries a dated addendum listing what is done and what is still open for Forgejo. The separate transition plan was folded into it and deleted. ADR 0003 is now [forge OAuth and session refresh](decisions/0003-forge-oauth-and-session-refresh.md).
- **Removed:** the remaining Compose profile, test fixtures, smoke and migration scripts, qualification documents and evidence receipts that belonged to the earlier backend.
- **Compatibility register:** rebased onto the Swagger served by Forgejo 15.0.9.
- **Breaking API rename:** the session RPCs are now `golf.v1.SessionService/LoginWithForgeToken` and `golf.v1.SessionService/BeginForgeOAuth`, and the options field is `forge_oauth_enabled` (JSON `forgeOauthEnabled`). Protobuf field numbers are unchanged, but RPC paths and JSON names changed, so existing clients must update.
- **Other renames:** metrics `golf_forge_requests_total` and `golf_forge_request_duration_seconds`; trace span `forge.request`; configuration uses only the `GOLF_FORGE_*` variables; webhooks accept only the `X-Forgejo-*` headers.
- **Recovery:** the backup/restore tooling was source-ported to Forgejo. No Forgejo backup/restore drill has been run, so recovery stays open for Forgejo.
- **Evidence:** `make forgejo-qualify` passed on a disposable pinned Forgejo 15.0.9/PostgreSQL stack ([receipt](compatibility/evidence/forgejo-qualify-20261016.json)).
- **Older entries:** below, results gathered on the earlier backend are attributed to "the native forge at the time" and are not Forgejo evidence. Links to its removed documents and receipts are now plain text.

- **Checks (2026-10-16, after the change):** `make forgejo-qualify` passed again on a fresh disposable stack: `smoke.py`, `workflow-config-smoke.py` and `forgejo-native-smoke.py`, cleanup true ([receipt](compatibility/evidence/forgejo-qualify-20261016-after-retirement.json)). `make fmt`, `make vet` and `make test` passed; `make generate` regenerated the Go and TypeScript protobuf code. `make web-check` and the web build passed. `node --test cloudflare/forge/*.test.mjs`: 764 tests, 763 passed, 0 failed. `make engine-check`, `make compatibility-check`, `python3 deploy/helm/golf/check.py` and `python3 deploy/kubernetes/cnpg/check.py` passed. The Python script tests passed (`recovery-test.py`, protected-boundary, compatibility and the Cloudflare suites), except `test_cloudflare_release.py`'s schema-tail test, which fails the same way without this change (the Cloudflare `schema.sql` tail is no longer migration 0035). `./scripts/install.sh --dry-run --yes` passed every check with a separate `--project` and ports; with the defaults it correctly reports the `golf-forgejo` project already running from another checkout.
- **Not run:** the Docker smoke scripts ported from the earlier backend (apart from the three above), the recovery drills and the OAuth browser flow have not been executed on Forgejo. Their earlier results are not Forgejo evidence.
- **Known Forgejo gaps found while porting:** Forgejo 15.0.9 has no repository `/licenses` API, so the repository overview's license section probably stays empty (untested). Forgejo 15 sends no hook installation-target header, so webhook intake no longer checks it.

## 2026-10-16: Agentic inbox, second slice: batch land, revert, agent branches (AM-5, no migration, not on hosted)

[`AGENTIC_MODE.md`](AGENTIC_MODE.md) "Inbox and intent summaries". Built and tested locally; not deployed. No schema change.

**Built:**
- **Batch approve and land.**
  - The inbox marks each row the caller may land (`canLand`, the pull request Land button's rule): the policy says land, or it waits only for a writer who is not the author.
  - **Approve and land selected** opens a TanStack Form confirmation with merge or squash. It then sends one `POST /native/land { action: 'land', number, headCommitId, method, idempotencyKey }` per pull request, three at a time, with one key per pull request per confirmation. That is the land queue's existing contract, unchanged.
  - Each answer is shown as given: landed, queued, needs a rebase (paths), blocked or failed (reasons), refused (the Worker's message) or unknown.
  - `repository.agentic-landing` is reported READY at schema ≥ 42, so on hosted (schema 52) the action appears for writers.
- **Revert from Landed.** `POST /native/land { action: 'revert', id, number, landedCommitId, reason?, idempotencyKey }` in `land-queue.mjs`.
  - It uses the automatic revert's inverse merge, now shared as `inverseCommit`. The commit is written as the person, through the branch fence, under the push fence's authority guard.
  - It is claimed once per landing, and the claim also holds the automatic revert off. It is settled by maintenance when unconfirmed.
  - The pull request gets a comment. The revert is audited as `agentic_mode.revert_landing` (refused when it does not apply). The UI asks for confirmation with an optional reason.
- **Agent branches (`agent-branches.mjs`).** `golf-agent/*` and the branch patterns of API tokens scoped to the repository (never `*`, never the default branch).
  - **Branches page:** they are hidden among the loaded branches, with **Show agent branches** and an honest count. The patterns come from `POST /native/agent-inbox/read { action: 'branches' }`.
  - **Deletion:** while agentic mode is on, the head branch is deleted after a land (`landed()`), a standard merge or a close (`UpdatePullRequest`).
    - It is one fenced ref update to zero (`source-api.mjs` `deleteBranchAt`, `ref-writes.mjs`) under the agentic-mode administrator.
    - A guard in the reservation rechecks access and versions, and that no open pull request (head or base) and no unfinished agent task uses the branch.
    - Golf deletes only when the head is still the pull request's head and no branch rule covers the branch.
    - Each deletion is audited as `agentic_mode.branch_delete` with the full head commit. Each skip is logged as `golf.agent_branch_kept` with the reason.

**Verified locally:**
- **`node --test cloudflare/forge/*.test.mjs`:** 770 tests, 769 pass, 1 skipped.
  - New in `land-queue.test.mjs`:
    - the batch contract: landed, needs rebase, refused, replay, one key per pull request;
    - person revert: authority, exact landing, commit identity and tree, comment, intake, audit, replay, conflict, and the automatic revert held off and settled;
    - branch deletion after land, merge and close;
    - the safety cases: head moved, another open pull request (head or base), branch rule, unfinished task, non-agent branch, agentic mode off or turned off by policy, administrator without write, and a guard race that sends nothing.
  - `agent-inbox.test.mjs` checks `canLand` and `actions`.
- **`node --test web/tests/*.test.ts`:** 24 tests, 22 pass. The 2 failures are the known pre-existing ones (`navigation-cache`, one `runtime-capabilities`).
- **`npm run typecheck`, `npm run build`, `npm run build:native`:** clean.
- **Playwright:**
  - `agent-inbox.spec.ts`: 16/16, including the inbox in all 9 layouts at 1440 and 390 px;
  - `repository-ref-management.spec.ts`: 17/17;
  - `land.spec.ts`, `agentic-mode.spec.ts`, `pull-ai-draft.spec.ts`, `layout-presets.spec.ts`: pass;
  - `native-agent-hosts.spec.ts:283` failed once and passed on rerun;
  - `repository-browser.spec.ts:132` and `:382` (Markdown rendering) fail. This change does not touch those files.

**Not done:**
- A hosted walkthrough.
- The branch picker still lists agent branches. Hiding works on loaded pages only.
- Deletion is best-effort after the response, with no retry sweep.
- Closing an unmerged agent pull request deletes its branch; the audit entry keeps the head commit.
## 2026-10-16 — Contribution graphs and AI impact, CG-1 and CG-2 (schema 53, not on hosted)

[`AGENTS_AND_AUTOMATIONS_PLAN.md`](AGENTS_AND_AUTOMATIONS_PLAN.md), "Contribution graphs and AI impact". Built and tested locally. Not
deployed: migration 0053 is not applied on the hosted demo.

**Built:**
- **Data (schema 53):**
  - `contribution_days`: the daily rollup, keyed by (actor, day, repository, kind, AI tier).
  - `contribution_ledger`: the ledger, one row per contribution, keyed by its source, so retries and repeated sweeps count nothing twice.
    It replaced `contribution_events` in migration 0054, which stays unused.
  - `contribution_git`: each repository's Git walk.
  - `contribution_cursors`: each sweep's position.
  - `contribution_settings`: the privacy choice.
  - Indexes for the sweeps' reads.
- **Writers** (`src/contributions.mjs`):
  - **Collaboration** (core handlers, Workspace): after an issue, pull request, comment, review, close, merge or published review draft,
    that discussion's last day of events. One batch, after the response is decided.
  - **Agent tasks:** when a task finishes.
  - **Pushes, Source API commits and agent task pushes** (`finishRefWrite`, in the stateless Worker and the Workspace) and maintenance
    settlement: a confirmed write to the default branch marks the repository's Git walk due. One upsert; a failure never fails the write.
- **Maintenance** (the `indexes` stage):
  - **The sweep** reads discussion events, finished agent tasks and succeeded container proposals since its cursors, behind a two-minute
    lag. It uses the writers' keys, so landings by policy and merges settled later are counted once.
  - **The Git backfill** walks first-parent history of each default branch through Artifacts `log`/`readCommit`, never storage writes.
    Each pass enrols 20 repositories and walks at most 3 of them, 200 commits each (a walk from the tip reads 20 first), with 40 extra
    commit reads. It resumes from where it stopped, stops at the first commit already counted, and re-checks each repository daily.
- **AI tiers:**
  - **Golf agent:** pull requests opened from agent tasks, landings by the agentic mode policy, agent task and container proposals,
    agent review tasks, commits by Golf's agentic identity or an agent task.
  - **API token:** a pull request opened through an API token, the way agents and automations outside Golf connect (a coding CLI
    over MCP, a script). Golf reports the token; it cannot tell an agent from a script. These count as AI involvement, not in the
    person's human count. Migration 0054 adds the tier; the next sweep rebuilds every count once from Golf's records
    (`contribution_rebuilds`).
  - **AI-assisted:** a person merged an agent task's pull request (also counted as a proposal accepted) or one opened through an
    API token.
  - **Declared:** a `Co-Authored-By` trailer naming Claude, Copilot, Codex, Cursor, Gemini and other known tools or their domains.
  - **Unlabelled:** everything else.
- **Reads:** `POST /native/contributions/read`, served by the stateless Worker (`statelessRoute` `'read'`) and overlapping reads in the
  Workspace.
  - **`person`:** for any signed-in person. Counts only for repositories the viewer can read (grant, or public on a public installation).
    Activity in other repositories appears only as anonymous counts, for the person themself or when they chose to show it.
  - **`impact`:** for operations administrators, checked before and after the reads. Installation-wide anonymous aggregates; no
    repository or person is named.
  - **Settings:** `POST /native/contributions` (`settings`) changes the privacy choice: self only, through Access, version-fenced.
- **Feature policy:** `contribution-graphs` (installation, organization, repository). Off hides counts and keeps them.
- **UI:**
  - **Profile heatmap** (`ContributionGraph.tsx`): a 53-week calendar with month and weekday labels, a legend, totals, streaks, a year
    picker, a per-day panel and a table view. The "Show AI involvement" overlay marks AI-involved days with a second hue and a dot,
    never replacing the human count, with tier totals and definitions. The private contributions setting shows its value, with Edit
    (TanStack Form).
  - **AI impact page** (`/admin/ai-impact`, capability `operations.ai-impact`):
    - merged pull requests with AI involvement, labelled as a share;
    - agent proposals and acceptance, landings by policy, reported cost (with how many runs reported one);
    - an AI activity calendar, contributions by tier, agent tasks, review advice, AI runs and automation runs;
    - time to merge, labelled "Comparison, not an effect". Nothing estimates time saved or productivity.
  - Colours follow the dataviz method: one blue ramp in four ordinal steps per mode, validated against each panel surface, and the
    categorical orange for the overlay, validated against blue in both modes.

**Verified locally:**
- `node --test cloudflare/forge/*.test.mjs`: 775 tests, 774 pass, 1 skipped. The new `contributions.test.mjs` (11 tests) covers:
  - stateless routing;
  - the trailer rules and the 53-week range;
  - idempotent writers through real CreateIssue, comment and close calls, with replays and a later sweep;
  - every tier through the sweep (agent proposal merged by a person, policy landing, agent tasks and review tasks, container
    proposals; excluded events and the lag);
  - a bounded, resumable backfill of 45 commits in three passes, then a push walking only its three new commits;
  - a failed Artifacts read leaving walks due;
  - a real push through receive-pack marking only default-branch writes;
  - authorization: counts only for repositories the viewer reads, anonymous private counts only by choice, never a private name,
    settings self-only with a version fence, repository and installation policy, public repositories;
  - the impact page for administrators only, its aggregates naming nothing, and the comparison label.
- Web:
  - `npm run typecheck`, `npm run build` and `npm run build:native` pass.
  - `node --test web/tests/*.test.ts`: 23 tests, 21 pass. The 2 failures are the known `navigation-cache` and one
    `runtime-capabilities` test.
  - Playwright `contribution-graphs.spec.ts`: 5 of 5 pass (the heatmap, overlay, day panel, table and year picker; the privacy
    setting; a visitor's view; the impact page and its unreadable and off states).
  - Neighbouring specs (estimated-costs, runner-capacity, feature-policies-native, missing-resource-refetch,
    native-installation-settings, settings, capabilities, profile-settings): 100 pass, 5 skipped. Two fail (`capabilities.spec.ts`
    "Manage connections", `profile-settings.spec.ts` personal settings search), in portable account pages this change does not touch.

**Not done:**
- Hosted deploy and migration 0053. The first passes after it backfill Git history at the paced rate above.
- CG-3 (per-agent, tool and automation pages) and CG-4 (repository and organization rollups, CSV export).
- "Your activity" and organization views, CI pass rate of proposals, review findings acted on.
- Re-attributing commits when a person adds an email later; profile graphs for signed-out visitors.
- Comments Golf posts itself (landing notes) carry no discussion event and are not counted. Issues and pull requests opened before
  discussion events existed (schema 14) are not counted.
- The impact page's time-to-merge read scans merges in the period without an index on their settle time.


## 2026-10-16: Agent pull requests land: 71 of 71 on hosted

- **Fixes, all merged and deployed:**
  - **#139:** the stateless Worker's isolate object cache.
  - **#140:** a missing resource's error screen no longer refetches when the tab becomes visible.
  - **#141:** runner pool caps and runner shares (schema 52, migrated on hosted).
  - **#143:** targeted landing reaches its pull request however many are open.
- **Measured at about 60 agents (`s2h`):** every Git and Source API operation succeeded. `open_pull_request` p50 2.0 s, CI reports 0.7 s, Workspace admission p95 0.8 s.
- **Measured with S7 alone, 16 agents (`s2j`):** 71 of 71 pull requests landed, p50 5.9 s. Before #143, 36 of 48 landed.
- **Data:** [benchmarks/2026-10-15-scale-out](benchmarks/2026-10-15-scale-out/README.md).
- **Open:**
  - one unexplained `open_pull_request` 503 in `s2j`;
  - the `s2f` 503s, which did not recur;
  - 359 stale open bench pull requests in `mj/agent-bench-3`.

## 2026-10-15 — Scale-out S5 slice 2: self-hosted pool caps and organization and repository runner shares (schema 52, not on hosted)

[`SCALE_OUT_PLAN.md`](SCALE_OUT_PLAN.md) S5, second slice; details in [`RUNNER_CAPACITY.md`](RUNNER_CAPACITY.md). Built and tested locally.
Not deployed: migration 0052 is not applied on the hosted demo.

**Built:**
- **Pool caps:** a new installation policy, `runner-pools` (`capacity-policy.mjs`): `{ engine, labels, maxConcurrent }` per self-hosted
  pool, where the pool is slice 1's (engine plus sorted label names).
  - The deploy value is "no caps"; each cap is 1–1000.
  - Narrowing saves at once. Raising or removing a cap needs `runner-pools` typed and an Access sign-in from the last 10 minutes,
    through `applyInstallationChange`. Audited.
- **Runner shares:** running pipeline jobs and runs started per UTC day.
  - The installation sets them (installation policy `runner-shares`) for each organization (all its repositories together) and each
    personal repository, and may enforce them.
  - Organization owners narrow the organization's, and repository administrators narrow the repository's within its organization's.
    These values are stored in the new `capacity_shares` table (schema 52), edited under a verified Access sign-in, version-fenced, and
    audited at their own scope.
  - Why a table and not `feature_policies`: that table's mode is a CHECKed enum, its scope excludes repositories, and a replayable
    migration cannot relax a CHECK.
- **Organization requests:** an organization owner requests a higher share.
  - It is a `capacity_requests` row with `policy_key` `organization:<id>`. A replayable migration cannot add columns, and the existing
    unique open-request index then gives one open request per organization and field.
  - A different operations administrator approves on the Runner capacity page, typing the organization's name, with a recent sign-in.
    The grant and the audit row are written in the same batch.
- **Enforcement where work starts** (`pipelines.mjs`):
  - **Pool caps and running shares:** counts inside `claimPipelineJob`'s conditional `UPDATE`. The pool is matched in SQL by label names
    (`json_each`), so a relabelled runner is counted.
  - **Skipping blocked jobs:** repositories and organizations at their share are excluded from the candidate query, and re-read when a
    concurrent claim fills a share, so runners take other jobs instead of stalling.
  - **When a pool is at its cap:** the runner sees an empty queue (GitLab 204, Forgejo empty task).
  - **Daily share:** a count inside `createPipelineRun`'s conditional `INSERT`. A run over it is recorded `REFUSED` with the reason.
  - **No configuration:** nothing changes.
- **Inventory and metric:**
  - Each pool shows its cap and held jobs; each organization and repository with a share shows running, queued, held and runs today.
  - `GET /native/capacity/metrics` adds `held`, `claimable` and `cap` without changing `queued`. The KEDA example now scales on
    `claimable`.
- **UI:**
  - Runner capacity page: Pool caps (Add, Edit, Remove) and Runner shares (installation value with Edit, and a shares table).
  - Organization settings and repository Settings → Runners: a Runner share panel with the current and inherited values, Edit, and for
    organization owners Request more.

**Verified locally:**
- `node --test cloudflare/forge/*.test.mjs`: 757 tests, 756 pass, 1 skipped. The new `capacity-shares.test.mjs` (9 tests) covers:
  - a cap stopping six concurrent claims at two;
  - the GitLab 204;
  - a share skipping more than a page of held jobs;
  - concurrent claims not overshooting a share;
  - the hierarchy refused above the parent, and enforcement;
  - each scope's authorization, including tokens;
  - an organization request approved with two people;
  - the daily share refusing a run with the reason;
  - the inventory and metric fields.
- Web:
  - `npm run typecheck`, `npm run build` and `npm run build:native` pass.
  - `node --test web/tests/*.test.ts`: 22 tests, 20 pass. The 2 failures are the known `navigation-cache` and one
    `runtime-capabilities` test.
  - Playwright `runner-capacity.spec.ts`: 3 of 3 pass, 2 of them new: the caps and shares panels, and the repository share panel.
  - The neighbouring specs (native-actions, organization-admin, organization-settings-navigation, settings, native-agent-hosts,
    organizations, native-installation-settings): 61 pass, 15 skipped.

**Not done:**
- Hosted deploy and migration 0052.
- A browser test of the organization settings panel. It uses the same component as the repository panel, which has one.
- A request that raises a pool cap.
- A native pool's `max_parallel` as policy.
- Shares for PR test containers, agent proposals and host tasks.
- The bench run at a raised limit.

## 2026-10-15 — After the 110-agent run: pull requests during merges, the push reservation race, D1 indexes (schemas 50, 51)

Each fix comes from the hosted runs in [benchmarks/2026-10-15-scale-out](benchmarks/2026-10-15-scale-out/README.md). All are merged,
migrated and deployed on the hosted demo.

- **Pull requests open while a landing's merge holds the repository (#133).**
  - `CreatePullRequest` was refused whenever any write held the repository; 14 of 163 `open_pull_request` calls in `s2e` failed
    this way or because the base moved.
  - It is now refused only for an unresolved write to one of its own two branches.
  - The MCP tool reads the branches again, up to three times, when the base moved.
- **The push reservation race (#134).**
  - A push whose reservation failed found nothing blocking it, because the other write had just finished, and answered HTTP 412.
    Git shows that as "unexpected disconnect" (10 pushes in `s2e`).
  - It now tries again while its authority guard holds.
- **D1 indexes, from `d1QueriesAdaptiveGroups` on the hosted demo:**
  - **0050 (#135):**
    - the CI pass's pending-push query read the whole `git_operations` table: 11,336 rows a call, 38.8 million in three hours;
    - pull requests by head branch read about 865 rows a call;
    - landing's per-head lookup scanned every land operation.
    After the migration, the CI query no longer appears among the top reads.
  - **0051 (#137):** `settleRefWrites` read 77,944 rows a call, every dispatched operation times every merge.
    After both migrations and a maintenance pass, the heaviest query over ten minutes read 106 rows in total (runner lookups by
    token). The sweeps no longer appear among the top reads.
- **Post-deploy outage removed (#132).** `RepositoryReads` kept a Workspace stub across the Workspace's restart on every deploy, so
  repository reads answered 503 for about three minutes after each deploy. Reads are now confirmed from D1: during a deploy, 27 of 27
  probes answered 200.
- **Not yet measured under load:** #133 and #134 need another hosted agent run, which needs new temporary API tokens from a signed-in
  session.

## 2026-10-15 — Scale-out S5 slice 1: runner capacity, autoscaler queue metric, approved capacity requests (schema 49, on hosted)

[`SCALE_OUT_PLAN.md`](SCALE_OUT_PLAN.md) S5, first slice; details in [`RUNNER_CAPACITY.md`](RUNNER_CAPACITY.md). Deployed on the hosted
demo with migration 0049 applied. The metrics route refuses requests without a token, or with an invalid one (401). The signed-in
pages, `/admin/capacity` and `/admin/costs`, are not yet viewed on hosted. Golf never starts
machines: it reports capacity and queue depth, and limits rise through requests a second administrator approves.

**Built:**
- **Inventory:** `cloudflare/forge/src/capacity.mjs`, `POST /native/capacity/read` (actions `read` and `preview`). It is for
  operations administrators only, checked before and after the reads, and runs in the stateless Worker (`statelessRoute` `'read'`).
  Page `/admin/capacity` ("Runner capacity", capability `operations.capacity`) leads with one shared DataTable across sources:
  - self-hosted Forgejo and GitLab pools (engine plus label names, matched as `claimPipelineJob` does, `name:image` by name, scope
    included): registered, active and online (5 minutes) runners, running, queued and the oldest wait;
  - jobs no active runner can take;
  - native pools (`max_parallel`, active machines, running, queued);
  - Cloudflare containers (PR tests, agent proposals, SSH tasks): the allocation is "not known to the Worker" because no
    `max_instances` is bound, plus Golf's own admission limit;
  - agent and SSH hosts (summed `max_concurrent`, online, running, queued).
- **Metric:** `GET /native/capacity/metrics?engine=…&labels=…` returns `{ pool, engine, labels, queued, running, online,
  oldestWaitSeconds, registered, truncated, at }`.
  - It is a stateless read and authenticated only by a `golf_capacity_` token, which `api-tokens.mjs` `machineTokenRoute` passes
    through Access on this path only.
  - Tokens are created and revoked on the page, shown once, stored as SHA-256, expire after 30, 90 or 365 days, at most 20 active,
    and audited. `actor()` knows no such credential, so the token reads nothing else.
  - A label set with no runners publishes its queue for scale-from-zero.
  - `docs/RUNNER_CAPACITY.md` has a KEDA `metrics-api` ScaledObject with bearer auth and no secrets.
- **Requests:** migration `0049_capacity_requests.sql` (`capacity_requests`, `capacity_metrics_tokens`; `schema.sql`, `release.mjs`
  schema 49 and `schemaTables` updated). On `POST /native/capacity`:
  - `request`: any operations administrator. The value is validated by the policy's own `validate`. Above the ceiling, up to the
    deploy maximum (daily admissions 50, preview lifetime 14,400 s), it is accepted as `needs_deploy`. Preview slots and agent
    budgets are fixed in code and refused above their bound. One open request per setting.
  - Cost change: daily admissions are priced as up to that many more CI runs a day at S6's measured cost per CI run (an upper
    bound; container time named as left out). Without a measurement, and for other settings, the estimate is null with the reason.
  - `withdraw`: the requester only. `decline` and `approve`: a different operations administrator only.
  - Approval goes through `installation.mjs` `applyInstallationChange`, extracted from `/native/installation` without changing its
    behaviour. It brings the typed confirmation, the 10-minute Access sign-in for widening, the revision fence, the receipt and
    the `update` audit row. The request becomes APPLIED in the same D1 batch, guarded on the request still being undecided.
  - Needs-deploy approval records APPROVED with the `golf_cloudflare.py update` step. Once a deploy raises the ceiling, **Apply**
    runs the same path. A request that can no longer apply becomes FAILED with the reason.
  - Every action writes its audit row in its batch (`capacity_request.*`, `capacity_metrics_token.*`, category "Runner capacity").
    Denials and failed approvals are recorded by the audit hook.
- **UI:** the requests inventory lists pending first, with current → requested, the ceiling, a needs-deploy badge, the cost change
  and the requester. "Request more capacity" opens a TanStack form with "Estimate cost". Approve, Apply and Decline open a form;
  approval needs the setting name typed. "New metrics token" shows the secret once.

**Checks:**
- `node --test cloudflare/forge/*.test.mjs`: 745 tests, 744 pass, 1 skipped, 0 fail. New in `capacity.test.mjs` (6 tests):
  - pool grouping and label and scope matching;
  - queued, unmatched and oldest wait;
  - inventory sources and admin-only access;
  - metrics token create, use, expiry and revoke, and that it reads nothing else;
  - cost math;
  - request validation, `needs_deploy`, the two-person rule, approval applying the policy and refusing without the recent sign-in or
    the typed name, apply after a deploy, withdraw, decline, FAILED, a locked installation, and audit rows.
  - `public.test.mjs` adds the stateless-route test. Diagnostics tests now expect schema 49.
- Web: `npm run typecheck`, `npm run build` and `npm run build:native` pass.
- `node --test web/tests/*.test.ts`: 22 tests, 20 pass. The 2 failures are the known ones on `main` (`navigation-cache` and the
  native-operations `runtime-capabilities` test).
- Playwright `tests/runner-capacity.spec.ts`: 1 pass, with fixture data; `estimated-costs` still passes 2.
- Neighbouring specs: `native-installation-settings` and `agent-budgets` pass 12; the 5 review-screenshot tests skip by default. `instance-admin` and `capabilities` have 3
  failures, the same 3 with `main`'s `web/` sources.

**Not verified / deliberately left out:**
- Not deployed; the migration is not applied on the hosted demo.
- The KEDA example has not been run against a cluster (`golf-ci` kind).
- `public.mjs` gained one line beyond `statelessRoute`: `/native/capacity` now gets `X-Golf-Native-Access-Issued-At` like
  `/native/installation`. Without it, approval could never satisfy the 10-minute sign-in rule.
- A request's cost reads the Analytics API (up to 5 s). Requests run on the Workspace's exclusive route.
- Remaining S5 work is listed in the plan:
  - organization and repository shares;
  - pool concurrency caps as policies;
  - container `max_instances` bound into the Worker;
  - container time in the cost;
  - organization-owner requests;
  - a bench run at a newly approved limit.

## 2026-10-15 — Scale-out S6: estimated costs in the admin UI (built, not yet verified on hosted)

[`SCALE_OUT_PLAN.md`](SCALE_OUT_PLAN.md) S6. Operations administrators see, at `/admin/costs` next to AI usage, what this
installation's Cloudflare usage costs at list prices so far this month, the month projected at that pace, and a scale-up what-if.
Every figure is labelled an estimate, not a bill.

**Built:**
- **Backend:** `cloudflare/forge/src/costs.mjs`, `POST /native/costs/read` (actions `read` and `estimate`), administrators only,
  checked before and after the reads; served as a concurrent read.
- **Rates:** a price table in code, Workers Paid list prices and included allowances checked against the pricing pages on
  2026-10-15, one source URL per rate. Artifacts are counted from 2026-10-14, when Cloudflare starts billing them.
- **Running now:** one GraphQL Analytics request per dataset, month-to-date and a 7-day window in the same request, 5 s timeout.
  - Read: Workers requests (this Worker), Durable Object requests and active time (account-wide), D1 rows read and written (this
    database) and size, R2 Class A and B operations and storage (this installation's buckets), Queues operations (account-wide),
    Artifacts operations (this namespace).
  - Each service row says its scope; account-wide figures are labelled as such.
  - Not read, listed by name and left out of totals, never $0: Durable Object SQLite rows and storage, Artifacts storage.
    Workers CPU uses `cpuTimeUs`, which no published page confirms; if the API refuses it, that one meter says so.
  - Configured but not priced here (Containers, Workers AI, Vectorize, Workflows, Workers Logs, Workers for Platforms, Browser
    Rendering, Email) are listed with their reasons.
- **Failure states:**
  - no token: "No Account Analytics Read token is bound (enable-analytics)";
  - HTTP 401/403: "The analytics token was refused (HTTP 403). It needs Account Analytics Read on this account.";
  - a GraphQL permission error: "The analytics token lacks permission for this dataset: …";
  - a timeout: "The analytics API did not answer within 5 seconds.";
  - an empty Workers, Durable Objects or D1 dataset is not taken as zero.
- **What-if:**
  - unit costs measured here over 7 days: usage divided by `git_operations` APPLIED (per write), `land_operations` LANDED (per
    landed pull request; the two are alternatives, both all-in) and pipeline plus container test runs (R2 and Queues per CI run);
  - containers from concurrent count and instance size (standard-1 by default); self-hosted runners from an entered hourly rate,
    empty by default and then listed as not priced;
  - the TanStack form opens only on "Estimate a scale-up", and every assumption and unit cost is editable;
  - the server computes the estimate (pure arithmetic in `costs.mjs`; no analytics read).
- **Golf's exact records** (AI runs, agent tasks, writes, landings, CI runs) are summary rows linking to AI usage and Agent hosts.
- **Deploy:** `prepare.mjs` binds `OPERATIONS_DATABASE_ID` and `OPERATIONS_BUCKETS`. Without them, D1 rows are read account-wide
  and D1 size is not read.

**Checks:**
- `node --test cloudflare/forge/*.test.mjs`: 735 tests, 734 pass, 1 skipped, 0 fail. This includes 4 new tests in `costs.test.mjs`:
  price math, unit costs, degraded states with fetch stubbed, and administrator-only access through `handle()`.
- Web: `npm run typecheck`, `npm run build` and `npm run build:native` pass.
- `node --test web/tests/*.test.ts`: 21 tests, 19 pass. The 2 failures are the known ones on `main`: `navigation-cache` and the
  native-operations `runtime-capabilities` test.
- `deploy/alchemy/native-config.test.mjs`: 6 pass.
- Playwright `tests/estimated-costs.spec.ts`: 2 pass. Its fixture is `costs.mjs`'s own output.
- Neighbouring admin specs: `ai-models-native` passes. `instance-admin` and `capabilities` have 3 failures, the same 3 with
  `main`'s `web/` sources.
- No horizontal overflow at 1440 and 390 px.

**Not verified:**
- Nothing has been read against the live Analytics API from this code. These fields were confirmed by published documentation or
  earlier live reads on the hosted demo, but not by this code:
  - `d1StorageAdaptiveGroups.max.databaseSizeBytes`;
  - `workersInvocationsAdaptive.sum.cpuTimeUs`;
  - the `date_gt` filters on the Durable Object datasets.
- Hosted behaviour is unverified until the demo is deployed.
- Each page load sends 10 GraphQL requests, against Cloudflare's 300 per 5 minutes per user.
- The read runs in the Workspace as a concurrent read and can hold a slot for up to 5 s.
- The S5 tie-in, where a capacity request shows its cost change, is not built.

## 2026-10-15 — Scale-out S1–S3 on the hosted demo: Git, Source API and MCP reads outside the Workspace queue

[`SCALE_OUT_PLAN.md`](SCALE_OUT_PLAN.md) phases S1, S2 and the MCP part of S3 are built, deployed on the hosted demo and measured
at about 30, 60 and 110 agents in one repository. Data and method: [benchmarks/2026-10-15-scale-out](benchmarks/2026-10-15-scale-out/README.md).

**Built:**
- **S1:** the edge Worker serves `info/refs` and `git-upload-pack` itself. The grant is read again after the provider answers.
- **S2:** pushes and their advertisement, `/native/source/commit` and `/native/source/branch` run in the Worker.
  - Their order is the D1 ref reservation and its authority guard.
  - One `writeSettled` RPC runs the queue's after-write work: drains, live activity and the CI pass.
- **S3 (MCP):** read tools, `initialize`, `tools/list`, `commit_changes` and `create_branch` run in the Worker. Each repository
  read is confirmed against D1 afterwards (`confirmReadFromD1`).
- **Budgets:** API token and task budgets stay in the Workspace's memory and are charged by a `chargeBudget` RPC, which is not an
  admission.
- **Revocation semantics:** for these routes, revocation is now committed, not queued. A revocation committed before the response
  refuses it; one still waiting in the Workspace queue no longer does.

**Measured at about 110 agents** (`s2e`, against this morning's `fixed3`):

| Operation | `fixed3` | `s2e` |
| --- | --- | --- |
| Clones | 6 of 68, p50 154 s | 182 of 182, p50 3.1 s |
| Pushes | 249 of 279, p50 101 s | 471 of 478, p50 2.4 s |
| Agent commits | 167 of 203, p50 47.6 s | 163 of 163, p50 1.6 s |
| Pull requests landed | 77 of 105, p50 64 s | 111 of 149, p50 6.6 s |
| Workspace admission wait | 14–47 s | p50 0 ms, p95 1.8 s |

**Fixed along the way (each found by the runs):**
- **Automatic CI:** every write asked for an exclusive CI pass in the queue. Passes are now coalesced.
- **Merge bases:**
  - `comparison()` read up to 500 commits of each tip's ancestry when the base had moved by a merge. Past that size, pull requests
    with passing checks silently never landed.
  - It is now Git's date-ordered merge-base walk.
  - Verified on hosted: #530 landed at the first sweep after the deploy, after 18 minutes stuck.
- **Busy merges:** a merge Artifacts refused as busy (`ERR artifacts_git_receive_pack_busy`) fenced the whole repository for two to
  seven minutes. It is now settled as refused at once, and the land retries it.
- **Logging:** `golf.land_soon_skipped` and `golf.request_unconfirmed`.

**Checks:** `node --test cloudflare/forge/*.test.mjs`: 731 tests, 730 pass, 1 skipped, 0 fail. No `web/` changes.

**Open:**
- **Distance to D1:** each D1 call from the Worker costs about 100 ms against about 20 ms from the object next to the primary.
  Smart Placement for the Worker is noted as a future deploy option.
- **Rest of S3:** the Source API reads, and `RepositoryReads`' confirmation.
- **S4–S6:** per-repository coordination, runner capacity with approval, estimated costs.

## 2026-10-15 — Overlapping writes overloaded the single Workspace; a merge that was not applied is now settled

**Overlap experiment (branch `admission-overlap`, not merged):**
- Classing the D1-ordered writes (agent-host routes, reported checks, new issues, comments, pull requests and reviews) as
  overlapping passed 722 forge tests.
- Under the ~110-agent mix it made the whole demo unresponsive within eight minutes: the one Workspace Durable Object saturated.
- The bench was stopped and the Worker rolled back to `main`.
- The admission classes were the backpressure. Raising capacity needs scaling out: Durable Objects per repository, and heavy work
  (clones, packs, merges, Source API object building) moved to the stateless Worker. See
  [the benchmark README](benchmarks/2026-10-15-100-agents/README.md).

**Bug it exposed, fixed and verified on hosted:**
- **Symptom:** a landing's merge was answered with `ERR artifacts_git_receive_pack_busy` and its branch never moved. It stayed
  `DISPATCH_UNKNOWN` and fenced `mj/agent-bench-3` (`write_pending`) indefinitely. Every branch delete and landing was refused
  with 412.
- **Cause:** `pull-merge.mjs` `settle()` only recorded success, and `settleRefWrites` skips merges.
- **Fix:** two minutes after sending, a merge whose branch does not hold its commit is settled as not applied (`REJECTED`,
  `NOT_APPLIED`, repository released).
- **Verified:** after the deploy, the hosted fence cleared at the next maintenance sweep (18:11 UTC), the merge became `REJECTED`
  and its land `FAILED`.

## 2026-10-15 — 100 agents in one repository: measured on hosted, two fixes, and the remaining ceiling

Full method, data and charts plan: [benchmarks/2026-10-15-100-agents](benchmarks/2026-10-15-100-agents/README.md).

**Setup:** about 110 paced agents on `mj/agent-bench-3` for 30 minutes per run (`scripts/agent_speed_bench.mjs --think 60`).
- Git pushes and Source API commits, a branch each and on a shared branch.
- Clones.
- The whole agent loop (S7): commit, `open_pull_request` over MCP, check, landing without a person.

**Baseline:**
- Only 14 of 69 agent pull requests landed within 15 minutes. Policy landing ran only in the 5-minute maintenance sweep, at most 20 a sweep.
- 14–27 % of Source API commits were refused with 412, because a merge held the whole repository.
- p50 latencies were 14–43 s.

**Fixes (deployed):**
- `landSoon` lands a pull request when its check is reported or it opens, instead of at the sweep. A single pull request lands
  5.4 s after opening, against 193 s or more after its check before.
- Writes wait for a merge holding the repository: Source API commits within their 30 s budget, Git pushes up to 20 s.

**After (run `fixed3`):**
- 77 of 105 agent pull requests landed within 15 minutes; land p50 was 64 s.
- Commit failures from the merge fence fell to about 2 % (run `fixed2`).

**Remaining ceiling, diagnosed with Server-Timing:**
- A commit spends 14–47 s waiting in the Workspace admission queue for about 1 s of work.
- Every request of the installation goes through one Workspace Durable Object. An `exclusive` request at the head of the queue
  waits for all running transfers and blocks everything behind it.
- Agents that land faster send more exclusive requests (opening pull requests, reporting checks). In `fixed3`, deployment writes
  fell to 0.54/s while S7 succeeded.
- The proposal to class the D1-guarded operations as overlapping is in the benchmark README. It has not been built yet.

**Cleanup:** the five benchmark tokens are revoked (401), the temporary administrator credential is deleted, and the probe
branches are removed. Pull requests opened by the baseline whose branches the bench deleted remain open, with no branch; they
cannot land.

## 2026-10-15 — Review tasks: PR review by Claude Code under its OAuth sign-in (schema 48), hosted-verified

**Built:** agent tasks gain a read-only **review** mode ([AGENT_HOSTS.md](AGENT_HOSTS.md#review-tasks-schema-48)).
- A review task reviews a pull request only, with a read-only tool:
  - Claude Code `--permission-mode plan`;
  - Codex `--sandbox read-only`;
  - Grok without write allowances;
  - OpenCode is refused.
- Outbound hosts need golf-agent-host 0.2.0, reported on each heartbeat. SSH hosts use the deploy's image.
- The task is listed in `agent_task_reviews` (migration 0048) and gets no MCP endpoint.
- Its token cannot push, and its finish names no commit. The review is the summary, up to 12 KiB.
- The PR reviewer automation accepts coding CLI engines and posts the review as a comment, its only CLI output.
- "Assign to agent" on a pull request offers **Review only**.

**Hosted** (`mj/actions-demo`; schema 48 migrated; `Login`, `ControlAccess` and `PreviewAccess` noop):
1. The PR reviewer was switched to Claude Code on the agent host `beastnode1`, rebuilt as 0.2.0. Claude Code is signed in with a Claude subscription; there is no API key.
2. Run now on PR #4, which has a deliberately reversed `subtract`.
3. The review task finished in 28 s: SUCCEEDED, mode review, no commit, and the branch `golf-agent/3a4ff0d4` was never created.
4. The review:
   - named `sum.js:2` swapping the operands;
   - traced it to the "Refactor subtract" commit and the failing CI run;
   - proposed the revert;
   - noted that the earlier GLM review had misjudged one test.
5. The automation run: "Reviewed by claude, posted as a comment"; 106,039 in, 1,554 out, $0.19 as Claude Code reported.

**Checks:**
- Go: `go test ./...` in `cmd/golf-agent-host` passes (36, one opt-in real-tool test skipped).
- Forge: `node --test` for agent-hosts, ssh-hosts, automations, automation-tools, engines, agent-task-mcp and agent-worker passes. The release test passes, pinned to schema 48.
- Web: `tsc` clean.

## 2026-10-15 — SSH hosts: Cloudflare Tunnel and Workers VPC verified on hosted; installer support

**Setup:** one Cloudflare Tunnel, `golf-ssh-beastnode1`, remotely managed.
- Ingress `golf-ssh-beastnode1.mjtechguy.com → ssh://localhost:22`, with a proxied CNAME.
- `cloudflared` 2026.10.0 (sha256-checked) runs on the machine.
- A new Access application for that hostname has one Service Auth policy for a dedicated service token with a 30-day expiry. The demo's own Access applications and login provider were not touched.

**Tunnel check from the workstation:**
- With the service token, `sshd` offered `SHA256:H2UgqQbF30nuh+hOlxZxnx8LoUsOlQWzPYp/BgVSsIc`.
- Without it, Access refused the WebSocket.

**Cloudflare Tunnel reach:**
- Host `beastnode1 (tunnel)`:
  - the connection test pinned that fingerprint;
  - `sshd` accepted Golf's key from `127.0.0.1`, through the connector;
  - the host turned Ready.
- A Claude Code task on issue #7 opened Cloudflare Access from the container, ran, and pushed `golf-agent/f084279f` (`39cad1e873ad`).

**Workers VPC reach:**
- The same tunnel is bound as `SSH_VPC_NETWORK` with `enable-ssh-hosts --vpc-tunnel-id`.
  - The deployment token needed **Connectivity Directory Admin**; Bind was refused.
  - Every deploy kept `Login`, `ControlAccess` and `PreviewAccess` noop.
- Host `beastnode1 (vpc)` at `10.10.69.200:22`.
- **The first test failed**: "the Workers VPC bridge did not connect within 60 seconds".
  - The container port reported the Durable Object's connection as opened before `ssh-probe` listened, so the bridge piped into a dead connection.
  - `sshd` logged the tunnel side closing.
- **The fix:** the bridge now waits for a LISTEN socket on the port in `/proc/net/tcp`.
- **After the fix:**
  - the test pinned the same fingerprint;
  - `sshd` accepted Golf's key from `10.10.69.200`, the connector's LAN address;
  - a Claude Code task pushed `golf-agent/a5da091f` (`0ccdf3f4dee2`).

**Installer:** `scripts/golf_cloudflare.py` gains the services `secrets` and `ssh-hosts`, which requires `secrets`.
- `ssh-hosts` migrates, enables and deploys.
- `--ssh-vpc-tunnel-id` passes `--vpc-tunnel-id` and renews the deployment token first.
- Docs: `deploy/alchemy/README.md` and `docs/SSH_HOSTS.md`, including a new "Setting up reach" section.

**Checks:**
- `node --test` `ssh-hosts.test.mjs` (8) and `deploy/alchemy/native-config.test.mjs` (6) pass.
- `python3 -m unittest test_golf_cloudflare test_cloudflare_alchemy_demo` passes (63).

## 2026-10-15 — Automations verified on hosted: PR reviewer, Issue → PR, CI fixer, Clef

All runs were on `mj/actions-demo` at `https://demo.gitgolf.mjtechguy.com`. Each automation acts as `mj`.

**PR reviewer (model, Workers AI):**
- **Event-triggered:** `pull_request.opened` (PR #8) and `pull_request.updated` (a push to PR #4's head) each queued a run.
  - Both succeeded on the installation default, GLM 5.3, and posted a comment plus a private review draft.
  - PR #8: 1,088 tokens in, 173 out, no findings.
  - PR #4: one finding.
- **Engine named explicitly** (`workers-ai:@cf/zai-org/glm-5.3`):
  - Before #121, it failed with "The model's answer failed validation: not JSON". The likely cause is that the named-engine path sent no reasoning effort, so GLM spent its 3,000-token budget reasoning and answered nothing.
  - After #121 it succeeded on PR #10 (1,219 in, 252 out).

**Clef:** "Suggest labels" on `mj/agent-bench-3` issue #19 chose documentation (73%) and question (20%) from the repository's three labels. In `mj/actions-demo`, which has no labels, Clef says so and does not run.

**Issue → PR (Claude Code on the outbound agent host `beastnode1`):**
- Opening issue #9 queued a run.
- The agent task finished in 25 s and opened draft PR #10, plus a comment on the issue.
- Usage, as reported: 136,504 tokens in, 1,692 out, $0.17.
- Automation output did not trigger the PR reviewer, as designed.

**CI fixer (Claude Code on `beastnode1`):**
1. A deliberate bug (`subtract` returning `b - a`) was committed to `agent/mcp-subtract`, the head of open PR #4, through the Source API.
2. Demo CI was dispatched on that branch. The workflow runs on pushes to `main` and on dispatch only. The run failed in both Node jobs on the restored Forgejo runner.
3. The first failure (run #3) was skipped: the CI fixer only matched runs a pull request started. It now also matches a push or manual run on an open pull request's head branch (this change).
4. Run #4 then produced:
   - a comment on PR #4 with the masked log excerpt;
   - an agent task (25 s);
   - draft PR #11, which restores `a - b` and leaves the tests unchanged.
5. Usage: 105,592 tokens in, 1,215 out, $0.17.

**Runners:** the kind `golf-ci` Forgejo and GitLab runners had been crash-looping for 18 hours. Their registration was stored in an `emptyDir`, and the pods re-registered with an already-used one-time token.
- Both were re-registered with new tokens.
- Their state now sits on PersistentVolumeClaims.
- The stale registrations were deleted.
- Both show Idle.

**Seen once:** right after a deploy, `GetRepository` on `mj/actions-demo` answered 503 "Repository access could not be confirmed" for about two minutes. Other repositories were unaffected, and it cleared without action. The cause is not known.

**Not verified on hosted:**
- provider-model engines (no API key in the vault yet);
- custom automations;
- coding CLIs on SSH hosts for automations (refused by design until wired).

## 2026-10-15 — SSH hosts deployed on the hosted demo; a task over Tailscale verified

**Deploy config:** the Alchemy stack builds the SSH image and binds `SSHAgentTask` on `enable-ssh-hosts`
([SSH_HOSTS.md](SSH_HOSTS.md#deploy)).
- Every plan and deploy left `Login`, `ControlAccess` and `PreviewAccess` unchanged.
- The first deploy needed a second run: Alchemy reconciled the container application before the Worker had
  created the new Durable Object namespace.

**Hosted result:**
- `agents.ssh-hosts` is READY.
- A direct SSH host for `git@github.com:22`, used only as a probe, was registered and tested from the hosted container:
  1. the first test reported GitHub's published ed25519 fingerprint (`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`);
  2. after confirming it, the second test failed with "the host refused Golf's key for git".
- The probe host was then deleted.

**A task over SSH through Tailscale:**
- **The machine:** beastnode1, on the owner's tailnet.
  - A dedicated `golf-agent` account, with no password and no sudo.
  - Claude Code 2.1.300 is installed and signed in there.
  - Golf's key is installed with `restrict`.
- **The tailnet:**
  - The policy file gained only `tagOwners` for `tag:golf-ssh`; its ACL is allow-all.
  - The auth key is reusable, ephemeral, tagged `tag:golf-ssh` and expires after 7 days.
  - It went from the Tailscale page into Golf's form without being printed or logged.
- **The host:** `beastnode1 (ssh)`, Tailscale reach, address `100.116.90.61`.
- **The connection test:**
  1. The container joined the tailnet as the tagged ephemeral node `golf-ede5b6d1`.
  2. It was offered `SHA256:H2UgqQbF30nuh+hOlxZxnx8LoUsOlQWzPYp/BgVSsIc`, which matches
     `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the machine.
  3. After confirming the key, sshd logged `Accepted publickey for golf-agent` from a tailnet address.
  4. The host turned Ready, reporting linux/amd64 and Claude Code 2.1.300 signed in.
- **The task:** issue #7 in `mj/actions-demo` ("Add a power function with tests") was assigned to Claude Code on the SSH host.
  1. Golf cloned the repository, joined the tailnet, sent the working copy and ran `claude` on `golf-agent/aba9305a`.
  2. The task reached "Proposal ready" in 29 s: commit `fa3ffa17c738`, 2 files (`sum.js`, `sum.test.js`), pushed.
  3. Claude Code said it could not run `npm test`, because running it needs approval in the non-interactive session.
- **Afterwards:** no `golf-` node remained on the tailnet, and the remote working directory was removed.

**Not verified on hosted:**
- Cloudflare Tunnel reach;
- Workers VPC (no `SSH_VPC_NETWORK` binding).

## 2026-10-15 — Hosted checks: agent tasks on MCP, automations, vault, engines

On `https://demo.gitgolf.mjtechguy.com`, schema 47, after #113, #115, #116 and #117.

**Agent task on Golf MCP (#113):**
1. Issue #5 in `mj/actions-demo` ("Add a modulo function with tests") was assigned to Claude Code on the agent host `beastnode1`.
2. The host passed the task token to Claude Code as an environment value, with a per-task MCP config.
3. The task SUCCEEDED in about 50 s on `golf-agent/52e85837`.
4. Claude Code opened PR #6 itself through the Golf MCP tools.
5. `pull_request_origins` records PR #6 as `agent-task`, linked to the task.

Claude Code did not post the requested issue comment, and no refusal was logged, so it simply didn't try.

**Automations (#116):**
1. An issue-triage automation was created and enabled on `mj/agent-bench-3`, with the built-in defaults: engine `default`, trigger `issue.opened`, output `comment`.
2. **First issue (#19):** queued a run within seconds. It was REFUSED: "This repository has no labels for Clef to suggest".
3. **After adding three labels:** issue #20 ran through Workers AI (435 input tokens). The suggestions were documentation (0.76) and bug (0.23), and Golf posted the triage comment. No label was applied, because the default output is a comment only.
4. The automation stays enabled on `agent-bench-3` only.

**Capabilities:** READY for `settings.credentials`, `settings.engines`, `automations`, `agents.mcp`, `repository.agentic-mode`, `repository.agentic-landing` and `repository.agent-inbox`.

`agents.ssh-hosts` reports UNCONFIGURED and names what's missing. It needs these deploy changes from `docs/SSH_HOSTS.md`, which are not made yet:
- the `SSHAgentTask` container Durable Object with the image from `cloudflare/ssh-hosts/Dockerfile`;
- `SSH_HOSTS_EXECUTION=true`;
- optionally `SSH_VPC_NETWORK`.

**Not verified on hosted:**
- a provider-model engine with a real API key;
- PR reviewer, Issue → PR and CI fixer automations;
- SSH hosts, Tailscale and Cloudflare Tunnel reach, all of which wait for the container binding.

## 2026-10-15 — SSH hosts and private-network reach, agents plan phases 1b and 5 (local evidence)

**Built** ([SSH_HOSTS.md](SSH_HOSTS.md)), with schema 47 (`0047_ssh_hosts.sql`: `ssh_hosts`):

- **SSH hosts are agent hosts Golf reaches itself.** Each is an `agent_hosts` row (`credential_digest` `ssh:<uuid>`) plus
  an `ssh_hosts` row. Sharing, the admission rules, task states, deadlines, cancel, the LOST sweep and the task protocol are
  unchanged.
- **Rule 3 refuses an SSH host** whose host key is not confirmed or whose reach is unavailable.
- **Keys.**
  - Golf generates an Ed25519 key per host in the Worker.
  - The private key and reach secrets are sealed with the credential vault's `sealSecret` (context
    `ssh-host:<uuid>:key` or `:reach`).
  - The public key is shown with an `authorized_keys` line (`restrict …`). Rotate key replaces the pair.
- **Explicit trust on first use.**
  - A connection test reads the offered host key without authenticating, and Golf computes the fingerprint.
  - `trustHostKey` pins only the fingerprint the latest test was offered.
  - A different key fails every connection before authentication.
- **Execution.**
  - On create, Golf claims the task itself, with no polling, and hands it to the new `SSHAgentTask` container Durable
    Object.
  - The container runs `golf-agent-host ssh-run` with the job on standard input. It clones with the task token, then
    sends the SSH host a working copy (no token, no remote) and the prompt.
  - It runs the CLI there with the outbound host's flags, streams the log, polls cancel, brings back the tree, then
    commits with the agent identity and `Golf-Agent-Task` trailer, pushes `golf-agent/<id8>` and finishes. The finish is
    verified as for outbound hosts.
  - New Go code is in `ssh_conn.go`, `ssh_run.go` and `ssh_tar.go`; `main.go` only gains the `ssh-run` and `ssh-probe`
    subcommands.
- **Reach.**
  - Direct TCP.
  - Tailscale: an ephemeral userspace node, a sealed auth key and tags, `tailscale nc`, and logout at the end.
  - Cloudflare Tunnel: `cloudflared access ssh`, with an optional Access service token.
  - Workers VPC: a Durable Object bridge from `getTcpPort().connect()` to the `SSH_VPC_NETWORK` binding. It reports itself
    unavailable until that binding exists.
- **API and capability.**
  - `POST /native/ssh-hosts` (`list`, `create`, `update`, `test`, `trustHostKey`, `rotateKey`, `delete`), audited as
    `ssh_host.*`.
  - Capability `agents.ssh-hosts`: UNCONFIGURED, with what is missing, until the container binding and
    `SSH_HOSTS_EXECUTION` exist.
  - `/native/agent-hosts list` no longer lists SSH hosts, and `delete` refuses them.
- **UI.**
  - Settings → Agent hosts gains SSH hosts: the inventory in the shared DataTable, Add SSH host (TanStack Form,
    reach-specific fields), Install Golf's key, Test connection, Review host key, then Trust, Connection, Key and Delete.
  - Edit reuses the agent host sharing form.
  - The assign dialog labels SSH hosts.
- **Image:** `cloudflare/ssh-hosts/Dockerfile`, with golf-agent-host, Git, Tailscale 1.104.1 and cloudflared 2026.10.0,
  both SHA-256 pinned.

**Evidence (local, not hosted):**

- `cloudflare/forge/ssh-hosts.test.mjs`, 7 tests:
  - capability and reach states;
  - vault sealing contexts;
  - create: a sealed key that opens to the shown public key, and no secret in rows, views or audit;
  - validation and management by scope;
  - pinning only from a confirmed test: a forged fingerprint is ignored, a mismatch keeps the pin and the tools;
  - assignment: refused before the pin, claimed with a minted token, the protocol with that token, empty-chunk cancel
    polling, concurrency, sweep dispatch, `ssh_dispatch_failed`, LOST and delete;
  - the Durable Object with a mocked container: job only on stdin, token dropped after launch, cancel grace, loss, a
    stale token, probe recording.
- Full suite `node --test cloudflare/forge/*.test.mjs`: 693 tests, 692 pass, 1 skipped (main at 536f934: 686, 685, 1).
- `agent-hosts-runtime-check.mjs` passes in real workerd, D1 and Durable Objects at schema 47.
- A Miniflare check generates Golf's Ed25519 key in real workerd (48-byte PKCS#8, fingerprint equal to `parseHostKey`).
- `go test ./cmd/golf-agent-host/` passes, including `-race` for the SSH tests. `ssh_test.go` runs a real OpenSSH
  server (`/usr/sbin/sshd`, a temporary configuration, this user, a free port) and checks:
  - the probe without a pin, with a pin, against another key and with Golf's key not installed;
  - `ssh-run` succeeded (the branch, the trailer, the token absent from the remote tool's environment and argv, remote
    work removed), no_changes, failed and folded commits;
  - cancel from a log answer and from the silent-tool poll, and the deadline;
  - a mismatched key refused before anything reached the host;
  - the Tailscale, cloudflared and Workers VPC paths through stand-in helpers: the auth key only through
    `--auth-key=file:`, `--state=mem:`, tags, logout, and the Access token in the environment;
  - tar escapes refused;
  - job validation.
- `docker build --platform linux/amd64 -f cloudflare/ssh-hosts/Dockerfile .` succeeds (not pushed). `ssh-probe` from that
  image, run with host networking against a local sshd and a key from Golf's own JavaScript generator, reports the host
  key (fingerprint equal to `ssh-keygen -lf`), signs in, and reports `linux/amd64` and a stand-in Claude Code signed in.
- `web/tests/native-ssh-hosts.spec.ts`: 3 tests pass against a mocked backend:
  - the inventory, Add, install key, test, review and trust, then ready;
  - Tailscale fields sent once and never shown;
  - the unavailable state.

  `native-agent-hosts.spec.ts` still passes (14 passed, 4 screenshot tests skipped). `tsc -b` is clean.

**Deploy changes needed:** in [SSH_HOSTS.md](SSH_HOSTS.md#deploy-changes-needed):
- a container application with image key `ssh`;
- the `SSHAgentTask` SQLite Durable Object with that container, and its migration;
- `SSH_HOSTS_EXECUTION=true`;
- the existing `EXECUTION_VALUE_KEY`;
- optionally, a `vpc_networks` binding named `SSH_VPC_NETWORK`.

`deploy/alchemy` was not edited.

**Not done:**
- a hosted run: Containers egress to SSH, and Tailscale and cloudflared inside Cloudflare Containers;
- Workers VPC against a real network;
- Golf MCP for SSH host tasks, deliberately not offered so the token never reaches the host;
- tested non-POSIX login shells;
- a per-host Codex sandbox switch.

## 2026-10-15 — Automations: framework and first built-in tools (agents plan phase 2b, schema 46; local evidence)

**Built:** `docs/AUTOMATIONS.md`, migration `0046_automations.sql`, `src/automations.mjs`, `src/automation-engines.mjs`, `src/automation-tools/*`.
- **Definitions:** at repository, organization and installation scope, under the new `automations` feature policy.
  - Each one has triggers (events and schedules on Durable Object alarms), targets, an engine and a place, versioned instructions, outputs, limits (per day, concurrency, maximum open PRs, de-duplication), a kill switch and audit.
- **Built-in tools:**
  - **PR reviewer:** an AI review draft that a person publishes.
  - **Issue triage:** labels, duplicates from semantic search, and a needs-information comment.
  - **Issue → PR** and **CI fixer:** agent tasks on agent hosts, opening draft PRs.
  - **Custom.**
- **Engines:** model automations resolve through the engines registry (#115), with the installation's Workers AI selection as the default.
- **Output:** output is neutralized and marked automated and unverified. Nothing is merged.
- **UI:** Settings → Automations at repository, organization and admin scope.

**Verified locally:**
- the forge suite: 709 tests, 708 pass, 1 skipped, including `automations.test.mjs` and `automation-tools.test.mjs`;
- `automations-runtime-check.mjs` and `ai-runtime-check.mjs` in real workerd;
- `tsc`;
- `automations.spec.ts` with `credential-vault.spec.ts`: 15 passed.

**Not verified:**
- hosted;
- SSH-host and cloud-sandbox places;
- learning from dismissed comments;
- the rest of the built-in library (phase 4).

## 2026-10-15 — Credential vault and engines, agents plan phase 2a (local evidence)

**Built** ([CREDENTIAL_VAULT.md](CREDENTIAL_VAULT.md), [ENGINES.md](ENGINES.md)), with schema 45 (`0045_credential_vault.sql`: `vault_credentials`,
`vault_credential_grants`, `engines`, `engine_selections`, `ai_run_engines`):
- **Credential vault** (`vault.mjs`):
  - API keys at user, organization and installation scope, and personal subscription sign-ins (token files);
  - envelope encryption: a data key per value, wrapped by the existing `EXECUTION_VALUE_KEY` Secrets Store key, bound to credential id and version;
  - lists hold metadata only (last 4 characters of API keys); rotate and revoke;
  - explicit grants to a person, an organization, a repository or everyone, limited by engine and place;
  - `credentialFor()` returns an unforgeable handle or a refusal, audited as `credential.use_denied`;
  - subscription use is refused: "cloud sandboxes are phase 3";
  - `sealSecret` / `openSecret` exported for other stores (SSH host keys).
- **Engines** (`engines.mjs`):
  - built-in Workers AI engines, plus stored Cloudflare-model, provider-model (OpenAI, Anthropic, xAI, Google) and coding-CLI engines;
  - selection per use case at installation, then organization, then repository, each only where the level above allows it;
  - AI runs (review drafts, intent summaries, release notes, triage) now resolve through engines: with no selection they run the AI models
    choice unchanged; a stored engine is recorded per run and re-checked before inference;
  - provider calls go through `env.AI.gateway(id).run`, with the key only in the outbound headers;
  - stable `listEngines` / `resolveEngine` / `runChat` interface for the automation framework.
- **API:** `POST /native/credentials` and `/native/engines`; capabilities `settings.credentials` and `settings.engines`; audit categories
  Credentials and Engines.
- **UI** (inventory first, TanStack Form, shared DataTable):
  - Settings → Credentials and engines;
  - Organization settings → Credentials and Engines;
  - Admin → Credentials and Engines;
  - an Engines panel in repository settings;
  - AI models points to Engines.

**Evidence (local, not hosted):**
- `cloudflare/forge/vault.test.mjs`, 8 tests:
  - sealing round-trip, context, key and tamper checks;
  - no plaintext in any answer, D1 table or audit row;
  - rotation, revocation, grants by person, organization, repository, engine and place;
  - scope hierarchy, subscriptions, capability and audit category.
- `cloudflare/forge/engines.test.mjs`, 7 tests:
  - the default resolution equals `aiModel` for every use, and a default run still calls Workers AI with the same model;
  - precedence and override withdrawal; fallback with a note for a disabled engine;
  - Anthropic and OpenAI request shapes through a mocked gateway, with the key only in the outbound headers;
  - usage recorded on the run; refusal at admission and before inference;
  - `listEngines`, `resolveEngine` and `runChat`; xAI and Google shapes;
  - a provider error never carrying the key.
- Full suite `node --test cloudflare/forge/*.test.mjs`: 681 tests, 680 pass, 1 skipped (main: 666, 665, 1).
- `ai-runtime-check.mjs`, `ai-review-runtime-check.mjs` and `ai-kinds-runtime-check.mjs` pass in real workerd.
- `web/tests/credential-vault.spec.ts`: 4 tests pass against a mocked backend:
  - the personal inventory, Add API key, Share, Rotate and Revoke;
  - the subscription warning and terms gate;
  - admin engine selection and New engine;
  - an organization member's read-only view.

  The related specs (ai-models-native, api-tokens, native-agent-hosts, organization-admin, organization-settings-navigation,
  native-installation-settings, settings) pass. `instance-admin.spec.ts` fails 2 tests identically with main's UI files.

**Deploy changes needed:** none. The vault uses the existing `EXECUTION_VALUE_KEY`; provider engines use the existing `AI` binding,
`EVIDENCE_ALLOW_AI` and `EVIDENCE_GATEWAY`.

**Not done:**
- hosted run against real providers;
- per-credential spend caps;
- re-wrapping envelopes after an installation key rotation;
- OAuth or device-code sign-in for subscriptions;
- running coding-CLI engines;
- teams as grantees;
- the automation framework itself (phase 2b).

## 2026-10-15 — AM-6 verified on the hosted demo; shared-branch commits fixed

On `https://demo.gitgolf.mjtechguy.com` (`mj/agent-bench-*`), after #108 to #112. Evidence is in `docs/compatibility/evidence/agent-speed-20261015-hosted-am6-*.json`.

**Blame and grep (#110), browser session on `agent-bench-3`:**
- Grep for `Note 1` returned 7 matches with path, line and column.
- `regex: true` was refused with 400 `regex_unavailable`.
- Blame of a file edited by two agents attributed line 2 and line 18 to their own commits, and the rest to the commit that added the file.

**Line-level merge (#109):** two commits from the same stale head, editing lines 2 and 18 of `docs/shared.txt` with `onStale: merge`. The second came back `merged: true`, and the file holds both edits. A third edit to line 2 was refused with 409, `both_modified` on that path.

**Rate budgets (#108):** S6 at 16 writers with one API token. After about 60 writes, including branch creations, further commits got 429 "API token budget: 60 writes per minute reached; retry in 36 s.". The branch-creating push was refused in Git's own report.

**Shared-branch commits (#112):** the budget was raised temporarily (a widening change, confirmed and audited) and restored to 60 afterwards.

| 16 writers on one shared branch (`onStale: merge`) | Successes |
| --- | --- |
| Before #109 (path-level merge) | 13/63 |
| After #109 (line-level merge) | 15/69 |
| After #112 | **36/36**, p50 11.8 s |

- **After #109:** the failures were not conflicts. They were "another write … stayed in flight; nothing was committed after 3 attempts" and a false 412 "access changed".
- **#112:** a commit waits for the branch's turn and re-merges for up to 30 s. A failed reservation whose authority guard still holds is now a lost race.
- **Throughput:** a branch per writer reached 64/64 at 2.43 writes/s.

**Decision on the per-repository `RepositoryWrites` split (AM-1 item 5): deferred.**
- **Current capacity:** the deployment sustains about 2.4 Source API writes per second (about 145 a minute) with every commit succeeding. That covers the target of 100 agents in one repository each writing about once a minute.
- **When to revisit:**
  - sustained 429 "Workspace is busy" responses;
  - p95 write latency above 30 s at the expected concurrency;
  - a need for more than about 2 writes per second across the deployment.
- **Scope when needed:** move transfers into a per-repository Durable Object. The D1 fences stay authoritative.

**Cleanup:** the benchmark API token is revoked, and agent rate budgets are back to the defaults.

## 2026-10-15 — AM-3 item 4: coding agents on hosts use Golf MCP with their task token (local evidence)

**Built:** a running agent task's own token (`golf_agent_task_…`) works on `/mcp` and `/native/source/*` ([AGENT_ACCESS.md](AGENT_ACCESS.md#agent-task-tokens), [AGENT_HOSTS.md](AGENT_HOSTS.md#golf-mcp-for-the-task)).
- **Server:** `api-tokens.mjs` `taskTokenActor` acts as the requester, scoped to the task's repository, `write`, exactly `golf-agent/<8 hex>`.
  - Only while the task is `RUNNING`, not cancel-requested, before its deadline and while the requester writes; Source API writes re-check that in the ref reservation (`token_guard`).
  - Not on `/git/` or any other route; the public Worker skips Access for it only on `/mcp` and `/native/source/*`.
  - `open_pull_request` only from the task branch, recorded as origin `agent-task`; `comment` only on the task's issue or pull request, or a pull request from its branch.
  - Calls count against the task's rate budget; scope refusals are audited with `agentTaskId`.
  - Claim adds `mcp: { url }` (`null` while `agent-access` is off for the repository).
- **Host:** `golf-agent-host` connects each CLI for that task only, with the token as `GOLF_MCP_TOKEN` in its environment (never argv, a file or a log): Claude Code `--mcp-config` (0600 file in the task directory, removed after the run) and `--allowedTools mcp__golf`; Codex `-c mcp_servers.golf.*` with `bearer_token_env_var`, approved tools and the default env excludes on; OpenCode `OPENCODE_CONFIG_CONTENT` with `{env:…}`. Grok is not connected (MCP only from its `config.toml`).
  - The host appends a "Golf MCP tools" section to the prompt. A branch the tool published through MCP is adopted as the proposal; local changes it lacks fail the task (`branch_published`).

**Evidence (local, not hosted):**
- `cloudflare/forge/agent-task-mcp.test.mjs` (5 tests): reads; scope and audit; budget kind `task`; refused on `/git/` (Bearer and Basic), RPC and account routes, and when finished, claimed, cancel-requested, expired or the requester lost write; Access bypass; claim `mcp`; over a real bare repository, branch-only `commit_changes`/`create_branch`, `open_pull_request` with origin `agent-task`, comment limits, and a cancel between admission and reservation writes nothing.
- `node cloudflare/forge/agent-hosts-runtime-check.mjs "$(command -v cf)"` passes on real workerd/D1/DO with the task token on `/mcp` (issue read, off-branch commit refused, pull request with origin `agent-task`, `/git/` refused, 401 after finish).
- `go vet ./cmd/golf-agent-host/` and `go test ./cmd/golf-agent-host/` pass (per-task configs, no token in argv or files, 0600 and removal, origin check, published-branch adoption).
- Real CLIs through the host against a stub `/mcp` (`GOLF_AGENT_HOST_REAL_MCP=1 … -run TestRealTools`): Claude Code 2.1.300, codex-cli 0.162.1 (`danger-full-access`, as bubblewrap is unavailable here) and opencode 1.18.35 each called the stub tool and committed its answer.
- Full suite `node --test cloudflare/forge/*.test.mjs`: 671 tests, 670 pass, 1 skipped (main: 666, 665, 1).

**Not done:** a hosted task using the hosted `/mcp`; Grok; the stored task prompt (server preamble) still says not to open pull requests, and the host's appended section overrides it for MCP tools.

## 2026-10-15 — AM-6 blame and exact text search as Source API reads (local evidence)

**Built:** `POST /native/source/blame` and `POST /native/source/grep` ([SOURCE_API.md](SOURCE_API.md)), with MCP read tools `blame` and `grep` ([AGENT_ACCESS.md](AGENT_ACCESS.md)).
- Both are Workspace reads, like `files` and `tree`. They need a grant and are narrowed by a token scope.
- **Blame:** follows first parents, up to 500 commits and 4 MiB of versions. Lines open at a bound belong to the stopping commit, with `complete: false` and the reason. Renames are not followed.
- **Line diff:** `line-diff.mjs` ports Git's xdiff Myers path as `git blame` runs it (tail trim, record cleanup, split cut-offs, compaction with the indent heuristic). It is separate from the diff3 work in `text-merge.mjs`.
- **Grep:**
  - a literal pattern (case-sensitive or not), with `:(glob)`-style path globs; `regex: true` is refused (`regex_unavailable`) because a hostile pattern would stall the workspace that serves every request;
  - binary files and files over 1 MiB are skipped and counted;
  - bounds: `maxResults` ≤ 500, 5,000 files, 32 MiB, 50,000 tree entries, 10 s, each named when hit;
  - the isolate keeps the last 32 answers per commit.

**Evidence (local, not hosted):**
- `cloudflare/forge/source-reads.test.mjs`, 8 tests against a real bare repository:
  - blame equals `git blame --first-parent` across edits, a merge, repeated lines, a missing final newline, `-L` ranges and older refs, and at the 500-commit and 4 MiB bounds (equal to `git blame <boundary>..<ref>`);
  - the line diff equals Git on 60 adversarial small edits, a 1 KiB-plus common tail and a 3,000-line rewrite;
  - grep equals `git grep -n --column -I` (literal, `-i`, `:(glob)` pathspecs, `maxResults`); a regex request is refused;
  - every bound, unsafe-pattern refusals, scope refusals and the MCP tools.
- Before landing, an ad hoc fuzz run also matched `git blame` in 1,500 small cases, 360 edits to files of 300 to 8,000 lines, and 20 rewrites of 20,000 lines.
- `node cloudflare/forge/source-api-runtime-check.mjs "$(command -v cf)"` passes in real workerd with blame and grep equal to git.
- Full suite `node --test cloudflare/forge/*.test.mjs`: 646 tests, 645 pass, 1 skipped (main: 638, 637, 1).

**Not done:**
- hosted run and speed numbers;
- rename/copy following;
- regular-expression search (needs the scan to run outside the workspace);
- grep's time bound is checked between file reads only.

## 2026-10-15 — AM-6 line-level three-way merge (diff3), verified locally

**What changed:** Golf merged a file both sides changed only by path. Edits to different lines of one file now merge, in every merge:
- pull request merges and squashes;
- lands and automatic reverts;
- Source API commits with `onStale: "merge"`.

**`text-merge.mjs`** (new): `mergeText(base, ours, theirs)` has the outcome of `git merge-file` (default Myers diff, default conflict style).
- It follows git's xdiff Myers pipeline: trimming, discarding lines without a counterpart, O(ND) with cost cut-offs, and group sliding.
- A clean merge gives identical bytes, line endings included. Overlapping or touching edits conflict, as in git, and the hunks are reported. No markers are written.
- Not merged:
  - `binary`: a NUL in the first 8000 bytes, or invalid UTF-8;
  - `too_large_to_merge`: over 1 MiB or 50,000 lines.

**`tree-merge.mjs`:**
- **When:** a regular file both sides changed, with the same mode on every side. Add/add merges against an empty base, like git.
- **Output:** a clean result is a new blob in `objects`, so callers pack it with the trees.
- **Budget:** files are merged one at a time, at most 200 files and 16 MiB read per merge (`merge_budget`).
- **Without `readBlob`:** a repository that cannot read blobs keeps path-level conflicts.

**Other code changes:**
- `source-api.mjs`: a minimal change. The request overlay now also serves the blobs of the commit being merged (`readBlob`).
- `pull-merge.mjs`: comments only.

**Differences from git:**
- `git merge` / `merge-tree` use histogram diff. Where Myers and histogram align repeated lines differently, a merge can differ or conflict.
- Golf is stricter for non-UTF-8 text, files over the bounds, and a mode change on one side combined with a content change on the other.

**Evidence (local):**
- `text-merge.test.mjs` compares 684 cases with `git merge-file -p`:
  - hand-written cases, both ways round;
  - edits at every distance;
  - CRLF and no final newline;
  - 400 fixed-seed random cases;
  - churn that hits the diff cost heuristics;
  - files at 50,000 lines and 1 MiB.
- `tree-merge.test.mjs` merged trees equal `git merge-tree --write-tree`, and the packed blobs pass `fsck --strict` in a fresh repository. Conflict, binary, too-large and budget cases are also covered.
- `source-api.test.mjs` covers `onStale: merge` on one file.
- `merge-runtime-check.mjs` has a new case: two pull requests edit different lines of `notes.txt`. Both merge in workerd, and each tree equals `git merge-tree`.
- The `merge`, `source-api` and `land` runtime checks pass.
- `node --test cloudflare/forge/*.test.mjs`: 648 tests, 647 pass, 1 skipped, against 638 tests, 637 pass, 1 skipped before. One core test fixture now serves its placeholder blobs as one-line text.

**Not verified:**
- No hosted run yet.
- S6 shared-branch commit success has not been re-measured.
- Worst case: adversarial 50,000-line files take about 1 s of CPU per file in Node.

## 2026-10-15 — AM-6 rate budgets for each API token and agent task (local evidence only)

**What exists**
- Each API token (`golf_pat_`) and each agent-host task has a budget of requests and
  writes per minute. The defaults are 600/60 for tokens and 600/120 for tasks.
- Writes are:
  - pushes;
  - `/native/source/commit` and `/native/source/branch`;
  - the MCP write tools.
- Over budget, the refusal names the budget and when to retry:
  - Git push: Git's own report, `budget: …`;
  - Git fetch: 429 `text/plain`;
  - MCP: a tool error (HTTP 200, `isError`);
  - Source API and the task JSON routes: 429
    `{code: resource_exhausted, message, retryAfter}`.
  - Every refusal carries `Retry-After`.
- People (Access sessions, `golf_native_` and `golf_git_` credentials) are never
  counted.

**How**
- `cloudflare/forge/src/agent-budgets.mjs` keeps a fixed one-minute window per key in
  the Workspace Durable Object's memory. No new binding and no D1 write per request.
- Memory is bounded: idle keys go after 2 minutes, with at most 10,000 keys (least
  recently used dropped first).
- It is a throttle, not a quota: a Workspace restart starts every window again.
- Deviation from the plan: the plan named the Workers Rate Limiting binding. Bindings
  belong to the deploy scripts, so counting happens in the Workspace instead.
- Charging happens at the routing layer: `core.mjs` for `/git/`, `/native/source/*`
  and `/mcp` (the tool name is read from the JSON-RPC body), and
  `agent-host-protocol.mjs` for task routes, once the token is known. `mcp.mjs` and
  `source-api.mjs` are unchanged.

**Policy**
- The installation setting `agent-budgets` has `enabled` and four limits, each 1 to
  100,000.
- It is edited in Admin → Installation with the existing versioning, widening
  confirmation and audit.
- The Workspace reads it at most once a minute, and an admin save applies to the next
  request.
- Settings → API tokens shows each token's current window against the budget.

**Checks run**
- `node --test cloudflare/forge/*.test.mjs`: 647 tests, 646 pass, 1 skipped. Before
  the change: 638 tests, 637 pass, 1 skipped. The 9 new tests are in
  `agent-budgets.test.mjs`.
- `npx tsc --noEmit -p web`: clean.
- Playwright `agent-budgets.spec.ts`, `api-tokens.spec.ts` and
  `native-installation-settings.spec.ts` with a mocked backend: 15 passed, 5 skipped
  (review screenshots).

**Not verified:** a hosted run, and re-running the bench with budgets on.

## 2026-10-15 — AM-5 agentic inbox and intent summaries walked through on the hosted demo

**Inbox:** `https://demo.gitgolf.mjtechguy.com/mj/agent-bench-3/agents`, with agentic mode on, shows:
- **In progress:** 0.
- **Ready to land:** 0.
- **Needs a person:** 1, PR #11 adding `.github/workflows/bench.yml`, with its sensitive-path reason.
- **Landed:** 16 recent landings, including #17, landed by the policy and shown as reverted by `77440cc`.

**Intent summary:** "Summarize intent" on #11 ran Workers AI (`@cf/zai-org/glm-5.3`) through the installation's AI Gateway and stored it once for head `8051eaa8f277`. The panel, marked "AI-written":
- describes the change;
- names its areas (CI workflows, GitHub Actions);
- lists three accurate risks: the empty `jobs` map, triggering on every push, and no benchmark actually added;
- shows confidence, coverage (1 of 1 files, 0.1 KiB of 48 KiB) and the model;
- links to the diff.

**Not verified on hosted:**
- "Land selected" from the inbox (the same `/native/land` path verified in the AM-4 run);
- live updates while a task runs;
- the inbox in all nine layouts.

## 2026-10-15 — AM-4 landing verified on the hosted demo (exit criteria met)

On `https://demo.gitgolf.mjtechguy.com`, repository `mj/agent-bench-3`, schema 43, after #100, #103 and #104.

**Setting:** agentic mode on, low-risk paths `docs/**`, the default sensitive paths, landing without a person on, required check `bench/ci`, revert on failure on. Checks were reported through `/native/repository-check`.

**Policy evaluation**
- Ten docs-only pull requests evaluated `land`: "every changed path is low-risk, landing without a person is on and every required check passed".
- One that adds `.github/workflows/bench.yml` evaluated `needs_person` as sensitive, cannot be landed, and is not on `main`.

**Concurrent landing**
- **First run, before #103:** ten lands requested at once ended 5 LANDED and 5 FAILED after 5 attempts (about 12 s). Two failures falsely reported lost write access.
- **#103:**
  - a land waits its turn while another write holds the repository, within 45 s;
  - a 404 while the account still writes is contention;
  - a merge the provider refuses with `ng`, whose branch does not hold the merge commit, is `REJECTED` and releases the repository at once instead of staying unknown.
- **Re-run after #103:** ten lands requested at once, the five that had failed plus five new ones, all LANDED in 22.5 s (1–10 attempts each).
- **Result:** `main` has all 15 notes, 15 merge commits, and `git fsck --strict` is clean.

**Landing without a person and revert**
1. PR #17 (docs-only, `bench/ci` passing) was landed by the maintenance sweep with `trigger: policy`, commit `4a3484f`.
2. Reporting `bench/ci` as failed on the landed commit led, within one sweep, to:
   - revert commit `77440cc` by `Golf (agentic mode) <agentic@golf.invalid>` ("Automatic revert: required checks failed after landing: bench/ci");
   - the land operation set to `REVERTED`;
   - issue #18 assigned to `mj`.
3. After the revert, `main`'s tree equals the tree before the landing, and fsck is clean.

**Also found and fixed:** `git clone` of a repository with many branches failed with HTTP 400 "Invalid Git content.". Git gzips large fetch requests and `/git/` refused any `Content-Encoding`. #104 decompresses gzip with the same 8 MiB bound. A full clone of `agent-bench-3` (21 branches) now works.

**Cleanup:**
- The temporary API tokens are revoked, and a revoked token gets 401 on `/mcp`.
- The one-hour Git credentials have expired.
- Agentic mode stays on for `agent-bench-3` only.

**Not verified:** the agentic inbox walkthrough (AM-5) and intent summaries on hosted.

## 2026-10-14 — Agentic inbox and intent summaries (agentic mode AM-5, first slice, schema 43)

See `docs/AGENTIC_MODE.md`, "Inbox and intent summaries". This adds:
- `agent-inbox.mjs`: `POST /native/agent-inbox/read` (`inbox`, `summary`; reads overlap)
  and `/native/agent-inbox` (`summarize`), for signed-in browser sessions only.
  Capability `repository.agent-inbox`. The inbox lists:
  - agent tasks queued, claimed or running;
  - open pull requests ready to land (`land`, `waiting_checks`);
  - open pull requests that need a person (`needs_person`, `blocked`, or not evaluable),
    with reasons, sensitive paths and conflicts;
  - recent landings and reverts from `land_operations`, read only when that table
    exists (AM-4 item 4). Otherwise it reports `landingHistory: 'unavailable'`.

  It evaluates at most 25 open pull requests per read, newest first, with the existing
  agentic-mode `evaluate` (now exported), and says when it stopped early.
- Intent summaries (`ai-intent.mjs`, migration `0043_intent_summaries.sql`,
  `pull_intent_summaries`): an AI run kind `intent-summary` through the existing AI
  runs. That means the same limits, gateway, model selection (`review-drafts`), feature
  (AI review drafts) and usage recording. The input is at most 48 KiB of whole diff
  files, and the rest are named. The output is strict JSON with `intent`, `areas`,
  `risks` and `confidence`. The summary is stored once per head commit with the model
  id, when the run settles, through a new optional `settled` hook of AI kinds. It is
  regenerated only for a new head. A summary request without Workers AI or with the
  feature off is refused with the reason. Requests are audited as `ai.run_request`.
- `ai-review.mjs` exports its bounded diff preparation (`preparePullDiff`, `pullTarget`);
  `ai-workflow.mjs` exports `createAiRun`.
- Web: `/:owner/:repo/agents` is the inbox while agentic mode is on. It has four
  sections in the shared DataTable, live updates from the repository activity stream,
  and **Summarize intent** / **Show intent** in a panel marked AI-written that links to
  the diff. **Land selected** appears only when the Worker reports
  `repository.agentic-landing`. Otherwise the existing Agent workspace view stays.

Verified locally:
- `node --test cloudflare/forge/*.test.mjs`: 628 tests, 627 pass, 1 skipped. Before
  this change: 621, 620, 1 skipped. The 7 new tests are in `agent-inbox.test.mjs`:
  - sections;
  - bounds and the truncation flag;
  - browser-only access and permission refusals;
  - the land table absent, then present;
  - summaries stored once per head and regenerated for a new head, with the 48 KiB
    input bound;
  - invalid model answers;
  - AI unavailable or turned off by a policy.
- Runtime checks with the schema 43 assertion pass: `ai-runtime-check`,
  `search-runtime-check`, `environments-check`, `agent-hosts-runtime-check` and
  `ui-check`. `ui-check` needs `web/dist-native`, built with
  `vite build --config vite.native.config.ts`.
- `npx tsc --noEmit -p web` is clean.
- Playwright `agent-inbox.spec.ts`: 6/6 pass. `native-agent-hosts.spec.ts`,
  `agentic-mode.spec.ts` and `pull-ai-draft.spec.ts` pass.
- `repository-routes.spec.ts` has 2 failures (workspace frame alignment and the runner
  chooser). They fail the same way on this branch with the web sources of main.

Not done:
- No revert action and no batch approval in the inbox.
- Agent branches are not hidden from the branch list (AM-5 item 3).
- The browser spec covers the default layout only, not all nine. No hosted walkthrough.
- The batch land request (`/native/land` `{ action: 'land', number, headCommitId,
  idempotencyKey }`) must be checked against the land queue's contract when AM-4 item 4
  lands. It is hidden until the Worker reports `repository.agentic-landing`.

## 2026-10-14 — Landing without a global lock and automatic revert (agentic mode AM-4 items 4 and 5, schema 42)

See `docs/AGENTIC_MODE.md` → Landing. This adds:
- Migration `0042_land_operations.sql`, table `land_operations`. It has one row per
  attempt to land a pull request:
  - `trigger`: `person` or `policy` (actor 0);
  - `state`: `QUEUED`, `LANDING`, `LANDED`, `NEEDS_REBASE`, `BLOCKED`, `FAILED` or
    `REVERTED`;
  - the head, base, landed and revert commits;
  - `attempts` and a JSON `detail`;
  - an optional per-account idempotency key.

  At most one land per pull request is in flight. Capability
  `repository.agentic-landing`.
- `land-queue.mjs`. A land is the existing native merge (`standardPullMerge`, with
  its journal, three-way plan, reservation and readback) onto the current base tip.
  - `pull-merge.mjs` only gained an optional authority and commit identity for the
    policy.
  - `POST /native/land` is a transfer: lands of different pull requests overlap.
  - A moved base or a busy repository is re-planned and retried up to 5 times, with
    jittered backoff from 200 ms to 2 s.
  - Overlapping paths end in `NEEDS_REBASE` with the paths. An agent-task pull
    request gets a comment offering a follow-up task; Golf never starts one.
  - A landed base push records a pipeline push intake.
- `POST /native/land` (`land`: `headCommitId` or `expectedHeadCommitId`, `method`,
  `idempotencyKey`) and `/native/land/read` (`list`, `get`), for browser sessions.
  - A writer may land when the policy says `land`, or only asks for a qualifying
    approval and the writer is not the author. Everything else is refused with the
    policy's reasons.
  - `evaluate` now also returns `canLand`.
  - Audited as `agentic_mode.land`.
- Landing without a person. A finished pipeline run (`PipelineRun` →
  `afterPipelineRun`) and the maintenance `indexes` stage (`sweepLanding`, at most 20
  evaluations) land pull requests whose evaluation is `land`.
  - The commits are by `Golf (agentic mode) <agentic@golf.invalid>`.
  - The accountable account is the administrator who saved the setting. The policy's
    authority (grant, setting version, Land without a person) is rechecked with each
    reservation.
  - Audited as `agentic_mode.auto_land`.
- Checks after landing. The required checks of the landed commit (the named ones, or
  every pipeline for that commit) are evaluated when its runs finish and during
  maintenance.
  - A failure on a policy landing with Revert on failure on is reverted: an inverse
    three-way merge onto the current tip, committed through `source-api.mjs`
    `commitTree` (the branch fence, readback and pipeline intake).
  - Then Golf comments on the pull request and opens "Automatic revert of #N: checks
    failed", assigned to the requester.
  - A revert conflict keeps the land `LANDED` with `detail.revertConflict` and opens
    the issue instead.
  - People's landings get a comment only.
  - One verdict and one revert per land, by a conditional claim.
  - Audited as `agentic_mode.revert`.
- Web:
  - the pull request **Landing** panel has **Land** (a TanStack Form confirmation with
    merge or squash) and the latest land operation;
  - **Settings → Agentic mode** has **Recent landings** in the shared DataTable (50
    loaded, labeled).

Verified locally:
- `node --test cloudflare/forge/*.test.mjs`: 630 tests, 629 pass, 1 skipped. Before
  this change: 621, 620, 1 skipped. `land-queue.test.mjs` adds 9 tests, over node:sqlite
  and a real bare repository through `git receive-pack`. They cover:
  - refusals, idempotent replay, reads and audit;
  - two concurrent lands, the second retried onto the moved base;
  - a base moving between read and merge (re-planned);
  - a moved head;
  - conflicts found by evaluation and during the merge, with the agent comment;
  - policy gating (setting, feature policy, lost grant);
  - a revert with the same tree as `git merge-tree` for `git revert -m 1`, run once;
  - a revert conflict;
  - a person's failed landing commented on;
  - settling an interrupted land.
- `land-runtime-check.mjs` passes on real workerd/D1 with `git receive-pack`:
  - two concurrent lands, one retried onto the moved base, whose tree equals
    `git merge-tree`;
  - a policy land committed as Golf;
  - an automatic revert after a failed push pipeline, whose tree equals a real
    `git revert -m 1` in a clone. The issue is assigned and the revert runs once.
- These pass with the schema 42 assertions: `merge-runtime-check`,
  `source-api-runtime-check`, `environments-check`, `ai-runtime-check`,
  `agent-hosts-runtime-check`, `search-runtime-check` and `ui-check` (after
  `npm run build:native`).
  - `runtime-check.mjs` fails to start, as on main: its explicit module list misses
    `agent-hosts.mjs`.
- `npx tsc --noEmit -p web` is clean.
- Playwright `land.spec.ts` (5) and `agentic-mode.spec.ts` (6) pass. The
  pull-request, merge-observation, native-merge and agent-host specs have no new
  failures: 17 failed with this branch and 20 with main's web sources, and every
  failure is also one on main.

Not done:
- No hosted evidence yet. The AM-4 exit criteria on the demo are open: ten concurrent
  agent landings, a sensitive change waiting, a failing change reverted.
- The policy always merges, never squashes. A `waiting_checks` pull request cannot be
  queued by a person.
- Merges still reserve the whole repository briefly, and conflicts are path-level.
- Native Golf has no service account. Golf's comments and issues are recorded under
  the administrator who saved the setting.

## 2026-10-14 — Agentic mode AM-0 to AM-3 measured and verified on the hosted demo

`https://demo.gitgolf.mjtechguy.com`, measured with `scripts/agent_speed_bench.mjs` against eight repositories
(`mj/agent-bench-1..8`), 20 s per step. Evidence is in `docs/compatibility/evidence/agent-speed-20261014-hosted-*.json`:
`baseline` (before #77), `am1` (#77), `am2-am3` (#79, #82, #83), `am-final` (#88, schema 40) and `am-source` (S6).

**Pushes to separate branches of one repository (S2), successes over attempts**

| Workers | Baseline | After #77 | After #82–#88 |
| --- | --- | --- | --- |
| 16 | 0/32 | 0/80 | 48/48 |
| 64 | 0/64 | 0/128 | 93/93 |

- **Baseline (S1):** two pushes racing on one branch left `write_pending` set with nothing to clear it. Every later push to that repository was refused (412).
- **#77:** a lost race is now Git's own "fetch first", and unknown outcomes settle by readback.
- **#82:** Artifacts sometimes fails one of several concurrent receive-packs into the same repository without reporting the branch refused; the same compare-and-swap is now resent.
- **#88:** an outcome that stays unknown fences only its branch.

**Pushes spread across repositories (S3)**

| Workers | Baseline | After |
| --- | --- | --- |
| 16 | 21/24 at 0.38 s⁻¹, p50 24 s | 48/48 at 2.19 s⁻¹, p50 7.6 s |
| 64 | 51/64, p50 76 s | 93/93 at 1.6 s⁻¹, p50 37 s |

**Shallow clones under push load (S4)**

| Cloners | Baseline | After |
| --- | --- | --- |
| 16 | p50 19.6 s | p50 10.3 s, background pushes 39/39 |
| 64 | 62/166 (104 refused 429) | 70/70, background pushes 75/75 |

**Throughput ceiling.** Total throughput levels off near 2 writes/s for the deployment. That is the single Workspace object plus the provider. The next step is the conditional `RepositoryWrites` split in AM-1.

**Source API (S6), `/native/source/commit` with an API token, no clone**

| Mode | Workers | Successes | Rate | p50 |
| --- | --- | --- | --- | --- |
| A branch per writer | 16 | 48/48 | 1.85 s⁻¹ | 8.3 s |
| A branch per writer | 64 | 61/93 | | 32 client timeouts at 60 s |
| One shared branch (`onStale: merge`) | 16 | 13/63 | | 49 refused after 3 merge attempts |

On one shared branch, merges cannot keep up with 16 writers. AM-4's landing queue addresses that case.

**Remote MCP (AM-3).** Claude Code on this workstation was connected to hosted `/mcp` with a `golf_pat_` token limited to `mj/actions-demo` and `agent/*`, with no Access headers. Using only MCP tools it:
1. read the repository;
2. created `agent/mcp-subtract`;
3. committed a subtract function with tests (`0adb0da`);
4. opened PR #4;
5. commented on it.

Checked independently with `git ls-remote` using the token. A commit to `main` was refused by the branch scope. `/mcp` without a token, and the token on a browser RPC route, both answer 401. This run also found the admin-role bug fixed in #86.

**Not verified on hosted yet:**
- the diverged merge and squash from #94;
- the agentic mode landing panel from #96;
- S5 (RPC reads), which needs a browser identity or token access to RPC routes;
- the per-repository `RepositoryWrites` split.

## 2026-10-14 — Agentic mode setting and landing policy (agentic mode AM-4 items 2 and 3, schema 41)

See `docs/AGENTIC_MODE.md`. This adds:
- The per-repository **agentic mode** setting (migration `0041_agentic_mode.sql`,
  `repository_agentic_settings`). It holds:
  - on/off, off by default;
  - low-risk path patterns, default `docs/**`, `**/*.md`;
  - sensitive path patterns, default CI configuration, `deploy/**` and `**/CODEOWNERS`;
  - land without a person, off by default;
  - required checks, default every pipeline of the head commit;
  - revert on failure, on by default.

  Every save rechecks the version and the administrator's authority in the same
  statement, and is audited as `agentic_mode.update` ("Agentic mode").
- Feature `agentic-mode` in the feature policy hierarchy (requires pull requests). A
  policy can turn it off but never require it.
- `land-policy.mjs`, a pure `evaluateLanding`. It returns `land`, `needs_person`,
  `waiting_checks` or `blocked`, with reasons, a risk (`low`, `normal` or `sensitive`)
  and the matched paths. Glob matching is anchored and has no dependencies or RegExp.
  Sensitive paths always need approval from a writer who is not the author and not an
  agent.
- `POST /native/agentic-mode` (`set`) and `/native/agentic-mode/read` (`get` and
  `evaluate`; reads overlap), for signed-in browser sessions only. `evaluate` gathers:
  - the changed paths from the merge base to the head tree;
  - the pipeline runs, jobs and reported checks of the head commit;
  - the current writers' reviews;
  - the author kind;
  - the existing merge blocker and the base branch lock.

  Capability `repository.agentic-mode`.
- `pull_request_origins`: `CreatePullRequest` records `person`, `api-token` (MCP) or
  `agent-task`. An `agentTaskId` must name a SUCCEEDED task of the repository whose
  branch is the head branch. The agent task panel's **Open pull request** sends it.
- Web:
  - **Settings → Agentic mode**: current values and path rules first; Edit opens a
    TanStack Form with a warning for landing without a person.
  - A read-only **Landing** panel in the pull request sidebar while agentic mode is on.

Verified locally:
- `node --test cloudflare/forge/*.test.mjs`: 612 tests, 611 pass, 1 skipped. Before
  this change: 567, 566, 1 skipped. The new tests are 39 in `land-policy.test.mjs`
  (truth table and glob edge cases) and 6 in `agentic-mode.test.mjs` (setting, policy,
  audit, evaluation and origins).
- Runtime checks with the schema 41 assertion: `agent-hosts-runtime-check`,
  `ai-runtime-check`, `search-runtime-check`, `environments-check` and `ui-check` pass.
  `ui-check` had not started on main, because its module list missed `agent-hosts.mjs`
  and later modules; it now loads every forge module its explicit lists leave out.
- `npx tsc --noEmit -p web` is clean.
- Playwright `agentic-mode.spec.ts`: 6/6 pass. `native-agent-hosts.spec.ts` and
  `repository-routes.spec.ts` were updated for the new settings entry and `agentTaskId`;
  both pass with 2 workers.
- In a run with more workers, the pull-request, merge, settings and route specs
  failed. The same specs, run on main's web sources, also failed, and the specs that
  failed only on this branch pass when rerun.

Not done:
- Golf does not land, queue or revert anything yet (AM-4 items 1, 4 and 5).
- A diverged pull request reads as `blocked` (`base_not_ancestor`) until the
  three-way merge lands.
- No hosted evidence yet.

## 2026-10-14 — Native merges of diverged branches and squash (agentic mode AM-4 item 1)

Cloudflare-native pull request merges (`pull-merge.mjs`) now use the AM-2
`tree-merge.mjs` three-way tree merge. This lifts the `base_not_ancestor` and
`squash_unsupported` refusals:
- **Diverged branches** merge from their single merge base (the bounded
  500-commit ancestry read of `comparison()`). The merge commit has parents
  `[base, head]` and the merged tree; the pack carries the commit and only the
  new tree objects.
- **Squash** writes one commit with the base as its only parent and the head tree
  (head contains the base) or the merged tree. With no title it uses the pull
  request title and `(#N)`; the author is the merging account, as for merges.
- **Conflicts** are refused before any write as `merge_conflict`: paths both
  sides changed differently (content, mode, delete, file versus directory). Up to
  50 paths with reasons, plus the full count, are kept in the journal row and
  returned in the receipt (`refusalCode`, `conflicts`, `conflictCount`) and in
  the merge observation (`mergeConflicts`, `mergeConflictCount`). Lines inside a
  file are never merged (diff3 stays AM-6).
- Other new refusal codes: `nothing_to_merge` (base already contains the head)
  and `ancestry_unproven`, now also for several merge bases (criss-cross) and
  unrelated histories.
- **Unknown outcomes** settle only by readback: the branch must name the
  dispatched commit, with parents `[base, head]` (merge) or `[base]` (squash) and
  the tree recorded at reservation (`expectedTreeId` inside the row's `original`
  JSON; no migration). The pack is never resent; merges keep reserving the whole
  repository through `write_pending`.
- The observation reports a cleanly merging diverged pull request as mergeable,
  with both merge commits and squash allowed. The web merge panel lists
  conflicting paths and the refusal reason of a rejected receipt; squash was
  already selectable when allowed.
- Proto: `PullMergeConflict`, observation fields 18–19, receipt fields 24–26.
  Capability text (`pull.merge`, `pull.merge-observation`), the capability
  inventory and `docs/CLOUDFLARE_NATIVE_SETUP.md` are updated.

Verified locally:
- `node --test cloudflare/forge/*.test.mjs`: 576 tests (including subtests), 575 pass, 1 skipped
  (main: 567, 566 pass, 1 skipped). New core tests cover a diverged merge, squash
  with and without divergence, the 50-path conflict cap, criss-cross and
  nothing-to-merge refusals, replay, and unknown outcomes settled only with the
  expected tree. `pull-merge.test.mjs` compares merged trees and conflicting
  paths with `git merge-tree --write-tree` and feeds the packs to
  `git index-pack --strict` and `git receive-pack`.
- `node cloudflare/forge/merge-runtime-check.mjs "$(command -v cf)"` (real
  workerd/D1 and real `git receive-pack`): head-contains-base merge, diverged
  merge and diverged squash equal to Git's merged tree with the expected parents,
  conflict refusal with paths, replay of each, and held pushes for a merge and a
  squash settled by readback.
- `tsc --noEmit -p web`; Playwright `pull-native-merge.spec.ts` and
  `pull-merge-observation.spec.ts`: 130 passed and 15 failed (main: 116 passed,
  14 failed). Every new conflict, refusal and squash case passes. The failures
  are the same on `main` in this worktree: font loading through a symlinked
  `node_modules` (8), observation-page image, preview and receipt cases (5), and
  the intermittent "Fixture procedure not supplied" alert in the masked 403/404
  cases (also seen on `main` when repeated).

Not yet done: a hosted merge of a diverged branch or squash on Cloudflare
Artifacts; line-level merging; rebase; the AM-4 land queue, agentic-mode policy
and revert-on-failure.

## 2026-10-14 — First real one-command Cloudflare install

`python3 scripts/golf_cloudflare.py install --yes` ran against a real account that already hosts a Golf installation,
on fresh hostnames `golf-test.mjtechguy.com` and `golf-test-previews.mjtechguy.com`, with `--content example` and
`--with ai,search,public,observability,analytics,operations,dead-letter`. `doctor --fix --remote` passed every
required check first (Workers Paid, Zero Trust organization, existing Secrets Store reused).

All 25 steps completed after two fixes and two resumes:
- `OwnedBySomeoneElse` on the `Login` one-time PIN identity provider (one per account): fixed in #91; `init`
  now reuses the account's existing one unmanaged.
- Right after a deploy, the playground clone and the public publish each failed once while the Workspace Durable
  Object still ran the previous release; both succeeded on resume. The installer now retries `seed` and
  `seed-public` up to three times, 60 s apart, and seed Git failures include Git's last error lines.

Verify: receipt `retained` with `ci_admitted` and `ci_verified`; `/auth/login` redirects to Cloudflare Access;
the public example `example-org/click` and its profile verified. The installation is kept for manual testing.

## 2026-10-14 — One-command Cloudflare deploy (`golf_cloudflare.py`)

`scripts/golf_cloudflare.py` (and `make cloudflare-doctor`/`cloudflare-install`)
wraps the Alchemy path without new provider logic:
- `doctor` checks local prerequisites with fixes (`--fix` runs missing `npm ci`)
  and, with `--remote`, read-only account checks (sign-in, Workers Paid,
  Zero Trust organization, zone status, Secrets Store). workers.dev subdomain and
  Artifacts access are reported as not checked (no read command in `cf` beta.13).
- `install` discovers the account, zone, Secrets Store and Access team domain with
  read-only `cf` calls, asks only for hostnames, email, content and optional
  services (or takes flags with `--yes`), confirms, then runs build-image → init →
  plan → deploy → seed → each service's sequence → verify. Known first-deploy
  errors are retried once; progress is saved privately so `--resume DIR`
  continues from the failed step.
- `status` (offline), `update` (plan → migrate when pending → deploy, `--with`
  adds services) and `destroy` (typed confirmation; delegates to the wrapper).

Verified locally: 32 unit tests with a mocked `cf`, mocked actions and a mocked
HTTP probe (discovery, non-interactive and scripted interactive prompts, step
sequence per service, resume, retry on the known errors, token freshness, verify,
update and destroy), `--help` of each subcommand, and `doctor` on a development
machine. Not yet run against a Cloudflare account: discovery output shapes of
`cf auth whoami`, `zones list`, `accounts subscriptions get` and
`secrets-store stores list` are assumed from the CLI's API mapping, and the
end-to-end install has not been exercised.

## 2026-10-14 — Cloudflare deploy paths without owner defaults

Both retained-installation paths now take every owner-specific value as input
(see the "What you provide" tables in `deploy/demo/README.md` and
`deploy/alchemy/README.md`):
- `cloudflare_alchemy_demo.py init` writes the private Alchemy input for a fresh
  account without a previous receipt; `prepare` (existing-installation handoff) is kept.
- The administrator login (`--admin-login`, default derived from the Access email)
  and the playground Git author (`--git-author-name`/`--git-author-email`) replace
  the hardcoded values and are saved in the private input.
- Content is explicit: `--manifest PATH` or `--no-seed` on `create`, `apply` and
  Alchemy `seed`; `seed-public` needs `--manifest`. `deploy/demo/example.json` and
  `example-public.json` are neutral samples; the maintainer's hosted demo moved
  unchanged to `mj.json`/`mj-public.json`.
- `cloudflare_forge.py` requires `--hostname` and accepts `--access-team-domain`;
  `cloudflare_setup.py init` requires both hostnames; the preview smoke accepts any
  base hostname in the selected zone.
- A `cf`-created installation reaches the Alchemy-only `enable-*` actions and token
  renewal through the documented `prepare` handoff (a replacement with reseeded
  content, not an in-place adoption).

Verified locally: unit tests for `init` input generation, identity derivation,
explicit-content argument handling, the build's admin enrollment, manifests and
`--access-team-domain`; `--help` of each changed CLI. Not yet exercised against
Cloudflare: `init` → `deploy` on an empty account, and a manifest without a
personal section on a hosted installation.

## 2026-10-14 — Agent access: API tokens and remote MCP (agentic mode AM-3, schema 39)

Personal API tokens (`golf_pat_…`, stored as SHA-256, migration `0039_api_tokens.sql`)
scope an agent to:
- a list of repositories, or all the owner can access;
- `read` or `write`;
- an optional write branch pattern (exact, or a trailing `*`).

Every call caps a token by its owner's current grant, and an identity change ends it.
There are at most 50 active tokens per account, and the `agent-access` feature policy
can turn token use off per repository. Tokens are accepted only on:
- `/mcp`;
- `/native/source/*`;
- `/git/*` (Bearer or Basic password).

They are refused (401) everywhere else. The public Worker lets token requests on those
paths past Access with cookies stripped and no Access identity.

Pushes and Source API writes re-check the token in the reservation statement
(`person.token_guard`). Create and revoke are audited, and so are uses a token's own
scope refuses. The `POST /mcp` Streamable HTTP endpoint (stateless JSON-RPC, `mcp.mjs`)
offers 11 read tools and 4 write tools. They run through the UI's own handlers as
internal requests, under an environment flag. Settings → Developer → API tokens lists
your tokens first; New token shows the secret once, with Claude Code, Codex, OpenCode
and Git setups. Capability `agents.mcp`. See [AGENT_ACCESS.md](AGENT_ACCESS.md).

Verified locally:
- `api-tokens.test.mjs` (6 tests) and `mcp.test.mjs` (7 tests) cover lifecycle,
  hashing, expiry, revocation, identity invalidation, scope, branch patterns, the
  race guard, route refusals, the Access bypass, the protocol, tools and their errors;
- one `mcp.test.mjs` case runs end to end against the real Source API and a real bare
  Git repository. An `agent/*` token lists, reads, branches, commits and opens a pull
  request, gets a stale-head refusal that carries `currentHead`, and is refused on
  `main`. Read tokens cannot write, and a token revoked mid-request leaves the branch
  where it was;
- a `workspace-admission.test.mjs` MCP admission case;
- `web/tests/api-tokens.spec.ts` (3 tests).

Remaining:
- the hosted exit run (Claude Code on `/mcp` with an `agent/*` token committing and
  opening a pull request), and the Access bypass policy on the hosted demo;
- telling agent host tasks about the endpoint (AM-3 item 4).
## 2026-10-14 — Source API routes (agentic mode AM-2, schema 38)

`POST /native/source/commit`, `branch`, `files` and `tree` (`source-api.mjs`, contract in
`docs/SOURCE_API.md`). A commit takes up to 500 changes (content, base64, mode,
delete, move; 8 MiB in total, 4 MiB a file) against an `expectedHead`, builds exact
Git objects with `git-objects.mjs`, and sends one receive-pack update through the AM-1
branch fence under the push authority guard (grant, access and identity versions,
rules version, credential). It is confirmed by reading the branch back, then recorded
for pipeline intake. A moved head returns 409 with `currentHead`, or with
`onStale: merge` is merged by path (`tree-merge.mjs`) onto the current head, with
conflicts listed. A head that moves again, a refused update or a busy fence is retried,
3 attempts in all. Migration `0038_source_commits.sql` journals idempotency keys: a
replay returns the original response, other inputs are refused, and an unknown outcome
waits for the maintenance sweep. `branch` creates (empty pack) or deletes (no pack)
with an expected head. `files` reads up to 100 paths (1 MiB inline, 4 MiB total,
binary as base64). `tree` lists up to 10,000 entries with `truncated`.
`token-scope.mjs` (`scopeAllows`, `requireScope`) applies the AM-3 token scope
(repositories, read/write, branch pattern) on every route once `actor()` attaches it.
Writes are Workspace transfers and reads are reads. Live activity and `CI_AUTO` follow
writes as they follow pushes. Capability `repository.source-api` is READY on schema 38.

Verified locally:
- the forge suite: 552 tests, 551 pass, 1 skipped (before: 540, 539, 1);
  `source-api.test.mjs` runs node:sqlite against a real bare repository and
  `git receive-pack`;
- `source-api-runtime-check.mjs` on real workerd and D1 with `git receive-pack`:
  - root, edit, delete, move, executable, symlink and binary commits;
  - trees equal to Git's own index for the same edits, and `fsck --strict` clean;
  - stale fail, disjoint merge and conflicting merge;
  - idempotent replay, branch create and delete, files and tree reads;
  - token scope refusals, through a test-only route;
- `merge-runtime-check.mjs`, `agent-hosts-runtime-check.mjs`,
  `search-runtime-check.mjs`, `ai-runtime-check.mjs` and `environments-check.mjs`
  pass.

Not verified:
- The hosted Artifacts provider accepting an empty pack for a branch create (real Git
  does) and the S6 numbers.
- API tokens, MCP and agent task tokens as callers (AM-3).
- Source writes are not in the audit log, as pushes are not.
- `ui-check.mjs` not run (unbuilt `web/dist-native`).

## 2026-10-14 — Concurrent Git traffic (agentic mode AM-1, schema 37)

The Workspace admission queue (`core.mjs` `serialize`) now has three classes. Reads
overlap, up to 8. Transfers overlap reads and each other, up to 24: clone, fetch and
push on `/git/` and on the agent task Git route. Everything else is exclusive: it
waits for every running request, transfers included, and fences later admissions. The
queue holds 512. A transfer is a transfer in both Workspace queues (`authority` and
`dispatch`), so a revocation, a settings change or a background job never overlaps a
push, as before.

Migration `0037_ref_write_fence.sql` adds `git_ref_writes`: a push reserves its ref
in the same D1 batch that journals its `git_operations` row, under the same authority
guard. Two unsettled pushes to one branch conflict (412, as before); pushes to
different branches proceed. A plain push no longer sets `repositories.write_pending`
while in flight, and still refuses to start while it is set. A provider failure or a
wrong read-back sets it, as before. Merges still reserve the whole repository; a
trigger keeps a merge from journaling onto a ref with an unsettled push.
`ref-writes.mjs` (`reserveRefWrite`, `finishRefWrite`) is shared by `/git/` pushes
and agent task pushes. The outcome lives in this table, not in a `git_operations`
column, because SQLite cannot add a column in a migration that is safe to replay.

The maintenance `indexes` stage settles unknown outcomes (`settleRefWrites`). It picks
writes older than 2 minutes that still hold their ref or `write_pending`, skipping
merge writes, at most 20 a sweep, and reads the ref. If the ref holds the new commit,
the write becomes `APPLIED`, with one pipeline push intake (an agent task commit is
recorded on the task instead). Otherwise the outcome is `NOT_APPLIED`. Either way it
releases the ref and `write_pending`, writes a `git_write.settle` audit row and logs
`golf.ref_write_settled`.

A push the provider refuses is not an unknown outcome. This is the case where the
report says `ng <ref>` (for example "fetch first" after losing a race to the same
branch) and the ref does not hold the new commit:
- the write is settled `NOT_APPLIED` at once;
- the repository is not fenced;
- the client receives Git's own report, so it fetches and retries.

Before this, a lost race left `write_pending` set with nothing to clear it, which
locked the whole repository against further pushes.

Verified locally: the forge suite (531 tests, 530 pass, 1 skipped; before: 524, 523,
1). New tests cover the admission classes, limits, the 512 cap and boolean
compatibility, Workspace ordering (pushes overlap each other and reads; revocations and
background jobs wait; `CI_AUTO` still runs), the ref fence and the merge trigger, both
sweep outcomes, and an agent task push against the fence and the sweep.
On real workerd and D1, three runtime checks pass: `agent-hosts-runtime-check.mjs`
(a real `git push` through the task route, and the scheduled sweep),
`merge-runtime-check.mjs`, and `actions-runtime-check.mjs --repos=demo` (a real
`git push` through `/git/` that starts its workflows on the stock Forgejo Runner).

Not verified: hosted throughput and the AM-1 exit numbers (S2/S3 at concurrency 16,
S4 latency), which wait for the AM-0 bench. A write settled by the sweep sets
`ci_state` `NONE`: the legacy `CI_AUTO` path does not run for it; Actions intake does.
`runtime-check.mjs` and `ui-check.mjs` do not start here for unrelated reasons: a stale
module list (no `agent-hosts.mjs`) and unbuilt `web/dist-native`.

## 2026-10-14 — Agent hosts verified on the hosted demo (phase 1a end to end)

On `https://demo.gitgolf.mjtechguy.com` (schema 36, with #67 Worker, #68 host binary, #70 UI):

- Settings > Agent hosts (`/account/agents`) issued a personal registration token and showed the exact
  `register` and `run` commands once. `golf-agent-host` on the owner's Linux workstation registered and
  reported Claude Code 2.1.299 and OpenCode 1.18.35 signed in and Grok 1.0.46 sign-in unknown; Codex was
  withheld because its sandbox cannot start under Ubuntu's AppArmor user-namespace restriction.
- Issue #1 in `mj/actions-demo` ("Add a multiply function with tests") was assigned to Claude Code from the
  issue page's Assign to agent dialog. The task panel streamed the log; the host claimed, cloned, ran
  Claude Code headless, committed and pushed `golf-agent/171fd924` in 23 s, and Golf verified the branch and
  marked the task SUCCEEDED. The panel showed the commit, the two changed files, the tool's own summary and
  its reported usage (84,988 input / 999 output tokens, $0.13, labelled as reported).
- Claude Code reported that it could not run `npm test`: the host runs it without approval for shell
  commands. Fetched and run separately, the branch's tests pass (4/4). A host owner can allow test
  commands with `tools.claude.extraArgs` (for example `--allowedTools "Bash(npm test*)"`).
- Open pull request on the task created PR #2 from `golf-agent/171fd924` into `main`, prefilled with the
  issue title and the tool's summary. The commit is authored `Golf agent (claude)` with a
  `Golf-Agent-Task` trailer.

Found and fixed while verifying: the Worker returns `hostId` as a string and the binary expected a number,
so the first registration consumed its token but saved no credential; the binary now accepts both. After a
deploy the Workspace Durable Object kept serving the old bundle while runners and tabs kept it busy (new
routes answered 501); #69 and #71 make an older instance retire itself, and a deploy now takes effect
within seconds.

Not yet verified on hosted: organization and installation hosts, sharing a host with other users, pull
request tasks, cancel and the lost-host sweep (all covered by the local runtime check), OpenCode and Grok
through Golf (each ran once against a fake server), SSH hosts (phase 1b).

## 2026-10-14 — Agent hosts, Worker side (agents plan phase 1a, schema 36)

The Cloudflare-native Worker half of `docs/AGENT_HOSTS.md`: migration
`0036_agent_hosts.sql`; the host protocol on `/native/agent-host/*` (register,
heartbeat, claim, task start, log and finish, and a task-scoped Smart HTTP Git route)
outside Access; the user API `/native/agent-hosts` and `/native/agent-tasks`; the six
admission rules, checked at create and again at claim, each refusal naming its rule;
the `agent-hosts` feature policy, the `agents.hosts` capability, audit rows
(`agent_host.*`, `agent_task.*`) and a maintenance sweep that marks tasks `LOST` or
`TIMED_OUT`. Credentials and tokens are stored as SHA-256 only. A task's push goes
through the same fenced single-ref journal as `/git/` pushes, limited to its own
`golf-agent/<id>` branch, and a `succeeded` finish is accepted only when the branch
points at the commit and the base is on its first-parent chain.

Verified locally: Worker tests (`agent-hosts.test.mjs`, 8 tests covering every rule,
registration, the protocol, Git route refusals, cancel, the sweep, log bounds and the
prompt bound, plus an audit case); the whole forge suite (523 tests, 522 pass, 1
skipped); and `agent-hosts-runtime-check.mjs` on real workerd, D1 and Durable Objects:
a fake host in the script registers, heartbeats, claims an issue assigned through
`/native/agent-tasks`, streams a log, runs a real `git clone` and `git push` of its
branch through the task route (a push to `main` is refused), finishes `SUCCEEDED`
after the Worker's check, then a cancelled task and a `LOST` task swept by the
scheduled handler. The Artifacts binding is the usual local `git http-backend`
fixture.

Not verified: the real `cmd/golf-agent-host` binary and real coding CLIs against
this Worker, the web UI, and anything hosted. Agent pushes do not start Actions
workflows; task changes are not on the live activity stream (the UI polls); personal
host audit rows are readable only by operations administrators.

## 2026-10-14 — Hosted run of real repositories on stock runners, in kind, and live AI and search checks

Run on `https://demo.gitgolf.mjtechguy.com` (schema 35, deployed before the fixes
below) with unmodified Forgejo Runner v13.2.0 and GitLab Runner 18.5.0, from this
machine and from a kind cluster.

Hosted evidence:

- **Registration:** installation registration tokens made on Settings > Runners
  registered both stock runners; they declared their labels and polled. A
  push to a new repository created a run within seconds.
- **`mj/actions-demo`** (matrix 20/22, postgres service reached by name, secret
  and variable, v4 artifacts, `needs` outputs, `workflow_dispatch` input, an
  environment): run 1 failed at the secret step as it should without the secret;
  after adding `DEMO_SECRET` and `GREETING` in the settings page, run 2
  (dispatched from the Actions tab) succeeded in 1m 9s with two artifacts. The
  unmodified `actions/upload-artifact@v4` still refuses this server upstream and is
  marked `continue-on-error`.
- **`mj/chalk`**, upstream `.github/workflows/main.yml` unchanged: Node.js 26 and
  22 succeeded (1m 36s).
- **`mj/inkscape-extensions`**, upstream `.gitlab-ci.yml` unchanged, 3,403 commits
  pushed in four steps: `codestyle:ci`, `archive` (5.2 MB artifact in R2), five
  `test:linux` matrix jobs, `mypy` and `sphinx` succeeded; both Windows jobs
  waited with "Waiting for a runner with saas-windows-medium-amd64" and
  `test:coverage` stayed blocked, as on GitLab. Pipelines for older pushed commits
  ran their old configuration and failed upstream (`pyenv: version 3.6.8 not
  installed`).
- **Kubernetes CD (`mj/kind-deploy-demo`):** stock runners as Deployments in kind
  (Forgejo Runner with a DinD sidecar, GitLab Runner with the Kubernetes
  executor). The GitHub workflow ran `test`, `image` (`docker build` and push to
  the kind registry), then waited at the `kind-production` environment (required
  reviewer, secret `KIND_KUBECONFIG`) and deployed after approval; the service in
  kind answered with the pushed commit. The GitLab pipeline ran `test`, a kaniko
  `build`, a manual `deploy` and the same approval, and rolled out its own commit.
  The Deployments panel lists three successful and two failed deployments (the
  failures were demo-configuration errors, below).
- **Audit log:** `/admin/audit` showed the repository, Git credential, secret and
  variable rows for this session with actor, location and outcome. Runner
  registration tokens, runner edits and pipeline actions had no rows (fixed in a
  separate change).
- **AI review draft:** GLM 5.3 returned a valid draft for the open pull request in
  `mj/review-playground` (1,106 tokens, one high-severity finding), state
  SUCCEEDED.
- **Semantic search:** `mj/review-playground` index READY and verified (8 files,
  10 chunks, `@cf/qwen/qwen3-embedding-0.6b`, 1024 dimensions); a natural-language
  query returned ranked excerpts with scores.

Defects found and fixed: pushes over 1 MiB failed with HTTP 400 (git's chunked
probe), an oversized push returned 503 instead of 413, and the page printed
`gitlab-runner register --token`, which stock GitLab Runner rejects for
registration tokens (needs `--registration-token`). Runner token and pipeline
action audit rows were missing.

After the merge and a deploy (Worker version 58, 15:11Z) the three fixes were
confirmed on hosted: a 2.9 MiB push with git's default settings succeeded and its
branch could be deleted, an oversize push answered 413 with the message, the GitLab
registration command showed `--registration-token`, and runner token create and
revoke rows appeared in the audit log. The first probes right after the deploy still
showed the old behaviour: the `Workspace` Durable Object kept its running instance
while a signed-in tab held live streams, and answered with new code only after the
tab was closed and the object idled about two minutes (see deploy/alchemy/README.md).

Findings left open:

- The installation's default actions host is `code.forgejo.org`, which has
  `actions/checkout` and `actions/setup-node` but not every marketplace action
  (`azure/setup-kubectl` failed to resolve). Write a full `https://github.com/…`
  URL in `uses:`, or enable pipelines with `--actions-url https://github.com`.
- Settings > Secrets and variables and Settings > Environments still describe the
  older approved-workflow path ("required reviewers … are not available on this
  installation") even though pipelines are on and Actions > Environments holds
  reviewers, branch rules and environment secrets.
- A stock runner warns `ReportState error: not all logs are submitted 1 remain`
  once per job; jobs complete normally.
- One kaniko build in kind failed to resolve `kind-registry` (it queried 1.1.1.1:53)
  and passed on the next pipeline; not reproduced or explained.
- Not run on hosted: node-postgres, pages/hugo, itsdangerous, organization-scope
  runners, `schedule` triggers, triage and release-notes drafts with real models.

## 2026-10-14 — AI pull request summary and review draft (AI-B)

Writers can ask Workers AI, through the private AI Gateway, to read up to 96 KiB
of a pull request's exact diff (bound to the pull request id, base, head and
merge base) and draft a summary and `path:line` review notes that only the
requester sees, using the installation's chosen model for the `review-drafts`
use (default `@cf/zai-org/glm-5.3`, strict `json_schema`, no tools). Output is
validated against the diff (each finding must sit on an added or context line of
a file the model was given; no duplicates or oversize text) and neutralized.
"Start pending review with this text" seeds the existing pending review form;
the person chooses the decision and nothing is posted until they publish it as
their own review. A draft is marked out of date when the head or base moved or
the title or description changed; "No findings is not an approval." It sits under
the `ai-review-drafts` feature policy, requires pull requests, and adds no
migration.

Verified locally: Worker tests (509, 508 pass, 1 skipped), a real workerd
D1/DO/Workflows run with a stub model (`ai-review-runtime-check.mjs`),
`pull-ai-draft.spec.ts` and the advice-card and review-authoring specs. The three
older review specs fail the same 64 of 70 tests with and without this change on
the same base. Unverified live: GLM 5.3 `json_schema` adherence and latency inside
the 150 s step. Not built: "Use as description".

## 2026-10-14 — Native Actions pipelines on the stock Forgejo Runner, and GitLab CI pipelines on the stock GitLab Runner (RUN-A/B/C)

Implemented and verified locally; migration 0035 (schema 35); not yet hosted.
The Cloudflare-native Worker speaks the stock Forgejo Runner protocol (pinned
v13.2.0, sha256 `fadaec89…cad1`) and the stock GitLab Runner API (pinned 18.5.0,
sha256 `4f84c299…6762`) on a shared pipeline core (D1 model, per-run Durable
Object, R2 logs and artifacts, optional intake Queue, scheduled sweep driven by
maintenance). GitHub Actions workflows from `.github/workflows` and
`.forgejo/workflows` run on push, same-repository pull_request and
workflow_dispatch; `.gitlab-ci.yml` pipelines support stages, needs, rules, extends,
parallel and matrix, services, artifacts, cache and manual jobs. Both support
environments with required reviewers, environment-scoped secrets released after
approval and deployment history; secrets reach same-repository runs only and are
redacted in stored logs. The web UI adds an Actions tab (runs, job graph, folded
logs, dispatch, re-run, cancel, artifacts, approvals, environments) and runner
administration at repository and installation scope. `enable-pipelines` switches it
on; unsupported syntax refuses the run with a visible reason.

Local proof used the real pinned runner binaries with Docker against the Worker on
workerd/D1/R2 (Artifacts is a local `git http-backend` fixture), and unmodified
upstream files:
- GitHub: demo workflow, `chalk/chalk`, `pallets/itsdangerous` (`pre-commit` and 5
  of 7 `tests` jobs pass; Windows and macOS jobs wait for a matching label; `typing`
  fails upstream), `brianc/node-postgres` (`lint` passes; 11 matrix jobs fail one
  upstream SCRAM test under host networking).
- GitLab: `inkscape/extensions` (five Python jobs, `codestyle`, `mypy`, `sphinx`,
  `archive` pass; Windows jobs stay queued), `pages/hugo` (refused on `main` because
  Pages is unsupported; the feature-branch test fails upstream), and a synthetic
  pipeline with artifacts, cache, a Postgres service, approvals and cancellation;
  the Kubernetes executor ran job pods with a service sidecar in kind.

Not done: hosted verification, `schedule` triggers, reusable workflows, org-scope
runner UI, WebSocket log streaming, v3 artifacts, distributed runner cache,
in-cluster Helm runner. Unmodified `actions/upload-artifact@v4` refuses
non-github.com servers (use the Forgejo fork). Pipeline dispatch, cancel and
approval are not yet in the audit log.

## 2026-10-14 — Audit log for privileged and state-changing actions

`/admin/audit` was empty after a day of runner pool, enrollment and placement
changes because only installation policy edits were recorded. One hook in the
request dispatch now records every privileged or state-changing request that has
a descriptor in `src/audit.mjs`: installation, feature and AI model policy,
runner pools and machines, organizations, repository creation, visibility,
settings, members, invitations, rules, webhooks, secrets and variables (names
only), environments, Git credentials, previews, releases, merges, review
dismissals, labels, milestones and run requests. Each row records outcome
(success, denied, refused, unknown), actor, Access email, auth kind, country,
colo, IP, user agent and request id in the existing append-only
`installation_audit` table; no migration. Policy and feature changes are
written in the same D1 batch as the change; every other row is written
best-effort after success, with a visible failure counter. Operations
administrators read the installation log, repository administrators their
repository's (`settings/audit`) and organization owners their organization's,
with server-side filters. Secret values, signing secrets and runner enrollment
credentials are tested never to appear in a row.

Verified locally: Worker tests (475, 474 pass, 1 skipped), real workerd runtime,
UI and audit checks, and the audit, installation, feature-policy and
settings-navigation specs. Pipeline runner registration tokens, runner edits
and deletes, workflow dispatch, cancel, re-run, manual play, deployment approval
and rejection, and environment and environment-value saves are audited as well
(`pipeline_runner.*`, `actions.*`, `environment.*`); a hosted check on
2026-10-14 showed repository, Git credential, secret and variable rows but no
runner-token rows, which this change adds. Dispatch inputs, approval comments and
environment values are never read into a row. The row stores client IP
addresses; retention and export are not yet configurable.

## 2026-10-14 — Semantic search with Workers AI embeddings and Vectorize (AI-E)

Repository administrators build a per-repository index that the maintenance
schedule fills with Workers AI embeddings (model from AI model selection) of
default-branch code and issue/PR titles and descriptions, in paced batches
(schema 34). Vectorize holds only ids, vectors and repository/kind metadata.
Every search re-checks the reader's grant in D1 and reads excerpts live, so
revocations, deletions and edits apply immediately; results name the indexed
commit. A changed embedding model rebuilds the index while the old one keeps
serving; the feature sits under the `semantic-search` policy.

Verified locally with Worker tests (468), a workerd check against stub
AI/Vectorize/Artifacts, script and deploy-config tests and Playwright specs.
Still unverified live: the embedding dimension, Vectorize filtering and upsert
visibility, gateway limits during indexing, and CPU per maintenance run.

## 2026-10-14 — Analytics reads failed because Workers reject `redirect: 'error'`

The Operations analytics feed (failing inside the Worker since 2026-10-13 although
the same token and query worked outside it) and the new AI Gateway usage panel
both called the GraphQL API with `fetch(..., { redirect: 'error' })`. Workers
accept only `follow` or `manual`, so every read threw before any request was sent;
the AI usage panel surfaced the message. Both now use `redirect: 'manual'`, and a
redirect response still fails the read because it is not a 2xx JSON answer.
Verified by Worker tests; hosted confirmation follows the deploy.

## 2026-10-14 — Clef label suggestions and Workers AI release notes drafts (AI-C, AI-D)

Repository administrators can ask Clef (`@cf/cloudflare/clef`, fixed) which of up
to 20 of the repository's labels fit an issue, from its title and description.
Suggestions are ranked probabilities (at most three at 15% or more) and apply only
when a person saves them in the labels editor; a suggestion is marked out of date
when the title, description or labels change. Administrators can also draft
release notes for an existing tag from its first-parent history back to the
previous tag (at most 500 commits): Golf merges count as merged pull requests,
other commits are listed by subject, every item must cite its input, and the
Worker writes the links. The draft fills the release form; nothing is published.
Release notes use the installation's chosen model for that use case (default
`@cf/zai-org/glm-5.3`). Both are under feature policies `ai-triage` and
`ai-release-notes`.

Verified locally with Worker tests (462, 461 pass, 1 skipped), a workerd run with
stub models (`ai-kinds-runtime-check.mjs`) and mocked Playwright specs (17).
Unverified live: Clef with more than three options, and GLM `json_schema`
adherence and latency.

## 2026-10-14 — AI model selection per use case and AI usage (AI-G, AI-F)

Administrators choose the default and allowed Workers AI models for agents,
summaries and review drafts, release notes and search embeddings at `/admin/ai`,
from the account's model catalog (cached 6 hours) filtered by task and capability
and bounded by the deploy list `AI_MODELS`; review advice and triage stay on Clef.
A per-use-case switch lets repository administrators pick from the allowed list in
repository settings. Writes are revision-fenced and audited; widening needs the
typed key and a recent Access sign-in; `policy_editing: false` locks it (schema
33). Every AI run records the model it used; the agent model is part of the agent
policy identity, so a change refuses queued proposals at their next step.
`/admin/ai-usage` shows Golf's own ledger by feature, model and day against the
daily AI limit, and an AI Gateway analytics panel that stays "Degraded" until a
live read succeeds.

Verified locally: Worker tests (448, 447 pass, 1 skipped), agents package (4),
real workerd AI/runtime/UI/environments checks, web typecheck and builds, and the
model-selection Playwright specs. Unverified live: the catalog's property names
and whether the analytics token reads the AI Gateway dataset.

## 2026-10-14 — Workers AI run foundation and the Clef recommendation card (AI-0, AI-A)

Workers AI runs (AI-0) are admitted and prepared in the workspace, inferred once
in `AiWorkflow` outside the workspace's write queue through the private AI
Gateway, and settled only while reserved (schema 32, `ai_runs`). A retried or
replayed infer step never makes a second model call; a lost settle becomes
UNKNOWN through maintenance; repository text never enters Workflow state, and
input snapshots are deleted after 7 days. Runs are gated by the deploy
allocation, the installation AI advice switch and each kind's feature policy,
with 100 runs a day (deploy ceiling 500) and 20 per person per hour. Verified with
node tests (438, 437 pass, 1 skipped) and a real workerd Workflow run against a
stub model; no feature uses it yet, and nothing has run live.

The Clef recommendation card (AI-A) puts the latest stored Clef advice on the
pull request Conversation tab: a sentence with a probability per next step, the
model, what Clef read, the commit and whether it is out of date. Writers can ask
again through the existing advice-only evidence job, which counts against the
daily evidence limit. Verified with mocked Playwright tests in Classic, Golf and
Flare, light and dark, at 1440 and 390 px; not yet seen against live advice.

## 2026-10-14 — First hosted customer-runner run; runner finish receipt fixed

A Golf native runner on a Linux Docker host was enrolled against the retained
installation (Admin → Runners: untrusted pool `mj-workstation`, machine
`mj-linux-docker`, 4-hour credential) and selected for `mj/review-playground`.
"Run approved workflow" on pull request 1 ran the approved `.github/workflows/ci.yml`
shell job on the host (Docker, no network, approved image
`sha256:81188fb3…`) and the report shows "Customer-hosted runner … attempt 2",
exit 0 and the unittest output. This is the first hosted customer-runner run.

The first attempt exposed a runner bug: it decoded `/finish` strictly and
expected only `{"result":{"state"}}`, but the Worker returns the whole stored
result, so every hosted completion failed to decode after the server had
accepted it. The runner now reads only the state from the receipt; the test
fakes return the Worker's real shape. The interrupted attempt's journal replayed
the exact payload and was accepted. Also fixed: the repository Runners settings
page unmounted its chooser on every background access check (#44).

Verified: `go test ./cmd/golf-native-runner` with the real Docker image, and the
two hosted runs above. Still open from the hosted trial list: failing job,
cancellation, runner restart mid-job, credential revocation; and the bounded
shell profile is not real GitHub Actions or GitLab CI (see
`docs/NATIVE_ACTIONS_PIPELINES.md`, in progress).

## 2026-10-14 — Native feature policies and repository Features (admin slices 3–4)

Installation administrators set each of 15 governed features (pull requests,
issues, Actions, secrets, previews, agents, AI advice, merge, attachments, wiki,
webhooks, email, releases, packages, public repositories) to Disabled everywhere,
Allowed or Enforced at `/admin/features` (schema 31). The page leads with a
summary band and grouped cards showing each feature's mode, operator allocation,
dependencies and reach ("On in 12 of 14 repositories"). Changes are version-fenced
and audited; widening needs the feature id typed back and a recent Access sign-in;
public repositories can never be enforced. Repository administrators turn allowed
features on or off in a Features section on repository settings, and every row
names the level that decided it (operator allocation, installation policy or the
repository). A disabled feature leaves the repository's tabs and settings, its
pages say which level turned it off, and the Worker refuses its requests and
background work (issues, pull requests, merge gates and the evidence pipeline).
Turning a feature off keeps its data. With `policy_editing: false` feature
policies cannot be changed; saved policies stay in force.

Verified locally: Worker tests (425, 424 pass, 1 skipped), capability and
generated-contract drift checks, Go build and server tests, release-script tests,
real workerd/D1 runtime, UI and environments checks, and the feature-policy,
admin, settings, routes and environments browser specs (failures limited to
`instance-admin:37`, `instance-admin:119` and `repository-routes:64`, which also
fail on `main`). Organization policies (slice 5) are not built. Hosted acceptance
follows the 0031 migration.

## 2026-10-14 — Native workspace renamed from `alice` to `mj`

The retained installation's workspace is now `mj`. Repository and invitation
lookups bind the installation's unique Artifacts namespace instead of the
workspace slug, so the database row and the Worker's `WORKSPACE_SLUG` cannot
disagree during a rename (#40). The guarded `rename-workspace --slug` step
updates the row and redeploys; a Durable Object left under the old name deletes
its own maintenance alarm. New installations no longer hard-code `alice`.
Existing R2 object keys keep their `…/alice/…` paths because their full keys are
stored.

Verified on hosted: `/native/config` reports workspace `mj`, the repository list
(19) and `GetRepository` load, and the maintenance journal shows the CI,
evidence, preview and index stages succeeding at 06:45 UTC after the rename,
with the workspace row `slug = mj`. That the old object stopped its alarm is
inferred from the code path, not observed directly.

## 2026-10-14 — Native installation overview and editable installation policy

Operations administrators signed in through Access see every installation setting
the Worker holds at `/admin` (allocations, approved origins, sender, limits and
today's use; secret bindings only as present), and can change policy inside the
deploy allocation (schema 30): webhook origins and daily limit, email on/off and
limit, AI advice and agent proposals on/off, preview lifetime and slots, anonymous
rate limiting and daily evidence admissions. The deploy value is the default and
the ceiling. Writes are revision-fenced with receipts and an append-only audit row
in one D1 batch (`/admin/audit`). Widening needs the typed setting name and an
Access sign-in from the last 10 minutes. Policy is read where it is used:
capabilities, admissions, each evidence step, the webhook and email drains,
preview publication and the anonymous limiter. `policy_editing: false` returns
authority to deploy only. The Operations page now leads with summaries and a
"Needs attention" list, and the three admin links with no native service are
grouped under "Not on this installation".

Verified locally by Worker tests (414, 413 pass, 1 skipped), real workerd/D1
runtime, UI, environments and rate-limit checks, release-script tests and native
Playwright specs. Remaining: hosted acceptance, live confirmation of the forwarded
Access sign-in time, and emailing operations administrators about widening
changes.

## 2026-10-14 — Agent proposals on GLM 5.3 Flash

Agent proposals now run on `@cf/zai-org/glm-5.3-flash` (briefly `@cf/zai-org/glm-5.3`;
both are listed in this account's Workers AI catalog with function calling and a
1M-token context). Live runs on `mj/review-playground` pull request 1, each asked
to add one small function to `calc.py` with a docstring and keep `add` unchanged:

| Model | Result | Inference calls | Tokens | Time | Denied requests |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | succeeded, `subtract` added, tests passed | 6 | 5,760 | 78 s | 1 |
| `glm-5.3-flash` | succeeded, `multiply` added, tests passed | 5 | 3,706 | 31 s | 0 |

The first Flash deploy did not rebuild the Worker: the Alchemy build watched only
`cloudflare/forge`, while the agent harness lives in `cloudflare/agents/src`. The
watch list now includes it.

## 2026-10-14 — Native releases and discussion attachments on R2

Cloudflare native serves repository releases for existing tags by current
administrators while no tag rules exist (schema 28): D1 notes and original
receipts, up to 25 assets of 256 KiB per release written once to private R2
with readback settlement, and downloads streamed only with current repository
access; tags still arrive only by `git push`. It also serves discussion
attachments (schema 29): up to 100 files of 256 KiB per description or comment
in private R2, portable upload authority, original receipts and SHA-256
verified downloads; there is no deletion or replacement. The four upload and
file-write procedures accept bodies of about 400 KiB; everything else stays at
96 KiB.

Verified locally by Worker tests (403, 402 pass, 1 skipped), real
workerd/D1/R2 runtime checks and native Playwright specs against the Worker
handlers; hosted acceptance is recorded separately.

## 2026-10-14 — Native email accepted on the retained installation

After `migrate` (applied `0027_email_notifications.sql`), `enable-email
--email-limit 200`, `renew-deploy` (the account offered `Email Sending Write`)
and a deploy, Cloudflare created the sending subdomain
`mail.demo.gitgolf.mjtechguy.com` and the capability reported `DEGRADED`. After
the administrator enabled email with background consent and subscribed
`mj/merge-probe` to issues, opening issue 3 there queued one delivery, which
Cloudflare Email Service accepted on the first attempt with a provider message
id; the acceptance was recorded and the capability turned `READY`. Delivery to
the inbox is not observed by Golf.

## 2026-10-14 — Native repository email notifications (not yet qualified live)

Cloudflare-native repository email notifications are implemented in source but
not qualified live. Schema 27 adds own-address consent, per-repository
subscriptions and a D1 outbox filled by triggers on committed source, issue/PR
and test-job activity. The Worker sends category-and-link messages only to each
subscriber's own Access sign-in address through the `send_email` binding,
rechecking account, address, consent, subscription version and repository
grant before the claim and under the lease, with six attempts, possible-duplicate
marking and a daily attempt budget. Cloudflare Email Service refuses a
caller-set Message-ID, so retries carry a stable `X-Golf-Delivery-ID` header and
the provider's message id is stored. `repository.email-notifications` is
DISABLED without the binding or Access, DEGRADED once configured, and READY
only after a provider acceptance from the current sender is recorded; none has
been recorded. Retries and mail held by the daily limit ride the shared
maintenance run (Cron Trigger or workspace alarm).

Evidence: 17 Worker tests, a real workerd/D1 flow through the local Email
Service simulator in `ui-check.mjs`, and native browser fixtures. Remaining:
account eligibility, the Email Sending permission and subdomain DNS validation
on the hosted account, a recorded live acceptance, bounce/complaint/reply
handling and unsubscribe links.

## 2026-10-14 — Native secrets accepted on the retained installation

After `migrate` (applied `0026_execution_values.sql`), `enable-secrets`,
`enable-workflow --workflow-path .github/workflows/ci.yml` and a deploy, both
`settings.repository-workflows` (combined-profile wording) and
`settings.repository-secrets` reported ready. The two playground repositories
gained `.github/workflows/ci.yml` on `main` and `feature`. On
`mj/review-playground`, signed in through Access: a secret `DEMO_DEPLOY_TOKEN`
(a random 29-character demo value) saved as version 1; reading it back was
refused (404) and the inventory never contained it; an approval for the exact
`feature` head `30c980d` and its workflow blob saved with origin
`WORKFLOW_RUN_ORIGIN_PULL_REQUEST`. A pull-request test job then ran the
approved workflow and passed. Its stored output reads `Deploy token in this job
is ***************************** with length 29`, so the value reached the step
and the stored log was masked; the full report does not contain the value, and
its limitations line states that values were released. The first approval
attempt was refused because the demo step was not valid YAML, as designed. The
demo secret and its approval (two-hour expiry) were left in place.

## 2026-10-14 — Native repository secrets and variables

Cloudflare native: repository secrets and variables are stored as AES-GCM
ciphertext under a dedicated Secrets Store key (`EXECUTION_VALUE_KEY`; Alchemy
`enable-secrets`) and managed only by an Access-verified administrator, with the
portable limits, version fences and receipts (schema 26). Values are released as
environment variables only to Cloudflare-hosted pull-request jobs of the
operator-approved Actions workflow at an administrator-approved exact commit
and head branch, for at most 24 hours per approval, with the new
`WORKFLOW_RUN_ORIGIN_PULL_REQUEST` origin; other jobs run without values and say
so. Stored output masks exact secret text only; transformed values are not
detected. Typed inputs, manual dispatch, organization values, environment
scopes, secrets expressions, customer runners and agent jobs do not receive
values. Portable Go refuses the new origin before any write.

Evidence: Worker tests (369, 368 pass, 1 skipped), targeted mutation checks
(39 of 40 caught; the survivor is covered by the source hash), a real
workerd/Secrets Store/D1 value check, and native Playwright cases. Remaining:
hosted run with a workflow profile, live confirmation that released values
reach a container step and appear in no provider log, a key rotation
procedure, and an approved-egress broker so jobs can use secrets against
outside services.

## 2026-10-14 — Native issue templates; anonymous read throttling

Cloudflare native serves `ListIssueTemplates` (`discussion.templates` ready):
Markdown templates and YAML issue forms from the default-branch head with the
portable sources and limits (50 files of 6,000 bytes; aliases, anchors and
unsupported fields counted, not rendered). A 140-input comparison with the
portable parser matched 134 cases; the six differences are documented in
`cloudflare/forge/src/issue-templates.mjs`.

Optional anonymous read throttling (`anonymous_rate_limit`; Alchemy
`enable-rate-limit`) uses the Workers rate limiting binding for credential-less
public reads and clones, per client network and Cloudflare location, with
approximate counts; signed-in, credentialed and runner requests are never
counted, and a limiter error lets the request through.

The four portable-only settings rows stay in the native capability list:
blocked routes and settings diagnostics show their label and reason, and
removing them would replace that with a generic "has not been set up" message.

Evidence: `issue-templates.test.mjs`, `rate-limit.test.mjs`, a mocked-backend
browser test, and `rate-limit-check.mjs` on workerd with the local simulator.
Hosted acceptance is recorded separately.

## 2026-10-14 — Native workflow settings, repository run switch and recent runs

The Cloudflare-native repository page `/:owner/:name/settings/workflows` is
available: `WorkflowService.InspectWorkflows` lists `.github/workflows/*.yml`
and `*.yaml` and `.gitlab-ci.yml` at the default-branch commit (at most 20
files of 64 KiB) for accounts with a repository grant and marks the one
operator-approved path; it starts nothing, and panels without a native service
are not mounted. An installation may approve an Actions shell workflow for
pull-request runs beside the Python module that agent proposals test with
(`cloudflare_alchemy_demo.py enable-workflow --workflow-path PATH` on the
Alchemy path). `ExecutionPolicyService` Get/Update at repository scope (schema
25) lets an administrator signed in through Access turn pull-request runs and
automatic push tests off for one repository; it is checked at admission only,
does not stop admitted runs and does not govern agent proposals. The native
Actions page lists the latest 50 runs across pull requests from stored rows,
without a staleness claim.

Evidence: local Worker tests (329, 328 pass, 1 skipped), the workerd/D1 UI
check, release and setup script tests, and native Playwright cases with mocked
RPCs. Remaining: no manual dispatch, branch-push or tag triggers, no run
history service, no workflow editor, one approved path per installation, no
revocation of admitted runs. Hosted acceptance is recorded separately.

## 2026-10-14 — Maintenance no longer depends on Cron Trigger delivery

The workspace Durable Object keeps a five-minute alarm and runs the scheduled
maintenance stages and collectors itself whenever no Cron Trigger run has
reported in for ten minutes. Reason: on the retained installation Cloudflare
has delivered no scheduled event to the Worker since its first Alchemy deploy.
Further evidence gathered since the earlier entry: replacing the trigger left
the same `*/5` `internalError` records appearing while the script had no `*/5`
trigger; a one-minute trigger on that Worker produced no record or event in 19
minutes; and a minimal throwaway Worker uploaded straight through the API with
its own one-minute trigger received no scheduled event in 25 minutes. That
points at cron delivery for this account rather than at Golf's Worker; the
cause is still not established and is Cloudflare's to diagnose.

Evidence for the fallback: Worker tests (arming, standing down after a
scheduled run, resuming after ten minutes) and the real-workerd runtime check,
which still passes its scheduled-maintenance assertions through the shared
function. Hosted result is recorded in the next entry after deploy.

## 2026-10-14 — Native merge accepted on the retained installation

After `migrate` (applied `0024_pull_merges.sql`) and a deploy, `pull.merge`
reported ready. On a scratch repository `mj/merge-probe`, created for this
check: two branches were pushed with a one-hour repository credential, pull
request 1 (`feature` into `main`, base an ancestor of head) merged through
`SubmitStandardPullMerge` in about one second with phase `SUCCEEDED`.
Cloudflare Artifacts accepted the Worker-built one-object pack and a command
requesting only `report-status`, and the ref read back immediately. An
independent `git fetch` showed `main` at the reported commit with parents
`[base, head]`, the head's tree, author and committer `Mike Johnson
<mj@users.noreply.demo.gitgolf.mjtechguy.com>`, and `git fsck --strict` clean.
Replaying the operation id returned the same receipt; the pull request read
back closed and merged with the merge commit id. Pull request 2 from a branch
that had diverged from `main` was recorded `REJECTED` / `preflight_refused`, as
was a squash request, and `main` did not move. The credential was revoked and
then refused by Git.

Not exercised on hosted: an unconfirmed write and its read-back settlement, a
locked target, the merge panel in a browser, and the webhook and activity
events a merge emits. `mj/merge-probe` remains on the installation because
native repository deletion does not exist yet.

## 2026-10-14 — Native pull request merge, first slice

Cloudflare native now merges a same-repository pull request with a merge commit
when the base branch tip is already contained in the head (schema 24,
`pull.merge` ready). The Worker builds the commit and a one-object pack and
writes it through the push reservation, Git rules and journal, confirming by
ref and commit read-back. The author and committer are the acting account's
name with `<login>@users.noreply.<public host>`. Squash, forks, diverged
branches, drafts and locked targets are recorded as refused with a reason, and
an unconfirmed write stays unknown and fences the repository like an
unconfirmed push. A merge does not start automatic CI.

Validation is local: the Worker suite (316 tests, 315 pass, 1 skipped), real
Git accepting the generated pack and receive-pack request, and a workerd/D1
merge against a real local repository (`cloudflare/forge/merge-runtime-check.mjs`).
Cloudflare Artifacts accepting the pack, automated recovery of a write that did
not land, tree merges, squash, protected merge and CI on merge remain open;
hosted acceptance is recorded separately once probed on a scratch repository.

## 2026-10-14 — Native environments accepted on the retained installation; expired previews were blocking new ones

After `migrate` (applied `0023_repository_environments.sql`, then reported the
schema current on a second run) and a deploy, the Environments capability
turned ready about five minutes later. On `mj/review-playground`, signed in
through Access: another environment name was refused (400); a `preview` policy
allowing only `release` saved as version 1; publishing a preview for pull
request 1 (head `feature`) was refused with 412; a save against version 0 was
refused with 409 `aborted`; after allowing `feature` with a 300-second lifetime
and one concurrent preview, a static preview published `READY` with a
301-second lifetime (operator ceiling 14,400) and a second was refused with 429
naming the limit; deleting the policy succeeded and the inventory read 0. The
settings page rendered its inventory and Add action. Not exercised on hosted:
renewal, automatic previews, and Worker-application previews under a policy.

The first publication attempt was refused for a different reason: four
previews that expired at 2026-10-13T21:57Z were still `READY` and unpurged, and
the workspace holds at most four. Preview cleanup runs only on the scheduled
maintenance that is failing on this installation (see the next entry). The four
were revoked by hand through the product's own action; nothing will clean up
later previews until the schedule works.

## 2026-10-14 — Native repository environments govern protected previews

Cloudflare native: repository Environments settings are available when
protected previews and Access are configured. A repository has one environment
named `preview`; its allowed head branches, lifetime (within the operator's
`PREVIEW_TTL`) and concurrent-preview limit (at most four) are enforced when a
protected preview is published or renewed, and existing previews are not
revoked by a policy change. Changes need a verified Access sign-in by a
repository administrator. Required reviewers, wait timers, tag/commit
selectors, environment secrets and production deployment are not available.

Schema 23 (`0023_repository_environments.sql`). On the Alchemy path
`enable-public` no longer carries its own copy of migration 0022; it requires
the current schema and `migrate` applies whatever is missing.

Evidence: Worker tests, a local workerd/D1 check
(`cloudflare/forge/environments-check.mjs`) and a mocked-backend browser test.
Hosted acceptance is recorded in the next entry once the migration and deploy
have run.

## 2026-10-14 — Alchemy path: schema migration, credential renewal, operations feed; scheduled runs failing

Three operator steps were added to `cloudflare_alchemy_demo.py`: `migrate`
applies reviewed, repeatable migrations between the recorded schema and the
checkout; `renew-credentials --days N` moves the expiry of the stack's
management, registry and analytics tokens 1 to 30 days ahead, applied in place
by the next deploy; `enable-operations` turns on service probes and provisions
a separate `Account Analytics Read` token for the Operations analytics feed.

Evidence on the retained installation (2026-10-14): after `renew-credentials
--days 30` and a deploy, Cloudflare lists the three tokens as active until
2026-11-13T03:14:12Z (previously 2026-10-20). After `enable-operations`,
Operations reports the Workers Analytics API as `configured`, with nothing
collected. `migrate` has only run against SQLite in tests.

Open defect found while checking the feed: Cloudflare's analytics record every
scheduled run of the retained installation's Worker since its first Alchemy
deploy (2026-10-13T17:36Z) as `internalError` with zero CPU, a live log stream
shows no scheduled event reaching the Worker, and `operations_maintenance` is
empty. The schedule is listed on the script, and re-applying it changed
nothing. Consequences until fixed: no cron-driven maintenance on that
installation (CI intake retry, preview cleanup, evidence reconciliation, index
reconciliation, webhook retries, the analytics feed, service probes). Work that
runs after a request is unaffected, which is why first-attempt webhook
deliveries and evidence jobs succeed. The cause is not established.

## 2026-10-14 — Workers AI, agent proposals and failure retention on the Alchemy path

The Alchemy deployment path can now enable three more Cloudflare services:
`enable-ai` admits inference through one private AI Gateway (authentication
required, no prompt logging or cache, 60 requests a minute, 500 cents a day)
and, with `--agent-path`, provisions agent proposals (a second container
application on the same image, the `PRAgentTask` Durable Object, a 100-step
evidence workflow); `enable-dead-letter` adds the evidence dead-letter queue.
The deployment token gains `AI Gateway Write` only when AI is enabled.

Evidence on the retained installation (2026-10-14), on `mj/review-playground`
pull request 1: review advice ran on Workers AI (`@cf/cloudflare/clef`) and
reported `SUCCEEDED`; an agent proposal with OpenCode 1.18.34 and
`@cf/zai-org/glm-4.7-flash` reported `succeeded` after 4 inference calls and 0
denied outbound requests in 37 seconds, published a proposal commit that adds a
docstring to `calc.py`, and its approved test module passed. The gateway read
back with the settings above. The first two agent attempts ended `lost` at
`container_ready`: the stack had defined the second container under another
image key, which is fixed. Alchemy beta.83 needed two deploy runs to create the
new class and then its container application.

Not exercised: the daily spend limit, rate limiting, a dead-lettered evidence
message, cancellation of a running agent, and two concurrent agents completing.
Agent proposals can change only `calc.py`, so they apply to the two playground
repositories and to no imported repository.

## 2026-10-14 — Native webhooks on the Alchemy path; Slack message shape

`cloudflare_alchemy_demo.py enable-webhooks DIRECTORY --origin ORIGIN` prepares
repository webhooks for an Alchemy installation: it generates the encryption key
in the private input and approves exact receiver origins, and the stack stores
the key in Secrets Store and binds the policy. Repeating it keeps the key.

Deliveries to `hooks.slack.com` carry a one-line `text` summary (what changed,
the repository name, a link), because Slack incoming webhooks refuse the
`golf.webhook.v1` document. Other destinations are unchanged, and portable Golf
has no such adapter. Webhook settings also denied every repository under a
named owner; they now follow the repository's owner.

Evidence on the retained installation (2026-10-14): after the deploy the
Webhooks capability reported ready, a subscription for `mj-labs/typer` saved as
`authorized`, and its test delivery was `accepted` by Slack with HTTP 200 on the
first attempt. The capability turned ready about five minutes after the deploy
finished although the live Worker version already carried both bindings; the
cause of that lag is not established. Not exercised: a delivery produced by a
real push, issue or pull request change, retries, and the daily limit against
Slack. PR agent proposals remain unconfigured.

## 2026-10-14 — Repository overview; PR evidence metrics on the Alchemy path

Console and Overview open a repository with an overview above the files: a band
with open pull requests, open issues, the latest commit and the default branch,
then the first open pull requests and recent commits. Every figure comes from a
bounded read (the first 50 open items, five commits); counts show `50+` when
another page exists. The tab counts share those reads. Signed-out visitors do
not get the overview, since it reads private collaboration data. CI status per
commit, a latest release, star history and contributors are not shown: nothing
reports them on the native runtime.

The Alchemy deployment path now qualifies the Analytics Engine dataset binding,
and `cloudflare_alchemy_demo.py enable-analytics DIRECTORY` names a dataset for
PR evidence metrics. Metrics are sampled completion counts, not billing.

Still not configured on the retained installation: webhooks (needs a Secrets
Store key and operator-approved destination origins) and PR agent proposals
(needs Workers AI admission, an approved file path and an agent container,
none of which the Alchemy stack provisions yet).

Validation: typecheck and the native build pass; `layout-presets.spec.ts` (24
tests) covers the overview; the Alchemy binding and script unit tests pass. The
full browser suite was not rerun.

## 2026-10-14 — Signed-in audit of the retained native site; settings wiring

All 46 signed-in routes of the retained native installation were opened in a
signed-in browser and compared with the capabilities the Worker reports.

Fixed in the web client:

- **Runners.** Repository Settings → Runners was gated on the portable runner
  pools and read "Unavailable" although the native runtime reports
  customer-hosted runners as ready. It now opens the native pool chooser that
  previously appeared only on the Actions page.
- **Account pages with no native service.** Provider connections, Coding
  agents, API credentials and Account activity called procedures the native
  Worker does not implement and showed an error. On the native runtime they
  leave the account navigation and their routes explain that the page is not
  provided, without calling the API.
- **Settings navigation.** Sections an installation does not provide move to one
  closed group at the foot ("Not on this installation") once capabilities have
  loaded, instead of sitting among working sections marked "Unavailable".
- **Unavailable page.** Its heading names the feature, with a "Not available on
  this installation" state and the Worker's own reason.
- **Git access.** The clone address is a read-only field with a copy button.
- **Tables.** An empty table no longer shows its search-scope footnote.

Not changed: the native Worker still has no adapter for general workflows,
repository secrets and variables, environments, merge execution, releases, wiki,
browser file editing, archive/transfer/deletion, API credentials, the account
activity log, teams, deploy keys or email notifications
(`docs/CLOUDFLARE_CAPABILITY_INVENTORY.md`). Webhooks, PR analytics and PR agent
proposals are implemented but not configured on the retained installation. The
retained repositories are single-commit snapshots, so per-file history has
nothing to report there.

Validation: typecheck and the native build pass. The routing, settings, Git
transport, table and layout specs pass (175 tests) apart from three that fail
the same way on `main`. The full browser suite was not rerun.

## 2026-10-14 — Centered Console, full-width Workbench header, quiet unavailable row changes

At 1920 and 2560 pixels every layout was measured on the repository list, a
repository, its issues and account settings. Console was the only one with a
one-sided gap: its column sat against the rail with the remainder on the right.
It is now one centered column; the top bar shares the column's edges and the
tab rule runs the full width. Workbench's content runs edge to edge while its
header was centered, so its header now runs edge to edge too. The other seven
were already symmetric; Primer keeps a full-width header over a centered page.

Showing row changes by default exposed a backend limit: the retained native
installation answers per-path history for its imported snapshots with
`unavailable` ("Native repository operation could not be confirmed"), so every
row read "Latest change unavailable". When no row can supply a change and the
reader has not asked for row changes, the list now keeps plain rows and its
footnote says once that latest changes are unavailable for the snapshot. A
reader who asks ("Show latest changes") still sees each row's own state. The
native per-path history itself is unchanged and still fails for those
repositories.

Validation: typecheck passes and `layout-presets.spec.ts` has 24 passing tests,
including equal side gaps in all nine layouts at 1920 pixels and the unavailable
row-change case. The 1,000-row tests in `source-entry-commit.spec.ts` that
exercise row refusals pass in isolation; they are timing-bound and fail when the
machine is loaded. The full browser suite was not rerun.

## 2026-10-14 — Primer, Tiles and Console follow the layout study

The first layout change (below) placed navigation and panes but did not look
like the designs that were chosen. Primer (Classic), Tiles (Golf) and Console
(Flare) now follow the [layout study](../design/layout-study/README.md) on the
code, repository list, pull request, settings and sign-in pages.

- **Primer.** One light header band holds the mark, an owner/repository
  breadcrumb, the jump field, New repository and the tabs. The repository root
  keeps a title row; other pages put its controls beside the breadcrumb.
- **Tiles.** One top line carries the breadcrumb, branch picker and Code. The
  repository root is three full-height tiles: files, README and About. The rail
  lists the repository's sections with notifications at its foot. The repository list gains a filter tile; pull requests and settings
  use the same edge-to-edge tiles.
- **Console.** Flare takes Cloudflare's neutral scale and Inter. The top bar
  holds owner, repository and branch chips and the jump field; plain tabs sit
  under it, then the repository name and description.
- **Shared.** A jump field (`Ctrl K`) finds a repository from the first page of
  the reader's repositories. File rows show their latest change by default; the
  existing lazy per-row read is unchanged and a reader's saved "hide" still
  applies. Issues and pull request tabs show open counts from one bounded read
  each (`50+` when another page exists). "Go to file" moves into the toolbar in
  Primer and Console. Classic and Flare sign in from a centered card.

`@fontsource/inter` is the one new dependency. No schema, binding or RPC changed.

Deliberate differences from the study:

- Manual refresh and live-status controls stay, shown as quiet icons.
- The account menu, color-mode toggle and notifications stay in the top right in
  every layout. The study drew the account menu at the foot of the rail in Tiles
  and Console.
- Tiles' top line leaves Branches and Tags to the branch picker, which lists both.
- In Tiles the star control sits beside the breadcrumb and Code precedes the
  jump field, so keyboard order matches reading order.
- The header has no global issue or pull request buttons; Golf has no such pages.
- Check totals, commit totals, watch counts, a latest release, a language filter
  and an activity feed are not shown: nothing loads them.
- The pull request page has no changed-files tile on its conversation view.
- Workbench, Reader, Refined, Fewer strokes, Kumo and Overview are unchanged.

The browser suite now saves the standard layout and hidden row changes before
each test, so existing specs keep exercising the arrangement they were written
for; `layout-presets.spec.ts` clears that and covers the layouts itself.
`GOLF_LAYOUT=appearance/layout` runs the suite in another layout.

Validation: typecheck and both frontend builds pass. `layout-presets.spec.ts`
has 22 tests: every layout at 1440 and 390 pixels, the structure of the three
designs against the study, open counts, the jump field, the filter tile, sign-in
per appearance, and width checks at 390 and 900 pixels after a desktop start.
The full browser suite ran on this branch: 2,033 passed and 199 failed in 26.1
minutes. 189 of the failures were already failing in the previous full run on
`main`; of the other ten, three fail on `main` in isolation and seven passed
when rerun. Each of the three designs was compared with its drawing page by
page. Go and Worker code is unchanged. This was checked against the mocked
backend only, and not yet against a signed-in session on the hosted site.

## 2026-10-13 — Nine layout presets across the three appearances

Each appearance now offers three named layouts in Appearance settings. The
choice is saved in the browser and remembered per appearance.

| Appearance | Layouts (default first) |
| --- | --- |
| Classic | Primer, Workbench, Reader |
| Golf | Tiles, Refined, Fewer strokes |
| Flare | Console, Kumo, Overview |

A layout is a combination of shared parts set on the document by
`web/public/theme.js`, never a page-specific design: navigation (`data-nav`:
top bar, rail or sidebar), content arrangement (`data-content`: standard or
panes) and features (`data-features`). Styles and components key on those parts.

- **Rail and sidebar.** The existing Flare sidebar is now the shared side
  navigation. Rail and sidebar layouts lift the repository heading into the top
  bar; Tiles and Kumo also list the repository's sections in the side navigation.
- **Panes.** Workbench and Tiles show the existing file tree beside the file
  list on the repository root, as edge-to-edge panes with the About column.
- **Reader.** Classic Reader places the README beside the file list.
- **Fewer strokes.** Golf's keyboard layout adds `g` then a letter to change
  section, `j`/`k` to move through rows, `/` to search, `?` for the key list,
  hints beside sections and a legend. Shortcuts pause while typing or while a
  dialog is open and are off in every other layout.
- **Summary band.** Fewer strokes and Overview show facts already loaded for
  the page: visibility, default branch, feature state and last update for a
  repository; loaded, private, public and shown counts for the repository list.
  No new reads or counts were added.
- **Primer.** Classic's default uses the light header.

Below 1051 pixels every layout uses the same top-bar shell. Built-in defaults
are Golf/Tiles for portable installs and Flare/Console for Cloudflare-native.
Operators set a first-visit default as `appearance` or `appearance/layout`
with `GOLF_DEFAULT_APPEARANCE` (portable server, also exposed in
`compose.yaml`) or `default_appearance` in the native installation settings.
Both servers validate the value and write it onto the document, so it applies
before first paint; a saved browser choice still wins. No dependency, schema,
binding or RPC was added.

Narrower than the design study, and still open:

- Panes apply to the repository root. Issue, pull request, list and settings
  pages keep the standard arrangement inside the chosen navigation.
- Workbench keeps the About column rather than a one-line facts strip.
- Summary bands show loaded facts only; commit, branch, check and review counts
  need reads the page does not make today.
- The operator default is deployment configuration. An administrator screen,
  a Helm value and server-backed per-user preferences are not implemented.
- Signed-out pages keep the top bar in every layout.

Validation: typecheck, both frontend builds, `go vet`, `go test ./...`, the
generation, engine and compatibility checks, and 296 native Worker tests (one
skipped) pass. `make cloudflare-check` stops at `web/tests/navigation-cache.test.ts`,
which fails the same way on `main` (module resolution); its remaining steps pass
when run directly. The new `web/tests/layout-presets.spec.ts` (15 tests) covers
all nine layouts at 1440 and 390 pixels, the picker and per-appearance memory,
operator and native defaults, the keyboard layer and signed-out pages.

The full browser suite ran on the final branch: 2,028 passed and 197 failed in
25.8 minutes. The suite is not green on `main`: 189 of those 197 fail there in
the same environment. Of the other eight, the appearance test fails on `main`
at the same top-bar height assertion, and seven passed when rerun on the branch.
Eight existing test definitions that measure the standard arrangement or use the top-bar
workspace menu now select that layout or navigate from the side navigation.
Screenshots were reviewed for every layout; dark mode was checked for the
keyboard layout only. This was not exercised against a live backend before
rollout.

## 2026-10-13 — Concurrent evidence and preview reads

PR, Actions and Agent workspace inventories now use explicit read-only native
routes. Evidence list/status/report/compare and preview list reuse existing
handlers and current grants. Reads overlap within the existing eight-reader
limit, while both authority and dispatch admission preserve queued mutation and
revocation ordering. Mixed-action routes remain exclusive; the read routes
reject creation, cancellation, grants, renewal, capture and unknown actions.

The shared native transport handles Worker/DO rolling updates with one retry on
the original route only for an unsupported read. Permission failures, unavailable
services and mutations are not retried. The retained Alchemy rollout exercised
that fallback on real requests. Both installation paths use the same source;
there are no new dependencies, bindings, migrations or content-seeding steps.

The [retained browser comparison](compatibility/evidence/native-concurrent-reads-20261013.json)
records 120 successful reads with unchanged PR/evidence/preview identities.
With both tabs updated, alternating old/new routes on two PRs improved evidence
p50/p95 from 1585/2676 ms to 644/802 ms and preview p50/p95 from 1131/2802 ms to
253/322 ms. Each endpoint has eight observations per phase. Initial measurements
with an older tab and a page reload retained multi-second queue delays; those
results are included. This is bounded API evidence, not an instant-page or load
guarantee. The deployed Worker and workspace release/configuration agree; public
FastAPI still denies anonymous evidence/preview access. Desktop/mobile inventories
and on-demand report opening passed.

Validation: 296 native tests passed, one skipped; six frontend transport/workspace/
preview tests and the native frontend build passed. Real workerd/D1/DO checks
passed with the new read route and mutation/identity denial. Local admission
tests cover overlapping reads and a revocation waiting in either queue; existing
proposal-comparison tests also cover current, stale and revoked read aliases.
Full browser regression, multi-tenant load and new agent execution remain unrun.

## 2026-10-13 — Read-only Agent workspace and measured source reads

Native repositories now expose `/agents` and `/agents/:number`: a compact PR work
inventory with source freshness, agent/evidence/test states, current protected
previews and reports loaded only on selection. It reuses current APIs, TanStack
Query/Table, shared preview validation and global theme styles. It adds no schema,
model call, mutation endpoint, automatic merge or dependency. Unallocated agent
execution is explicit; this retained demo shows real CI evidence and previews.

The lazy UI is approximately 3.2 kB gzip. Deep links, desktop/mobile layout,
report opening, anonymous evidence/preview denial and an injected access-revocation
response were checked. Revocation removes loaded workspace rows and report data;
refresh resets failed observations before reopening the view. Current previews
expire locally as well as being authorized by the server on access.

Operations adds source/evidence/preview p50/p95 to existing D1, authority and cache
metrics. Alchemy now applies the shared observability policy. Its repeatable
`enable-observability` command enables the bounded 2048-request/30-minute history
and 1% sampled redacted request logs; invocation logs/traces remain disabled.
Live provider settings and populated Operations metrics were verified.
[Hosted UI/metrics evidence](compatibility/evidence/agent-workspace-demo-20261013.json)
records the observations and remaining limits.

The [eight-repository benchmark](compatibility/evidence/agent-workspace-reads-20261013.json)
passed all 96 reads at concurrency 1/4/16 with observability enabled. Warm p50 was
268/313/531 ms and p95 was 432/786/690 ms respectively. These are indexed pinned
snapshots and browser-to-server timings, not cold-cache, large-monorepo or fleet
qualification. Evidence/preview inventory remains slower (roughly 2–4 seconds in
the observed window); that admission/read path is the next measured target.

Validation: 293 native tests passed, one skipped; four workspace/preview tests,
five private-cache tests, six Python Alchemy tests, Alchemy typecheck/two binding
tests, frontend build and real workerd/D1/DO runtime checks passed. Full browser
regression and new agent execution were not run. Checkout/CI queue measurements,
selective inputs and a portable Agent workspace remain open in the
[staged plan](AGENT_WORKSPACE_PLAN.md).

## 2026-10-13 — Public source, profiles and discovery

The native opt-in public mode adds anonymous source/history browsing and HTTPS
clone access for explicitly published repositories. Writes, collaboration, CI
artifacts and previews retain their existing authorization. Schema 22 adds
visibility and explicitly published profile fields without changing existing
repository defaults. Access moves to `/auth/login`, and other paths verify its
signed cookie before resolving an enrolled Golf user.

User/company profiles include editable Markdown READMEs and up to six currently
public owned pins. Discovery queries D1 names, descriptions and topics with
server pagination. Repository lists and headers share Public/globe and
Private/lock indicators. The UI uses existing TanStack components, sanitized
Markdown, lazy routes and global Flare/density tokens.

[Scope, GitHub research and next increments](GITHUB_DISCOVERY_PLAN.md) record
limits and qualification gates. [The repeatable Alchemy recipe](../deploy/alchemy/README.md#public-source-and-discovery-demo)
separates schema opt-in, deployment and explicit public fixture publication.

[Hosted evidence](compatibility/evidence/public-discovery-demo-20261013.json)
records anonymous HTTPS clone, private-source denial, cached-source and profile-pin
revocation, retained admin access, profile saving, mobile topic discovery and
visibility badges. Only `mj/fastapi` is public; the remaining 17 repositories are
private. Public profiles live at `/mj`, `/mj-platform` and `/mj-labs`, without a
misleading repositories breadcrumb or global workspace dropdown.

Validation: 291 native tests passed (one skipped), 27 Python release tests, five
Alchemy deployment tests, two public fixture/readiness tests, Alchemy typecheck/two binding
tests, native frontend build, and real workerd/D1/Access runtime checks passed.
The hosted clone check caught Artifacts' shallow v0 negotiation failure; forwarding
v2 and preserving Golf's default branch fixed modern Git clones. Initial Worker /
Durable Object propagation took about six minutes and briefly returned unsupported
profile errors; seeding now waits for matching source/configuration fingerprints.
Full browser regression, legacy shallow v0 clones and anonymous load qualification
remain unverified. The existing main bundle still emits Vite's size warning.


## 2026-10-13 — Retained demo rebuilt with Alchemy

The authorized Python/`cf` demo was backed up and removed, then replaced at the
same hostname by a fresh Alchemy installation. The Python installer remains
available. The [parallel recipe](../deploy/alchemy/README.md) pins Alchemy
2.0.0-beta.83 and uses the shared native Worker build, Flare UI, approved Python
runner and demo manifest. Alchemy/Effect are deployment dependencies only.

The replacement contains 18 repositories: 12 under `mj` and three each under
`mj-platform` and `mj-labs`. All 16 pinned GitHub imports passed their reviewed
package-build/test profile and published digest-verified OCI artifacts to the
Cloudflare managed registry. Both playgrounds passed canonical CI and published
static and Worker previews. Upstream workflow matrices were not executed.
The human browser session resolves to `mj` with instance administration; machine
credentials retain ordinary repository authority. Static and Worker previews
opened through Access and Golf's existing one-time reviewer grants.

The trial caught three deployment differences: Alchemy requires an explicit
Workflow environment binding, its default Docker provenance index did not start
this runner, and its `Worker.domain` reconciliation deleted runtime-created
preview domains on update. The shared Worker now supports both workflow binding
forms; the deployer disables provenance indexes and verifies the remote runner
manifest against the approved image. A narrowly owned gateway-domain resource
preserves application domains; a live repeat deployment confirmed this. A second
small resource applies the native Workflow concurrency/retention settings omitted
by this Alchemy beta. Private schema receipts prevent bootstrap SQL replay.

Initial infrastructure provisioning took 68.1 seconds; the final repeat deployment
took 2.5 seconds, excluding content seeding. Both initial failed CI runs remain in
history. A local package-preflight permissions failure was repaired and resumed.
The teardown DNS gap produced cached NXDOMAIN on the user's Mac; flushing its
resolver restored access. Installation state includes secrets and must remain
private even when values carry Alchemy `Redacted` labels.

Validation: 284 native tests passed (one existing skip), deployment TypeScript
checks and two binding/domain tests passed, and 35 Python deployment/seeding tests
passed. The native frontend build passed. Forty-three native control bindings
matched the shared build. The new Alchemy destroy wrapper has not been live-tested;
partial teardown recovery requires inspection. Runtime provider tokens expire
after seven days; this is a retained experiment, not unattended production
operations. Full browser regression and arbitrary upstream workflows were not
rerun. [Deployment evidence](compatibility/evidence/alchemy-demo-20261013.json)

## 2026-10-13 — Access session repair and live PR preview links

The retained demo reproduced a valid human Access session followed by intermittent
401 responses from Golf's outer Access-context check, including JavaScript assets
and repository image RPCs. These failures produced blank pages or cleared the
frontend session. The Worker now verifies the signed Access assertion when runtime
context is absent, using a configured team issuer, exact audience, RS256 signature,
required expiry/identity claims and cached public signing keys. Existing runtime
context remains authoritative; unsigned email headers and cookies alone are refused.
Golf still checks active enrollment and current repository grants. Signing-key
service failures remain availability errors rather than signing the user out.

The authentication release passed 283 native tests (one existing skip), workerd
runtime checks, and signed-in browser navigation through source, packages, profile
and admin. Fifteen concurrent/batched session reads retained admin access; a request
without credentials was redirected to Access. The saved deployment records the
account's team issuer for repeatable setup and release.

Native PR conversations now show one current-commit deployment card above the
discussion. Each confirmed preview publication immediately emits repository activity;
the card shares TanStack queries with execution details and uses five-second polling
only while a visible page lacks a live stream. Current passing jobs, commit identity,
preview state and expiry filter links; previous commits and revoked/expired previews
cannot become current deployment links. PR tools now retain their canonical owner
instead of reconstructing the old installation partition. The preview daily cap
remains 20 when an installation's evidence allowance is higher. This adapts the
[Workers Builds fast preview feedback](https://developers.cloudflare.com/changelog/post/2026-10-12-faster-pull-request-comments/)
to Golf's own PRs without posting to upstream GitHub/GitLab repositories.

The preview changes passed 161 focused native tests, two preview-selection tests,
the native frontend typecheck/build and real workerd/UI checks. The retained coordinator adopted the release. A real passing canonical CI run
published a new static preview; its link appeared on the already-open PR 1,067 ms
after the READY response (2,439 ms after submission), with the stream reporting Live
and no page reload. Opening the link completed Access and current Golf permission
checks and served the actual preview. This is one measured publication, not a latency
SLA. See [session and preview evidence](compatibility/evidence/access-session-preview-links-20261013.json).
The full browser regression suite was not rerun.

## 2026-10-13 — Denser shared layout and Flare refinement

The shared shell now uses smaller page gutters, headings and section gaps. The
repository home opens directly with its inventory; desktop rows align branch and
update metadata beside the name/description. At 1440×1000, the retained 18-repository
inventory fits 13 complete rows instead of 7, with row height reduced from 95.5 to
62.5 pixels. Flare keeps its orange identity and blue actions with clearer neutral
surface levels in light/dark modes, a narrower sidebar and flatter content panels.

Organization repositories and members share a two-column desktop layout that
stacks on smaller screens. Settings use compact grouped navigation, aligned current
values and bounded editor widths. Managed-registry settings show configuration and
link to Packages rather than duplicating its artifact table. Installation allocation
details mount only when their disclosure opens. Existing TanStack routing, queries,
forms and shared tables remain in use; no dependency was added.

The reference was GitHub's repository hierarchy and Primer's
[page layout](https://primer.style/product/components/page-layout/) and
[grouped navigation](https://primer.style/product/components/nav-list/).
The changes adapt those information patterns to Golf's existing components.

Native typecheck/build and real workerd UI/Access checks pass. Browser checks use
the retained APIs through the temporary read-only operator preview, covering home,
organizations, source, Actions, Packages, PR reading and account/repository settings;
profile/general editors open and cancel, installation details expand, and Classic,
Golf and Flare switches work. No page overflow was observed at the sampled 390,
900 and 1440-pixel widths; mobile primary controls retain 44-pixel targets. The
main entry bundle decreases from 175.33 to 175.16 KB gzip; CSS increases from 24.70
to 25.09 KB gzip. Full browser regression and human-only mutation flows were not
rerun for this visual pass. [Density and live asset evidence](compatibility/evidence/enterprise-ui-density-20261013.json)
records the deployed Worker release and exact served entry/CSS bytes.

## 2026-10-13 — Repeatable demo and real owner namespaces

The retained demo now uses `mj` / Mike Johnson as the personal owner and retains
the selected email's operations-admin login. `mj-platform` contains Werkzeug,
Jinja and ItsDangerous; `mj-labs` contains Typer, Tenacity and structlog. Both have
persisted owner membership for `mj`. The original ten imported repositories and
two CI/application playgrounds remain personal. Native schema21 adds owner,
membership and repository mapping tables; existing Git/DO identities stay stable.
Repository reads, clone URLs, settings, discussions, CI and package inventories
resolve the canonical owner. Membership listings and organization repository
pagination use the current actor's access.

The [deployment recipe](../deploy/demo/README.md) saves the pinned public manifest,
CI image requirements, create/apply commands, bounded machine-authority renewal and
owned cleanup. Reapplying the retained receipt verified the same owners, repositories
and completed CI jobs; all sixteen language/file indexes were primed. A transient
provider repository-read failure was safely resumed; that read now has bounded
retries. Shared Secrets Store cleanup preserves unrelated secrets, and old-schema
preview cleanup retains its legacy owner lookup.

[Sanitized live evidence](compatibility/evidence/demo-owners-20261013.json) records
the current owner URLs, hosted passing test reports, destroyed test allocations and
matching managed-registry digests. The six added imports passed local preflight and
hosted offline wheel-build/functional smoke tests. Browser checks against deployed
APIs verified both organizations, real member rows and personal/organization package
pages at desktop and phone widths. The checker used a temporary read-only operator
proxy; it did not impersonate the human Access login.

Validation: native suite 278 passed / one existing skip, release controller 26
passed, demo controller/transport/seed/deployment checks 30 passed, focused Go
repository creation/image tests, native frontend build, real workerd runtime/UI
checks and capability inventory passed. The saved Python image recipe was rebuilt.
No second fresh installation was created; complete upstream CI matrices, runnable
application image builds and general native organization/team administration remain
open. Current native repository names remain unique across the installation.

## 2026-10-13 — Retained native demo, managed registry and shared UI

The retained installation at https://demo.gitgolf.mjtechguy.com uses Cloudflare's
managed image registry under [ADR 0010](decisions/0010-cloudflare-managed-image-registry.md).
The selected login is enrolled as an operations administrator, and the user
reported signing in. Automated browser acceptance did not impersonate that human
login. Existing CFCR installations and historical evidence remain unchanged.

[Sanitized live evidence](compatibility/evidence/managed-registry-retained-demo-20261013.json)
records ten actual GitHub snapshots: requests, Flask, HTTPX, Starlette, Click,
Rich, pytest, Pydantic, attrs and FastAPI. Their upstream main commit/tree identities
remain intact. Separate demo-ci branches have real hosted passing offline wheel
builds and functional smoke tests, destroyed test allocations, and matching
managed registry digests. The OCI artifacts contain built wheels, source archives
and JSON reports; they are not runnable application images. Full upstream workflow
matrices were not executed. Earlier failed/rerun attempts remain in private
receipts. The original two repositories also passed hosted CI and source-preview
preparation; preview access remains subject to its lease.

Packages and Actions share a compact page header, the existing TanStack DataTable,
and global CSS tokens. Packages links verified build/source receipts, provides
immutable reference copying and places registry coordinates in a disclosure.
Runner settings leads with its current value and opens a TanStack Form only on
Change runner. Desktop and phone layouts and runner edit/cancel were checked in
T3 using the built UI and an authorized live read-only proxy. Its unsupported
live stream is a preview-proxy limitation. The real runner read returned canEdit.
No new frontend dependency was added.

Repository lists request authorized metadata without per-repository Git provider
observations. One live twelve-repository request took 174 ms end to end and 22 ms
inside the Worker; this is a single observation, not a load benchmark. Fresh HTML
embeds its already verified session, removing a duplicate bootstrap request.
Opening a repository pre-reads exact-commit root entries, overview, latest commit
and README without delaying that response. Language/license and full path indexes
were primed for the imported main commits; bounded immutable caches keep current
permission checks. Packages navigation no longer downloads inventory on every page.
Public HTTPS README images no longer depend on a fixed domain list, while private
host/IP rejection, byte limits and SVG sanitization remain in place.

Validation: 277 native tests passed with one existing skip; 25 demo-controller tests,
portable image tests, generated-file checks, the native web build and real local
workerd/D1/Secrets Store and Access UI checks passed. Latest Worker and workspace
coordinator releases match. Owned managed CI tags are included in scoped stop
recovery; cleanup of this retained installation was not executed. Provider tokens
expire after seven days, source-preview leases after four hours, and resources
remain retained until explicitly stopped. Alchemy remains optional future work.

## 2026-10-12 — Disposable CFCR integration and guarded release rehearsal

The [sanitized hosted receipt](compatibility/evidence/cfcr-hosted-rehearsal-20261012.json)
records a complete disposable Golf/CFCR run. Exact native CI image publication,
registry clients and authority revocation, five managed scanner reports, and the
schema18 guarded release/served rollback/served promotion passed. The initially
interrupted image upload was recovered through the partial-setup cleanup path.
All 26 final owned resource categories were absent and the independent stop timer
was cancelled. This is one synthetic workspace, not a retained rollout or load
qualification; migration-bearing rollback remains open.


## 2026-10-12 — Scanner cache reuse and managed requalification

Independent CFCR commit `e5812ee` reuses verified immutable database images, compatible Syft
inventory, and exact current registry-generated scan evidence. Reuse preserves
original age and upstream producer trust; revoked producers, changed recipes,
stale feeds and removed reports fail closed. Trivy still analyzes the image
independently. Bounded stage/byte receipts make cache behavior inspectable.

The [P2/P3/P4 packet](HYBRID_EXECUTION_AND_CFCR_PLAN.md#22-database-inventory-and-evidence-reuse-packet--2026-10-12)
and [sanitized receipt](compatibility/evidence/cfcr-scanner-cache-20261012.json)
record real local results: first verification plus execution 8.476 s, verified
full scan 4.782 s, inventory reuse 4.386 s, and an exact evidence hit with no
container. This is a tiny 524-byte input fixture with the scanner image already
installed, not a large-image benchmark. Cancellation/crash recovery/owned cleanup,
62 JavaScript + three Python tests, 75 OCI specs (four conditional skips), and
production preparation passed.

A disposable managed Cloudflare check reproduced the readiness internal error
before any reports. Its exact Worker, container application and uploaded image
were removed and verified absent; the independent cleanup timer was cancelled.
The native startup gate remains open. No retained demo or product rollout was
made. Automatic DB updates, imported CI evidence, broader workload benchmarks,
snapshot qualification, general native workflow runners and previous D1 rollback
gates remain unfinished. Golf application code did not change in this slice.

## 2026-10-12 — Hybrid execution plan and independent external scanner

Existing work is checkpointed on Golf main `36f7d01` and independent CFCR main
`1a2470b`; development continues on `feat/hybrid-runners-cfcr` in both repositories.
The [detailed hybrid execution plan](HYBRID_EXECUTION_AND_CFCR_PLAN.md) records
P0–P9, service choices, execution/trust/cache contracts and acceptance gates.

Independent CFCR now has an opt-in outbound external scanner path: current-admin
machine enrollment, exact-job leases, immutable reports, producer revocation,
cleanup quarantine and explicit recovery. Its rootless-compatible Docker
supervisor keeps credentials out of the scan container. Real local workerd +
Docker qualification produced five reports twice in about eight seconds per
small vulnerable fixture, with running cancellation, SIGKILL recovery and owned
cleanup. Trivy uses read-only database files without a per-job database copy.
[Sanitized evidence](compatibility/evidence/cfcr-external-scanner-20261012.json)
records the scope; this is not a hosted or large-image performance claim.

Golf's full checkpoint `make check` passed. No hosted resources were deployed for
this slice. The previous managed scanner startup and D1 rollback-preflight gates
remain open, along with general native workflow execution, fleet/UI enrollment,
evidence reuse and the rest of the phased plan.

## 2026-10-12 — Cloudflare/CFCR qualification and preview discoverability

See the [qualification packet](CLOUDFLARE_FULL_QUALIFICATION_2026-10-12.md) for real hosted results, failed attempts, timing receipts and cleanup. Native CI now publishes an exact-commit OCI image into separate CFCR: the full agent/test bundles had omitted the private authorization entrypoint. Both exports are repaired and production preparation checks configured exports against the built bundle. Registry infrastructure failures preserve bounded diagnostics, terminate as LOST and destroy the job container.

Immutable file history reuses the bounded shared navigation cache after current access verification. PR conversation/Checks and native run rows prominently expose protected deployment URLs, copy actions and expiry, with job/commit matching and revocation masking. Shared mobile copy-control overflow is fixed. Cloudflare final-authority queue/database timing is visible separately in Operations.

This is not a full qualification sign-off. Loaded-workspace metadata tails and incomplete large-repository indexing remain open. Hosted Docker/regctl/Cosign, OCI (71 passed, eight skipped) and live authority checks now pass. A post-indexing 60-read sample has zero failures and warm p50 223 ms / p95 832 ms; this does not close loaded-workspace contention. Native scanner startup still fails; the final release rehearsal failed at rollback preflight with provider D1 HTTP 403/API 7403 after release convergence; rollback/promotion remain unverified; general native Actions/GitLab execution remains outside the approved Python-module runner. All owned resources were removed and the independent stop timer cancelled at 02:11 UTC.

## 2026-10-11 — Deeper CI fault, concurrency and Forgejo qualification

The advanced maintained Actions launcher now supports a fresh, digest-pinned
Forgejo installation with an inventory-matched API baseline. Real signed-push
testing exposed two portability bugs: Forgejo's callback allowlist belongs under
`webhook`, and its signed webhook headers omit the installation-scope header
the earlier backend sent. Both are fixed. Golf then required matching header
aliases, valid HMAC and the existing immutable repository/owner binding; since
2026-10-16 only the `X-Forgejo-*` headers are accepted. Rejection tests include duplicate/mixed
headers, invalid signatures, organization scope and signed foreign repositories.

The unchanged PSF Requests lint workflow now passes on **Forgejo** with actual
checkout/setup-python actions, pre-commit, signed push admission, restricted
dependency egress, timeout, running cancellation and owned cleanup. The
[receipt](compatibility/evidence/requests-forgejo-deep-20261011.json) binds current
binaries, source hashes, provider image and API baseline. This extends earlier
evidence from the native forge at the time; it does not expand the supported Actions language.

The separate [Forgejo worker-loss packet](compatibility/evidence/worker-loss-forgejo-deep-20261011.json)
passed `.forgejo/workflows` precedence, historical exact Git source, two dependent
jobs with fresh workspaces/scoped logs, manual and signed-push execution, and
restart without replay. A real `SIGKILL` during a running step left owned residue;
ordinary startup refused reuse. Explicit recovery fenced the original attempt as
lost, removed its containers/volumes and created no replacement run. Owned stack
cleanup passed and foreign container identity remained unchanged.

Actual Cloudflare cancellation during clone found a terminal-state race:
destruction interrupted preparation, whose exception replaced cancellation with
`LOST`. Cleanup now preserves the first terminal result and shares in-flight
destruction. A second regression fences late authorization after cancellation;
a recreated task also retries cleanup without restarting execution. Both original
race counterexamples fail before the fix and pass afterward.

The final [hosted resilience packet](compatibility/evidence/ci-hosted-resilience-20261011.json)
passed six-way original-intent replay, conflicting input refusal, six requests
competing for one remaining daily slot, exhausted-budget refusal with replay,
repeated cancellation, denied reader cancellation, cross-repository status/report/
cancel isolation, successful and failed exact-head tests, staleness and reader
revocation. Cancellation was observed after admission, not confirmed command
start. All eleven cleanup categories are absent. This was a disposable,
machine-authenticated installation; no human login or retained rollout occurred.

Twelve PostgreSQL coordination-test families passed three times under `-race`
(36 executions, no skipped cases), including lease loss, competing dispatch and
cancel, pool capacity, current-authority changes and artifact privacy. Its
[receipt](compatibility/evidence/ci-database-races-20261011.json) distinguishes
actual database tests with native HTTP fixtures from real forge/job execution.
The full Go suite, Cloudflare checks, compatibility checks, targeted webhook and
container regressions, and six migration-tool tests passed.

Failed attempts remain in a [separate record](compatibility/evidence/ci-deep-failed-attempts-20261011.json).
One initial hosted Git push returned an unexplained HTTP 500; later fresh
installations passed. The expanded harness also exposed a stale two-job cleanup
guard, now shared with its configured allocation limit and verified in the final
run. All earlier provider resources were removed. **Native Cloudflare Actions/
GitLab YAML execution, full GitLab pipelines and sustained production load remain
unqualified.** See the [complete qualification report](CI_QUALIFICATION_2026-10-11.md).

## 2026-10-11 — Shared UI review and real cross-runtime CI qualification

Cold portable file reads now use the source endpoint's authorization receipt,
avoiding the redundant metadata request; retained source still requires a fresh
authority check and is hidden after denial. Shared source/diff menus stay within
narrow viewports, and commit summaries remain visible at320px. These components
serve portable and Cloudflare builds. The navigation regression fixtures now
revoke access at the intended request boundary and wait for asynchronous workflow
inspection instead of racing render completion.

GitLab-format shell jobs now accept bounded job-level `before_script`; setup and
`script` share one shell, variables, functions and working directory. A failed
setup stops execution. Inspection and compilation agree on the combined50-entry
bound, including the Actions step bound. Global/default setup, `after_script`,
includes/rules and multi-job GitLab pipelines remain unsupported. This is not
GitLab Runner compatibility.

Current Forgejo/Docker CI passed actual Actions and GitLab shell execution,
failure/cancellation, queue restart persistence, log/history pagination, policy
revocation and owned cleanup. [Its receipt](compatibility/evidence/ci-review-20261011.json)
is separate from the broader [CI qualification report](CI_QUALIFICATION_2026-10-11.md).

The unchanged PSF Requests lint workflow passed on the maintained Actions engine
with real pinned checkout/setup-python actions and pre-commit. Actual signed-push
admission, scoped dependency egress, denied private/direct egress, one-minute job
timeout and running cancellation passed, with attempt resources removed. Its
dated receipt bound the current binaries/source hashes. This advanced packet ran on
the native forge at the time (an earlier backend, since retired) and its receipt was
removed with it; the Forgejo run of the same workflow is recorded above.
An initial preparation attempt used the sanitized Git-image receipt (which omits
local acquisition fields); a second correctly rejected stale frontend assets.
Both were corrected before the successful third attempt. Neither failed attempt
is counted as a pipeline pass.

The actual secret/variable packet passed matrix/dependent job execution, encrypted
raw-output quarantine, cross-chunk exact-secret masking, value-version changes,
repository-admin loss, approval-session logout, binding removal and drained key
rotation followed by restart without the retired key. Its
receipt (collected on the native forge at the time, since removed) recorded the
bounded scope; transformed-secret concealment and broad Secrets/OIDC are not
qualified. The shared native test-proxy validator now accepts AMD64 and ARM64
and checks the binary architecture against the actual immutable container image.
Both positive architectures and mismatched image/OS/architecture/hash cases pass
pure counterexample checks.

The real GitLab-format artifact producer passed exact private archive validation,
independent signed object-store readback, refused storage-outage fallback, retained
readback after restart, and reader revocation. Its fresh RustFS/Docker stack is
removed. The artifact receipt (collected on the native forge at the time, since removed)
is not GitHub artifact/cache protocol compatibility. Two preflight attempts stopped
before creating a stack: missing pinned RustFS image, then the ARM64-only test
proxy guard. The image was acquired and the shared guard fixed before the passing
run. All temporary local qualification images and owned runtime resources were
removed after the final packet.

The real Cloudflare packet passed canonical Artifacts Git, private PR test success
and failure, stale-source checks, evidence-reader revocation and scoped machine
access. Both canonical YAML fixtures were read back byte-for-byte, but Actions
and GitLab inspection/dispatch returned typed501 `unimplemented` responses.
**Hosted YAML pipeline execution is missing; cross-runtime enterprise CI is not
qualified.** All temporary cloud resources are confirmed absent in the
[hosted receipt](compatibility/evidence/ci-hosted-review-20261011.json). No human
login, retained deployment update or ongoing demo was required.

Validation: `go test ./...` without the database environment, maintained engine
checks, compiler/shared-shell counterexamples, generated contracts, compatibility,
Cloudflare checks, TypeScript and both frontend builds passed. The broad browser
run passed277/279; the two timing failures were corrected and the affected routes
plus diff suite passed91/91, followed by the focused capability-recovery check.
Fresh/cached source authorization and mobile menus have explicit regression tests.
Full historical database integration, every Actions/GitLab feature, positive human
hosted browser coverage and production-scale load are not claimed.

## 2026-10-11 — Forgejo portable foundation and staged import qualification

[Setup and exact limits](FORGEJO_SETUP.md) now cover explicit Forgejo configuration,
legacy aliases, schema095 installation/workflow binding, neutral CLI tokens,
`.forgejo/workflows` discovery/dispatch and shadow diagnostics, provider-aware
login/Operations labels, separate rootless Compose and guarded Helm profiles.
An API inventory against the earlier backend recorded 410 shared route pairs,
72 source-only pairs and 81 target-only pairs; matching paths are not parity. It was
replaced on 2026-10-16 by the register based on Forgejo 15.0.9's served Swagger.

Actual Forgejo15.0.9/PostgreSQL smoke checks passed private source/Git/CLI access,
revocation, workflow inspection/precedence and native PR/review creation. Actual
Compose CI passed `.forgejo` Actions and GitLab-format shell jobs, restart
persistence, denied dispatch, failure/cancellation, source/log receipts, history
pagination, policy revocation and cleanup. A staged importer rehearsal from the
earlier backend transferred core Git/collaboration metadata but **lost one private
pending review**. The importer was removed on 2026-10-16, when migration was
superseded.

Validation: focused PostgreSQL/race tests, final `go test ./...` without the database
environment,102 focused shared UI tests, frontend build, generated contracts,
compatibility and Cloudflare checks passed. Helm lint/render and separate Compose
configuration checks passed. An earlier broad PostgreSQL run found the existing
OAuth downgrade test's conflict with migration092's no-downgrade guard and was
stopped during lengthy cleanup; the full historical integration suite is not
qualified. A timing-sensitive runner cancellation test failed in an initial busy
run, then passed five targeted repeats and the final full unit run.

No retained installation, production default, cloud deployment or source authority
was changed. Backend replacement detection at an unchanged URL, all APIs/roles,
coordinated recovery, Kubernetes runtime and performance/scale remained open (see
ADR 0009 for the current list). All owned native/CI containers, volumes, networks
and temporary CI image were removed. See
[ADR 0009](decisions/0009-forgejo-portable-backend.md) and the
[qualification receipt](compatibility/evidence/forgejo-local.json).

## 2026-10-11 — Forgejo transition direction accepted; planning only

The user selected Forgejo as the destination for portable Golf and the
origin-backed bridge, recorded in
[ADR 0009](decisions/0009-forgejo-portable-backend.md). A transition plan (since
folded into the ADR) covered version/API inventory, configuration compatibility,
native behavior tests, CI discovery, data/identity migration, shared UI/packaging,
recovery, cutover and retirement of the earlier backend. Cloudflare-native and
independent CFCR retain their existing architecture. No Forgejo runtime was started,
no migration was run and no deployment changed.

## 2026-10-11 — Deep-history comparisons, native merge diagnostics and CFCR job publishing

Native coverage is **91/298 shared procedures** (207 remain). The new merge
observation adapter binds the exact PR revision and selected commits, checks
current repository authority and reports source/target freshness and branch lock
state. The shared PR UI exposes these observations separately from publication.
All native merge methods remain disabled: diagnostics do not implement protected
merge, trusted required checks, write-ingress fencing or ambiguous-write recovery.

Short linear comparisons now avoid walking old common history. Both commit
identities are validated; merges fall back to the existing bounded DAG walker.
Tests cover 10,000-commit history, reversed comparisons, missing commits,
60 deterministic DAGs checked against an exhaustive oracle and real Git patches.
The hosted fixture added 1,000 actual Artifacts commits; its exact one-commit
comparison took **429 ms**, then **283 ms**. Its unchanged small tree and single
service principal do not qualify large-tree diffs or global concurrent load.
Eight additional final-release comparisons at concurrency four all passed; the
first batch took roughly 1.5 seconds and the next 380–448 ms. These slower burst
observations remain in the [speed record](CLOUDFLARE_SPEED_QUALIFICATION.md).

The independent CFCR integration now supports an explicitly enabled native job
broker. Credentials bind the current job, repository, actor, commit, policy and
deadline; repository code receives only registry/image/source coordinates.
CFCR restricts job tags, rejects management/deletion and isolates upload sessions.
Current execution/access checks deny stale or cancelled jobs. Successful tests
can retain an independently digest-verified image receipt after container cleanup,
shown in the shared report UI. This is not signed build provenance or a general
Docker image-build workflow. Setup and limits: [CFCR integration](CFCR_INTEGRATION.md).

Local validation passed:

- `make cloudflare-check`, both frontend builds and 129 focused shared browser
  cases, including native merge diagnostics and image receipts at 390 and 1440
  pixels. Receipts fit without page overflow, stay out of browser storage and
  disappear after current-access denial.
- 152 final core/task tests, six comparison tests and 15 native operator/setup
  tests, including the maintained actual-Git deep-history fixture self-check.
- 42 CFCR JavaScript tests plus the Python archive-boundary check; default and
  CI-enabled native build-output validation.
- Real Docker build/push/remove/pull with identical image identity; cancellation
  then denies pull. This check uses a fixture execution authority.
- Actual local Golf Worker/D1/private service bindings → CFCR → current Golf
  execution authorization → OCI publication/digest readback. Changing the source
  denies later access. The running job and Artifacts transport are fixtures.

Hosted run `golf-native-20261011-4e4a3c97` passed real Git/PR/check/review tests,
passing and failing container CI, stale-source refusal, Workflows/R2 evidence, protected static and Worker previews,
grant replay/revocation, isolated D1/R2, Secrets Store signing and egress denial.
The service-auth browser preserved document identity through Code → PR list → PR
detail, used Archivo and had no horizontal overflow at 1280×800. The first merge
observation completed; a follow-up read triggered focus revalidation. Both states
are retained in its `merge-browser-proof.json`. The private temporary browser proxy
is stopped; human-cookie and secure-context behavior remain unqualified.

Release `09a8e092a63b289e0f736df56f068172be2dfc5d16d84c809be6bf852124b611`
passed guarded migration/check/deployment, all 111 served asset hashes, compatible
rollback and promotion. The unrecorded predecessor and machine administrator
access were refused. Each stage required matching Worker/workspace release
observations; several-minute convergence delays were retained. The predecessor is
a same-schema HTML-comment baseline, not an independently old frontend chunk.
After promotion, eight more concurrent comparisons passed, with 580–1102 ms client
times and zero coordination queue time; provider setup/token calls and D1 reads
remain measurable costs. No global latency guarantee is established.

The unattended run finished successfully at **21:33 UTC**, before its independent
21:43 UTC deadline. All **24 owned resource groups** are confirmed absent,
including 125 owned R2 objects and their bucket, canonical Artifacts namespace,
databases, Workers, container applications/image, Access resources and temporary
provider credentials. The cleanup timer is inactive; qualification credentials
are removed or revoked. The owned local image alias and temporary browser/test
servers are gone. Recorded backend/operator source hashes still match. No hosted
demo remains running. No hosted CFCR registry was allocated, and no personal
login, IP bypass or AI call was needed.
[Final ownership and checks](../.tmp/cloudflare-forge/golf-native-20261011-4e4a3c97/ownership.json),
[browser observations](../.tmp/cloudflare-forge/golf-native-20261011-4e4a3c97/merge-browser-proof.json),
[concurrent timing](../.tmp/cloudflare-forge/golf-native-20261011-4e4a3c97/deep-comparison-promotion.json).

The full six-priority scope remains open: protected publication, complete
environment lifecycle, broader collaboration, hosted CI-to-CFCR qualification,
large-tree/multi-tenant scale and a lasting curated demo. See the explicit
[execution checkpoint](REPOSITORY_PARITY_PLAN.md#2026-10-11-execution-checkpoint).

## 2026-10-11 — Shared file finder, cached native inventory and keyboard polish

The new `GetRepositoryFileIndex` adapter brings native coverage to **90/298 shared
procedures** (208 remain). The shared **Go to file** dialog works across local,
Docker, Kubernetes and Cloudflare-native, with `t`, Enter and arrow navigation,
Unicode/literal paths and immutable commit links. It finds unopened nested files
without fetching their contents. Native indexes reuse D1/R2 under current authority;
portable reads use supported forge object APIs with pre/post permission checks.

Inventories are complete or refused: 10,000 paths, 512 directories including root,
1 MiB of path bytes and existing literal-path bounds. Submodule repositories and
full-text contents are not searched. Only 50 matching links render at once, with
an explicit count. Closing discards private browser inventory; filenames are not
persisted in browser storage. The shared details dialog now restores its original
focus target through StrictMode replay. Native clone menus open repository Git
credentials instead of pointing users to unsupported account SSH settings.

Local validation passed:

- 25 file-finder/source-navigation browser cases; 96 additional shared repository
  routes, access and reviewer cases. Phone and desktop layouts covered all four
  runtime profiles; no full-document navigation and no stored private filenames.
- Full server unit suite, plus race-enabled isolated PostgreSQL file-index/source
  selection tests. Wrong repository, changed identity, permission loss during reads
  and rebound repository identity all deny results. The owned DB container is gone.
- Native tests cover shared-tree deduplication, missing objects, count/byte/depth
  limits, a warm index with Artifacts unavailable, and permission loss despite a
  cached result. `make cloudflare-check`, both frontend builds and real local
  workerd/Access/D1/Queues/Workflows/R2 runtime checks passed.

The disposable hosted run `golf-native-20261011-f4a32b11` has verified all nine
feature-commit filenames against actual `git ls-tree`, with a **106 ms** warm HTTPS
inventory read. Five metadata reads measured 183–247 ms (median 204 ms). These are
small-fixture observations, not large-repository or global-load results. Eight
concurrent inventory requests by one service principal completed at 113–289 ms
(median 252 ms), all with the requested repository/commit and nine paths
([receipt](../.tmp/cloudflare-forge/golf-native-20261011-f4a32b11/file-finder-concurrency.json)). Shared
browser inspection confirmed Archivo, nested CODEOWNERS selection at the exact
commit, unchanged document identity and no private filenames in browser storage.
The private HTTP service-auth proxy is stopped; it does not qualify secure-context
or human-cookie behavior. [Browser receipt](../.tmp/cloudflare-forge/golf-native-20261011-f4a32b11/file-finder-browser-proof.json).

The full unattended hosted run passed and finished at **20:37 UTC**. Release
`840833a7085a6c97cf8691ca0396469b5b1e619ffdf07b9d19fdd34b31cbb53b`
passed guarded migration/check/deployment, verification of all 111 served asset
hashes, compatible rollback and promotion. Edge/workspace version agreement was
required after every deployment; multi-minute propagation was observed. The
unrecorded rollback predecessor was refused. This still uses the documented
same-schema HTML-comment baseline, not an independently old frontend chunk.

Real Git push/clone, PR review/checks/evidence, passing and failing container CI,
stale-source refusal, current-reader/replay/revocation checks, protected static and
managed Worker previews, isolated D1/R2, Secrets Store signing and outbound denial
passed. No personal login, OTP, IP bypass or new AI calls were used. All 24 owned
resource groups are confirmed absent, qualification credentials are removed or
revoked, and the independent cleanup timer is inactive. No hosted demo remains
running. Runtime backend source hashes match the recorded run.
[Final ownership/checks](../.tmp/cloudflare-forge/golf-native-20261011-f4a32b11/ownership.json).

Full protected merge, larger background search, native adapter completion, hosted
human-cookie/secure-context checks and production/global scale remain open.


## 2026-10-11 — Hosted schema18 rollout and unattended qualification

Release `d20a2a027cb1dc852bd9a2d9bee9b2b84a8a86b43821fdee393358e8f4ae144c`
passed the bounded service-account suite at `gitgolf.mjtechguy.com`. The final
installation ran from 05:40 to 06:00 UTC, within its independently armed 45-minute
cleanup deadline. No personal Access login, OTP, IP bypass or human impersonation
was used. All 24 owned resource groups are confirmed absent, temporary credentials
are removed/revoked, the test proxy is stopped and the timer is inactive. No demo
remains running. [Aggregate receipt](../.tmp/cloudflare-forge/20261011-unattended-summary.json)
and [final ownership/checks](../.tmp/cloudflare-forge/golf-native-20261011-78328ad4/ownership.json).

- Guarded migration/check/deployment, compatible schema18 rollback and promotion
  all passed, with matching edge Worker and workspace versions. All 111 served
  retained assets matched their hashes. Rollback to an unrecorded predecessor
  was refused; the pending-review privacy floor remains enforced.
- Actual Artifacts push/clone, immutable browsing, issues, PRs, reviews, source-bound
  checks/evidence, replay, stale-source rejection and reader revocation passed.
  Both passing and deliberately failing CI jobs produced the correct reports and
  destroyed their containers. Queues, Workflows and R2 carried the evidence.
- Protected static and managed Worker previews passed Access/service-grant,
  replay and revocation checks, Browser Run capture, isolated D1/R2, Secrets Store
  signature and outbound-denial checks. This is service-auth coverage, not an
  actual reviewer Access sign-in.
- CODEOWNERS came from actual Artifacts. Default-branch settings and Git HEAD
  agreed, with stale revisions rejected. Explicit disposable D1 fixtures verified
  branch locks, repository-only read credential scope/revocation, and pending/
  discarded draft privacy. All 17 human-only management methods rejected machine
  credentials; Operations admin access also remained denied.
- Shared browser Code→Settings navigation retained its document, Archivo loaded,
  all nine settings destinations appeared, and General description save/restore
  succeeded. [Browser evidence](../.tmp/cloudflare-forge/golf-native-20261011-78328ad4/browser-proof.json).
  The authenticated private HTTP test proxy does not qualify secure-context or
  human-cookie behavior. Five metadata reads measured 166–193 ms (median 185 ms).
  A separate earlier run observed a real live issue event 300 ms after mutation
  ([stream receipt](../.tmp/cloudflare-forge/golf-native-20261011-8c807a0f/hosted-stream.json)).

An earlier attempt separately completed Clef/AI Gateway and two concurrent agent
proposals with canonical Git unchanged and both containers destroyed. Its 42 backend
source hashes match the final run; that entire attempt remains marked failed due
to a later overly specific test assertion, not relabeled as passing.
[Agent evidence](../.tmp/cloudflare-forge/golf-native-20261011-0ed3ae1d/ownership.json).
Other failed attempts retain receipts for a stopped fixture correction, a provider
Worker-create failure, the rehearsal's wrong HTML filename and a 60-second wrapper
timeout. Harness fixes preserve the native asset inventory, allow 300-second release
commands and require edge/workspace convergence. All six attempts' cleanup receipts report owned resources absent; all six timers
were separately checked as inactive.

The new `--unattended` path is documented in [native setup](CLOUDFLARE_NATIVE_SETUP.md#unattended-hosted-qualification).
Validation also passed 46 focused Python checks and actual local workerd/D1 review
assignment, notification, private draft, publication, dismissal and receipt replay.
This closes bounded hosted service-account qualification, not full GitHub parity.
Positive hosted human-only mutations, large-repository/concurrent/global load,
and the remaining 208 shared adapter gaps remain open. The baseline differs only
by an HTML comment; a uniquely old frontend chunk was not separately exercised.

## 2026-10-11 — Native PR review workflow and default branch (schema18)

Eleven additional bounded shared procedures bring the native adapter inventory to
89/297 (208 remaining). This closes selected collaboration gaps, not the full
GitHub parity plan or protected merge acceptance.

- Existing shared reviewer UI now requests/cancels enrolled repository accounts.
  Identity/grant generations prevent revoked requests from reappearing after
  remove/re-add or disable/re-enable. Requests create inbox notifications even
  without a subscription; publishing an overall review completes its request.
- Own-account pending overall summaries can be created, edited, published or
  discarded. Pending/discarded rows are excluded from other readers' review lists;
  private edits emit no shared timeline, notification, webhook or live event.
  Discard clears body text. Exact source/revision checks fence stale publication,
  own-PR approval is refused, and source changes still permit explicit discard.
- Administrators can dismiss reviews and restore only the latest non-stale
  approval/change request from a currently accessible author. These observations
  do not establish eligible protected approvals. Original operation receipts omit
  plaintext draft/reason inputs and remain inspectable after lost acknowledgments;
  replay cannot reapply an earlier effect.
- CODEOWNERS suggestions use the exact base commit, `.github/CODEOWNERS`, root,
  then `docs/CODEOWNERS` precedence and bounded case-sensitive GitHub-style globs
  with last-match/empty-owner semantics. Matching avoids repository-supplied regex.
  Unsupported syntax, email owners, escaped patterns and bounds are explicit;
  no automatic reviewer requests or membership/approval eligibility is inferred.
  The existing portable native-format regex consumer remains separate.
- Native General edits an existing default branch. Provider ref lookup and a
  transaction-bound identity/grant/settings revision fence protect the update.
  Description/website/topics gain the same effect-time authority checks. Golf's
  Git advertisement rewrites HEAD/symref to its selected branch; canonical objects
  and the provider's direct URL metadata are unchanged. Default-branch updates
  publish source/PR invalidations. Feature toggles remain operator-managed.

Migration0018 is additive and preserves original receipts; the release/rehearsal
schema is18. **Rollback to code below schema18 is refused**, because that code does
not filter pending review bodies. Compatible predecessor bytes remain verified.
A fix forward is required if no recorded schema18 predecessor exists.

Validation:150 focused backend/Git tests (including actual Git `ls-remote --symref`
against the broker),48 shared browser cases (portable and native, desktop/mobile),
22 release/migration tests, full `make cloudflare-check`, both frontend builds,
actual workerd/D1 review transactions and the built UI/Access/D1 checks passed.
Artifacts reads in the review runtime check are fixtures; no new hosted Artifacts
publication is claimed. Builds retain the existing >500kB chunk warning.
Temporary runtimes were disposed; no Cloudflare resources or jobs were started.

The source-only checkpoint above is superseded by the bounded hosted
service-account qualification recorded at the top of this ledger; positive hosted
human-only mutation coverage remains pending. The disposable demo is removed.
Protected merge/check authority, inline/pending inline threads, native file writes,
repository lifecycle, general CI/CD administration, releases/wiki/notifications,
Golf Apps, security/insights and Projects/Discussions remain in the parity plan.

## 2026-10-11 — Native repository Git credentials

Four GitTransportService adapters now enable own-account repository HTTPS
credentials in the shared settings UI. Secrets are displayed once; only SHA-256
hashes persist. Native binding metadata explicitly identifies Golf identity/grant
lifetime rather than inventing a browser source session. Portable Golf keeps its
existing session semantics. Desktop/mobile native controls describe write rules,
expiry and the fact that Access sign-out alone does not revoke a credential.

Read/write mode, exact repository identity, current grants/account state, expiry
and explicit revocation govern Basic/Bearer admission. Tokens cannot call Golf
RPCs or address another repository. Generation checks prevent grant/account ABA
from reviving a token; Git writes recheck credential authority during reservation
and reads recheck before returning content. Existing branch locks/tag restrictions
apply. One account can allocate at most 100 unexpired/unrevoked credentials.
Schema17 adds only the credential table and inventory index; interrupted migration
and missing-index recovery preserve the original hashes/metadata.

Validation: 128 core tests, 20 migration/release tests, 47 focused Git/Rules browser
cases, full `make cloudflare-check`, both frontend builds, `make generate-check`
and focused portable `TestGit` Go tests passed. An actual Git client answered the
broker's Basic challenge and listed fixture refs. Actual workerd/Access/D1 proved
issuance, own inventory, Basic write admission reaching a branch-lock denial,
revocation, spoof rejection and disabled-user rejection. Source tests also cover
lost creation acknowledgement, allocation limits, cross-scope denial and
revocation during provider lookup. The shared T3 browser returned a connection
error for the local server, so no manual visual check is claimed. The pre-existing
frontend chunk-size warning remains.

The previous hosted demo remains removed; no provider resources were created or
Access policy weakened. The temporary local server was stopped. Hosted Access
machine-admission and new-token Artifacts clone/push qualification remain open.
Git receive-outcome inspection, protected PR merge and metadata pruning remain
unimplemented. Credentials expire in 5–60 minutes; Access browser sign-out alone
does not revoke them. Native coverage is 78/297 bounded adapters, with 219 missing.


## 2026-10-11 — Native branch locks and tag restrictions

Cloudflare-native now implements the three shared Rules RPCs and the existing
repository settings route. Administrators can create/edit/remove branch locks
and enrolled-account tag restrictions. Literal or single trailing-prefix patterns
are enforced on canonical Golf Git writes, including administrator creation,
forced updates and deletion. Every matching tag restriction must allow the
writer. Stable account IDs prevent login-name reuse from transferring permission.
Portable forms retain their broader configuration; native forms and
inventories show the supported policy without unused review, team or merge fields.

Schema16 adds policy snapshots and original mutation receipts. D1 commits both
atomically, revisions reject stale/ABA edits, and original request replay returns
historical evidence without restoring old rules. Rules cannot change during an
unresolved Git write. Git reservation rechecks current access/identity/credential
and policy generation after provider lookup. Denials leave no provider effect,
pending lock or orphan Git operation. Allowed-account resolution uses one bounded
D1 query rather than one round trip per name. The release helper refuses rollback
to code without rules enforcement and verifies a compatible predecessor against
its recorded bundle digest before dispatch.

Validation: 119 core tests (including lost acknowledgements, receipt rollback,
revocation/identity ABA, overlapping rules and reused account names), 19 guarded
release/migration tests, 77 focused Rules/mutation/settings browser tests, both
production frontend builds, and full `make cloudflare-check` passed. Actual local
workerd/Access/D1 checks passed policy/receipt commit, denied administrator pushes,
original replay and disabled-user admission. Existing workerd/D1/DO/Queues/
Workflows/R2/Secrets Store checks also passed. The shared T3 preview could not
connect, so no manual visual inspection is claimed. The existing frontend chunk
size warning remains.

This is not protected PR merge, trusted checks/reviews, signing, force-push
exceptions or provider-side Artifacts protection. Direct provider write
credentials stay outside the Golf broker's enforcement boundary. Receipt
retention/pruning remains open. Native coverage is now 74/297 bounded adapters,
with 223 missing; full parity is unfinished. The prior hosted demo remains fully
removed. No provider resources were started or deadline extended; hosted schema16
qualification awaits a fresh bounded installation.


## 2026-10-10 — Native repository webhooks

Webhooks now has a working Cloudflare-native backend behind the shared settings
editor: all five subscription/history/test/redelivery RPCs, encrypted endpoint and
signing-secret storage, transactional source/discussion/native-test events, bounded
retries, original delivery receipts and current sponsor authorization. Revoking
then restoring a grant does not reactivate old delivery consent. Exact approved
HTTPS origins and a dedicated Secrets Store encryption key are required. Portable
email controls stay separately gated; runtime-specific help describes the actual
native limits. Operations reports queue count/age, failures and maintenance status.

Schema15 adds only webhook tables/indexes/triggers. An actual workerd test caught
the older maintenance journal's fixed stage constraint; the additive webhook
journal preserves that existing data. Setup rejects malformed policy before writing
files. Interrupted migration and lost-acknowledgement tests preserve the budget
and recover missing objects without repeating provider effects.

Validation:111 core tests,20 webhook browser cases,14 native setup tests,17
release-helper tests, both frontend builds, make cloudflare-check, built native
UI/Access checks and real local workerd/D1/DO/Secrets Store/cron checks passed.
The focused checks additionally cover ciphertext identity binding, expired leases,
quota/concurrent drains, redirect refusal, uncertain responses, stale edits and
revocation during encryption. The pre-existing >500kB frontend chunk warning
remains. No local test server was left listening on4179.

Hosted schema15 release `42fe30e0331aada0dd908d3fa03c1a4c0dde597417fea9179b56e687d6f6f64d`,
Worker version `5e3146f7-8edc-4193-a03f-360f64376596`, serves the shared Webhooks page.
Both actual Worker and workspace API headers agree. The first final-release page
load encountered two transient asset401 responses while API requests worked;
direct asset rechecks returned200 and the existing Reload Golf control recovered
the page without another sign-in. Seamless rollout is not claimed. The earlier backend release
`2f25a0a1196b…` qualified a signed test, automatic issue event and explicit UI
redelivery against an owned temporary signature-verifying receiver: three HTTP204
receipts, each on its first attempt. Replaying the original test operation did not
create a second attempt. The UI displayed history, preserved event identity on
redelivery and disabled the subscription. Operations recorded a successful cron
stage at06:31:21 UTC with zero backlog/failures. Evidence is retained privately in
`.tmp/webhook-live/hosted-evidence.json`.

The fixture issue is closed, its subscription disabled, and temporary receiver
Worker deletion/provider absence confirmed. Its local signing key was removed.
The encryption key is in the demo's owned Secrets Store and cleanup inventory.
The existing09:37:55 UTC demo stop timer remains active; no demo/preview lease was
extended and no container or AI execution was started.

This completes a bounded webhook adapter, **not full GitHub/settings parity**.
The inventory is71/297 shared RPCs adapted,226 missing. Native general workflows,
execution secrets/variables, environments, Git credentials/runners and enforced
rules/protected merge remain open. Native webhook Actions events cover test jobs;
receipt archival/pruning and encryption-key rewrapping remain future work. See
[CLOUDFLARE_NATIVE_SETUP.md](CLOUDFLARE_NATIVE_SETUP.md#repository-webhooks-on-the-native-path-schema15)
and [REPOSITORY_PARITY_PLAN.md](REPOSITORY_PARITY_PLAN.md).


## 2026-10-10 — Repository settings navigation

The reported “only General and Access” problem was capability filtering in the
repository sidebar, not Access sign-in. The shared desktop/mobile navigation now
retains all nine existing settings destinations, marks unavailable features and
opens their capability explanation without mounting unsupported editors. Direct
settings URLs wait for capability discovery; failed discovery keeps navigation
and provides explicit recovery. Native capability descriptions distinguish the
bounded test/preview consumers from missing workflow/environment/protection editors.

Validation: 13 distinct focused browser cases across local, Docker, Kubernetes
and native, 102 core tests, both UI builds, built native UI/Access checks and
make cloudflare-check passed. Two new responsive tests initially used hidden
controls incorrectly; corrected locators passed. No schema changes or new native
RPC adapters. **Full functional parity remains incomplete (66/297 adapters).**

Hosted release `f187dea82c56…`, Worker version
`cf6513e4-a0f1-4226-a67c-f002d3bd49de`, was deployed and independently read back.
The signed-in shared browser confirmed all nine entries on workers-sdk, working
General and Access pages, and selected unavailable routes retaining the repo tabs.
The initial rollout briefly served the previous workspace API alongside the new
frontend. At 06:02:34 UTC, both actual served Worker and workspace API release
headers matched `f187dea82c56…`, including the new per-feature explanation text.
This qualified API convergence, beyond the provider deployment readback.
Cloudflare documents [eventually consistent Worker/DO code updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).
The existing 09:37:55 UTC shutdown timer remains active; no preview lease or demo
window was extended, and no temporary testing credentials were created.



## 2026-10-10 — Native engagement and collaboration integrity

Source/local qualification: native reactions, subscriptions, in-app notifications,
mark-read receipts and transactional discussion activity are implemented. Discussion creation, plain-text/state/draft edits, new comments, overall reviews
and reported check writes now recheck identity, credential, repository authority
and relevant discussion revisions inside the effect/receipt transaction. Deleted
comment identities are never reused. List author reads are batched, and issue
comment counts share the page query; query counts stay constant across1/20 rows.

Schema14 adds engagement generations, activity/inbox tables, indexes and cleanup
triggers. The release helper now sends its validated SQL statements rather than
leading migration comments that the installed CLI parses as flags. Tests cover
CLI argument safety, interrupted migrations, data preservation and missing
trigger/index recovery. Native sign-in retains the Access path even when expired
authentication discovery fails. Unsupported attachments/templates do not mount
inside newly enabled engagement UI. Portable behavior remains on its own adapter.

Validation:109 native/core activity tests,16 release-helper tests,110 distinct
focused browser cases passed across issue/live behavior and sign-in (two browser
cases required rerun; the new test's invalid creation route was corrected). Both
UI builds, make cloudflare-check, built UI/Access admission and real local
workerd/D1 mutation/notification/revocation checks passed. No local test runtime
was left running. Existing >500kB entry chunk warning remains.

Native inventory:66/297 shared procedures have bounded adapters,231 remain missing.
Full parity and the production/global-scale completion gates are **not complete**;
see REPOSITORY_PARITY_PLAN.md. Hosted release `feb2122ac0f7…` / Cloudflare version
`0fb349b8-90b3-467f-b644-96d25569db49` was deployed at05:43 UTC, with actual served
schema14/digest verification and31 hosted API checks. Temporary label removed and
verification issue canonical#4 closed. Repeated imported-repository metadata reads
sampled129–219ms; this is not load/global qualification. The independent demo stop
timer is confirmed for09:37:55 UTC; no CI/agent work was started and existing
preview leases remain expired. Shared human Access session expired; human browser
acceptance of the updated release remains open.

## Native invitations and discussion administration (2026-10-10; source/local qualified)

Native now adapts all seven shared invitation procedures and five additional
repository resource procedures, raising inventory coverage from 51 to **63 bounded
adapters out of 297**. This is implementation coverage, not full GitHub/forge parity
or hosted qualification.

Invitations use verified enrolled Access identities, explicit expiring consent,
issuer/recipient identity generations and current administrator authority. Acceptance
atomically commits its direct grant and actor-bound original receipt. Account or
issuer-grant changes invalidate pending authority; expiry, decline and revocation
are supported. Historical replay never restores a removed grant. No emails are sent
and no new accounts or workspace memberships are created.

Native repository labels/milestones support inventory, create/edit/delete, unique
names, stale-write rejection, durable receipts and deletion tombstones. Issues and
PRs support label/assignee/milestone assignment and combined repository filters.
Resource changes advance linked discussion revisions and deletion clears links.
Assignee choices require active accounts with current repository access. Comment
edit/delete permits the author or current repository administrator and records the
exact outcome atomically. Replays cannot recreate deleted comments.

Shared UI controls serve portable and native installations. Native uses separate
capabilities for invitations, resources and comment editing; organization labels,
reactions and notification subscriptions remain unavailable. Resource changes wake
live issue/PR streams and refresh open inventories. List metadata uses three batch
queries with row/byte limits rather than per-discussion metadata reads.

Additive migrations0012/0013, fresh-install schema, release preflight/readback and
recovery tests target schema13. Existing grants/discussions are preserved and older
schema10–12 release manifests remain supported. Setup instructions and the complete
[execution ledger](REPOSITORY_PARITY_PLAN.md) are updated.

Validation: 118 focused browser cases (access/invitations, issue/PR metadata,
comments and live updates), 95 native core tests, seven activity tests and 15 release
helper tests pass. Both production frontend builds, `make cloudflare-check`, real
local workerd/D1 mutation/receipt/trigger checks and built UI/Access admission and
spoof-rejection checks pass. All temporary test runtimes exited. Vite still reports
an existing entry chunk above 500 kB; this increment does not qualify cold-load or
global-scale performance. Full portable server/Docker/Kubernetes journeys and hosted
schema13 migration/rollout were not run.

No hosted rollout or human Cloudflare acceptance was performed. No paid jobs,
external messages, live permission changes or demo extensions were made. Teams,
Git credentials/lifecycle, protected merges, full CI/CD, Golf Apps, security,
Projects and Discussions remain required work.



## Repository parity scope and native collaborator administration (2026-10-10; source/local qualified)

The user authorized the complete [repository parity execution plan](REPOSITORY_PARITY_PLAN.md),
including Golf Apps and the wider security/planning surfaces. Native collaborator
administration is the first completed local adapter: all six shared access RPCs,
read/write/admin grants for enrolled accounts, removals, version-fenced edits and
historical original receipts in one D1 transaction. Self changes and inactive
new grants are refused. Trigger-backed generations survive removal/re-add and
operator changes. Current repository authority still governs source, previews,
registry access and live streams. Native Access settings reuse the shared editor;
unimplemented invitation/team/deploy-key subpanels stay separately gated. A shared
organization/user ID collision in locked collaborator controls is corrected.

Validation: 86 browser cases, 87 focused core/activity tests, 13 release-helper tests,
`make cloudflare-check`, both frontend production builds, real workerd/D1
collaborator mutation/replay/revocation and built UI/Access checks pass. Existing
native method coverage is now 51 bounded adapters out of 297 shared procedures.
The additive 0011 access migration, release preflight and schema-aware predecessor
rehearsal are implemented. Existing grants and schema10 release manifests are
preserved. No production credentials, grants, services or demo deadline changed.

This increment is not deployed: hosted schema11 migration/rollout and human
administration acceptance remain open. Full settings, protected merge, invitation/
team administration, Git credentials, full CI/CD, Golf Apps, scanning/insights,
Projects and Discussions remain tracked requirements, not completed features.

## Persistent repository navigation across hosting profiles (2026-10-10)

Golf now uses one persistent application root and repository frame for its shared portable and Cloudflare frontend. Repository pages use a compact hamburger/Golf/owner/repository header; Code, Issues, Pull requests, Actions and Settings retain the same tab navigation. Settings replaces only its panel inside a persistent, capability-aware grouped sidebar, with an accessible section picker on phones. Capability diagnostics open on request. General and Access settings no longer repeat the repository heading or a redundant return button. No dependency or authorization-cache lifetime was added.

Router pending updates retain stable location values so commit-history canonicalization cannot restart indefinitely. Route validation, legacy URL normalization, sign-out, revoked access and original-identity deletion remain enforced. Ref pagination returns focus inside its disclosure before disabling/removing the load button, avoiding a disappearing branch picker. Responsive checks cover 320px and desktop, dark/light, keyboard dismissal and persistent DOM identity across local, Docker, Kubernetes and Cloudflare-native profiles.

Validation: all 539 selected browser scenarios passed across the main run and corrective reruns; both production builds and `make cloudflare-check` passed. The native asset/Access/D1 check also passed in real local workerd after bringing its module fixture up to date with the current worker imports. All 137 follow-up integration checks and a fresh eight-case runtime-profile pass succeeded. Release `3f86b2acb03b5c0f7cf963bbeff6e32095b8d9e062131d5ea21f4ee010c430c7`, Worker `7bfe0da6-8570-4ef3-a4e0-4f73c5dc0cd0`, schema10, is served by both ingress and Durable Objects. Hosted Vite Code → Issues → Settings → Code retained the same document, header and tabs; the hamburger returned to the workspace without a document reload. The 320px hosted layout has no horizontal page overflow. Three served JS/CSS asset digests match the reviewed release. One lazy chunk returned a transient401 during rollout; fresh asset reads and reload succeeded. Operations reports zero queued/running jobs. The original04:58:57UTC shutdown timer remains active. See the [navigation verification receipt](../.tmp/repository-shell-qualification/hosted.json). Portable sources/builds are updated; existing Docker/Kubernetes installations have not been redeployed. This is navigation/layout parity, not completion of previously documented native backend feature gaps.

## Native speed and interaction profiling (2026-10-10; bounded five-repository qualification)

The [speed qualification record](CLOUDFLARE_SPEED_QUALIFICATION.md) documents the complete browser/DO/D1/R2 cache path, CPU profiling, timings, failures and remaining work. Release `0d521b4763766fa80db9973294bdff2ec184c96d6d892e8721437590d8a215b6`, Worker version `e16c6e17-c81f-44cb-a3c5-017ecd9a9d09`, schema10, is served by both ingress and repository/workspace objects. Background metadata indexing no longer blocks foreground reads; stale index generations are fenced. Independent provider/diff work overlaps, completed bounded diffs reuse immutable indexes, and anonymous allowlisted README images use bounded upstream caching. Shared UI source/README/sidebar refreshes retain authorized content and clear it on denial; unchanged source rendering is memoized.

The final five-repository, concurrency-four run retained108 requests:102 passed exact identity checks and six Kubernetes/Rancher HEAD diffs returned the existing comparison-limit429. File/folder median/p95 was183/274ms; repository metadata198/685ms; overview195/421ms; history176/197ms. Every request reported zero coordination-queue time, although this final run did not force a fresh background index batch. Warm cached root/file DOM readiness measured96/72ms with no observed long task in the small browser sample. Shared-browser rendering suspension prevents treating its frame timestamps as end-user paint/INP. These are one-region, one-workspace results, not global SLOs. Operations exposes retained latency/stage/cache/error observations and reported zero queued/running jobs; its30-minute window includes older releases and test failures.

Vite, Kubernetes, Moby, Rancher and Workers SDK are imported as explicitly described default-branch snapshots with ten commits, canonical Git stored in Artifacts. License/language overviews are available, including25,883 indexed Kubernetes files. These are not full-history migrations; older path history and oversized diffs remain open. Hosted warm-cache revocation denied all four concurrent requests after removing the dedicated test principal's grant. Full `make cloudflare-check` passed152 native/14 frontend tests and bridge/agent checks; both frontend builds, real workerd authority/resource checks and47 operator tests passed. Four initially failing malformed-address browser cases were fixed and the affected route/source/sidebar cases passed focused reruns.

The owned demo remains scheduled to stop at04:58:57UTC. Its original supervisor was found absent; recovery now retires only original owned Worker previews through the native revoke API before removing their provider cleaner. It verifies the original service-token identity, uses a five-minute native cleanup credential, refuses redirects and revokes the credential in `finally`;18 supervisor/recovery tests pass. Actual deadline retirement is still pending. No CI/AI jobs were started for these speed checks. Complete native collaboration parity, paged large diffs, cold/large-file paint, multi-principal/multi-region load and global-scale acceptance remain open.

The temporary IP-bound testing policy/token was retired after qualification. Independent provider/D1 readback confirms the service token absent, original human Access policies preserved, test credential revoked and test user inactive; the local secret was removed and its separate timer stopped. The demo's original stop timer remains active. Shared-account Access login branding was not changed because it affects other applications; the qualification record documents the dedicated Golf organization option.

## Replacement navigation demo (2026-10-10; bounded hosted navigation and live acceptance passed)

Replacement `golf-native-20261010-014e4e98` is ready at https://gitgolf.mjtechguy.com, with canonical and review-playground repositories, completed bounded tests/agents and the original protected static/Worker preview kinds. Its current four-hour stop deadline is2026-10-10T04:58:57.889Z. The exact navigation release `4c3dfaf5d332e180b2950f7815b382ec328bcf55ef940e677888ded2209a2911`, schema10, passes actual served-version, retained-asset, machine-admin-denial, rollback-to-development-predecessor and re-promotion checks. Both owned test and agent applications independently report zero active/starting instances. The independent stop timer is active and its real service properties confirm bounded failure retries; all46 Cloudflare operator-script tests pass.

The user confirmed Golf loads in a regular browser, and the shared browser subsequently loaded and authenticated successfully. Hosted checks against the small `alice/canonical` fixture measured 80ms for an intent-prefetched file, 71ms for a cached directory return and 68ms for a cached file revisit. These navigations preserved the page document, reused source payloads and performed a fresh repository-access check before displaying cached content. A real repository-description mutation appeared automatically in the About sidebar in 508ms while the document and pinned source commit remained unchanged; the description was restored using the returned revision. Browser diagnostics independently confirmed the exact current release and schema10. These are single-browser observations, not latency percentiles or global performance guarantees: the initial repository metadata request still took1413ms.

The [replacement qualification receipt](../.tmp/cloudflare-forge/golf-native-20261010-014e4e98/navigation-qualification.json) binds current source/release identities, hosted observations, execution counters and timer properties. Both test/agent apps remain idle and the04:58:57UTC stop timer remains active. This closes the bounded hosted navigation/live-mutation acceptance only; large-repository/global load, complete native parity and hosted collector invocation remain open.

## Expired navigation demo retirement (2026-10-10; owned resources retired, replacement preparing)

The agreed four-hour navigation demo expired at2026-10-10T00:16:13.719Z. The independent host timer fired at00:16:43, but its recovery command failed during D1 inspection. A retry confirmed the managed app had not been purged; cleanup correctly refused to remove its cleaner or control authority first. The operator retried the two owned preview revocations through the native API, confirmed both purged, and revoked the temporary native credential. The original owned Access service token was rotated for cleanup; the complete recovery also retires that token and its other owned resources. The expired allocation was not extended. Final hosted navigation/live measurements remain pending the replacement window.

The provider refused outbound Worker deletion while the control Worker still held its service binding (error10142). Recovery now removes preview ingress, retires/deletes the control Worker, then deletes the outbound Worker. Two regression tests verify dependency order and preserving outbound authority if control deletion fails; all demo-supervisor tests pass. Independent stop services now retry failed recovery up to three starts, thirty seconds apart, with one-second timer accuracy. This covers recovery-command failures; host loss, expired authority and a live supervisor whose own cleanup fails still require operator reconciliation. The corrected recovery confirms every journaled owned resource absent and the short-lived recovery token independently absent. The ownership receipt reports stopped. A replacement with the original bounded four-hour policy is preparing for the requested retry.

The private [preview retirement receipt](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/preview-retirement-retry.json) and [recovery journal](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/cleanup-recovery.json) retain effects and current deletion states. Do not infer full retirement until the journal and ownership receipt report completed absence and the cleanup token is independently absent.

Replacement attempts retain failures rather than reusing an uncertain allocation. Attempt `golf-native-20261010-7d3bc310` failed preview deployment with Cloudflare10007 and retired every recorded resource/credential. Attempt `golf-native-20261010-55e2eaab` failed the initial session read during fresh-hostname DNS propagation and also retired every recorded resource/credential. The side-effect-free current-actor readiness gate now runs before dependent preview deployment and retries DNS/timeout/routing failures with existing finite bounds; unexpected actor identity fails immediately. Focused readiness tests and all Cloudflare operator-script tests pass. The independent retry mechanism was exercised against real user-systemd with two deliberate failures and a successful third start; the proof unit completed without provider allocations.

## Native navigation cache and resumable live updates (2026-10-09; bounded hosted browser acceptance passed on replacement)

The shared UI now bootstraps default-branch source from the authorized repository metadata read, deduplicates source/navigator/README payloads, and prefetches at most two small files/directories on hover or keyboard focus. Cold native source entry avoids separate ref-resolution/access RPCs; the native content read still checks authority before and after provider waits. Retained private bytes require fresh repository access before display. Source snapshots remain pinned. Repository listing uses bounded concurrent provider reads rather than a serial request waterfall.

The native `WatchRepository` adapter implements the existing Connect JSON/protobuf stream with durable scoped replay, compaction reset, current authorization per frame, connection limits, backpressure, cancellation and bounded rotation. Golf ingress and metadata/job workers publish topic invalidations; direct privileged Artifacts-management writes remain outside that journal. Hidden tabs pause streams and polling; visible live tabs avoid redundant periodic native repository refreshes. The [setup guide](CLOUDFLARE_NATIVE_SETUP.md) documents exact bounds and the [robustness plan](CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md) retains broader load acceptance.

The guarded release `4c3dfaf5d332e180b2950f7815b382ec328bcf55ef940e677888ded2209a2911` deployed as Worker version `8618516c-0feb-4827-9c12-7980548fb327`, schema10, with 113 current/predecessor assets retained. Final `make cloudflare-check` passes 142 native tests and 14 frontend unit tests, alongside the maintained bridge/agent checks. Both frontend builds, generated-contract consistency, Go server/generated packages, 84 focused browser cases and actual workerd/D1/DO JSON/protobuf mutation/revocation checks pass. The runtime check also proves ten-second server rotation works with an older fourteen-second client deadline.

The [private qualification receipt](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/navigation-qualification.json) retains source identities and validation. The earlier release served and reported Live in the human browser; Access expired before the final-release navigation/live-mutation measurements. Those hosted acceptance steps remain pending, rather than inferred from local tests. The original demo stop deadline remains2026-10-10T00:16:13.719Z; its independent host timer is active. Both owned test/agent applications have zero active/starting instances. No CI or AI execution was started for navigation qualification. Current shared coverage is 46 bounded RPC adapters and 251 missing adapters; large-repository/global load and hosted collector invocation remain open.

## Hosted Operations rehearsal and retirement hardening (2026-10-09; bounded hosted release and human dashboard qualified, demo replacement pending)

The owned human-demo launcher now supports `--operations-rehearsal`: schema10 preflight, reviewed immutable asset retention/readback, exact served release checks, machine-admin denial, rollback to the recorded predecessor and re-promotion of the same reviewed version. Rollback/promotion intent is journaled before provider effects; lost acknowledgements fence automatic replay. R2 read-only retrieval retries explicit transient HTTP statuses/timeouts with finite bounds and private diagnostics. The browser benchmark includes representative file reads and retains transport failures as observations with a ten-second request deadline, without recording response bodies or private errors.

The launcher requires independent user-systemd stop-timer readback before awaiting-login/readiness, preserving the installed CLI/Node path. Login preparation is thirty minutes; the agreed four-hour window begins after original preview lease renewal. Renewal preserves IDs/source/bundles and rechecks writer permission, canonical PR source and current policy, with an atomic original-expiry fence and four-hour/global-deadline cap. Activation failure preserves the prepared UI for a bounded repair window. This remains dependent on the operator host and credential availability. It does not implement Cloudflare-owned whole-allocation self-retirement.

Recovery journals each provider deletion and confirms absence, resumes already-removed resources, validates retained release assets and repository indexes, and preserves D1 when bucket cleanup fails. Ownership/release/recovery receipts use one private atomic replacement helper so interrupted publication preserves the prior receipt. A missing database requires the previously saved storage inventory. Static-preview storage is distinct from managed Worker apps, whose resource journals must already be fully purged. Wrapped CLI404 responses are accepted as absence; other failures remain failures. Recovery credentials are scoped, short-lived, recorded by ID and explicitly revoked with readback. Unknown app effects and changed identities still refuse automated retirement.

The [first attempt](../.tmp/cloudflare-forge/golf-native-20261009-c9df5872/ownership.json) failed an outdated PR/discussion fixture before the rehearsal. Its retained index objects were individually reviewed and removed after all writers retired. The [second attempt](../.tmp/cloudflare-forge/golf-native-20261009-bbb82c17/ownership.json) passed real Git/collaboration, canonical container tests, protected static/Worker delivery, isolated D1/R2/Secrets Store, two agents and grant/revocation checks, then failed an R2 asset read before release publication. Subsequent read-only probes did not reproduce that failure. Its bucket and database were preserved until ownership-reviewed recovery; [recovery](../.tmp/cloudflare-forge/golf-native-20261009-bbb82c17/cleanup-recovery.json) then confirmed all owned resources absent and successfully resumed after completed deletion. These remain failed qualification attempts. Their Access applications were removed; an OTP for either application cannot validate the replacement.

The [third attempt](../.tmp/cloudflare-forge/golf-native-20261009-a87d15de/ownership.json) passed schema10 deployment, all111 retained asset hash/length checks, machine-admin denial, exact served rollback and re-promotion. Human Access login and the actual Operations API passed: two repositories, two active previews, genuine zero queued/running jobs, loaded Archivo fonts and no1280px page overflow. The [human API observation](../.tmp/cloudflare-forge/golf-native-20261009-a87d15de/operations-human-proof.json) took596ms. Provider/maintenance observations had not arrived. Its subsequent revoke/recreate activation failed with a native503 whose exact cause was not captured. The launcher removed all owned resources; the recorded host timer was stopped after confirmed cleanup. This remains a failed demo attempt, with its narrower release/human proof retained.

Native Operations now batches inventory aggregates into one D1 call and reports timestamped historical successful service activity separately from current health probes. Four preview-renewal tests cover original identity/no allocation, stale replay, current authority and deadline caps. Focused operator checks pass with13 setup tests,15 demo/recovery tests and12 release tests, plus2 forge initializer tests ([log](../.tmp/cloudflare-operator-tests-final.log)). The complete `make cloudflare-check` target passes with134 native Node and13 frontend boundary/metrics tests plus maintained Go/bridge/agent checks ([log](../.tmp/cloudflare-check-operations-rehearsal-final.log)). Real local workerd/D1/DO/Queues/Workflows/R2 checks pass and dispose their runtime ([log](../.tmp/cloudflare-runtime-lease-final.log)).

The [fourth replacement](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/ownership.json) reached `awaiting_login` at20:13UTC after real CI, protected previews/app storage, two successful isolated agents, all111 assets, exact served rollback/re-promotion, machine-admin denial and original static/Worker preview lease renewal passed. All44 maintained source hashes match. Both execution applications independently report zero active/starting instances ([observation](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-container-proof.json)). Actual human login and activation now pass: the original preview IDs remain READY, the supervisor and independent timer are armed, and the four-hour window stops at00:16:13UTC on2026-10-10. [Human API proof](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-human-proof.json) shows nine historical service-activity observations, two active previews and genuine zero running/queued work. [Layout](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-layout-proof.json) verifies Archivo and no page overflow at1280px in light/dark and390px in dark.

Six [warm Operations reads](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-latency.json) return200 in266–308ms; the initial read took956ms. These are separate observations from the earlier596ms call, not controlled before/after speed acceptance. The [initial repository benchmark](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/repository-benchmark-initial.json) retains six not-yet-indexed overview observations out of24 requests despite HTTP200. After metadata completion, all18 [settled overview/root/file reads](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/repository-benchmark-settled.json) return200 with exact source/available metadata; warm p50 is244ms and p95/p99 are326ms. This is two small fixture repositories, one enrolled user/workspace and one browser region, not large-repository, cold-cache, multi-tenant or global acceptance.

An independent five-minute Analytics Read inspection confirms the installed cron schedule and real fixed-Worker GraphQL traffic response ([proof](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-provider-inspection.json)); its token was revoked and independently confirmed absent. Actual local scheduled dispatch records all four maintenance stages and a successful R2 probe, then disposes its runtime ([log](../.tmp/cloudflare-runtime-scheduled-final.log)). Hosted maintenance/provider journals remain empty through20:26UTC. The fixed-Worker scheduled-event GraphQL query also returns no invocations ([inspection](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-cron-inspection.json)); the separate inspection token was revoked with independent absence confirmation. Sampled log queries returned no scheduled/error events, which does not prove their absence. The exact hosted dispatch cause remains unknown, so these services remain unknown/configured and hosted collector acceptance stays open. [Cloudflare's cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) distinguishes trigger propagation and delayed past-event visibility; neither delay is used as proof that this installation's collector succeeded. [Validation](../.tmp/cloudflare-forge/golf-native-20261009-b39170f1/operations-validation.json) records operator helper hashes and the narrower proof. Full native parity, hosted collector invocation, multi-workspace/global load, staging/canary, quarantined restore and Cloudflare-owned allocation retirement remain open.

## Integrated Operations dashboard and reliability increment (2026-10-09; source and local runtime qualified)

The [detailed robustness execution plan](CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md) records work packages and the baseline method-by-method native parity queue. The [integrated Operations dashboard](OPERATIONS.md) is implemented at `/admin/operations` using Golf's shared frontend and generated Connect RPC across local, Docker, Kubernetes, Cloudflare bridge and native profiles. Cloudflare requires no Grafana, Prometheus or collector deployment. Services distinguish configured bindings from successful timestamped observations; missing metrics remain unknown and genuine zero values remain zero.

Portable observations reuse the process registry and bounded PostgreSQL/forge readiness checks, with approximate histogram latency and trace export failure counts. Current password-session instance administrators are checked before and after collection; provider/PAT/delegated credentials do not gain administration. Native observations use primary-session aggregate inventories, explicit current Access identity and the additive `operations_admins` role. Fresh bootstrap enrolls only the configured owner. Existing installations need reviewed migration0010 and deliberate enrollment; repository-creator grants never promote users. Current-role/email revocation during reads withholds the snapshot.

Native cron now records independent CI, preview, evidence and index maintenance attempts/outcomes/last success. Failure counts remain unknown when a stage fails; other stages continue. Evidence retries preserve original job/workflow identity. An optional separate, operator-owned dead-letter queue persists known original-job delivery failures idempotently before acknowledging; it never dispatches a replacement. Records expire after seven days in bounded batches. Retry/retention limits and a prolonged D1 outage can prevent inbox persistence, so the original job journal remains recovery authority. Started jobs are governed by execution expiry/current authorization rather than their earlier queue publication-attempt count.

Optional background Workers Analytics collection is scoped to the installed account/control Worker, uses an independent Secrets Store Analytics Read reference, is atomically throttled and retains last successful values across failure. Optional Artifacts info/R2 HEAD probes perform no writes. Managed request logs are sampled, omit private identifiers/bodies/URLs, disable automatic invocation logs and leave traces disabled pending separate privacy qualification. Provider storage totals, billing and broader service usage are explicit unavailable/unknown coverage. No real Analytics credential/provider eligibility is qualified by this source increment.

Repository reads now retain bounded immutable blob-size metadata even when an oversized source body is not cached. Warm directory metadata can reuse the known size without downloading that body again. Account/namespace/repository scope, bounded eviction and current authorization remain enforced. The dashboard read itself can use the existing concurrent read path. These source changes do not replace a hosted cold/warm performance measurement.

Validation passes: `go test ./...`; Operations authority/revocation tests with a temporary real PostgreSQL17 instance under the race detector; telemetry race tests; `make cloudflare-check` (including128 native tests,13 frontend boundary/metrics tests,13 native setup tests and7 release tests); both frontend builds/typecheck; generated contract consistency; and native CLI build-output validation for optional collectors/logs/failure-queue bindings. Real local workerd checks pass Access mapping/spoof rejection/admin admission/revocation, matching built asset bytes, D1/DO/Queues/Workflows boundaries, dead-letter persistence, conditional R2 writes and disabled-user denial. The existing Codex credential permission fixture now sets its intended public mode explicitly, so restrictive caller umasks do not invalidate that refusal test. Evidence logs: [Go](../.tmp/operations-go-final.log), [Cloudflare](../.tmp/operations-cloudflare-final.log), [UI runtime](../.tmp/operations-ui-runtime-final.log), [native runtime](../.tmp/operations-local-runtime-final.log).

No new hosted resources were provisioned and the temporary PostgreSQL/local Workers processes were removed. The shared test browser could not reach the environment's local port, so visual authenticated dashboard acceptance remains open. Matching hosted schema10 rollout/readback, live collectors, Docker/Kubernetes served acceptance, full allocation self-retirement, interrupted-deletion recovery, global load qualification, organization/fleet drilldown, alerts and full native forge parity remain open. Current generated native coverage is297 procedures,45 bounded adapters and252 missing adapters. Neither this dashboard nor the written plan establishes production readiness or completes the broader roadmap.

## Shared native frontend (2026-10-09; bounded hosted human qualification)

The Cloudflare-native build now imports the same `main.tsx`, application, router, components, styles and fonts as the portable frontend; the parallel compact native forge UI was removed. Native allocation, test/agent evidence, proposal comparison and protected preview controls remain inside the shared account/repository/PR screens. The native API adds actual Artifacts commit metadata/history, readable source selection, commit/PR/comparison diffs and best-common-ancestor traversal, with explicit bounds and refusal of unsupported multiple merge bases/cross-repository comparisons. D1 migration0005 persists the enrolled private workspace, current-authority repository stars and revision-fenced own profiles. Create/update PR receipts now match the shared composer contract and canonical links use `/pull/NUMBER`.

The current disposable control Worker is version `2073a9cd-7a7b-4253-a3ca-5b9176422805`. Its existing workspace required approximately five minutes after upload before serving the new comparison/stream-refusal contracts; an upload acknowledgement alone was not acceptance. Actual human Access qualification covers repository root/file browsing, PR conversation/commits/files, real six-file diffs, same-repository comparison, own profile/workspace reads and star/unstar. Shared PR diff layout fits390px without page overflow, and Archivo/Geist Mono bytes load in both themes. A fresh protected Worker entry/grant, D1 note write/read and private signed R2 receipt read also pass using the existing human Access browser session. Credentials were not extracted. [Shared UI validation](../.tmp/cloudflare-native-shared-ui-validation.json) records source/build/runtime/hosted evidence; [human evidence](../.tmp/cloudflare-forge/golf-native-20261009-3322fac6/human-ui-proof.json) and [demo receipt](../.tmp/cloudflare-forge/golf-native-20261009-3322fac6/ownership.json) retain their separate provenance.

Both frontend builds and83 native Node tests pass; real local workerd checks pass Access identity mapping, spoof rejection and disabled-user denial. The full Cloudflare check and actual D1/DO/Queues/Workflows/R2 qualification also pass at the recorded source boundaries. No new CI/agent job or paid inference was started for shared UI qualification. Disposable execution containers remain destroyed; the intentionally retained demo auto-stops at07:37:40UTC on2026-10-09 under its original supervisor.

This completes shared visual/application reuse and a bounded collaboration adapter slice, not full native capability parity. Source editing, streaming activity, inline/pending review, review requests, labels/assignees/milestones, releases/packages/wiki, general Actions, admin/team/account/email capabilities, protected canonical merge, recovery and global tenant scale remain open. Native unavailable errors/disabled controls must stay explicit. The portable installation and schema091 were not deployed or migrated by this increment. Golf Apps, Email Service, optional PlanetScale/Hyperdrive, Access branding and paid repository access remain discussion follow-ups.

## Product status against the plan (2026-10-08)

Golf is a usable local development installation. Neither infrastructure track has passed its complete release gate. The verified feature slices below do not make an entire phase or all ten repository Settings sections complete. Source ahead of localhost is identified separately; a successful source test is not deployment evidence.

| Plan phase | Current state | Working evidence and remaining work |
| --- | --- | --- |
| 0 — Baseline/proofs | Partial | Build/contracts/native Git and bounded engine/harness proofs exist. P0.8 protected integration, all five harness paths and complete Cloudflare execution proofs remain open. |
| 1 — Portable foundation | Partial; local core deployed | Local email/password sessions, encrypted credentials, roles/admin/account settings, shared UI, PostgreSQL and RustFS work in the retained Compose installation. Complete identity/MFA/role matrix, every Settings consumer, fresh Kubernetes acceptance and latest-schema coordinated recovery remain required. |
| 2 — Forge/connections | Partial; bounded 087–091 consumers deployed | Deployed 086 retains the earlier collaboration/forge slices and adds own native pending review create/edit/submit/discard, exact saved inline transfer and pending/published inline edit/delete. Deployed 086 adds personal selected-provider imports, bounded personal-owner generic package publication/mediated downloads, ordinary wiki unit writers/navigation and later mirror completion observations. Deployed 089 adds exact saved-inline pending append, bounded batch/rename and verified discussion body/comment uploads/downloads. Pending rebase, ranged/application suggestions, native CAS, wider registries/roles, projects and private migration fidelity remain open. |
| 3 — Protection/recovery | Incomplete release gate; 083 source safeguards qualified | Foreign RESERVED/DISPATCH_UNKNOWN rule updates now fence later Golf-managed writes, including other own permits. Restored Golf factors/provider connections/agent credentials and leases are quarantined. Exact Golf-only host dump/fresh restore is tested; protected publication, every native ingress, effective approval/check authority, merge queues, wider Git/LFS maintenance and coordinated current-schema whole-stack recovery remain open. |
| 4 — CI/runners | Partial; supported local catalogs deployed | Manual/configured push, isolated Docker runs, maintained multi-job dependencies, job/step drilldown, live terminal logs, scoped secrets/variables and bounded private artifacts are exercised. Source-ahead opt-in Requests push now qualifies genuine checkout, scoped job tokens, pinned public Node24 actions and controlled dependency egress. PR/fork, broader Actions/GitLab semantics/cache and scale remain open. |
| 5 — Agents | Partial; managed088 source and controls deployed | Earlier Codex execution/OpenCode PR-review and managed connection/grant/conversation surfaces retain their evidence. Deployed 085 adds sponsor/PR-author persona mentions with current comment revalidation and running OpenCode completed-message progress. Managed private reply/cancel/live-process resume/finish and permission controls are deployed; native 1.18.34 task-image initialization/resolved policy is observed at worker startup. File-tool grants remain withheld. Actual inference/tool use, all-five harnesses and the disabled first-party agent Actions catalog need independent runtime qualification; lost workspaces are never resumed. |
| 6 — Cloudflare services | Bounded foundation/agent/storage proofs qualified; product source ahead | Worker/R2/Artifacts and operator-private concurrent-agent/Clef/conflict/candidate-test proofs pass. Migration093 adds encrypted product Cloudflare profiles and an operator D1/R2 storage consumer with real provider and controlled-native browser acceptance/cleanup. Migration094 qualifies a bounded operator preview through actual Access email-code admission, immutable content/D1/R2 reads and repository revocation. Golf agent task integration, native tenancy, complete app provisioning, automatic protected PR previews, fleet cost and the showcase remain required. |
| 7 — Previews/CD/DNS | Partial source work; complete delivery loop open | Environment/artifact policy and a static-preview candidate exist. The preview runtime qualification stops before stack creation at its unchanged Docker capacity reserve. Source094 has an actual temporary Cloudflare custom-domain/Access/Worker/D1/R2 browser and revocation proof. Automatic PR links/lifecycle, production rollout/rollback and general Cloudflare adoption/bindings remain open. |
| 8 — v1 release/hardening | Incomplete | Earlier bounded backup/restore and refusal checks exist. Full latest-schema restore/upgrade, performance/soak, migration fidelity, cross-track acceptance and signed/offline distribution must close before production readiness. |
| 9 — Wider enterprise | Planned expansion | HA/regional cells, wider enterprise governance, managed hosting, additional OS runners and advanced product surfaces have their own acceptance gates. Current admin/settings screens are not proof of those capabilities. |

Current localhost runs clean frozen source `f5485677108270ccf8480556ba3ee8fbcebe905d` at schema`202610050091`, core/web `sha256:4a51995fb1a11c4f4f94a89086547fa74cae3beead9beb458915effe97d4d99c` and dedicated agent worker `sha256:3749752e851fa60adc23b246e3704f5cf23da1cdefc46871800045af000c9072`. The [aggregate](../.tmp/priority091-final/manifest.json), [deployment](../.tmp/portable-completion091-runtime-attempt1/receipt.json), [post-served independent verification](../.tmp/portable-completion091-post-served-verification/manifest.json) and [actual served checks](../.tmp/portable-completion091-served-attempt1/manifest.json) pass. Maintained engine and runner remain unchanged; the new agent Actions catalog remains disabled. Direct-TLS managed READ Git remains at `https://127.0.0.1:8443`; native web/API/SSH remain independent ingress. No managed WRITE/bootstrap or complete protected-ingress qualification is claimed.

The current evidence below supersedes historical runtime identities. Older entries retain their original source, runtime and scope; their then-current wording does not describe today's deployment. See [the local sequence](LOCAL_COMPLETION_NEXT.md) and [full Settings requirements](REPOSITORY_SETTINGS_IMPLEMENTATION.md).

## Managed Worker apps (2026-10-09; bounded hosted API qualified)

Workers for Platforms is now enabled in the selected account. The [hosted managed-app receipt](../.tmp/cloudflare-forge/golf-native-20261009-f8536cfa/ownership.json) passes actual exact-source automatic application publication, private dispatch through the Access-gated preview gateway, isolated D1 notes and R2 receipts, hosted Secrets Store HMAC verification, denied Internet fetches, single-use grant replay denial and current repository-reader revocation. All21 owned cleanup categories are absent. The operator-only wrapper uses a synthetic reviewer with real machine Access; it does not establish human login or browser-cookie acceptance. Product gateway builds have no proof route.

Provider acceptance exposed and corrected three API assumptions: a missing dispatch script can return HTTP200 with `script:null`, custom-domain IDs can be40 hexadecimal characters, and successful DELETE responses can have an empty body. Resource identity and independent absence checks remain required. `make cloudflare-check` passes with72 native Node tests and the new demo-supervisor process-identity test ([log](../.tmp/cloudflare-app-post-upgrade-check.log)). Earlier failed attempts retain their receipts and owned-resource reconciliation rather than being relabeled as successful qualification.

The populated-demo supervisor and private begin/stop commands are implemented. Its first setup attempt passed real CI, Clef, application storage/dispatch and two concurrent agents, then failed while rebuilding the control UI because deployment had removed its local image tag. All24 owned cleanup categories are absent in that [failed receipt](../.tmp/cloudflare-forge/golf-native-20261009-39620e60/ownership.json). Preparation now restores the tag from the approved immutable image ID, builds the native UI, disables workers.dev on the human deployment and replaces the synthetic proof gateway with the product gateway. The second attempt reached human Access but failed the origin cutover: the outer Worker accepted the new hostname while its active workspace Durable Object still enforced the former origin. Its [exact app-resource reconciliation](../.tmp/cloudflare-forge/golf-native-20261009-53a3c47d/app-cleanup-reconciliation.json) confirms removal of the app scripts, database, bucket, domain and dispatch namespace; the remaining owned resources were removed by its original supervisor. A new setup uses the final hostname/audience from first deployment, verifies the owned control domain separately and passes machine Access credentials through Git and the native Golf CLI. The CLI pairing/header/redirect boundary passes under the race detector ([log](../.tmp/cloudflare-native-access-cli-final.log)); two demo-supervisor identity/private-receipt checks pass. A subsequent early stop exposed the qualification wrapper’s workers.dev-only setup guard; custom-host proof now requires its explicit approved preview origin. That [failed setup receipt](../.tmp/cloudflare-forge/golf-native-20261009-79322550/ownership.json) confirms teardown of its recorded resources. Its unstarted Workflow definition was separately [removed and verified absent](../.tmp/cloudflare-forge/golf-native-20261009-79322550/workflow-cleanup-reconciliation.json); the launcher now journals a Workflow attempt before deployment and cleans it up even if later readback was never reached. The next [setup receipt](../.tmp/cloudflare-forge/golf-native-20261009-59f16a80/ownership.json) passed canonical-host session/Git/CLI/CI/static checks but left app publication fenced after cleanup-script acknowledgement; all25 owned cleanup categories are absent. Static and app publication now run in separate Workflow steps after immutable report storage, with original-key replay, fresh invocation bounds and safe outcome diagnostics. All73 native Node tests pass ([log](../.tmp/cloudflare-delivery-phases-source.log)); the full Cloudflare checks ([log](../.tmp/cloudflare-delivery-phases-check-final.log)) and actual local workerd/D1/DO/Queues/Workflows/R2 checks ([log](../.tmp/cloudflare-delivery-phases-runtime.log)) pass. The current [populated demo receipt](../.tmp/cloudflare-forge/golf-native-20261009-3322fac6/ownership.json) reached `awaiting_login`: two private Artifacts repositories/PRs, actual canonical-host Git and CLI writes, passing CI, Clef, two overlapping independent agent proposals, automatic static/Worker publication, private app D1/R2, hosted Secrets Store signatures, denied egress and grant/revocation checks all pass. The product preview gateway replaced the operator-only wrapper. The owner’s macOS direct `nslookup` resolved the record while the system resolver used by curl/Chromium failed. Flushing the macOS system DNS caches restored HTTPS and browser login. [Human UI evidence](../.tmp/cloudflare-forge/golf-native-20261009-3322fac6/human-ui-proof.json) confirms Access login as `mike`, both private repositories, current settings/capabilities and the canonical PR’s real CI/agent runs. The supervisor is now `ready`: the approved window started at03:37:40UTC and stops at07:37:40UTC on2026-10-09. Fresh static/Worker previews are READY; static expiry remains04:37UTC. The native shell now reuses the local brand/layout styles and shared theme toggle; Archivo/Geist Mono font bytes, both themes and390px layout were verified. Native and portable frontend builds, public-boundary tests and real local Access/workerd/D1 UI checks pass. A human Worker-preview form exchange first returned404: the control UI’s `no-referrer` policy suppresses cross-origin navigation POST Origin, conflicting with the exact-origin grant check. The deployed control header now uses `strict-origin` without disclosing paths/queries or relaxing authority. The shared browser disconnected during that retry. Subsequent fresh entry/grant and actual human Worker-preview D1/R2 write/read now pass, as recorded in the shared frontend increment above. Current demo resources are intentionally retained for the approved window, with no qualification execution tasks left running. Full native forge parity, protected canonical merge, arbitrary builds/bindings, recovery and global SaaS scale remain open. The $10/day envelope is planning/admission policy, not a provider billing cap.

## Runtime settings, automatic CI and managed Worker apps (2026-10-09; source/local qualification)

The API now reports an explicit deployment runtime and settings capabilities. Local/direct launches can select `local`; Compose selects `docker`, Helm selects `kubernetes`, and the isolated Cloudflare bridge selects `cloudflare-bridge`. Native Workers report `cloudflare-native`. The portable frontend uses the same capability contract for menus, inventory actions, direct settings routes and optional Cloudflare resource controls. Missing, unknown, disabled or failed metadata withholds the affected editor; user/admin/repository authorization remains independently enforced. The native frontend has a read-only Settings and capabilities page for Access identity, approved CI/agent policy, storage/app allocations and expiry. It does not expose portable PostgreSQL, Docker pool, password/MFA/SSH or SMTP editors. Kubernetes hosting does not establish a Kubernetes execution adapter. Retained localhost still runs frozen schema091/source above; these UI/API changes require a coordinated deployment and have not updated it.

The native source adds durable automatic test intake after confirmed eligible PR head/base branch pushes, rechecking current writer authority and exact canonical Artifacts source. Passing tests can admit an approved prebundled Worker module and SQL schema. Each managed app receives a separate private D1 database, R2 bucket, Workers for Platforms script, cleanup script and child preview hostname. Access remains the outer gate and Golf rechecks current repository readers, PR revision, expiry and single-use reviewer grants. Same-origin bounded app POSTs carry no control/reviewer credentials into application code. An outbound Worker denies Internet fetches; the provisioner uses a separate Secrets Store reference, with an optional distinct app signing secret. Journaled provider identities, uncertain-write fencing, current-policy checks and owned cleanup are required before readiness and retirement. Configured app hosting reports degraded while human acceptance and complete recovery remain open; a binding alone is not successful provider execution. See [native setup and limits](CLOUDFLARE_NATIVE_SETUP.md#managed-worker-applications-bounded-hosted-api-qualified).

`make cloudflare-check` passes with71 native Node tests,11 initializer/migration tests,2 runtime-manifest tests and the existing bridge/preview/agent/Go CLI checks ([log](../.tmp/cloudflare-managed-app-check-final.log)). Subsequent targeted native tests also pass ([log](../.tmp/cloudflare-managed-app-core-final.log)); the actual bridge Compose render confirms its distinct runtime ([log](../.tmp/cloudflare-runtime-bridge-final.log)). Go runtime/provider metadata checks pass under the race detector ([log](../.tmp/cloudflare-runtime-server-final.log)). Both portable/native frontend builds, TypeScript, generated contracts and Helm renders pass. Actual local workerd qualifies native D1/DO/Queues/Workflows/R2 fences ([log](../.tmp/cloudflare-managed-app-runtime-final.log)), embedded UI bytes and runtime identity/capability responses ([log](../.tmp/cloudflare-managed-app-ui-final.log)). The interactive demo app executes against real local D1/R2 and verifies its signed receipt with a local test key ([log](../.tmp/cloudflare-managed-app-demo-final.log)); its Python test also passes. Managed-app Secrets Store/dispatch/outbound prebuilt outputs validate ([log](../.tmp/cloudflare-managed-app-output-final.log)). These runtimes were disposed. The collaborative browser could not reach the temporary local UI port, so no interactive UI browser acceptance is claimed.

At this earlier source-only increment, the selected account denied Workers for Platforms discovery with403/error10121 ([log](../.tmp/cloudflare-managed-app-entitlement.log)); Workers Paid does not supply that separate subscription. CLI OAuth also cannot create account API tokens (403/error9109); no OAuth credential was copied into a Worker. Hosted app dispatch, outbound interception, Secrets Store attachment, per-preview DNS/TLS/Access, actual human native UI login and retirement remain unqualified. No new Cloudflare resource was created by this increment. Earlier hosted receipts below retain their exact historical source hashes and bounded scope; they do not qualify this newer app source.

At this earlier increment, the requested populated demo had fixtures but was **not provisioned or ready**. Repository/CI seeding, an explicit stop command and automatic owned-resource deadline teardown still need implementation and hosted qualification. Its agreed four-hour window starts only when ready and has not started. General application dependency builds, app cookies/WebSockets, automatic PR comment links, full native forge/settings parity, production promotion and global SaaS scale remain open. The $10/day envelope remains planning/admission policy, not a provider billing cap.

## Native reviewer UI and static delivery (2026-10-09; local UI and bounded hosted delivery qualified)

The separate native frontend now exposes private repository/PR inventories, overall reviews, approved tests, two concurrent agent admissions, current-source evidence/report inspection and explicit proposal comparison. Overlapping edits require human resolution; separate paths still require integration tests. Neither comparison nor preview deployment publishes canonical Git. Access is the Cloudflare UI's default login: runtime-authenticated identity maps to an active D1 user, and Golf retains current repository authority. Configured Access also gates machine bearers. Caller identity headers are stripped and inactive/unmapped users cannot open the UI. The control Worker embeds a bounded 64-file/2MiB UI rather than using the Static Assets router, whose production Access-context limitation is documented by Cloudflare. Portable frontend/authentication and local schema091 remain unchanged.

Approved passing canonical test reports can automatically publish one exact Artifacts static directory into digest-verified private R2. A separate Access preview Worker has only scoped service RPC into the existing Workspace authority. Current readers obtain a 60-second single-use reviewer grant and a five-minute-or-shorter HttpOnly session; every content read rechecks active user, current repository access, PR revision/refs and expiry. Pushes, PR closure and revocation deny old content. D1 fences publishing uncertainty and one optional paid Browser Run dispatch per preview; private PNG integrity/readback and purge follow the same repository authority. Expiry denies access immediately, with scheduled storage cleanup every five minutes. Four unpurged previews and daily admission limits bound this initial workspace consumer.

`make cloudflare-check` passes with63 native Node and10 initializer/migration tests, the maintained shared agent tests and existing Go/CLI race checks ([log](../.tmp/cloudflare-native-delivery-check-final.log)). The separate native frontend builds with TypeScript/Vite ([log](../.tmp/cloudflare-native-delivery-web.log)). Actual local workerd validates all embedded asset bytes/MIME types, Access identity mapping, spoof rejection and disabled-user denial ([UI runtime log](../.tmp/cloudflare-native-delivery-ui-runtime-final.log)); the existing D1/DO/Queues/Workflows/R2 runtime proof also passes and disposes its runtime ([log](../.tmp/cloudflare-native-delivery-runtime-final.log)). Both production and ephemeral proof build outputs validate ([log](../.tmp/cloudflare-native-delivery-build-final.log)). Controlled tests cover proposal source/revision conflicts, reviewer/session revocation during reads, changed policy, quota/expiry/purge, lost publishing responses, corrupted private objects and uncertain Browser Run outcomes without paid redispatch. These checks do not establish a hosted human login or interactive UI browser workflow.

The earlier [hosted delivery attempt](../.tmp/cloudflare-forge/golf-native-20261009-2c8119f2/ownership.json) ran actual passing container tests and published an automatic READY R2 preview from exact canonical Git, then stopped at its Access/RPC check; all14 owned cleanup categories are absent. A [subsequent attempt](../.tmp/cloudflare-forge/golf-native-20261009-2eceeb44/ownership.json) confirmed the same publication but failed an authenticated request with403; all14 cleanup categories are absent. An isolated [Access probe](../.tmp/golf-access-e766b57d8201/receipt.json) then qualified service authentication, exact runtime audience and unauthenticated denial, with Worker/app/service token absent. An earlier probe records error1010 because the Python client omitted the explicit Golf user-agent; the maintained harness now uses the same client identification as its existing API requests. A transient Artifacts403 stopped another attempt before resource allocation; the attempted namespace was independently confirmed404. Failed receipts remain failures, rather than successful full delivery claims.

The final [hosted receipt](../.tmp/cloudflare-forge/golf-native-20261009-605103d9/ownership.json) passes actual passing/failing canonical container tests, automatic private R2 publication, Access service authentication and unauthenticated denial, real cross-Worker preview RPC, single-use reviewer grant replay denial, current-reader revocation and stale-preview denial after a push. Passing head `e56b370584a060a03a323abf6621cc4e16c4d47c` produced preview bundle SHA256 `910f0c8941cd0990ce60522ca78cf4d6ffce0b93dc18570189d9bc2aae1697de`. Browser Run produced a real30,697-byte [private PNG](../.tmp/cloudflare-forge/golf-native-20261009-605103d9/preview-snapshot.png), SHA256 `b9bd7b7af1b3bcce5def55ef360a2841bfa47c718c86532309056b3704ef72cc`; its binding supplied no browser-millisecond observation, so usage remains null. The synthetic mapped reviewer plus operator-only wrapper qualify the Access/service-RPC/D1/R2 path, not actual human Access identity or browser cookie exchange. Product builds contain no qualification route. Source identities and teardown are reconciled in the [final manifest](../.tmp/cloudflare-native-delivery-final.json).

This slice serves a bounded static directory on UUID paths beneath one dedicated hostname, with CSP sandboxing. Per-preview hostnames, arbitrary application builds/runtimes/data bindings, automatic PR-push CI intake/comment links, tested proposal integration/protected canonical merge, full native forge/UI parity, onboarding/identity changes/recovery, actual human native Access login and global SaaS scale remain open. Browser Run renders only script-free index HTML with external requests denied; it does not establish interactive preview QA. The $10/day envelope is planning/admission policy, not enforced provider billing.

The final manifest matches all27 hosted source hashes and the built CLI digest. All14 owned hosted cleanup categories are independently absent; all three isolated Access probes also removed their Worker, application and service credential. No temporary test service, preview deployment or control-domain deployment is retained.

## Native PR agent execution (2026-10-09; bounded hosted API qualified)

Native PR evidence now admits real OpenCode tasks under current D1 repository write/admin authority. The maintained agent controller is reused through `PRAgentTask`, with an operator-approved source file, immutable image/module/file-policy digest, exact PR head/tree, a unique private Artifacts fork and per-request60-second Git credentials kept outside the container. Queues/Workflows drive admission and immutable private R2 context/results. Current writer/PR/policy/expiry checks, two shared CI/agent slots,16 reserved inference calls,120-second agent execution, bounded tests/output and cancellation fence further effects. Publication remains proposal-only, with a durable receive-pack fence, provider ref readback and exact parent/commit/tree verification. The [separate native setup](CLOUDFLARE_NATIVE_SETUP.md#operator-approved-native-pr-agents) includes opt-in flags, API semantics, private prompt access and additive D1 migration; portable PostgreSQL/local schema091 remain unchanged.

The final [hosted receipt](../.tmp/cloudflare-forge/golf-native-20261009-aacad957/ownership.json) passes two real agents from head `1a878e5b6ba115e2e7ce0fe99d5af254e689ac2d`, tree `d09b4b8e1e60eb3cc6eb958e773295d2554a3e4d`, producing separate Artifacts proposals `030f9cc42b0742ea1134c8512a4f86d39465b183` and `7dfda4d600df339aa0a92ce0cb82297c82473718`. Their recorded native execution overlaps by13,021ms; each reserves4 inference calls through the private AI Gateway. Observed native input/output/reasoning totals are5,235 and5,224 tokens, not dollar billing. Both run the approved module successfully, including intercepted network denial, and confirm destruction before report publication. Canonical Git remains unchanged. A later push marks both retained proposals stale; current readers can inspect private context, then lose that access after grant revocation. The same run also requalifies passing and deliberately failing native CI, and real Clef advice with349 input/0 output tokens.

The [final manifest](../.tmp/cloudflare-native-agents-final.json) verifies all25 maintained source hashes and the built CLI digest; all12 cleanup categories are independently absent, including both container applications, their owned registry image tag, task/Workspace Durable Object namespaces, four Workflow instances, Worker, queue/consumer, gateway, private R2 reports/bucket, canonical/task Artifacts repositories/namespace and D1 database. No temporary test service or control-domain deployment remains. Earlier attempts retain their failures: transient gateway discovery/namespace403, a missing-fork lookup throwing during `get()` rather than `info()`, and a shallow Git push rejected before publication dispatch. The latter is reproduced by an actual local Git [packet trace](../.tmp/cloudflare-native-agent-shallow-proof.log). Native agents now use full single-branch clones within the16MiB upload-pack bound; the strict canonical single-ref grammar remains unchanged. Prepared execution Workflows allow two concurrent instances while D1 independently limits total containers. The earlier overly narrow task cleanup guard is corrected for the four-job proof; its historical failed receipt is preserved, with runtime/resource absence reconciled in the manifest.

`make cloudflare-check` passes ([log](../.tmp/cloudflare-native-agents-check.log)):47 native Node tests,8 native initializer/migration tests, the3 maintained shared agent-runtime tests and existing Cloudflare/Go CLI race checks. Real local workerd/D1/DO/Queues/Workflows/R2 checks pass and dispose their runtime ([log](../.tmp/cloudflare-native-agents-runtime.log)), including an errored Workflow durably refusing further work. Tests cover ambiguous fork/write responses without redispatch, exact source/parent identity, existing or unconfirmed fork targets, current writer revocation, stale selection/policy, shared execution allocation, cancellation, cleanup retry, native permissions, symlink rejection, tests moving the candidate and bounded results. Hosted processes, model calls, concurrent execution and cleanup are qualified separately from controlled unit interfaces.

This is an API-only, single-approved-file OpenCode/Python profile, not full native agent/forge parity, hostile-repository isolation or SaaS scale. Native agent controls, live activity, comparison/integration UI, automatic protected previews, all-harness/dependency/workflow support, protected canonical publication, migration/recovery/retention and fleet acceptance remain open. Analytics Engine still has source/unit/native build evidence only; these hosted tests create no dataset.

## Native PR container execution and metrics (2026-10-08; bounded hosted API qualified)

The native evidence consumer now runs real repository tests through Containers/Sandbox. An operator approves one Python unittest module and immutable local image ID; each task binds that policy digest and the PR's exact head commit/tree. D1 admission, a two-container workspace limit, current writer/PR/policy checks, read-only Git brokerage, test-stage outbound denial, single-use dispatch, bounded execution, cancellation and destruction precede private R2 publication. The separate [native setup path](CLOUDFLARE_NATIVE_SETUP.md#operator-approved-container-tests) includes allocation flags and an additive migration for existing native D1 installs. Portable PostgreSQL and the retained local deployment are unchanged.

The final [hosted receipt](../.tmp/cloudflare-forge/golf-native-20261008-41c3d38b/ownership.json) passes the actual Queues/Workflows/Artifacts/D1/Durable Object/Containers/Sandbox/R2 consumer. Commit `be2e6143538c59f22b217a8b7a7ad53c3498cae6` runs two passing tests, including a real intercepted403 network denial. A later deliberately broken commit `5d82b70e730268b54f7f749f8a21efc7efbe1f10` runs the same module and records `FAILED`, exit1, its own exact tree and confirmed destruction. The original report becomes stale; revoked readers cannot download either report. Clef completes through the private AI Gateway with351 observed input tokens and0 output tokens. Neither execution nor advice grants merge authority.

`make cloudflare-check` passes ([log](../.tmp/cloudflare-native-tests-check.log)):34 native Node tests,6 native initializer/migration tests and the existing Cloudflare/Go CLI race checks. The real local workerd/D1/DO/Queues/Workflows/R2 check also passes and shuts down ([log](../.tmp/cloudflare-native-tests-runtime.log)). Unit container interfaces are controlled; hosted process exits, denied traffic and teardown are qualified separately. Earlier failures exposed protocol-v2 loss in shallow cloning; only the private test broker now forwards a validated Git protocol header. Hosted first-write/clone availability remains variable; Git writes are never blindly retried.

The [final manifest](../.tmp/cloudflare-native-tests-final.json) verifies all19 maintained source hashes and the built CLI digest, audits36 native receipts with no unresolved cleanup, and records removal of every final owned resource: tasks/DO namespaces, container application/image tag, Worker, queue consumer/queue, Workflow, AI Gateway, private R2 reports/bucket, Artifacts repository/namespace and D1. Earlier failed attempts remain failed in their receipts. No retained service or analytics dataset was deployed.

Optional Analytics Engine completion metrics are source/unit and native build-output qualified, with no hosted ingestion/SQL readback claim. Measurements exclude private content and raw workspace/user/task names, preserve missing token observations as `-1`, and never replace D1 quota/billing authority. This remains an API consumer with one approved unittest profile; browser/CLI job controls, native agent admission/editing, general Actions execution, automatic protected previews, managed application hosting and global fleet scale remain open.

## Native queued PR evidence (2026-10-08; bounded live API qualified)

The [optional native allocation](CLOUDFLARE_NATIVE_SETUP.md#optional-queued-pr-evidence) connects Cloudflare Queues, Workflows and private R2 to the native repository authority, with an explicitly enabled Workers AI Clef call through AI Gateway. Writers admit an exact open-PR selection and owner-scoped operation key. D1 retains the metadata snapshot/outbox, UTC-day allocation and inference reservation; one workspace Durable Object serializes provider effects with Git/permission changes. Queue/Workflow payloads contain only job IDs/states. No portable forge, PostgreSQL, origin or Container participates in this consumer, and existing installations/repositories are unchanged.

The final [live receipt](../.tmp/cloudflare-forge/golf-native-20261008-0e80dbdd/ownership.json) passes native Git/CLI/collaboration plus actual Queue-triggered Workflow completion, private conditional R2 retention, matching report SHA256/source selection, reader download, later-push staleness and repository-reader download revocation. One real Clef dispatch returns `inspect_changes` with 297 observed input tokens and 0 output tokens; its three probabilities are validated/projected without fabricating usage. It is a recommendation from PR metadata, not a code review, executed test or merge decision. Worker/schema/build/qualifier/CLI source hashes and the built CLI digest match that final receipt.

Twenty-five Node tests cover the complete native source boundary, including lost queue/create/PUT acknowledgements, exact-ID Workflow deduplication, bounded redispatch, quota accounting, inference uncertainty/no re-inference, malformed typed advice/usage, policy/actor/grant loss, stale refs, corruption and expiry during R2 publication. Actual installed workerd runs D1/DO issue transactions and revocation, real Queues/Workflows expired-job denial and R2 create-only conditional writes. Three independent initializer tests apply real SQLite bootstrap and validate private/fresh installation plus optional allocation rejection. The complete Go CLI race suite and remaining Cloudflare checks pass in the [source check log](../.tmp/cloudflare-native-evidence-check.log); the [native runtime log](../.tmp/cloudflare-native-evidence-runtime.log) records its narrower platform boundary.

The final launcher removes its queue consumer, Workflow instance/definition, Worker/Durable Object class, unbound queue, gateway, exact report/private bucket, Artifacts repository/namespace and D1, with independent resource absence checks. The [read-only absence audit](../.tmp/cloudflare-forge/resource-absence-20261008.json) checks all 28 native receipts and finds no remaining owned Durable Object namespace or unresolved cleanup. Earlier gateway-minimum, clone/push and cleanup-order failures remain in their original event history; subsequent exact-identity recovery records confirm final absence. Read-only Git readiness/clone retries are bounded; no uncertain Git write is automatically resent. Fresh hosted Git requests have produced HTTP 500/404 failures during this qualification, so the positive disposable flow is not production availability or scale acceptance.

This adds an API evidence consumer, not browser/CLI evidence controls, actual CI/agent execution, protected previews/merge or canonical recovery. Operator-approved job allocations are 1–20/day and expire after ten minutes; AI defaults off. Advisory uncertainty can be retained in a completed metadata report. A pending outbox has at most three original-ID dispatches; there is no scheduled reconciler/garbage collector or global tenant quota/router yet. Gateway/provider retries and billing remain separate from Golf's durable single inference dispatch. The $10/day envelope is planning policy, not a provider-wide billing cap. Native user/account/credential lifecycle and retained control-domain deployment remain open.

## Native D1 collaboration (2026-10-08; bounded API and CLI qualified)

The [native setup](CLOUDFLARE_NATIVE_SETUP.md#native-collaboration-and-cli) now adds native issues/comments, shared issue/PR numbering with separate PR identities, same-repository PR create/read/edit/state/draft workflows, immediate overall reviews and commit-bound reported checks. D1 transactions commit the collaboration effect and owner-scoped operation receipt together; exact revision edits prevent concurrent stale changes, and lost responses after commit can be replayed without another effect. Current repository grants are checked before reads, mutations and operation inspection. The portable Go/PostgreSQL/forge path and existing canonical repositories are untouched by this D1 schema.

The final [native receipt](../.tmp/cloudflare-forge/golf-native-20261008-690ef349/ownership.json) passes the existing Artifacts push/clone/source proof plus actual Golf CLI issue creation/read through generated Connect contracts, issue/comment creation replay, exact revision edit and stale-edit denial, a PR created from actual base/head branches, reader overall approval/replay, author-approval refusal and administrator-only reported check publication. A second actual Git push advances the proposal: the retained review becomes stale, stale review/check selections fail, and the new head has no inherited checks. Repository-reader revocation denies issue/PR and own review-operation reads as well as Git. The receipt records Worker/schema/CLI source hashes and the built CLI digest. Its owned Worker/Durable Object class, Artifacts repository/namespace and D1 database are removed with absence checks.

Fifteen Node tests exercise actual SQLite transaction rollback, a lost response after commit, duplicate/conflicting inputs, concurrent revision edits, exact identities, reader/author/writer boundaries, closed/draft proposals, unavailable refs, stale reviews, reported-check supersession/commit binding and revocation. Actual local workerd/D1/Durable Object checks now include issue/comment transaction replay, not only identity. The complete Go CLI suite passes with the race detector, including explicit native credential selection, mixed-mode refusal, canonical token checks and preservation of portable/source write restrictions. The native CLI refuses MCP enrollment until an appropriate scoped native lifecycle exists. The [Cloudflare checks](../.tmp/cloudflare-native-collaboration-check.log) cover the final source; the setup initializer tests remain included.

This is API/CLI collaboration acceptance, not browser acceptance or complete native forge parity. PRs are currently within one repository; comparison/history/diffs, inline/pending reviews, labels/assignees/milestones, notifications, protected rules/merge and product-integrated Actions/agents remain required. Reported checks are controlled status observations, not actual CI execution or trusted merge evidence, and overall reviews are not official approvals. Native authentication/account/credential lifecycle, browser control deployment, existing-repository cutover/backup/restore and global partition scale remain open. All owned test resources are removed; no control-domain deployment or retained-installation upgrade is attributed to this increment.

## Native Artifacts repositories (2026-10-08; bounded live Git qualified)

The independent [native setup path](CLOUDFLARE_NATIVE_SETUP.md) now has a real Worker/Artifacts/D1/Durable Object repository foundation. Canonical Git objects and refs are created directly in Artifacts. D1 owns workspace identities, hashed expiring credentials, per-repository grants, stable repository IDs and create/write journals. The workspace coordinator serializes provider effects and authorization changes. Existing local and bridge repositories remain untouched and owned by the portable forge until explicit migration; this is not a cutover of existing data.

The final [live receipt](../.tmp/cloudflare-forge/golf-native-20261008-c3a8e8aa/ownership.json) passes actual private repository creation/replay/conflicting-key denial, Git push and clone through Golf, exact commit `18e861fa1b497a7183958409c26bd7177f21d7fa`, immutable file bytes, directory/symlink/binary reads, source selection, reader-only Git access, write denial and repository-read revocation. The receipt pins the source qualified for that repository-only increment. No portable forge, PostgreSQL, Tunnel, fixture Git provider or external origin participates in this proof. The owned Worker, Durable Object class, Artifacts repository/namespace and D1 database are removed; each resource has an independent absence check. Earlier failed attempts are retained honestly in their own receipts, with their resources removed too.

Nine Node tests cover the authority/operation boundaries against SQLite plus controlled provider failures. Two initializer tests exercise private files, real SQLite bootstrap application, validation and refusal to rotate an existing installation. The installed CLI's actual local workerd/D1/Durable Object runtime passes identity, spoofed-header denial and credential revocation, then shuts down. `make cloudflare-check` passes ([local log](../.tmp/cloudflare-native-check.log)); the final run includes opaque-token and initializer coverage. Artifacts commit/tree field mapping was checked against the installed runtime declarations. Qualification fixed both opaque provider-token handling and ordinary Git capability-list whitespace; the broker requests short-lived provider tokens and revokes them after each request.

The offline native initializer writes `.cloudflare/native` independently from the bridge's `.cloudflare/install`. Its custom-domain/operator-bootstrap deployment is not yet live-qualified; the disposable proof uses a verified Workers subdomain. No persistent control service or DNS record was created by this increment. This is bounded private, unprotected single-ref SHA1 Git, not protected merge or full forge parity. Native issues, PRs/reviews/checks, history/diffs, the browser control UI, tenant/account administration, automated pending-write reconciliation, canonical migration/backup/restore, production partition scale and product-integrated Actions/agents remain open. Pending Git effects fence new writes without blocking repository access revocation.

## Cloudflare control setup (2026-10-08; source/local runtime only)

The separate [Cloudflare setup path](CLOUDFLARE_SETUP.md) now generates private configuration under `.cloudflare/install`, with project-scoped bridge volumes, new credentials, origin/runner TLS, R2 settings and optional existing agent/notification/Actions consumers. The initializer provisions nothing. Local `.env*` files and the retained local installation are preserved; inherited Compose/application variables cannot override the selected project. No host ports are published. `gitgolf.mjtechguy.com` is the control default following the user's latest suggestion; `origin.gitgolf.mjtechguy.com` is a proposed service-only origin hostname, not an existing deployed route.

The control Worker serves the production frontend through Workers assets and streams existing dynamic API/Git routes to one HTTPS bridge using a separate Access service credential. Tests cover caller Authorization/Origin preservation, header/cookie isolation, separate Set-Cookie values, manual redirect handling, dynamic no-store responses, preview handoff headers and SPA/API separation. Five Node tests and two setup tests pass; the latter render actual Compose with all supported overlays, verify origin certificate names and reject unsafe/private configuration. `make cloudflare-check` passes ([local log](../.tmp/cloudflare-control-check.log)). The installed CLI's local workerd also passes fixture-origin streaming/cookie/UI checks and is disposed afterward. Native CLI prebuilt dry-run passes with116 production frontend assets; nothing is uploaded.

This increment does **not** establish a live control-domain deployment, origin Access/Tunnel policy, fresh retained installation, complete local capability parity or canonical Artifacts Git. Native Git/SSH/OAuth ingress requires its own configuration/acceptance. Canonical repositories remain owned by the portable forge on the bridge; the qualified Artifacts agent forks are separate. Artifacts canonical storage plus D1 collaboration/authorization and product-integrated Sandbox tasks remain necessary native work, reinforced by the user's explicit Git-in-Artifacts clarification. No provider resources or persistent test services were started by this increment, and no schema migration was added.

## Cloudflare protected preview094 (2026-10-08; bounded native browser qualified)

Migration094 adds an optional single-client Golf OIDC issuer, an operator-configured Cloudflare static deployment target, the existing UI's reserved deployment identity, and a Worker broker using runtime-authenticated Access identity. One-use60-second codes/grants, S256 PKCE, exact callback/client authentication, host-only five-minute viewer cookies, current native repository readers and live parent/environment/artifact fences are enforced. Private operator signer/client/broker files are separate from encrypted product account profiles. An explicit operator mapping can bind one existing external Access email to one native reader without changing Golf OIDC claims. See the [setup and scope contract](CLOUDFLARE_FOUNDATION_CONTRACT.md#operator-configured-protected-static-preview).

`make check` passes ([local log](../.tmp/cloudflare-preview-make-check.log)), as does the production web build. The final [PostgreSQL/race receipt](../.tmp/cloudflare-product/golf-cf-product-20261008-c4a5a8d1/ownership.json) covers native-shaped OIDC requests, authenticated single-use/concurrent exchanges, wrong client/PKCE, expired parents/codes, private configuration and resource/secret/mapping rotation, reserved deployment identity, Access-before-grant, wrong-reviewer/broker refusal, immutable artifact reads and repository-reader/parent revocation. Seven Worker tests cover runtime Access context/audience, alternate hosts/control cookies, grant origin/body limits, credential stripping, external-identity forwarding and withholding storage output after revocation.

The final [native qualification](../.tmp/cloudflare-previews/golf-cf-preview-20261008-6496579a/ownership.json) and [collaborative browser proof](../.tmp/cloudflare-previews/golf-cf-preview-20261008-6496579a/browser-proof.json) exercise actual Golf/PostgreSQL, Access email-code authentication, Worker/custom-domain TLS/DNS, D1 and private R2. The user authorized reuse of an existing Access seat and entered the emailed code in the browser. The exact-host application required both that email and the owned temporary login method; Golf separately authenticated fixture reader42. The browser executed the immutable retained JavaScript (`real-static`) and fetched matching HTML/JavaScript200/no-store responses. `/api/storage` returned a real D1 query result and the exact3072-byte archive digest from R2. JavaScript could read no authentication cookie. Anonymous requests redirected to Access; the health-only machine credential received404 for HTML, JavaScript and storage.

After removing only repository read permission, the same browser received404/no-store for all three content paths. Independent checks still returned200 for the Access identity endpoint and Golf session endpoint, proving repository revocation rather than logout caused denial. No project content was returned after revocation. The original repository identity and runner-protocol artifact producer remain controlled fixture inputs: this is not a real forge PR or execution of real CI commands.

Every owned resource from the final attempt is removed with independent native absence checks: Worker/domain/DNS, Access application/temporary IdP/service token, D1, R2 object/bucket, temporary tunnel and PostgreSQL. Existing Google IdP, users, subscriptions and unrelated zone records are preserved. The [final source/evidence manifest](../.tmp/cloudflare-preview094-final/manifest.json) records hashes, earlier attempts and cleanup without credentials.

Earlier receipts remain honest failures. [Golf-issued identity admission](../.tmp/cloudflare-previews/golf-cf-preview-20261008-e5496ed9/browser-proof.json) reached the Access callback but was blocked by the organization seat limit; [existing Google login](../.tmp/cloudflare-previews/golf-cf-preview-20261008-5e9d4ec4/browser-proof.json) encountered a deleted Google OAuth client. Neither is marked native-qualified. [The first email-code attempt](../.tmp/cloudflare-previews/golf-cf-preview-20261008-d5e98a84/browser-proof.json) exposed a browser form bug: `no-referrer` produces `Origin: null`. Trusted resume/grant documents now use `strict-origin` in HTTP and HTML, keeping exact Origin checks and withholding URL paths/queries; project content/denials retain `no-referrer`. Earlier native command/TLS/user-agent/OIDC parameter failures and their owned cleanup remain in the per-attempt records.

Next product gate: durable automatic PR admission/provisioning/link publication, superseded-attempt fencing, TTL/owned cleanup and approved resource/budget policy. General machine preview grants, real PR/CI execution, native SaaS tenancy/scale, arbitrary app builds and production promotion remain open. This adapter supports one explicitly configured deployment per process, with either Golf-issued aliases (source-qualified) or one explicit external reader mapping (native-qualified through email code). It does not upgrade retained schema091 or complete CF3/CF4/the competition gate.

## Cloudflare foundation (2026-10-07; bounded live runtime qualified)

The earlier read-only slice in the [foundation contract](CLOUDFLARE_FOUNDATION_CONTRACT.md) records: `golf-server cloudflare inspect` performs three bounded read-only account/namespace probes through direct API credentials or a named `cf` OAuth profile, and `cloudflare/qualification/src/worker.mjs` authenticates operator-private R2 object metadata/Artifacts namespace probes. It creates no native tenant, provider resource, Git token or deployment. Profile mode delegates authentication to the CLI without opening credential files and checks selected-profile/account identity before service reads. Management credentials remain separate from saved R2 S3 profiles; product management-token persistence is not implemented. [ADR0008](decisions/0008-cloudflare-native-saas-ownership.md) records the selected native SaaS destination and proposed ownership/migration boundary.

`make check` passes, including formatting/vet/all root Go packages, web type checking, generated contracts, maintained engine/vendored runner checks, compatibility register checks, focused Cloudflare/command race checks and all eight Node test results. Go tests cover scoped read-only paths, malformed/oversized responses, denied/partial operations, credential omission, redirect refusal, invalid command/configuration and cancellation. Worker checks cover pre-provider authentication, metadata/credential omission, independent binding errors, routes/methods and timeout. Local documentation links and private-by-default example configuration checks pass. An initial Worker fixture incorrectly expected trailing HTTP header whitespace to remain unnormalized; the corrected fixture checks invalid internal whitespace, and the final complete checks pass.

The subsequent [live account receipt](../.tmp/cloudflare-foundation/account-post-upgrade.json) binds `cf 1.0.0-beta.13`, the repository-bound `golf` OAuth profile, selected account, exact built binary/source hashes and the approved $10/day infrastructure-plus-AI testing envelope. Workers scripts search and R2 bucket-page reads succeeded before the upgrade, while Artifacts namespace discovery returned HTTP403/API10004. After the user enabled Workers Paid, subscription discovery lists that plan and Artifacts namespace discovery succeeds with an empty page. The rebuilt Golf profile inspection exits0 with all three scoped reads accessible. Artifacts accepts a repository-list read for the as-yet unprovisioned `golf-development` namespace; this success is collection-read evidence, not namespace existence or Git/write readiness. No provider-resource mutation, deployment or paid inference was performed.

The account-inspection increment's full `make check` and build pass. Added native subprocess tests qualify account pinning, credential/profile ambiguity refusal before service operations, partial/malformed reads, metadata exclusion, bounded output and cancellation. The subsequent live proof below supersedes the earlier runtime-unqualified boundary only for its explicit scope.

`python3 scripts/cloudflare-foundation-smoke.py --profile golf --account-id ACCOUNT_ID` now passes the disposable CF1 vertical slice. The [complete live receipt](../.tmp/cloudflare-foundation/golf-cf1-20261007-9504515f/ownership.json) binds the selected account, native CLI version, exact runner/helper/Worker/object-store source hashes, Worker ID/version, resource names, Git identities, operation outcomes and cleanup. This remains a dirty source snapshot, not a frozen product release. The existing Golf S3 store passes actual R2 immutable source/artifact create/replay, exact readback, conflicting-content preservation, hash/size/corruption rejection, four simultaneous conditional writers with one winner, unsigned-request denial and wrong-key denial. Public R2 routes remain disabled.

Independent Git verifies public baseline commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` and tree `b4eecafa9be2f2006ce1b709d6857b07069b4608` before and after shallow Artifacts import. A separate fork starts at that baseline and accepts proposal `20f3e36ab1ef3ce227fee43b83147ca838dbb3eb`; a fresh clone verifies tree `68956d0278bca53cd5bbd3e1d1b0b39f86a2539e`. Anonymous Git returns401; read-token writes fail native authentication, cross-repository reads and revoked-reader requests return403, and parent refs remain unchanged. Native OAuth, not extracted CLI credentials, authenticates the installed SDK workaround for beta.13's dropped fork destination field.

Worker `836d23215595423da8246fc3ef36a978`, version `b1fd8aa5-908d-4691-af59-d2dfcc9d8db0`, passes actual R2/Artifacts bindings with200, anonymous/wrong-token401, write-method405 and query404, fixed metadata-free responses and no-store. Its temporary workers.dev route is operator bearer-authenticated, **not Zero Trust protected**; preview URLs stay disabled. Eleven transient platform404s resolve within the bounded probe wait; the complete five checks take6.625s. Only this exact side-effect-free probe retries the platform404, not provider mutations or Worker failures.

Exact Worker/bucket/namespace GET404 readbacks, minted Git-token revocations, post-deletion automatic Git-credential denials, R2 user-token GET404 and cleanup-token verify401 all pass. A five-minute current-user token-management credential resolves the native OAuth DELETE403 gap and self-revokes; its provider scope covers this user's tokens, so it is an operator cleanup mechanism, not tenant isolation. Failed earlier attempts retain their original receipts. Two early R2 cleanup harness mistakes were reconciled by exact-key deletion and bucket404, with separate correction receipts. The separate [all-owned resource audit](../.tmp/cloudflare-foundation/all-owned-resource-absence.json) confirms every attempted Worker/bucket/namespace name absent with404.

Final `make check` passes with root Go/maintained-engine checks, browser type checking, generated contracts, compatibility register, focused Cloudflare race checks, all eight Worker tests and native-helper/Python syntax checks. The live Go test is explicitly opt-in and skipped by ordinary source runs; database-dependent tests remain skipped without an isolated DSN. No paid inference or account-bill measurement is claimed. The $10/day envelope is planning policy, not a provider cap.

This closes the bounded Worker/R2/Artifacts proof, not all CF0/CF1 product acceptance. The following increment qualifies operator-controlled concurrent execution. Versioned product management connections, native tenant authority, full-history migration, D1/provisioning, DNS/Access previews, recovery and measured scale remain open. Retained localhost/schema091 and product capability readiness remain unchanged.

## Cloudflare concurrent agent runtime (2026-10-08; bounded live CF2 prototype qualified)

`python3 scripts/cloudflare-foundation-smoke.py --profile golf --account-id ACCOUNT_ID --agents` passes the [complete live receipt](../.tmp/cloudflare-foundation/golf-cf1-20261008-0496f62e/ownership.json). The maintained runtime and repeatable operator runner are specified in the [agent contract](CLOUDFLARE_AGENT_CONTRACT.md). All foundation and agent source hashes in this receipt match the current maintained files. This is an uncommitted source snapshot, not a frozen release or a tenant-authorized Golf deployment.

Two native SQLite Durable Objects and separate Cloudflare containers execute pinned OpenCode1.18.34 against private Artifacts forks through Worker-only Git/inference brokers. Both real inference and execution intervals overlap. Agent A uses four model calls and reports5,386 native tokens; its addition check passes and full suite fails as intended. Agent B uses six calls and reports9,376 tokens, with both tests passing. Exact published commit/tree identities and private immutable R2 receipt hashes pass independent readback. Native resolved permissions and completed file-tool events are retained; only `calc.py` is readable/editable. GLM's binding-native usage event is normalized for OpenCode without inventing usage or completion.

One real Clef advisory call returns `integrate_and_retest` with174 input tokens; replay returns the reserved result. Cancellation destroys its container after one inference dispatch. The ten-second timeout expires after three dispatches and1,543 reported native tokens; both negative forks remain at the admitted base and publish no proposal. These are process/inference cancellation observations, not proof that an already dispatched model call is unbilled.

Both proposals survive a real `calc.py` merge conflict. The controller creates candidate `6af4dfbcf471b1e14b597450111734865b202956`, tree `ef1ebde5ba78254c11e5380613a5a491d2c14441`, with preserved merge ancestry. A separate native container clones that exact candidate and passes fresh full tests. Advancing the original parent makes the old base stale; promotion is withheld. Prior proposal checks are not used as candidate checks. All five complete context/result payloads were additionally retained privately on the operator machine before provider cleanup; the [local retention ledger](../.tmp/cloudflare-foundation/golf-cf1-20261008-0496f62e/retained-context.json) binds their filenames, byte counts and verified hashes.

Container destruction, class retirement and namespace absence, exact application/Worker/image/gateway deletion, foundation bucket/Artifacts namespace404, post-deletion Git denials and minted credential cleanup all pass. A final [read-only account audit](../.tmp/cloudflare-foundation/all-owned-resource-absence-20261008.json) finds no owned qualification Workers, R2 buckets, Artifacts namespaces, container applications/images, AI Gateways or Durable Object namespaces. Earlier failed attempts retain their failure receipts: attested OCI images would not boot; native write shares the edit permission; permission patterns are worktree-relative; the native usage suffix needed normalization; the original three-second timeout expired before inference. None is counted as a passing full run. Final focused Cloudflare race/Node/Python checks and native prebuilt deployment dry-run pass; the earlier full `make check` remains its separately recorded broader source check.

This closes the bounded provider runtime proof. Full CF2 still requires the existing Golf-authorized task/result consumer, durable product ownership and comparison/context UI. The temporary bearer-protected workers.dev endpoint is operator-only and does not qualify repository-authorized Zero Trust previews. D1/resource provisioning, DNS/Access previews and measured global SaaS operation remain open. Localhost/schema091 and production capability readiness are unchanged; the $10/day testing envelope is not a provider billing cap.

## Cloudflare product accounts and operator storage (2026-10-08; migration093 source ahead)

The [foundation contract](CLOUDFLARE_FOUNDATION_CONTRACT.md#product-account-profiles-and-operator-storage) now covers Cloudflare account profiles in Infrastructure connections and an explicit repository-environment operator storage consumer. Profiles reuse encrypted immutable history, administrator password/CAS checks and the shared settings UI. The API origin is fixed; account changes require credential replacement; mixed database/S3 fields and API/PAT/OAuth delegation are refused. Workers/R2/D1/Artifacts read probes report independent observations without provider writes or secret projection.

Provision/Get/List/Remove reuse the existing cookie/Origin/native-repository authority boundaries. Migration093 retains original actor/repository/owner/environment/profile/account/input ownership, dispatch acknowledgements and append-only events. One unresolved pair per environment and bounded workspace history prevent duplicate allocations. Current authority/version/owner checks precede effects. Exact create acknowledgements and independent readbacks qualify D1 identity and R2 creation date/private serving; collisions are refused without adoption. Unknown effects retain their fence and are not redispatched. Cleanup uses original acknowledged identities/credentials; same-name R2 replacements remain untouched, and GET404 establishes removal. Cleanup can compensate original acknowledged resources after repository deletion but still requires current operator administrator authority/password.

The served T3 browser [receipt](../.tmp/cloudflare-product/golf-cf-product-20261008-3e184472/ownership.json) passes actual password login, Add/Save encrypted-profile inventory, fixed Cloudflare fields, secret/editor clearing, saved account selection, a provider permission REFUSED allocation with both resources PLANNED, wrong-password private masking and fresh-authority absent-intent inspection/explicit clearing without creation replay. The placeholder credential returns independent Workers/R2 unavailable and D1/Artifacts denied states; none is falsely accessible. Its native repository identity is controlled and no live provider credential is installed. Main-frame DOM input/click events run together while real requests settle, because separate tool focus correctly revalidates/clears private forms. The earlier [failed browser attempt](../.tmp/cloudflare-product/golf-cf-product-20261008-99f86d67/ownership.json) remains failed, with cleanup passing; its served inventory alone was not accepted as interactive evidence.

`make check` passes root Go formatting/vet/tests, generated contracts, web type checking, maintained engine/compatibility checks and focused Cloudflare/agent checks. The new PostgreSQL qualifier also runs the race detector with real encrypted-profile/version/permission/history checks, exclusive dispatch ownership, original-only replay, immutable acknowledgement identity, pre-existing foreign collisions, late repository revocation, ambiguous D1 response with no adoption/retry, cleanup after repository deletion and refusal to delete an external same-name R2 replacement. The actual [SIGTERM interruption proof](../.tmp/cloudflare-product/interrupt-proof.json) verifies owned database/child shutdown; its interrupted qualification stays failed rather than being relabeled as a positive run.

The maintained launcher mints temporary native account-scoped credentials in memory, records owner-only receipts, immediately removes test resources and checks independent provider absence/revocation. Browser and source modes stop their exact tunnel/database/process groups. No provider secret is printed or retained. The $10/day infrastructure-plus-AI envelope remains planning policy, not a provider billing cap; these storage qualifications invoke no inference. Retained localhost/schema091 is unchanged. Complete build/configuration/resource policies, Worker bindings, secrets, deployment/approval/production isolation, native tenant authority, Cloudflare task/result/comparison/context integration, protected DNS/Access previews, latest-schema coordinated recovery and measured scale remain open. On 2026-10-08 the user confirmed `previews.mjtechguy.com` with per-preview hostnames and Golf-backed short-lived reviewer grants. Read-only native inspection verified the active zone and an existing Google Access identity provider; no Golf OIDC provider was present. The Golf-to-Access issuer/identity bridge and current-reader preview broker remain unimplemented/unqualified; no DNS/Access application or PR preview link has been published.

Final [database/race source receipt](../.tmp/cloudflare-product/golf-cf-product-20261008-70e2f98d/ownership.json) and [native live Golf consumer receipt](../.tmp/cloudflare-product/golf-cf-product-20261008-afccc3fb/ownership.json) pass against their recorded maintained source hashes. The live operation is REMOVED, native D1/R2 GET404 checks pass, its PostgreSQL container is stopped, the exact product token is absent and its cleanup helper self-revokes. These are real Cloudflare effects through Golf RPCs with controlled native repository identity, not an actual portable-forge deployment, Worker application or protected preview. Earlier successful/failed attempts retain their original source snapshots and scope.

Final complete `make check` passes after the last ownership/cancellation changes (`.tmp/cloudflare-product/final-check.log`). The [owned-runtime absence audit](../.tmp/cloudflare-product/runtime-absence-20261008.json) reports zero remaining qualification databases, test launchers or cloudflared processes across all11 attempts. Unrelated installations are untouched. Private receipts, source hashes and logs remain for review; no temporary test server or tunnel is left serving them.

## Local ordinary Actions milestone (2026-10-07; source ahead of deployment)

A native Requests receipt (on the native forge at the time; receipt removed with the earlier backend) qualified the original `.github/workflows/lint.yml` at `414f0513c33883adf6f2b46901d4f0b38a455851` under `golf.workflow.act.v0.2.89.linux.remote-node24.v1`. Independent native Git verifies commit/tree/workflow; an explicit native sponsor and signed push admit a private repository run. Genuine pinned checkout and setup-python execute on Node24; setup-python selects the approved image's CPython3.14.8 toolcache, and the unchanged dependency command passes all nine pre-commit checks. This is a dirty source snapshot bound by binary/image/file hashes, not a clean frozen deployment revision.

Three separate controlled source commits qualify failed-command/denied-egress behavior, the one-minute job timeout and cancellation after a running step. All four native run outcomes and exact-owned Docker teardown are recorded; unrelated identities remain unchanged. The legacy job resource profile is preserved. Genuine Python installation exceeds its temporary volume, so the operator image includes the authentic read-only toolcache rather than weakening job limits or replacing the action.

Checks (receipt removed with the earlier backend) recorded `make check`, runner/engine tests and a real PostgreSQL-backed authority/race suite with 111 named cases and no skips. Controlled native-response tests do not substitute for the separate actual native runtime receipt. Existing graph UI recognizes the catalog and passes build/type checks; this increment adds no new served-browser qualification. Failed attempts, including real Git/proxy/toolcache integration discoveries and the intentionally refused workflow-level `github.token` probe, remain in owner-only local receipts.

[Operator setup](ACTIONS_REMOTE.md) and the explicit Compose overlay make this profile reviewable and repeatable. Retained localhost remains schema091/frozen `f548567`; no rollout is claimed. Preserved `pull_request` declarations do not enable actual PR/fork events. Private actions, broader Git/Actions behavior, long-step token refresh, provider artifacts/cache/OIDC, hostile tenant isolation and the full compatibility plan remain open. This milestone is the stopping point for the current local work before discussing self-hosted and global Cloudflare SaaS paths.

## A1 historical Git workspaces: bounded owned runtime qualification (2026-10-07)

The explicitly configured `GOLF_RUNNER_GIT_PREPARATION_IMAGE` now negotiates `golf.runner.git-source.exact-h.v1` only after verified TLS1.3. The existing trusted worker/engine path prepares native Git metadata without exposing controller/provider credentials and preserves original admitted source bytes. Default workers retain the legacy archive profile; the retained deployment is unchanged.

Actual Git engine/image proof (receipt removed with the earlier backend) passed six cases: correct source, wrong tree before frames/acknowledgements, cancellation, workspace byte exhaustion, inode exhaustion and real create with deliberately lost acknowledgement followed by exact-owned recovery. Registry bytes bind OCI index/platform/configuration/layers/diff-IDs. Git job roots are read-only and writable tmpfs mounts have independent byte/inode limits. Four minimal vendored act adaptations preserve default behavior and are reconstructed/checked against original source; all seven drift/tamper cases are rejected.

Actual enrolled historical Git proof (receipt removed with the earlier backend) passed on schema091, exact Linux/amd64 binaries/images/source hashes and a fresh private repository on the native forge at the time. Both jobs execute admitted H after its branch advances. Independent native Git fetch/readback verifies H, actual tree, original workflow blob and executable mode100755 separately in each scoped job. Core and worker restart retain the original graph/attempt without replay. Abrupt worker SIGKILL leaves residue, normal startup refuses reuse, and explicit recovery fences the original attempt as lost before removing owned containers/volumes. No automatic replacement is created; all owned stacks are removed and unrelated identities remain unchanged.

Local A1 checks (receipt removed with the earlier backend) recorded full `make check`, runner race checks and real isolated PostgreSQL authority/race tests with the independently built planner and no skips. Earlier failed receipts remain unchanged: rootless archive-copy/read-only-root failures, native volume cleanup resetting precreated options, fixture YAML/shell mistakes and launcher TLS arguments led to corrected native paths. Native attempt6's passing receipt is excluded from tree qualification because the REST field aliased H; attempt7 proves the correct tree but exposed the qualifier's missing worker namespace rebind after core restart. Corrected attempt8 passes historical source and worker-death recovery.

At this historical checkpoint, four bounded A1 tasks were completed; the later local ordinary Actions section above supersedes only its explicit scopes. Job-token delivery/rotation/masking with independent public/control origins, genuine checkout options and the adversarial Git corpus remain open. Remote Node24 Actions/dependency egress and unchanged Requests remain refused. No retained rollout, source repository CI workflow, private-token job execution, GitLab Runner or broad parity is claimed.

The historical separately undelivered job credential candidate admits bounded Git v2 ls-refs and exact-H/depth1 fetches. V2 source/database proof (receipt removed with the earlier backend) recorded real native Git fresh/repeated fetches and real PostgreSQL late-revocation/graph/namespace fences for v0/v2, with no skips and owned database cleanup. Advertised capabilities exclude filters/server options/alternate transports; foreign wants/haves, deeper history and cross-repository paths remain refused. The earlier historical runtime receipt remains bound to its earlier v0 binaries. Failed v2 attempts preserve native optional-LF and have-H acknowledgement-round discoveries; the final 90.674-second authority/race suite passes. Eight additional native Git source tests pass export transformation refusal, link/gitlink denial, literal LFS preservation and disabled hooks/helpers with no source-selected private endpoint contact. These are separate source/native Git checks, not private-token delivery or actual forge checkout.

## Forge/CI compatibility foundations on an earlier backend (2026-10-07; condensed)

A versioned compatibility register, workflow inspection `golf.workflow.inspect.v3` and one bounded native workflow run were qualified on the native forge at the time (an earlier backend, since retired). Those documents and receipts were removed with it. The register is now based on Forgejo 15.0.9's served Swagger, and Forgejo workflow discovery uses `.forgejo/workflows`, then `.github/workflows`.

Requests lint is pinned unchanged at `414f0513c33883adf6f2b46901d4f0b38a455851`; its earlier roadmap pin at `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60` has identical workflow bytes and is preserved. An actual public GitHub run succeeded on the selected commit. Golf's pinned negative admission test refuses the same workflow with no admitted jobs. Node24 checkout/setup-python actions, genuine job checkout, controlled dependency egress, PR semantics, job permissions/timeouts and hosted toolchains remain missing. The agent catalog stays disabled. Existing import credentials have gained no CI authority, protected publication stays unavailable, and no source repository CI workflow or retained rollout was performed.

## Portable priorities087–091: deployed bounded consumers (2026-10-06)

Four authorized parallel streams are integrated and deployed on the frozen source above. Formatting/vet/all ordinary Go packages, generated contracts, production web build and separate maintained-engine/vendored-runner checks pass. [Final PostgreSQL/race qualification](../.tmp/priority091-final/source/postgres-race-attempt1.log) passes in 120.607s, including actual latest-schema Golf-only `pg_dump`/fresh `pg_restore`, copied control/command/credential quarantine and expiry/consent/identity/pool races. [134 controlled browser cases](../.tmp/priority091-final/browser-final-attempt1.log) pass; actual-font dark/light/mobile captures are inspected. Earlier isolated source/native checks and qualifier-launch/format failures retain their own receipts.

| Packet | Deployed supported consumer | Qualification and remaining gate |
| --- | --- | --- |
|087 — Protected observations | Exact-H official native approvals/change requests, stale/excluded observations and safe merge explanations. [Contract](PROTECTED087_CONTRACT.md). | Actual native HTTP/SSH/API and exact-head consumer proof passes with source-file hashes matched to the frozen release. Stale-review races remain reproducible; trusted candidate checks, expected-base CAS/exclusive ingress and complete P0.8 remain open. |
|088 — Managed ACP and workflow children | Owner/original-session-bound private replies, cancel, negotiated preserved live-process resume/finish and permission controls; encrypted once-only commands/native-send receipts; exact parent/job/step/H-bound private workflow children implemented in an explicit new catalog. [Contract](AGENT088_CONTRACT.md). | Deterministic real subprocess and PostgreSQL/browser checks pass. Actual startup network-none no-model qualification records approved task image `sha256:0c554c5485425bbcd8f9d7442234eb7455c9ff23008700cea513e1b905a01c85`, native 1.18.34 and resolved policy. Actual file-tool/provider inference and all-five harnesses remain unqualified; production `acp_file_tools=false` withholds Allow once. The new Actions catalog is disabled because the unchanged retained engine/runner is not its runtime proof. Broker-bound agent children are refused before approver locks; child reads bind final repository ID/owner, and resource checks follow placement→worker→pool locks. |
|089 — Everyday source/reviews/attachments | Append exact encrypted saved inline drafts to own native pending reviews; durable 256-KiB aggregate multi-file create/update/delete/rename; current discussion association and mediated verified bytes; durable bounded PR/issue body/comment multipart uploads. [Contract](FORGE089_CONTRACT.md). | [Fresh full-scope native proof](../.tmp/forge089-native091-final-attempt1/manifest.json) binds the exact frozen revision and all listed handler/proto/migration hashes; original replay/inspection, native one-parent source readback, uploads/download SHA and stale refusal pass. Actual served batch two-file/replay/readback and PR-body/comment upload/replay/inspection/download pass. Native atomic HEAD/attachment-version CAS, ranged/apply suggestions, full external threads and per-line blame remain open. |
|090–091 — Verified email recovery | Explicit current-password/MFA enrollment for current verified login email; generic public request, encrypted one-time email code and password reset; fixed throttles, expiry/guess limits, original consent/version fencing and browser/API/MFA-challenge revocation. [Contract](PASSWORD_RECOVERY090_CONTRACT.md). | Real PostgreSQL and full-App browser tests pass. Actual served default-disabled enrollment, generic unknown/unenrolled response, invalid-code refusal and current-session preservation pass. Retained SMTP/inbox recovery delivery is not qualified; a real configured email worker must deliver. Actual authenticated GitHub selected public import/default HEAD/replay/revocation passes with exact source hashes, without upstream writes; explicitly selected private GitHub/GitLab fidelity remains unqualified. |

Actual served checks also repeat provider inventory, package namespace privacy, generic publish/replay/download, wiki creation, pending create/replay/discard, MFA/one-time factor recovery, prior PAT/API revocation and same-cookie persistence across core restart. The owned native actor/repositories are purged and its Golf account disabled; immutable Golf history remains. The initial public browser harness had a port typo and ESM config placement error before tests; corrected source and final 134 checks pass. Formatting caught one native attachment nil-inventory helper; the formatted frozen source is fully retested, including native uploads. The old upload launcher’s narrower scope text is retained as historical; the fresh frozen proof records actual upload coverage.

Cutover builds/pins small images before stopping managed writers, verifies an AES-256-GCM Golf backup with a separate private key, preserves retained account/session/connection/grant/history hashes, rebinds the unchanged runner and checks served bytes/all three running Golf binaries plus startup-bound worker heartbeat. [Unchanged Compose/Docker deployment profiles and actual current resource settings](../.tmp/priority091-final/resource-and-agent-profile.json) are recorded. Post-cutover failure quarantines managed traffic instead of unsafe old-code replay. No new Docker service/capacity, provider inference, execution job, upstream provider write, Cloudflare resource or repository CI workflow is attributed to this batch. Credential-free startup sandbox probes retain their separate no-model scope. Latest-schema Golf-only recovery is distinct from coordinated native/Golf/RustFS restore.

Remaining release work: complete protected publication and every ingress, actual file-tool/provider/all-five runtime acceptance, enabled matching workflow-agent engine/runner, explicit private migration fidelity, unchanged upstream CI checkout/remote actions/dependencies, full delivery/Settings, CD, canonical recovery, Kubernetes and Cloudflare. This rollout does not establish full GitHub/forge parity or either complete infrastructure track.

## Portable priorities083–086: deployed bounded consumers (2026-10-06)

The four parallel streams are integrated and locally deployed on frozen `8a477978b709a428d952723da2a57cb161d8c0a0` above. All Go packages, vet, generated contracts and web build pass. Integrated PostgreSQL/race qualification passes in101.817s, including an actual owned host `pg_dump`/fresh `pg_restore` and quarantine. Final controlled full-App/review/forge/release browser qualification passes119 cases; dark/light/mobile captures are inspected. The [source and deployment aggregate](../.tmp/priority086-final/manifest.json) preserves each native/source/browser boundary and earlier failures. The [prior full-App QA](../.tmp/priority086-qa/manifest.json) caught StrictMode activation and recursive private-cache masking defects, corrected before this rollout.

Actual served checks pass provider inventory, private-repository/public-package-namespace refusal, generic publish/replay/download, wiki creation and pending create/replay/discard. They also repeat password MFA, one-time recovery, preexisting PAT/API revocation and session persistence after a backend restart. The first served qualifiers sent an incorrect download field and wiki service name; both purge their owned actors and disable their Golf accounts, and the fresh corrected third attempt passes. Native and immutable Golf histories retain their original scope; no uncertain operation is resent or adopted.

Cutover drains managed writers, verifies an AES-256-GCM Golf backup with a separate private key, preserves retained accounts/sessions/connections/grants/history, rebinds the unchanged runner and verifies served asset bytes/all three running Golf binaries and startup-bound worker heartbeat. Other containers, deployed environment and resource limits remain unchanged. Post-cutover failure quarantines managed traffic rather than rolling back to code that cannot interpret new operation barriers. The exact owned stopped image pin is removed; zero owned host test schemas/restore databases remain and the owned test PostgreSQL server is stopped. No new Docker service, execution/model call or Cloudflare resource is attributed to this batch. Full-stack restore remains unqualified.

| Packet | Implemented supported consumer | Qualification and remaining boundary |
| --- | --- | --- |
|083 — Policy dispatch and restored authority | The shared native boundary fences an exact repository while a foreign rule operation is RESERVED/DISPATCH_UNKNOWN, even when another consumer carries its own valid permit. Original rule dispatch binds exact row/actor/method/path/payload; inspection/replay never resend or clear uncertainty. Restore quarantine resets copied MFA challenges/factors/recovery state, revokes copied Golf provider-connection authority and agent authentication, fences leases/tasks/reviewers and cancels pending outbound work with uncertainty preserved. | [Dispatch contract](PROTECTION_DISPATCH_FENCE.md), [actual owned native proof](../.tmp/priority083-native-attempt5/manifest.json), [recovery contract](RECOVERY.md#what-is-captured). [Host dump/fresh-restore proof](../.tmp/priority083-source/host-restore-attempt2.log) covers exact Golf schema restoration and quarantine, not native volumes, RustFS, canonical Compose, external effects or full latest-schema recovery. Independent native ingress and protected publication remain open. |
|084 — Review authoring | Complete selected native pending create/update/submit/discard; exact encrypted saved-inline transfer without consuming the Golf draft; pending/published inline edit/delete; verified Golf reply parent IDs, copyable suggestions and recipient-scoped pending versus shared published live invalidations. | [Review contract](REVIEW_AUTHORING_CONTRACT.md), [actual native proof](../.tmp/review084-native-final-source/manifest.json). Empty native PENDING summaries are withheld after pinned 422 behavior; empty approvals are supported. Pending append/rebase, multiline/ranged/apply suggestions, external thread ancestry/resolution, wider role matrices and protected eligible approvals remain open. Current native revisions, visible parents and unknown no-resend remain mandatory. |
|085 — Agent review and ACP transport | Enabled persona mentions by the current sponsor/PR author retain exact comment identity/author/body digest, with revalidation before admission, lease/observation and publication. Running OpenCode completed messages/usage enter the encrypted private journal under existing screening/authority. Executable ACP-v1 initialization, sequential prompt/reply, cancellation, one-time permission and negotiated resume transport is implemented. | [Agent workflow contract](AGENT_WORKFLOWS085_CONTRACT.md). Installed OpenCode 2.0.16 no-model initialization/session proof does not qualify the pinned Docker 1.18.34 managed worker/browser. No managed interactive controls, in-flight steer, unrestricted tools, preserved-workspace/auth recovery or ordinary embedded-agent workflow action is enabled by this adapter. Historical mentions lacking the new original receipt are refused; edited/deleted/changed-author comments cannot authorize publication. |
|086 — Provider imports and portable forge | Personal encrypted GitHub/GitLab.com token connections support exact selected project preview/import, producing a forced-private own-account nonmirror destination with native ID/default-branch HEAD readback. Fresh personal-owner generic publication/link/readback supports one file up to 256 KiB; mediated downloads are bounded at 10 MiB. Ordinary `repo.wiki` writers and safe canonical relative navigation/sidebar/footer reads are exposed. Accepted mirror originals can report a later timestamp and observed public default-branch HEAD equality. | [Forge contract](contracts/PORTABLE_FORGE086.md), [actual native proof](../.tmp/native086-final-source/manifest.json). Provider/private authorization fixtures and actual public cloning do not prove private all-ref/history/LFS/metadata/identity/policy/CI fidelity. Packages follow native owner-namespace privacy; private repositories require a private personal namespace and explicit native `write:package` authority. New OAuth consent requests it; existing credentials are unchanged and no scope proof is implied. Other registries/org publication/replacement/large streaming remain open. Mirror observation establishes no sole causation, remote-wide equality or private/arbitrary upstream completion. |

These consumers reuse the existing Go/PostgreSQL/keyring/native API/shared UI/live-event boundaries. No Cloudflare service, extra Docker capacity, paid model call or new execution job is attributed to this batch. Controlled full-App screens and actual served API tests retain their separate scopes. Unknown originals and earlier failed qualifiers retain their own histories; no automatic adoption/resend or mock success closes a gap.

Next acceptance remains full protected writes, wider review/source and provider fidelity, unchanged upstream CI, managed interactive/all-five agents and embedded workflow agent steps, CD, latest-schema coordinated recovery, Kubernetes and the Cloudflare track. See [the next packets](LOCAL_COMPLETION_NEXT.md); this rollout does not close those release gates.

## Portable priorities077–082: deployed bounded consumers (2026-10-05)

The parallel batch is integrated and deployed on the frozen source above; later documentation commits do not imply another product rollout. New consumers are organization-team reviewer requests, advisory CODEOWNERS observations, inline replies/resolve/reopen and single published-review dismissal/current-head restoration; journaled wiki authoring, organization label administration, package/file metadata and mirror controls; local TOTP/recovery, targeted administrator/operator factor recovery and YAML issue forms; exact-repository source writes and bounded Actions/own-agent inspection through CLI/MCP. The [plan](../GOLF_IMPLEMENTATION_PLAN.md) and [next work](LOCAL_COMPLETION_NEXT.md) identify their explicit remaining contracts.

All Go packages, vet, generated-contract checks and web build pass. The combined controlled browser run passes168 cases; the final identity/admin/review/full-route run passes39. Owned actual-native proofs cover review/team/comment lifecycle, wiki/labels/packages/mirrors, machine original/replay/revocation, local password-factor/restart/recovery and YAML publication. Admin recovery additionally runs real read-only console inspection and console reset subprocesses on isolated host schemas. These checks do not imply new model/workflow execution or complete Settings readiness. Failed qualifiers retain separate receipts and unknown originals were not resent/adopted.

MFA changes revoke existing password/native-token Golf browser sessions and fence their dependent API grants, while independent OAuth/native Git/API grants remain separately authorized. Recovery disclosure uses ephemeral UI state outside the revoked workspace. Console recovery is an explicitly drained operator procedure, not a password-reset bypass. Global admins cannot browser-reset themselves or another protected administrator.

The final combined PostgreSQL/race check passes in88.622s; native local-factor and real admin console checks are repeated after integration. Served runtime proves email/password challenge, one-time recovery, refusal of password-only access, revocation of preexisting PAT-backed Golf sessions/dependent API tokens, session persistence after a core restart, factor disable and logout. The owned native actor/repository is purged and its Golf account is explicitly disabled through the supported operator command; its immutable Golf audit remains. Browser captures are controlled full-app fixtures rather than native served UI qualification.

The cutover drains managed writers, takes and verifies an AES-256-GCM Golf backup with a separate owner-private key, preserves retained account/session/connection/grant/history hashes, rebinds the unchanged runner to the new core, checks all three running Golf binaries and served asset bytes, and verifies an actual agent-worker heartbeat after StartedAt. Environment/resources and other containers remain unchanged. Rollback to pre-MFA code is refused once any factor is enabled; failure then quarantines managed traffic. No new execution job, model call, Cloudflare resource, capacity increase or heavy-execution reserve reduction occurs. The exact owned stopped image pin is removed; zero owned host test schemas remain and that PostgreSQL test server is stopped.

Protected every-ingress enforcement, atomic native mutation fencing/qualified equivalent, full approval eligibility, pending review lifecycle, suggestions, package publication/download mediation, native projects, connected private migration, full notification/identity policy, all-five/interactive agents, unchanged upstream CI, CD, latest-schema coordinated recovery, Kubernetes and Cloudflare remain acceptance work. No full parity/phase-ready claim follows.

## Portable completion076: four parallel streams (2026-10-05)

Current localhost runs clean frozen `fffb28ad9794035ffb7c6b34d9dac3b7b3e3a29f` at schema076. Core/web image is `sha256:2202ed01e7dfbf87c68b2ccacf5789a9e44e3181e44913c34c8ed96404318002`; dedicated agent-worker image is `sha256:5c42ba782424ff76efefcf8fc8c1ee1be244b44b2ef4d2e7d10096aaf618a55b`. Runner image and the maintained engine bytes remain unchanged. Subsequent documentation commits do not imply another product rollout.

[Final evidence](../.tmp/portable-completion076-final/manifest.json), [deployment](../.tmp/portable-completion076-runtime-attempt1/receipt.json), [independent running verification](../.tmp/portable-completion076-running-verification/manifest.json) and [actual served checks](../.tmp/portable-completion076-served-attempt1/manifest.json) pass. The cutover drained managed workers, retained an owner-private Golf database backup whose credential payloads remain encrypted and preserved account/session/API-credential/connection/grant/history hashes. Genuine direct-TLS managed READ Git remains available at `https://127.0.0.1:8443`. Independent verification binds all three Golf binaries, all served assets, schema076, a worker heartbeat after its StartedAt and zero queued executions. Other containers and deployed environment/resource configurations remain unchanged. No Cloudflare integration, Docker capacity increase, reserve reduction or model execution is attributed to this batch. The owned stopped image pin is removed; shared host PostgreSQL test schemas are cleaned and that owned test server is stopped.

| Stream | Implemented and qualified bounded consumer | Remaining boundary |
| --- | --- | --- |
| Repository/PR | Ordinary code writers can create/edit/delete/upload individual web files on an explicitly observed unprotected branch, without administrator-only protection-list access. Individual PR reviewer requests/removal use exact pull-unit/author authority and an immutable journal. Actual native writer/reviewer proofs and source UI pass. | 256-KiB files; no atomic native HEAD CAS; broader ref writers, protected integration, teams/CODEOWNERS, thread replies/resolution and suggestions remain open. |
| Everyday collaboration | Own issue/comment reactions, subscriptions, native activity, issue/PR notification inbox and journaled mark-read; immutable Markdown template chooser; inherited organization-label inventory/selection. Actual native owner/reader, notification205, reaction DELETE204, template and inherited-label effects pass. Successful engagement controls permit the next toggle without a dismissal step; unresolved/corrupt intents stay blocked. | Organization label CRUD, YAML forms/attachments, richer unified/cross-repository activity, global unread counts, broader notification types/preferences and Golf collaboration email fanout remain open. New OAuth consent requests notification scope; retained narrow credentials need explicit grants/re-consent. |
| Native forge | Release edit/delete and asset upload/rename/delete, with byte receipts and original-operation inspection; public GitHub/GitLab imports, optional pull mirrors and genuine mirror configuration reads; native wiki list/read with canonical page routes and sanitized Markdown/raw views. All have actual native production-handler proofs. | Release administration-only; uploads256 KiB, downloads10 MiB; mirror sync/source edits and connected migration fidelity remain open. Wiki is latest read-only content, not an immutable history/authoring claim; empty/omitted content stays unavailable. Projects/packages remain open. |
| Agent interfaces | Explicit repository-bound `issues:write`/`pulls:write` delegation plus six typed CLI/MCP writes and33 read tools, including original review inspection and inherited-label selection. Old credentials remain read-only. Actual CLI/stdio MCP in both supported revisions passes native comment replay/revocation. | Scope does not authorize Git/source writes, merges, execution or administration. Broader machine mutations, interactive ACP/agent continuation, agent workflow steps, all-five harness execution and unchanged upstream CI remain open. |

The frozen source passes190 browser cases, TypeScript/build, Buf/sqlc generation checks, vet, selected real PostgreSQL/race consumers (90.911s) and the complete Go suite. A full Go attempt caught a timing-sensitive pre-existing runner cancellation fixture:150ms sometimes cancelled copy before the intended hash phase under load. Its test now waits for its selected phase before cancellation; five race repetitions and the final complete suite pass. Runtime runner/engine code and resource limits were not changed. Earlier failures remain separate evidence.

Native qualification caught real status differences absent from controlled HTTP fixtures: attachment rename returns201, reaction removal204, and notification mark-read205 on the native forge at the time. Each was verified with fresh owned fixtures; original unknown operations were never resent or relabeled. All owned native fixture actors/repos/orgs were purged. The smaller actual served smoke proves delegation/replay/revocation, reaction add/remove, notification/template reads, source-writer access and mirror reads; the larger source/native and controlled browser receipts retain their separate scopes.

Contracts and runnable qualifiers: [review requests](PULL_REVIEW_REQUESTS_CONTRACT.md), [collaboration](DISCUSSION_ENGAGEMENT_IMPLEMENTATION.md), [native releases/imports](NATIVE_FORGE_COMPLETION.md), [wiki reads](REPOSITORY_WIKI_CONTRACT.md), [scoped CLI/MCP](SCOPED_COLLABORATION_DELEGATION.md). Reproduce the source/native consumers using `scripts/repository-file-writer-native-proof.py` (optionally `--wiki`), `scripts/discussion-engagement-native-proof.py`, `scripts/release-management-native-source-proof.py --include-imports` and `scripts/scoped-collaboration-native-proof.py` against an isolated test database and owned native fixtures.

This supersedes071 descriptions of administrator-only web files, absent engagement/import/wiki consumers and32 read tools. Historical receipts below remain unchanged. No entire Settings section, plan phase, infrastructure track or full forge/GitHub parity becomes complete from these bounded increments.

## Portable collaboration, source changes and access control071 (2026-10-05)

| Implemented consumer | Actual evidence and boundary |
| --- | --- |
| Issue/PR metadata and queries | All six label/milestone/assignee edit-and-clear UI/API cases pass: [issue labels](../.tmp/issue-labels069-native-attempt1/manifest.json), [issue assignees](../.tmp/issue-assignees069-native-attempt1/manifest.json), [issue milestones](../.tmp/discussion-milestones069-native-attempt1/manifest.json), [PR labels](../.tmp/pull-labels069-native-attempt1/manifest.json), [PR milestones](../.tmp/pull-milestones069-native-attempt2/manifest.json), [PR assignees](../.tmp/pull-assignees069-native-attempt2/manifest.json). These effects were qualified on the first069 deployment. [Actual organization-unit proof](../.tmp/collaboration-served069-native-unit-attempt1/manifest.json) verifies issue and pull writers independently, with code-only/reader denial. Server-backed search/author/assignee/label/milestone filters and ordinary PR sort/base selection share URL state; unknown native filters cannot silently broaden results. Native query/receipt behavior is exercised again through the final071 CLI/MCP qualifier. |
| Repository labels, milestones and ordinary comments | [Final071 actual proof](../.tmp/discussion-resources071-native-attempt2/manifest.json) passes 28 native operations and 26 served actions across all eight create/edit/delete/comment kinds, six dark/light/mobile captures and exact unit permissions. Epoch-day deadlines and clearing pass. Inventories use shared DataTable and explicit New/Edit controls; ordinary comments permit their current author or the exact unit writer. Deleted/missing authors remain read-only; review/timeline comments are excluded. |
| Branches and tags | [Actual071 API/browser proof](../.tmp/ref-mutations071-native-attempt1/manifest.json) passes create/delete, slash/Unicode/literal-percent refs, original-operation inspection without resend and published-tag deletion refusal. Served admission now recovers after a positive parent refresh while actual denial stays masked until explicit refresh. Ordinary repository-administrator scope; default branches, configured protections and published release tags remain fenced. |
| Web files and binary upload | [Actual071 API/browser proof](../.tmp/file-mutations071-native-attempt2/manifest.json) passes create/edit/delete/upload, exact native one-parent commits and byte/blob readback, stale HEAD/blob refusal, protected administrator refusal and actual dark1440/light390 controls. Unicode/literal-percent paths render through supported `GetContents`. Files are capped at256 KiB; text editing requires UTF-8. Native writer protection-list reads actually return403, so this slice remains administrator-only on unprotected repositories. It does not claim native atomic expected-HEAD CAS, rename/batch editing or blame. |
| Golf user suspension and restore | [Actual071 proof](../.tmp/golf-user-access-native-attempt4/manifest.json) and [qualification](../.tmp/golf-user-access-native-attempt4/qualification/manifest.json) pass two local sessions, token sessions, delegated API and genuine TLS managed Git read revocation; old credentials remain revoked after restore, while fresh logins work. Password confirmation, immutable identity/version, original receipt/rebind refusal and explicit rejected-password marker pass. Source PostgreSQL checks additionally cover provider OAuth refresh/background email/webhook boundaries and last-active-admin protection. Actual provider OAuth and independent native web/API/SSH suspension are not claimed. |
| CLI and MCP | [Final native SDK log](../.tmp/local-parity071-mcp-native-attempt1.log) passes all32 tools under modern and legacy protocol revisions, exact read receipts, CLI filters, pagination, scopes, foreign-account denial, four-call admission, cancellation/SIGTERM, API credentials, revocation/source logout and owned-session cleanup. Eight new read tools cover tags/releases/labels/milestones/assignees and PR commits/checks. This does not add delegated mutation tools. |

The full ordinary Go suite passes (`go test -p 1 ./... -count=1`), along with canonical API lint/generation, typecheck and vet. Source PostgreSQL race tests pass for ref, file, resource and suspension journals; affected browser suites pass140 collaboration and131 file/ref cases, followed by25 final focused ref/file cases. Actual served screenshots above were visually inspected. Each qualifier purges its own native fixtures and logs out its own sessions; retained user settings and agent policies were not overridden.

Failures remain visible. The first071 deployment had an incorrectly supplied main/dirty build stamp and is explicitly superseded; the clean frozen rebuild then encountered native `no space left on device` before readiness, and its attempted rollback could not resolve an overwritten unreferenced image digest. [Owned cache cleanup](../.tmp/local-parity071-owned-cache-closure-cleanup/manifest.json) reclaimed1.346 GB only from exact private descendants of proven Golf cache roots, retaining current core/original worker-base images. Final attempt3 passes after native recovery and a uniquely tagged/pinned worker rebuild. Ref attempts on069 exposed the real initial-admission UI bug; resource attempt1 assumed an omitted empty protobuf field; file attempt1 used a nonexistent helper RPC. Their corrected fresh proofs do not relabel those failures. An earlier concurrent full Go run hit the runner's150ms fixture deadline; its isolated and final serialized runs pass without weakening the deadline.

Schema067 tables are now present through additive migration, but static previews remain unqualified and unavailable. Current runtime includes trusted Git preparation/job-credential source code, but its advertisement, assignment and actual checkout/engine consumer remain unqualified. Full upstream CI, protected integration, a growing Codex journal, all five interactive harnesses, release asset writes, complete delivery/Settings and latest-schema recovery still need their own acceptance. No whole phase, full GitHub/forge parity, Kubernetes release or Cloudflare track is marked complete.

## Issue assignees: earlier066 deployment (2026-10-05)

Backend `4442ca6`/`0fe34ba` adds native-admin issue assignee replacement/removal/clear. The wrapper binds independent expected IDs and selected exact ID/login pairs, numerically sorted canonical int64 sets capped at100. Native candidate inventory is unpaginated and bounded to1000; overflow refuses rather than pretending completeness. Candidate discovery does not prove assignability: each retained/new selection requires the separate native204 check. Missing former candidates can be removed. Even equal-ID/no-op input must pass current identity/eligibility/admin checks before being classified unchanged. One PATCH sends explicit non-null `assignees: []` for clear and native content_version; exact issue receipt and independent ID-set readback gate success. Uncertain effects retain the original key without replay. There is no native atomic target/set CAS.

UI `3ab90e6` reuses the shared sidebar pencil, compact inline TanStack editor, bounded global scroll and loaded-candidate search. The original issue/expectation/UUID and selected login pairs freeze once. Unknown metadata, capability loss, issue replacement, cancellation, logout and late results retain existing privacy/recovery boundaries. The [UI receipt](../.tmp/issue-assignees-source-proof/manifest.json) records19 focused and132 full issue/PR browser cases, typecheck/build and file hashes; failed fixture attempts are preserved. The [backend receipt](../.tmp/issue-assignees-backend-receipt/manifest.json) binds16 top-level/60 real PostgreSQL/race cases plus the final5 top-level/36 fence cases, generated reproducibility/vet and owned cleanup. Independent read-only review found and verified the corrected no-op gap, with no further bounded source blocker.

[Actual native attempt2](../.tmp/issue-assignees-native-attempt2/manifest.json) passes add/replace/clear, exact supported native readback, unchanged title/body/state/labels/milestone, owner/write/read/outsider checks, stale expectations and identity mismatch. Dark1440/light390 captures are visually inspected. Native collaborator removal did not leave a retained nonassignable assignee in this fixture; that particular removal scenario remains source-qualified, not actual-native qualified. Attempt1's qualifier failed on native `assignees: null` after successful API clear, with cleanup preserved. Helper `1637179` normalizes that documented empty observation without changing product validation; [pure correction evidence](../.tmp/issue-assignees-nullable-native-source-proof/manifest.json) preserves the failure. All owned native users/repositories and sessions are removed through supported interfaces.

[Actual labels](../.tmp/issue-labels-assignees-regression-attempt1/manifest.json), [milestones](../.tmp/issue-milestones-assignees-regression-attempt1/manifest.json) and [recorded activity](../.tmp/agent-activity066-served-attempt6/manifest.json) pass on this same image. Activity remains an empty retained journal, not a growing Codex run. The [deployment receipt](../.tmp/issue-assignees066-runtime-attempt1/receipt.json) binds frozen source `b7d31f2d088bc20d42ed2b0cfdfc475f92cd3538`, core image `sha256:99630ef46b63ce2ac0975e1c2a7de4c8b77957742903ccaf5f1dfac235e9cddc` and server SHA `f39c9ed69cf5e8ed0b713b480e8ca7f0a2118a6efd587eb0a8e1e36184ce85f3`. Canonical API generation retains066 without preview067. Schema/engine/authentication/connection/history hashes and original runner image/environment are preserved; runner networking is rebound. Agent worker and all other containers are unchanged. Shared gzip guard `9c6063c` is also included; its source Go-transport checks are not a new live native-Git checkout proof.

At that066 checkpoint broader issue-unit writers, administration, PR metadata and queries remained open; the071 evidence above supersedes those gaps. Organization-level labels and the wider discussion lifecycle remain open. No full Settings section, phase or infrastructure track becomes Ready from these increments. Current deployment supersedes the earlier identities below without relabeling historical receipts.

## Labels and agent monetary limits: earlier deployment (2026-10-05)

Backend `59ca2b5` and UI `8140c1e`/`ea1cd5d`/`63065c7` add repository label inventory and one-field issue label replacement/clear through the existing durable intent contract. Compact inline checkbox editing uses the shared sidebar/pencil and TanStack Form. Writes freeze the original issue identity, UUID and independent expected label set; selected IDs bind to the current native repository and exact postflight issue/label readback. Lost/ignored responses stay uncertain with original-key inspection only. Native owners/admins are admitted; inherited organization labels and broader issue-unit writers remain unsupported. Exclusive-label conflicts and unsafe new numeric IDs refuse before native dispatch. Current metadata loss or issue replacement removes editing readiness; keyboard focus and both themes are exercised. Native observations are not atomic native CAS.

The [backend receipt](../.tmp/issue-labels-backend-receipt/manifest.json) records22 real PostgreSQL/race cases (76 with subcases), separate read-only API-scope regressions and generated checks. The [final UI receipt](../.tmp/issue-labels-ui-proof/complete-manifest.json) binds113 full issue/PR cases,23 focused review cases, typecheck/build and file hashes; earlier failed attempts remain preserved. The [actual label qualification](../.tmp/issue-labels066-served-attempt1/manifest.json) and [milestone regression](../.tmp/issue-milestone-labels066-regression-attempt1/manifest.json) passed against the native forge at the time: exact change/clear, owner/writer/reader/outsider matrix, independent stale-set refusal and untouched other issue fields. Dark1440/light390 captures are visually inspected; owned users/repositories/sessions are removed through supported interfaces.

Agent limit correction `ddf658c` rejects unsupported positive monetary caps at Save/Preview/Create and before worker credential/source/executor access. Existing positive ancestor or personal caps stay restrictive and block execution; an explicit lower zero cannot erase them. Zero means no Golf monetary cap for supported subscription execution, not a hard zero-dollar guarantee. API-billed execution remains unavailable. Runtime/concurrency and reactive reported-token thresholds retain their existing limits. [Source proof](../.tmp/agent-spend-source-proof/manifest.json) passes11 real PostgreSQL/race cases and browser checks. [Actual authenticated refusal](../.tmp/agent-spend066-served-attempt1/manifest.json) passes Save/Preview/Create with unchanged policy/revision, no provider calls and owned logout. Worker queued-legacy-cap handling is source-tested; this test did not fabricate a provider run or old queue entry.

The [deployment receipt](../.tmp/issue-labels066-runtime-attempt1/receipt.json) binds frozen source `4e92a5e309a5bc0d7641b37fc8009faa3e50921d`, core and agent-worker image `sha256:8e297500025ae13a2579abf463b875e843111d70cfa2de72daba08e997a742c1`, and both Golf binaries SHA `245275ebd25d86ed37e7a7ff8fce507e19b785b36eabeeddbe5c881ed3d75442`. Schema066, corrected639 engine, account/session/connection/grant/history hashes, original runner image/environment and agent-worker environment remain unchanged; runner networking is rebound. Other containers are unchanged. This supersedes earlier current-local identities without relabeling their receipts.

[Served recorded-activity recheck](../.tmp/agent-activity066-served-attempt5/manifest.json) passes four theme/size captures with owned logout on this image. All14 retained own journals remain empty. Current saved instance/personal model/trigger policies deny a manual Codex task; they were not silently changed for qualification. A real growing Codex journal and interactive ACP remain separate gates. No entire Settings section, phase or infrastructure track becomes Ready from these slices.

## Issue milestone editing and recorded activity: earlier deployment (2026-10-05)

Backend `974685a` adds current-authorized native milestone inventory and issue assignment/change/clear. UI `0b9ff7c` reuses the shared sidebar, pencil action and TanStack mutation form; `cffa2ac` settles captures. Writes freeze the original independent milestone ID and UUID, bind the selected milestone to the native repository and require exact readback. Lost/ignored/wrong responses remain uncertain and inspect the original intent without automatic replay. Existing fingerprints and schema066 remain unchanged. This slice admits native repository owners/admins only; code writers and issue authors do not acquire issue-unit administrator authority. Native observations are not atomic compare-and-swap. Broader writer permissions and PR metadata remain open.

The [backend receipt](../.tmp/issue-milestone-backend-receipt/manifest.json) records real PostgreSQL/race, API scopes and generated checks. The [UI receipt](../.tmp/issue-milestone-ui-proof/final-manifest.json) records100 issue/PR cases and3 subsequent capture/recovery cases, typecheck/build and file hashes; the first pagination expectation failure is preserved. The [actual native served test](../.tmp/issue-milestone066-served-attempt1/manifest.json) used the native forge at the time and owned owner/writer/reader/outsider fixtures: owner change/clear, denied writer/reader, masked outsider and stale expected-ID refusal pass. Independent native reads preserve title/body/state. Actual dark1440/light390 captures are visually inspected. All owned sessions are logged out and users/repositories purged through supported interfaces.

Recorded activity `e06faf2` automatically drains the bounded journal without More. Authority masking, pause/resume, attempt binding and running refresh remain; interactive ACP is not added. The [source receipt](../.tmp/agent-activity-auto-source-proof/manifest.json) records36 activity cases plus the cancellation regression. Fourteen retained own tasks have empty journals, so neither this deployment nor those observations establish a real growing Codex conversation.

The [deployment receipt](../.tmp/issue-milestone066-runtime-attempt1/receipt.json) binds frozen source `78073800d9df1ae85ce7bcac3805d244891c76b2`, core `sha256:d38af3421d56ee9acff88362527adaf7facaec2105ac17921f602620954e3bb7` and server SHA `72b4c9af53444e799d430ebbf0edf87a1a39186ecc3df93c6e8033762400088e`. Schema066, engine SHA `a55cb5d79a914cce8d69b3e7b8f43b0ed9076717ea0e9bcaf67d47aa9f9ad9d3`, accounts/sessions/connections/history and original runner image/environment remain unchanged; runner networking is rebound and other containers are unchanged. This section supersedes older current-local identities below without relabeling historical receipts.

Worker composition `85e7db5` joins fixed TLS preparation, bounded native sandbox, original archive manifest and final current-attempt source checks under one deadline. It is not activated. Actual engine attempt1 stopped before Docker mutations on a qualifier OCI identity assumption; corrected qualifier `89461dd` validates cached index/platform/config/compressed-layer/diff-ID linkage. [Attempt2](../.tmp/actions-git-source-actual-attempt2/manifest.json) stops at1,330,460KiB available versus2,097,152KiB required; only its removed read-only capacity probe ran. No registry, preparation/job container or upstream CI run was created. Checkout credentials/origin, remote actions, dependency egress, job workspace disk limits and unchanged Requests remain gates.

## Native discussion metadata: earlier deployment (2026-10-05)

Source `7fa58fe` validates real labels, assignees and milestones with independent known/absent flags, exact bigint counts, safe colors/text and current repository read checks. Shared UI `e30f2fa` renders compact sidebars; `ed1f225` adds loaded updated-time sorting and issue comment-count sorting. Milestone fix `b4877a0` preserves UTC calendar deadlines: the reproduced New York November30 regression now shows December1 with unchanged native datetime.

The [source receipt](../.tmp/discussion-metadata-final-proof/manifest.json) binds native1.27.3 reads, real PostgreSQL RPC/boundary checks and UI evidence. The first PostgreSQL fixture exhausted its test tmpfs; later passing receipts use explicitly smaller test WAL limits and retain that failure. The [metadata backend deployment](../.tmp/discussion066-runtime-attempt1/receipt.json) and [calendar frontend deployment](../.tmp/milestone-date066-runtime-attempt1/receipt.json) pass served asset/binary hashes, schema066, retained accounts/sessions/connections/history, original runner image/environment rebinding and unchanged other containers. Historical frontend is `40f868dbc8837b33a80484ac2aed38c2f85714b5`, core `sha256:e2940a3fe0863debabcf0f169714e06d404ede7ddb5751bcd9eb809646233d23`; backend remains `b29c2fa`, binary SHA `a7ce7409c578cc412414c20318b83c40d90ee0ed76dbad49909caf6c70765bc9`.

The [actual served native fixture](../.tmp/discussion066-served-attempt2/manifest.json) and [four browser captures](../.tmp/discussion066-served-attempt2/browser/browser-manifest.json) pass labels, assignees, exact milestone counts/calendar dates, issue/PR list controls, dark1440/light390, fonts and no overflow. Root inspects rendered captures. The owned session logs out and disposable native user/repository is purged through supported APIs. [Existing PR disclosure](../.tmp/discussion066-pr-served-attempt1/browser/manifest.json) and [actual Actions terminal recheck](../.tmp/discussion066-xterm-served-attempt1/browser/manifest.json) pass on this same frontend: automatic historical log loading, native xterm, page-wheel handoff and320/390 widths remain working. These are read-only checks of the existing controlled run, not new upstream CI execution.

At that deployment metadata editing/inventories remained open; the later milestone slice above supersedes this status. Server query/filtering and wider timeline/comment controls remain open. No entire Settings section or phase becomes Ready from these reads.

## Job-scoped Git credentials: reviewed source progress (2026-10-05)

Source `83032fa` supplies a sealed job-only read credential for an actually started original graph job, clipped to the original lease and at most5 minutes. It carries no worker/native/session credential. Ref discovery exposes the bound repository's native ref metadata; only object fetch is exact-H/depth1/v0. Current job/attempt/source/policy/session or sponsor/approval/worker/resource/key fences remain required. No independent per-token revoke inventory, Gitv2 or pinned checkout compatibility is claimed. The [original source receipt](../.tmp/job-git-source-proof.json) records real PostgreSQL/race plus controlled native/graph fixtures, not actual worker handoff.

Independent review reproduced a separate native approver's admin-rights loss during buffering while the dispatcher and all Golf SQL/job fences remained authorized. Correction `557f8d0` repeats that approver's supported native authority read before final SQL/byte release, rejects issuer userinfo/opaque aliases and explicitly preserves the15-second ordinary-router bound. [Final source proof](../.tmp/job-git-approval-source-proof.json) retains the failing private200 regression and final14.555-second PostgreSQL/race pass, no skips and owned cleanup. Shared guard `9c6063c` also rejects transparent gzip decoding; [actual Go-transport source tests](../.tmp/git-response-encoding-source-proof/manifest.json) reproduce all four prior upload/receive advertisement/result failures and preserve plain responses. Independent read-only reviews found no further source blocker. Supported native observations still are not atomic with subsequent external permission changes.

These packets are unadvertised, unassigned and undeployed. Current localhost remains the assignee/agent-limit build above; the shared gzip guard is included, while job-scoped credential endpoints remain undeployed. Configured HTTPS PublicURL and enrolled coordination may use different origins: actual issuer reachability, job token delivery/rotation/masking, native historical-H checkout and worker/engine activation remain required, along with the unchanged Docker reserve, registry-qualified image, disk quotas/recovery, pinned remote actions, dependency egress and unchanged upstream CI. See the [transport contract](RUNNER_GIT_PREPARATION_CONTRACT.md).

## Trusted Git job handoff: source progress (2026-10-05)

Envelope/native engine consumer `b34aee2` passes its [source receipt](../.tmp/git-source-envelope-final-proof/manifest.json); explicit `ExecuteGit` staging `063776b` passes [targeted race, full runner race and vet](../.tmp/actions-git-source-staging-final-proof/manifest.json). It validates the original archive/H/workflow/resource bindings before Docker effects, transfers one fixed0444 `/golf/git-source.tar` outside execution JSON, verifies exact remote SHA/path and preserves cancellation/owned cleanup before engine startup. Legacy `Execute` refuses Git manifests. Full race attempt1 preserves the pre-existing250ms cancellation timing failure; its isolated check and full attempt2 pass. Read-only independent review finds no source-control-flow blocker.

Shared worker checker `8621bfe` removes the duplicate archive/tree validator and applies the same path/case/control checks at worker and engine boundaries. [Worker/shared race and vet](../.tmp/git-snapshot-shared-proof/manifest.json) pass with actual local SHA-1/SHA-256 fixtures; two intermediate compile failures are retained. These source packets are unadvertised, unassigned and undeployed. Actual Docker engine transfer/materialization still requires an approved registry-digest-pinned Git job image; a local OCI index or RepoDigest-shaped reference is not substituted for independently qualified registry bytes. The Actions job workspace is an existing volume, not the preparation sandbox's bounded tmpfs. Coordinator integration, original enrolled native checkout, separate job token/origin, remote actions, dependency egress and unchanged Requests CI remain required.

## Historical commit/PR disclosure deployment and Git sandbox qualification (2026-10-05)

Commit/PR cleanup `fc9a04f` passes159 source browser cases, typecheck and build ([source receipt](../.tmp/diff-ordinary-cleanup/manifest.json)). Ordinary diff engineering footers are removed; exact comparison IDs, patch size and binary/text limits remain in existing accessible disclosures. Private-draft and current-denial masking remain checked. The isolated066 frontend is now `743cf02dffbdf84f4037fe72263eaaf3ad27087c`, core `sha256:c4c03dc52c10ad7377e274dce03d4e72b67ae5f3015c2632bfac3d8d62813d41`. The [deployment receipt](../.tmp/diff-cleanup066-runtime-attempt1/receipt.json) passes exact served asset bytes, unchanged original457 backend/schema066, corrected639 engine, retained accounts/authentication/history, original runner image/environment rebinding and unchanged other containers. This supersedes previous frontend/core pins below. The [actual commit browser proof](../.tmp/diff-cleanup066-served-attempt1/browser/manifest.json) passes closed/open keyboard metadata, original native line ranges, both-theme/mobile rendering, read-only requests and owned logout; captures are visually inspected. The [actual native PR1 proof](../.tmp/diff-cleanup066-pr-served-attempt1/browser/manifest.json) also passes collapsed/open full comparison metadata and dark1440/light390 captures on the imported Flask review demo; root visually inspects the rendered page. It makes only read requests and the owned session logs out. PR mutation/privacy-denial behavior remains separately qualified by the source suite.

Trusted sandbox `69f47ad` and parent transport `e2c0c1b` now pass [actual Docker qualification](../.tmp/git-preparation-actual-final/manifest.json): a real TLS1.3 git-http-backend feeds an opaque exact-H/depth1 PACK to native Git2.54.0 in four disposable network-none containers, for SHA-1/SHA-256 root and child commits. Native strict index-pack/fsck, exact workflow/tree identity, all original regular-file fixture archive bytes/modes and whitelist metadata export pass. Observed kernel cgroups enforce256MiB/no additional swap,1 CPU and32 PIDs; inspected read-only root, uid1000, dropped capabilities, no-new-privileges,128/32-MiB tmpfs and no bind mounts/volumes precede pack transfer. All four containers are removed. The source helper also tests restrictive admitted limits, corrupt/dangling PACKs, metadata substitutions, cancellation and cleanup refusal; full internal runner race passes13.270s. Full worker race passes20 top-level cases in3.213s, including the existing TLS receipt/denial checks through the shared reader; vet passes.

Preparation remains unadvertised, outside assignments/jobs and undeployed. These are owned real-Git origins, not an actual forge/enrolled Golf-server or unchanged upstream CI. Adversarial resource-exhaustion, lost-create receipt/labeled recovery, the job metadata/materialization envelope, separate job checkout origin/token, pinned actions, restricted dependency egress and original Requests lint.yml remain required. The old host-Git loopback consumer is historical/source-only; the new intended integration uses the network-free sandbox. Failed attempts are preserved: initial framing refused native shallow packets without LF (fixed without accepting foreign/duplicate objects); image attempt1 used a stale rebuilt image pin; actual attempt2 used native archive's global PAX header instead of Golf's regular-file admitted fixture (fixture corrected, checker unchanged). The final source-bound Docker run passes27.083s. See [preparation contract](RUNNER_GIT_PREPARATION_CONTRACT.md).

## Diff line ranges: source and actual frontend deployment (2026-10-05)

Shared source `6fc5ed9` adds snapshot-bound old/new Shift-click ranges and whole-code-line highlighting in unified and split diffs. Navigation history/direct fragments use the current selection; a reused component resets its pivot for changed snapshot/text. Cross-file/side, missing context, duplicate coordinates and foreign/malformed fragments do not fabricate a range. This is display-only selection, not multiline review publication or retrieval of prior PR comparisons after a push. The [source receipt](../.tmp/pr-diff-range-review/manifest.json) binds seven files and105 passing commit/PR/private-draft/fragment cases in2.5 minutes, with build/typecheck and four final theme/size captures. Original-code range/pivot failures and the corrected test-harness import are preserved. Split selected added/deleted cell colors are checked against unselected cells, including mobile and both themes.

The isolated066 frontend release is `0c6b7a1c6ac52311595065c8da402153d5c834fd`, cherry-picking only that UI change over the prior qualified frontend. The [deployment receipt](../.tmp/diff-ranges066-runtime-attempt1/receipt.json) passes exact served asset bytes, unchanged backend/engine/schema/authentication, backup, original runner image/environment rebinding and unchanged other containers. Current core image is `sha256:be495d27abbcf98c2f36669a88d33c22c89ece38d0adc558e888367cd4b00a91`; backend remains original457/schema066 and corrected engine639. This supersedes earlier frontend/core identities below; trusted Git worker/server preparation and067 remain undeployed.

The [actual commit browser proof](../.tmp/diff-ranges066-served-attempt3/manifest.json) and [observations](../.tmp/diff-ranges066-served-attempt3/browser/manifest.json) pass on original native H `084a57960740894ad743177faafcf3cc5326900a`: actual consecutive new-side lines2–3 produce a shareable range, two whole selected rows/cells, a distinct split background and no mobile document overflow. Dark1440/light390 captures are visually inspected; only read RPCs occur and the owned session logs out. Native old-side/PR behavior remains source-fixture qualification rather than a new native PR write. Browser attempts1/2 remain failed because the helper assumed the native patch began at line1; attempt3 derives its coordinates from the actual patch, without a product change or relabeling the earlier failures.

## Trusted Git worker consumer: source verification (2026-10-05)

Worker source `2545199`, archive/tree binding `f5dc9a4`/`281da40` and final timeout correction `0641832` now have a [committed-source receipt](../.tmp/runner-git-worker-preparation-final-proof/manifest.json). All 18 full runner race cases pass in2.559s without skips; vet passes. Nine scenarios run installed Git2.39.5 through actual TLS1.3 and an owned real git-http-backend, including exact H/depth/workflow, original archive/all-file mode/byte equality, malformed receipt/MIME/compression, denial/redirect/cancellation and credential-free cleanup. Independent real SHA-1/SHA-256 repositories verify the same archive/tree boundary. Controller credentials stay in the trusted broker; no source checkout/hooks/filter execution or stored fetch nonce occurs. Review found and corrected deadline/disconnect/background-maintenance and nonpositive-client-timeout edges.

This is an unmaterialized trusted-worker preparation consumer, not an enabled job checkout, actual forge-to-Golf runner proof or unchanged upstream CI. Advertisement, assignment/job metadata integration and runtime deployment remain disabled. Native Git memory/disk/CPU ceilings, filesystem/materialization safety, separate job-scoped checkout origin/token and original Requests CI remain explicit gates in the [contract](RUNNER_GIT_PREPARATION_CONTRACT.md). Current localhost remains the original066 backend and separately deployed frontend.

## Diff review progress: source and actual frontend deployment (2026-10-05)

Shared diff source `60dd445` separates Viewed progress from collapsed display state. Header and file-tree reopening keep Viewed checked; selecting the same anchor again expands a collapsed patch. Marking Viewed still collapses the patch. Commit/PR/private-draft source suites pass98 cases in2.4 minutes, with typecheck and whitespace checks. The [original-code regression](../.tmp/pr-diff-viewed-review/regression-before.log) fails the retained-Viewed assertion; the [fixed run](../.tmp/pr-diff-viewed-review/regression-after.log) passes. An earlier fixture refusal remains separate: optional native Star support now explicitly returns Unimplemented, rather than an unrelated private-authority NotFound.

The isolated066 release cherry-picks only that frontend change as `e5459995748189b1eb36fcf30f23de8db56f6947`. The [deployment](../.tmp/diff-viewed066-runtime-attempt2/receipt.json) passes exact served asset bytes, unchanged server/engine/schema/authentication, runner rebinding with its original image/environment, backup and unchanged other containers. Current core is `sha256:3cafa9aa2c25a306af2bd47c60c7638c228ff5178cbd6190ad259a5110b64681`; backend remains original457/schema066 and corrected engine639 in both core/runner. This supersedes earlier core/frontend identities below, not their original execution evidence.

The [actual served commit proof](../.tmp/diff-viewed066-served-attempt3/manifest.json) and [browser receipt](../.tmp/diff-viewed066-served-attempt3/browser/manifest.json) pass on original native H `084a57960740894ad743177faafcf3cc5326900a`, comparing exact native diff bytes and header/tree/same-anchor behavior without browser writes. Both-theme1440/390 captures have no document overflow; root inspects them and the owned session logs out. Actual PR reopening remains covered by source browser fixtures, not a new native PR mutation proof. Deployment attempt1 stopped at clean-source preflight on an untracked dependency symlink before touching retained runtime; attempt2 uses ordinary cloned dependency files. All broader readiness states remain unchanged.

## Trusted runner Git preparation: source verification (2026-10-05)

Source `9867129` adds two TLS1.3 read-only Git preparation endpoints under the original enrolled-worker/live-attempt boundary. Native repository/owner/actor/H/workflow observations bracket bounded buffering, and existing current policy/value/approval/control/placement/resource/lease fences apply before releasing bytes. Only admitted-H protocol-v0 depth1 negotiation is accepted; redirects, unsupported capabilities and writes are refused. Enrollment/attempt control credentials remain outside jobs.

The [exact source receipt](../.tmp/runner-git-source-proof/manifest.json) verifies tested file hashes match the commit. The [fresh PostgreSQL/race run](../.tmp/runner-git-source-postgres-attempt2/manifest.json) passes17 top-level cases in22.636s, including nine manual/push late-revocation scenarios, current native identity, bigint preservation, original grant expiry and browser-logout independence. Owned schemas/container cleanup passes. A separate actual installed Git2.39.5/http-backend case verifies exact H, depth1 and real file bytes. Database native/runner responses remain fixtures; this is not actual forge-to-worker end-to-end checkout. Server vet and whitespace checks pass.

The [first database attempt](../.tmp/runner-git-source-postgres-attempt1/manifest.json) remains failed: its fixture rounded the deliberate bigint repository ID before forwarding, then the database entered recovery. The fixed decoder uses UseNumber; the fresh512-MiB tmpfs/768-MiB memory database fixture records its logs, stable process and cleanup. An earlier real Git check rejected a valid depth packet without a trailing newline; the closed exact-H grammar now accepts that valid form without relaxing H/depth/capability checks. This server packet is not deployed. Current workers still use ordinary archives; separate job checkout tokens/compatible origins, pinned remote actions, dependency egress and unchanged Requests CI remain required. See [runner preparation contract](RUNNER_GIT_PREPARATION_CONTRACT.md).

## Protected preview candidate and resource preflight (2026-10-05)

Frozen runtime source `f4a55c8b4875f82fa040797bf15cba88c434b275` builds successfully with schema067 and deployment live events. The [host build receipt](../.tmp/static-preview067-host-artifact-receipt.json) binds independent Linux/arm64 core/runner/engine/proxy binaries, web assets and engine notices. Cached-base overlay images are separately pinned and their executable hashes checked: [core](../.tmp/static-preview067-core-pin-receipt.json) `8736ba` and [runner](../.tmp/static-preview067-runner-pin-receipt.json) `1d862a`. These are candidate images, not a retained-stack deployment.

The [actual PostgreSQL-profile attempt1](../.tmp/static-preview067-postgres-attempt1/manifest.json) passes exact image labels and four binary comparisons, then fails the unchanged2-GiB Docker reserve:1,968,776KiB available versus2,097,152KiB required. It stops before creating any qualification stack, database, native accounts, policies or preview listeners. No TLS, artifact, browser, reviewer, restart or RustFS runtime qualification follows. Only cache IDs proven to originate in these owned builds were reclaimed; the [prior cleanup](../.tmp/static-preview067-owned-cache-cleanup/manifest.json) and [core](../.tmp/static-preview067-core-owned-cache-cleanup-receipt.json)/[runner](../.tmp/static-preview067-runner-owned-cache-cleanup-receipt.json) receipts preserve that scope and unchanged other containers. More Docker capacity is required to proceed; no foreign resources were pruned or reserve reduced. Localhost8080 remains the separately qualified066 stack.

The actual helper now coordinates an already-open read-only browser with independent external review, activation and revocation; pure helper checks pass. Actual observed cookie attributes and a separate short-lived expiry fixture replace injected cookie assertions and an ambiguous long-case expiry. These helper changes have not yet earned a runtime PASS. A fresh [localhost console recheck](../.tmp/xterm-user-scroll-recheck-20261005/browser/manifest.json) does pass automatic16+5 pages, absent footer and outer wheel137→268→8 on the existing successful run, with three captures and owned session logout.

## Deployment live events: source verification (2026-10-05)

Source `73fa4f6` now appends repository `actions` invalidations for deployment state events and independent review decisions in their original PostgreSQL transaction. Existing repository streams revalidate deployment inventory/detail/current-access queries; no new topic, polling engine or automatic mutation is introduced. The payload contains no private receipt, decision, preview credential or artifact bytes. Current denial remains masked across later events; source snapshots and PR comparisons stay pinned.

The [source proof](../.tmp/deployment-live067-source-proof/manifest.json) records 15 real PostgreSQL/race checks passing in32.926s, including exact activity deltas, replay/refusal and review rollback. The [database receipt](../.tmp/deployment-live067-postgres-attempt2/manifest.json) binds `73fa4f6` and verified owned schema/container cleanup. The [combined browser run](../.tmp/deployment-live067-browser-attempt4.log) passes61 cases in48.5s on `d215ce1`, including three new live deployment detail/inventory/review-denial cases and existing pinned source/PR/draft/cursor regressions. Typecheck, build, server vet and whitespace checks pass.

Failed attempts remain preserved: the old live fixture returned native Star NotFound and lacked current workflow access, blocking its scenarios before the live behavior; these fixtures now explicitly represent an unavailable optional feature and positive ordinary access. A later combined attempt passed60 cases and failed one DOM identity assertion; three isolated repeats and the final sequential combined run pass, without weakening that assertion or changing source rendering. This does not prove the intermittent observation impossible. Native authorization remains httptest and artifact production a runner protocol fixture. No retained runtime image or schema was changed: localhost8080 remains066, and actual protected-preview TLS/browser/runtime qualification plus067 deployment remain required.


## Real xterm console, automatic history and neutral charcoal deploy (2026-10-05)

Golf now uses pinned xterm.js 6.0.0 with Fit 0.11.0 and Search 0.16.0 for the read-only Actions terminal: real ANSI rendering, selection, search and Follow controls. Historical pages load automatically, the technical footer is removed, and wheel scrolling passes to the page at terminal boundaries. Global dark surfaces use neutral `#090909`/`#111111` across Golf, marketing and docs; the terminal stays `#080808` in both themes. The [actual marketing/docs theme observations](../.tmp/charcoal-sites-attempt2/manifest.json) pass dark/light checks. The [fresh combined source suite](../.tmp/terminal-ux-integrated-browser-attempt1.log) passes 124 cases in 1.6 minutes; earlier terminal/consumer/small-screen receipts retain their original scope.

The [actual spacing qualification](../.tmp/xterm-spacing066-watch-attempt2/manifest.json) and [browser receipt](../.tmp/xterm-spacing066-watch-attempt2/browser/manifest.json) pass on repository 289, `golf-admin/golf-live-console-d8efa5`, exact H `084a57960740894ad743177faafcf3cc5326900a`. Controlled Docker run `9eab16af-f93f-4bd8-9c16-d69618bd6dd1` succeeds in 43 seconds; two different RUNNING output observations retain the same xterm DOM, Follow pause/resume works, and selected-step output and five captures pass. The [independent byte audit](../.tmp/xterm-spacing066-watch-attempt2/log-byte-audit.json) verifies all 21 native chunks: 21 line feeds, zero doubled line feeds. Root inspected completed 1440 and 390 views. Temporary policies are restored after terminal completion and the owned session logged out. This is actual live stdout/stderr viewing, not an interactive shell or unchanged upstream-project CI.

The earlier xterm deployment serves frontend `eb0913bdca2b4002e7f6848e95c2aa045392439f` in core `sha256:3589c832bf77c48202bedb3d2e77510cf2150a6fd892c4cdbdcb1b9106fbed94`; the [deployment receipt](../.tmp/terminal-ux066-runtime-attempt2/receipt.json) verifies served assets, retained authentication/history, unchanged foreign containers and runner rebinding. The server remains the original `457d7a3` binary at schema `202610040066`. Both core and runner retain the `63906d9`-built engine SHA `a55cb5d79a914cce8d69b3e7b8f43b0ed9076717ea0e9bcaf67d47aa9f9ad9d3`, which fixes the native extra newline. The [runner receipt](../.tmp/xterm-spacing066-runner-attempt1/receipt.json) binds image `sha256:ed952a0c0af7ff6dfc66571c7022d432f32e41b2df493027521c20e519a6b380` and unchanged original runner binary/environment. Frontend, engine and server provenance remain separate; this is not an all-service rebuild from main.

The [final served proof](../.tmp/xterm-final066-served-attempt2/manifest.json) and [three captures](../.tmp/xterm-final066-served-attempt2/browser/manifest.json) bind that `eb0913b` frontend to the completed original run. Historical cursors advance automatically from 0/16 chunks to 16/5 chunks, exposing all 21 without Load more or a footer. With the mouse inside the terminal, page scroll advances 137→268 then returns to 8; expanded 320 search has no overflow, and 1440 dark/390 light captures pass. Root inspected 1440 dark and 320 search. The owned session logs out. This is read-only inspection of the existing successful run, not a second execution proof.

Earlier attempts remain preserved. The [attempt1 correction](../.tmp/xterm-spacing066-watch-attempt1/qualification-correction.json) explicitly invalidates its qualification: the expected source was mistyped and the worker still used the old engine after a coordinator-only update. Fresh attempt2 binds actual frontend/worker identity and LF counts. Final-served browser attempt1 failed before screenshots because historical output still required Load more; UX ship attempt1 stopped before Docker on a missing test dependency/cherry-pick conflict. No failure is relabeled.

Static previews remain source-only: [nine real PostgreSQL/source cases](../.tmp/preview067-postgres-attempt3/manifest.json) pass 12.980s with native httptest and a runner protocol fixture; 41 deployment UI cases pass within the 72-case integrated source suite. The actual preview qualifier has now failed the resource preflight described above; runtime checks remain unrun. Migration `202610040067`, protected preview TLS/browser/runtime qualification and deployment are not present in this retained 066 runtime. Full Settings readiness, original upstream CI and latest-schema recovery remain open.


## Earlier styled Actions console deployment and proof (historical, 2026-10-05)

Localhost8080 now serves frontend source `054af583a2a0f9fddfbf0a97180dc5ba63266c5f` in core image `sha256:60692f11acc848ad84a1527f58bb12a39f46a8f652eb1b03d016165d308d83b2`. The server and maintained engine remain the exact original `457d7a3` binaries at schema202610040066; runner, agent and webhook image pins are unchanged. The [deployment receipt](../.tmp/live-console066-runtime-attempt5/receipt.json) verifies frontend bytes actually served, unchanged backend/engine bytes, preserved retained authentication/history and other containers. This is explicitly a frontend update, not a rebuild of all services from the new source revision.

The log pane is a charcoal terminal-style console with readable monospace text, line numbers, safe ANSI colors, search, copy/download and Follow controls. Scrolling back pauses following; successful background reads keep the same console mounted. Existing repository live events trigger currently authorized run/log reads; active output drains additional pages without a manual refresh. Every page still validates exact repository, source, attempt, job/step and increasing sequence receipts. Current denial clears private output and controls. Secret-bound output remains withheld until the existing redaction contract permits release. This is a live stdout/stderr viewer, not an interactive shell; the current protocol does not supply per-line timestamps. Rendering is bounded to2000 lines, with controls for earlier loaded history; copy/download/search cover loaded output only.

The [actual retained-stack live qualification](../.tmp/live-console066-watch-attempt2/manifest.json) passes on new private repository289, `golf-admin/golf-live-console-d8efa5`, exact source `5f62d49d245b9aeacb1c9fe1e920a0ae53bc6fa0`, workflow `.github/workflows/console.yml`. Run `42a20a80-9331-45bc-9d1d-ebb21408f71f` executes real isolated Linux source/workspace checks and succeeds in44 seconds. Its canonical route is `/golf-admin/golf-live-console-d8efa5/actions/runs/42a20a80-9331-45bc-9d1d-ebb21408f71f`. The [actual browser receipt](../.tmp/live-console066-watch-attempt2/browser/manifest.json) records two different authorized output observations while the run is still RUNNING, the same console DOM, Follow pause/resume, successful completion, actual selected-step output, and five desktop/mobile captures. Root inspected the live desktop and completed light mobile images. Temporary manual policies were restored after confirmed terminal completion and the owned managed session logged out. This controlled fixture uses the explicitly supported `sh` shell; it is not unchanged upstream-project CI. Its saved output remains inspectable; its temporary manual-dispatch authorization was not left enabled.

The first live attempt remains failed: a core-only recreation left the runner's `network_mode: service:golf` bound to the old coordinator namespace, so the run stayed queued. The [runner correction receipt](../.tmp/live-console066-runner-reconnect-attempt1/manifest.json) confirms cancellation of that owned queued run and recreation of only the runner with the same image and environment in the current coordinator namespace; all other containers are unchanged. The failed attempt's automatic cleanup raced the explicit cancellation; the separate [cleanup supplement](../.tmp/live-console066-watch-attempt1/manual-cleanup-supplement.json) verifies terminal cancellation and restoration of original policy projections. Future core recreations must also rebind namespace-sharing workers and verify actual coordinator polling before claiming runner readiness. Earlier failed frontend-deployment attempts remain separately retained.

Source verification:31 integrated console/workspace browser cases pass, as do the four updated withheld-output regressions, typecheck/build and whitespace checks. The preceding graph suite had47 passing cases and four obsolete disabled-button expectations; those four now assert the stronger boundary that withheld output exposes no download controls. This is not a fresh full GitHub Actions compatibility qualification. Original Express/Flask/Requests workflow compatibility and latest-schema recovery remain open.


## Real popular-project upstream CI remains unsupported (2026-10-04)

Express, Flask, Awesome and Spoon-Knife are real imported upstream repositories. Import/source/README and earlier agent-review evidence does **not** qualify their original CI. The [actual unchanged Express dispatch](../.tmp/upstream-express-dispatch-attempt1/manifest.json) compares the original pinned upstream YAML byte-for-byte, resolves native repository174 and workflow blob at `7ef98448f8b38099ab1ded55e458538ad47a51e7`, and returns HTTP400/failed_precondition: “Workflow is outside the selected pinned Linux Actions engine profile.” Zero runs were admitted. The temporary instance/repository manual policies were restored through supported revision-checked RPCs. This is an honest failed compatibility attempt, not a passing pipeline.

All18 researched current Express/Flask/Requests workflows are unsupported. The first unchanged upstream target is [Requests lint.yml at611c616](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/.github/workflows/lint.yml): remote pinned Node24 checkout/setup-python actions, genuine scoped Git checkout, restricted dependency egress and the original push/PR declarations must work before claiming acceptance. Linux/macOS/Windows matrices, artifacts, cache, permissions, concurrency and service containers remain separate compatibility work. Source archives alone do not supply checkout authorization or `.git` provenance.

The retained controlled Docker run `a9031ab2-9500-4254-9301-435b5a7dd080` at repository163 has two actual recorded steps and logs. Its [actual run/step/reload/mobile browser proof](../.tmp/retained-ci-visual-review-attempt3/manifest.json) passes; its canonical route is `/golf-admin/golf-local-ci-0c61aa/actions/runs/a9031ab2-9500-4254-9301-435b5a7dd080`, with `?step=0` selecting the first step. Earlier helper attempts used an obsolete query-run URL and then an incorrect assumed theme-button state; both failed attempts are retained. This completed controlled run is not a currently running job or unchanged upstream CI. The later terminal-style live-output deployment and actual running-job proof are recorded above.


## Existing-tag publication066 deploys; Actions and density update included (2026-10-04)

Retained localhost8080 runs frozen component `457d7a316a2486ab8396e5a9517e0f66ae9ef10d` at schema202610040066: core/webhook `sha256:bd730b30fb8f74113337eb73515d6a15dca39d161a54b1aef25775f4c1723631`, runner `sha256:71e18df6c4d30a5000ce19a835f7d06cf89730c341e75efe131f970eb329c222`, agent-worker `sha256:02e52db581c78664a41b73629036b537a4222b60a321994615158a66f91a9f68`. The [stopped-writer backup/deployment receipt](../.tmp/settings-release66-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-release66-running-proof/manifest.json) pass. Authentication, original session, seven agent connections, three Codex auth records, grants and116 historical issue operations are hash-identical; foreign containers are unchanged. Missing-Origin/session publication endpoints return403/401 with no-store.

[Actual lightweight attempt2](../.tmp/release-publication66-lightweight-served-attempt2/qualification/manifest.json) and [annotated attempt1](../.tmp/release-publication66-annotated-served-attempt1/qualification/manifest.json) each pass one explicit browser-confirmed publication against native1.27.3/Git2.54 and PostgreSQL18.4. Each binds exact existing tag object/peeled H, title/notes hashes, native author/ID/content, original-key replay/restart, stale revision and current reader refusals. Each has four separate actual dark/light1440/390 original-publication captures, one browser Submit, reload with no automatic original Get or resend, then one explicit original Get. Root inspects lightweight dark desktop and light mobile. [Parent cleanup](../.tmp/release-publication66-lightweight-served-attempt2/parent-manifest.json) and [annotated cleanup](../.tmp/release-publication66-annotated-served-attempt1/parent-manifest.json) pass. These publication views remain separate from the existing eight metadata-only views.

[Real PostgreSQL/race attempt3](../.tmp/release-publication66-postgres-attempt3.log) passes37.891s with no skips and exact owned cleanup: original intent, current authority, lost/malformed/readback responses, lifecycle exclusion, target/fork-source merge exclusions in both orders and simultaneous distinct actors. The61-case source-browser suite passes25.3s; [eleven integrated privacy/account cases](../.tmp/release-publication66-integrated-privacy-attempt1.log) pass6.0s. [Combined checks](../.tmp/release-publication66-main-check-attempt2.log) pass. The earlier invalid maximum-notes fixture remains preserved; its correction changes valid content within the original size limit. Lightweight attempt1 stopped at the2GiB reserve before any stack/publication and cleanup passed. Only verified HOST archives of stopped sole-owned older Golf pins and precisely owned/unshared cache records were retired; running065 remained untouched until the quiesced deployment.

The same component deploys the prior99-case source-tested Actions workflow/kind-filter preservation and visible Checks search, plus shared empty/footer density improvements. Source font-settled four-theme/size density captures and keyboard/privacy checks retain their own scope; new publication served captures independently show this component. This does not freshly requalify all Actions execution behavior.

Publication currently supports existing unprotected native tags, ordinary repository admins and one release POST. It does not add tag creation, release edit/delete, asset upload, atomic protected tag fencing, cryptographic artifact promotion, actual native accepted-response-loss qualification or latest-schema recovery. Uncertain writes remain inspectable without automatic resend. Every incomplete Settings section remains Partial. The next source-only packet is a portable qualified-artifact static-preview consumer with separate protected origins; it is not yet available. See [release contract](REPOSITORY_RELEASES_CONTRACT.md) and [next local consumers](LOCAL_COMPLETION_NEXT.md).


## Prior source proof for the Actions follow-on packet (2026-10-04)

Integrated source `9e5ab65` preserves Actions server workflow/kind filters through run/job/step/reload and return navigation, and makes loaded Checks search match displayed result labels and descriptions. The [99-case affected source-browser suite](../.tmp/actions-filter-ui-worktree/.tmp/filter-evidence/affected.log), TypeScript and [combined main checks](../.tmp/actions-checks-next-main-check-attempt1.log) pass. These source changes are included in the later457/schema066 deployment above; their source receipt is not a new actual Actions execution proof. The optional existing-tag release publication helper at `8458d96` passes pure receipt/phase/scope/hash checks, preserving default read/asset modes; Backend/UI, actual bounded publication and density now have the separate066 receipts above; recovery remains open. No incomplete Settings row becomes Ready.

## Local native squash and PR authority refresh deploy (2026-10-04)

Localhost:8080 now runs frozen component `d03feff595f9e79cf8af01952eda94bda057c778` at schema065: core/webhook `94a483566322`, runner `d4bcf9e28e47`, agent worker `250102a8c1f1`. The [stopped-writer backup/deployment](../.tmp/settings-squash65-final-retained-backup/receipt.json) and [independent running-binary/boundary verification](../.tmp/settings-squash65-final-running-proof/manifest.json) pass. All 128 accounts, the original session, seven agent connections, three Codex authentication records and retained operation history retain their exact records; foreign containers remain unchanged. [Combined checks](../.tmp/standard-squash65-final-main-check-attempt1.log), canonical generation and the final frozen host build pass. Earlier release downloads, artifact storage, Stars and maintained Actions features remain integrated.

The requested PR confirmation now offers current enabled **Create a merge commit** and **Squash and merge**, respecting the implemented native default. Optional title/message fields start empty for native defaults; bounded exact custom text is sent once and never stored in browser intent. Original method/source/head identities remain immutable. Historical ordinary merge fingerprints are unchanged, including explicit wire `merge`; new squash intents have a distinct fingerprint. Equal source/target branch names are allowed only for explicitly bound different repositories. Unknown outcomes retain original-key GET-only inspection and block replacement; protected integration and rebase remain unavailable.

[Same-repository squash attempt2](../.tmp/standard-squash65-same-served-attempt2/qualification/manifest.json) and [private fork main-to-main attempt1](../.tmp/standard-squash65-fork-served-attempt1/qualification/manifest.json) pass on the same frozen component. Each creates two supported-native source commits, performs one actual browser-confirmed squash, independently verifies exact native PR/source/H/output C/single parent/current target and custom text hashes, refuses changed-method replay, and retains original status across backend restart. Each [same-repository browser](../.tmp/standard-squash65-same-served-attempt2/qualification/browser/browser-manifest.json) / [fork browser](../.tmp/standard-squash65-fork-served-attempt1/qualification/browser/browser-manifest.json) proof has four font-settled dark/light views at 1440 and 390 pixels captures, one Submit and one explicit original Get, with no custom text in browser storage. Root inspected the dark desktop and fork mobile captures. Reader/protected and private-source denials remain separately checked. These single-parent observations do not prove atomic expected-base enforcement, content equivalence, protected publication or actual accepted-response-loss recovery.

Owned cleanup and stable foreign IDs/images/running flags pass for both [same-repository parent](../.tmp/standard-squash65-same-served-attempt2/parent-manifest.json) and [fork parent](../.tmp/standard-squash65-fork-served-attempt1/parent-manifest.json). The fork parent separately records one unrelated restarting-to-running status observation without attributing its cause. [Earlier same-repository attempt1](../.tmp/standard-squash65-same-served-attempt1/qualification/manifest.json) remains failed: its browser squash and native single-parent receipt completed, then its qualifier read the native commit message at the wrong JSON depth. Nested commit parsing is corrected at helper revision `ee88413`; compiled product/component remains d03. Its cleanup passed; no failure is relabeled.

[Real PostgreSQL/race checks](../.tmp/standard-squash65-postgres-attempt1.log) pass in 35.083s without skips, covering method immutability, legacy fingerprints, same/fork squash, same-name branches, current strategy/authority refusals and uncertain outcomes; the owned database is removed. Current PR denial now latches before cancellation and masks/disables background reads until explicit reauthorization. The [106-case serial source-browser suite](../.tmp/pull-denial-latch-worktree/.tmp/denial-evidence/browser-serial-final.log) passes in 1.1 minutes; [six integrated privacy/navigation checks](../.tmp/standard-squash65-denial-main-attempt1.log) pass in 9.9s. Earlier parallel fixture failures remain preserved: deleting another test's temporary HTML caused Vite to reload the active page. Deterministic live-reset/held-read tests establish the separate background denial fix. See [merge contract](STANDARD_PULL_MERGE_UI_CONTRACT.md). All incomplete Settings sections remain Partial; latest-schema recovery, release publication, protected previews/CD and fuller CI compatibility remain separate work.

## Local private release downloads and Actions live-history refinements deploy (2026-10-04)

Localhost8080 now runs frozen component `155f88778337bd5906697800689f226d2b96fd85` at unchanged schema064: core/webhook `304dfcd88345`, runner `1ac569a9cd07`, agent worker `34ad6f59159d`. The [stopped-writer deployment](../.tmp/settings-assets64-retained-backup/receipt.json) and [independent running-binary/boundary proof](../.tmp/settings-assets64-running-proof/manifest.json) pass. All128 accounts, the original session, seven agent connections and retained operation history remain exact; foreign containers remain unchanged. Earlier Star, artifact, release and maintained Actions isolation features remain integrated. [Combined checks](../.tmp/settings-assets64-main-check-attempt1.log) and the frozen host build pass.

Native release assets now download through an exact same-origin managed-cookie route, using current repository/release/asset identities. Golf buffers at most10MiB, verifies metadata and current authority again before sending bytes, refuses native redirects and forces private attachment/no-store/nosniff/sandbox headers. Native UUIDs and credentials stay server-side. Larger files retain metadata with an explicit limit. The [actual fresh qualification](../.tmp/repository-assets64-served-attempt1/qualification/manifest.json) passes two22-byte supported-native fixtures: independently matching owner/reader byte hashes, wrong associations, current reader revocation, origin/bearer/query/cross-site/session denials and same-core restart preservation. The [browser proof](../.tmp/repository-assets64-served-attempt1/qualification/browser/manifest.json) passes eight dark/light1440/390 captures plus one exact-hash attachment click; root inspected the desktop detail. [Owned cleanup](../.tmp/repository-assets64-served-attempt1/parent-manifest.json) and unchanged foreign identities/images/running flags pass, with no status changes observed. [Database/race checks](../.tmp/repository-release-assets-postgres-attempt1.log) pass3.061s without skips; the database is removed. All29 release source-browser cases pass10.4s. This is current attachment reading, not Golf release/asset writes, immutable publication proof or native ServeDirect/remote asset storage support. See [release contract](REPOSITORY_RELEASES_CONTRACT.md).

Actions live-history refresh now preserves loaded search/sort and unchanged-inventory pagination while keeping previous private rows masked/inert during authority checks. Denial/logout/scope changes clear the table. The32 source-browser cases pass39.8s. The fallback shell catalog also accepts one or two distinct literal `[push, workflow_dispatch]` events and executes only explicitly declared triggers; maintained catalogs already support event lists. Source race and combined checks pass; this new fallback declaration does not independently requalify automatic native push. All incomplete Settings sections remain Partial, and protected integration, fuller pipeline compatibility, release publication and protected previews/CD remain separate local work.

## Local maintained Actions isolation and graph viewer deploy (2026-10-04)

Localhost8080 now runs frozen component `557b9de45f7f97609636b967e0c861a0ff626c89` at unchanged schema064: core/webhook `5a79c360026d`, runner `ff9e235779f0`, agent worker `a4dd0e904c9d`. The [stopped-writer deployment](../.tmp/settings-twojob64-retained-backup/receipt.json) and [independent running-binary/boundary proof](../.tmp/settings-twojob64-running-proof/manifest.json) pass. All128 accounts, the original session, seven agent connections and retained operation history remain exact; foreign containers remain unchanged. The maintained engine's existing DAG scheduler now also fences each private workspace/command-file volume to one job container across the entire attempt. Shared toolcache and read-only composite sources retain their separate rules.

[Actual two-job attempt4](../.tmp/actions-twojob64-served-attempt4/manifest.json) passes one real input-free manual TLS1.3/Docker run: two dependent jobs, three steps, eleven graph events, exact native/source/archive/attempt identities, successful fresh-workspace marker exclusion, dependency timestamps and independent scoped logs. Restart/original inspection/same-key replay retain one run/attempt. Owned cleanup passes and foreign identities/images/status/running flags remain unchanged; unrelated restart lifecycle observations have no attributed cause. Corrected test input at helper revision `f21a2fd` explicitly selects the approved Alpine `sh`; the compiled component stays557. Reserve-only attempts1/2 and original missing-shell attempt3 remain failed and preserved. See [engine contract](ACTIONS_ENGINE.md#two-job-workspace-isolation-qualification-2026-10-04).

The deployed viewer also accepts valid v2 withheld/redacted secret-log receipts while retaining typed-input/binding and no-raw-output privacy guards; recorded pending/skipped captions no longer invent queue/dependency explanations. Full engine race, [combined checks](../.tmp/actions-two-job-main-check-attempt1.log) and [49 graph source-browser checks](../.tmp/actions-two-job-ui-main-attempt1.log) pass. This actual run does not qualify served graph UI, secret execution, matrix/output/cancellation or automatic push. Later source-only fixes for explicit shell event lists and preserving Actions table controls during successful refresh pass [combined checks](../.tmp/local-actions-refinements-main-check-attempt1.log) and [32 inventory browser cases](../.tmp/actions-refresh-ui-main-attempt1.log), but are not yet deployed. Incomplete Settings sections remain Partial.

## Local repository Star preferences deploy (2026-10-04)

Localhost8080 now runs frozen component `9ddc7e7213cb7b910753e682de98d8d361f6ffae` at unchanged schema064: core/webhook `1e7cd578843a`, runner `9eab6b1c7a01`, agent worker `1c27bc28a7bf`. The [stopped-writer deployment](../.tmp/settings-stars64-retained-backup/receipt.json) and [independent running-binary/boundary proof](../.tmp/settings-stars64-running-proof/manifest.json) pass. All128 accounts, the original session, seven agent connections and retained operation history remain exact; foreign containers remain unchanged. Earlier064 artifact, fork-merge and release features remain integrated.

The [actual native Star qualification](../.tmp/repository-stars64-served-attempt2/qualification/manifest.json) passes two ordinary accounts' explicit own true/false preferences, independently observed native state/counts, original-target refusals, backend restart with GET-only inspection, and current reader revocation. The [actual browser proof](../.tmp/repository-stars64-served-attempt2/qualification/browser/manifest.json) passes four theme/size captures and exactly one explicit Star request; reload and subsequent views are read-only. Root inspected the dark desktop capture. Owned cleanup and stable foreign identity/image/running flags pass. The parent wrapper retains an inherited release-scope label; its authoritative child receipts identify Star operations. Attempt1's browser failure remains preserved; attempt2 adds fixed-code diagnostics without changing the runtime component or guards.

[Fresh database checks](../.tmp/repository-stars-postgres-attempt1.log), managed-session boundary tests and source-browser checks pass. Disabled native Stars support refuses only the optional preference feature after current authority checks, preserving authorized code browsing. Uncertain results offer explicit current inspection without automatic resend; a current preference is not an original-effect receipt. This adds Star/Unstar, not watch/fork controls or complete GitHub parity. Incomplete Settings sections remain Partial. The next integrated source packet hardens private Actions volumes and v2 secret-log viewing; its actual two-job execution proof and deployment are pending.

## Local RustFS artifact storage and compact Actions refinements deploy (2026-10-04)

Localhost8080 now runs frozen component `a6f546851926e72114c87062b0aefb891a3d7410` at schema064: core/webhook `e93e63a8c421`, runner `28ac0e692194`, agent worker `b0eb334f1456`. The [stopped-writer deployment](../.tmp/settings-064-retained-backup/receipt.json) and [independent running-binary proof](../.tmp/settings-064-running-proof/manifest.json) pass. Accounts, the original session, connected agent credentials and retained operation history remain exact; foreign container identities/images/running states remain unchanged. The previous schema063 features remain integrated. [Combined checks](../.tmp/settings-064-main-check-attempt2.log), canonical schema generation and the frozen host build pass.

Artifacts inherit the original run's PostgreSQL, environment S3 address or saved connection/version; switching active storage cannot redirect old output. Conditional creation and verified reads use a separate private `ci-artifacts` namespace. Storage failure never falls back to PostgreSQL. Upload/replay rechecks the original lease after provider and retained-budget waits. The [actual database/race matrix](../.tmp/workflow-artifacts64-postgres-attempt1.log) passes35.760s, including nine upload outcomes, original profile versions, current authority and expired waits. The [native RustFS test](../.tmp/artifact-rustfs64-native-attempt1.log) passes3.581s: conditional replacement refusal, exact bytes/digest/size, namespace separation, replay and original source/artifact restart preservation.

The [fresh actual RustFS workflow](../.tmp/workflow-artifacts064-rustfs-served-attempt1/manifest.json) completes every functional stage successfully: one real TLS/Docker GitLab run, PostgreSQL source/artifact payloads absent, exact original object address, independently signed3072-byte read matching the attachment, outage503 without fallback, same RustFS/backend restart and original dispatch without another run, reader revocation, and four actual served captures. Root inspected the padded desktop artifact receipt. Its original overall result remains **incomplete**, because one foreign container's observed status changes from running to restarting; no failure is relabeled. A [separate hashed resource/lifecycle supplement](../.tmp/workflow-artifacts064-rustfs-served-attempt1/resource-lifecycle-supplement.json) verifies owned resources absent and all136 foreign IDs/images/running flags unchanged, with four preexisting automatic restart policies and increasing counters observed. Lifecycle cause is not asserted.

Actions loaded search now matches visible run-kind/status/trigger labels, and artifact details use shared padded/responsive metadata styles. Focused source-browser checks pass, and the latter also has the new actual theme/size captures. This delivers bounded object-backed attachment storage, not retention/purge, protected previews/CD, remote R2/AWS qualification, full Actions artifacts/cache, or coordinated latest-schema recovery. All incomplete Settings sections remain Partial. See [artifact contract](WORKFLOW_ARTIFACTS_CONTRACT.md) and [next local work](LOCAL_COMPLETION_NEXT.md).


## Own Star preference: bounded native and served proof (2026-10-04)

[Star attempt2](../.tmp/repository-stars64-served-attempt2/qualification/manifest.json) qualifies on frozen component `9ddc7e7213cb7b910753e682de98d8d361f6ffae`, core `1e7cd578843a`: two ordinary managed actors explicitly Star/Unstar one private native repository; independent own-state/count observations, wrong immutable-target refusals, GET-only restart inspection and current reader revocation pass. [Four actual theme/size captures](../.tmp/repository-stars64-served-attempt2/qualification/browser/manifest.json) include exactly one explicit browser Set and reload without another write; private credentials are not persisted. [Owned cleanup and foreign identities](../.tmp/repository-stars64-served-attempt2/parent-manifest.json) pass. The reused parent release-scope label is preserved; the Star-specific child manifests define this proof. Earlier [attempt1](../.tmp/repository-stars64-served-attempt1/parent-manifest.json) remains failed at its browser view with cleanup passed.

[Database/race checks](../.tmp/repository-stars-postgres-attempt1.log) pass2.844s, including optional disabled/scope refusal distinct from actual private-authority denial and lost-acknowledgement source tests. Integrated checks and24 source-browser cases pass. This is current own preference, with no journal, original-effect attribution, automatic write retry, Watch/Fork or full readiness claim. Deployment remains a separate receipt; the existing deployment block above is unchanged. See [Star contract](REPOSITORY_STARS_CONTRACT.md).

## Local fork merges, build artifacts and release browsing deploy (2026-10-04)

Localhost8080 now runs frozen component `b3f9e86c0612b469f320b79e215ea591bef79aac` at schema063. The [stopped-writer deployment](../.tmp/settings-063-final-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-063-final-running-proof/manifest.json) pass. Core/webhook is `45f259d6c50c`, runner `37a6614288d7`; the exact agent image is recorded in the running proof. All128 accounts, the original session, seven agent connections, three Codex authentication records and retained operation history remain unchanged. Other containers remain unchanged. [Combined checks](../.tmp/settings-063-final-main-check-attempt1.log) and the frozen host build pass.

Standard unprotected fork merging is now available alongside same-repository merging. Its [actual native/served proof](../.tmp/standard-fork063-served-attempt2/qualification/manifest.json) passes on the earlier `fa058e5` component: one explicitly confirmed merge binds source repository/owner/head, preserves original-key inspection without resend across restart, and refuses current private-source denial. Four served theme/size captures and fresh database checks pass. This does not implement protected merge, squash/rebase or full fork CI trust.

The [actual artifact workflow](../.tmp/workflow-artifacts063-final-served-attempt1/manifest.json) passes on the deployed component: one TLS/Docker GitLab shell job creates an exact two-file/47-byte archive; current owner/reader downloads, restart preservation, original dispatch without a second run and reader-revocation denial pass. Four served captures pass. The collector uses bounded ordinary-user tar capture from the live tmpfs, followed by pause/ownership verification. Earlier failed Docker-copy attempts remain recorded; capture is non-atomic. This is a bounded private PostgreSQL attachment, not preview/CD or full Actions artifact/cache parity. See [artifact contract](WORKFLOW_ARTIFACTS_CONTRACT.md).

[Release browsing qualification](../.tmp/repository-releases063-served-attempt1/qualification/manifest.json) passes on the same deployed component: two real published/prerelease fixtures match exact list/detail IDs, tags, notes, author and timestamps; current reader removal denies both reads. Eight served list/detail captures pass, with root visual inspection. Releases now have repository tabs, canonical URLs and breadcrumbs. Asset downloads and release writes remain unavailable; native timestamps do not prove an immutable publication snapshot. See [release contract](REPOSITORY_RELEASES_CONTRACT.md).

Each disposable stack is removed and foreign identities remain unchanged. These functional increments do not turn incomplete Settings sections Ready. [Prioritized remaining local consumers](LOCAL_COMPLETION_NEXT.md) retain object-backed artifacts, authorized release publication, protected previews/CD, complete workflow triggers/graphs and protected-writer enforcement as outstanding work.

## Local schema061 merge and SMTP controls deploy (2026-10-04)

Localhost8080 runs component source `234d471921702195734af78b8c5d3cf6471f95b1` at schema061: core/webhook `d6c9886094ae`, runner `e59181f3ad13`, agent worker `23fa927a9821`. The [stopped-writer deployment](../.tmp/settings-061-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-061-running-proof/manifest.json) pass. Retained accounts, sessions, agent authentication and operation history remain exact, and unrelated containers remain unchanged. Standard native same-repository merge and the password-confirmed exact-generation SMTP Pause control are now deployed. Protected/fork merges remain unavailable in this build; Rules and Notifications remain Partial.

The [fresh native/browser merge qualification](../.tmp/standard-merge061-served-attempt2/qualification/manifest.json) and [owned cleanup](../.tmp/standard-merge061-served-attempt2/parent-manifest.json) pass. An ordinary writer explicitly confirms one unprotected merge through Golf. Independent native reads establish the merged PR, output commit, two parents including selected H, and target branch. Original-key replay, reload, explicit status inspection and backend restart do not resend. Changed intent, reader, protected-target and fork requests refuse. Four font-settled theme/mobile captures pass. This verifies an acknowledged native merge and its bounded receipt; it does not provide atomic B/protection fencing, protected publication, every lost-acknowledgement outcome or whole-platform recovery. The first invocation stopped at the VM reserve check before creating resources and remains recorded separately.

The [standard merge PostgreSQL checks](../.tmp/standard-merge-postgres-attempt1.log) pass13.377s. The [SMTP Pause PostgreSQL checks](../.tmp/smtp-pause-postgres-attempt2.log) pass20.720s, including the actual before-DATA socket fence, generation changes, restart and no replay on reactivation. An earlier test attempted to alter an immutable account role; its failed log is retained, and the corrected fixture enrolls a separate ordinary actor. SMTP Pause cannot recall DATA already accepted by a relay. Affected source/browser and main checks pass. Compact coverage disclosures and merged-PR density changes at `45e9bca`/`a8e4f17` are source-tested and integrated but are not part of this deployed image. Build-artifact production/download and separately authorized fork merges are the next local increments; preview/CD and broader pipeline compatibility remain open.

## Local schema060 deployment and typed value execution pass (2026-10-04)

Localhost8080 runs component source `12f8003ee92ce80ccdf4f29588d3a4f25b1d1e2e` at schema060. The [stopped-writer deployment](../.tmp/settings-060-retained-backup/receipt.json) and [independent running-binary verification](../.tmp/settings-060-running-proof/manifest.json) pass. All128 accounts, the original session, seven agent connections and retained operation history remain exact; unrelated containers are unchanged. This deploys the requested exact-input approval editor, current Access inspection and condensed coverage copy. The [served settings review](../.tmp/settings-060-retained-browser-attempt1/manifest.json) passes both themes at1440/390, current Access inspection and eight settings pages, without configuration writes. The original session inventory stays unchanged. General remains Ready; the other complete sections remain Partial.

The [fresh native/Docker/TLS attempt](../.tmp/workflow-inputs060-values-attempt1/manifest.json) passes: two immutable repository value versions are approved against one exact workflow/source and canonical typed input identity. The real maintained worker receives the secret and variable, completes literal/default/number/composite steps and the approved-environment step, and publishes redacted output with no synthetic secret in readable logs. Exact binding/input identities, original-key replay/inspection after discarded accepted response body, backend restart, old/HTTP-worker exclusion and actual certificate-verified TLS1.3 all pass. Owned cleanup passes; foreign identities remain unchanged, with independently restarting foreign containers merely observed. The original helper's historical059 proof-kind label is preserved and corrected by a [scope supplement](../.tmp/workflow-inputs060-values-attempt1/scope-supplement.json); future helper output uses the060 typed-values label.

The [historical-approval PostgreSQL test](../.tmp/settings-typed-approval-historical-postgres-attempt1.log) passes against an independently inserted pre060 journal shape. It confirms that omitted new fields preserve legacy intent bytes and once-only replay. The102 affected approval/workflow source-browser cases and40 Access source-browser cases also pass. Actual browser approval submission, latest-schema whole-platform recovery, protected publication, broader pipeline conformance, deployment consumers and lifecycle completion retain separate acceptance. Local Compose delivery now has priority; Kubernetes/Cloudflare qualification is tracked independently from local functional progress.

## Actual scoped Access-core059 recovery passes (2026-10-04)

[Recovery059 attempt4](../.tmp/repository-access059-recovery-attempt4/manifest.json) passes on component source `05ab5bf`, core `8f99f647`, PostgreSQL18.4/native1.27.3 and explicit `access-core059`. Supported APIs create real personal/org grants, team membership, shared RO/RW deploy-key associations, invitation outcomes, a pending invitation and two distinct native204 response-loss originals. A real encrypted typed manual run remains queued without any worker or job execution. Supported operator activation, encrypted backup/verification and fresh stopped-target restore then pass; the canonical native URL is never replaced by a different stored forge identity.

All seven retained Access/invitation history families remain exact except the required credential-version-triggered pending expiry and one append-only expiry event. Old sessions are invalidated and issuer credential versions advance. Current reenrollment does not upgrade old invitation consent or resend uncertain effects: original direct inspection/replay stays once-only, the invitation remains uncertain, conflicting work stays blocked and stale pending acceptance refuses. Native IDs/grants/teams/shared key associations remain independently unchanged. The queued typed run is retained and cancelled without replay; its encrypted inputs authenticate under supported bounded rotation across the complete thirteen-family key inventory. Wrong/missing content keys refuse. A controlled restart preserves these outcomes. Cleanup passes with no owned resources remaining and all unrelated container identities unchanged.

This closes the scoped Access recovery criterion, including encrypted queued typed-admission retention. It does not qualify execution recovery, deployment adapters, Kubernetes/Cloudflare topology or whole-platform recovery. New schema060 typed approval source is not included in this exact059 receipt. [Attempts1–3](RECOVERY.md) remain failed and cleaned: initial key-policy bootstrap, partial OAuth configuration, then an unsupported assumption about collaborator-list permission fields. Attempt3 had actually passed both native effect-loss cases before its snapshot helper failed; it remains a failed pre-backup attempt.

## PR merge inspection deploys with retained settings regression (2026-10-04)

Localhost8080 now runs component source `05ab5bfa4639c348dbbed83b4de08be9f817ef7c` at schema059: core/webhook `8f99f647`, runner `273c49d9` and agent `71fa178b`. The [stopped-writer backup/deployment receipt](../.tmp/settings-059-merge-observation-retained-backup/receipt.json) and [independent running-binary proof](../.tmp/settings-059-merge-observation-running-proof/manifest.json) pass. All128 local accounts, original session, seven agent connections, three Codex authentication records and historical uncertain operations remain unchanged; unrelated container identities are unchanged. The runner/engine artifacts are independently rebuilt byte-identical to the preceding components.

The explicit PR **Inspect merge observations** control is available in this build. It reads exact native/source identities, branches, protection, caller authority and merge defaults; it grants no publication permit or merge execution. [Main checks](../.tmp/settings-merge-observation-main-check-attempt1.log), the packet's75 source-browser cases and [Postgres race cases](../.tmp/settings-merge-observation-postgres-attempt1.log) pass. Actual native/served observation qualification remains pending. Rules stays Partial under its publication requirements.

The [retained settings review](../.tmp/settings-059-merge-observation-retained-browser-attempt1/manifest.json) passes four font-settled dark/light1440/390 captures and eight linked settings headings, with [the original session inventory unchanged](../.tmp/settings-059-merge-observation-retained-browser-attempt1/runtime-session-receipt.json). Root inspects the light mobile capture. No configuration writes or workflow dispatch occur. Coverage remains one Ready configuration section and nine Partial sections. Separately, source copy now condenses the coverage rows and updates the qualified Access scope; that copy is not yet deployed. Its fifteen existing browser cases pass27.1s. The preceding run's sole obsolete Rules=Planned assertion is preserved as failed, then corrected to the already-implemented Partial state; no capability is promoted.

Owned superseded e04 core/agent components, the older local13 agent and historical backend pin are retained as verified host OCI archives before their exact stopped pins/tags are removed. The backend archive explicitly preserves its historical tag/OCI-label mismatch without inferring source qualification. See [core](../.tmp/settings-059-viewer-retired-core-image.tar-receipt.json), [agent](../.tmp/settings-059-viewer-retired-agent-image.tar-receipt.json), [local13](../.tmp/settings-local13-agent-retired-image.tar-receipt.json) and [backend](../.tmp/settings-backend-retired-image.tar-receipt.json). Only exact new unshared build-cache records are removed; active data, images, keyrings and other projects are preserved.

## Current SSH deploy-key consumers qualify on both repository scopes (2026-10-04)

[Personal059 attempt2](../.tmp/repository-personal-deploy-keys059-attempt2/parent-manifest.json) and [organization059 attempt1](../.tmp/repository-organization-deploy-keys059-attempt1/parent-manifest.json) pass on component source `e04a07ca`, core `fa4abeb7`, native1.27.3 and schema059. Each independently pins the owned native container's Ed25519 public host key before comparing network keyscan. Both prove private read-only clone, native-denied read-only push, allowed read/write push with independent ref readback, separate associations for one shared public key, selected-association revocation, surviving second-association push and final new-connection revocation. Current owner/direct-admin versus reader/writer/global/outsider, exact target/revision, Origin/bearer/logout boundaries pass. Each includes sixteen actual font-settled dark/light1440/390 Add/list/reload/Delete captures; root visually inspects the personal dark desktop inventory. Owned fixtures are removed and every outside-project container identity/image/status/running state is unchanged.

The [personal first attempt](../.tmp/repository-personal-deploy-keys059-attempt1/parent-manifest.json) remains failed with cleanup passed at the first SSH clone. Its prepared helper used a bare `HostKeyAlias=localhost` while the known-host record was port-qualified. The corrected helper uses the exact port-qualified alias, isolated configuration/agent/control settings, validates both actual clone URLs, and records only fixed Git failure categories. Real local OpenSSH lookup/config checks pass without a connection. Passing transport does not qualify revocation of already authorized/in-flight activity or managed protected-write ingress. Access-specific recovery and service-backed current observation retain separate gates.

The new explicit merge-observation source at `05ab5bf` passes main checks and [Postgres-backed race cases](../.tmp/settings-merge-observation-postgres-attempt1.log), including nine native-response fixture modes plus logout and late authority changes, in14.734s. Native/served qualification and deployment are pending; no merge operation is enabled. The [packet](REPOSITORY_RULES_NEXT_INCREMENT.md) retains the publication gate and Rules remains Partial.

## Current Access grant and invitation matrix qualifies (2026-10-04)

[Access059 attempt3](../.tmp/repository-access059-served-attempt3/manifest.json) passes with cleanup on deployed component source `e04a07ca70f5e56faff123e1980491a393ea3dda`, core `fa4abeb7`, native1.27.3 and schema059. All twelve personal/organization × owner/member-direct-admin × read/write/admin invitation cases have exact successful requested-role acknowledgements and independent aggregate native membership/permission checks. Actual organization-owner Set/Remove and invitation Preview/Create refuse with unchanged retained generation/inventory, zero native mutation and zero refused proxy-write attempts. Native aggregate permission remains distinct from an exclusive stored direct role.

One direct grant and a second distinct invitation acceptance each receive actual native204 before the controlled adapter closes the response. Both retain original `DISPATCH_UNKNOWN` identity/generation; the invitation remains `GRANTING`. Inspection, unchanged-key replay and backend restart never resend either native write; fresh conflicting work and archive remain blocked. Retained generation ABA checks pass. Twelve actual dark/light1440/390 inventory/requested-role/original-receipt captures pass; root visually inspects the dark desktop requested editor. Captures retain the Access048 protocol naming; the parent records the actual059 schema/image/source. This remains distinct from arbitrary transport/final-SQL loss and recovery.

The qualification proxy has an independently rebuilt [artifact receipt](../.tmp/access059-distinct-fault-proxy/source-artifact-receipt.json), separate from the product image. Its mandatory aggregate refused-write count records no refused path/body/credential; the native route allowlist is unchanged. Only Access permits two distinct once-only collaborator fault reservations; duplicate/concurrent/third reservations refuse, and Rules remains limited to one. Pure Go race/control-handler and Python boundaries pass. The actual final counters record two losses and zero refused writes; one verified pre-header startup GET failure remains explicitly accounted, with no later unaccounted failures.

[Attempt1](../.tmp/repository-access059-served-attempt1/manifest.json) remains failed at the owner counter helper. [Attempt2](../.tmp/repository-access059-served-attempt2/manifest.json) passes the twelve cases/owner refusals/direct loss but fails when the original Go control handler refuses a second arm. Both cleanup receipts pass and neither failure is relabeled. Current native SSH/shared-key consumers, Access-specific recovery, current service observation and remaining topology acceptance still require their own receipts before complete Access readiness. The new closed059 Access recovery profile and drill are source-prepared with pure guards/archive checks; actual execution is pending. See [Access acceptance](REPOSITORY_ACCESS_ACCEPTANCE.md) and [recovery scope](RECOVERY.md).

## Typed Actions drilldown deploys and actual served qualification passes (2026-10-04)

Retained localhost8080 now runs component source `e04a07ca70f5e56faff123e1980491a393ea3dda` at schema059: core/webhook `fa4abeb7`, runner `e7bac659` and agent `f569e8f4`. The [stopped-writer backup/deployment receipt](../.tmp/settings-059-viewer-retained-backup/receipt.json) records coherent backups and unchanged retained authentication/history; the [independent running proof](../.tmp/settings-059-viewer-running-proof/manifest.json) binds actual images and binaries. This supersedes the preceding deployed6d image identity, without relabeling its receipts.

[Actual typed attempt5](../.tmp/workflow-inputs059-served-attempt5/manifest.json) repeats the native1.27.3/PostgreSQL18.4/verified-TLS1.3/Docker execution and original-run inspection/restart checks on these exact component images. Its [actual read-only browser proof](../.tmp/workflow-inputs059-served-attempt5/typed-ui/manifest.json) adds twelve font-settled dark/light1440/390 captures of the requested four-type input editor, recorded run and selected local-composite step after navigation/reload. Actual run/log reads bind the original native/source/input/job/step identities; UI writes are prohibited and submitted disposable values do not persist in browser storage. Root inspects the dark desktop editor and light mobile step capture. This is actual editor/read/drilldown qualification, not browser dispatch or all privacy transitions. One controlled API admission executes one Docker job. Cleanup passes, with all134 foreign container identities/images/status/running states unchanged; four unrelated restart lifecycle observations remain separately identified.

The [current retained settings browser review](../.tmp/settings-059-viewer-retained-browser-attempt2/manifest.json) also passes four verified dark/light1440/390 captures, all ten inventory rows, General's Open anchor and eight linked section headings. The [runtime/session receipt](../.tmp/settings-059-viewer-retained-browser-attempt2/runtime-session-receipt.json) binds the actuale04 core image and proves the original one-session inventory byte hash unchanged after isolated login/logout. Root visually inspects the dark desktop capture. No settings write or workflow dispatch occurs, and headings do not qualify every data consumer. Its [first invocation](../.tmp/settings-059-viewer-retained-browser-attempt1.log) stops before login because the wrapper and script both create the same output directory; the unchanged-session failure receipt is preserved.

All85 source run-browser cases pass39.7s ([log](../.tmp/typed-run-viewer-worktree/.tmp/typed-run-browser-qualified.log)); main checks pass ([log](../.tmp/settings-059-viewer-main-check-attempt1.log)). Legacy and typed run identities remain distinct, and exact source/attempt/log fences apply to the v2 viewer. These checks do not qualify additional catalogs, triggers, typed secrets, empty/zero submitted-value execution, live release revocation or coordinated recovery.

Superseded owned056 core/runner/agent images and typed33d core are preserved in verified host OCI archives before removing only their stopped sole pins/tags. See [056 core](../.tmp/settings-056-final-retired-core-image.tar-receipt.json), [056 runner](../.tmp/settings-056-final-retired-runner-image.tar-receipt.json), [056 agent](../.tmp/settings-056-final-retired-agent-worker-image.tar-receipt.json), [typed core](../.tmp/settings-059-typed-retired-core-image.tar-receipt.json) and [webhook-wire](../.tmp/settings-webhook-wire-retired-image-archive.tar-receipt.json) receipts. Original image/source receipts remain intact; other containers are unchanged.

[Access059 attempt1](../.tmp/repository-access059-served-attempt1/manifest.json) fails with cleanup passed before the owner-refusal, twelve-invitation and invitation-owned acknowledgement-loss cases. Native ownership and Golf's owner observation already agree; the helper incorrectly asks its closed direct-recipient counter for an owner excluded from that counter. This is a qualification-helper failure, not a completed owner refusal proof. The role-matrix and recovery gates remain open in the [Access acceptance checklist](REPOSITORY_ACCESS_ACCEPTANCE.md). General remains the one qualified Ready configuration row; the other nine sections remain Partial until their actual consumers and complete acceptance pass.

## Typed Actions runtime qualifies and retained schema059 deploys (2026-10-04)

[Actual attempt4](../.tmp/workflow-inputs059-served-attempt4/manifest.json) passes on frozen component source `33d16cdc4e42fb292747273400a62c49968017a0`, core `787bad92`, runner `f196f4af`, native1.27.3 and PostgreSQL18.4. One real native repository supplies a full-SHA typed manual workflow. A verified TLS1.3 runner executes one Docker job with declared boolean/number defaults, choice selection, numeric truth, inert Unicode/HTML/shell/expression text and a local composite action. Actual job/step and scoped log receipts agree with the original source, attempt and encrypted input metadata. Invalid requests admit zero runs; old/HTTP/missing-capability workers cannot consume the queued run. Discarding an accepted response body, original-key inspection/replay and a queued backend restart preserve exactly one original run. This is a controlled response-body discard, not a guarantee for every transport failure.

The exact owned installation, actors, sessions and volumes are removed; all132 foreign container identities/images/status/running states stay unchanged. Unrelated autorestart lifecycle observations are separate. Failed [attempt1](../.tmp/workflow-inputs059-served-attempt1/manifest.json), [attempt2](../.tmp/workflow-inputs059-served-attempt2/manifest.json) and [attempt3](../.tmp/workflow-inputs059-served-attempt3/manifest.json) remain recorded. Their PostgreSQL tmpfs initially had root ownership; the pinned image's actual postgres UID/GID70 is now set. Attempts1/2 also retain a proxy-stop cleanup failure even though exact owned teardown removed their resources; attempt3 cleanup passes. No failure is relabeled. The literal fixture's shell expectation is built without an interpolatable source token.

Source `6d33d4833aa8ceea7bb667795ef65f6da72f6a64` also preserves input-free GitHub workflows on the legacy v1 path under a selected v2 installation, including existing v1 execution approvals; GitLab remains legacy. Actual planner/PostgreSQL regression passes5.393s ([log](../.tmp/workflow-input-legacy-gh-postgres-attempt1.log)). All80 source-browser cases pass1.8m ([log](../.tmp/workflow-input-browser-attempt2.log)); main checks pass ([log](../.tmp/workflow-input-v2-main-check-attempt2.log)). These browser fixtures are separate from actual native execution.

Matched complete59 [artifacts](../.tmp/settings-059-complete-host-artifact-receipt.json) and images deploy to retained localhost8080 with schema059 ([stopped-writer backup/deployment receipt](../.tmp/settings-059-complete-retained-backup/receipt.json)). Core/webhook image is `aff30bb3`, runner `d982d8fe`, agent `97e0d3cf`; the [independent running proof](../.tmp/settings-059-complete-running-proof/manifest.json) verifies each actual binary and image. Existing accounts, sessions, connections and manual history are unchanged across deployment. Public8080 stays available; the internal coordinator uses an unexposed loopback TLS listener and the runner's configured private development CA. An owned read-only client in the actual runner network namespace proves TLS1.3/readiness and wrong-hostname, untrusted-CA and TLS1.2 denial; recent worker presence is a separate observation, not a retained dispatch qualification. No retained repository mutation or workflow dispatch occurs.

The [retained browser review](../.tmp/settings-059-retained-browser-attempt2/manifest.json) captures all ten settings rows at1440/390 in both verified themes and navigates all eight linked sections. It verifies General's current-service Ready observation and nine Partial rows; section-heading loads do not qualify every data consumer. Only the isolated review login/logout occurs; the original active session remains. Root visually inspects the dark desktop capture. [Browser attempt1](../.tmp/settings-059-retained-browser/manifest.json) remains failed: duplicate environment headings made its locator ambiguous, and its incorrect theme storage key means those captures cannot establish the claimed light theme. The second attempt fixes both and asserts the actual theme.

Historical owned lifecycle/general images are preserved in verified host archives before removing only their sole stopped owned pins/tags ([lifecycle receipt](../.tmp/settings-lifecycle-retired-image-archive.tar-receipt.json), [general receipt](../.tmp/general-retired-image-archive.tar-receipt.json)). New build-cache cleanup is limited to independently identified completed, unshared owned records; foreign resources are untouched.

This completes one typed execution slice, not full Actions/GitLab parity or all settings. Actual zero/empty submitted-value runs, typed secrets, input-declaring push, additional triggers/artifacts/cache, recovery and protected mutation/deployment consumers remain open. Review found the run-detail UI still recognizes only v1 graphs/logs; its v2 drilldown is being implemented and is not yet claimed served-qualified. See the [ten-section acceptance requirements](REPOSITORY_SETTINGS_IMPLEMENTATION.md).

The Access closure audit also corrects a historical evidence count: Access048 attempt9's actual `requestedInvitations` contains eight cases (six owner-issued roles plus two direct-admin-issued admin cases), not the twelve claimed in earlier prose. Direct-admin-issued read/write invitations on each repository type remain unqualified on the048 generation protocol. Its other actual grants, unknown-operation and restart receipts remain valid for their recorded cases; no full Access Ready claim follows. The qualifier is being expanded to require the missing four cases explicitly.

## Typed manual Actions integrates with encrypted admission and secure runner release (2026-10-04)

Main source `01647941aae28ac97468099a3c45478c12b8ec7d` integrates the schema059 consumer and requested input editor. String, boolean, number and choice values bind exact native repository/owner IDs, full commit/blob, schema, submitted/defaulted maps and original operation key. Admission independently prepares source, plans against the selected v2 catalog and atomically stores the immutable run plus authenticated encrypted content. Legacy input-free intent hashes, GitLab manual dispatch and v1 push execution retain their existing contracts. Old/HTTP workers cannot claim typed runs; release independently verifies retained source/schema and current session, native writer, policy, placement, resource and attempt/lease authority. V2 execution-value/secret broker forwarding remains refused.

The [admission/key/preparation PostgreSQL matrix](../.tmp/workflow-input-v2-postgres-attempt2.log) passes23.500s with the actual maintained planner. The [release/legacy runner matrix](../.tmp/workflow-input-v2-release-postgres-attempt2.log) passes80.016s, including secure assignment and postclaim native writer/session/policy/worker/cancellation revocation, legacy graph/runs, pools, limits and original-operation checks. Both bounded owned databases are removed. These use native-provider fixtures and transport-state test requests; they do not establish an actual TLS handshake or Docker/native execution. Focused combined race checks pass server2.081s/runner1.959s/command1.387s ([log](../.tmp/workflow-input-v2-combined-final-race.log)); main `make check`, now including maintained-source verification and nested engine/private evaluator tests, passes ([log](../.tmp/workflow-input-v2-main-check-attempt1.log)).

All79 workflow browser cases pass1.7m ([log](../.tmp/workflow-input-browser-attempt1.log)), including four input types/presence/defaults, stale preparation, original-digest-only resume after lost response, private editor clearing, both themes/desktop/mobile, and v2-configured legacy GitLab dispatch. These are source RPC fixtures, not served qualification. Root inspected the dark1440 and light390 requested-editor captures. The independently rebuilt frozen host planner matches the tested binary byte-for-byte; [qualification receipt](../.tmp/workflow-input-v2-source-qualification-receipt.json) binds frozen component source `33d16cdc4e42fb292747273400a62c49968017a0`, host/Linux binaries, maintained source manifest and exact adaptation patch. Frozen Linux artifacts and production web build pass ([build log](../.tmp/settings-059-typed-host-build-attempt2.log), [artifact receipt](../.tmp/settings-059-typed-host-artifact-receipt.json)); no059 runtime image/deployment is claimed.

Failures remain recorded. [Admission attempt1](../.tmp/workflow-input-v2-postgres-attempt1.log) fails19.253s: a typed retention fixture incorrectly set a push-only `event_ref` on a manual run, and the inspection fixture omitted the native repository URL required by the existing read boundary. The corrected fixtures preserve those product guards. [Release attempt1](../.tmp/workflow-input-v2-release-postgres-attempt1.log) fails79.522s because its postclaim interception called a nil test transport; the corrected fixture delegates to the real default transport and repeats the same full matrix. A host build's [first invocation](../.tmp/settings-059-typed-host-build-attempt1.log) refuses an incorrectly transcribed source revision before creating artifacts. No failure is relabeled as a pass.

Retained localhost8080 remains source `a0860c9`/schema056 with its existing accounts, sessions, credentials, policies and history. Actual v2 native+Docker+verified-TLS execution, served input forms, recovery, protected writes, full Actions/GitLab catalog and the complete ten repository-settings sections remain open. Settings readiness is unchanged. See the [typed dispatch](WORKFLOW_DISPATCH_INPUTS_CONTRACT.md) and [maintained engine](ACTIONS_ENGINE.md) contracts.

## Encrypted manual-input retention and key lifecycle pass fresh PostgreSQL checks (2026-10-04)

Frozen source `a6b5f6e` adds schema057 immutable encrypted submitted/effective payloads and schema058 key-audit counts. Authenticated content binds run, distinct Golf/native actor IDs, immutable native repository/owner IDs, original key, full commit/path/blob, source/schema/map digests and canonical plaintext size/hash. Strict opening verifies the independently supplied identity and closed canonical maps; ciphertext rotation changes only key/ciphertext.

Every retained state participates in startup, inventory, missing-key refusal, paged legacy validation, bounded shared-budget rotation, audit counts, retirement, remaining-work counters and recovery locking. The combined fresh PostgreSQL/race matrix passes26.358s with the owned database removed ([attempt2](../.tmp/workflow-input-encryption-postgres-attempt2.log), private bounded [database receipts](../.tmp/workflow-input-encryption-postgres-attempt2)). It exercises terminal history, busy-row skip/rollback, batch1 accounting, corrupted row501, restart/missing-key refusal, recovery locking/cancellation with retained inputs, existing key/recovery families and the preparation RPC. Focused source race passes1.547s ([log](../.tmp/workflow-input-encryption-main-race.log)); combined main checks pass ([log](../.tmp/workflow-input-encryption-main-check.log)).

The first actual matrix fails20.271s before these feature assertions: the first UNION arm of the inventory query lacks its new column alias, so PostgreSQL refuses it during startup ([preserved attempt1](../.tmp/workflow-input-encryption-postgres-attempt1.log)). Source compilation/sqlc had not detected this defect. `a6b5f6e` names that column and regenerates the query; attempt2 repeats the same selectors rather than weakening them. Both owned database fixtures are removed. This is storage/key-lifecycle foundation evidence: typed run admission/completeness, exact-source runner release, engine/input UI and actual execution are not yet qualified. Retained localhost8080 remains source `a0860c9`/schema056 and healthy; no retained encryption migration or account/key changes occur in these tests. Settings readiness remains unchanged.

## Exact-source manual parameter preparation passes; execution integration remains pending (2026-10-04)

The shared `internal/workflowinputs` contract is frozen in source `e5f2157`, with independent canonical schema/submitted/effective JSON and digest goldens. Server and maintained-engine consumers reuse the same bounded YAML, declaration and typed-map semantics instead of separate parsers. Common race tests pass1.216s and unchanged server foundation tests/seeds pass1.603s; vet/whitespace pass.

The additive managed `PrepareWorkflowDispatch` RPC now verifies the exact full commit/tree/blob and current native writer identity, preserves oneof false/zero/empty presence, computes submitted/defaulted digests and returns only declarations/metadata. It rechecks managed session and native authority across source reads. No run/key reservation, source archive/upload, job planning or execution credential release occurs; preparation may succeed with execution disabled and is not an admission or readiness claim. Legacy dispatch behavior retains the same exact-source helper and intent hash.

Source race checks pass1.524s ([log](../.tmp/workflow-input-preparation-source-race.log)); fresh PostgreSQL/HTTP checks pass6.528s with the owned database removed ([log](../.tmp/workflow-input-preparation-postgres-attempt1.log), private bounded [database receipt directory](../.tmp/workflow-input-preparation-postgres-attempt1)). Those checks cover public metadata without submitted-value disclosure, zero runs/archive/mutation calls, mismatched target/nonwriter denial and permission/session/native-actor revocation during source reads. Combined main checks pass ([log](../.tmp/workflow-input-preparation-main-check.log)). Maintained-engine typing, immutable encrypted admission and full key lifecycle, capable verified-TLS worker release, input UI and actual execution are still being integrated. This source packet is not deployed to retained localhost8080/schema056 and does not make CI or all repository settings Ready. See the [input contract](WORKFLOW_DISPATCH_INPUTS_CONTRACT.md).

## Operator-global prepared Git rejection qualifies in a fresh native fixture (2026-10-04)

A bounded operator-global reference-hook fixture (frozen source `4ad746c7e863af60824b15a6f33803f2a897bc79`, Git 2.54.0, PostgreSQL 18.4) passed its second attempt on the native forge at the time (an earlier backend, since retired) after a failed first attempt; [ADR 0004](decisions/0004-protected-integration-enforcement.md) summarizes what it showed. It is not Forgejo evidence, and its receipts were removed with that backend. Combined `make check` passed and retained 8080 was unchanged.

This proves only bounded hook composition, not the production Golf policy consumer. Exact source/base/candidate and actor/policy/review/check/fork reservations, every managed/native writer, durable uncertain-outcome/recovery fencing, override resistance and full P0.8 acceptance remain open. Rules and the other incomplete settings rows remain Partial; no native fork decision or full protection claim follows from this fixture.

## Manual-input validation and compact workflow controls integrated in source (2026-10-04)

The Actions configuration density change is integrated in `5802f25`: the original-dispatch inspection control uses the shared action layout, and static qualification prose uses native disclosures while current worker/policy/source and uncertainty remain visible. All49 isolated source-browser cases pass with loaded fonts across dark/light desktop/mobile, plus TypeScript. The combined pre-foundation `make check` passes ([log](../.tmp/settings056-density-main-check.log)). These changes are not yet deployed to retained8080.

Source `1b2ef71` adds declaration parsing, typed submitted/defaulted values and separate canonical digests under the [manual-input contract](WORKFLOW_DISPATCH_INPUTS_CONTRACT.md). Tests cover false/zero/empty presence, defaults, choices, count/UTF-8/escaped-byte bounds, finite binary64 precision/underflow, literal untrusted values, deterministic hashes and case-fold name collisions. Main's focused race cases pass1.599s ([log](../.tmp/workflow-dispatch-input-foundation-main-race.log)); the final main parser fuzz passes477 executions/21 baseline seeds in8.647s with race instrumentation ([log](../.tmp/workflow-dispatch-input-foundation-main-fuzz.log)). The independent source packet also has40,009 preceding non-race fuzz executions; its final case-fold guard is covered by focused counterexamples and main's later fuzz run.

No RPC or deployed catalog accepts typed parameters yet. Encryption/key lifecycle, immutable admission and original-digest inspection, worker release, patched evaluator semantics and actual CI/browser qualification remain required. This foundation does not activate a form or mark CI Ready. Retained schema056/source `a0860c9`, service images, policies and account/session history remain unchanged; readiness still requires all requirements in the ten-row settings packet.

## Actual schema056 workflow notices and original-dispatch inspection qualify (2026-10-04)

Notification attempt4 is **qualified**, with cleanup passed and zero owned resources remaining, on frozen source `a0860c947feeb07c4abf7ee46a7b312e26beb1fa`, core `04a84575`, runner `8dbc01ea`, native1.27.3 and schema056 ([manifest](../.tmp/workflow-notifications056-served-attempt4/manifest.json)). Four actual shell runs cover success, failure, queued cancellation and one additional browser-dispatched success. Own original-key reads bind the full source SHA and exact run; another writer and a missing key receive404. Missing-key404 is not proof that an earlier dispatch had no effect. Independent SMTP and HMAC receiver receipts verify activity/completed/failures filtering, temporary451/503 retries, and accepted-response loss producing two identical frozen bodies with different `possibleDuplicate` observations. Restart produces no additional delivery. SMTP acceptance remains relay acceptance, not inbox delivery.

Four actual font-settled dark/light1440/390 captures exercise the original-dispatch UI on one real successful run ([browser manifest](../.tmp/workflow-notifications056-served-attempt4/original-dispatch-ui/browser-manifest.json)). Its accepted browser response is deliberately discarded; reload performs no dispatch or automatic original-key read, and explicit inspection resolves the exact run with exactly one DispatchWorkflow and one GetWorkflowDispatch request. These are actual RPCs, not mocked responses. This supersedes the preceding pending statements only for the qualified shell outcomes and original-dispatch scope; new notification-mode settings controls are not yet served-qualified.

All132 foreign container IDs, images, status and running states remain unchanged. Four unrelated containers have separately recorded StartedAt/restart-count changes whose cause is not asserted; this is not an all-metadata-stable claim. The [operator seed receipt](../.tmp/workflow-notifications056-served-attempt4/root-seed-receipt.json) records an exact approved public Alpine image in the owned daemon: the cached archive loaded but did not retain its named digest, so an official-registry pull was required. The helper itself performs no image build/pull. The earlier [retained running proof](../.tmp/settings-056-final-running-proof-after-notification-attempt2.log) independently verifies all four retained service binaries and unchanged authentication/manual history after cleanup.

Failed attempts remain evidence: [attempt1](../.tmp/workflow-notifications056-served-attempt1/manifest.json) stops at null-IPAM preflight with no resources created; [attempt2](../.tmp/workflow-notifications056-served-attempt2/manifest.json) mishandles MIME CRLF, exhausts five SMTP attempts and reaches the180-second deadline. Root independently observes zero owned resources after attempt2, while its foreign-category cleanup check fails. [Attempt3](../.tmp/workflow-notifications056-served-attempt3/manifest.json) raises a command-shadowing TypeError after accepted-body checks and before restart, leaving its original cleanup failure intact; supported operator CLIs and exact-project cleanup remove its nine containers, five volumes and two networks ([root cleanup receipt](../.tmp/workflow-notifications056-served-attempt3/root-cleanup-receipt.json)). Its earlier failed full lifecycle comparison remains recorded. Fixes change qualification helpers only; product code is unchanged.

Real lost/timed-out notification producers, automatic push and maintained-engine outcomes, served new-mode controls, provider bounces, Cloudflare adapters, production scale and schema056 recovery remain open. All broader settings acceptance states remain unchanged; this bounded delivery proof does not make the Notifications row or the product fully Ready.

## Retired schema055 artifacts retain exact recoverable archives (2026-10-04)

After the matched schema056 deployment and coherent stopped-writer backup passed, only the three owned, stopped schema055 pins were retired. Their original source `3cadc2aa339698138f6b1d561f4fdffa51c3e2bc`, exact OCI indexes, ARM64 manifests/configuration and archive checksums remain verified in the [core](../.tmp/settings-055-retired-core-archive.tar-receipt.json), [runner](../.tmp/settings-055-retired-runner-archive.tar-receipt.json) and [agent](../.tmp/settings-055-retired-agent-worker-archive.tar-receipt.json) receipts. All other container IDs, images and running states stayed unchanged. These are artifact preservation and narrowly owned cleanup; restoring schema055 requires its matched coherent backup, not an in-place runtime downgrade of schema056. Schema056 disaster recovery remains unqualified.

## Retained schema056 deploys; final-image environment configuration qualifies (2026-10-04)

Retained localhost8080 is deployed at schema `202610040056`, frozen source `a0860c947feeb07c4abf7ee46a7b312e26beb1fa`. Exact running core/webhook image `04a84575`, runner `8dbc01ea` and agent-worker `34bfc45d` match their source pins ([core](../.tmp/settings-056-final-core-pin-receipt.json), [runner](../.tmp/settings-056-final-runner-pin-receipt.json), [agent](../.tmp/settings-056-final-agent-worker-pin-receipt.json)). Independent reads verify all four running services' public Golf/runner/maintained-engine binary hashes, readiness and SPA HTTP200 ([running proof](../.tmp/settings-056-final-running-proof/manifest.json)). The coherent [backup/deployment receipt](../.tmp/settings-056-final-retained-backup/receipt.json) records complete backups, schema056, unchanged foreign containers and identical retained authentication/manual-history hashes: 128 accounts, one session, seven coding-agent connections, three authentication records, one connection-access record, one automation grant and116 issue mutations. Historical UNKNOWN issue mutation7 remains unchanged, without replay. The initial HTTP checker omitted Origin but expected401; the corrected check verifies omitted-Origin403 and valid-Origin/no-session401, both no-store, without changing product behavior.

Environment attempt11 qualifies the bounded configuration API and twelve actual dark/light1440/390 inventory/editor/receipt captures on that exact final source/core, with cleanup and unchanged fixture runtime ([manifest](../.tmp/repository-environments055-served-attempt11/manifest.json), [browser manifest](../.tmp/repository-environments055-served-attempt11/browser/browser-manifest.json)). This supersedes the pending final-image environment statement, without relabeling attempt10's intermediate `1385`/`c813` fixture. That intermediate image has a separately verified exact OCI archive and sole-owned-pin removal with132 other containers unchanged ([archive receipt](../.tmp/settings-056-intermediate-core-archive.tar-receipt.json)). The original command's subsequent image removal failed with “no such image” after removing its sole stopped owned pin; the [failure log](../.tmp/settings-056-intermediate-core-archive.log) is preserved. Retired055 archival remains pending.

The preceding schema056 notification/password database checks and original-dispatch59 source browser/14.361s database checks keep their recorded scope. Actual original-dispatch native/served inspection and workflow-outcome notification delivery remain pending. Environment policies still have no deployment, preview, secret-release or enforcement consumer. Nine broader repository settings sections remain Partial; deployment, full CI/agent/provider compatibility, recovery and protected-write/P0.8 acceptance are not completed by this retained deployment. Earlier source/runtime statements below remain historical evidence with their original identities.

## Outcome notifications and original dispatch inspection pass source checks; retained deployment stays055 (2026-10-04)

Source `a0860c947feeb07c4abf7ee46a7b312e26beb1fa` integrates schema056 workflow notification modes and reusable password-attempt reservation/refund handling. Existing source/issues/pulls/actions topics and repository SSE remain unchanged. Actions subscriptions choose activity, all terminal outcomes, or failed/timed-out outcomes; cancelled/lost labels remain explicit and do not claim immediate cleanup or a confirmed execution result. A once-per-run immutable terminal journal feeds the existing webhook/email queues under exact native repository/owner and current saved consent. Payloads exclude source, logs, prompts and private agent content; delivery still rechecks current credentials/native authority. Omitted edits preserve prior modes, and automatic email retries retain encrypted frozen MIME. The notification UI's 41 source browser cases pass; actual outcome delivery and current served mode controls are not yet qualified.

The [notification database run](../.tmp/settings056-notification-postgres-attempt3.log) passes 111.869s, and [affected password/database families](../.tmp/settings056-password-affected-postgres-attempt2.log) pass 136.626s; both owned databases are removed. Original notification attempts remain failed evidence: the [first](../.tmp/workflow-notifications056-postgres-attempt1.log) expected Aborted instead of the established FailedPrecondition stale-edit contract, and the [second](../.tmp/workflow-notifications056-postgres-attempt2.log) checked a MIME-soft-wrapped URL without decoding quoted-printable. Corrections preserve the product contract and require the exact decoded outcome/link while comparing frozen retry bytes. The broader [affected attempt2](../.tmp/settings056-affected-postgres-attempt2.log) remains FAILED, including an infrastructure database-profile refusal and subsequent PostgreSQL recovery/connection failures; it is not a full-suite pass. Original-key manual workflow inspection adds source-bound status lookup and browser metadata-only resume without automatic dispatch/replacement; 59 source browser cases pass and the [dispatch database run](../.tmp/settings056-dispatch-postgres-attempt1.log) passes 14.361s with its owned database removed. Actual native/served original-dispatch qualification remains pending. Latest [main checks](../.tmp/settings056-final-main-check-attempt1.log) pass.

Environment attempt10 is actual configuration-only PASS/qualified with cleanup on the intermediate source `1385d6ebe5e3edba8b75b76b4ac5a531780524a7`, image `sha256:c8139b21d110e40998d0fd4a0e4ce5cd0ada15164f624578e1852d95b5c3ed8e` and native1.27.3 ([manifest](../.tmp/repository-environments055-served-attempt10/manifest.json)). Twelve actual dark/light1440/390 inventory, requested-editor and verified-receipt captures pass with exact identities, CAS/tombstone/replay, lost-response inspection/no resend, ordinary authority and reader/logout denials ([browser manifest](../.tmp/repository-environments055-served-attempt10/browser/browser-manifest.json)). No native mutation, environment deployment or policy enforcement is claimed. Independent [foreign-container comparison](../.tmp/settings056-environments-foreign-comparison.json) preserves all133 original IDs, images and running states; an initial name-filtered comparison was corrected. Earlier attempts retain their original failures. This intermediate fresh fixture is separate from retained localhost8080, which still runs source `3cad`/schema055 with `d9` core/webhook, `2cc` runner and `34dd` agent images. Latest source `a086` is being prepared for deployment, without a deployment PASS here. Nine broader repository settings sections remain Partial; actual deployment/preview/secret consumers, full CI/agent/provider compatibility, recovery and protected-write/P0.8 gates remain open.

## Retired053/054 artifacts archived with exact owned cleanup (2026-10-04)

The retired054 core `68f82d80` and agent-worker `78753ee2` images/pins have verified private host OCI archives and strict owned cleanup PASS ([core archive receipt](../.tmp/settings-054-retired-core-archive.tar-receipt.json), [agent archive receipt](../.tmp/settings-054-retired-agent-worker-archive.tar-receipt.json)). Archive checksums and original source `5e6` labels are preserved; every other container remains unchanged. The [core](../.tmp/settings-054-retired-core-archive.log) and [agent](../.tmp/settings-054-retired-agent-worker-archive.log) logs retain the exact operations. Retired054 runner e7b03b30 and retired053 runner0a6a7444 archives also PASS with original source labels, verified checksums and all other containers unchanged ([054 runner receipt](../.tmp/settings-054-retired-runner-archive.tar-receipt.json), [053 runner receipt](../.tmp/settings-053-retired-runner-archive.tar-receipt.json)). Their additional reserve gain is negligible. Free reserve reaches 2,099,288 KiB, just above the 2-GiB guard; no broader image/cache pruning is performed. Retained055 remains source `3cad` with core/webhook `d9`, runner `2cc` and agent `34dd`, as identified below. This archive completion neither changes any of the ten full settings acceptance states nor supplies missing deployment consumers, recovery or P0.8 qualification.

## Retained schema055 deploys with exact worker and binary provenance (2026-10-04)

Retained localhost8080 is deployed at schema `202610040055`, source `3cadc2aa339698138f6b1d561f4fdffa51c3e2bc`. Exact named running core/webhook image `d9d1505f`, runner `2cc3286b` and agent-worker `34dd42d7` match current Compose configuration and frozen source ([core pin](../.tmp/settings-055-complete-core-pin-receipt.json), [runner pin](../.tmp/settings-055-complete-runner-pin-receipt.json), [agent-worker pin](../.tmp/settings-055-complete-agent-worker-pin-receipt.json)). Unlike the earlier054 provenance limit, this deployment verifies original environment hashes for all four actual Golf services, excluding stopped image-pin containers by explicit name. Four actual running public binary hashes match frozen artifacts: Golf `97a6ecd5`, runner `3229bea8` and engine `f24c42dd`; runner/engine were independently compiled byte-identical to054 ([running binary receipt](../.tmp/settings-055-retained-running-binaries.json), [host artifacts](../.tmp/settings-055-complete-host-artifact-receipt.json)).

All four Golf writers plus native/database services were stopped for coherent PostgreSQL dumps and private native data/configuration backups, with verified archive listings. The [backup/deployment receipt](../.tmp/settings-055-retained-backup/receipt.json) records deployed/schema055, complete backups, unchanged foreign containers and identical retained auth/session/connection/grant/manual-history byte hashes. One session, 128 local accounts and historical UNKNOWN issue mutation `7` remain unchanged; the original unknown is not replayed. All recorded execution/delivery/lifecycle queues are zero. Four HTTP checks return 200, including canonical environment/settings/runners pages and readiness; anonymous managed environment RPC returns 401/no-store ([HTTP receipt](../.tmp/settings-055-retained-http-receipt.json)). The deployment log's terminal schema054 label is a preserved typo; SQL assertions, deployment receipt and independent HTTP manifest establish schema055.

The preceding source/database055 checks remain bounded configuration evidence. Actual authenticated served environment CRUD/captures are not yet qualified; environment deployment, previews and inherited secrets still lack consumers and full support remains Partial. Earlier054 source/image/capture evidence retains its original identity. Exact-owned055 build-cache cleanup receipts preserve all other containers ([core cleanup](../.tmp/settings-055-complete-core-owned-cache-cleanup-receipt.json), [runner/agent cleanup](../.tmp/settings-055-complete-runner-agent-owned-cache-cleanup-receipt.json)); retired054 core/agent image archival and exact owned cleanup now pass in the newer entry above. Deployment does not complete recovery, native deletion, protected-write/P0.8 or every settings requirement.

## Schema055 named environment configuration passes source checks; retained runtime stays054 (2026-10-04)

The seven environment/database families, including independent-administrator creator contention and positive ServeHTTP, PASS 22.929s with the owned database removed ([attempt3 log](../.tmp/environments-055-postgres-attempt3.log)). Earlier attempt2's mapped token-verification fixture failure remains preserved: `296`/`3df` correct the operator client's bypass of the test override by using a real httptest native endpoint for both clients; no product assertion is weakened. This supersedes the preceding pending contention statement, without erasing the failed run.

The source UI packet `9dc`/`8a7` passes 36/36 browser cases in 14.3s for fonts, themes, mobile sizing, CAS, private permission denial and read-only status/no retry. The initial combined mounted run passes 37/39; two failures are strict H1/H2 fixture selectors ([attempt1](../.tmp/environments-055-mounted-browser-attempt1.log)). Corrected mounted route cases pass 3/3 in 3.9s in both [attempt2](../.tmp/environments-055-mounted-browser-attempt2.log) and [final attempt3](../.tmp/environments-055-mounted-browser-attempt3.log), including the settled ordinary-reader denial. Canonical source `90057ac62e8a5a358e79643bb0059cebbc952cd7` mounts `/OWNER/REPO/settings/environments` with the shared layout, breadcrumb, current security availability and an explicit Add editor. [Main make check](../.tmp/environments-055-main-check.log) and [mounted TypeScript](../.tmp/environments-055-mounted-check.log) PASS. This is configuration-only, Partial support: deployment/preview consumers, secret inheritance and full environment/CD enforcement are not implemented or qualified. Retained runtime remains schema054/source `5e6`; these source tests are not served055 evidence, and updated coverage wording does not make every settings section Ready.

Prepared SSH harness changes `cf28`/`0a4` add independent host-key pinning and closed Git receipt facts; pure source checks PASS, but the pinned actual invocation remains unrun. Earlier SSH trust-on-first-use evidence retains its original scope.

## Actual resource settings and Docker limits qualify together; schema055 contention remains open (2026-10-04)

Resource attempt2 is PASS/complete with cleanup on frozen source `5e6aa4bfb3a7303638ff053e83284295635d3c1a`, core `68f82d80` and runner `e7b03b30` (full immutable identities in the local ignored [resource manifest](../.tmp/runner-resources053-served-attempt2/manifest.json)). Two independently enrolled Docker workers execute the actual lower-limit jobs; exact Docker/cgroup CPU, memory, disabled-swap and PID observations agree with admitted instance/pool/repository minima. The actual guest starts and its three-second whole-attempt timeout completes in 3.138516s with attempt resources removed. Restart retains original completed/timed-out bindings without replacement execution. Old022 remains process-alive/nonassignment evidence, not a successful-polling claim; the separate authenticated verified-TLS capability-omission request is independently identified.

Twelve actual dark/light 1440/390 current-value/requested instance, pool and repository editor captures pass with complete proof ([browser manifest](../.tmp/runner-resources053-served-attempt2/browser/manifest.json)); root inspected the light390 repository editor. Actual stale-editor CAS409 has no effect and requires explicit inspection. Four real accepted placement responses are discarded before reaching the UI, without mocked RPCs; subsequent inspection never resends, reload never writes and private credentials are not persisted. Parent-side independent current-value/version readback also passes. These results supersede the earlier pending resource-editor capture statement; they do not relabel the separate b451 attempt1. Actual default-max execution, CPU/OOM/PID stress, maintained act-graph limits, active/queued tightening and private-byte fences, larger profiles, aggregate/hostile-tenant accounting, Kubernetes, Cloudflare and recovery remain unqualified. Instant hardware quiescence is not provided; full Runners remains Partial.

Schema055's six existing database cases plus the positive outer-HTTP case pass 19.511s with cleanup ([attempt1 log](../.tmp/environments-055-postgres-attempt1.log)). The new two-independent-admin contention case then FAILS 20.446s at fixture line542 during mapped token verification, with cleanup ([attempt2 log](../.tmp/environments-055-postgres-attempt2.log)). The lock-order correction is integrated in source, but this failed run does not qualify contention; its fixture is being corrected. Canonical environment UI mounting is still in progress and unserved by the retained `5e6`/schema054 runtime. Partial schema055 source/database evidence is not full055, actual environment/CD, or a Ready claim; the failed counterexample remains preserved.

## Retained schema054 deployment completes with preserved account history (2026-10-04)

Retained localhost8080 is deployed at schema `202610040054` on frozen source `5e6aa4bfb3a7303638ff053e83284295635d3c1a`. Exact named running services verify core/webhook image `68f82d80`, runner `e7b03b30` and final agent-worker `78753ee2` against that source and current desired Compose configuration; full immutable identities are linked below. Health, readiness and two SPA deep links return 200; workflow and agent execution queues are zero. The local ignored [backup/deployment receipt](../.tmp/settings-054-retained-backup/receipt.json) records status `deployed` and schema054. This supersedes older retained047/pending-deployment statements without changing their historical evidence.

Before migration, all four Golf writers and native writers were quiesced. Both Golf and native-forge PostgreSQL dumps have verified archive listings, with private native data/configuration backups. Retained auth, sessions, connections, grants and manual issue history have unchanged byte hashes, including one session and 128 local accounts. Historical issue mutation `7` remains UNKNOWN from 2026-10-03, unchanged and not replayed; this is not an all-unknown-zero claim.

The first post-deployment checker failed because a stopped image-pin container's inherited Compose labels displaced the actual agent worker in its service map; the failure remains in the [original deployment log](../.tmp/settings-054-retained-deploy.log). Corrected exact-name/current-desired-Compose checks pass. Original environment hashes match for the other three Golf services; the original agent-worker environment hash was not retained, so all-four original environment equality is not asserted. Foreign-container preservation passed at the original pre/post-deployment comparison before that erroneous pin check; that recorded scope is preserved. Later schema055 configuration/UI and rule-padding changes remain source-only, unserved by this `5e6` runtime: 59 padding browser fixtures pass 16.7s plus TypeScript. No full settings Ready, native deletion, protected-write/P0.8 or 055 database qualification follows from deployment.

## Actual Rules and organization execution qualify on the schema054 image (2026-10-04)

Rules attempt13 passes with cleanup on source `5e6aa4bfb3a7303638ff053e83284295635d3c1a`, core `sha256:68f82d803fb643a8738223959c361db8986a4712ec256a02535dc2d5eb416bd5` and native 1.27.3. Personal and organization rule mutations have independent native readback; twelve actual dark/light 1440/390 requested-editor and receipt captures pass, including the desktop dark receipt inspected by root. A real native 201 response discarded after acceptance leaves the original operation UNKNOWN; status, replay and restart do not resend, and replacement/archive attempts stay blocked. Evidence: local ignored [Rules manifest](../.tmp/repository-rules049-served-attempt13/manifest.json) and [browser manifest](../.tmp/repository-rules049-served-attempt13/browser-manifest.json). Earlier failed attempts, including attempt12's receipt-refresh failure, remain preserved. This qualifies the bounded configuration slice, not native CAS, protected-write enforcement or full Rules readiness.

Organization execution attempt2 passes with complete proof and cleanup on that same core/source and matching runner `sha256:e7b03b305ea7d06fdd79fe5ceee7e72d99ee7032b15b95328e91c6f7eadff80c`. Real maintained-Actions jobs consume the explicitly selected organization values; exact owner/repository/version/session/credential/expiry and local-override boundaries pass. Twelve actual dark/light 1440/390 captures pass. Supported native namespace transfer makes the original run read return 404 and cancels the worker attempt with output withheld and zero readable rows. Evidence: local ignored [organization manifest](../.tmp/org-values052-served-attempt2/manifest.json) and [browser manifest](../.tmp/org-values052-served-attempt2/browser/manifest.json). Attempt1 remains FAILED on b451/core c0, with cleanup PASS: its final historical-address read returned 503. The narrow historical-address mapper's disposable PostgreSQL/race checks pass 9.709s and 11.156s with cleanup ([redirect log](../.tmp/workflow-historical-redirect-postgres.log), [address log](../.tmp/workflow-historical-address-postgres.log)). Named environments, fork/agent/CD release, OIDC, transformed-secret concealment, atomic native authority and fresh 052 recovery remain separate gates.

Deletion source is mounted through `28d905c` and `5e6aa4b`: the canonical route retains the original native ID and can inspect its own original operation after repository absence. The 35 focused source browser cases and 86 combined mounted deletion/rule cases pass; the latter takes 29.5s ([mounted log](../.tmp/settings-054-mounted-browser.log)). Deletion/lifecycle PostgreSQL and positive ServeHTTP/status/replay checks remain the earlier 54.113s PASS with cleanup on a controlled synthetic profile ([database log](../.tmp/settings-054-deletion-postgres-attempt3.log)). These are not actual full native DELETE, managed deployment-boundary or P0.8 qualification. Default deletion availability remains false; full lifecycle remains Partial.

Schema054 build artifacts bind the frozen source in local ignored [core](../.tmp/settings-054-complete-core-pin-receipt.json), [runner](../.tmp/settings-054-complete-runner-pin-receipt.json) and [agent-worker](../.tmp/settings-054-complete-agent-worker-pin-receipt.json) receipts. The final re-exported agent-worker image is `sha256:78753ee26b79c9833801257e07c0072b1ba16a9f6463a97a601c7e57c617240f`; independently read Golf and maintained-engine binary hashes match the [host artifact receipt](../.tmp/settings-054-complete-host-artifact-receipt.json) (`4f99cd84…` and `f24c42dd…`). Retained deployment is now verified in the newer entry above; its original checker failure and environment-provenance limit remain preserved. This build evidence supplies no 055 database proof or full-section Ready claim. Chronological entries below preserve earlier source/image states; this entry supersedes their pending Rules and organization qualification statements without relabeling older evidence.

## Actual Docker resource limits qualify for the first bounded group (2026-10-04)

Resource attempt1 passes on source b451, core c0f752c8 and matching runner0a6a7444 (full identities in [the qualification recipe](RUNNER_JOB_LIMITS_QUALIFICATION.md)). Instance/pool/repository current-password/CAS settings compose to250m CPU,96 MiB memory and24 PIDs with a30-second budget. Two independent upgraded workers execute owned source and return fixed controller/completion markers; independent Docker inspection and actual cgroup-v2 values agree, including disabled swap and nonroot/network-none/readonly isolation. Old022 process presence/no-assignment is explicitly process-only evidence; a separate authenticated verified-TLS missing-capability request returns204 without assignment, while the wrong credential returns401.

The actual timeout guest starts, retains its three-second admitted budget and finishes TIMED_OUT in3.148746s without its late completion marker; attempt containers/volumes are removed. Restart preserves completed/timed-out snapshots, and exact known-operation replay returns the original attempt without replacement execution. All owned actors, sessions and fresh Compose resources clean up. Original evidence: `.tmp/runner-resources053-served-attempt1/manifest.json` and log. Actual maintained Actions inner limits, CPU/OOM/PID stress, active policy tightening/private-byte revocation, current resource-editor captures, aggregate accounting and other runtimes remain open; full Runners is Partial. Organization shared-value execution is the next actual fixture. Retained8080 still runs047; this proof does not relabel that runtime.

## Deletion database consumer passes; rule receipt refresh corrected (2026-10-04)

Schema054 introduces an owner-only deletion journal and consumer with current password confirmation, exact immutable target/observed revision, durable uncertainty before one supported native DELETE, exact204 confirmation and original-operation inspection after repository absence. Default availability remains false: the existing qualified private-native incarnation profile and producer exclusions must be independently established; a synthetic database row cannot enable the retained installation. Personal and organization ownership are distinct from instance administration. Successful original IDs remain permanently fenced; ambiguous outcomes never resend. See the [deletion contract](REPOSITORY_DELETION_CONTRACT.md).

Real PostgreSQL/race deletion and lifecycle cases plus positive outer-HTTP deletion/status/replay cases pass54.113s in `.tmp/settings-054-deletion-postgres-attempt3.log`; the owned database is removed. HTTP Origin/session/delegated guards and pure deletion cases pass2.018s. Canonical generation and `make check` pass (`.tmp/settings-054-main-check.log`). Two failed attempts remain preserved: the first fixture omitted its required native repository URL; the second used internal error identity and an incorrect HTTP status instead of the public Connect contract. Fixes preserve exact target checks and denial behavior. Controlled-provider204 is not actual native or bootstrap qualification; full lifecycle remains Partial.

Actual Rules attempt12 on b451/core c0 reaches a valid SUCCEEDED mutation and independently verified configuration, but its browser qualification fails because the verified receipt disappears during the component's own inventory refetch. All fresh resources clean up; the failed manifest remains `.tmp/repository-rules049-served-attempt12/manifest.json`. Fix `9b13fc1` preserves the mounted editor solely across that verified refresh, with hidden/inert and capture-blocked controls until fresh inventory verifies. Other refreshes, errors, authority loss, sign-out and account changes clear private content; no automatic status adoption occurs. All59 affected browser fixtures pass16.7s, plus TypeScript/build. A newly built served image and repeated actual Rules captures remain pending.

The prepared resource qualifier now exists in [the runtime recipe](RUNNER_JOB_LIMITS_QUALIFICATION.md); it is not yet an actual Docker pass. Retained localhost8080 continues to run047 until matching core/runner/agent images and affected runtime checks are ready. None of these increments marks the ten full settings requirements complete.

## Actual managed READ Git qualifies; resource UI and database checks pass (2026-10-04)

Managed READ attempt9 passes on source `b451ead63266c2b0b9e1b3f71a135590587067ed`, core `sha256:c0f752c8c2c1d3126958d465800c6309c5ed962066a4f90bf44aec7f50dc56d9`, actual native1.27.3 and fresh schema053. Owner and independent ordinary reader perform real host Git clone/fetch/ls-remote through Golf's direct TLS1.3 listener; independent native commit/tree entries and Git-computed blob hashes agree. One-time scoped credentials remain outside clone URLs. Own-only inventory, wrong repository/immutable IDs, instance/native admin without ordinary grants, Origin/cookie/bearer/plain HTTP and unqualified WRITE denials pass. Explicit capability revocation, parent logout, old-cap refusal after login/restart, native access removal between advertisement and upload, rename/replacement denial and restoration pass. TLS hostname verification remains enabled. Native HTTP/SSH are unexposed/disabled and native Actions disabled for this fresh fixture. All fixture accounts/sessions/repos/Compose resources clean up. Evidence: `.tmp/managed-git-read-served-attempt9/manifest.json` and log. This is serial revocation between requests, not deterministic in-flight revocation, WRITE, SSH/LFS, protected publication or P0.8 qualification. Earlier failures remain preserved, including strict CA, omitted outer RPC registration, missing fixture POST MIME, native-denial mapping and a disk guard before resource creation. Native404/401/403 now produce safe resource/auth denials instead of503; unknown upstream details stay private.

The resource controller/executor's real PostgreSQL/race families pass91.261s in isolation, and combined organization/resource/Git positive-HTTP/rule families pass72.253s on canonical main (`.tmp/runner-job-limits-worktree/.tmp/runner-resource-postgres.log`, `.tmp/settings-053-combined-postgres.log`); both databases are removed. Positive settings requests through Server.ServeHTTP independently pass4.052s (`.tmp/settings-052-positive-transport-postgres.log`). Complete instance/pool/repository requested/effective resource UI is integrated in `7e9eade`;95 source browser cases pass20.6s with fonts, both widths/themes and private late/CAS/unknown fences, and combined `make check` passes (`.tmp/settings-053-ui-main-check.log`). Earlier organization picker/route/repository-value cases pass52/52 on main13.2s (`.tmp/settings-052-picker-main-browser.log`). These source fixtures do not substitute for actual Docker limits or current served screenshots.

Matching53 runner `sha256:0a6a7444766e7f6d3667758ef249f4f7afb304cf113dbc16fc22649f79fd5c4f` and core artifacts bind the same source, new runner binary and maintained Actions engine hashes in `.tmp/settings-053-first-host-artifact-receipt.json` and pin receipts. Actual resource and organization environment execution are next; old022 remains separately preserved as a refusal fixture. The core runtime predates the newest resource UI; retained localhost8080 still runs047 pending matching qualification/deployment.

Only exact owned obsolete image pins/tags and completed owned build-cache IDs are reclaimed after host archive/content/identity verification. A legacy `golf-settings-complete-core:13f06a8` receipt disagrees with its inherited OCI source label; the archive explicitly retains that provenance mismatch and makes no source qualification claim. All other container identities/states remain unchanged, and no foreign cleanup occurs. Archive/cache receipts remain private under `.tmp/`.

## Bounded workflow job limits integrated in source; matching runtime pending (2026-10-04)

Schema053 and the complete controller/executor resource consumer are integrated with the organization descriptor in `b451ead63266c2b0b9e1b3f71a135590587067ed` (wire `16f17c4`, consumer `1b4c713`). The first local Docker profile restricts the former maxima: 1 CPU, 256 MiB memory with equal memory-swap, 64 PIDs and 900-second execution deadline. Instance/pool/repository ceilings compose by minimum, with password-confirmed current admin authority and CAS. New runs retain the effective snapshot and generation; historical missing bindings remain inspectable but cannot claim or release source/credentials/results. Current-generation fences cover assignment, source, heartbeat, logs/progress/graph and completion; no original intent adopts new limits or automatically replays. The [resource contract](RUNNER_JOB_LIMITS_CONTRACT.md) records exact fields, lock/release timing and remaining acceptance.

Pure race checks pass for runner 2.988s, runner command 1.334s, act module 3.700s and affected pure server 1.610s; vet, Buf, local sqlc drift and whitespace pass. Authored PostgreSQL cases were unrun in that packet; root's real database and combined-main checks are pending. No actual053 Docker enforcement, kernel quota/PID/OOM/timeout, lower-ceiling cancellation latency, new settings captures or recovery proof is claimed. These results do not relabel the actual047/050 pool captures or the old022 runner image.

Deployment requires matching core, runner and act-engine images: the old022 consumer does not declare `golf.runner.job-limits.v1` and receives no new assignment. Active processes stop only after maintained cancellation is observed; final transaction authorization is not atomic with remote byte receipt. Limits are per inner job container, not an aggregate reservation; act's fixed outer 2-CPU/1-GiB/512-PID envelope and concurrency two remain. Full Runners stays Partial, with larger profiles, aggregate capacity, other runtimes and scale/recovery gates open. No retained runtime changes are represented by this source increment.

## Organization sharing integrated; bounded Docker pools qualified (2026-10-04)

Complete organization execution-value source is integrated through `a45a98c`: owner-only encrypted secret/variable inventories, explicit selected-repository sharing, immutable scoped references, repository source approvals, current owner/session/version/expiry checks at admission and release, same-kind local override, cross-kind refusal, and credential-key rotation/recovery accounting. The organization settings route uses current native identity and independently verified ownership, requested editors and shared layouts. Both Save RPCs allow bounded64-KiB encoded requests so valid8-KiB escaped values plus selected identities fit; other RPC limits are unchanged. The native-ID fixture now uses JSON UseNumber, preserving IDs above JavaScript's exact-number range rather than accepting a rounded identity. Actual PostgreSQL/race org/repository execution, key and recovery families pass93.040s; the owned database is removed (`.tmp/org-values-seams-worktree/.tmp/org-values-seams-postgres-final.log`). `make check` passes on combined main, and36 affected browser fixtures pass9.8s (`.tmp/settings-052-main-check.log`, `.tmp/settings-052-main-browser.log`). These are source/database/browser fixtures; live organization environment release and current served052 UI remain pending. They do not qualify arbitrary job environments, fork release, OIDC or external Cloudflare delivery.

Actual runner-pool attempt7 passes on frozen `f231fa22e00c78979bec1f98fb05fde8b71b48b4`, core `sha256:c7fcc575e5ad3aeba33d7b1248627015e50d33d46a8c4f78acc7e8cd6e03c55a` and qualified047 runner `sha256:0222090d296cbda3725e60329a14b624c33c7d5b94711a617d8623d3e461fed5`. Two independent workers execute capacity-one work sequentially with recorded native source/log markers, queued backpressure, isolated non-root containers and cleanup. Unbound work is excluded; drain, old placement/pool pins, explicit repinning and completed-run restart/no-replay checks pass. Twelve actual dark/light1440/390 inventory and requested pool/placement editor captures pass. Native actors, managed sessions and fresh Compose resources clean up. Evidence: `.tmp/runner-pools-served-attempt7/manifest.json`, `browser/manifest.json`, seed receipt and log. Earlier attempts remain failed, including real password throttling and browser selector failures; the throttler is unchanged. Full Runners remains Partial pending configurable enforced limits, other runtime consumers, isolation and scale acceptance.

Rules attempt11 exposes pinned-native CREATE priority-zero normalization: native assigns a positive priority, so an exact zero request cannot be confirmed. `c6a4604` rejects CREATE zero before intent/native dispatch and defaults new UI rules to one; EDIT zero retains existing semantics. Pure checks,53 browser fixtures and the real PostgreSQL rule family pass; a new matching runtime must qualify actual editing. `43e7107` also adds positive tag-selection authority preflight, with affected real PostgreSQL/race cases passing20.429s and no claim of native CAS. Evidence remains `.tmp/repository-rules049-served-attempt11`, `.tmp/settings-051-rule-priority-*` and `.tmp/settings-051-tag-positive-postgres.log`.

Managed READ Git qualification is now prepared against the frozen051 core, real direct TLS and an unexposed native service. Initial actual attempts preserve strict-certificate, RPC and cleanup failures. The actual404 exposes a genuine product wiring omission: Git management handlers were registered but absent from the outer managed-browser whitelist. Organization value procedures and the outer encoded-size cap also need matching boundary wiring. All ten procedures now deny anonymous calls401, other origins/bearers403, with no-store; real PostgreSQL tests through ServeHTTP confirm both Save procedures accept supported escaped sizes and reject over-bound input (8.947s, `.tmp/settings-052-outer-boundary-postgres.log`). Disposable certificate extensions and last-native-admin fixture cleanup are corrected without bypassing TLS verification or weakening transport assertions. Actual clone/fetch qualification remains pending. Retained localhost8080 remains qualified schema047: no unverified052 artifact, unmatched agent image, retained account change or deployment is represented as Ready. P0.8 and all remaining full-section acceptance gates stay open.

## Managed Git source checks and remaining actual settings qualification (2026-10-04)

Managed HTTP Git's second source packet is integrated in `f231fa2`, with default-disabled startup configuration, canonical clone destinations, browser-only credential controls and exact empty push-mirror inventory checks. All six authored `TestManagedGit*Postgres` cases, the branch allowlist order regression and the rule-mutation family pass with the race detector against an owned disposable PostgreSQL instance (23.017s, `.tmp/settings-051-git-and-branch-order-postgres.log`); cleanup passes. Ten wired browser fixture cases pass6.7s (`.tmp/settings-051-managed-git-wired-browser.log`), and `make check` passes (`.tmp/settings-051-managed-git-main-check.log`). The earlier failed expectation is corrected to the public failed_precondition code while preserving UNKNOWN, zero replacement credentials and one original native dispatch. These are source fixtures; actual native managed-Git transport qualification and WRITE enrollment remain absent. The existing internal TLS listener provides server authentication, not mutual TLS. Existing server I/O deadlines can terminate Git requests before their separate handler deadline. P0.8 remains open.

Actual Rules attempt8 establishes that native tag acknowledgement and independent readback contain only one of two requested users in the organization fixture. The omitted personal direct administrator lacks access to that organization repository; selecting its actual organization member/direct administrator corrects the fixture without changing the success predicate. Attempt9 passes personal and organization branch/tag/merge edits, then exposes another fixture assumption: changing an unrelated reader's role does not change the repository metadata access revision. The stale-access test now changes actual repository visibility; current caller role loss remains independently tested. Attempt10 passes both mutation matrices, permission boundaries, whole-configuration and visibility drift, archived and actual-mirror refusal, then fails the first actual browser mutation receipt assertion after one HTTP200 dispatch. All three failed attempts and their exact native/accounts/sessions/Compose cleanup evidence remain preserved in `.tmp/repository-rules049-served-attempt8` through `attempt10`. Rules editing is not yet runtime-qualified.

Actual runner-pool attempt4 starts both independent workers after correcting a fixture YAML tmpfs entry that had been parsed as two mounts. It proves capacity-one sequential execution by two real Docker workers, native-source/log receipts, non-root isolated containers and unbound-work exclusion, then receives the normal password-verification rate limit during later administrator edits. The limiter is unchanged. The next fixture uses a second independently authorized repository/instance administrator for those later control phases, and records the completed capacity proof before subsequent checks. Failed attempts1–4 and cleanup remain preserved; runner-pool completion is not inferred from a partial run. Retained localhost8080 remains qualified schema047 pending matching, fully checked deployment artifacts.

## Organization deploy keys qualify; tag readback remains open (2026-10-04)

Organization deploy-key attempt4 passes on frozen6ed970c/core `sha256:df41e673383068d6aaee05d10e3051dfde65392befb98d0a1c61e049fb697227` and native1.27.3. Two owned private organization repositories share one SSH public key with separate read-only/write associations. Actual private clone, denied read-only push, acknowledged write push with independent native commit/ref readback, removal of only one association, surviving second association/push, reattachment and final new-connection revocation all pass. Current organization owner/member-direct admin management, writer/reader/team-only admin denial, private nonmember native-site-admin denial, immutable target/key/access revisions, visibility drift, Origin, bearer and revoked-session boundaries pass. All16 actual dark/light1440/390 Add/list/reload/Delete captures pass; root inspects representative desktop/mobile images. Exact native actors/repos/organization, managed fixture accounts, sessions/bearers and fresh Compose resources clean up. Evidence: `.tmp/repository-org-deploy-keys-served-attempt4/parent-manifest.json`, `qualifier-manifest.json`, `browser/manifest.json` and terminal log. Its capture helper hard-coded the caption role `personal-owner`; the separately recorded organization scope, native IDs and visible namespace establish the actual organization-owner fixture. The helper now labels both scopes correctly; old evidence is preserved. Full Access remains Partial pending its other required acceptance.

Attempts1/2 are failed proofs: a nonmember native site administrator correctly cannot obtain a private organization access observation, but the helper expected200. Attempt1 also masks its original failure with cleanup failure. Closed RPC diagnostics preserve both facts in attempt2; the fresh native instance's sole site administrator cannot be purged. Attempt3 stops at the unchanged2GiB free-space guard before creating actors. Attempt4 uses an explicitly owned unmanaged bootstrap administrator, discarded with the entire fresh instance, allowing every test actor to be independently purged. No retained account or credential changes occur.

`cf5809a` compares only exact tag allowlist membership without imposing requested ordering; duplicates, exact spelling/counts and unrelated configuration remain strict. Real PostgreSQL/race rule/access/invitation tests pass65.006s and full `make check` passes (`.tmp/settings-050-tag-order-postgres.log`, `.tmp/settings-050-tag-order-main-check.log`). Frozen dc4da6f builds core `sha256:999bbc72a20fb2db32dd31069a41a40f3296cc21026d6273e446e849b05ddbcd`; exact source/artifact/pin receipts are `.tmp/settings-050-tag-fixed-host-artifact-receipt.json` and `.tmp/settings-050-tag-fixed-core-pin-receipt.json`. Actual Rules attempt7 still returns DISPATCH_UNKNOWN at tag allowlist restoration despite clean post-readiness forwarding and successful branch/tag/empty-allowlist mutations. Cleanup passes; no runtime Rules completion is inferred. A fixture-only bounded count/equality diagnostic is prepared to compare acknowledgement and independent readback, never raw native data. Retained localhost8080 remains047.

The superseded owned408 agent and6ed qualification core are preserved in verified host OCI archives before removing their sole stopped pins/tags. Only the five completed, timestamp/description/ownership-checked tag-fixed build-cache records are reclaimed; every other container/image identity remains unchanged. Receipts: `.tmp/settings-050-initial-agent-archive.tar-receipt.json`, `.tmp/settings-050-final-core-archive.tar-receipt.json`, `.tmp/settings-050-tag-fixed-owned-cache-cleanup-receipt.json`. No broad or foreign cleanup occurs.

Managed HTTP Git's opt-in source foundation is integrated in `3e99d5f`, default disabled, with WRITE enrollment absent. Eight browser fixture cases pass3.9s (`.tmp/settings-051-managed-git-browser.log`). The first PG command used a nonmatching selector and explicitly reports no tests; it is not a qualification. The correct `TestManagedGit` run executes the six authored PG cases, retaining one failing public-error expectation: unresolved receive denies a new WRITE credential with failed_precondition. That assertion is being corrected without relaxing retained UNKNOWN or no-repeat-write requirements. Source wiring and actual native Git qualification remain pending; P0.8 stays open.

## Actual Access048 requested-role qualification passes (2026-10-04)

Actual attempt9 passes on frozen6ed970c/core `sha256:df41e673383068d6aaee05d10e3051dfde65392befb98d0a1c61e049fb697227`, native1.27.3 and separately frozen fb5f625 ARM64 fixture adapter. Personal/org owners and member direct-admin requested read/write/admin grants and twelve invitation combinations, inherited effective owner versus actual organization ownership, retained generation ABA, owner/self/role-loss/immutable-target/Origin/bearer denials, real accepted native204 acknowledgement loss, original-operation inspection/replay and restart no-resend all pass. The verified startup native-unready GET remains explicitly recorded; seven confirmed caller-aborted GETs are counted separately from provider failures. No post-readiness provider failure occurs. All12 actual font-settled dark/light1440/390 inventory/requested-role/original-receipt captures and explicit browser logout pass; exact owned native/accounts/sessions/Compose cleanup passes. Root visually inspects representative desktop/mobile and both-theme captures. Evidence: `.tmp/repository-access048-served-attempt9/manifest.json`, `browser-manifest.json`, terminal log and `.tmp/native-proxy-cancellation-artifact-receipt.json`. Full Access includes remaining organization deploy-key/Git and recovery acceptance; the row remains Partial.

The fixture closes its page before independent native membership cleanup and cookie-context logout, avoiding cleanup races; confirmed request-context-cancelled GETs retain explicit closed observations and a separate monotone counter. Deadlines, provider-only cancellation, disconnects and write cancellation remain qualification failures. Earlier failed attempt8 is preserved, not relabeled. An initial root pure-test insertion accidentally recurses inside the progress validator; moving that assertion into the pure fixture corrects it before any actual run. Both qualifier pure tests then pass.

Actual Rules attempt6 now has clean post-readiness forwarding and succeeds through branch creation/edit/removal and tag creation/empty allowlist clearing, but the next tag restore returns a retained DISPATCH_UNKNOWN instead of the expected SUCCEEDED. Native responses/independent reads are200, not transport failures. Targeted readback comparison and pinned-native allowlist semantics are under investigation; the predicate is not weakened or replayed. Cleanup passes (`.tmp/repository-rules049-served-attempt6/manifest.json` and terminal log). The Rules row and retained localhost047 remain unchanged.

## Invitation refusal correction and live Access048 attempt8 (2026-10-04)

`d59d0e7` preserves only the closed unresolved-Access sentinel through invitation acceptance's error mapper, leaving arbitrary provider/storage errors sanitized. The real PostgreSQL/race Access/Invitation suite passes54.173s, including repeat same/new acceptance keys with no native resend, reservation, generation or activity changes while the original direct outcome remains unknown (`.tmp/settings-050-invitation-unresolved-postgres.log`); owned cleanup passes. Full `make check` passes (`.tmp/settings-050-invitation-final-main-check.log`).

Frozen `6ed970c717e33033de388a7437de57b388deecbc`, core `sha256:df41e673383068d6aaee05d10e3051dfde65392befb98d0a1c61e049fb697227`, contains the fix. Exact archive/artifact/pin receipts are `.tmp/settings-050-final-host-artifact-receipt.json` and `.tmp/settings-050-final-core-pin-receipt.json`. Actual Access attempt8 passes requested personal/org roles, all invitation combinations, refusal boundaries and real native204 acknowledgement loss through restart/original-key no-resend. Its pre-actor snapshot independently records one native-unready GET failure followed by a successful native version read, with no mutation/drop/armed state. All12 actual UI captures run, then the browser qualifier fails at the final explicit logout while live access reads race native cleanup; read400/401 responses and caller-cancelled proxy GETs remain recorded. The full attempt is failed, cleanup passes, and this does not qualify editing, clean transport or the complete Access row. Evidence: `.tmp/repository-access048-served-attempt8/manifest.json`, `browser-manifest.json` and terminal log.

Actual pool attempt1 passes pool configuration, placement and role/Origin/password/CAS admission, then fails the private Compose subprocess starting both real workers before capacity execution is proved. Exact owned cleanup passes. Its prepared helper now records bounded closed operation/status/callsite diagnostics before cleanup; no raw output or credentials are retained. Evidence: `.tmp/runner-pools-served-attempt1/manifest.json` and terminal/seed logs. Organization deploy-key qualification is separately prepared with real SSH read/write/revocation/shared-key assertions and member/direct versus team-only administration; it has not yet run. Retained localhost remains047; the settings rows remain honest about their uncompleted acceptance.

## Live Access048 attempt7 (2026-10-04)

The internal-network proxy's actual cached image, read-only mounted ARM64 binary checksum and loopback-control/internal-forwarding topology match their receipts. On frozen408788c, actual personal and organization owner/direct-admin read/write/admin changes and twelve requested-role invitation combinations pass supported native readback, exact original status/replay and retained generation checks. The actual-organization-owner distinction resolves the earlier inherited-admin-team refusal. Role loss, immutable IDs, owner/self, Origin/bearer and rename/replacement denials pass. A real native204 is accepted once and its acknowledgement is deliberately lost; Golf retains UNKNOWN, original status/replay sends no duplicate, and fresh direct grant admission is blocked.

The attempt then fails: invitation acceptance overlapping that unresolved slot correctly does not dispatch, but returns500/internal instead of400/failed_precondition. This product error mapping is being corrected; remaining restart/browser assertions do not run. The forwarding adapter's two accumulated failures are absent from its final bounded observation window, so startup versus post-readiness transport failure still needs an explicit recorded baseline; no clean-transport qualification is inferred. Exact owned sessions/accounts/native actors and Compose resources clean up successfully. Evidence: `.tmp/repository-access048-served-attempt7/manifest.json` and terminal log. The whole attempt remains failed, the Access row remains Partial, and retained localhost remains047.

## Frozen050 qualification artifacts (2026-10-04)

Frozen `408788c1af95386d5ec1ea7d8fbfa456b365a7c4` builds Linux ARM64 Golf, web assets and the inside-network qualification proxy from the exact Git archive. Core `sha256:85525e234610264dd11c96fff20c7904597e9e164611c73735b5d7229eb9db28` and matching agent worker `sha256:3554cc80fa9b5f904d76454aabaddb9de58c519813555f586eecbf2bb204f46d` are pinned qualification artifacts; runtime/helper bases remain the previously qualified cached images. Artifact/source/file hashes and pin receipts are `.tmp/settings-050-host-artifact-receipt.json`, `.tmp/settings-050-core-pin-receipt.json` and `.tmp/settings-050-agent-pin-receipt.json`. Pure Go/race and Python forwarding-adapter checks pass without native calls or listeners. The initial agent host copy omitted executable mode; the unused artifact is replaced with a mode0755 build before deployment or qualification, with its failed artifact receipt retained. Actual access, rules editing and Docker pool qualification remain pending; retained localhost8080 remains047.

The coverage inventory describes the integrated organization-ownership, rule-editor and pool controls, and separately identifies remaining qualification/enforcement. Completed owned050 build-cache IDs alone are reclaimed with all container identities preserved (`.tmp/settings-050-owned-cache-cleanup-receipt.json`). The superseded049 qualification image is preserved in a verified host OCI archive before removing its sole owned stopped pin/reference; index, configuration revision and archive hash are checked, with every other container unchanged (`.tmp/settings-049-core-archive-receipt.json`). No foreign cleanup or broad prune occurs.

## Integrated pool consumers and retained run receipts (2026-10-04)

`a8d381d` integrates manual/push pool admission, existing user/lifecycle/policy/broker ordering, unlocked bounded candidate filtering, authoritative placement→worker→pool→run claims, private external-environment release only after claim commit and current authority, and immutable placement metadata through all shared run readers. The empty DRAINING audit array now remains an explicit SQL empty array. The corrected real PostgreSQL/race suite covering pools, placement, access, invitations, rules, controls and transport passes98.082s (`.tmp/settings-050-consumers-postgres.log`); the separately affected workflow/push/execution suite passes30.829s (`.tmp/settings-050-workflow-execution-postgres.log`). Both owned databases are removed. These are real Golf database/source-consumer tests, not live native/Docker pool execution qualification.

Workflow run details show the admitted pool and recorded pool/placement versions without substituting current inventory or inferring legacy placement from missing metadata. Malformed pin metadata refuses the run and log fetch. All58 affected workspace/job-graph browser cases pass39.3s (`.tmp/settings-050-run-receipts-browser.log`); TypeScript passes. Combined with the earlier121 access/pool cases, affected source UI is qualified. Real Docker capacity/placement, target-ownership/native invitation and Rules editing still need live qualification before retained deployment. The Runners, Access and Rules settings rows remain Partial.


## Runner-pool source integration and actual-ownership correction (2026-10-04)

Named local-Docker runner pools, versioned repository placement, immutable run pins, capacity/worker fences and shared requested-editor UI are integrated from `4cb271d` and `bad7f0a`. Instance pools mount in Admin runners; contextual placement mounts only with current repository administration. Canonical generation and TypeScript pass. All121 affected browser cases pass40.0s, including the49 new pool/placement cases and three explicit actual-owner/nonowner/unknown organization target cases (`.tmp/settings-050-ownership-browser-final.log`). The first118-case run retains106 passes/12 failures: a root change accidentally blocked valid new accounts with no current access, one assertion used obsolete owner-error copy, and two new tests mistook a disabled option's matcher behavior and shared fixture object references for product failures. The account predicate is corrected; independent selected-pool objects and the actual disabled DOM property retain the original refusal assertions. No product runtime qualification is inferred from these controlled browser fixtures.

`5197ad4` separates actual organization ownership from inherited effective owner-level team access. An additive optional target fact, current supported-native ownership read for ambiguous effective owner, exact account reobservation and revision discriminator preserve owner/self safeguards. Reservation, dispatch, readback and invitation recipient checks use that fact. Existing positive caller authority and legacy known-nonowner invitation revisions remain unchanged. This is source-qualified; fresh actual organization grant/invitation qualification remains required.

The first combined real PostgreSQL/race suite completes86.495s with seven new pool cases failing; affected access, invitation and rule cases pass. Five pool handler fixtures omitted the managed Origin, one negative test attempted an already-protected native-source field, and an actual empty DRAINING membership save incorrectly encoded SQL NULL for its audit array. These remain recorded failures (`.tmp/settings-050-ownership-postgres.log`); corrections and consumer integration are in progress. The owned database is removed. Full Runners and Access acceptance remain open; localhost8080 still runs qualified047.

Actual Rules049 attempts1–5 perform supported branch/tag mutations but do not complete qualification. Closed diagnostics identify a fixture's host-to-published-native GET response closing before headers, with normal forwards5–9ms and unrecovered Golf transport timeouts around10s. Attempt5 adds one explicitly counted reconnect only for an empty GET closed before response headers; writes and received/partial responses never replay. Native/managed outcome assertions remain unchanged. Attempts2/3 retain cleanup category `session` failures even though their owned native/container resources are purged; attempts1/4/5 report complete cleanup. Evidence is in `.tmp/repository-rules049-served-attempt1` through `attempt5` manifests/logs. A fresh-network forwarding adapter is being prepared to remove the flaky host crossing; no successful Rules editing/runtime readiness is claimed yet.


## Native access qualification and frozen049 runtime (2026-10-04)

Frozen source `7257036bf2559bd26be1006e97dd26d9fb7c8f56` builds fresh Linux ARM64 Golf and web artifacts, retaining the independently qualified runtime/helper base. Exact image `sha256:31f23c2bc823ac4c0fb8d3470a2a381dae4ddfe7434f88c58fc8d498a389c264` is pinned; source/artifact/runtime receipts are `.tmp/settings-049-host-artifact-receipt.json` and `.tmp/settings-049-core-pin-receipt.json`. This image is a qualification fixture, not the retained localhost deployment. Only completed, individually identified Golf build-cache records are reclaimed; existing image/container identities are preserved.

Actual Access048 attempts1–4 stop before actor creation: the helper set the OAuth public URL without its required client credentials. Product startup validation correctly refuses that inconsistent configuration. The unused helper override is removed from Access and Rules qualifiers; native ROOT_URL remains explicit. Closed startup diagnostics persist bounded categories and static configuration reasons, never raw logs, credentials or response bodies. Attempts5/6 then pass actual personal owner/direct-admin read/write/admin grant, removal and original-operation status/replay checks, but stop at the first organization grant with a real no-effect403. Attempt6 proves current issuer authority is valid and the intended non-owner target receives native effective permission `owner` through its admin team. Pinned native permission source promotes admin team access to that effective level; Golf currently treats it as actual ownership. This limitation remains open pending a positive current target-ownership distinction and qualification. All six fresh fixtures clean up successfully. Evidence: `.tmp/repository-access048-served-attempt1` through `attempt6` manifests/logs. No failed attempt is a full Access qualification; retained localhost8080 remains schema047.


## Rules configuration intents and combined049 source integration (2026-10-04)

Final client review adds fail-closed corrupt/unreadable original metadata, synchronous submit/status exclusion, account-away-and-back epoch fencing and strict phase/failure/revision/timestamp receipts. Global account/logout cleanup uses a separate small metadata module, retaining lazy editor loading. Existing native tag EDIT can explicitly clear both allowlists; native CREATE continues to require an account/team. Source payload admission verifies explicit empty arrays. All52 affected rules browser cases pass10.6s (`.tmp/rules-049-safety-browser-final.log`), and real rule mutation/tag/concurrency PostgreSQL regressions pass13.857s with owned cleanup (`.tmp/rules-049-tag-and-concurrency-postgres.log`). Final `make check` passes and the subsequent extracted cleanup module's TypeScript check passes. Earlier safety runs retain50/52 and24/26 passing cases with two test failures: synchronous DOM click occurred while the original mutation still disabled status inspection, and Playwright's raw exact label text included an initialized textarea value. Root also moved the cleanup export during the first run, allowing development hot reload; the same failures persist in a stable rerun, so that interruption is not claimed as their sole cause. The focused debug passes inspection and retains the label failure. Waiting for the actual unknown receipt and using the exact accessible textbox name corrects the fixture without weakening product assertions or inventing a verified outcome. Actual native write qualification remains pending.

The separately reviewed dispatch fallback rechecks current native authority after a competing same-key SQL reservation wait. Three real PostgreSQL concurrency regressions now pass with the rule mutation family14.019s (`.tmp/rules-049-concurrency-postgres.log`): native prewrite hold serializes queued logout; postflight behind completed logout preserves original uncertainty without a success event; an exclusive archive waiter observes the unresolved049 count and releases without nested-lock deadlock; revocation before dispatch locks produces zero native writes and fresh-session original-key status cannot resume it. The source fixtures use supported HTTP providers plus the owned Golf test database, not actual native dispatch. Exact owned database resources are removed.

For the next frozen image, exact prior-owned completed compilation mounts are checked against `.tmp/settings-credentials-owned-build-cache-identities.json` before reclaiming only their IDs. The npm mount yields302.9MB; the already-empty Go mount yields0B. All existing container image identities and running states remain unchanged; `.tmp/rules-049-prior-owned-cache-cleanup-receipt.json` retains the ownership/current-state proof. No broad/foreign prune or Docker-wide configuration change occurs.

Source packet `40a5c66` adds explicit requested branch/tag create/edit/remove and merge-default editors with metadata-only original-operation journals. Main integrates the existing managed cookie/Origin/no-store boundary for all three Rules methods, current ordinary repository-administration admission, canonical generated048/049 contracts and lifecycle active accounting that preserves access/invitation/execution/delivery families. Native writes use supported APIs, independent whole-configuration readback and current authority; observations do not establish native atomic CAS, trusted-check provenance or P0.8 protected publication. Unknown outcomes remain inspection-only and block fresh rule operations/archive.

Integration review finds the new status handler incorrectly required an empty access revision, rejecting every valid inspection. Identity-only route/native IDs/UUID checks replace that call; real PostgreSQL success and accepted-ambiguous cases now inspect the original receipt without another native write. Dispatch initially held only a shared lifecycle transaction while separate outcome transactions reacquired that lock; queued exclusive archive could stall it, and local logout was not serialized through dispatch. The existing account/session workflow transaction now holds the account, session and shared lifecycle gate through the supported native request, then releases them before independent readback/outcome. A separate concurrency regression is being prepared; no actual native revocation qualification is claimed yet.

Main `make check` passes (`.tmp/rules-049-main-check.log`) and combined real PostgreSQL/race checks across rule mutations, access, invitations, lifecycle, runners and rule observations pass102.511s with exact owned fixture removal (`.tmp/rules-049-combined-postgres.log`). All77 affected main browser cases pass22.7s, including the canonical current-admin editor route, explicit form opening, denied metadata clearing and both-theme/mobile inventories (`.tmp/rules-049-main-browser-verified.log`). Two earlier browser runs each retain75 passes plus one obsolete read-only-copy assertion failure; a root edit attempt used the wrong working directory and therefore did not change that assertion. A subsequent launch stops before executing tests on a new test-only argument syntax error. The corrected source and unchanged semantic/privacy assertions produce the passing run; none of the incomplete runs is relabeled passing. These remain source fixtures, not actual native editing. Retained localhost8080 remains qualified schema047; full Rules and the other unmet settings acceptance conditions remain open.


## Live runner qualification and local schema047 deployment (2026-10-04)

Actual runner attempt5 passes on frozen `e576467df4aabc7aa689490af839e470c0e26fb4`, core `sha256:f4d5005782aef2936f9610d8da7e4c09172d5063f39e8f80ec5e32a6bdd597ea` and separately qualified13f06 runner `sha256:0222090d296cbda3725e60329a14b624c33c7d5b94711a617d8623d3e461fed5`. Ordinary managed instance admin, ordinary/native admin denials, current-password confirmation, stale versions, immutable repository/workflow identities and Origin/bearer boundaries pass. Independent protocol-worker source/heartbeat/log/finish checks are labeled separately from actual Docker jobs. The actual worker runs a slow job while draining: heartbeat leases advance, later logs and successful completion survive, a second job stays queued, Resume releases it, and Revoke cancels a live attempt with independently empty owned container/volume inventories. Terminal revocation survives core and worker restarts and the old identity cannot claim queued work. Twelve actual font-settled dark/light1440/390 admin inventory/requested confirmation/repository-policy captures pass; root inspected the dense dark desktop table. Owned accounts, native actors, Compose containers/volumes/networks and attempted job resources are cleaned. Evidence: `.tmp/runner-controls-served-attempt5/manifest.json`, `browser/manifest.json` and terminal/seed logs. Named pools, capacity/resource ceilings, Kubernetes/Cloudflare execution and the complete Runners row remain required.

Earlier runner attempts1/2 retain their real denied-update error failure and successful owned cleanup; attempts3/4 stop at the Docker2GiB reserve check before creating resources. Exact completed owned stage/source/rehydrated-base/helper-copy build-cache records are reclaimed, with qualified image identities preserved. The superseded9b9f67e Rules-qualified fixture image is preserved in an exact OCI archive on the host before removing only its Docker pin/reference; `.tmp/settings-047-qualified-core-archive-receipt.json` records its index/source and archive checksum. Initial archive assertions mistakenly compared truncated container IDs and then an OCI index digest to a config digest; both refused removal. The corrected verification checks the OCI index blob digest, config source label and sole owned stopped pin. No retained/foreign resource is reclaimed.

Localhost8080 now runs schema047 on exact frozene576 core plus matching Golf-binary agent helper image `sha256:d95d1e53c4bbb29992fcf1e0ca8d0a758ab801bb42066cfdb6651b959ecd2cbd`, qualified13f06 runner and matching core webhook worker. Deployment starts with zero workflow/agent/webhook queues, preserves native infrastructure, accounts, provider grants, runner catalogs and notification destinations, and applies normal additive Golf migrations. Four document routes and the anonymous managed runner boundary pass; all four image identities/processes are verified (`.tmp/settings-047-retained-deploy-receipt.json`). The first post-deploy check confused a runner receipt tag with its digest; the explicit digest override is corrected. A second HTTP check omitted document Accept and received the intended404 SPA boundary; correct document requests pass. Neither is an application failure. Saved Golf sessions remain database-backed. Actual secret-bearing retained worker use still requires its separate TLS coordinator configuration; local HTTP presence does not qualify that channel.

## Durable access intent integration and combined source checks (2026-10-04)

Source048 is integrated as `1a5e1bd`, retaining047 generation, with managed GetRepositoryAccessOperation registration and global account-change/logout metadata clearing. Actor-owned original keys, per-target retained generations and invitation/shared-slot checks prevent replay and hidden Golf add/remove ABA beneath higher effective team permissions. Unresolved native/SQL outcomes retain their original identity and block fresh overlapping grants/archive; status inspection performs no repeat write. Known pre-reservation semantic refusal can expose the closed no-effect marker for explicit dismissal followed by a separately reviewed fresh intent. Saved client metadata contains only original IDs/revisions/role/action, never credentials or RPC bodies.

The first real combined Access/Invitation/Lifecycle/Runner/Rules PostgreSQL race suite fails87.856s in four Access refusal-code assertions; new Access handlers rewrapped typed precondition errors as generic Internal. `80b76cd` uses the existing infrastructure mapper in all three intent/status handlers, preserving closed codes/metadata while raw provider/storage errors remain sanitized. The unchanged assertions and combined suite then pass86.472s with exact owned database removal (`.tmp/access-048-combined-postgres-final.log`); original failure log remains `.tmp/access-048-combined-postgres.log`. All81 affected main Access/deploy-key/team/invitation browser cases pass32.5s (`.tmp/access-048-main-browser.log`). Main048 TypeScript, generation and final `make check` pass (`.tmp/access-048-final-main-check.log`). This packet is source-qualified; current retained schema047 does not yet contain048. Actual changed-protocol native grants, write/admin invitations and organization Git/deploy-key qualification remain pending, as do the full Access row and all remaining settings requirements.

## Actual Rules readback and runner denial correction (2026-10-04)

Rules attempt2 passes on fresh frozen `9b9f67e3191ca6bdd45745fa5ec7d31a8ab47d54`, exact image `sha256:85c3027a41bbe47a69b1183a13d765711dded4e406cd86d7010fe8c46adbb668`, native1.27.3. Independent supported-native whole branch/tag arrays and merge flags, exact large numeric values, positive personal/org owner and direct-admin authority, denied team-only/global/reader, current role loss, serial rule revisions, exact stale targets, archived/mirror readable configuration, native rename/replacement and Origin/bearer/logout boundaries pass. Twelve actual font-settled dark/light1440/390 inventory/details/reload captures pass. Root inspected the actual dark desktop inventory. Owned native actors, repositories, organization, local sessions/accounts and fresh Compose resources are removed. Evidence: `.tmp/repository-rules-served-attempt2/manifest.json`, `browser-manifest.json`, terminal log. This qualifies observations, not editing, atomic matching/precedence, trusted checks or protected merge enforcement. Attempt1 remains failed at its2GiB disk-reserve check before resource creation. Exact owned completed Golf build-cache records were reclaimed; image identities remain verified.

All34 new runner-wrapper/shared-access-hook/real-route browser cases pass22.0s, including close during held loading, late receipt suppression, empty close/reopen fresh paths, denial, immutable target replacement and mobile/theme layout (`.tmp/repository-runner-settings-close-final.log`, test commits `bf69c73`, `d3e9533`). These are controlled source fixtures, not running worker proof.

Actual runner attempts1/2 remain failed before execution; both clean up their owned fresh stack. Attempt2 preserves safe boundary failure metadata and identifies a real error mapping defect: an ordinary local nonadmin UpdateRunnerControl denial was rewrapped as generic500/internal instead of403/permission_denied. No control was authorized. The handler now uses the existing infrastructure error mapper to preserve already-classified permission errors, including transaction rechecks. A regression asserts nonadmin, native-token and OAuth update refusals remain permission_denied; real PostgreSQL runner race checks pass9.874s with owned database removal (`.tmp/settings-047-runner-denial-postgres.log`). Both native live runner execution and retained deployment remain pending after this correction.

## Runner settings integration and organization authority (2026-10-04)

The enrolled-runner control service is registered behind the managed browser boundary, with dedicated `/admin/settings/runners` and `/OWNER/REPO/settings/runners` routes, shared navigation and breadcrumbs. Repository inspection requires explicit workflow selection from an independently identity-checked current workflow inventory. Instance administrators use existing versioned drain/resume/terminal-revoke controls with current-password confirmation. Rules and runner read pages share the existing exact repository-access observation behavior. Neither enrolled presence nor a lease claims worker health, pool capacity or full runner readiness.

Main `make check` passes and all72 affected runner/rules/access/deploy-key source browser checks pass24.8s (`.tmp/runner-controls-root-main-check.log`, `.tmp/settings-runner-access-rules-browser.log`). The first real PostgreSQL race suite fails76.423s only in the new repository-runner test fixture: it omitted the native canonical repository URL required by the existing shared read guard. The fixture is corrected without weakening the guard; focused real runner PostgreSQL race checks pass9.479s with owned database removal (`.tmp/settings-047-runner-postgres-final.log`). The original failed suite remains recorded at `.tmp/settings-047-access-rules-postgres.log`. These are source checks, not actual Docker drain/revoke or retained deployment proof.

The organization-authority source packet allows current organization owners and current member/direct administrators to manage direct grants and deploy keys, with native repository-admin proof. Golf global administration and effective team-only permission do not confer direct-grant administration. Effective native access is labeled separately from direct membership; role changes record explicit requested intent rather than inferring a stored direct role from higher inherited permissions. Nested supported writes reuse their held lifecycle transaction, avoiding a queued archive writer deadlock. Durable cross-actor access generations and actual organization Git qualification remain separate follow-up gates. Prepared runner qualifier `e513b25` adds independent protocol and real Docker worker checks plus twelve actual UI captures; its self-check passes, but it has not run yet. The retained stack remains the earlier schema041 deployment.

## Actual invitation and current-generation email qualification (2026-10-04)

Invitation actual attempt2 passes on frozen13f06 core/native1.27.3, with exact owned target cleanup (`.tmp/repository-invitations-served-attempt2/manifest.json`). Ordinary personal owner/direct administrator and organization owner/member-direct administrator cases, explicit persistent issuer consent across logout, absent native grant before acceptance and exact read grant afterward, original-key replay/status, rejection/revocation/expiry, issuer disable/password-version replacement, recipient logout, stale edit refusal, hidden lost authority, native rename/replacement and fourteen Origin/bearer denials pass. Twelve actual font-settled dark/light1440/390 inventory/editor/confirmed-inbox captures pass, including a deliberately withheld valid browser response inspected through the original durable key without another grant request. Root inspected the served desktop Access inventory. This is browser acknowledgement-loss evidence, not native PUT or final SQL acknowledgement-loss qualification. First attempt remains failed at its helper's session logout because it omitted Connect-Protocol-Version; d2bfa92 fixes both logout calls and capture font settling, with cleanup passing for both attempts. Actual write/admin invitations, organization direct collaborator/deploy-key administration and effective versus direct-role correctness remain concrete Access work.

SMTP actual attempt5 passes on the same13f06 core, independently confirming045 observations alongside real implicit-TLS SMTP (`.tmp/email-notifications-served-attempt5/manifest.json` and `browser-manifest.json`). Exact active transport identity/version/generation, zero versus one connected/recent worker, latest CREATED queued versus relay-accepted delivery and stop/start/restart changes are checked separately. Activating version2/generation2 has no inherited old-generation delivery evidence; its own new verification is independently accepted by the relay. Existing verification, category subscription, logout/restart, retry/lost DATA ACK, original redelivery, explicit unsubscribe and native/local revocation cases pass again with unchanged receiver bytes on denied work. Twelve served account/repository/admin captures include four actual admin observation tables matched against the exact RPC plus independent owned relay receipts. Parent status/cleanup both pass and browser status records its independent completed stage before parent cleanup. Connected workers are not health; SMTP250 is not inbox delivery. No provider inference, external destination or retained relay/subscription change occurs. The initial invocation missing --sink-image exits before resource creation and is recorded separately in the arguments log.

Rules source c1b486 is integrated as f3aec99. Root adds the managed browser-only route/client/HTTP registration, exact parent repository identity checks, contextual navigation and breadcrumbs at `/OWNER/REPO/settings/rules`. Archived/mirror readable observations are not incorrectly gated by write-only canManage. Main check and generated drift pass. All25 Rules browser cases pass8.9s after correcting the main-route development StrictMode read-count expectation; the preceding combined58-case run passes57 and retains its single incorrect count assertion, and the unintended unedited25-case retry remains24/25. Collaborator/deploy-key density cases pass in that combined run. Shared CSS reduces empty-table padding and duplicated profile margins while keeping readable font sizes and mobile targets. Actual served Rules qualification and full enforcement remain pending; this source is not the retained deployment.

## Real TLS execution-value qualification and invitation hardening (2026-10-04)

Actual execution-value attempt3 passes on exact fresh source `13f06a857a20d9ed9630aa6964457ca5b164a872`, core `sha256:b678b0c74aa4bb98b995629d9799974a49ace6308bea7434a118a1eab69c693c` and runner/helper `sha256:0222090d296cbda3725e60329a14b624c33c7d5b94711a617d8623d3e461fed5`. TLS1.3 admission, wrong-host/CA/TLS1.2 refusals, exact native source and pinned matrix/dependency execution, seven Origin/bearer boundaries, value CAS/replay and metadata privacy pass. Real output is encrypted and unreadable until verified completion; successful output masks the exact synthetic secret across independent4096-byte forwarding chunks while retaining original job/step provenance. Secret replacement, current native administrator loss, approval-session logout and binding removal each stop the live attempt without publishing raw output. Drained key rotation covers both execution credential families, refuses premature legacy retirement and restarts successfully without the old key. Twelve actual mounted settings/editor/selected-run captures pass both themes1440/390, fonts/privacy and no browser mutation. Root inspected the dense dark desktop inventory. Managed sessions/accounts, ordinary native actors, containers, networks and volumes are cleaned. Evidence: `.tmp/repository-execution-values-served-attempt3/manifest.json`, `browser/manifest.json` and terminal log. Full scoped inheritance/OIDC, fork/push/agent/CD consumers and the Secrets row remain incomplete.

`13f06a8` integrates additive046 allowing the actual empty step coordinate of admitted job-level logs in encrypted quarantine. It preserves original coordinates rather than assigning logs to a fictional step. Exact replay, changed-coordinate refusal, unknown jobs/steps, TLS admission, encrypted-only precompletion storage and cross-coordinate masked release have real PostgreSQL regression coverage. Runner ACK diagnostics expose only allowlisted frame kind, scope and numeric HTTP status; response bodies, coordinates, source text and credentials remain private. Earlier actual attempts1/2 remain failed as recorded below.

`b995554` completes the invitation source refinements: concurrent issuers share a serialized per-repository quota, and final success requires another current issuer/recipient/target revision check after native collaborator readback. The source fixture uses `proto.Clone`, avoiding a copied protobuf mutex. The combined041–046 PostgreSQL race suite passes130.829s with zero remaining test schemas and exact owned-container/volume removal (`.tmp/settings-041-046-combined-postgres2.log`). The first broad source fixture enters recovery under its512MiB temporary database limit; it is not a passing run. The successful rerun occupies567MiB, consistent with insufficient fixture capacity. The1GiB rerun retains container/disk diagnostics (567MiB occupied at completion) and succeeds without retained database changes. Focused runner/server race checks also pass. Prepared invitation native/browser helper `03bfc7e` is integrated and its actual fresh qualification is running; latest email045 observations and retained deployment remain separate gates.

The exact compiled core/runner inherited old OCI revision labels from their frozen bases; root applies a metadata-only final layer with the correct immutable13f06 source label. Original build metadata, both original and final image identities and stopped read-only/network-none/capability-dropped pins are retained. Only exact newly created completed build scratch/cache records are reclaimed; no broad or foreign cleanup. The local review instance is still unchanged until the new runtime qualification gates finish.

## Invitation inbox and operational email observations integrated source (2026-10-04)

Invitation044 packet `8b6a597` is integrated as `31ea16c`, preserving combined041/042/043 models. Root registers seven concrete managed-cookie/Origin/no-store methods and the existing shared typed client; delegated API bearer access is refused before decoding. The contextual Access page keeps the invitation panel mounted only through a verified same-target refresh, hiding private content while revalidating. `/account/invitations` is a full account page with contextual navigation and breadcrumbs. Only existing-account invitations are supported; no email-claim acceptance or global-admin permission bypass is introduced. Root maps the closed, wrapped issuer-authority sentinel to fixed403 guidance without exposing underlying private detail. Independent review identified repository-quota serialization across issuers and a final native issuer/target observation after collaborator readback; `b995554` integrates and source-qualifies those fixes. Actual native qualification remains separate. Full Access remains Partial.

Operational SMTP source packet `96ca63b` is integrated as `787a141` with additive045 metadata index. The existing current-instance-admin transport read now also returns a bounded exact-generation observation, guarded against configuration changes during the read. Saved active configuration, connected/recent database worker ownership and the most recently created exact-generation delivery are separate facts. UI validation refuses inconsistent generation/active target, stale claimed activity, unbounded counts and fabricated acceptance. The compact shared table explicitly states that worker connection activity is not delivery health and SMTP250 is not inbox delivery. The global section-heading rules align nested headings/icons rather than styling this page separately. Actual served045 observation qualification remains pending; existing SMTP848 proof remains valid for its narrower source.

Integrated source browser qualification passes all93 cases in1.2m, including invitation creation/inbox/status-only replay/privacy, existing collaborators/teams/deploy keys, email controls and operational-observation counterexamples (`.tmp/invitations-status-integrated-browser2.log`). The first launch used the root working directory without the web Playwright configuration and fails89 navigation cases with invalid relative URLs while four pure tests pass; it is not application qualification and remains separately preserved. The corrected run uses the explicit web workspace/configuration. TypeScript and Go server/command checks pass; current HTTP boundary and closed error checks pass separately. Source fixtures do not replace actual native integration, latest schema recovery or retained deployment.

Actual execution-values attempts1/2 on the frozen848 core/runner remain failed with exact fresh-project cleanup passing. Attempt1 groups completed one-shot prerequisites into Compose's running-service wait; the helper now starts them separately. Attempt2 independently verifies TLS1.3, wrong hostname/CA and TLS1.2 refusal, exact public job/daemon digest receipts, value CAS/replay/status, seven Origin and seven bearer denials, and refusal of HTTP/no-capability assignment. Real execution then fails at `durable_frame_ack`, stores neither quarantined nor readable output, and expires without replay. Closed worker-stage metadata is retained; synthetic secret/raw logs are never persisted to evidence. Source investigation identifies an incompatible constraint: admitted engine job-level setup logs carry an empty step coordinate, but042 rejects it in encrypted quarantine. An additive046 fix and regression are being prepared; no secret execution readiness or retained042 deployment is claimed.

## Real portable SMTP qualification and frozen execution images (2026-10-04)

Actual SMTP attempt4 passes with both parent `status: passed` and `cleanup: passed`, on core `sha256:4a7d6e33f42d723ca2f465d8523097c9b5ba3ae2f9465a1148bf62162c64e08a`, frozen source `848eeae39fe7d749f8977b579385a6eb9fdf7cba`, native1.27.3 and the exact owned Python TLS465 receiver. The consumer performs real one-time own-mailbox verification, committed private-repository category notices, explicit background consent across logout, backend/worker restart without replay, temporary451 retry, lost DATA acknowledgement with possible duplication and identical frozen body/Message-ID, explicit redelivery, inert unsubscribe GET and explicit POST, and refusal of an old unsubscribe capability after consent replacement. Removing current native access and disabling the local account cancel pending mail with unchanged receiver connections and receipt counts. The private issue body is absent from mail. Codes, unsubscribe capabilities and message bodies remain transient RAM; evidence stores only fixed outcome metadata and hashes. Twelve actual font-settled dark/light1440/390 captures pass privacy, dense table/editor, reload/no dispatch and live read-revocation checks; root inspected the actual dark desktop repository view. All exact fresh-project actors/accounts/resources are cleaned. Evidence: `.tmp/email-notifications-served-attempt4/manifest.json` and `browser-manifest.json`.

Attempts1–3 remain separately failed, with cleanup passing:1 exposes unpublished loopback control ports on an internal-only receiver network;2 expects a nonexistent issue outcome enum;3 completes the mail/retry/unsubscribe checks and twelve captures but incorrectly expects404 rather than the explicit403 revoked-consent redelivery refusal. Root helper fixes `8ffe178`, `6c61261` and `894bc2b` correct those fixture contracts and preserve failed-procedure metadata. No product error is hidden or whole failed run relabeled as passing. Actual SMTP250 is relay acceptance, not inbox delivery. Real authenticated STARTTLS/public sender domains, Cloudflare/API adapters, richer semantic notifications, production scale and latest-schema recovery remain unqualified; the full Notifications row remains Partial.

The same frozen core includes fresh Golf binary/web bytes, with unchanged separately qualified provider/helper bytes inherited from the pinned webhook image. Fresh runner/helper image is `sha256:276d6f37f91f281e6a62cbb7fcf06adb0062ddd3e9b5bc95f6fc51e0ed209a32`, source848eeae. Both have stopped, network-none/read-only/capability-dropped proof pins and separate build/identity receipts under `.tmp/golf-settings-credentials-image-pin-receipt.json` and `.tmp/golf-settings-credentials-runner-pin-receipt.json` and `.tmp/settings-credentials-runner-build*`. Only exact completed owned compilation cache is reclaimed, with retained/pinned container identities unchanged; no broad or foreign resource prune. Real TLS secret-bearing Actions execution is the next separate running gate. The retained product still serves schema041/sourcefeccc58; these images are not yet its deployment.

## Integrated execution values and verified SMTP settings source (2026-10-04)

Email packet `d93336d` is integrated as `ae0cab0`, with root-managed browser wiring in `45998f9` and optional consumer packaging in `07ee0f7`. All eleven RPCs retain cookie/Origin/no-store authentication and exclude delegated API bearer access. Verified notification mailbox/preferences live on `/account/settings`; own repository subscriptions and history share the existing Webhooks settings page without a second sidebar. Named immutable SMTP versions and explicit activation have an Admin portal page at `/admin/settings/notifications`. The opaque unsubscribe endpoint is registered outside managed sessions: opening its GET confirmation changes nothing; explicit capability POST can unsubscribe. Invalid operator egress policy fails startup before database use. `compose.email.yaml` is optional and does not configure a relay or subscription. Email source integration passes fifteen browser cases22.8s, Go server/command checks and closed HTTP boundary checks0.390s. Actual SMTP/native/browser delivery remains a separate upcoming qualification; retained email is not activated.

Execution-value packet `512a448` is integrated as `5dd59ba` with canonical schema041/042/043 generation. Central key inventory, required-key checks, legacy authentication, activation, bounded rotation, retirement and named crypto audit include both repository-value/quarantined-output families and notification contents. Seven browser-only methods have the shared session/Origin boundary and safe conflict/approval error mapping. `/OWNER/REPO/settings/secrets` uses the shared contextual layout, generated client and explicit inventory/editor controls. Actions validates publication receipts and displays withheld output separately from empty ordinary logs; masked published logs carry their actual receipt. Publication state is part of private log cache/mount identity so release starts a fresh read and pagination. No secret-bearing ordinary HTTP runner, fork, shell, agent, CD, OIDC or organization/environment-inheritance readiness is claimed.

Root combined real-PostgreSQL/race qualification passes91.344s (`.tmp/secrets-email-combined-postgres.log`) across execution values/output, email, webhooks, lifecycle and relevant execution policy tests. Its exact owned cached-image32953/tmpfs fixture has zero remaining schemas and is removed with volumes; no native/product/provider runtime is exercised by this source suite. Main `make check`, generation drift and TypeScript/web build pass. The first integrated111-case browser attempt passes106 and fails five unscoped assertions/absent mail-history fixture observations after adding sibling settings panels; those failures remain separately preserved. Correctly scoped section assertions and explicit unconfigured mail fixtures yield110/111 in45.7s, with one lost-response editor case timing out before form entry. That case passes alone2.8s and the full affected webhook page passes all twelve16.5s (`.tmp/webhook-lost-ack-focus.log`, `.tmp/webhook-email-parent-final-browser.log`). The passing cases include the actual product secrets route/client/layout, lost-response/no-replay privacy, denial clearing, both themes/mobile and withheld-output byte refusal. This is source-fixture UI evidence, not actual TLS runner execution or SMTP delivery. Neither incomplete broad attempt is relabeled as a fully passing run.

The retained product remains the qualified `feccc58`/schema041 core and matching workers recorded below. These newer042/043 settings remain source increments until exact new images and disposable native/TLS/SMTP qualification pass. Full Secrets and Notifications rows remain Partial; the ten complete acceptance requirements are unchanged.

## Archive qualification and local settings deployment (2026-10-04)

Actual lifecycle attempt2 passes on the unchanged combined image `sha256:43a1b0d5d1849a819fa0f81c00e8449bfb6506c1c126d597c5420a3984bdede8`, source `feccc586e7db1bb30f2d0da55457f36394dd739d`. Personal and organization ownership, no global-admin override, password/confirmation/identity boundaries, stale observation refusal, once-only durable archive/unarchive receipts, status-only replay, exact source preservation and archived Golf-managed issue refusal all pass. Twelve actual dark/light1440/390 captures and ten once-only UI intents include independent native readback, reload and an accepted-write/lost-browser-response case inspected without another mutation. All owned repositories, organizations, native actors, sessions and fresh Compose resources are cleaned (`.tmp/repository-lifecycle-served-attempt2/manifest.json`). Root inspected the actual dark desktop settings page. Native PATCH acknowledgement loss, external Git/native scheduling fencing, transfer/deletion and recovery remain unqualified; the full Danger row stays Partial.

Attempt1 remains failed separately: its native/API slice and twelve captures complete, but later browser/cleanup checks do not qualify. Source `b357266` preserves the original browser error and adds closed lost-response diagnostics, distinct disposable account rate buckets without relaxing the production limiter, and supported native admin deactivation before purging the fixture's last active administrator. No native database edits or retained account changes are used.

The retained local app now serves the above exact qualified image with schema041. Its matching agent worker is `sha256:aadd52e5bdfcb95d74d872674031ba1bf76eeaaca7a7461bee9590f6883339d5`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. The generic webhook worker uses the exact core image. Workflow and agent queues are zero before and after; database/forge readiness passes and all workers run. The first guarded redeploy starts the core but fails later when Docker loses its autogenerated core tag; a pinned-image override restores the runner and builds the matching worker, and the default aliases are restored afterwards. Separate failure/build/restore logs remain under `.tmp/settings-lifecycle-retained-deploy.log`, `.tmp/settings-lifecycle-agent-worker-build.log` and `.tmp/settings-retained-*-restore.log`. No execution catalog, provider grant, notification destination, retained password or account permission is changed. These deployed controls qualify General configuration and the bounded team/webhook/archive slices, not all ten settings sections.

Email043 and execution values042 are the next source integration and owned-runtime gates. Their source-only checks must not be presented as retained delivery or secret-bearing execution.

## Combined schema041 image and served settings regressions (2026-10-04)

Fresh combined core/web image `sha256:43a1b0d5d1849a819fa0f81c00e8449bfb6506c1c126d597c5420a3984bdede8`, source `feccc586e7db1bb30f2d0da55457f36394dd739d`, includes the archive admission gate and shared dense table actions. Its fresh Go binary and web bundle are built from the clean frozen tree; unchanged provider/helper bytes come from the separately pinned qualified webhook proof image. The image is protected by an unstarted, network-none, read-only, capability-dropped proof pin (`.tmp/settings-lifecycle-image-receipt.json`). Only exact completed owned compilation/web scratch is reclaimed; all retained and pinned identities are checked unchanged. No foreign resources are pruned.

Actual webhook attempt9c passes on this image with twelve new served captures and full owned cleanup (`.tmp/outbound-webhooks-served-attempt9c/manifest.json`). It additionally queues a delivery while the consumer is stopped, disables the authorizing local account, and verifies preclaim cancellation with exact `authorization_or_configuration_changed`, zero attempts/duplicate flag and zero additional receiver requests. The earlier9 attempt fails the reserve check before any fixture;9b completes the preceding delivery/browser checks but incorrectly expects the in-attempt native revocation reason for this before-claim cancellation. Both remain separately preserved; source `36c1bf9` corrects the exact expected receipt without permitting a send or arbitrary failure. Root inspected the new actual dark390 inventory: compact rows, shared44px mobile actions, no document overflow and a keyboard-accessible horizontal table region.

Actual team-access attempt5 also passes on this combined image with the new shared forge write gate and twelve served captures, exact associations, current owner/role/target/response-loss boundaries, cleanup and runtime stability (`.tmp/repository-team-access-served-attempt5/manifest.json`). These checks qualify those existing feature slices on schema041, but do not qualify archive/unarchive itself. Its native/browser qualification is the next gate before retained deployment. The retained product still remainsb26/schema039; no runner catalog, provider grant, retained account or notification destination is changed.

## Integrated archive/unarchive settings source (2026-10-04)

Lifecycle source `66ace34` (isolated packet `20eb9dfa5dd379fc8b88b65551b18a930d7aa6b2`) is integrated with schema041, durable own-user intent/status records, current personal/organization ownership, local password step-up, one supported native archive PATCH and independent acknowledgement/readback. The shared repository SQL admission gate and supported forge HTTP write hook fence unresolved/archived managed repository effects; no external native Git/SSH ingress or atomic native-ID CAS is claimed. True/unknown native Actions-unit observations refuse dispatch; default installation configuration separately disables native Actions. Transfer/deletion and recovery remain open. See [Archive lifecycle contract](REPOSITORY_LIFECYCLE_CONTRACT.md).

Root registers all three methods through the existing cookie/Origin/no-store managed browser boundary, excludes delegated API bearer access, exports the shared client and mounts the stable settings panel with independently pinned native target discovery. Canonical error mapping now preserves lifecycle precondition guidance for ordinary existing write handlers. The full section remains Partial. Source `make check` passes (`.tmp/repository-lifecycle-integrated-check.log`);94 integrated General/access/team/deploy-key/webhook/lifecycle browser cases pass30.0s, including actual source-fixture font loading, original operation identity/revalidation/lost-response privacy, actionable coverage links and compact table-action rows (`.tmp/lifecycle-integrated-settings-browser.log`). The preceding76-case density slice passes29.5s. Source checks do not substitute for the forthcoming disposable native archive qualification, a new product image or retained deployment.

## Actual outbound delivery and organization-team access (2026-10-04)

Fresh webhook attempt8 passes on core `sha256:7c27a8714b5d57ceaa6717ab6e8c11288288aef540793cd55099cdd23ded1eb9`, source `e697ecdf16bd26b4d7aa39bdf10b071924f4237e`, native1.27.3 and the explicitly selected local Python HTTPS receiver. Ten actual requests have independently verified HMAC over timestamp/event/body, with only public signature/hash metadata retained. Actual logout continuation, restart without repost, a real issue activity producer with private body excluded, transient503 retry, accepted-before-lost-HTTP-ack duplication, stable-event explicit redelivery/replay, redirect refusal, TLS hostname denial before receiver bytes, current native-admin revocation without send and local-account disabling all pass. Twelve served dark/light1440/390 captures pass actual Add/Edit/test/history/reload/duplicate confirmation and live private editor clearing. Cleanup passes and runtime identities stay unchanged (`.tmp/outbound-webhooks-served-attempt8/manifest.json`, `browser.json`). Root inspected actual desktop/mobile inventories. Attempt7's twelve captures and delivery checks passed but its parent helper expected403 after removal of the sole collaborator grant on a private repository. The corrected rerun independently checks native GET404 and Golf404; the earlier failed attempt remains preserved. This proves the owned internal HTTPS443 operator-exception profile and generic repository activity, not production public DNS/TLS, semantic Slack/Cloudflare/email notifications, SQL acknowledgement loss, latest040 recovery, Kubernetes egress or million-scale fanout.

Fresh team-access attempt4 passes on the same exact core image/source. Native ordinary actors, positive organization membership, current organization owner plus native repository-admin gates, protected teams, exact association readback, stale/external edits, role loss, native rename/replacement, Origin/read-only bearer/logout and twelve served captures all pass. The real accepted-write/lost-browser-response case permits inspection without replay or false success attribution. Exact current-owned-target cleanup now passes and runtime remains unchanged (`.tmp/repository-team-access-served-attempt4/manifest.json`, `.tmp/repository-team-access-served-attempt4.log`). This completes bounded existing-team associations, not invitations/custom roles or the entire Access section.

Source presentation now acknowledges these implemented slices, leaves both full sections Partial and links available repository controls directly from the coverage inventory. The mobile webhook screenshot exposed form-level action margins/wrapping inside table cells; shared table CSS now keeps action groups in one compact row while preserving44px mobile controls and horizontal table scrolling. The webhook header reuses the existing shared panel action layout. These layout/prose changes require their next fresh product image and served requalification; the retained deployment still remainsb26/schema039.

## Settings qualification progress and direct runner TLS (2026-10-04)

This checkpoint supersedes the older statement below that no maintained-engine graph has succeeded. Actual Actions attempt7e passes on Golf `sha256:17783bef273451b644010c4d7d7150f021b18da2f839ae79c5ae94903bbc5744` (source `9a73974f17195542f0f7f5fb226939be6a914a85`) and runner `sha256:15f912421428dc83fa3bc4bfba59cefe503b35156160e96e471d5350bd448fab` (source `09fc8e2c45599dc347a992478d139851fbf2f4e6`). The five-instance dependency/matrix/local-composite/output/conditional graph succeeds with27 durable events. A separate four-instance mixed matrix records20 events, independent failed/successful cells and the expected aggregate failure. Exact source, workflow blob, archive hash, catalog, attempt and paginated job/step log receipts are checked independently. Twelve actual dark/light1440/390 inventory/run/selected-step captures pass. The unchanged browser manifest is hashed into a separate runtime receipt; cleanup and retained-runtime identity checks pass (`.tmp/actions-engine-product-served-attempt7e/manifest.json`, `.tmp/actions-engine-graph-ui-served-attempt7e/manifest.json`, `runtime-receipt.json`). Root inspected the actual light390 selected-step capture. Earlier7b/7c/7d failures remain separately preserved;7d's successful browser slice did not complete the parent qualification because its immutable manifest was incorrectly reopened for exclusive creation. Source `28e359a` corrects only that evidence-writing path. Full Actions/GitLab compatibility remains incomplete and the retained opt-in catalog is still disabled.

Organization-team access source is integrated, including exact native identity/authority, protected team handling, readback, revalidation and denial clearing. Actual attempt3 passes native/API checks, twelve browser captures, four attach/detach/reload cycles and a genuine accepted-write/lost-browser-response inspection with no replay. Its final cleanup fails on a stale rename alias; therefore the overall attempt remains failed (`.tmp/repository-team-access-served-attempt3/manifest.json`). Source `568cf81` changes cleanup to resolve only current owned targets and their immutable native IDs. A fresh complete rerun is required; invitations and custom roles remain open.

Outbound webhook source040 includes encrypted destinations/keys, explicit background consent, leased delivery, pinned network/TLS boundaries, HMAC, bounded retries/history and explicit redelivery. Root source `9122ef8` refuses operator-approved path escapes before saving and makes no-byte destination denials terminal. Real-PG race25.449s passes, including zero receiver requests after policy revocation. Actual controlled-HTTPS attempts3–6 remain failed and cleaned: invalid Compose tmpfs syntax, an internal bridge blocking host-published readiness, then rejected endpoints incorrectly mapped to generic HTTP500. The first two are fixed without changing retained networking or weakening TLS. Source `e697ecd` adds a closed safe400/503 mapping; a real-PG HTTP regression passes2.687s with no-store, no private destination leak, no saved rejected subscription and no receiver request. Positive actual signed delivery is still pending; no external notifications have been sent.

Source `5ab7ca6` adds an optional direct TLS1.3 listener for machine APIs and `compose.runner-tls.yaml`. It validates explicit operator certificate/key settings, uses the same authenticated handler, and establishes actual request TLS rather than trusting a forwarding header. Go race2.519s passes actual trusted handshakes plus TLS1.2/wrong-host refusal. Runner CA verification is being integrated with the repository execution-value consumer; neither secret-bearing CI execution nor this TLS overlay is yet runtime-qualified. It is disabled by default and the retained deployment is unchanged.

The retained local product remains source `b26ae14abc870e27c3e16a26f558b1e6db2db995`, schema039 and the exact core/worker/runner identities recorded below. General Ready and the newer settings controls remain source/proof-image increments until the next guarded deployment. Lifecycle archive/unarchive, CI secrets/bindings and verified email notification transports are under separate isolated implementation; no full section readiness is claimed. All ten complete acceptance requirements remain in [Complete repository settings](REPOSITORY_SETTINGS_IMPLEMENTATION.md).

## General native acceptance and Actions transfer diagnosis (2026-10-04)

General configuration is qualified on the unchanged fresh image `sha256:17783bef273451b644010c4d7d7150f021b18da2f839ae79c5ae94903bbc5744`, source `9a73974f17195542f0f7f5fb226939be6a914a85`, with native1.27.3. Actual qualification63988 passes website/topics independent writes, unchanged tracker options, full external/internal/disabled modes, exact slash/default-ref refusal, IDs/revisions, nonadmin/outsider, Origin/bearer/logout boundaries and native readback. Twelve real dark/light1440/390 captures pass four General saves and four separate Topics saves/reloads; root inspected desktop current values and mobile editor (`.tmp/repository-general-served-attempt2/manifest.json`). Supplemental64168 passes archived edit denial and a real native rename/replacement at the same URL without changing the replacement, then restores the original identity (`.tmp/repository-general-served-target-fences/manifest.json`). Every owned actor/repository/account/session and fresh Compose resource is cleaned. The first attempt refuses insufficient startup disk reserve before any fixture; it is preserved separately.

The General coverage row can now report Ready after a validated current settings observation from this implemented contract. Read-only authority is separate from capability availability; failed/unknown private observations retain Partial and clear editor content. This is General configuration, not a wiki workspace or completion of the other nine sections. The badge increment is source-only until its next product build/deployment. Access prose now acknowledges actual deploy-key support; the agent row acknowledges the bounded Codex journal while preserving interactive/other-harness/tool-policy gaps. Browser regression initially passes14/15 with one obsolete wording assertion; the corrected focused authority case passes separately. Source typecheck passes. The retained local product is still b26 until the next guarded deployment.

Actual opt-in engine attempt3 (`.tmp/actions-engine-product-served-attempt3/manifest.json`) is Lost before graph events, classified `helper_remote_hash`, and fully cleaned. An independent owned Docker test proves `docker cp` returns0 but the file is absent inside the running tmpfs; a fixed trusted exec-stdin write creates the same18,216,939-byte regular file with an exact full SHA256 match (`.tmp/actions-copy-diagnostic2/manifest.json`). Source `484ab0f` changes this actual shared transfer path: hash the same opened helper first, stream bounded bytes into the live namespace, preserve the exact remote digest check. Runner/command race2.367s/1.409s and vet pass.

Runner image `sha256:65e5bb0c6d5d2cd1461b7ef5fbc82fd018f3b272eeeecc5f6b1f9d39aa2e7853` contains that fix at source `7716470`; actual attempt4 with the above General image passes helper transfer, then becomes Lost at `helper_completion` with no graph events (`.tmp/actions-engine-product-served-attempt4/manifest.json`). Cleanup passes; no successful graph/browser/mixed-matrix qualification is claimed. Safe closed inner-engine diagnosis continues. Only exact Golf-owned completed build scratch is reclaimed; running and stopped proof image identities are checked unchanged before/after. No foreign resources, retained policies, provider grants or remote repositories change.

## Actions engine source, deployed drilldowns and actual legacy qualification (2026-10-04)

The combined Actions backend/runner/helper `7a5d2f2` and graph UI `b26ae14` are integrated with the parallel source/deploy-key contract. Product `b26ae14abc870e27c3e16a26f558b1e6db2db995` is deployed locally on manifest/container `sha256:c0b1cd09835b1199d96f107f508d6f10d71c28358bd96346fb520a3d5ae6d471`, exported config `sha256:59626b00c739a9e7917d839f6f18aee5adfcd85c7205e4643aad8d46620368c4`. Worker is `sha256:64ac9959eabf4ed88081c274f69e91ce2d1d65e0be9266404d6adb3f8d85c220`; retained runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Build24943 and guarded deployment78333 exit0; successful explicit-role checks show zero active workflow/agent executions before and after deployment, readiness passes and schema039 is applied. The opt-in catalog remains disabled in this retained installation and no execution policy/provider grant changes. Latest-schema recovery remains unqualified.

The pinned maintained engine delegates static DAG/matrix/composite/expression execution to the public native executor, with independently owned per-cell error state, bounded immutable admission, durable graph acknowledgements and exact job/step log receipts. The source profile explicitly requires matrix fail-fast:false and refuses matrix outputs, remote/JavaScript/Docker actions, services and other unsupported forms. Complete Actions/GitLab compatibility and all Settings requirements remain open. Source proofs: integrated `make check`86152,110 browser cases1.2m,57 routes/source/settings cases37.9s; isolated engine real-PG broad64.371s, helper race2.165s/vet/build and static Linux arm64 helper build. None substitutes for actual opt-in execution.

Actual existing shell-CI compatibility passes65296 on this unchanged Golf image and fresh runner image `sha256:a5b0cea44ce745327de391bd5927cda00d87317395c72f5a0261f2e8d5771a59` from the same b26 source. The disposable RustFS-backed installation proves manual Actions/GitLab shell jobs, independent manual/push ceilings, durable exact-source queues/idempotency and storage restart, real step events, typed run/history receipts,49 log chunks/four pages, failure/skip, cancellation/revocation and complete owned cleanup (`.tmp/actions-engine-legacy-ci-served.log`). Twelve actual inventory/run/selected-step desktop/mobile dark/light captures pass with click/reload, exact receipts and unchanged image/config (`.tmp/actions-engine-legacy-ci-served/manifest.json`); root inspected the actual light390 selected-step image. This is bounded shell compatibility, not a successful maintained-engine execution.

The first opt-in qualifier failed during prerequisites before any fixture. The next actual controlled opt-in run77026 reaches admission/assignment but becomes Lost in about one second with no recorded job events (`.tmp/actions-engine-product-served-attempt2/manifest.json`). No success is claimed and no browser/mixed-matrix proof ran. Managed actors/sessions/native fixtures and fresh Compose resources are cleaned. The runtime adapter startup failure is being diagnosed; an independent unstarted owned Docker daemon create/inspect matches the intended resource/environment shape and is fully removed. The source-only launcher/browser helpers preserve this failure checkpoint and retain actual runtime/graph/source identities, rather than relabeling it Ready.

General configuration source `db213f4` is now integrated with the combined generated descriptors: website, a separate topics editor, explicit disabled/internal/external issue/wiki modes, complete stale-edit observations and exact target/readback validation. Unrelated internal tracker options are preserved and legacy booleans cannot silently convert external services. Private dirty drafts remain hidden/inert during revalidation and clear on authority/account changes. Isolated87 browser cases47.7s, real-PG race3.549s, build and `make check` pass; integrated `make check`94875 also passes. This General increment is not yet deployed or actual-native qualified; the complete ten sections and a real Golf wiki workspace remain required. General service-observed coverage stays Partial while acceptance is unfinished.

## Deployed source projection and access layout (2026-10-04)

Source `ce661fa2a48aa0a6eb4b3356c8b3f05c338bbf76` is deployed locally on manifest/container image `sha256:e7b05b51251676fd770449c87e334d76a8a2701a1fe787911c00ad6e0eb1fa45`, separately exported config `sha256:8499ec427701614a3e64b0ace8ce0234b449817374527a2232b99dd67e542fb2`. Worker is `sha256:efed78321eccd11da7bb3f11c0461604ab70b563693bfb4a116e4437a928f383`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Build72597 and deployment66915 exit0, database/forge readiness passes and schema038 remains applied. This supersedes the older current-runtime and undeployed access-layout statements below; earlier qualifications retain their own source/image scope.

An opt-in source-directory projection uses at most one bounded selected-head native commit inspection. It returns a latest-change receipt only for an independently present entry positively affected at that exact head; merges, malformed/oversized native metadata and unmatched entries retain bounded lazy path-history reads. It validates actor/repository/head/path before accepting either projected or fetched metadata. Source evidence includes real-PG race31.161s,125 integrated browser cases1.5m,58 final row cases1.1m and integrated `make check`57842. No shared cache, migration or guessed older-path history is added.

Actual served measurement on the reported pinned demo source now makes15 initial commit-history requests instead of16: one of the15 directory entries qualifies for projection, and a separate read-only native path-history comparison agrees with that receipt. Three scroll cycles, actual listener-driven simulated tab visibility revalidation and22.5 seconds idle add no immutable source/image/history requests or tree/image removal. Mutable repository metadata still revalidates on visibility. The exact runtime is unchanged before/after (`.tmp/repository-projection-defaults-served.json`, terminal7207). The first diagnostic qualifier50050 expected a serialized empty protobuf path; the final probe correctly accepts omitted default fields without relaxing repository/head/path identity. A many-matching-row source fixture is not a claim that the real demo eliminates all path reads. General older-history batching and shared authorized live fan-out remain required; no million-user capacity result is claimed.

The access-page density follow-up is now served. Eight actual read-only captures cover dark/light1440/390 inventories and an unsubmitted Add editor (`.tmp/access-density-served-final/manifest.json`, terminal48755). Heading geometry and document overflow checks pass; root inspected light mobile inventory and dark desktop editor. No key, policy or provider grant is changed. These captures qualify the new layout and complement, rather than replace or relabel, the16 native deploy-key Add/Delete/reload captures on the earlier ea192dd image. Complete Access and the remaining Settings sections still require the full functionality and acceptance in the repository-settings packet.

Deployment guard diagnostic: a pre-deployment queue check used an unset PostgreSQL role and failed, but the shell continued into deployment. Therefore no successful pre-deployment zero-queue check is claimed. Correct explicit-role post-deployment reads show zero active workflow/agent executions and zero executions terminal in the preceding five minutes (`.tmp/source-projection-post-deploy-queues.log`). The future wrapper now runs the validated queue check and deployment in one checked process. This is a corrected deployment procedure, not retrospective proof of the failed guard.

## Deployed source-view stability and live cursor fix (2026-10-04)

Product source `ea192ddc10c3706adc5a983840287063b790106a` is now deployed locally on manifest/container image `sha256:0c21515246aed91a1e011d77aa5d219482255a98e1f8f6d26362102f7139682b`, with that explicit OCI revision and separately exported image config `sha256:da9a304a44463e949583ec6de64e7b0e81fb80cfcc0d961369993a4a2180dcd4`. Worker is `sha256:e7e3e8eb46727ac7e2c574236300fadfd02fd90d7e233b92494299c7f1aa6499`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Build80987 and deployment32087 exit0; database/forge readiness passes, and migration038 is applied. Integrated `make check`33892 passes. This supersedes the source-only deployment statements in the earlier development checkpoint below. No retained execution policy or provider grant changed.

The actual reported `/golf-admin/golf-review-demo/tree/d73fa1cdcbd8b1465c151db8924ba58b1dd14e35?branch=main` route now keeps completed row history, immutable source and decoded Markdown images stable. Three down/up scroll cycles previously increased commit-history requests from16 to61; now they remain16. Source requests remain3 and image requests1. A simulated tab visibility transition genuinely revalidates native access metadata (repository reads2→3) while source/image/history counts stay unchanged and neither the tree nor images are removed. The exact image/revision remains unchanged throughout this read-only managed-session probe (`.tmp/repository-repaint-watermark-visible-served.json`). A second actual served probe adds22.5 seconds idle after visibility revalidation: two additional stream rotations cause no metadata, source, image or history reads and no tree/image removal (`.tmp/repository-idle-watermark-served.json`). This is simulated browser visibility, not an operating-system focus or population load test. The strengthened browser regression exercises the actual TanStack visibility listener and passes2.2s (`.tmp/repository-repaint-visibility-final.log`); its first diagnostic failure used a non-bubbling synthetic event and did not reach that listener.

Completed row reads are latched by exact actor/repository/commit/path identity; pending offscreen reads still cancel and concurrent admission stays bounded. Immutable queries retain only mounted memory, with no automatic focus/reconnect refetch. Markdown component identities remain stable. Access revalidation hides and disables private content while retaining geometry; actual denial clears it. First navigation still makes bounded per-path history reads; a batched, authorized summary projection remains a future optimization. These fixes do not establish a million-project performance result.

Actual served cache headers pass (`.tmp/repository-cache-served.json`): content-hashed JavaScript assets are `public, max-age=31536000, immutable`, the app document revalidates with `no-cache`, and the unauthenticated session RPC returns401 with `no-store`. Private API/source responses are not placed in public browser/CDN caches. Focused source cache checks and the earlier35 source-identity browser cases remain separately recorded below.

Empty activity history now carries canonical cursor0 across Connect stream rotation, preventing fresh-history resets every ten seconds. Source real-PostgreSQL qualification passes18.179s, including first-event replay after an empty reconnect, recipient/repository exclusions and native/session denial. Seventeen live browser cases pass30.0s, including repeated idle rotations preserving open menus and DOM identity. Both server and client are deployed together. The durable journal, native authority and admission limits remain authoritative; shared authorized fan-out, coalescing/backpressure, multi-replica delivery and hot/idle/reconnect load tests remain required under plan15.1.1. Current local polling/stream caps are not million-user qualification.

Twelve actual retained-agent inventory/review/task captures pass on the preceding `4a58b96` image `sha256:14632dadf5b0b3a8b96b4791d95ba3836bf2849552f0118dca6cc29580f052f5` (`.tmp/conversation-retained-agent-served/manifest.json`). These historical runs have final results and honest unavailable journals; no new provider inference or native conversation runtime was qualified. New AM-3 observations and latest-schema recovery remain separate gates.

Deploy-key qualification now passes on the unchanged `ea192dd` runtime (terminal80838, `.tmp/repository-deploy-keys-served-final.log` and `manifest.json`). Actual native read-only clone/denied push, read/write push with exact Git-ref receipts, role/revision/Origin/session refusals, revocation on new connections and shared-public-key association detach pass. Sixteen served Add/list/reload/Delete captures cover both modes/themes at1440/390 with exact acknowledged association IDs and independent native readback; root inspected desktop and light mobile images. All owned native actors/repositories/keys are purged, managed fixture accounts disabled, and sessions/bearers revoked. Earlier incomplete attempts remain separately preserved: the granular diagnostic identified a reload helper whose section-scoped `has` locator searched for a section inside each row. Selecting the row by the independently acknowledged association ID repairs the helper without changing product behavior or weakening receipt checks. Complete organization/team/invitation access and all-ten Settings readiness remain incomplete, as do full maintained Actions/GitLab compatibility and the wider Git/UI goal.

## Source access-page density follow-up (2026-10-04)

Actual deploy-key mobile captures above exposed a split-word Collaborators heading and unnecessarily large technical guidance blocks. The source follow-up uses the existing global panel heading to wrap whole control groups, removes inherited20px action margin inside headings, and keeps long titles shrinkable. Access now leads with owner/permission and the collaborator inventory; implementation-level explanations move into a closed About repository access disclosure. Admin destructive authority and independent grants/removal/uncertain-outcome consequences remain explicit. Edit/remove/refresh reuse Lucide icons with accessible labels/tooltips and the existing forms, confirmation dialog and shared TanStack table; no new layout/table engine is introduced.

The final affected Settings/profile/infrastructure/access/deploy-key browser slice passes57 cases22.2s (`.tmp/access-density-shared-final.log`), including actual permission-denial clearing, duplicate-write prevention, wrong receipt/unknown outcomes, keyboard confirmations and four desktop/mobile/theme layout checks. TypeScript and whitespace pass. Root inspected the source-only light390 image; its heading stays on one line and the Add/refresh controls fit. These source screenshots are UI fixtures, not replacement served proof. The deployed runtime remains `ea192dd`; this density follow-up will require its own build/deployment and affected served capture before being called deployed.

## Integrated conversations, deploy-key source and source-view performance (2026-10-04)

AM-3 backend commits `ce03da6`/`fb64a3b`/`17a1492` and UI `a633e3d` are integrated, including migration038, private encrypted bounded Codex observations and the actual worker consumer. Integrated `make check`27089 passes;63 affected browser cases pass50.8s. Independent isolated real-PG race passes112.456s and the account recovery-shape follow-up preserves valid credentials on malformed recovered auth. This qualifies source behavior, not an actual new native inference/journal, interactive continuation or latest-schema recovery. Deployed runtime remains theb47 checkpoint below until explicitly recorded otherwise.

Repository SSH deploy-key source `8934865` is integrated with the combined generated contract. Main `make check`86281 passes, and29 deploy-key/access browser cases pass20.7s. Independent real-PG final2.092s and earlier broader3.522s pass. Actual native read-only clone/denied push, read/write push and shared-public-key association detachment plus served UI proof remain pending; the complete Access settings section remains Partial.

Fresh signed-push qualification29460 passes on the unchangedb47 Golf/runner image (`.tmp/unified-actions-push-served.log`): disabled-intake non-revival, independent active grant after browser logout, push-only/manual-denied ceilings, exact commit/blob/private RustFS source, restart/replay deduplication, real Docker execution and grant-revocation fencing. Isolated containers/volumes/network/recorder/Git state are cleaned. This retains the bounded shell catalog scope.

The actual reported source URL was measured before the performance change: three down/up scroll cycles increase ListCommits calls16→61 without changing the pinned commit (`.tmp/repository-repaint-baseline.json`). Source inspection identifies viewport state clearing completed rows, stale immutable reads and recreated Markdown image component types; background access hiding also collapses the workspace. The new mounted-only immutable query policy, stable Markdown component identities and geometry-preserving inaccessible authority gate are source-only pending deployment. First affected browser run85/86 passes; the new DOM-identity assertion used a role locator that excludes intentionally hidden images, and is corrected to inspect the existing DOM element without relaxing visibility/denial assertions. Final35 source-identity cases pass37.8s, including equal height/DOM identity, no duplicate source/image reads, and actual permission-denial clearing. Scroll-row follow-up and actual served before/after measurement remain in progress. Public content-hashed JS/CSS/font files now have an immutable one-year cache policy; the app document/unversioned files revalidate, missing asset fallbacks are not marked immutable, and RPC/API remain no-store. Focused cache/SPAboundary checks pass0.381s; initial expectations are corrected for the native index redirect301 and malformed GETRPC400 without changing those runtime contracts. Plan15.1.1 retains the full live-fan-out/multi-cell scale requirement; current local polling is not million-user qualification.

## Unified Actions inventory and actual agent-result drilldowns (2026-10-03)

Frozen product source `b47e36f6573fdd3fbdb81eea1ea8704ad508934d` is deployed on manifest/container image `sha256:3780bd2470a7eb3ae88e347818868d0f5e1661e7c83ccb7636414a57d891f556`, with that explicit OCI revision label and separately exported config `sha256:a038bf4a884741bb2c438108b34019c5a19581ac4a21028ddd6ef53351758c0d`. Worker is `sha256:85125cd35e01896934d01b19d556b391d339f9848aac6df7b526cbf4e7212de3`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Build3508 and deployment97465 exit0; current database/forge readiness passes. Migration037 remains applied. No retained execution policies or provider grants were changed.

The default Actions inventory now combines actual workflow, coding-task and PR-review runs using a typed keyset service and kind badges. Workflow/task/review URLs are distinct; selecting a row opens its full page. Linked review tasks do not appear twice in the common feed, and private child links exist only for their initiating current repository writer. The mixed list exposes metadata, not prompts/results/patches/archives. Cursor filters bind repository, actor, kind and workflow. Typed detail validates current native identity and actual stored source/attempt information; missing trigger/actor/usage information is not invented. Coding-task patch proposals reuse the shared syntax/line/unified/split diff viewer and safe malformed-patch fallback.

Integrated `make check`5881 passes (`.tmp/unified-actions-main-check.log`). Broad isolated real-PG race passes74.843s; focused common-run tests pass9.474s, and the forward-only historical review fixture passes2.260s after repairing its old034 setup without weakening later migration downgrade refusals. UI113 affected cases pass1.2m; final shared task-diff follow-up21 cases pass28.0s. Generated API SHA256 is `a68f12cbedbeb5bd56c65ac9544bafc0dddf795517c55e8a298d44faff2eb7ba`.

Fresh isolated Compose CI terminal95784 exits0 on that exact Golf image (`.tmp/unified-actions-ci-served.log`). It proves independent manual/push policy observations and denial, actual controlled Actions/GitLab shell jobs, restart/idempotency, private RustFS immutable source bindings without database archive copies, real attempt/source/step progress receipts, wrong typed kind/repository denial,49 log chunks/four pages, failure/skips, cancellation/revocation and complete owned cleanup. Six actual runs traverse bounded mixed-history cursor pages without duplicates/skips and with server-filter binding. Twelve actual dark/light1440/390 inventory/run/selected-step captures pass; inventory rows are actually clicked and selected run pages reloaded with exact receipts (`.tmp/unified-actions-ci-served/manifest.json`). Mobile run logs begin around589px and collapsed Jobs retain selected-step reload. This remains the bounded shell catalog, not full Actions/GitLab engine compatibility.

Actual retained-data qualification also passes on the same unchanged source/image (`scripts/agent-actions-ui-browser.mjs`, terminal61611 exit0, `.tmp/unified-actions-retained-agent-served.log`). Twelve dark/light1440/390 captures cover the existing `golf-admin/golf-review-demo` common inventory, a published structured PR review, and its own linked private coding task. Each review and task is opened through the actual row/child link, reloaded and checked against current repository, typed run, source and real attempt receipts. No provider catalog lookup, inference, new task, source/policy/grant/native review mutation or external push occurs; managed sessions are logged out. Private artifacts remain owner-only in `.tmp/unified-actions-retained-agent-served/`. Root inspected actual desktop review and mobile task screenshots. These historical tasks have final results, not retroactively fabricated conversations.

The subsequent **source-only** density increment moves New coding task into the Actions header, gives mobile users explicit run/workflow selects, keeps policy/default-branch/configuration explanations in a disclosure, fixes badge/trigger spacing through a shared CSS selector and displays relative run dates with exact timestamp tooltips. The first browser pass53/57 had four obsolete mobile-link selectors after the new select controls; its diagnostic artifacts remain separate. Corrected tests exercise the actual mobile selects and still verify server filtering, policy/privacy, source context and reload. Final57 affected browser cases pass28.3s (`.tmp/actions-density-final-browser.log`); settings coverage6 pass7.1s. This source increment is not yet attributed to the deployedb47 image or its screenshots.

The user's all-sections-Ready requirement is now explicit in [the repository settings implementation packet](REPOSITORY_SETTINGS_IMPLEMENTATION.md) and plan6.4. All ten sections retain their full scope, dependencies and acceptance evidence. Stale CI/agent coverage prose is corrected; those broader sections remain Partial while engines/artifacts/cache and conversation/tool policy work is unfinished. Native deploy keys are being implemented in an isolated branch. AM-3's first bounded Codex event journal and Conversation UI are also isolated/in progress, with dedicated encryption-key lifecycle and private-read qualification; they are not current deployed functionality. Interactive replies/steer/resume, OpenCode/other adapter journals, full job graphs and embedded agent steps remain required. Protected merge/squash/rebase/P0.8, remaining Settings rows, expanded recovery and the broader GitHub/GitLab/forge/UI goal stay active.

## Historical Actions policy/layout checkpoint before unified workspace (2026-10-03)

Frozen product source `5bbca43b6c1cfe9f2b8d81eac2922707ea8918c5` is deployed on manifest/container image `sha256:da706883eb7a05f5cfdd06433418ced240bd8167a8fb8affb26bbdd4fd48d20e`, with explicit OCI revision label and separately exported config `sha256:24fa32d135513b71625c92a5c198be85e95f61d77e51c70df0a32760a3a23aed`. Worker is `sha256:4fac8453d6106c09d251a4355da19fb6e7cca2d73462e5b4dac9e2de9ff76f54`; runner remains `3d4f34ae…`. Deployment94198 exits0; database/forge readiness passes, migration037 remains applied and workflow/agent queues are0. No retained execution policy was enabled or changed.

Read-only workflow inspection now returns coherent independent manual/push policy observations from a bounded repeatable-read snapshot, with exact repository-ID and native owner/kind guards. Missing policy is known denial; database failure is unknown, with no guessed execution grant. Configured worker, policy approval, YAML eligibility, native writer permission and an active push sponsor remain separate conditions. Broad isolated-PG race passes44.786s, focused8.894s, drift/vet/whitespace pass. Main `make check`15364 passes. UI110 affected cases pass1.2m; contextual manual action/privacy/uncertain-write follow-up22 pass27.8s; final nine live regressions pass18.1s.

All16 actual affected served captures (Status/alias, Actions and workflow settings, both themes1440/390) pass on the unchanged image; cleanup passes (`.tmp/actions-policy-selected-served/manifest.json`, terminal63645). Fresh isolated CI terminal98996 passes all four independent policy combinations, actual manual Actions/GitLab shell execution, restart/idempotency, named step/source receipts,49 log chunks/four pages, failure/skips, cancellation/revocation and cleanup. Twelve actual inventory/run/selected-step captures pass (`.tmp/actions-policy-ci-final-served/manifest.json`); mobile logs begin around589px and closed Jobs preserve selected-step reload. The first incomplete nine-record attempt remains separately preserved: a helper's role locator excluded a hidden link after collapsed reload; correction `d797a2c` changes only the helper. It is not relabeled as a successful capture.

Actual signed-push qualification6621 also passes on the same image: push-only/manual-denied observations, independent active grant after browser logout, exact commit/blob/private RustFS source, duplicate delivery/restart fencing, real Docker execution, running grant revocation, subsequent denial and cleanup (`.tmp/actions-policy-push-served.log`). This establishes the current bounded shell catalog, not full Actions/GitLab engine compatibility. Original308 all-page captures retain their older602fa image and four historical Status failures. The local gallery keeps those, selected16, finalCI12 and the incomplete diagnostic separate; static gallery QA passes690 choices.

The next in-progress packet follows the user's clarification: coding agents and PR reviews must be visible in Actions with kind badges and full-page URLs, including real embedded agent steps later. The current served image still has separate coding-task history; the mixed read/drilldown service and UI are not deployed yet. [Metadata/progress audit](ACTIONS_RUN_METADATA_AND_PROGRESS.md) records exactly what is persisted versus missing. Full agent tool/terminal journaling, multijob/matrix persistence, actor/title snapshots, usage presence, embedded parent/child execution and recovery remain required; UI does not invent their metadata.

ACP clarification: agent runs require durable back-and-forth conversation, not only a final result. The [conversation contract](ACTIONS_RUN_METADATA_AND_PROGRESS.md#agent-conversations-and-human-participation) now explicitly covers prompts/streamed replies, turns, tool activity, questions/approval decisions, capability-gated replies/continuation and transcript replay separate from actual execution resume. Source inspection confirms Codex currently uses app-server final-output projection and the OpenCode reviewer structured CLI output; a durable ACP conversation adapter/journal and interactive controls are not implemented or qualified by the mixed read packet.

A pinned maintained-engine qualification is integrated in `scripts/actions-engine-qualification` without a production dependency (`97ec706`, candidate source `act v0.2.89`). Its actual owned offline runtime passes independent manual/push five-job DAG and two matrix cells, a local composite action, false-condition skips, controlled failure, a four-second deadline and hard engine termination. Inspected jobs retain non-root UID1000, network-none, dropped capabilities, no control socket/credentials and explicit CPU/memory/PID limits. Engine hard loss leaves one observed residual job before the trusted owner removes the entire disposable daemon; this is observed cleanup, not successful job completion or automatic retry. Exact qualifier binary SHA256 is `133890bf0ba85092b67babe1a68caf6a71d329f81ea666d6c15085044a9e0eb9`; `.tmp/actions-engine-offline-runtime-qualified/manifest.json` records complete/pass/cleanup true (terminal32225). Failed earlier attempts remain separate. Integrated source race passes1.577s, vet/module verification pass. This creates no Golf run, installs no production adapter, and does not qualify JavaScript/remote actions, services, full compatibility or Cloudflare placement. The complete product goal remains active.

Next actual qualification helpers (`70d8560`) require unified typed list/detail receipts, real workflow attempt/source/progress identity, bounded cursor/filter checks and an actual inventory link click followed by reload. Syntax/self-checks pass; they have not run against the upcoming unified product image. The prior served5bb manifests remain unchanged.

## Actual all-page and Actions checkpoint (2026-10-03)

Product source `4e5bc6c` is served on Golf image `sha256:602fa284f9e3bf861ddd5cd0e28637b174781698b8d17c56f8e0b9a890e0b1a0` (build-exported OCI config `sha256:7b45447c80296adb54f4eb3bbedb17bb022fe518af7d2213dc2d2882bd52c7df`). Readable source/Latest/private-clearing qualification passes on that unchanged image: twelve actual PNG captures, eight text captures, supported native and delegated/API/CLI receipts in `.tmp/readable-source-final-served/`. All owned actors/repositories and sessions are cleaned. Earlier failed setup passes remain separate and are not relabeled as successful.

The actual read-only all-page audit completed all308 captures:296 captured, eight legitimately pending saved-infrastructure configuration, and four failed390px Status overflow checks. Both themes at1440/390 and owned admin/reader/outsider/anonymous states have explicit per-capture results in `.tmp/all-page-final-served/manifest.json`. [Detailed review](ALL_PAGE_UI_PARITY_REVIEW.md) records remaining layout/feature gaps. A capture completing is not full functional or authenticated-GitHub parity. The review gallery is locally available at `http://localhost:4326/all-pages/`.

Fresh isolated CI qualification on the same image passes manual controlled shell Actions, GitLab script, failure/skipped steps, cancellation/policy revocation, durable restart/idempotency and sequence-paged logs. Twelve actual Actions list/run/selected-step browser captures pass, including reload and exact selected-step output (`.tmp/all-page-ci-final-served/manifest.json`). The isolated stack/resources were removed; retained instance policy was not enabled or changed. Full jobs/matrices/uses/expressions/secrets/artifact/cache and scalable engine qualification remain open in the [Actions implementation packet](ACTIONS_COMPATIBILITY_IMPLEMENTATION.md). Independent configured push has its own existing shell-catalog qualifier; it is not inferred from manual screenshots.

The next source increment is in progress: compact workflow sidebar/run views/mobile logs, the Status overflow correction, and coherent read-only per-workflow manual/push policy observations. These changes are not yet represented by the served602fa image or the308-capture manifest. Their tests/deployment and affected served proof must be recorded separately before they are called qualified. The overall product goal remains active.

## All-page familiarity and agent metadata progress (2026-10-03)

[Route inventory](ALL_PAGE_ROUTE_COVERAGE.md) enumerates41 logical page surfaces plus15 embedded workspaces; this is a source inventory, not a claim every state is implemented or visited. Fresh anonymous GitHub organization/profile references and Golf login desktop/mobile are retained in `.tmp/all-page-parity-review/`; authenticated Golf coverage is pending its disposable fixture pass. Shared small-inventory presentation in `2d4dbe0` keeps full loaded-list behavior for larger pools and removes unnecessary search/pager/header chrome for empty or tiny inventories. Eight focused browser checks pass10.7s (`.tmp/all-page-table-final.log`); the initial7/8 run had an incorrect new empty-message assertion, corrected without relaxing paging/privacy tests.

CLI/MCP overview in `092b36d` adds `repo overview` and `golf_repo_overview`, increasing the read catalogue to24. Current native repository identity is resolved and the overview ID/key/index state/count/string receipts validated before release; no selected-SHA index assertion, website fetch, write grant or session authority is added. CLI race coverage passes2.518s; vet/typecheck/whitespace pass. Actual official-SDK/native qualification passes under both2026-07-28 and2025-11-25 (`.tmp/overview-mcp-native.log`, terminal57089 exit0), including all24 tools, temporary PAT session cleanup, owner-issued API bearer cancellation/revocation/source logout, current native scope and private collaborator/membership denials. The served backend remains the earlier60dc sidebar image at this checkpoint; the new CLI reads its existing overview RPC. Disposable native actors/orgs/repos/child processes are removed. Earlier19/23-tool proofs retain their own historical scope.

Readable suffix backend is integrated in `3117541`, with exact namespace/path candidate enumeration and conservative ambiguity. Its source/isolated-PG evidence is recorded in the [qualification matrix](READABLE_SOURCE_URL_QUALIFICATION_MATRIX.md); new browser UI, final integrated deployment and actual named-route/Latest qualification remain pending at this checkpoint. The all-page visual work and these bounded increments do not complete the overall product goal.

## Native repository sidebar and layout (bounded local qualification, 2026-10-03)

Three agents independently researched pinned native metadata, implemented the UI/backend and reviewed GitHub layout/privacy. [Deep layout review](REPOSITORY_SIDEBAR_PARITY_REVIEW.md) retains eleven actual public GitHub captures and historical Golf provenance; [overview contract](REPOSITORY_OVERVIEW_CONTRACT.md) defines the new exact-ID/current-authority read. Main integrates backend `8f37a27`, sidebar `3bc302e`, condensed shared README controls `25d9cd0` and final SVG meter correction `c35dc86`. Root Code places refs/Code inside the left workspace with About alongside it. Real description, safe website, complete topics, optional star/watch/fork counts, detected license IDs and indexed language bytes are exposed with honest unknown/available/error states. Successful About removes repeated visibility/default-branch/updated/history rows. Empty root repositories use the same sidebar; file/folder/commit/PR views retain their own context. No contributors, release/package/deployment links or write controls are fabricated.

Canonical repository-ID receipts, before/after current native/local authority, independent optional index reads, decimal counts above2^53, signed64 language aggregate/bounds and display-only safe http(s) websites are validated. No cache or backend website fetch is introduced. Indexed languages/licenses are repository observations, not selected-SHA/current-default-head proof. The overview RPC is narrowly read-only bearer-allowlisted; no CLI/MCP overview command or write delegation is introduced.

Backend disposable-PG race coverage passes2.676s, including identity replacement and local/native access loss during an optional wait; focused source race passes1.544s, generation/drift/vet/whitespace pass. Root integrated Go tests pass (`.tmp/sidebar-integrated-go.log`, terminal95285) and integrated `make check` passes (`.tmp/sidebar-integrated-check.log`, terminal14417). Generated API SHA256 is `8b832a131ecc85cc614b0afc11f2481555a729848ad771df9177133164d7c550`. Final focused sidebar browser coverage passes27 cases28.2s; the six-file source/Markdown/live/sidebar slice passes157 in1.5m (`.tmp/repository-sidebar-focused.log`, `.tmp/repository-sidebar-affected.log`), with TypeScript/build/whitespace passing. The initial26-case run had23 passes/three fixture assumptions about canonical remount read counts; final assertions bind a real baseline. Final SVG height correction separately passes TypeScript and actual served visual inspection; final main `make check` also passes (`.tmp/repository-overview-final-check.log`, terminal55465 exit0).

Source `c35dc86` is deployed locally on manifest/container reference `sha256:60dcfd7e2a36e695634e4c1324a95c4eab3909d6c275b37cc3d8e4e1d58568ef`, separately exported OCI config `sha256:3394aa3b0f51385659499d0575c031a6008ce8837bae170a39c6fb67b99fad28`. Worker is `sha256:e62b4c31bcdc84bd0b4ac31535cb9a604ad127d20c78a3493c67ea490171ff13`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Final redeployment exits0 (`.tmp/repository-overview-final-deploy.log`, terminal58028), database/forge readiness passes, schema037 remains applied and both queues are0.

Actual native/served/API/delegated/CLI/browser proof passes (`scripts/source-identity-smoke.py --overview`, `.tmp/repository-overview-final-served-proof.log`, terminal44298 exit0). Supported native fixture PATCH/topics/content writes produce real description/website/topics, Python index bytes and count/license observations independently compared with Golf; wrong native ID/private outsider are denied. Exact source/README/image namespace and immutable-byte checks also pass. Four actual root full-page and four source dark/light390/1280px captures plus metrics are owner-only in `.tmp/repository-overview-final-served-proof/`; root inspected dark desktop and light mobile. Desktop railx976/280px and toolbarx24/928px both starty208, separated24px. Mobile toolbar95px and sidebar follows README aroundy976, with no document overflow. Visible file-change reads settle before capture. Actual access removal clears the entire sidebar, README/image in a second root tab and private file content in the original tab; image/config identities stay unchanged before/after. All three fixture actors/repository are purged, managed sessions revoked/accounts disabled. No workflow execution, inference, remote push or Cloudflare operation ran.

Initial native/served proof on `d6b4dd6` and the same-image settled-row recapture both passed. Their owner-only artifacts `.tmp/repository-overview-served-proof/` and `.tmp/repository-overview-aligned-served-proof/` remain attributed to that image. Inspection found capture-only unfinished mobile lazy rows and an actual SVG aspect-ratio scaling issue; the final helper waits for visible rows and the final meter retains its8px height. Prior captures are not relabelled as final. Complete contributors, resource navigation, releases/assets, social mutations, linked packages, CD environments, context-specific issue/PR rails, readable RS-2 URLs and the remaining overall implementation gates stay open.

## Exact source selection and caller migration (bounded local qualification, 2026-10-03)

Main source through `eabe5b9` integrates typed source resolution, exact repository-ID/full commit/path receipts, all source/README/navigator/image/CLI/MCP consumers and sibling workflow-source reads. [Design and remaining readable-route work](READABLE_SOURCE_URL_DESIGN.md). Native `contents-ext` can prefer a branch/tag literally named as the requested SHA; exact reads now use supported commit/tree/blob APIs with bounded complete directory paging and independent child-tree/blob hashes. Native root-tree fields expose commit IDs, so root inventory is commit-resolved evidence rather than independently checked root-tree hashing. Named namespace resolution is explicit; untyped browser branch/tag collisions refuse content. CLI/MCP bare named refs are branch-only and tags require explicit `ref_kind`; no write delegation is added.

Final `make check` passes (`.tmp/rs1-integrated-check.log`, terminal90555 exit0). Generated API SHA256 is `7a34819fe83f468c0e55352b2b4af781d139c7278add1ed0a7b2a48cad1fc814`. Affected browser integration passes239/239 in1.5m (`.tmp/rs1-browser-final.log`); final conflicting-label coverage passes34/34 in37.3s (`.tmp/rs1-conflict-final-browser.log`). CLI race tests pass2.651s. Real isolated-PG source/browser/image/authority/API-credential/RPC race coverage passes20.075s after correcting an expected-descriptor allowlist in the initial broader run; focused exact-object malformed/hash/paging coverage passes1.511s. The supported-native production-handler qualifier passes (terminal97631 exit0) after a setup-only Git fixture failure in the earlier run. It covers default/branch/tag/commit, different-head same-name slash branch/tag, prefix neighbor, annotated/lightweight tags, SHA-looking branch versus old commit, original Unicode/% bytes and empty blob, root/child inventory, image echoes and post-login native access removal. Every owned native actor/repository, own Git temporary directory, credential envelope, schema and disposable PG container is removed.

Workflow source inspection, grant admission and manual/push preparation share the same exact object reader, bounded ordinary-file scans and actual LFS-pointer refusal. Broad disposable-PG race coverage passes40.849s before the final raw-pointer guard; final changed-guard/source/durable/grant coverage passes7.297s. A malformed CRLF pointer without an OID yields no execution plan, archive, persisted run or grant. These checks do not execute a pipeline or inference. Supported native archive source tracing found full-object resolution in both the pinned native handler and installed Git2.54.0, so the `contents-ext` namespace bug is not established for archive consumers. Whole-workspace archive equality, optional PAX provenance and export-ignore/export-subst behavior still need independent fixture qualification; archive SHA256 alone is not tree completeness.

Deployment initially failed after the Docker VM filled, causing PostgreSQL ENOSPC. Clearing only6.453GB of unused build cache allowed normal WAL recovery on the existing volume; no database files/volumes were removed or manually repaired. Recovery redeployment exits0 (`.tmp/rs1-source-redeploy-recovery.log`, terminal6028). Golf source `eabe5b9` is served on manifest/container image reference `sha256:b7286f49e17e81e89c04f5ded6d07e5a7ff5db59496e359ac88ae171e21c50b3`, separately build-exported OCI config `sha256:656fa8ae1cc3a0836395f53381b967feac9fdf60a183df0e119a7a6ac0290954`. Worker is `sha256:f8c36557dd6b7322c7ddb8426be66aadf82336eff1f4021c4f4b73931403f182`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Database/forge readiness passes, schema037 remains applied and both queues are0. This local interruption/recovery is not the fresh-target/latest-schema coordinated recovery qualification.

Actual served/API/delegated/CLI/browser proof passes (`scripts/source-identity-smoke.py`, `.tmp/rs1-source-served-proof.log`, terminal73921 exit0): explicit same-name branch/tag/default/commit and SHA-looking branch selection; wrong-ID/private denial; exact original file/README/image receipts after default movement; revoked bearer denial; literal `docs/source % #? ü.txt` and fragment/reload; live collaborator removal clearing private source. Four actual390/1280px dark/light PNG/TXT captures and provenance metrics are owner-only in `.tmp/rs1-source-served-proof/`; root inspected dark390 and light1280, with no document overflow. Before/after image/config identities match. All three fixture actors/repository are purged, managed sessions revoked/accounts disabled. No inference, workflow execution, remote push or Cloudflare operation ran.

RS-2 readable branch/tag addresses, ambiguity chooser, explicit Latest/Copy permalink and rename/recreation qualification remain required. Complete GitHub/native collaboration, contributor summary, protected merge/P0.8, Git ingress suspension, full CI/ACP and latest-schema037 recovery remain open. The ongoing repository-sidebar review/implementation is a separate increment and cannot inherit these served screenshots.

## Saved inline native reviews and human live activity (bounded local qualification, 2026-10-03)

Main integrates backend `efa6715`, explicit saved-version UI `8df4cc1` and durable refusal/live-event refinement `0e98573`. Managed browser sessions can explicitly publish a saved encrypted private review as COMMENT, APPROVED or REQUEST_CHANGES. The exact saved version/generation and original M/B/H/diff remain immutable; a shared native-actor/PR reservation gate excludes unresolved human and managed reviewer effects. The complete independent native header/child/context receipt is required for success. Known valid semantic refusals are durable REJECTED receipts; status/reload never dispatches. Unknown effects cannot be retried or bypassed with another key. See [publication contract](PULL_INLINE_PUBLICATION_CONTRACT.md).

Migration037 retains only immutable metadata and references existing encrypted036 history. Only a verified transition to SUCCEEDED emits one scoped metadata-only pulls activity event, including the older human overall-review writer. Private saves, refusals, unknown effects and exact-key replay emit no shared review activity. Both infrastructure tracks use this behavior with AI/Cloudflare optional. Main generated API digest is `4be6c6df69e998df47f8547393e881a4b08d9ceacc5be06e7b9c8b9894806fa5`; optional native repository flags remain intact.

Final isolated PostgreSQL18.4 race coverage passes155.341s, and the final production-handler/native HTTP qualifier passes all three decisions/six original-context child receipts, existing own-PENDING refusal, actual empty-summary durable refusal/status/replay with zero native effects, and three correctly scoped success-only activity events. All owned native actors/repos, credential envelopes and isolated PostgreSQL containers are removed. This is source/native evidence, distinct from a deployed browser image. The initial source/native152.791s/3277 and95 browser49.7s observations remain historical in the contract.

Combined main browser integration passes229 cases in1.4m and107 in1.5m, covering publication/private drafts/inline readers/overall reviews, routes, repository settings/source/live/unit gates and comparisons. Fourteen layout cases pass9.1s; shared file-header correction passes22 affected cases18.0s and six final theme/width cases8.7s. Final `make check` passes. Mobile fixtures show a138px toolbar, first code aroundy776 at390px andy804 at320px; desktop toolbar stays49px. Display controls are grouped together, file basenames remain legible while long parent paths truncate, and shared h3 panel headings align icons. Existing complete path labels/tooltips/copy remain available. These fixture measurements do not replace the current c385 served baseline below.

Source `6d94bab` is deployed locally on Golf manifest/container image reference `sha256:44e980a479a2f39ac808a2d62851ff7ed928e910366994ca08db964f2652c160`, with build-exported OCI config `sha256:344e600372945f6db4c62e10167f7b5ea39d534672ade46e0459aae84e94b2ac`. Worker reference is `sha256:4a25eb5345a8d5c2414d45934a7f92e99907c047f648d520475ba48585145752`; runner stays `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Deployment exits0; database/forge readiness passes, schema037 is applied and both queues are0 after qualification. Docker image-inspect Id equals the manifest reference on this engine; the separately exported config hash above is not inferred from that field.

Final actual served/native/browser qualifier passes (`.tmp/inline-review-aligned-served-proof.log`, terminal98501 exit0): managed login, actual old/new line authoring and saved summary, explicit saved COMMENT/APPROVED/REQUEST_CHANGES, exact immutable version/generation/comparison receipts and independent native single-header/two-child original M/H context for each decision. A second authorized conversation tab observes each new review automatically without manual refresh. Status checks/reload send no publication replay. Same-image backend restart preserves the managed cookie, encrypted saved draft and known successful receipt; it does not qualify an in-flight unknown-effect crash. Live native access removal clears private source/publication details. Every fixture native actor/repository is purged, Golf sessions revoked/accounts disabled; encrypted account/draft/publication history remains retained. No inference, workflow, remote push or Cloudflare operation ran.

Four final actual both-theme390/1280px PNG/TXT captures plus provenance/layout metrics reside in owner-only `.tmp/inline-review-aligned-served-proof/`; root inspected light1280 and dark390. No overflow and44px mobile action targets pass. The first f877/f819 deployment passed the same publication/restart/revocation qualifier, but visual inspection found a680px right-aligned panel inherited from the overall composer. Removing that layout class reuses the full repository panel;95 affected browser cases pass47.6s, four explicit workspace-width/x alignment cases pass5.7s and TypeScript passes before the final replacement. Initial four captures in `.tmp/inline-review-served-proof/` retain their f819 identity and are not relabelled.

The separate source/private-draft regression also passes on initial f819 (`.tmp/inline-review-private-regression-proof.log`, terminal16120 exit0), with14 actual Code/workspace/private captures. It verifies true/false/mixed optional native configuration, private outsider denial/config restore, annotated tag versus peeled commit and latest banner, canonical Unicode file/fragment/settings, original M/B/H/raw SHA/old-new coordinates, CAS/replay/generation/history, browser Add/Edit/Save/Reopen and live denial. Private-only save/delete/read emits no native review or shared activity. Actual390px plain Files toolbar is138px and first line is aroundy804, versus the historical c385235px/y901 baseline; desktop toolbar remains49px and1920px main stays1440px. This regression predates only the publication-panel wrapper correction; its captures stay attributed to f819, not the final44e image. Full IR-3 acceptance, renamed/deleted/private-fork publication, follow-up saved-version attempt history, real transport-boundary races, IR-4–IR-8, latest-schema recovery, protected merge/P0.8, delegated writes and full CI parity remain open. No workflow, inference or remote push ran.

## Compact shared diff controls (historical source checkpoint, 2026-10-03)

The shared commit/PR diff toolbar now groups comparison counts and uses accessible icon controls for diff modes, file filtering, review comments and private drafts. The explicit Review changes action remains labeled. Global CSS preserves 44px mobile touch targets, keyboard disclosure focus and both Golf themes without reducing source text sizes.

Affected commit, PR, inline-reader and private-draft browser suites pass141 cases in1.1m (`.tmp/compact-review-toolbar-verified.log`); the corrected focused selection passes10 in8.9s. `make check` and whitespace checks pass. Browser fixtures at390px in both themes show a188px offline toolbar and first code aroundy826, with320px first code aroundy878; desktop toolbar remains49px. Fixtures include the additional manual offline refresh control and are not served/native measurements. The first two source runs exposed hidden-label locator assumptions and an unsupported175px offline bound; corrected assertions target accessible disclosure labels and require44px controls, no overflow and code within the900px fixture viewport.

At this source checkpoint the increment was not deployed; the c385235px served mobile measurements below were the baseline. The bounded replacement qualification above now supersedes that runtime. Migration037/native inline publication was still isolated at this earlier checkpoint; no native review, inference, CI, remote push or full-parity completion is implied.

## Repository URL and enabled-unit integration (historical c385 qualification, 2026-10-03)

Product source `bfbb5deba7d86c298cc18b81e9326b402da9d533` adds canonical `/OWNER/REPO/settings`, `/settings/access` and `/settings/workflows` with supported legacy aliases. Source/path-history SHA routes omit redundant `ref` and path-owned query selectors; issue/PR filters and deliberate source/history return context remain separate. Incoming deep selectors are validated before any cleanup or authority request. A conflicting query ref cannot select another snapshot. Authorized source reads normalize old file links and tree/blob aliases using the returned kind, preserve fragments, and cannot overwrite navigation with a stale source receipt. Readable branch/tag path entry still needs a qualified slash-ref/path resolver.

Repository projection adds optional `issuesEnabled`, `pullRequestsEnabled` and `wikiEnabled` configuration flags. Explicit false hides Issues/PR tabs and blocks their deep-link panels, Compare and feature reads. Unknown remains unknown and does not manufacture a disabled state. True grants no permission and does not imply an internal unit: the installed native configuration also reports externally hosted Issues/Wiki units. Golf does not follow external unit URLs. Wiki configuration is read only because no Golf wiki workspace exists. Existing mutable repository activity revalidates metadata; snapshots remain pinned. This does not establish that every external settings edit emits such activity.

Backend unknown/false/true/malformed/private-denial projection and existing settings/source/session regression passes on isolated PostgreSQL18.4 with race checks (27.420s). Actual supported-native owner PATCH/read-only caller Get/List true/false/mixed proofs pass (2.014s/1.880s/2.073s); enabled Issues still denies a caller without issue-read scope. All disposable native actors, repository, envelopes and PostgreSQL fixtures are removed. No live Golf database writes, inference, workflow execution or remote organization writes ran for those checks. The additive API schema digest is `09697c1a5f48d692e321164fd85b210b8ff80a4c7eed1be79a0970cde84ae5ed`.

Dedicated final route coverage passes48 browser cases in28.5s and the corrected repository/settings/live/access slice passes67 in1.5m. The first67-case run had63 passes/four failures: a newly exposed stale-source navigation race affected three cases and one fixture still expected unsupported Wiki editing. The source guard and fixture were corrected. The first broader338-case run had337 passes and one blocked download-menu interaction during offline metadata polling. Metadata now revalidates only on confirmed activity/reset; a dedicated reconnect/menu stability case and all339 final affected browser cases pass in2.4m (`.tmp/repository-url-units-integrated-final.log`). A separate four-theme/viewport download/history rerun also passes14.5s. Final `make check` passes. Replacement-image qualification now passes, as recorded next; the preceding af5 image/captures below remain historical and are not relabelled. Go/TypeScript/vet/generated-drift/whitespace checks pass. This is not full native feature, CI, protected merge or review-publication parity; the [native feature and URL audit](NATIVE_FEATURE_AND_URL_AUDIT.md) retains those gaps.


The local replacement deployment exits0 with Golf container image reference `sha256:c385dfcaba691d260137731d35fdc084aff07651da2c797db04bf1709750d1c1` and OCI config `sha256:f5278cd59460f403699a547f2a55f288e19d6640340770b622e9a2d81c9aaba8`. Worker reference is `sha256:c515fa530364446fd8eeb2531026c8e85adc6cea73163c91414f1036b2ec95ed`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Database/forge readiness passes, schema036 stays applied, and both queues are0 after proof. Migration037/IR-3 work was isolated at this c385 checkpoint; the later bounded publication release is recorded above.

Final actual served/native/browser qualification exits0 (`.tmp/repository-url-units-served-proof.log`) on unchanged runtime identity before/after. Owner-supported native PATCH true/false/mixed matches served managed-reader repository fields exactly; the private outsider is denied and original configuration is restored. Actual Unicode legacy file links normalize to `blob/SHA/literal-path`, retain `#L2` and reload; Settings opens its canonical path with reader-only values and unsupported Wiki explanation. The complete preceding private-draft qualifier also passes: native annotated tag/object/peeled commit and selected latest-commit receipts, original M/B/H/diff/old-new coordinates, version CAS/status replay and changed-intent denial, delete/recreate generation fencing, native/private authority denials, actual Add/Edit/Save/Reopen and live access revocation. No private draft emits a native review or shared activity. The two-draft/five-version/seven-content metadata checkpoint precedes browser edits and is not a final retained total.

Fourteen new PNG/TXT captures and layout/provenance metadata live in owner-only `.tmp/url-unit-served-proof/`, separate from historical af5 artifacts. Root visually inspected Code at1920px dark and390px light plus the private workspace at390px dark. The1920px main remains1440px atx240 with no overflow; the390px plain Files changed toolbar remains235px high aroundy528 and first code aroundy901, so mobile above-fold density is still open. All fixture native actors/repositories are purged, Golf sessions/bearers revoked and fixture accounts disabled; encrypted Golf draft/tombstone/account history is intentionally retained. This proof does not cover actual network-byte/SQL lost acknowledgements, two-device/restart or latest-schema recovery, protected merge, native inline publication, inference, CI or Cloudflare. No remote push ran.

## Bounded Code workspace, native refs and latest commit (bounded local qualification, 2026-10-03)

The preceding Code increment corrected the full-width workspace experiment: repository work surfaces, base main layout and shared inventories again have a 1440px maximum while adapting to smaller viewports, preserving Golf's charcoal/light surfaces, lime accent and readable 14px filenames / 13–14px metadata. Code directory rows contain name, latest change message and relative author date, with no duplicate per-row author. The real latest-commit banner separately shows native author name, message, exact commit navigation and relative time for the selected snapshot. Native author text is not a guessed linked Golf username; authorship is not a verified committer identity. Relative dates retain exact datetime/full locale tooltip, render future dates explicitly and add no timer/subscription. Absolute dates remain the default elsewhere.

Generated read-only `ListTags` binds current canonical repository ID, paged inventory and independently rechecked authority. Tag object ID stays distinct from the peeled source commit; selecting a tag opens its listed exact commit. Branch/tag totals are optional native observed counts, never loaded-row counts; absent counts remain unknown. Search covers loaded pages and each inventory continues explicitly. Separate count/ref/source observations are not atomic. No tag write, release, signature verification, archive or tag-specific CLI/MCP command is added.

`ListCommits` exact repository-ID/full-SHA binding now also permits an empty literal path for the latest-snapshot banner. Responses echo repository ID, full selected commit and path; a receipt mismatch hides the banner rather than inventing author/message evidence. Existing literal file/directory row limits, current read authorization and private-content clearing remain intact.

The 11 focused relative-date browser cases pass 12.0 seconds, including near-now, future, all displayed age units, exact tooltip/datetime, absolute-history default and invalid fallback. TypeScript and whitespace checks pass for this slice. The frozen API schema digest is `0a7f0341474f4b41acf7525b69ecef32d27814cee8e866d0e51645d7229e25ea`. Final bounded served proof passes on the replacement image below. Prior 490-browser/5ae runtime and gallery observations retain their actual provenance; they do not qualify this new source. The newly spaced native-draft proof passes on the replacement image recorded below. Latest-schema036 recovery, P0.8 protected merge and IR-3 native inline publication remain open; no inference, CI, remote push or deployment ran for this documentation increment.

Source `44a9c7823718a9a942f28cc5e7797d9b82b38a67` and parser correction `6a71470eff8f93b95838e336290349946aa8dd7a` are frozen. Product `make check` passes. Final affected repository/source/live coverage passes 76 browser tests in 1.3 minutes; six theme-persistence screenshot cases pass 13.8 seconds and reload explicitly checks the selected theme. The initial full 514-case run had 507 passing cases and seven new fixture assertion failures in query ordering/extras or ambiguous menu selectors; the corrected affected suite passes. This is not a claim of a subsequent full 514-case rerun.

Disposable PostgreSQL 18.4 race coverage passes 33.118 seconds. A supported-native handler/Git source proof passes 4.369 seconds with 63 mixed annotated/lightweight tags, 64 branches, exact 1/20/100 caller sizes across a 50-row native clamp, object-versus-peeled identities, observed counts/latest SHA and wrong-ID/outsider denials; owned fixtures are purged. Honest zero/unknown empty-branch cases pass 1.916 seconds and API-boundary/pure-paging coverage passes 1.469 seconds. No schema change is added beyond 036. The source/helper checks are distinct from the final actual replacement-image Code/private-draft qualification below.

The final combined source includes browser spaced-path parser correction `cf90c40a5fed6aa1605fba5e1764fe4e41352af1`, with unchanged API schema digest. A genuine native spaced filename had been parsed incorrectly in the UI, hiding eligible private-draft line controls; the shared renderer now retains its literal path. The focused 35 parser/private-draft browser cases pass 44.1 seconds and TypeScript passes. The preceding deployed trial passed six Code captures and four ordinary draft-workspace captures, but its spaced-file private-draft run failed; those observations are historical and do not constitute complete final qualification.

The replacement is deployed locally on Golf image `sha256:af5d1116be903514b91374b2cc9deae2d98bc9743e3fc47465b5dc2b46403647` (OCI config `sha256:b0f07bf22cdbe47dc3940bf197ce28e98cf0c4647d7800274481b7993864fd0e`). Worker is `sha256:2a001aea3fff1c2f24ab6234a14db65f1c66dcea4ee6013cf3cb6e1e20da4a3a`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Deployment exits 0, database/forge readiness passes, queues are empty and schema 036 is applied. Actual replacement-image qualification now passes, as recorded below; the 14 captures retain this exact image identity and do not relabel earlier screenshots.

The [native feature/URL audit](NATIVE_FEATURE_AND_URL_AUDIT.md) records current supported integration and residual route/UI gaps separately from this bounded proof.

Final actual served/native qualification exits 0 on the unchanged replacement image before/after the run (`.tmp/private-review-drafts-final-qualified.log`). It verifies exact native tag-object/peeled-commit identities and observed totals, selected-snapshot latest-commit receipts, wrong-ID/current-authority/privacy denials, retained comparison, version CAS, target-generation delete/recreate fencing and exact operation replay. Actual spaced/Unicode path Add/Edit/Save/Reopen succeeds with the literal native path and empty terminal TAB delimiter. No native review or shared repository activity is emitted by private drafts. The API checkpoint before subsequent browser edits contains two draft identities, five versions and seven encrypted content records; these are not final retained counts after browser saves.

Fourteen actual Code, ordinary workspace and private-draft viewport captures accompany the checks. Root visually inspected Code at 1920/390px and the private workspace at 390px. The 1920px Code workspace measures 1440px wide at x240, with desktop 41px and mobile approximately 72.5px source rows. On the plain 390px Files changed capture, the toolbar is 235px high and starts around y528, with first code around y901 in a 900px-tall viewport; patch content remains below the fold, so further shared density refinement stays open. The desktop toolbar is 49px high around y382, with first code around y561. Native actors/repositories are purged, temporary sessions/bearers revoked and Golf fixture accounts disabled. Encrypted Golf draft history remains retained by design rather than being directly deleted.

The final renderer change passes 79 affected commit/compare/PR browser cases in 1.1 minutes and 35 parser/private-draft cases in 44.1 seconds with TypeScript checks. This bounded Docker/native/browser evidence supersedes earlier source-only/pending 036 statements; earlier 034/image/gallery proofs retain their original scope. It does not establish full 514-case rerun, genuine network byte-boundary/SQL acknowledgement-loss behavior, backend-restart/two-device browser qualification, Cloudflare execution or latest-schema 036 recovery. Discarded-response-body status inspection is narrower than a real commit/network-loss drill. Native IR-3 publication, protected merge/P0.8 and canonical URL/native feature gaps remain open.

## Encrypted private PR draft backend (2026-10-03)

Source commit `9f51f5f` adds browser-owned Get/Save/Delete private Golf review drafts under migration036. First Save independently captures exact native repository/PR/M/B/H/revision/diff SHA; later edits retain the encrypted original comparison. Version CAS plus a permanently retained target generation fence delayed requests across delete/recreate. Typed ordered intent binds a once-only operation receipt; tombstones never reuse UUIDs or return deleted bodies/source. Current managed owner/session/native authority and exact Origin remain mandatory; API delegation and administrator access to another owner's draft are denied. No native write, inference/workflow or shared repository activity is emitted. [Bounded contract](PULL_REVIEW_DRAFT_CONTRACT.md), [generated API detail](INLINE_REVIEW_DRAFT_API_PROPOSAL.md).

The review-content AEAD family participates in startup/usage/rotation/retirement for current and historical SAVE/DELETE/comparison records. Explicit transport/content/version/owner/instance bounds and reserved Delete capacity prevent unbounded retention. No purge or native draft/publication path is enabled. Missing acknowledgements are inspected by exact operation; postcommit authority uncertainty cannot claim no effect or trigger an automatic write retry.

All19 top-level draft tests/subcases pass with real disposable PostgreSQL18.4 under `-race` in45.514s, including concurrent edits, delayed save/delete/recreate, retained context after push/rename, owner-lock revoke/expiry, historical DELETE key rotation, ciphertext/AAD guards, escape-heavy bounds and500 saturated creates followed by all500 tombstones. Combined main035+036 draft/key/publication race coverage passes80.355s; the corrected actual034→latest migration fixture passes2.295s. The earlier broader draft/key/diff/workspace/review/RPC selection passes130.987s. Go packages/vet, TypeScript, buf/generated drift/SQLC and whitespace checks pass. Old-schema fixture seeding precedes latest runtime startup; production code adds no downgrade fallback.

**The bounded backend/UI replacement-image served/native qualification passes above.** The original backend tests below remain source/SQL evidence, not proof of every runtime path. Latest-schema036 recovery remains unqualified and protected merge/P0.8 stays open. Full inline publication, native PENDING lifecycle, replies/resolve and richer coordinate/CLI/MCP parity remain required; the overall plan is incomplete.

## Managed reviewer publication repair (2026-10-03)

The integrated source packet now captures exact native repository/PR/M/B/H and the accepted patch fingerprint, uses a strict typed coordinate parser, scans publisher-owned pending reviews through the configured native pagination span, and journals immutable once-only dispatch with same-publisher/target exclusion. Complete native header/child/body/coordinate/context readback and post-observation authority are required for success. Unknown effects survive restart, source movement and fresh intents; existing legacy publishing/unknown/outdated rows conservatively block their original domain without invented native identity. Their details explain the uncertainty while preserving original state/freshness and historical receipts. Published legacy receipts keep their historical proof. [Contract and limits](REVIEWER_PUBLICATION_CONTRACT.md).

The predispatch gates cover final escaped comment bodies, native scanner/control/retained-context limitations and known aggregate encoded receipts exceeding the existing2MiB transport bound. A real-PG regression holds preflight while an earlier intake attempts supersession; unresolved reservations remain visible and cannot become outdated. Focused real PostgreSQL race coverage passes20.820s, including an actual034→035 upgrade; focused Go race passes1.526s. The subsequent caller correction visibly terminates known no-dispatch refusals instead of leaving succeeded tasks queued/running, without a contradictory native status from a losing publisher. Publication/worker/migration real-PG race coverage passes24.843s; final owned-worker variants pass5.291s, including legacy scan/wire uncertainty without invented receipt/state. All disposable databases are removed. Final main `make check` passes Go formatting/vet/tests, TypeScript and complete generated drift; the full main Go race suite also passes (server5.095s).

`make qualify-reviewer-publication-native` passes on integrated source against supported native1.27.3 and an isolated Golf PostgreSQL database, following the first worktree run. The actual production helper refuses the publisher's existing PENDING review without changing its original child, retains a rejected nonreplaying intent, then publishes exactly one fresh review with complete independent header/child/body/M→H context verification; repeated publication leaves one native review. Temporary helper sessions are removed. Both disposable native actors, repository, database container and owner-only credential file are purged after each run. This deterministic source-helper proof executes no inference, workflow or served managed worker and does not qualify those paths or Cloudflare execution. The earlier actual parser proof separately rejects a historical selected header with newer native hunk context.

Local implementation commit `38704fe3428d2a877b49a588089415931a6fe597` is deployed. Golf runs manifest `sha256:ff83738858e94e8f14333ce3d3e1d3dd885d3b7509cbee9b65681380bc0db19b` (OCI config `sha256:5d09e858ceca71bae058392520d17403de747415c5576ddf35cb5bcaf298810c`); worker is `sha256:e71ab0d1fddf0da5b40246eab43424aba7bbe55f074f16b650c11c973ac95c86`, runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Schema035 is applied, database/forge readiness passes and both queues remain empty. Eight existing outdated rows receive the conservative legacy block rather than speculative cleanup. No qualifier overlapped deployment. Web sources are unchanged; the443-browser and gallery1f81b70e captures below retain their actual earlier-image provenance rather than being relabelled as new runtime captures.

Journal exclusion remains actor-specific and native effects non-atomic; unexpected native metadata overflow stays unknown. Original per-entry receipt persistence, native reconciliation, complete human draft/review lifecycle, P0.8 protected merge and coordinated latest-schema035 recovery remain required. The recovery tool continues to reject unqualified schemas. The IR-2 backend source is now integrated separately above; its bounded final UI/served qualification passes on the deployment recorded above. No inference, workflow execution, remote push or remote organization change ran; the full implementation goal stays active.

## Exact PR identity and actual old-side comparison (2026-10-03)

Golf's PR diff API now requires exact native repository/PR IDs together with the displayed branch-tip/head objects, and returns those IDs plus the native merge base. The old side is merge base M, independently distinct from a diverged base branch tip B; the shown comparison is M→H. Retained PR head and current caller/repository/native identity, state and merge-base observations bracket the bounded read. The browser rejects mismatched receipts, binds line anchors to M/H, resets Viewed for a changed selection and labels the old side, head and divergent target tip separately. Missing or malformed old-side metadata blocks the diff request. These are bounded observations, not an atomic ref lock, provider-cache completeness or merge authorization. [Exact contract](PULL_DIFF_CONTRACT.md).

CLI `pr diff` and MCP `golf_pr_diff` take the same six explicit bindings without automatic lookup. Canonical decimal IDs and full lowercase equal-width hashes are checked before temporary PAT login; both PAT and owner-issued read-only bearer modes retain current authority. The catalogue now has23 tools. Native commit/check reads reuse the same selector; no review-write delegation is introduced.

Final `make check` passes formatting, Go vet/tests, TypeScript and generated drift. The full **443-test browser suite passes2.6m**, including the seven new comparison-binding cases and the shared responsive correction. Six focused toolbar cases pass8.4s in both themes at1280/390/320px: controls wrap whole buttons, retain single-line readable labels and stay within the viewport. The earlier116-test affected suite passes58.5s. Real isolated PostgreSQL18.4 diff/workspace/PR/mutation/review/API-credential/RPC race coverage passes95.398s; CLI/MCP race coverage passes2.184s. The new Go MCP smoke inventory/receipt assertions compile but its standalone native smoke was not rerun.

`make qualify-pull-diff-binding` passes on the final running image `sha256:1f81b70aec461e5d2591ffb58ab17ede5f1b13fa07e18e97b60bb29a12d47017` (config `sha256:15e9f7af64605d4ded836ffcbab330baa4a1a5c88f6dd870c63f67baf0b20a9d`). A disposable renamed private fork diverges target B and source H from common M. Supported Git clone/fetch independently verifies full object IDs, all three blob contents including final newlines, and byte-for-byte native diff output. API/CLI/PAT-bearer MCP receipts match; the base-only reader independently lacks general fork access. Wrong repository/PR/head, outsider and foreign Origin requests fail. Four actual served dark/light1280×900/390×900 captures accompany assertions for all three full object labels and every M/H line anchor; live collaborator removal clears the private diff, and subsequent target movement rejects the original selection. All four actors, fork/base repositories and temporary sessions are purged/revoked. Root visually inspected desktop and mobile captures. An earlier qualified image exposed broken mobile toolbar words; the final shared correction and replacement-image proof supersede that presentation.

The updated `make qualify-pull-workspace` also passes against that final image: private-fork commits/pagination and denied general source access, latest mixed native checks, read-only delegation/scope/Origin, stale-head denial, source-branch deletion retaining history, both themes/mobile and live removal of all three private status rows. Its first browser attempt tried to click a refresh control hidden while live and asserted denial after1.5s. The harness now waits for actual SSE row detachment within15s, checks the denial alert and independently confirms Pending/Failure/Success rows are absent. No product behavior was weakened; the final run exits0 and removes every fixture repository/user/session.

The new [inline-write characterization](PULL_INLINE_WRITE_NATIVE_QUALIFICATION.md) passes eight serial supported-native cases and removes all five fixture actors/repository. It proves historical review headers can coexist with newer stored hunk context, pending append/submit can rebind headers, later-child500 and final-submit422 failures can leave pending children, and a known hidden pending parent can accept a reply or author resolution despite read404. These findings constrain the [IR-2–IR-8 implementation design](INLINE_REVIEW_IMPLEMENTATION_DESIGN.md). Encrypted retained comparisons/CAS owner drafts, server coordinate admission, independently journaled once-only batch publication, visible-parent replies, richer coordinates/suggestions and scoped agent writes remain required. **P0.8 protected merge/squash/rebase and coordinated latest-schema034 recovery remain open.**

Applied schema remains202610030034; no migration is added. Database/forge readiness passes and both job queues are empty after proof. Worker is `sha256:3121984652874c7cb3e93d413c2a0500d0dcc8539442c7b9d23767ba15c20f97`; runner is `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. No deployment overlapped a live qualifier or capture. No source/imported workflow execution, paid inference, remote push or remote organization change ran. The shared portable/Cloudflare contract advances without claiming Cloudflare-specific deployment qualification; the complete goal remains active.

Local implementation commit `9ec28a6b9f1494760519e912f46b23608b29671f` and sibling docs commit `b0883172f6f35bc6549d0390a38f2aa94c437e05` retain this increment. Docs TypeScript/build/export/whitespace checks pass; API/CLI/MCP23/PR/status guides pin that source and proto SHA-256 `34cb6632b27cc18931d043b35f24c2d0c43364e31af6e69cbe73470c336f802b`. Commits remain local.

The final [bound-diff gallery](http://localhost:4326/deep-comparison.html?page=bound-diff) has132 Golf captures across33 surfaces,54 actual signed-out public GitHub references,43 choices and26 element comparisons. The120 generic and four bound-diff captures use the final image; the eight earlier human/inline-review qualification captures keep their actual historical provenance. All43 choices × two widths × two themes pass file/HTTP image decoding, overflow and script-error checks, as do all26 element comparisons. All12 qualification text companions match HTTP byte-for-byte; loopback4326 serves396 curated HTML/PNG/TXT assets. The bound fixture was purged and its demo link explicitly opens a different retained PR; no authenticated GitHub comparison is invented. OCI image config and the separately observed Compose configuration hash are labelled independently. Mobile labels are readable, while mobile header depth/below-fold patch placement remains a recorded density gap. [Visual audit](GITHUB_VISUAL_AUDIT.md).

A parallel static audit found that the existing managed bot inline writer predates these safeguards: it accepts only review ID/publisher/head receipt checks, lacks publisher-owned pending preflight and independent complete child readback, uses a permissive coordinate parser and can replace `publication_unknown` with snapshot `outdated`, admitting fresh intents. Its current happy-path qualification does not cover those hazards. Correcting durable cross-intent uncertainty, exact comparison/context binding and complete receipts is a priority before extending authoring; it must retain the full intended agent-review capability. No provider ran during this audit. The next work packet must preserve historical uncertain effects, including legacy rows whose original dispatch state cannot be reconstructed, without guessing native ownership or enabling replay.

## Bounded inline review reads and expanded native boundary proof (2026-10-03)

Golf now reads complete bounded inline-review collections through generated `GetPullRequestReviewComments`, the explicit Conversation review expansion and the optional Files changed comments panel. Shared compact comment headers, avatars, safe Markdown, dates and global CSS retain Golf styling. Draft reviews use **Draft updated** with the native update time, and own pending inspection is explicitly read-only. Literal old/new file coordinates and recorded hunks are presented without fabricated current source anchors or reply threads. Resolution is observed per comment; a deleted resolver retains the resolved flag with an unavailable identity. [Read contract](PULL_REVIEW_COMMENTS_READ_CONTRACT.md).

The API requires exact native repository/PR/review IDs, repository-local number and the selected full reviewed commit. It reads the entire native unpaged array, rejects more than100 comments, and retains2MiB JSON/256KiB body/64KiB hunk limits. Caller/repository/PR/review/count observations bracket the read, own PENDING visibility is checked before child fetch, numeric IDs remain strings, and order is creation time then exact numeric ID. The observed current head can be unavailable independently of the recorded review. Header/count checks do not lock concurrent body/resolver edits. CLI `pr review-comments` and MCP `golf_pr_review_comments` require the same six bindings; the MCP catalogue now has22 tools. Delegated read-only credentials can read but cannot publish.

Validation: final `make check` passes Go formatting/vet/tests, TypeScript and generated drift. Final full **434-test Playwright suite passes2.5m**, with44 new inline/privacy/live/navigation cases and390 existing cases. The affected109-test suite passes38.1s. Real isolated PostgreSQL18.4 read/API-credential/RPC/auth-boundary race coverage passes21.936s; the later inline-specific unresolved-current-head suite passes16.151s. CLI/MCP race coverage passes2.029s. An initial final browser run passed431/432 but exposed an intermittent unchanged keyboard tab test: refreshing access hid the focused constant tab link. Ten traced repeats passed; the narrow product fix preserves constant PR navigation while concealing private title/body/editor/diff during revalidation, and a held-refresh regression test now verifies it. Direct native body/resolver edits emit no Golf journal event; the explicit inline refresh remains visible while live and is tested to replace the private observation. Automatic external-edit reconciliation remains unqualified.

`make qualify-pull-review-comments` passes on running Golf image `sha256:ce7530520f0456a55d9188e99412f3e3ec3b48830f2413baf932220f8137ec31` (config `sha256:b77d7001dee9a7b21828e3bf20bf8620803e990eb9cf523bac201423c25a9ccd`). The actual supported native1.27.3 fixture publishes53 comments and one reader reply; Golf independently preserves all54 IDs, body/path/side/blame/original/hunk/time/URL/author metadata and individual resolver state. It proves exact-target/head/private/Origin/pending denial, own pending reads, CLI and PAT/bearer MCP, production browser lazy expansion, safe Markdown, deleted-resolver details and an unresolved same-line reply, both themes at1280×900/390×900, Files changed context and live collaborator revocation. Disposable actors/repository are purged and temporary sessions revoked/signed out; no private fixture is retained in product. The native probe separately characterizes old/new lines after head/rename/deletion and unpaged53-row behavior despite50-row settings. [Native findings](PULL_REVIEW_COMMENTS_NATIVE_QUALIFICATION.md).

Future writers must independently authorize a visible parent review: the supported native reply route can append to another actor's hidden PENDING review if the parent ID is known. Native batch creation is also nontransactional and can leave a partial PENDING draft. Inline authoring, persisted drafts, reply/edit/delete, suggestions, whole-file/multiline comments, accurate original/current anchoring and complete conversation resolution remain required, with once-only immutable intent and unknown-outcome handling. These reads do not authorize protected merge.

The expanded boundary fixture on the native forge at the time (document removed with the earlier backend) passed 6 classifier test methods (0.143s) and a serialized actual isolated native run: supported repository/main metadata and current-user PAT/Bearer-PAT reads, invalid Bearer rejection, wrong repository/owner identity rejection before consuming the receive slot, valid exact-C push, and an explicit post-publication receive replay denied without changing feature/main. Fixture users/repos/containers/volumes/networks are removed. This is not an actual OAuth JWT lifecycle, production transport, durable admission, paused accepted-write SQL-loss/restart proof or effective expiry fence. **P0.8 protected merge/squash/rebase and coordinated latest-schema034 recovery remain open**.

The [inline-review visual gallery](http://localhost:4326/deep-comparison.html?page=inline-review) contains54 actual signed-out public GitHub references and128 Golf captures across32 surfaces. The120 refreshed generic captures and four new inline-reader captures bind the current image; four earlier human-review editor captures retain their actual prior-image provenance. Both qualification sets are explicitly Golf-only, with subsequently purged fixture captions, actual visible-body text and different retained-demo links. The inline captures are scrolled viewport observations with open deleted-resolver details. File and HTTP verification passes42 choices × two widths × two themes, image decoding, no script errors/overflow and26 element comparisons; all eight qualification text files are served byte-for-byte. Curated loopback4326 serves only HTML/PNG/text.

Database/forge readiness and applied schema034 are observed; no new migration is introduced. Both queues were empty before replacement and after proof. Worker is `sha256:eb2aa70a0888f4f624d96d57138d09db9e4db564e770bc1945cdaf0a8d6683f9`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. No deployment overlapped a native qualifier. No source/imported workflow execution, paid inference, remote push or remote organization modification ran. The complete implementation goal remains active.

Local implementation commit `b99de7ad61933d8ce92505d692f7bdfb87369c4c` and sibling docs commit `8d3cd20a7668ad946b7beab54b4ce53b9c3956f8` retain this increment. Docs TypeScript, production build, agent-readable export checks and whitespace pass. The API guide pins that full implementation revision and schema SHA-256 `cc9a5c5a747e352ed5d89132d1b86572ead971907d0b25dca497760c015c7882`. The live `next` PR guide contains the inline-read section, and the API guide visibly links the pinned implementation revision. Golf8080, docs3000, marketing4325 and the gallery4326 return200. Commits remain local; no remote organization is modified.

## Human overall reviews and native boundary fixture (2026-10-03)

Golf now publishes overall PR comments, approvals and change requests from an explicit **Review changes** panel in Conversation or Files changed. It uses the shared TanStack/Markdown controls, preserves the original displayed repository/PR IDs, revision and full base/head, and supports both themes/mobile. Draft text stays in memory; tab storage retains only request metadata. Uncertain outcomes offer status inspection without another POST. Review submission/status401 immediately clears the authenticated workspace and private query/request state. Earlier-snapshot labels compare recorded review commits to the current PR head independently of native stale flags. Inline draft comments, threads, suggestions, dismissal and richer reviewer controls remain required.

Generated `CreatePullRequestReview` and owner-scoped `GetPullRequestReviewMutation` use the append-only metadata journal034. Only a new committed reservation dispatches; receipts and independent native readback must match actor, PR, original full head, decision, body fingerprint and zero inline comments. Successful original-head publication is historical evidence, not current freshness, eligible approval, native CAS or merge readiness. Native read-only delegation can inspect own status but cannot publish. Current target access remains necessary for private review data; subsequent dismissal preserves historical success while exposing the current dismissed flag. [Review mutation contract](PULL_REVIEW_MUTATION_CONTRACT.md).

Native characterization exposed two hazards: body-only submissions can absorb an existing own PENDING inline draft, and hidden drafts are filtered **after** native pagination. The actual configured maximum clamps requested100 to50. Golf observes the supported API setting around total-based PR/review/comment/collaborator reads, uses its effective span and rejects observed drift. Pending preflight scans at most2000 native reviews/pages under a15-second child deadline; an incomplete scan never permits dispatch. This observes configuration and drafts; it cannot lock them or prevent a concurrent native draft appearing after preflight. Zero-comment receipt/readback detects unexpected absorption after effect and retains unknown without replay. [Native qualification](PULL_REVIEW_NATIVE_QUALIFICATION.md).

Validation: `make check` passes. The full **390-test Playwright suite passes1.6m**, including33 new review cases. Real isolated PostgreSQL18.4 race coverage for PRs, discussions, repository access, delegated credentials, RPC and native paging passes119.601s. A focused cancellation proof passes1.960s: aborting the second page of a partial hidden-draft scan durably rejects preflight, and replay makes zero POSTs. Configured-span missing/negative/drift tests, a pending draft beyond two empty50-row pages, once-only concurrent reservation, post-dispatch logout, unknown/mismatched receipts, immutable journal guards and historic dismissal are included. Exact15-second exhaustion timing is not separately qualified.

`make qualify-pull-reviews` passes on running Golf image `sha256:5e4ca543693c1d6fa86e3d7a5d3b1ce76d2a2a937874c2985fc80df15e0b9ae1` (config `sha256:aadebb5a567bfd9b5cb12a8578a70e7c648cec8288fa8887c33ce5c75be7d270`). Actual native API and served browser proof covers all three decisions, empty approval, reader unofficial approval, independent zero-comment receipts, same-key replay/conflict, self/wrong-target/pending exclusions, owner status, PAT/bearer/Origin bounds, Write/Preview at1280px/390px in both themes, real browser publication/readback and live private-draft access revocation. All disposable actors/repositories are purged; temporary sessions are revoked/signed out. Initial qualifier failures were harness assumptions: protobuf JSON omits default false, a nonunique alert locator, and an immediate assertion before asynchronous private-editor removal. The final proof waits for actual editor detachment and checks private text removal; product behavior was not weakened.

The separately isolated native operation boundary fixture on the native forge at the time (document removed with the earlier backend) qualified protocol classification, native network isolation, an exact declared single-ref expected-old HTTP push/readback, bypass denials and cleanup. Four classifier test methods pass. This is an initial BOUNDARY-1 fixture, not Golf's production forge transport, durable admission or complete mediation. Current-user/Bearer and full password/OAuth/session seams, broader Git protocols, paused native acceptance, SQL-loss/restart and effective-write fencing remain required before integration. **P0.8 protected merge and coordinated latest-schema034 recovery remain unresolved**; the existing recovery tool deliberately refuses unqualified schemas. Neither boundary nor reviews enables protected merge/squash/rebase.

The local visual gallery now contains **54 actual signed-out public GitHub references and124 current Golf captures** across31 captured surfaces. Four additional human-review screenshots use the owned subsequently purged native fixture at1280×900/390×900 in both themes; their text companions are actual visible body text, not ARIA snapshots. The gallery labels their different retained-demo link and does not invent an authenticated GitHub review comparison. Both file and loopback HTTP verification pass41 choices × two widths × two themes, image decoding, overflow/script-error checks and26 element comparisons. Only allowlisted HTML/PNG/text is served at [review-editor gallery](http://localhost:4326/deep-comparison.html?page=human-review).

Both queues were empty before replacement; database/forge readiness and applied schema034 are observed. Worker is `sha256:29a36a846e814edb08b697c5975a96fe38a2a3c101f55054b54b0980b2d2fc7d`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Deployment did not overlap native qualification. No source/imported workflow, paid inference or remote push ran. The full implementation goal remains active.

Local implementation commit `4de28377e8231a12843a9825ec0e80b59cb949fb` and sibling docs commit `3b7c9bbaadd51c8bff1ca0234d9e05b19f19c981` retain this increment. Docs TypeScript, production build, generated agent-readable exports and whitespace checks pass. The API guide pins that implementation revision and schema SHA-256 `307da06aa2fe237de7fa574a0a61e3a83034073be719e471dc5a50ef52880c33`; live `next` PR documentation returns200. Golf8080, docs3000 and marketing4325 remain available. Commits stay local; no remote organization was modified.

## Integrated source workspace, literal history and full-page issue creation (2026-10-03)

The source workspace now combines a contextual lazy Files tree, numbered escaped syntax, reloadable line/range selection, exact path/permalink copying, preview-text download and literal file/directory history. Directory rows add latest-change title/date through viewport-admitted reads capped at three concurrent browser RPCs. Canonical path history binds the native repository ID, full snapshot and literal path. The supported native endpoint ignores requested page size; Golf discovers its actual span and slices exact caller pages rather than trusting the misleading native pagination header. Native rename-following, blame, tag selectors, full-repository search, source writes and generic raw/binary/LFS downloads remain required. See [history/actions](PATH_HISTORY_CONTRACT.md), [Files navigation](SOURCE_NAVIGATOR_CONTRACT.md) and [row metadata](SOURCE_ENTRY_COMMIT_CONTRACT.md) for bounds and authority limits. The navigator's existing GetContents endpoint has no expected-native-ID receipt; UI query isolation does not invent that server guarantee.

New issue composition is a full page at `/OWNER/REPOSITORY/issues/new`, using the shared TanStack composer, Write/Preview, explicit Cancel and confirmation before abandoning an unsent draft. Existing frozen intents, durable owner-scoped outcomes and status-only inspection after uncertain writes are retained. No private draft is restored or silently reposted.

`make check` passes Go vet/tests, TypeScript and generated drift. The final full **357-test Playwright suite passes in 1.4m**. An earlier combined run passed355 and found two stale test assertions: a status locator matched both loading and success, and keyboard focus expected the former modal's title-to-body order. Narrow receipt selection and explicit title→Write→Preview→body focus assertions pass without weakening product behavior. Isolated real PostgreSQL18.4 path-history/RPC/API-credential race tests pass in 15.940s, including post-wait session revocation, native selection/identity drift, malformed pagination and exact sliced order. No SQL migration is added.

`make qualify-path-history` passes actual native Git/API, CLI, PAT/bearer MCP and production browser proof on Golf image `sha256:3a54e7c9af7577811f6839f49be4a805cccc911bd2762ae48804d4b173eb74ef`. It creates63 commits with Unicode/glob/leading-colon literal filenames, observes the actual50-row native span, verifies1/20/100 caller pages against Git, directory descendants, pinned history after branch advancement, wrong-ID/private/path/ref denials and exact third-page CLI/MCP results. Browser proof covers actual latest-change rows, selected-file tree/filter, line ranges, clipboard/download byte preservation, pagination/reload, both themes at1280px/390px and live access revocation removing source/actions. A separately owned full-page issue is created and independently reread through the native API. Disposable users/repositories are purged; temporary sessions are revoked and signed out. The older standalone issues-live script was updated for canonical routes but was not rerun and is not evidence for this qualification.

The final cached image was re-exported without provenance after the initial build tag disappeared from the local engine. Its config is `sha256:d98b03eebab804667e06347abbd610ebfd2c92d15d60d5ca74c1cbb6c93768f3`; native proof uses the actually running digest above. Worker is `sha256:f025e04f4773a8c63c345c9e9ca6bbd6437efbf551440cf5b0a6f3a81f15bd90`; runner is `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Agent/pipeline queues were empty before replacement; database/forge readiness passes. Deployment and native fixture qualification did not overlap. No source/imported workflow execution, paid inference or remote push ran.

The screenshot inventory now has **54 actual public GitHub references** and **120 freshly served Golf captures**, spanning30 surfaces in both themes and desktop/mobile. New source/tree/action/history and full-page issue choices are included; all record the same running image, settled content and no overflow/alerts. Visible directory metadata settles without admitting offscreen reads. Empty compare selects the same actual base/head and confirms no changes rather than reusing a populated preview. The actual rotating theme button is used. Both local-file and loopback HTTP gallery verification cover40 choices × two widths × two themes,26 element comparisons, image decoding, responsive fit and no script errors. Public references are signed out; authenticated GitHub write/review/admin/merge menus remain unexercised. [Visual audit and remaining density gaps](GITHUB_VISUAL_AUDIT.md).

The [protected merge implementation design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md) specifies the proposed mediation, admission, exact candidate, trusted producer/reviewer, uncertain accepted-write and recovery work packages. It enables no merge publication. P0.8, effective-write expiry/old-writer fencing and latest-schema033 coordinated recovery remain unresolved. Human reviews/inline threads, merge/squash/rebase, broader lifecycle controls, multi-job CI and native/ACP progress remain full requirements. The broader goal remains active.

Local implementation commit `e0c1cefb68084f47a5b109ac2d2997583fb18602` and sibling docs commit `d3f77e545d99d5183857af1e17a9e96527d72650` retain this increment. Docs TypeScript, production build, generated exports and whitespace checks pass; live `next` API/repository/issue/MCP guides return200 with the new contracts. The API guide pins that full implementation revision and schema SHA-256 `36c80c5b9dabd244f645e2076074efe83124f5109d85f80f45b3063daf1e4574`. Marketing4325, docs3000 and Golf8080 remain running; the loopback-only [page gallery](http://localhost:4326/deep-comparison.html) and [element gallery](http://localhost:4326/element-comparison.html) are refreshed. Only allowlisted HTML/PNG/visible-control text is served. Commits remain local; no remote organization was modified.

## Full-page compare/New PR and matched screenshot refinement (2026-10-03)

Local product commit `124089c` adds generated `GetRepositoryComparison` and canonical `/OWNER/REPOSITORY/compare`, with separately authorized native target/source IDs, existing named branches and displayed exact full commits. Supported native-forge APIs (the native forge at the time) compare same-repository or explicit renamed-private-fork sources. JSON commits are unpaged and bounded to500 returned rows; UTF-8 native diff is bounded to512KiB with exact byte count. Branch/session/repository observations are checked around native reads; there is no ref lock, formatter completion proof, mergeability or protected merge authority. [Comparison contract](REPOSITORY_COMPARISON_CONTRACT.md).

Paged loaded-only base/head selectors and an explicit source picker lead to shared Files/Commits views and an explicit ready/draft TanStack/Markdown PR editor. Source commit links use the source repository. Branch/source activity refreshes observations while preserving original commits/drafts; stale or currently rechecked selections block fresh submission. Private source/target denial clears preview/editor/text. The once-captured creation payload stays in memory; reload inspects only metadata-key status without a second POST, even when source preview is unavailable. Existing single-field lifecycle editors remain shared.

`make check` passes Go vet/tests, TypeScript and generated drift. The final full320-test Playwright suite passes1.2m; focused43-case compare/source/settings/organization and19-case compare/live runs also pass. Real isolated PostgreSQL18.4 race suites pass: comparison/mutation/discussion/workspace/RPC61.971s, then comparison/API-delegation17.879s. The initial combined API run exposed an old test attempting to downgrade latest schema033. That historical-upgrade fixture now starts from a fresh004 schema and migrates forward, retaining exact sessions/API history/recovery-invalidation assertions;033's deliberate Down refusal is unchanged. Passing tests do not qualify coordinated033 recovery.

`make qualify-pull-mutations` passes against actual native API/served browser on image `sha256:ff792ac8623980efea3fe27764a7f500cc249cbf79d8581969e2d5525a9b004d`: same-repository/renamed-private-fork comparison, exact commits/diff, stale/source/outsider/Origin denials, browser draft creation, shared title/description/draft/ready/close/reopen, replay and uncertain-result boundaries, and actual source-fork/target access revocation removing private unsent drafts. Disposable qualification users/repositories are purged. Final presentation-only changes pass the full browser suite and actual served capture/empty-comparison tests.

The shared mobile global header is65px, previously134px, with accessible workspace/account/theme controls and a bounded keyboard workspace menu. Compare selectors use aligned source/branch rows and readable44px controls. All104 final served Golf captures span26 surfaces in both themes at1280×900/390×844, including empty/populated comparisons, explicit editors and opened clone/branch/diff menus. Four new real public GitHub clone/branch screenshots bring references to48;20 element references and all gallery choices are reviewed with honest pending controls. An initial refresh sampled Opening repository; the final100-page refresh waits for headings and settled loading state, then four native empty-comparison captures complete the inventory. [Visual evidence and remaining elements](GITHUB_VISUAL_AUDIT.md).

Final Golf image is `sha256:b54ca4a502f51be3d6fc0fd98fcfe527ac4de469bdd6e328d21aa2fa677cbbed`; worker is `sha256:0e161f2c39da3dc6aacae6dfc9c2630dad62f64c131cb5f2c8392f4ba2fc8706`; runner is `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current namespace. Both queues were empty before replacement; readiness reports database/forge ready. The initial completed comparison build's tag was absent from the local engine; re-exporting cached layers restored it before deployment. No SQL migration, source/imported CI execution, paid inference or remote push is introduced. Human reviews, richer source/row metadata/actions, tags/ranges/large comparisons, broader CLI/MCP, multi-job/ACP and merge/squash/rebase remain full requirements. P0.8 and latest-schema033 recovery remain unqualified; the broader goal stays active.

Sibling docs commit `6307942` passes TypeScript, production build and generated-contract export checks. Live `next` PR/API/repository/status guides return200 and contain the new contract; the API guide pins product `124089c` and schema digest `2a2ea4e29afee72551bb5dd5475ce469a066a079d017f767a0eee5a03cc2b966`. The loopback-only [page gallery](http://localhost:4326/deep-comparison.html) passes36 page choices × two widths × two themes, and the [element gallery](http://localhost:4326/element-comparison.html) passes20 actual comparisons. Both local-file and HTTP-served image/control/responsive/script-error checks pass. Only allowlisted gallery HTML, images and visible-control snapshots are copied to the isolated review server. Temporary capture sessions are signed out and closed. No remote push ran.


## Shared diff hierarchy, filters and safe syntax (2026-10-03)

Commit and PR diffs now share a collapsible changed-file folder hierarchy, compact filename/parent emphasis, loaded file-type and Viewed filters, a hide/show sidebar action and native-index-stable navigation. A selected line opens its containing folders without changing the commit. Rename, deletion, binary and duplicate entry identities remain explicit. Tree nesting is bounded while full literal names remain accessible. The PR Files changed heading and actions occupy one shared toolbar. [Exact shared workspace contract](DIFF_WORKSPACE_CONTRACT.md).

Unified/Split, Wrap lines, Syntax colours and sidebar visibility persist as four sanitized booleans. Private paths/text, filters, Viewed and source/actor IDs never enter preference storage. Viewed stays in memory and resets on reload/new selection; it is not a submitted review. The existing lazy lowlight renderer colours each displayed hunk's old/new sides independently and emits escaped text/spans only. Shared language lookup accepts only own entries, including plain-text fallback for prototype-like filenames. Missing source between hunks is not reconstructed. Native raw output, line anchors, read limits and authorization contracts are unchanged. The two native diff menus open upward when needed, have bounded scrollable content and close with keyboard focus return on Escape or viewport resize.

Validation: `make check` passes Go vet/tests, TypeScript and generated drift checks. The final full **306-test Playwright suite passes in 1.2m**. Coverage includes directory keyboard navigation, native indices through filtering, rename/deletion/binary and special/duplicate/deep names, selected-line folder reveal with retained Viewed, loaded extension/Viewed transitions, exact raw output, persistent display versus private reset, independent multiline old/new tokens, literal HTML, prototype-like filenames, both themes and 320–390px layout/menu fit. Existing PR mutation, access-revocation and Markdown/source regressions also pass. Initial focused assertions used `.check()` after filtering removed the checkbox and an ambiguous old/new line locator; explicit click/result assertions and exact side anchors corrected those fixtures.

`python3 scripts/commit-diff-smoke.py --cli bin/golf` passes native Git/API/CLI and production browser proof on image `sha256:a7fc341746c7c266be59d6c0b1669a3b42802eef4c2f7695c75ab9acb9fac05d`: root/first-parent merge/empty changes, rename/delete/binary/symlink/gitlink output, UTF-8/control/byte bounds, immutable source after branch advancement, private/missing-scope denials and temporary CLI session cleanup. Actual browser actions qualify tree/filter/Viewed/display/syntax controls, literal script text, canonical source/history/reload, both themes at 1280px/390px and live collaborator revocation. Disposable users/repositories are purged. The first attempt reached the controls but retained a stale URL assumption; the passing probe uses canonical commit/tree routes. This read-only first-parent fixture does not qualify Golf merge mutations.

The final image adds menu placement/focus and own-entry language lookup. Its actual retained PR and commit captures pass both themes at 1280px/390px, and eight opened menu captures verify full popup bounds, syntax spans, no overflow/alerts and retained sign-in. An initial immediate capture sampled before the asynchronous native toggle placement; awaiting the same settled bounds as the browser test resolves that observation. Temporary capture sessions are explicitly signed out. All **44 public GitHub references** were refreshed with actual browser screenshots/accessibility snapshots. The local main gallery now compares these with **76 Golf captures**, with opened Golf filter/settings menus and honest pending surfaces. Gallery verification passes all 30 page choices × two widths × two themes, image decoding, 16 element comparisons, responsive layout and absence of script errors. Earlier unchanged-page captures retain their original provenance; current diff captures record the final served image. [Visual comparison and remaining layout work](GITHUB_VISUAL_AUDIT.md).

Current Golf image is `sha256:1cddabd2451b60dcc20b45340e0203220f83742035b589de948e10b2efa3545d`; worker is `sha256:9de8147c9ad07d6be77452f08bdd1ba1f3ce6a0ab3630e3ee328ca3ed6815fa5`; runner is `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current namespace. Agent/pipeline queues were empty before replacement, and readiness reports database/forge ready. The completed build's image tag was absent from the local engine on the first deployment attempt; re-exporting cached layers and redeploying succeeded. No source/imported workflow, paid inference or remote push ran. No API/schema change is introduced; schema033 recovery remains refused/unqualified. Server Viewed, richer file/source menus, additional context/whitespace comparisons, full compare/create, human reviews, multi-job/ACP progress and protected merge/squash/rebase remain requirements. GX-1/GX-3/GX-7 advance; the broader goal remains active.

Documentation sync at sibling commit `6a952b0` passes TypeScript, production build and generated-contract export checks. Live `next` PR/API/status pages return 200 and contain the updated content; the API guide pins product `42caa86` with unchanged schema digest. The loopback-only [page gallery](http://localhost:4326/deep-comparison.html) and [element gallery](http://localhost:4326/element-comparison.html) pass HTTP-served image/control checks.

## PR creation API and shared lifecycle editors (2026-10-03)

Two generated browser-session writes now create PRs and edit one existing PR field at a time. `CreatePullRequest` binds separately authorized target/source repository IDs, named branches and displayed full commits; explicit `owner/repository:branch` native addressing supports a renamed private fork. Creation is currently API-qualified; a full-page compare/New PR interface remains required. `UpdatePullRequest` binds the displayed revision, separate native PR ID and repository-local number for title, description, draft/ready and close/reopen. [Exact mutation contract](PULL_MUTATION_CONTRACT.md).

PRs reuse the issue discussion's TanStack editor, Markdown preview, global styles, private frozen drafts, duplicate-submit latch and owner-scoped durable outcome handling. Named Edit actions open the editor; no default bare form is added. Empty descriptions and false draft remain explicit optional values. Reload inspects a metadata-only outcome key without restoring text or resending. Background reads preserve the draft's original revision; stale rejection requires explicit review. Actual private live access revocation removes the editor and its unsent content. Draft/ready maps the pinned native title prefixes `WIP:` and `[WIP]` and verifies the returned flag; title edits may change draft state.

The journal distinguishes native issue and PR IDs, reserves once before dispatch, retains provisional receipts and independently rereads current caller-authorized native objects. Lost/malformed receipts, source movement, unrelated observed edits and post-dispatch authority loss remain unknown without retry. Native body-version admission and pre/post observations do not implement whole-PR atomic CAS, expected-native-ID fencing or exactly-once external effects. Human reviews, inline threads, full compare/create UI and merge/squash/rebase remain required; P0.8 protected integration remains unresolved.

Validation: `make check` passes Go vet/tests, TypeScript and generated drift. The isolated real PostgreSQL18.4 race suite (`TestPullMutation|TestIssueUpdate|TestDiscussion|TestPullWorkspace|TestPullDiff|TestPullRequest|TestRPC`) passes64.896s and removes its database. It covers concurrent same-key dispatch counts, PAT/OAuth, draft preflight denial/stale selection, separate immutable PR receipts, unrelated native changes, bad receipts, lost acknowledgments, current authority loss and schema033 guards. The full297-test Playwright suite passes3.2m, including shared ordinary issue regression coverage, exact one-field/presence/revision/identity inputs, frozen drafts, explicit stale review, unknown status-only reload, private cleanup, both themes and keyboard/mobile behavior. One initial focused run exposed a fixture mutating its shared Protobuf object; cloning the fixture corrected it without weakening the assertion.

Final served `make qualify-pull-mutations` passes actual supported native API and production browser tests: same-repository and renamed-private-fork creation, native default draft prefixes, title/empty-description/state transitions, author/writer permissions, reader-authored proposals, reader/outsider/independent-source denials, native stale-body409, durable replay/conflict and Origin/delegation/logout boundaries. The browser exercises all lifecycle controls, explicit shared editors, dark/light desktop/mobile and actual live collaborator revocation. Its first browser attempt tried a manual refresh hidden while Live was connected; the final qualifier instead waits for the private editor to be removed by native-access revalidation. Both attempts purge their disposable users/repositories. No source/imported workflow, paid model call or remote push ran.

Four actual served editor captures are retained locally under `.tmp/github-visual-audit/pull-mutations/`; both1280px/390px widths fit without document overflow. A subsequent capture-only pass refreshes16 retained PR tab screenshots and adds four title-editor views, bringing the main comparison gallery to68 Golf captures. Both galleries pass selection/image-decoding checks at desktop/mobile widths, with the QA session signed out and closed and no submitted PR edits. A PAT-authorized PR view can separately deny personal agent-account management; that is truthful independent authority, not a claimed reviewer failure. The preceding element audit adds16 real GitHub captures, bringing public references to44, with signed-out limitations and row/page/control acceptance recorded in [the visual audit](GITHUB_VISUAL_AUDIT.md#element-level-comparison-and-layout-priorities).

Current Golf image is `sha256:f59f8439bea54897b1487c59e9c40807ae4e3875ee7f6245c973b9af12ea9c24`; worker is `sha256:e3e77464471827a4d7abcbe6af042af734e2737d0a3a236767d70191f3d6f0a3`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current namespace. Schema033 is applied; latest coordinated recovery remains refused/unqualified. GX-4 advances while full applicable forge/collaboration/automation parity remains the active goal.

## Selected PR Commits/Checks and shared table spacing (2026-10-03)

The four canonical PR workspace tabs now include native commits and latest reported check contexts through two generated reads. Requests bind displayed immutable repository/PR IDs, number and complete base/head commits; current PR metadata and the base repository's retained `refs/pull/NUMBER/head` are checked around every page. Repository/caller/session authority is checked before/after successful waits. Mismatches fail as stale instead of silently following a new head. These are observations, not atomic locks, ABA prevention or independently verified provider-internal comparison completeness. [Exact contract](PULL_WORKSPACE_CONTRACT.md).

Commits reuse the repository history/date grouping/SHA-copy/source/message component. Checks reuse the shared loaded-only searchable/sortable/paginated TanStack table with native result/publisher/time/details; unsafe targets remove the action and are never fetched. Pinned native JSON aggregate state/count describe only a page, so Golf exposes no global passing decision. Native status publishers may be repository writers; success is not trusted execution or merge authority. Detailed check-run/job trees/logs/annotations and fork-only statuses are excluded. Relevant Golf PR/Actions events refresh check observations for the pinned selection; commit metadata stays pinned with explicit Refresh comparison. Events outside Golf are not promised immediate live coverage.

Validation: `make check` passes Go vet/tests, TypeScript and generated drift checks. Isolated real PostgreSQL18.4 race tests (`TestPullWorkspace|TestPullDiff|TestPullRequest|TestRPC`) pass31.273s, including PAT/OAuth pagination, malformed/oversized metadata, native selection/ref changes, current-access denial and mid-read local revocation. Disposable DB cleanup passes. All284 browser tests pass1.6m after the shared tab focus fix; after the final global table margin correction all92 affected repository/PR/live/account-table tests pass49.0s. New cases cover canonical/legacy routes, exact selection/page binding, loaded deduplication and duplicate-context refusal, safe literal text/links, denial/expiry cache cleanup, live check refresh versus pinned source and explicit comparison refresh, both themes/320–390px keyboard navigation. The full suite found a mobile ResizeObserver recentering the selected tab after focus moved; the shared reveal now honors the focused tab, and the original strict visibility assertion passes.

Final served `make qualify-pull-workspace` passes supported private-fork API/browser tests: explicit commit/latest-context paging, base-only retained commits/diff without direct fork access, mixed status outcomes, missing-scope/Origin/outsider/read-only delegation boundaries, stale-head refusal, no inherited old checks on a new head, retained history after source deletion, dark/light desktop/mobile and revoked-access cleanup. Native metadata/retained-ref and deletion hooks can settle at different times; the qualifier polls only failed-precondition read observations with fixed selected commits and never resends mutations. Earlier fixture/browser attempts exposed those transient races and an already-removed refresh control, then purged their fixtures. One attempt overlapped deployment and failed sign-in/session cleanup; native fixture accounts were purged, and the final isolated run confirms its own cleanup without claiming receipt recovery for interrupted requests. No source/imported workflow, paid model or remote push ran.

Four actual public GitHub PR Commits/Checks screenshots extend the deep comparison manifest to28 references across13 page types plus two history menus. Eight matching final served Golf captures extend it to64 screenshots, plus eight disposable private-fork captures. The interactive ignored `.tmp/github-visual-audit/deep-comparison.html` gallery passes page/theme/viewport and image-loading checks. New final PR captures have no page overflow or alerts in either theme at1280px/390px; desktop commit rows are67–68px and check rows60px. GitHub remains signed out; authenticated write/merge/settings references and job logs remain unexercised. Detailed GitHub Checks uses a sidebar/detail job workspace; the current native-status table is an honestly narrower slice, not claimed equivalent.

Global inventory toolbar/pagination labels no longer inherit editor23px/8px margins, reducing unnecessary spacing across all tables while preserving14px row text and touch controls. Current Golf image index is `sha256:f121b74edb8d61560119fcf1ae665408158166b2f6ec60165217def0b5a74ebd`; worker is `sha256:5f2ba0a740af905cf3f9e27872caf8341e5d191682be126f7ffd0709577032aa`; runner stays `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current Golf namespace. Schema032 is unchanged and latest coordinated recovery remains refused/unqualified. P0.8 protected merge/check enforcement, human PR lifecycle/reviews, persistent Viewed, richer queries/source tools, large-PR performance, new CLI/MCP catalogs, multi-job/native/ACP progress and complete forge parity remain required. GX-3 advances; the full goal stays active.

## Ordinary issue editing/lifecycle and served control refinement (2026-10-03)

`RepositoryService.UpdateIssue` adds browser-session-only title/description edit and close/reopen for ordinary issues. Explicit named icon actions open TanStack inline editors; no initial bare form is shown. Title/body/state are separate native PATCH intents. Empty body presence clears description. The displayed revision, exact repository/issue IDs and UUID key bind the existing metadata-only durable journal; only a new reservation dispatches. Stale/no-op edits reject before dispatch. Lost responses, invalid receipts, changed postflight fields and caller revocation remain unknown without automatic resend. The original draft revision survives background access checks; rejected edits require explicit review/reopening. [Exact contract and native limitations](ISSUE_DISCUSSION_CONTRACT.md#edit-close-and-reopen-ordinary-issues).

Actual pinned native qualification proves owner/writer changes, reader-authored issue edit/close, reader denial editing another author's issue, outsider denial, explicit empty body, native stale-body409, close/reopen, same-key replay and one-field/Origin/read-only API/logout boundaries. Native permission is checked on save; controls do not claim a per-action authority observation. Code push permission is not issue-unit permission. Native title/state remain non-atomic after their version check, and owner/name/number addressing lacks expected-ID admission. P0.8 protected merge/check enforcement remains required and unresolved.

Validation: `make check` passes. The full273-test Playwright suite passes1.0m; after the compact editor/disclosure/button refinement, all24 affected issue tests pass35.5s with TypeScript. Cases cover optional empty fields/exact IDs/revision/key, duplicate-submit prevention, stale draft preservation, explicit fresh review, unknown/malformed/current-object-less receipts, metadata-only reload/status, sign-out cleanup, distinct comment/description labels, keyboard focus and both themes/mobile. One earlier broad run exposed an ambiguous SSH test locator selecting both a removal notice and loading status; the exact notice locator was corrected, all5 SSH tests and the subsequent full suite pass. No product behavior was weakened for that test.

The isolated real PostgreSQL18.4 race suite (`TestIssue|TestDiscussion|TestRPC`) passes35.673s, including schema032 migration/guards, concurrent same-key replay with counted PATCHes, ordered journal/live events, missing/invalid native versions, PR refusal, changed identity, post-PATCH revocation,403/409/412/500 and lost/wrong/changed receipts. Its disposable database is removed. `make qualify-issue-updates` is the repeatable real Compose proof; all disposable users/repository are purged. Native qualification passes again on the final served image after the UI refinement.

The actual localhost browser passes title edit/restoration and close/reopen, restoring fixture #4 to its original title/open state. Pending convenience keys clear after verified results. Final dark/light desktop/mobile editor and normal issue captures have no document overflow. The screenshot revealed an oversized title editor (desktop294px→260px, mobile368px→281px); permission details now use a disclosure and Save/Close share the existing action row, retaining labels, readable fonts and visible focus. The interactive comparison gallery includes these real editors as Golf-only captures; authenticated GitHub edit/settings/merge references remain unexercised. No source workflow, imported workflow, paid inference or remote push ran.

Current Golf image index is `sha256:220ba558c32b759b6af786dbbe9683d96bc1c7dbdb2baf097bc608f1849872fa`; agent-worker index is `sha256:d433a06153a8c0616f8f5725f831c3ad61bcd3a0ac7775dcd94b74c57c8a7102`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current Golf namespace. Schema032 extends existing constraints/guards and refuses silent Down. Latest coordinated recovery is unqualified and remains refused by existing tooling. Labels/assignment/boards, unified timeline, PR creation/edit/lifecycle/human inline reviews, richer filters/source controls, multi-job/native/ACP progress, complete forge parity and protected integration remain full requirements. GX-4 advances; it is not complete.

## Broad GitHub screenshot comparison and compact history/discussion controls (2026-10-03)

The fresh reference pass captures11 public GitHub page types at1280×900 and390×844 plus two actual history filter menus:24 screenshots and control snapshots. Golf's paired52 served screenshots include those surfaces plus account/infrastructure settings in both themes. The local interactive `.tmp/github-visual-audit/deep-comparison.html` gallery selects page/theme/viewport and history before/after. GitHub is signed out; authenticated settings/write/merge menus and signed-in job logs remain unexercised. Different owned-local data means layout/affordance comparison, not pixel equality. [Detailed audit and acceptance tasks](GITHUB_VISUAL_AUDIT.md).

Commit titles/SHA open the exact diff; shared copy uses the complete SHA, and the code icon opens its pinned source. Meaningful full messages use a named ellipsis disclosure, with Escape/focus return. Inline disclosures remain open when focus leaves, avoiding a layout shift that could swallow the next pagination click. Consecutive author dates group across loaded pages without sorting native history. Desktop rows shrink from139px to67–68px while retaining16px titles. These are author dates, not verified committer dates/signatures. Issue/PR comments share compact author/date headers and named external-link icons; Markdown and private draft/paging/write contracts are unchanged. Mobile tabs occupy one45px scrollable row with44px targets, reveal the active tab on route/size changes and reveal keyboard-focused tabs. Existing global CSS/shared controls own these changes.

Validation: `make check` passes Go vet/tests, TypeScript and generated drift checks. The final full263-test browser suite passes1.0m, including author-date order across page boundaries/duplicate results, literal hostile message text, exact SHA copy, Escape focus, immutable diff/source links, mobile resize/focus, current-access denial and issue/PR discussion behavior. Product Docker build and docs TypeScript/build/generated-export checks pass. The gallery's actual browser checks pass page/theme/viewport/before selection and image loading without page errors. Final screenshots show no document overflow in either theme at both widths. No source-repository CI, imported public workflow or paid agent work ran.

Current Golf image index is `sha256:67f286a89581e35e5bb25c90106608f93e782080c87239522f9102898c9f191c`; agent-worker index is `sha256:4aff6870c0835401c9065c8b048b241330a49af7b3b63823c8269c4192c8b3d1`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in the current Golf namespace. Readiness reports database/forge ready; the QA browser session persists across replacement. Schema031 is unchanged and recovery remains gated. Richer filters, metadata/row menus, file tree/history/blame, issue/PR lifecycle/human reviews, multi-job/agent progress and authenticated reference qualification remain required. P0.8 protected merge/check enforcement remains unresolved.

## Worker-recorded steps and expanded GitHub interaction comparison (2026-10-03)

The portable runner now dispatches each Actions step through a separate native Docker exec in the same isolated workspace. Every exec clears ambient/image environment explicitly. The trusted enrolled worker records ordered start/finish events independently of stdout; schema031 stores append-only observations under existing run/attempt/lease/session/grant/policy fences. Replays are idempotent only when identical. Normal finish must agree with recorded completion when events exist. Cancellation/timeout/worker loss leaves observed work interrupted, with later steps skipped; historical uninstrumented outcomes remain unrecorded. These are observed CLI outcomes, not signed execution attestations or protected merge authority. [Runner contract](RUNNER_ISOLATION_CONTRACT.md).

Canonical run pages now show the stored single-job name/ID/stage and named step states/timing. `?step=0` selects the first step, with optional API `stepIndex` presence preserved. Step start/finish log sequences bound reads under repeatable-read isolation, preventing later-step output from leaking through a concurrently closed boundary. Direct pending-step links wait for real recorded starts. Shared live Actions invalidations refresh outcomes and selected scoped logs. The whole-run view remains separate. Commands and raw agent protocol/thinking are not exposed. [Exact API/UI limits](PIPELINE_EXECUTION_COMPATIBILITY.md#current-actions-run-workspace).

Actual GitHub screenshot/control inspection was extended to branch/clone panels, file controls/action menus, comfortable/compact PR rows and sort menus, plus the mobile repository shell. Golf now has loaded-only paged branch search, HTTPS/SSH selection and shared literal-text clone/code/source/diff-path copy buttons. Native disclosures support Escape/focus return; copy failure is announced. Empty files copy zero bytes rather than the visible placeholder. PR snapshot metadata shares its existing metadata line: the same fixture row contracts from94px to71px with16px titles and13px metadata preserved. Trailing issue metadata no longer takes half the title column. The mobile header uses two rows while retaining account/theme, workspace switching and both navigation links. Global styles and existing shared components own these changes. [Visual audit and remaining controls](GITHUB_VISUAL_AUDIT.md).

Validation:

- `make check` passes Go vet/tests, TypeScript and generated drift checks. The full262-test browser suite passes59.9s; after the final PR-density/mobile-header CSS changes, all51 affected workspace/repository/PR/run tests pass37.0s. Cases include zero-index step links/reload/live completion, pending-step waits, authority/cache denial, branch pagination/search/keyboard dismissal, exact clipboard bytes and clipboard refusal.
- The actual PostgreSQL progress/runner/log race suite passes3.852s, including event ordering/conflicting replay, oversized sequences, normal-finish coherence, immutable event rows, current authority loss, scope isolation and the FailedPrecondition mapping for unstarted steps. Its disposable database is removed. Native Docker isolation/timeout/cancellation/output bounds and explicit crash cleanup pass8.541s with the exact approved image already present.
- Disposable Compose proof passes real two-step Actions and shared-script GitLab execution, failure/skipped and cancellation/interrupted outcomes,49 log chunks over4 pages, restart, RustFS immutable source bindings with NULL database archives, policy revocation and attempt-resource cleanup. It ran backend image `sha256:49c798c636c861bb6e8d7b57860e1c06cf8a92e8679187848bca207cbb68fff1`; subsequent changes are presentation only. The disposable stack is removed.
- A retained owned local push runs two named steps successfully,15s and10s, and API/browser reads isolate the correct output markers. Review [the actual run](http://localhost:8080/golf-admin/golf-local-ci-0c61aa/actions/runs/a9031ab2-9500-4254-9301-435b5a7dd080?step=0). Its exact commit is `e64ce1ddeece` (full identity in the run receipt). Temporary QA token/session were removed; execution ceilings and automation grants were not changed.

Current Golf image index is `sha256:d87358cbeccf5261d682b86ff9267dc96e8dac673409f1a18949c2733558297c`; agent worker is `sha256:2daa7688012c64fe2f341dbc6c61aa377a7858b607517af04d902e37a6177f9d`; runner is `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`, recreated in Golf's current namespace. Production product/docs builds and docs generated-export checks pass. Readiness reports database/forge ready. No source-repository workflow, imported public workflow or paid agent task ran. The final48 served screenshots pass both themes at1280×900 and390×844 without document overflow, including actual isolated step logs and historical unrecorded states. Artifacts and metrics live in `.tmp/github-visual-audit/options-after-manifest.json`; matched public reference screenshots and controls live alongside them. Local screenshots remain ignored private development artifacts.

P0.8 protected merge/check enforcement remains required and unresolved. Multi-job/maintained-engine compatibility, richer workflow/row filters, authenticated write/settings/merge reference coverage, safe native/ACP agent progress, artifacts/cache/rerun, proxy/multi-replica/load qualification and schema031 recovery remain required work. The recovery operator still refuses schemas beyond its qualified checkpoint.

## Canonical Actions run workspace and complete stored-log continuation (2026-10-03)

Workflow rows now open `/OWNER/REPOSITORY/actions/runs/UUID` rather than appending an inline detail under the inventory. The work page retains contextual Actions navigation/breadcrumbs and displays observed state, trigger/ref, start/finish duration, worker, optional exit code and immutable source links. Exact execution receipts are disclosed on request. Detail must match the selected run and current native repository ID before requesting logs. Cancellation sends the observed version once, handles ambiguous responses explicitly and aborts local handling when navigation leaves the page.

Log continuation now follows the existing sequence API beyond its first16 chunks. Ordered pages preserve text across chunk boundaries; malformed/nonadvancing sequence pages are refused. Loaded text can be searched and explicitly downloaded, without HTML execution or an automatic private persistent cache. Worker truncation is separate from unloaded pages. Live action events refresh the selected run and loaded log pages. Current replay uses TanStack infinite-query refetching; high-volume tail transport and structured job/step events are not implemented. [Workspace contract and broader engine requirements](PIPELINE_EXECUTION_COMPATIBILITY.md#current-actions-run-workspace).

Validation: `make check` passes. The full257-test browser suite passes57.1s; after correcting the shared search/icon wrapper markup found in the served screenshot, all7 affected workspace tests pass10.4s and TypeScript passes. Cases include live tail updates, cross-repository refusal, malformed continuation, denial/private cache removal, literal hostile output, loaded download, lost cancellation responses and navigation during a pending cancellation. Final actual native run screenshots pass1280/390px dark/light, with no horizontal document overflow, aligned icon actions and the real automatic shell log visible. Local results live in `.tmp/github-visual-audit/run-after-manifest.json`.

The expanded `scripts/ci-compose-smoke.py --image golf-golf --runner-image golf-runner --objects` passes on the final image. Real worker output spans49 ordered chunks over4 API pages and reaches the final marker without duplicates/gaps/truncation. Actual Actions/GitLab success, exit7 failure, cancellation, policy revocation, durable restart, immutable RustFS S3 source bindings with NULL database archives and attempt-container/volume cleanup also pass. The disposable stack is removed. No imported public workflow, paid agent task or source-repository CI workflow ran. Retained local execution policies remain unchanged.

Docker/product and docs production checks pass. Current Golf image index is `sha256:0d4c01060755cdcca3276b63e4da58721e1b55e0c4a261e0506e5d69a466c4ed`; worker index is `sha256:0db1fa87a8bfa532df764a4a51ee896f4c0801ee242a2e70428a2f06d0908509`. Runner image is `sha256:c3a3f07b8f2fc166092aced4dd987411b7b7820f0a963dfcfad9586994ec8bca`, recreated in Golf's current namespace. Local readiness passes. Review the retained successful run at `/golf-admin/golf-local-ci-0c61aa/actions/runs/1664b5bf-a052-4578-8d2f-db07152a99ac`.

Remaining full requirements include job/step graph and safe events, line permalinks, workflow filters/sidebar, rerun/artifacts/cache, maintained-engine compatibility, ACP/native coding-agent progress, capacity/proxy/HA qualification and P0.8 protected merge/check enforcement. These are required pending implementation, not completed by this run/log increment.

## GitHub screenshot comparison and initial private live updates (2026-10-03)

Actual public GitHub references cover Code, file/README, issue list/conversation, PR list/conversation/Files changed, history, commit diff, Actions/run summary and branch/clone menus. Paired initial captures cover nine pages at1280×900. Golf retains its brand while adopting a compact owner/repository header, folders-first40px source rows, root About column, real HTTPS/SSH Code disclosure, shared TanStack loaded-only list search/sort, title/status above discussion cards, PR tabs above conversation and run-first Actions. Controls use shared components and global CSS. Unsupported row actions, checks or merge controls are not substituted with inert lookalikes. [Comparison and remaining tasks](GITHUB_VISUAL_AUDIT.md).

At the same desktop viewport, the first source row moves from467px to318px (GitHub307px); the first PR diff row moves from773px to588px; the Actions run-table header moves from682px to436px. Final served-image captures cover ten pages in both themes at1280×900 and390×844: all40 have no document horizontal overflow. Screenshots and measurement manifests remain in ignored `.tmp/github-visual-audit/`.

Initial private live updates now use a generated Connect server stream backed by schema030's transactional append-only repository journal. Fixed topic invalidations refresh authorized mutable reads; source and selected comparisons stay pinned. Reconnect/cursor replay, current authority checks, recipient-private agent events, bounded connections and visible fallback are implemented. Issue drafts survive background checks but disappear on denial. CI/agent state updates are observations, not complete streamed job/ACP logs. Ordinary external forge issue edits, full log paging, retention, proxy/multi-replica/load qualification and safe native/ACP progress remain open. [Exact contract](REPOSITORY_ACTIVITY_CONTRACT.md). This supersedes older statements that all live transport is still planned; EventSource/SSE was not the selected initial transport.

Validation: `make check` passes Go tests/vet, TypeScript and generated drift checks. The full browser suite passes250 tests. The isolated PostgreSQL activity/workflow/agent/issue/PR boundary race suite passes27.201s, including real HTTP first-frame delivery, authority loss, recipient/cursor binding, commit ordering/rollback and connection ceilings; the disposable database was removed. An owned local issue/comment posted from an independent authenticated session appeared in the already-open conversation without refresh. Docker build and redeployment pass; `/readyz` reports database/forge ready. Current Golf image index is `sha256:b3c3f239da687af4d6c3ca35f7ab35bc586b9589ad38a1375179b9a3db367868`; current agent-worker image index is `sha256:707388c29278792ace9a356f57d35c341efd5d9ca3ab1d886aa08588baba56e9`. The pipeline runner was recreated in Golf's current network namespace.

This increment does not complete GitHub parity, protected merge/check integrity, broad CI compatibility, disaster recovery for schema030 or Cloudflare deployment. No source-repository CI workflows were added.

## Compact repository presentation and asset delivery (2026-10-03)

New repository navigation uses owner/repo paths for source trees/files, issues, PR conversation/files, commits and Actions, preserving legacy query links. Shared breadcrumbs cover work and settings/admin pages. Global product density now uses 40px source rows, 16px panel padding, 20px section gaps, compact headers/comments, 14px UI text and 16px Markdown with 32/24/20px headings. PR/commit raw metadata is disclosed on demand. These are shared CSS/components; mobile controls retain 44px targets.

Shared Markdown now parses sanitized HTML/logo alignment, heading anchors/duplicate slugs, lists/tables and managed images. The new generated private image RPC binds references to an immutable ordinary source document and rechecks caller/repository access after waits. Relative ordinary assets stay within the same repository/commit; external HTTPS hosts are explicitly limited, public-address validated, credential-free and redirect-free. PNG/JPEG/GIF/SVG previews are bounded to256KiB; SVGs receive additional client sanitization before data-URL image rendering. Unsupported hosts/formats and context-free comment images remain visibly unavailable. Remote asset content remains mutable independently of source snapshots. See [visual references and limitations](REPOSITORY_PRESENTATION.md).

Native local Git imports and immutable README reads pass for Express, Awesome and Spoon-Knife in private admin-owned fixtures alongside Flask. No imported applications/workflows were executed, and temporary Git credentials are revoked. GitHub repository/file/issues/PR/conversation/files screenshots were captured in a separate public browser and compared for density, navigation and row/page controls. A served Flask screenshot caught Tailwind's image reset overriding the HTML logo height; the shared CSS fix is checked by an actual rendered150px height assertion.

Validation: `make check` and Docker/product/docs production builds pass. Isolated PostgreSQL image/PR-diff/commit-diff/caller boundaries pass under the race detector19.305s; disposable database removed. All245 browser tests are covered: the full run passed242, with three stale URL/layout/ambiguous-navigation test expectations corrected, then all31 tests in the affected audit/agent/organization files passed20.8s. The separate26 issue/repository tests passed36.8s, including sanitized SVG/HTML and heading/image-size assertions. Actual served-image visual qualification additionally passes all four READMEs at1280px charcoal and390px light: no horizontal overflow, Flask height150px, five Express managed images, three Awesome managed images and ordinary Spoon-Knife Markdown. Express's OpenSSF badge remains a visible unavailable placeholder; no success is substituted. Local results/screenshots are retained in `.tmp/readme-visual-results.json`. Running image index is `sha256:bef6011b8d442c7545f2a2ce82c7add3678a8c9c0832ec97cce0e5d1d533fcd5`; agent worker and pipeline runner were recreated in its namespace. These checks do not complete GitHub parity, protected merges, full CI compatibility or Cloudflare deployment.


## PR changed files and shared commit diff workspace (2026-10-03)

GX-3 now has a real initial file/hunk workspace. PR Conversation / Files changed routes and commits share file navigation/search, unified/split rows, exact old/new line anchors, rename/delete/binary metadata, collapse and in-memory snapshot-scoped Viewed markers. A new generated `GetPullRequestDiff` API binds the selected full base/head IDs and PR/head/base repository identity around the bounded native diff read, then rechecks session/repository authority through the shared read boundary. Changed snapshots fail explicitly without content; this remains an observation rather than a native atomic lock or trusted merge evidence. Source lines cannot impersonate patch headers; Git C-quoted UTF-8 paths and zero-length ranges are supported. Invalid hunk counts retain native text, and comparisons above500 files or12,000 preview rows use native fallback. Global CSS supplies the shared diff layout, themed additions/deletions and smaller repository/PR header spacing. The GitHub-like shell now labels source as Code, moves Settings into contextual tabs and omits prominent native-interface/empty-description filler. PR branch comparison stays visible; native IDs/ref and review diagnostics move into disclosures while outdated/dismissed badges remain visible. Commit pages lead with the human title/author and disclose technical IDs. [Contract](PULL_DIFF_CONTRACT.md).

Validation: `make check` passes Go tests/vet, TypeScript and generated contracts. All50 affected repository/PR/commit/issue/workflow/parser browser checks pass32.9s. The real isolated-PostgreSQL PR/commit read suite passes13.439s, and the additional PR suite with mid-read session revocation passes11.213s. Tests cover changed head/base, stale selection, private access removal, caller identity, malformed IDs, size/encoding bounds, safe text, split/filter/View reset and both themes at320px. Actual retained local PR #1 returns its selected native751-byte parameterized-fix diff; stale selection returns Connect `failed_precondition` (HTTP400). Actual served UI exposes file navigation and line rows from that real PR. More complete native private-fork/large-diff qualification remains open.

Remaining GX-3 work includes PR commits/checks tabs, whitespace comparison, changed-row syntax, persistent viewed state and native inline threads. Human reviews/lifecycle, safe SSE/ACP events and merge/squash/rebase enforcement remain full requirements. No merge capability or parity completion is claimed.

## Repository Markdown, highlighting and Actions work tab (2026-10-03)

The active full repository-experience goal is tracked in [the GitHub/forge capability matrix and tasks](REPOSITORY_EXPERIENCE_PARITY.md). The prior reviewer turn made concrete verified progress; it did not establish repository parity. This increment adds shared CommonMark/GFM rendering for Markdown source, issues, PRs, human comments and native review bodies, plus explicit source/rendered switching and draft Markdown preview. READMEs are discovered at the pinned commit in `.github`, root and `docs` priority, or the current directory for nested browsing. Relative document links resolve inside the same repository snapshot. Raw HTML is displayed as text; unsafe/protocol-relative URLs and credential-bearing external URLs are refused, and images become alt-text placeholders without loading remote or private assets. Source and fenced code use a lazy AST-to-React highlighter; unsupported languages or content above64KiB stay plain text. Existing256KiB source bounds remain. Global CSS supplies readable typography, charcoal/light syntax tokens and scrolling tables/code.

A canonical `view=actions` work tab directly exposes the existing workflow inventory/manual Run, paged run/detail/log/cancellation surface and managed coding tasks. Scope policies, grants, accounts and reviewer configuration remain in settings. This is a shared automation workspace with distinct CI and coding-task runtimes, not a claim that coding CLIs execute inside edge Workers. Current live updates still need refresh/polling; authenticated SSE and safe ACP/native agent event streams remain required under GX-5.

Validation:39 repository/issue/PR/workflow browser fixtures pass36.7s, including new GFM tables/tasks, highlighted code, unsafe URL/HTML/image denial, exact snapshot-relative links, Actions deep-link/reload and charcoal/light390px checks. Production build/type checks pass. Legacy fixtures were expanded to describe the existing reviewer/PR-discussion endpoints rather than treating those valid calls as unsupported; rendered-content labels now identify Markdown accurately. Real disposable `ci-compose-smoke.py` on Golf image `sha256:70035fa1c38521453ed3bc0f6195d6e9208c5987e7f3d78926bec6899d2c68ae` and runner `sha256:c3a3f07b8f2fc166092aced4dd987411b7b7820f0a963dfcfad9586994ec8bca` passes exact-commit durable queue/restart, Actions/GitLab shell success/failure, denial, running cancellation, policy revocation and attempt/container/volume cleanup. The disposable project is removed. Actual retained Golf UI serves Actions and renders the real demo PR/bot reviews as Markdown, with the runner recreated in the current namespace.

This is progress toward the full goal. PR commit/check tabs, further diff features, human review and lifecycle mutations, file-level diff UX, live SSE/ACP logs, merge/squash/rebase enforcement, remote/private images, heading anchors/outline, non-Markdown README formats and wider forge features remain open. P0.8 continues to gate protected integration; a native status or UI merge button cannot replace its missing target-side fence. No source-repository CI workflows, paid model calls or remote pushes were added for this increment.

## Managed OpenCode Go PR review persona (2026-10-03)

Repository settings → Workflows now includes an explicit Add/Edit PR reviewer and shared, searchable/sortable/paged review history. The PR page displays that history, bounded plain-text review details and native bot reviews, and supports PR comments through the existing durable comment journal. The initial persona uses a current connected OpenCode Go account, exact native catalog model/variant, explicit scope policies and expiring local-account sponsorship. The portable Docker executor disables every tool, repository configuration, plugins/MCP and auto-updates; a separate trusted publisher posts exact-head COMMENT reviews/inline findings and advisory checks. See [contract and limits](PR_REVIEWERS.md). Schema027–029 adds reviewers, immutable PR-comment context and cross-head intent receipts; canonical recovery remains refused above qualified021.

Actual local evidence uses the official Flask source pinned at `d73fa1cdcbd8b1465c151db8924ba58b1dd14e35`, imported with full history into the private `golf-admin/golf-review-demo`. No upstream application or imported CI was executed. Retained OpenCode Go uses `opencode-go/deepseek-v4-pro`, variant `high`, and a separate nonadministrator `golf-review-bot` with read collaborator access. PR #1 remains open for inspection. Its intentional SQL injection at head `40f8727522839cebe3c344b3019928f11b6760db` produced a real high-severity finding, native inline review119 and advisory failure. The parameterized fix, with a subsequent explanatory comment, reached head `d4a487ab35b1fa23d8d0897cb635b0a0c9e8087d`; automatic push review120 was clean and its advisory status successful. Golf-journal comment189 mentioning the bot produced clean follow-up review121. A fresh intentional-defect PR #2 independently triggered automatic PR-open review122 and was then closed without merge. Repeated polling did not duplicate native reviews. Disabling the reviewer refused a new intent without admitting a task; the demo reviewer was restored enabled with seven-day sponsorship. Existing Codex and Go connections remain connected; Claude retains its prior reauthorization state.

Initial attempts exposed a launcher/cache storage problem and non-JSON final-step summaries. They failed without publication or automatic replay. The final runtime packages the pinned native binary directly, uses bounded512MiB private auth/cache storage, feeds the diff over stdin and sets two native steps to avoid injecting the final-step summary instruction into its first response. Tools stay disabled and are checked against actual resolved CLI configuration before readiness. Native transport retries remain possible inside an attempt; model output still must pass strict bounded JSON/path/line validation. Prior attempts and historical review snapshots remain retained. One earlier human PR-comment POST applied before a native URL-association validator rejected its receipt; its unknown journal is preserved, no repost occurred, and the corrected association is proven by comment189.

Validation: full Go tests/vet and generated-contract checks pass; runner race tests pass1.208s; isolated real-PostgreSQL reviewer/PR-discussion/issue/task/migration/startup race checks pass (server30.947s, database40.796s). All13 affected browser fixtures pass35.0s; product and docs production builds pass. Actual served PR UI shows the real native reviews, historical SQL finding and published clean-review detail modal. The final dispatch-readiness change prevents workers selecting a review task before its review receipt is linked and cancels queued work on failed intake. A new explicit clean review also succeeds after that deployment. Isolated PostgreSQL cross-head intent/duplicate constraints and task checks pass4.188s. Running Golf image index is `sha256:5be7efaf24fc5876c02634497d6ec42786d841a65520b298ff7bc02dbe7c2b2c`; reviewer image is `sha256:e64d5f8a363254a3eb48b8ef10b6377a7ab65487ecf4b95894abc64f82a6b2cb`. The pipeline runner was recreated in Golf's current namespace.

This verifies the initial local advisory security-review use case, not complete CodeRabbit/GitHub parity, general OpenCode editing tasks, protected merge, exhaustive vulnerability detection or Kubernetes/Cloudflare execution. Polling bounds, same-repository/non-draft requirements, source limits and sponsor/PR-author-only mentions are explicit. Publication after live mid-inference revocation/head changes remains additional qualification work beyond existing task authority checks. No repository CI workflows or remote pushes are added.

### Fresh end-to-end reviewer rerun (2026-10-03)

A fresh local PR #3 in `golf-admin/golf-review-demo` verifies the configured persona again on the running deployment. Actual OpenCode Go / `opencode-go/deepseek-v4-pro` inference found the intentional SQL injection and published inline bot review124 with advisory failure. Pushing the existing parameterized fix produced automatic clean review125 with advisory success. A new authorized Golf PR comment mentioning `@golf-review-bot` produced clean follow-up review126. Eight seconds of subsequent polling added no native review. Native read-back confirms the fixture is closed without merge and the original demo PR #1 remains open. Temporary test publishing credentials are revoked. The cleanup helper initially expected HTTP200 rather than the native close endpoint's HTTP201; read-back confirmed the close applied, so no close mutation was replayed. This rerun verifies the advisory local persona lifecycle, not complete PR-review parity or exhaustive vulnerability detection.

## Managed manual Codex ChatGPT tasks (2026-10-03)

The portable Docker track now runs user-initiated Codex ChatGPT tasks from **Repository settings → Workflows → Coding tasks**. The shared table, explicit New editor and confirmed cancellation bind current native authority, scoped policy revisions, connection/catalog version and immutable source. A separate trusted worker holds exclusive account/worker ownership, uses private disposable task containers, checks ongoing authority/leases, returns encrypted native refresh state only to the current account, and retains a final summary/proposed patch. No source-repository publication or automatic replay occurs. Status distinguishes the exact-image worker heartbeat from account/policy eligibility. `make local-agents-up` installs the optional profile; subsequent local lifecycle commands preserve it. [Contract](AGENT_TASKS.md).

Qualification: `make check helm-check` passes; 41 affected browser fixtures pass (26 task/usage/workflow/policy/grant,15 account/harness/status). Real-PostgreSQL agent/account/migration/startup race checks pass (server36.480s/database45.542s), and the final admission/idempotency/cancellation PostgreSQL subset passes3.068s. Runner race tests pass1.219s. Native pinned0.160.0 sandbox qualification passes credential/root read/write and command-network denials with permitted workspace writes; worker startup repeats it before advertising readiness. Actual browser-to-Golf-to-native Codex inference completes on a disposable private README: proposed diff/summary retained, token use recorded, account UUID preserved and no native source publication. A separate actual attempt verifies reported-token interruption at21,970 against a20,000 threshold, demonstrating reporting overshoot rather than a hard prepaid billing cap. Test policies/source/tokens are removed/restored after each proof. Retained personal account and local login remain connected. Final local Golf image is `sha256:419614d570dafb7de5268da24ed900e2bf5483eca7d22b013ba362a4be00707b`, managed worker `sha256:1a943a8d471ec29b858fe9cbcc4d8852270c1b35c4f6eb4d3b3be6c7369da267`, native task image `sha256:23cca3c39ac66c2678633cfeb3639bae3aaf2ae03e3fd01f475ccd9865fe0200`. Actual served task UI uses the common themes/table, and390px document width stays390px. The runner was recreated in the final Golf namespace.

Schema026 adds durable private task receipts/source/config and worker presence. This initial path supports only manual Codex ChatGPT execution,16MiB ordinary-file snapshots,15-minute maximum runtime and64KiB final summary/patch. API-billed tasks, automatic push/comments, other harness executors, fair scheduling/per-scope aggregate billing, mid-turn credential crash checkpoints, resume/publication, Kubernetes/Cloudflare execution and canonical schema026 recovery remain open. Recovery still refuses above qualified schema021. No repository CI workflows are added.


## Scoped agent usage, native model catalogs and OpenCode Go

Personal, instance, organization and repository settings now expose an explicit Edit workflow for account/model/variant selection, instructions, triggers, model allowlists, runtime/token/API-spend/concurrency ceilings and permitted task overrides. Higher-scope ceilings remain restrictive, instructions are retained, absent policies deny use, and known zero spend stays zero. Shared defaults require named instance connections with explicit use grants; personal accounts remain private. Browser-only task preview resolves permitted overrides without queuing work or changing configuration. [Contract](AGENT_USAGE.md).

OpenCode Go is a distinct `opencode-go` provider alongside Zen. The pinned native `opencode auth login --provider opencode` command asks for an API key; it is not a Zen browser OAuth flow. Codex catalogs come from native `model/list`, OpenCode catalogs/variants from native `models`, and Claude choices are documented aliases with explicitly unverified runtime effort support. Catalog availability does not establish entitlement. Model metadata is sanitized and bound to the current account version; saved configuration requires current account authority, catalog selection and revision. Schema025 adds scoped settings, metadata-only change events and sanitized catalogs without changing existing credential bindings.

Qualification: `make check helm-check` passes, including generated-contract drift and 25 negative Helm checks. All 44 focused browser checks pass; the final usage/settings/profile rerun passes all 15 checks (7.2s). Native adapter race checks pass (2.520s); real-PostgreSQL agent/account/migration/startup race checks pass (server 36.658s, database 35.623s). The packaged OpenCode Go catalog/variant parser passes an isolated invalid-key/no-network check. Actual localhost configuration, encrypted Go cache and native catalog persist across backend replacement; original usage settings were restored and owned qualification credentials disconnected afterward. The existing real Codex account and administrator session remain intact. Final local image is `sha256:45576680f6b8cf6afbe4dc95f8d05aa78943c331bb42c7852c82cf80415751b0`, schema025; the Compose runner was recreated for the current Golf namespace. Actual Codex model/effort selection was checked without saving a draft or running inference; mobile width is contained at 390px.

This is configuration and preview, not managed execution. Automatic agent triggers, PR-comment dispatch, isolated task workers, atomic execution admission, aggregate billing/concurrency accounting, paid inference, OpenCode provider OAuth and distributed renewal remain open. Schema025 canonical recovery remains unqualified and refused by the existing recovery allowlist. No repository CI is added.

## Claude Code and OpenCode managed account setup

Personal settings now expose Claude Code native browser/code login or an Anthropic API key, and OpenCode API keys for Zen, Anthropic and OpenAI as distinct provider connections. Instance administrators select harness/provider when creating named accounts and retain explicit, default-deny Golf user grants. Existing compact Lucide rows/details/editing/disconnect UI and encrypted connection-scoped credential lifecycle are reused. Native binaries are pinned to Claude Code 2.1.288 and OpenCode 1.18.34 inside the Golf Compose service; no host agent login, Keychain or Docker socket is imported. Schema024 preserves Codex UUIDs/cache bindings and makes harness/provider identity immutable. Legacy RPC/audit identifiers remain internal compatibility names; user-facing activity now says coding agent. [Contract](AGENT_CONNECTIONS.md).

Account authentication/configuration is separate from model access and managed task execution. Claude Console/cloud/gateway modes, OpenCode provider OAuth, quota interfaces, successful paid inference, distributed renewal/failover and managed container/Pod/Cloudflare task execution remain open. Optional Claude/OpenCode task Dockerfiles are image definitions, not an implemented executor. Recovery remains refusal-gated for schema024.

Qualification: `make check helm-check` passes. All 27 focused account, capability and activity browser tests pass (21.3s). Native adapter race tests pass (2.548s); real-PostgreSQL Codex/additional-harness/migration/startup race checks pass (server 32.355s, database 25.798s). Packaged arm64 native invalid-key cache/snapshot/restore/logout and actual Claude authorization issue/cancel pass. On local image `sha256:0613e8c875f1cc5d1b17c46f11abcad9517a63821ef82bb397a6ca7ec67c3003`, schema024, actual authenticated native Claude issue/cancel and four distinct Claude/OpenCode API-key cache restorations across backend replacement pass. Deliberately invalid qualification keys were removed afterward; the real Codex account and administrator session stayed intact. Both manual/automatic pipeline capabilities are ready and the runner points to the current Golf network namespace. Optional task images launch pinned CLI versions as nonroot with a read-only root filesystem, private tmpfs HOME, no network and dropped capabilities. This is launch/account-cache evidence, not approved Claude OAuth, valid model access, managed tasks or complete disaster recovery.


## Codex provider usage, compact connection details and common page spacing

Connection rows now use accessible Lucide icon actions. Read-only details and quota snapshots open in a bounded modal with Escape and launcher focus return; personal connection renaming uses an explicit TanStack Form editor and preserves encrypted login state. Instance name/access editing remains separate, and disconnect uses confirmation. Shared users receive metadata-only details. Owner-only personal renaming reuses the versioned connection configuration transaction and refuses shared grants.

Connected account details now expose **Refresh plan and usage**. The pinned native account broker reads documented `account/rateLimits/read`, preserving separate buckets/windows, nullable durations/reset times and earned-reset count presence. Golf shows plan, percentage remaining/used, actual window length, absolute reset time/countdown, checked-at freshness and banked resets without redeeming them. Unknown data is distinct from known zero. Unsupported quota reads do not imply authentication failure, API-key connections do not promise ChatGPT quota data, and no inference is run. Usage is manager-only private page state; existing Origin/session/role/CAS and post-provider encrypted-cache persistence remain in force. No schema change.

Validation: full browser suite232 passed before the final connection presentation refinement; all12 final Codex browser checks pass, covering device/API setup, secret exclusion, quota snapshots, focus restoration, explicit rename, instance management and shared-user restrictions. `make check helm-check` passes. Native usage race tests pass; all Codex personal/shared/usage/rename real-PostgreSQL race tests pass19.413s. The served local UI returns real provider quota and banked-reset metadata while preserving the connected account across backend replacements. Dark/light and mobile detail views were inspected, and the runner was recreated into the current Golf network namespace. No agent inference or reset redemption ran.

Global `styles.css` now owns `page-stack` vertical rhythm and `panel-content` padding using section/panel tokens. Account, admin, infrastructure, repository settings/workflows, organization and status roots use the shared rule; immediate children no longer add a second section margin. Direct panel headings/actions/notices receive common padding. Quota visuals use native meters and global CSS. Existing shared TanStack tables/forms remain in place.

## Named instance Codex accounts and infrastructure inventories

**Admin portal → Coding agents** (`/admin/agents`) adds named instance Codex connections and version-fenced user access. Connections initially allow no users; management and use are separate, including for administrators. Personal connections remain private. Authorized users see safe shared metadata without challenges, credentials or access lists. Only currently enrolled local-password Golf administrators manage instance authentication/access; disabled and revoked identities are denied. Native process/refresh ownership is connection-scoped, preserving encrypted cache binding and key lifecycle coverage across multiple accounts. Schema023 retains existing personal state. This implements account administration, not managed task execution or provider entitlements. [Account contract](CODEX_ACCOUNTS.md).

Infrastructure settings now separate database and object-storage inventories, each with a named Add workflow. Active CI source storage shows the exact immutable profile/version separately from saved alternatives, including when a newer edit exists or the active profile is outside the loaded page. Storage activation retains controlled write/read verification, password confirmation, revision checks and existing-run bindings. Database profiles support saving/testing and explicit operator-led cutover guidance; they do not switch live pools online.

Operational correction: replacing Golf alone can strand the Compose runner in the previous container's network namespace (`network_mode: service:golf`). A running runner container did not imply a fresh heartbeat. Recreate the runner after Golf replacement; verify the namespace points to the current Golf container and both manual/automatic capability heartbeats are ready. The earlier observed degraded state was corrected this way without changing credentials or execution policies.

Qualification: `make check helm-check` and generated contracts pass. The full real-PostgreSQL `go test -race ./...` passes on the final frozen tree (server 324.106s). Final Codex plus three historical migration PostgreSQL race regressions pass (29.211s); active historical infrastructure inventory passes a real PostgreSQL race test (3.129s). Browser fixtures pass for nine Codex connection/access flows, ten infrastructure flows, two status role flows, and twelve activity flows; the new audit resource-ID extension passes separately. Native arm64 Codex0.160.0 shared API-cache restoration across Golf replacement, real device issue/cancel, selected-admin metadata projection and final encrypted-auth cleanup pass without inference or host credentials. Final local image is `sha256:1dd7363939e361deff69d5a2802841042ee8171f7fbdefdddba59563a70ddceb`, server binary `eb8a8a6190f97ad1b3d13849d4c454937cf05d57474b1df3b91b1f9b3b90d564`, schema023. Actual admin/user/infrastructure pages, retained administrator browser session across replacement, dark/light rendering, current runner namespace and ready manual/automatic capabilities pass. The named “Local team Codex” connection is left unconfigured and assigned only to the current local administrator for review; no test credential remains.

Schema023 full disaster recovery remains unqualified; the recovery allowlist stays at schema021. Account cache restoration does not qualify canonical restore or successful inference. No repository CI is added.

## Personal Codex authentication inside Golf

**Account settings → Coding agents** (`/account/agents`) implements personal native ChatGPT device/API-key setup, provider-reported account details, pending approval/cancel, provider refresh, reconnect-required states and confirmed disconnect. The API is browser-session-only and version fenced; credential snapshots are encrypted in PostgreSQL with owner binding, restart restoration and full key lifecycle accounting. Connection events appear in existing personal account activity. The packaged trusted account broker is pinned to native Codex 0.160.0 and exposes no task/model RPCs; no host login is imported. [Managed account contract](CODEX_ACCOUNTS.md).

Qualification passes: `make check helm-check`; full real-PostgreSQL `go test -race ./...` (server 248.456s), final 7 Codex PostgreSQL race tests 10.759s and Codex/key lifecycle 36.562s; 19 Codex/activity browser fixtures 29.4s, followed by 7 Codex fixtures 14.8s after status-copy fixes. Coverage includes encrypted cache restoration, private owner isolation, Origin/PAT/delegated denials, exact cancel/new-session authority, revoked/disabled initiators during provider waits, broker database-owner loss, refresh-failure snapshot writes, key rotation/retirement and audit rollback. Pinned arm64 native protocol checks pass fresh/private API cache, owned 0600 snapshot/restore, logout and real device issue/cancel without inference.

Retained localhost qualification passes on image `sha256:90b364dbee91705f93f3564f29a83ce8504fa2cbf6b06ed19677ff9e25184566`, server binary `5ca40de994365e4b1cb945acba3ab2cdfceab3c2437ea5fc511b0caa995cae82`, schema022: actual browser → Golf → native device issue/cancel/confirmed disconnect, personal activity, deliberately invalid native API cache persisted encrypted across backend replacement, restored native account read, and credential cleanup. The existing administrator browser session survives replacement; retained environment and login credentials remain byte-identical. Core, RustFS and Docker worker remain running. The fake API key was removed and the personal connection is ready for the user’s own login.

Native cached API-key configuration does not prove validity/model access. Provider-approved human ChatGPT login and successful inference await the user’s own connection. Golf’s 15-minute completion deadline is not provider token expiry. Managed task execution, additional harnesses, amd64/Kubernetes/Cloudflare, HA partition fencing and schema022 canonical recovery remain unqualified/unimplemented; recovery continues to refuse unsupported schemas. This is a managed personal authentication increment, not completion of N5.

## Codex CLI local operator runtime foundation

The [Codex local contract](CODEX_LOCAL_RUNTIME.md) implements an opt-in separate Docker runtime pinned to Codex CLI0.160.0. It supports native device/API login, private owner-scoped auth volumes, full-lifecycle credential locking, explicit orphan refusal/disconnect, bounded canonical source, a fresh workspace, native structured terminal evidence and private proposal/checkpoint output. Source and credential files never mount from the host; no forge/admin, Docker socket or deployment credential is given to the task. It does not change the existing network-disabled CI runner or schema021 core.

Offline source/credential/locking/ownership/terminal and ANSI device-code parsing checks pass. On exact local arm64 image `sha256:9bdc4c4929ee08cb5e211450eda5d46c156ac5c982a90d740d70dd2cd9db55b5`, native Codex workspace sandbox checks pass with the scoped Moby-derived seccomp profile: UID1000 workspace writes, auth/root write denials and sandbox TCP denial. Actual native CLI invalid-key qualification passes cached-login persistence across separate helper processes, failed/cancelled model execution, private artifacts and verified attempt/auth-volume cleanup. A deliberately invalid key cannot qualify successful inference. Two native lifecycle issues were fixed and checked: full Docker container IDs for cleanup and preserved canonical source ownership during copy. Device prompt ANSI parsing is covered separately.

The earlier pending terminal device login was cancelled when account setup moved into Golf. Human provider approval and successful model execution remain separate acceptance steps. No host Codex login was read or reused. Native credential storage is outside Golf's encrypted managed connection/recovery contracts. amd64/Kubernetes/Cloudflare execution, distributed renewal/revocation, managed browser/API task admission, automatic agent triggers, resume and proposal publication remain unqualified/unimplemented. Golf's coding-agent capability remains unavailable. `make check helm-check` passes; no repository CI is added.

## Qualified schema021 recovery and retained automatic CI

The expanded [recovery drill](RECOVERY.md) passes on exact image `sha256:27f9e813321169f851c6f281f9855611c5bc6fc7bb9c4830c40fb3e5117d9583`, with backend binary SHA256 `a3f234c3aa0e92436d01fc7b51c9fcd613f8f2e7e59f1ba8c4e3dd4ac5e11eef`. It backs up the stopped canonical core plus optional local RustFS, restores to fresh volumes, verifies exact stored-object bytes and preserves real native automatic-run provenance. Four queued/leased manual and push runs are cancelled, interrupted preparation is quarantined and grants are revoked. Old sessions/API/attempt capabilities are rejected; fresh sign-in, supported native Git/LFS/attachment/protection/SSH operations, restart and key rotation pass. This fixture leases runs through HTTP but does not execute a Docker job. Offline archive/configuration/Compose-boundary checks also pass; disposable resources are removed.

The retained local deployment now runs schema `202610020021` on image `sha256:f658a021b4cc908beb171430bb18a3b31e1b9196e044d9a909b7dc8b260f67c9`, with the same qualified backend binary. Before the stopped-writer upgrade, an encrypted verified schema019 rollback snapshot and private configuration copies were retained under ignored `.tmp/local-upgrade-20261003T010641Z/`. This same-host copy is not offsite disaster recovery. Existing password, database/storage/key configuration and worker enrollment are preserved.

An actual Git push to private `golf-admin/golf-local-ci-0c61aa` completed automatic Docker run `1664b5bf-a052-4578-8d2f-db07152a99ac`. Source is stored through RustFS (`env_s3`, no database archive), exact push provenance is retained, and logs contain the expected successful shell output. The administrator session survives backend restart, the completed run/source/logs persist and managed executor containers/volumes are clean. Pipelines, native intake and automatic pipelines report Ready. Only the new demo has an explicit 24-hour branch/workflow grant; other repositories remain governed by default-deny policy and independent grants. See [local test and explicit setup helper](PUSH_AUTOMATION_CONTRACT.md#retained-local-test).

These results supersede earlier retained-schema019/recovery-pending statements below. Schema020 alone, remote object stores, executing/orphan Docker recovery, Kubernetes/HA recovery, complete provider pipeline syntax, coding-agent execution and Cloudflare execution adapters remain separate gates. No repository CI workflow is added.

## Automatic push shell CI — source schema021

The [automatic push contract](PUSH_AUTOMATION_CONTRACT.md) is implemented: signed-payload canonical deduplication, receipt-time admission opt-in, leased PostgreSQL preparation, native sponsor push activity with a conservative clock margin, exact after-commit/workflow blob/ordinary-source preparation, approved image/storage bindings and atomic grant/policy-fenced run admission. Manual dispatch remains separate. The shared run inventory now shows typed manual/push origin and authorized event/grant provenance; grant receipts remain explicitly conditional. Status requires both a recent successful coordinator tick and an active worker.

Queue bounds: 512 pending/preparing items, 20 seeded per batch, one preparation per coordinator, 90-second leases, 60-second preparation deadline and three read-only preparation attempts. Native activity deduplication and 64 queued/running runs per repository prevent unbounded automatic admission; terminal denials do not silently retry after policy changes. Executed attempts never replay automatically. Native freshness is sponsor-only/newest 100 activities; synchronized stable clocks and a seven-second post-grant wait are required in this first slice.

Qualification: `make check helm-check` passes, including generated API/database drift checks and 25 negative Helm cases. Authenticated isolated PostgreSQL 18.4 full race passes (server 199.509s; database 21.281s); targeted lease/history/recovery and clock-margin race checks pass. All 17 final workflow/grant/capability browser checks pass (19.4s), including push/manual table origin and conditional create receipts. The final disposable native proof passes on exact image `sha256:7fb7ed76de50f29d4e9481c0bab1b15f0f4a9bcc8cef9e80d129116bfe754d58`, binary `a3f234c3aa0e92436d01fc7b51c9fcd613f8f2e7e59f1ba8c4e3dd4ac5e11eef` and runner image `sha256:cb2e671a60695d5a6595796b4c6a4435fe8965a6bff8ec8b613fceecfe1fae79`. Four actual signed native pushes prove disabled-history non-revival, push-only admission, conditional grant/wire provenance, exact commit/blob/private RustFS source, native activity evidence, logout independence, queued/completed restarts, same/new-delivery-ID deduplication, successful Docker execution, running revoke/cancellation and subsequent push denial. Managed executor resources, disposable project and private files are removed; no secrets/private markers appear in Golf logs. Proto SHA-256 is `c28bdb60c8112adb171020796f3871231859e1aea1435b6937b2d416f83c82ac`.

The disposable proof is `scripts/push-ci-smoke.py`; it uses actual supported native Git/HMAC transport, RustFS and the dedicated Docker worker rather than an inserted automatic fixture row. The subsequent schema021 recovery and retained deployment qualification is recorded above. No full GitHub/GitLab engine parity, Cloudflare execution or coding-agent adapter is claimed.


Updated: 2026-10-02. This ledger records evidence for the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md). A plan, compiled source and live provider qualification are different evidence levels. Git history identifies the implementation revision containing this ledger.

## Automatic run authority foundation (dispatcher remains disabled)

Schema020 adds mutually exclusive manual/session and push/grant/event origins, immutable authority bindings, separate manual intent lookup/uniqueness and event/grant/path deduplication without a grant-version replay namespace. Insert guards reject mismatched sponsor/resource/credential/ref/commit/workflow identities, deleted commits and receipts preceding grant creation. Shared poll/source/heartbeat/log/result checks resolve the independently encrypted grant credential and current native identity/access outside SQL locks, then fence sponsor/grant/credential and exact push-policy epochs with database-clock expiry. Browser logout is independent; revoke/expiry/sponsor disable, native identity/owner/archived/mirror denial and policy changes cancel or deny work and stale results. Temporary storage/provider failures report unavailable; they cannot become a false revocation or green result. Job assignments contain no delegated credential.

Qualification: `make check helm-check` passes after generated-model refresh. Authenticated isolated PostgreSQL 18.4 full server race passes (190.069s) and database race passes (41.137s); final additional origin/worker scenarios pass in the targeted race run (8.693s). Tests cover immutable/mixed/invalid origin rejection before uniqueness, pre-grant receipt denial, same-event deduplication, separate manual intent replay, push-only versus manual-only permission, logout/restart, queue/running revoke/expiry/disable, native principal/owner/archive/mirror changes, source/result fencing, and temporary policy-storage failure without destroying the lease capability. The native grant compatibility drill passes on exact built image `sha256:1d35f7459e413a34888f7db4db257d78919f8d283e6ae996ce696532acb35a3c`, proving existing real personal-PAT grant/auth/replay/restart/revocation behavior on schema020, unchanged source and no automatic runs. The run-origin tests use real Golf PostgreSQL and a substituted native API; this is not a native push-to-Docker execution proof.

The retained installation is unchanged on its schema019/1ff8978 image. Source schema020 is a stopped-writer upgrade and is incompatible with mixed old/new manual conflict targets. Its automatic-origin backup/fresh restore is not qualified; recovery scripts deliberately retain the earlier allowlist. Event materialization, replay/freshness handling, admission bounds, native push-to-executor qualification and schema020 recovery remain required before unattended release. Grants and the automatic capability still report execution unavailable. No agent/provider adapter is added. Plan section 2.3.1 explicitly distinguishes portable PostgreSQL coordination plus executors from planned Cloudflare Workflows/Queues coordination and qualified Sandbox/Containers execution, with one orchestration owner per run and no ambiguous execution retries.

## Portable local HTTPS increment

The opt-in `compose.https.yaml` / `make local-https-up` profile adds digest-pinned Caddy 2.11.6 with persistent certificate volumes, bounded resources and no host trust installation. It removes the published Golf HTTP port, enables existing secure host-only cookies, rejects unknown hosts, redirects to the fixed origin and denies internal CI/health/metrics paths at the edge. The retained normal HTTP development installation is unchanged. [HTTPS operation and qualification](HTTPS.md) documents local trust, profile switching and public-domain configuration.

Native disposable qualification passes on exact Golf image `sha256:1ff8978ebcb6bba7ef8be14cdfa92451cc90862bcd861c5216677f09d5b2cb2b`: explicitly verified local CA, actual enrolled email/password session, Secure/HttpOnly/SameSite/persistent/host-only cookie, no cookie transmission to HTTP, Origin/fetch denials, RPC no-store, private route denials, unknown-host rejection, redirects, backend port removal, session/CA persistence across backend and edge restart, and logout rejection of the original cookie. Fixture containers/network/volumes are removed; no retained keys/accounts or system trust are changed. Public ACME issuance/renewal, full native Git ingress/write-policy enforcement, Kubernetes/Cloudflare origin security, load/HA and edge-volume recovery remain unqualified. The public certificate configuration is a deployment option, not a completed live production proof. Valkey remains optional and has no implemented consumer.

## Current recovery and local bootstrap increment

`make dev` / `make local-up` now initializes/preserves all three private environment files, starts Golf/PostgreSQL/the native forge plus RustFS, verifies/initializes CI source storage, builds the local worker independently, and starts its trusted Docker daemon/worker against the current Golf network namespace. `make local-status` reports the complete selected profile; `make local-stop` preserves volumes. The smaller `make up` core remains available. This is the implemented development profile, with default-deny execution policies and no Valkey dependency; agent/email/CD consumers and production HTTPS packaging remain unfinished.

The recovery tool now admits the current schema019 in addition to its historical schema008/009 profiles. It checks the actual restored migration version against the manifest before invalidation. The expanded native drill uses actual signed Git/native webhook receipts, enabled and already-revoked grants, a token-only sponsor without a local account, a saved/tested encrypted PostgreSQL profile and queued/leased manual runs. Canonical encrypted backup/fresh restore preserves event/policy/profile/credential history, revokes all enabled grants, retains prior revocation, cancels queued/leased runs and denies old cookies/delegated API/attempt capabilities. Fresh local reconciliation does not revive grants; the saved profile decrypts/tests and all three retained automation credentials plus one profile rotate successfully, with inactive-key retirement eligibility and no queued-run replay. Schema-label mismatch, live-writer/no-overwrite, ciphertext/checksum and existing private Git/LFS/attachment/protection/SSH/restart checks pass; all disposable resources are removed. The fixture still explicitly skips the below-minimum 1 MiB cap-negative case.

Qualification: final native recovery drill exits0 on exact Docker image ID `sha256:1ff8978ebcb6bba7ef8be14cdfa92451cc90862bcd861c5216677f09d5b2cb2b`, which is also deployed locally. Server binary hash is `eedf1447a5576c17ea72f67cf157e983dd5520a02ead59cf5a359aee6bbc87a1`. Offline recovery boundary checks, targeted capability/recovery tests, `make check helm-check` and the Docker build pass. Repeated local bootstrap passes on the retained development installation: source bucket verification, ready manual-worker heartbeat, byte-identical private credentials/configuration and the same administrator session across backend replacement; verification logout leaves retained credentials unchanged. Automatic pipelines stay disabled. Status now accurately distinguishes implemented grants/push policies from the missing materializer and grant-bound runner admission.

This closes schema019 canonical three-service recovery evidence before automatic-CI admission; it does not qualify RustFS/worker overlays, external resources, an executing/orphan Docker process, future automatic-run schema, Kubernetes or production HA. Plan sections 2.3.3–2.3.4 add deployment presets with per-function provider choices, Cloudflare account/resource validation, immutable deploy/cost previews, current Containers durability/scaling constraints, production HTTPS ingress and measured optional Valkey consumers. Those provider/edge/cost UI paths remain implementation tasks; no inactive container or saved token is advertised as a working integration.

## Push policy, compilation and durable grant prerequisites

The next automatic-CI increment now implements independent default-deny `push_allowed` at instance/organization/repository scopes, with policy revision/epoch CAS and actor audit. Manual permission never implies push permission. [Execution policy](EXECUTION_POLICY_CONTRACT.md) records the event-aware admission contract and schema018. Existing manual runner paths remain manual.

The inspection catalog is `golf.workflow.inspect.v2`; the shell execution plan stays v1. Actions inspection/compilation accepts only the documented branch-push/exact-branch-list subset, optionally alongside input-free workflow_dispatch; tags, globs, paths and unsupported event/filter syntax stay denied. The manual compiler requires workflow_dispatch, and the UI hides manual Run for push-only files. The bounded GitLab one-job script has an explicit Golf branch-push mapping; this is not a native pipeline engine. See [workflow contract](WORKFLOW_CONFIGURATION_CONTRACT.md).

[Automation grants](AUTOMATION_GRANTS_CONTRACT.md) implements cookie/Origin-protected current-native-admin create/list/revoke, an independently supplied personal PAT resolving to the sponsor, exact branch/workflow scope, expiry, idempotent create and revision/epoch revocation. The explicit New editor and confirmation-only Revoke use shared forms/tables; archived repositories retain revocation. Delegation outlives browser logout. Local sponsor disable permanently revokes grants; stopped-writer recovery revokes all restored grants including PAT/OAuth-only sponsors. Schema019 adds the distinct fifth keyring domain with retained revoked/expired-key counting, bounded rotation, audit and retirement refusal.

Qualification: compiler/inspection targeted race passes (1.482s). Isolated PostgreSQL16 policy/key lifecycle race passes (9.469s) including total cross-family batch bounds, busy-row resume, immutable bindings, audit rollback, legacy validation and missing-key/retirement denial. Isolated PostgreSQL 18.4 grant/event/run/runner race passes (7.528s) including concurrent create/replay, admin/foreign token denial, encryption, logout/restart, audit rollback, revocation, recovery quarantine and sponsor disable/re-enable. Grant HTTP boundary registration/Origin/auth regression passes. The full isolated PostgreSQL 18.4 server race suite passes (150.516s); the subsequent native metadata reference correction is covered by final grant race (2.025s). All23 final workflow/grant/policy browser checks pass (26.8s), including actual route UI, secret clearing, ambiguous receipt handling, archived revocation, every push-policy scope and push-only manual-action exclusion. `make check helm-check` passes; the final metadata correction has its focused regression. Native grant proof passes on image `sha256:920308a328afaffbb4ef9ffb992691449a8fe19b509840dccd2d513ef4858557`: actual owner/reader/outsider and immutable-SHA reads, create/list/exact replay/conflict, encrypted projection, logout/restart, revoke/current-revoked replay/audit and all permission/Origin/bearer/bounds denials. Source is unchanged and no automatic run is created. Disposable resources are removed. Native proof exposed and corrected omitted protected HTTP procedures and unsupported HEAD contents lookup; regression checks cover both root causes.

The final status refinement removes pagination from the complete capability inventories while retaining shared search/sorting. Ready services have a lime indicator; configured but degraded services have an amber indicator and explicit degraded text; disabled/unconfigured rows remain muted. Pagination remains the shared default on other inventories. All 24 final status/workflow/grant/policy browser checks pass (18.9s), including all 27 reported Cloudflare fixture rows without a page cutoff, indicators, search and denial cleanup. The final image `sha256:b402a689ce66952f6667a5ffc857f91c6cd8a4fdecee0bd2cefca942bfac3d8f` carries these frontend changes; its server binary hash `c51cf76fe5999c66b2520f19e72b9397f19cd9fe99d6671dd628d3f96b9e6678` is identical to the native-qualified 920308 image, preserving the backend qualification without claiming a second native run.

The local deployment uses schema `202610020019` and retained worker/RustFS overlays. Actual retained administrator email/password sign-in, account security, editable instance push policy (still false), ready manual worker and all 3 protected grant HTTP routes pass; verification logout leaves credentials unchanged. Intake is unset and automatic CI remains disabled. This is disposable development, not whole-stack recovery or a production migration proof.

This is a prerequisite increment for N2/N3. Grant receipts explicitly report execution unavailable. Event-to-run materialization, automatic run origins, runner grant/credential/push-policy fences, grant editing/credential refresh, real coding agents, outbound delivery and preview deployment remain required. At this prerequisite increment schema019 backup/fresh restore was not yet qualified; the subsequent recovery/local-bootstrap entry records the canonical three-service qualification and remaining topology limits. No pipeline starts merely because a grant or push permission is saved.

## Capability setup entry points

Status now includes role-aware configuration actions into existing full settings pages: repository management, instance execution policies, and database/object-storage connections. R2 actions explicitly configure CI source storage only; other consumers and live Cloudflare qualification stay unavailable. Native event intake is labeled deployment configuration without a UI setup path. Unimplemented coding-agent, email, webhook, deployment and other provider adapters say Setup not available yet. Failed status refresh clears setup controls along with inventory rows. No credentials, scopes or provider connection presence are inferred from capability readiness.

Infrastructure settings explain New → save → test → verify/activate for CI sources, multiple saved profiles, one active CI-source binding, immutable versions for existing runs and the unavailable database cutover. Editors remain explicit actions on the full settings page; a Back to status link closes the navigation loop. Plan section 2.3.2 records connection multiplicity, scoped defaults, immutable run bindings and the remaining actual setup contracts.

Validation: TypeScript check and production Docker build pass; eight status/infrastructure browser checks pass (13.7s), including ordinary/admin action visibility, denied-refresh cleanup, navigation into the real inventory, explicit PostgreSQL/object/R2 editor selection and existing save/test/activate/ambiguous-result coverage. Local Docker image ID `sha256:765279e917ad7ec635af9a3799c13e4c861a969f85fb128d18f6431983e91050` is deployed (OCI config digest `sha256:22336c0fe98ec4a1d845a9e7c0665dcddacab0f86864d1de1dfcb180f8be6b60`; the config digest is not the Docker image ID). Retained administrator email/password login, protected connection inventory, ready manual-worker heartbeat, HTML settings routes and the compiled setup bundle pass live HTTP checks; verification logout leaves credentials unchanged. Server binary remains `c51cf76fe5999c66b2520f19e72b9397f19cd9fe99d6671dd628d3f96b9e6678`. No new provider adapters or automatic execution are claimed.

## Native events and provider-neutral status foundation

The implementation plan now details generic Golf capabilities with independently selected forge, execution, harness/authentication and delivery providers; portable agent machines, email, incoming/outgoing webhooks and notifications require no Cloudflare account. Sections 2.3.1–2.3.2, 9.9, 10.6 and 16.1 define per-function connection/evidence states, outbound HTTP/Slack delivery, provider mappings and N1–N10 tasks/dependencies/acceptance. [Local automation implementation](LOCAL_AUTOMATION_IMPLEMENTATION.md) identifies the actual session-bound runner/parser changes required for unattended push execution and each native harness adapter.

The new native push endpoint uses explicit operator repository bindings and raw-body HMAC authentication. Schema `202610020017` retains immutable connection bindings and compact append-only delivery metadata with exact-body hash deduplication. It does not retain raw payloads, infer actor authority from the sender or run commands. Newly recorded events explicitly report execution unavailable. Connection secrets remain in operator configuration; all serving replicas must be drained/restarted for consistent secret rotation. Native delivery/event headers are unsigned, so captured-body relabel replay/freshness is not prevented by this receipt-only slice. See [event contract](REPOSITORY_EVENTS_CONTRACT.md).

`/status` now separates the Golf platform, five portable coding-agent adapters and per-function Cloudflare integrations in shared searchable/sortable/paginated tables. It distinguishes actual manual-worker health and configured event intake from planned automatic execution, agent connections, email, outbound notifications and provider adapters. Failed refresh hides old table content. It provides no fake Connect actions or green provider states from installed binaries/saved credentials.

Qualification: all 18 focused browser checks pass (11.9s) after the final lazy-loaded status/CSS change, covering grouping, portable-agent wording, per-function provider states, shared search/pages, 320px controls and denied-refresh cleanup plus existing workspace/login/navigation behavior. Ordinary `go test ./...`, TypeScript/build, format/vet, generated drift and Helm bundled/external/OAuth/ingress/replica profiles plus 25 negative configurations pass. Generated SQL models include schema 017. Isolated real-PostgreSQL event race tests pass (2.857s) across configuration/HTTP/JSON, concurrent deduplication, restart/secret rotation, immutable binding/append-only guards, configuration rollback and insertion/deferred-commit failure; its fixture is removed. Provider-separation race check passes (1.420s) and verifies configured intake cannot imply operational agents, automatic pipelines or Cloudflare connections.

Native push qualification passes on image `sha256:798e232c939a4d07815ef22c8c63bed7a7772416508883399d5c77a7537f7052`: two actual Git pushes produce native HMAC deliveries and durable receipts (202); an exact privately captured transport replay after Golf restart returns 204; conflicting signed payload, invalid signature, mismatched binding and unknown connection return 409/401/400/404. Compact metadata privacy, no automatic runs and removed-connection denial with retained history pass. The disposable fixture is cleaned. This is Docker Desktop callback evidence; captured transport replay does not imply a native redelivery API or Linux callback qualification.

The same image is deployed at `http://localhost:8080` with schema `202610020017` and retained worker/RustFS overlays. Actual `admin@golfgit.local` password sign-in, account-security read and logout pass without changing retained credentials. Manual pipelines report ready; native intake stays disabled because no repository connections are configured on the retained stack. Automatic pipelines, all five agent adapters, outbound notifications and Cloudflare integrations remain disabled. Product status, docs and marketing return HTTP 200 on ports 8080, 3000 and 4325 respectively. This development update does not qualify whole-stack recovery or production migration.

This advances N1 and the status foundation of N4. It does not complete user-scoped event inbox/configuration APIs/UI, reconciliation/retention, durable unattended grants, automatic triggers, native pipeline engine parity, coding-agent execution, outbound HTTP/Slack/email delivery, previews or Cloudflare adapters. Schema017 whole-stack recovery and production multi-replica secret-rotation procedures remain unqualified.

## Own credentials and ordinary-account administration increment

The account security page at `/account/security` exposes explicit Edit actions for own Golf password and unique enrolled login alias, using current-password confirmation, immutable own IDs and credential-version checks. Successful changes atomically increment the version, revoke all local-password sessions (including the caller) and invalidate their delegated read-only API credentials. The browser clears private state and returns to sign-in. Independent native credentials and PAT/OAuth sessions remain separate. The email alias is unverified and does not establish mailbox ownership, notifications, native email mutation or recovery. See [account security](ACCOUNT_SECURITY_CONTRACT.md).

`/admin/settings` now offers explicit New/Reset/Enable editors for ordinary local accounts, using administrator-password confirmation and exact target versions. Enrollment binds an existing independently verified native identity; it does not provision native users. Enable requires a fresh password and matching native credential. Reset preserves a disabled account's disabled state. Administrator/self targets remain protected, and the browser cannot grant roles. Each commit includes actor/target/version/revocation history; secrets are encrypted or hashed and never returned. See [ordinary lifecycle](INSTANCE_ACCOUNT_LIFECYCLE_CONTRACT.md).

Schema `202610020016` adds actor-required self-change and ordinary-administration event classes. Downgrade refuses while those events exist. The shared local-response interceptor narrowly recognizes successful typed self-revocation receipts, so a committed credential change can return its receipt after intentionally removing its own session; unrelated responses still require current authority. Whole-stack schema016 encrypted restore, administrator-role lifecycle, native provisioning, verified email/recovery, MFA/passkeys, SSO policy and unified native suspension remain unqualified or unimplemented.

Qualification: all 199 browser cases pass across the full run (198 passing) and the corrected older settings fixture (six focused settings cases passing); the 22 focused security/administration cases also pass. The older fixture now explicitly checks Partial plus the remaining MFA/passkey/verified-email/recovery gaps, rather than treating password management as wholly absent. TypeScript, format/vet/generated drift and ordinary Go tests pass. Final serialized isolated real-PostgreSQL race suite passes (`go test -race -p 1 ./... -count=1 -timeout=240s`; server156.198s, database20.875s, telemetry6.354s); its fixture was removed. An additional 20-case actual Connect routing regression passes under race detection1.476s, covering malformed/noncanonical receipts, wrong versions/counts/login flag and another route. The initial pre-fix self-change401 regression was corrected in the shared interceptor and the complete database suite rerun successfully.

The combined native proof passes on immutable Golf image `sha256:a26132c709660b91c794be9e12f0f2f128bb80b1a3c80807ed2314a2b1b0d5ad`: `python3 scripts/account-lifecycle-smoke.py --image <that-image>`. It tests all three administrator and both self-change methods, native-ID mismatch, current-password/Origin/PAT/bearer/stale/protected-target denial, ordinary-only roles, disabled reset, fresh matching credential replacement with unchanged historical binding, exact local-session/delegation revocation, encrypted stored credentials, duplicate-alias rollback, actor audit and actual restart persistence. Native profiles and independent PATs stay unchanged. The disposable project containers, volumes, network and private configuration are removed. Initial runs exposed a fixture's incorrect expectation that an unknown protobuf JSON role field would be rejected; the corrected fixture verifies the resulting account remains ordinary in its response, stored row and fresh-login admin denials. No runtime role guard was relaxed.

The account-security deployment at `http://localhost:8080` ran that qualified image and schema `202610020016`, with the existing worker/RustFS overlays. Readiness reports the Golf database and native forge ready; bounded pipelines remain ready. The retained `admin@golfgit.local` account passed actual password sign-in, own security read and administrator inventory; the verification session was logged out. Its credentials were unchanged. Documentation and marketing remain available on ports3000 and4325. This deployment is disposable development, not production migration or schema016 disaster-recovery qualification.

## Previous profile editing and shared pagination increment

The profile increment local Golf image was `sha256:2d2031977450f8e795e18290e0f6e7a9582a3218afaf08b51fa663f8c83cea9a`; schema remains `202610020015` and the previously qualified worker/RustFS profile remains enabled. The retained administrator passed email/password login and own-profile GET/PATCH with unchanged values on this image; no account credentials or profile values were changed by that check.

Account settings now offer an explicit public-profile editor for display name, biography, location and website. Save uses current own-account identity, an observed revision, one supported native PATCH and verified receipt/readback; this does not provide native atomic CAS. Unknown outcomes require manual inspection, and private drafts/receipts clear across denial, account changes, logout and pagehide. Username, avatar uploads and recovery remain separate work; the newer security increment provides Golf password/login-alias changes. See [profile contract](PROFILE_CONTRACT.md) and [settings test readiness](SETTINGS_TEST_READINESS.md).

All inventories use the shared TanStack table pager (20 rows by default, 10/20/50 selection, Previous/Next, page/range indicators). Search/sort/pagination apply to loaded rows and say so; server continuation remains a separate action. Workflow history now fetches additional server pages instead of stopping at 20 runs. Mixed settings coverage is labeled Partial rather than Read only.

Qualification: all 192 browser checks passed (191 in the complete run, then the one older workspace fixture corrected to supply the new authoritative Profile API passed independently). Four pagination fixtures cover resetting/clamping, filtering/sorting, server-vs-local loading, denial, keyboard and mobile themes; eight profile fixtures cover saves/clears/validation/cancellation, privacy, permissions, stale or unknown outcomes and focus return. Go tests, TypeScript, generated drift and scoped PostgreSQL profile race checks pass. The actual disposable native/local profile proof passed on image `sha256:666e24485826dc67e8d9cd298de5b6e0a0ec4985e0a1577d064fee98dc314f15`, including ordinary write/read scoped users, unchanged independent login credentials, native read-only refusal, stale/foreign targets, restart persistence and full cleanup. Final-image UI changes do not widen that backend contract.

## Manual Compose CI, execution policy and infrastructure increment

The CI increment was qualified with Golf image `sha256:494ecb367aa6b5ea4bc164ff69a49878b90bffc3f56e5865493c8a8d0a4223f5`, the worker image is `sha256:d679c6656ac2a7bcd39cca6f0860b785ab8cb76794f7d2b51aee683aa178546a`, and Golf schema is `202610020015`. The local deployment now includes a registered Docker worker and RustFS 1.0.0; policies remain **disabled by default**. Current retained-administrator email/password sign-in, actual infrastructure/default inventory and logout pass on the rebuilt local stack. That check does not qualify every CI or recovery scenario on this image. This is a disposable development deployment; its update is not a production database migration/cutover qualification.

The browser now persists instance → organization → repository execution ceilings, all/selected/disabled repository eligibility, a separate manual-dispatch switch and exact workflow-path selection. Policy writes use current scope authority, immutable IDs, observed revisions and transactional actor history. Missing/disabled higher scopes deny admission. Source fetch, queue assignment, heartbeat, logs and results recheck policy epochs, session/account authority and current native identity/repository access. Golf instance administration does not acquire organization ownership or repository write permission. Native archived/mirrored repositories deny new execution before archive retrieval and are checked again after source waits. Existing authorized runs can still be cancelled.

[The shell catalog](PIPELINE_EXECUTION_COMPATIBILITY.md) compiles verified exact bytes for one Linux job: input-free manual GitHub Actions with bounded ordered `run` steps, or one digest-qualified GitLab job with a shared `script`. It rejects unsupported fields, actions/includes, expressions, secrets/variables, services, job graphs and events rather than ignoring them. Commands remain private to the plan; source inspection does not expose them. Jobs use an ordinary-source snapshot from a pinned native archive, not a full Git checkout: `.git`, submodules, LFS hydration and hooks are unsupported. Archives are normalized in memory with 16-MiB/4,096-entry/8-MiB-file bounds and rejection of links, traversal, duplicates and unsafe metadata; application code does not extract them onto the host.

Manual runs have durable exact repository/owner/user/session/commit/blob/image/source/policy binding and user-scoped UUID/input-hash idempotency. Browser APIs dispatch, list, inspect, cancel and paginate bounded logs. They require current cookie/Origin authority; read-only API credentials and CLI/MCP do not dispatch jobs. Private short-lived attempt capabilities authorize registered worker transport and are withheld from job containers. Leases, status versions, ordered/idempotent logs and terminal fencing constrain stale results; expired workers become lost instead of automatically replaying jobs. The Docker executor uses an isolated job container and separate Docker daemon, an operator-approved image digest, no job network or host Docker socket, bounded resources/output/runtime and explicit shell/failure behavior. These controls do not establish a hostile multi-tenant sandbox, protected-merge provenance or GitHub-hosted/GitLab Runner compatibility. Worker/policy status reflects actual registration and admission state, not a mock ready flag.

Organization creation now has persisted disabled/all/selected-user instance policy, current enrolled-administrator edits and browser creation for an eligible current user through supported native APIs. Golf eligibility does not manufacture native creation permission. Current identity, policy revision and session authority are checked; unsupported native metadata fails closed. Team ownership safeguards, invitations, delegated roles, organization-wide defaults and a durable native creation outcome journal remain separate work.

`/admin/settings/infrastructure` provides compact loaded-row tables and explicit full-page New/Edit/Test/Activate editors. A current enrolled local Golf administrator confirms their password for saves, tests and activation. Database/object profile credentials are encrypted under a dedicated keyring domain and UUID/version binding; public defaults and receipts never include passwords, access keys, ciphertext or DSNs. CAS saves append immutable configuration/actor versions. Database tests perform bounded PostgreSQL Ping without migrations; saved database profiles **do not switch** either live database pool. Object tests check bucket accessibility only. A separate activation verifies controlled immutable write/read behavior, then commits an exact profile/version pointer and append-only actor evidence. Future CI source objects use that pointer; existing runs retain their original provider/fingerprint or historical profile/version. This activates CI source storage, not Git repositories, attachments, artifacts or caches. Deployment defaults report actual startup metadata; an unreported native endpoint remains unknown rather than assuming local PostgreSQL. Historical profile credentials participate in startup key availability, bootstrap verification, rotation/event counts and retirement denial; see [keyring contract](CREDENTIAL_KEYRING.md).

Qualification recorded so far:

- All **179 browser fixtures pass (1.2m)**, including manual workflow UI, inherited policy controls, organization creation and infrastructure editors. The six focused infrastructure fixtures pass separately (15.1s): desired database configuration, retained credentials/original version, separate test/activation revision, lost receipt/secret cleanup/manual inspection and denied private-state removal. TypeScript and ordinary `go test ./...` pass.
- Full serialized real-PostgreSQL race checks before the object/profile extension pass (`go test -race -p 1 ./... -count=1`; server 97.834s, database 20.603s). Combined workflow/policy/worker/organization checks pass 7.824s. They include queued/running restore quarantine, null attempt capabilities, completed source/status/log evidence preservation and source-session invalidation. This is a database-level recovery regression, not a complete schema-015 native restore drill.
- Combined real-PostgreSQL infrastructure/key/object/activation race checks pass 18.722s. They verify actual successful and failed database Ping, admin/session/Origin/delegated denial, CAS/history/credential retention, all historical credential rotation, immutable source provider/version readback, post-wait policy/session/access revocation, transactional activation audit rollback and actor attribution. Provider transport in these database tests is controlled fixture evidence; it is separate from actual RustFS/Compose execution. Disposable PostgreSQL containers are removed.
- Actual RustFS 1.0.0 adapter race qualification passes (2.544s): `GOLF_RUSTFS_TEST_IMAGE=rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff go test -race ./internal/objectstore -count=1 -v -timeout=150s`. Native conditional replacement returns412, identical replay is accepted, eight concurrent creates produce one winner, and hash/size/auth checks plus actual RustFS restart persistence pass. Disposable resources are removed. This qualifies that RustFS build, not R2 or arbitrary S3 providers.
- Actual isolated Docker executor race checks pass (runner7.366s, worker command1.218s): `GOLF_RUNNER_TEST_IMAGE=alpine@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0 go test -race ./internal/runner ./cmd/golf-runner -count=1 -timeout=120s`. They cover non-root/read-only/capability/network/resource boundaries, actual ordered steps, exit7, timeout/cancel/output caps and cleanup, SIGKILL orphans and explicit labeled recovery that leaves unrelated worker resources intact.
- Final native Compose/source-storage proof passes: `python3 scripts/ci-compose-smoke.py --objects --image sha256:494ecb367aa6b5ea4bc164ff69a49878b90bffc3f56e5865493c8a8d0a4223f5 --runner-image sha256:d679c6656ac2a7bcd39cca6f0860b785ab8cb76794f7d2b51aee683aa178546a`. It explicitly provisions a fresh private RustFS bucket, preserves queued source binding across actual RustFS/Golf restart, executes Actions/GitLab shell success and exit7, cancellation and policy revocation, and verifies all five runs have exact `env_s3` source key/hash/fingerprint with PostgreSQL `source_archive` NULL. Attempt resources and the disposable project containers/volumes/network are verified removed. This proves the bounded source-object path, not artifacts/cache/CD or a whole disaster-recovery drill.
- The current local bucket is explicitly provisioned; bucket creation is not an automatic profile-save or health-test side effect. Current schema015 is also independently verified by the local Golf `goose_db_version` table. Final full schema015 PostgreSQL race checks pass (`go test -race -p 1 ./... -count=1 -timeout=240s`; server115.845s, database20.796s, telemetry6.339s); the isolated PostgreSQL fixture was removed. Whole-stack schema015 recovery, hostile tenancy/load/capacity, production migration, R2 and Cloudflare execution remain unqualified.

The catalog advances P4 and the settings requirements; it does **not** complete them. GitHub/GitLab direct import, maintained engine/coordinator compatibility, full Git workspaces, fork approval, trusted result provenance, artifacts/caches/secrets/OIDC, dependency network policy, schedules/triggers, runner groups/autoscaling, Kubernetes/Cloudflare executors, integrated coding harnesses and protected previews/production CD remain gates. AI and Cloudflare remain optional for the portable core. Golf's own repositories still have no CI workflows.

## Previous administration, repository access and workflow inspection increment


The previously qualified administration runtime is `sha256:91b88ad5fd90a065f7996dcf4f1d93a85d43adeadd6de63e9094b088827382d4`, with Golf schema `202610020009` and server binary SHA-256 `b589e62507068499ea9efb192edda286ec17bc5998b187d0d3ae26822e354fb0`. Global administration has shared navigation at `/admin` and an actual local-account inventory at `/admin/settings`. Explicitly enrolled local-password administrators can disable an ordinary local account after confirming their own current Golf password. The transaction checks current authority and the target credential version, disables password sign-in, revokes its local sessions/dependent read-only API credentials and records immutable actor attribution together. Administrator accounts cannot be disabled in this browser flow; enrollment, reset, reactivation and global infrastructure/policy configuration remain operator-managed. Native Git credentials and provider logins are independent. See the [disable contract](INSTANCE_ACCOUNT_DISABLE_CONTRACT.md).

The persistent global sidebar has been removed. A compact header contains the Golf brand, an on-demand personal/organization switcher, repository/organization navigation, one theme toggle and the user menu. Membership reads mount only while the switcher is open, with paginated current authority, cancellation and denial/account-switch cleanup. Repository home offers a loaded-row ownership filter; system capability status moves to `/status` under the user menu, with the old capabilities hash preserved. Settings retain a task-specific local sidebar.

Personal repository settings now share General, Access and Workflow configuration navigation. [Collaborator administration](REPOSITORY_ACCESS_CONTRACT.md) supports existing-account read/write/admin grants and removal for the actual personal owner or a qualified direct native repository administrator. Golf's global role does not bypass repository authority. Owner/self changes are locked; hidden or unverifiable organization ownership fails closed; organization grants stay team-managed. The UI resolves immutable account IDs and reviews the original repository/collaborator revisions before a single write. Native administration includes broad powers such as deletion. Native username-addressed writes remain best-effort revision fences, not atomic target/permission CAS or exactly-once mutations. Pagination now follows canonical native `X-Total-Count`, including explicit refusal beyond the 10,000-page limit.

[Workflow configuration inspection](WORKFLOW_CONFIGURATION_CONTRACT.md) discovers direct GitHub Actions YAML and root GitLab CI configuration at a resolved commit, verifies exact blob bytes and applies a bounded, non-expanding YAML inspection catalog. A compact searchable table links back to that pinned source and shows unsupported/invalid configurations and diagnostics. It never executes a script, fetches includes/actions, activates triggers or approves runner images. A checked static subset is not Actions/GitLab compatibility. CLI/MCP remain the existing 21 reads; these new browser procedures are not delegated API tools. No repository CI workflows were added.

Qualification:

- All **160 browser fixtures passed (46.0s)**, including collaborator identity/grant review, cancellation and lost receipt, account-switch privacy, global role denial, lazy/paginated workspace switching, contextual settings navigation, ownership filtering, password-confirmed disable, failed logout during an in-flight disable, pinned workflow links, loaded search/sort and mobile reflow. Typecheck, production build, `go test ./...`, `go vet ./...`, generated drift, formatting and offline recovery archive validation pass.
- Full real-PostgreSQL race checks pass with packages serialized (`go test -race -p 1 ./... -count=1`; server 80.919s, database 20.247s). Parallel packages contend on the shared native migration advisory lock and exhausted one existing 3-second migration fixture deadline; no production migration retry or timeout test was weakened. After the final count-header pagination change, focused real-PostgreSQL repository-access race checks pass again (1.828s).
- On the final runtime image, actual native collaborator grants/removal, three paginated direct accounts, owner/direct-admin/global-admin distinctions, public/private readability and revocation, hidden organization fail-closed, Origin/bearer/logout denial and disposable cleanup pass. Workflow inspection proves exact commit/blob identity, three inspection states, old-pin stability after branch advance, scope/access/session denial, symlinks/oversize/count/aggregate limits and cleanup. Synthetic final workflow source commit: `33cc8c76537c47ca652ee8f75a4f24c6def04e49`.
- Isolated actual local-account disable and encrypted schema-009 recovery pass on image `sha256:6e50de4129b17d04ea071796b8a7011d40eeebef167804105c230f8b0293cac5`. They prove wrong-password/ordinary/PAT/bearer/Origin/admin-target denial, CAS, two target password-session revocations and dependent bearer denial, independent native/PAT survival, durable actor history, restart/throttle, exact `ADMIN_DISABLED` preservation after restore and existing Git/LFS/attachment/protection/SSH/signature/post-restore write coverage. All disposable cores and private recovery artifacts were removed. Subsequent runtime changes are collaborator-count pagination, shared table styling and contextual frontend navigation; the disable/recovery implementation is unchanged. Schema-008 backup compatibility remains explicitly allowed, with the earlier qualification retained below.
- Production-served browser review with `admin@golfgit.local` passes email/password login, actual global account inventory and administrator protection, shared repository Access/Workflow pages, on-demand current membership switcher, removal of the permanent sidebar, dark desktop/light 320px layout and sign-out. Screenshots were inspected; secondary account metadata now uses shared block styling instead of running into usernames. No retained account password, keys or roles were changed by qualification.

Next enforcement milestones remain organization invitations and team/repository grant editors with ownership safeguards, persisted instance→organization→repository policy ceilings and connection selection, GitHub/GitLab product import, then isolated runner execution with a compatibility corpus, provenance and exact-commit fork approval. At that historical increment, CI/agent execution, Cloudflare destinations and protected previews/CD were unimplemented. The newer bounded manual CI and policy scope above supersedes that CI status; broader gates remain open.

## Current delivery

Historical note (2026-10-16): the sections from here through "Next work and release gates" describe the 2026-10-02 developer preview. Their native evidence was gathered on the native forge at the time (an earlier backend, since retired) and is not Forgejo evidence. Scripts and documents specific to that backend were removed.

The developer preview is implemented: a versioned Connect Go API and typed-route React application backed by separate Golf/forge PostgreSQL databases, operator-enrolled Golf email-or-username/password sign-in, optional scoped forge browser OAuth plus per-user token bootstrap, encrypted persistent sessions with account listing and current/individual/bulk revocation and own-account session activity, member-scoped organization/team/member/repository browsing, authorized repository listing and durable own-account creation, repository/branch/history/source and native commit-diff browsing, ordinary issue creation/comment discussions and PR/native-review browsing, owner-issued source-session-bound read-only API credentials, own-account native SSH key management, a read-only JSON CLI, black/charcoal/light themes, live health checks and Compose/Helm installation. The forge owns Git and collaboration data; Golf application features do not write the forge's database or repository files. The explicitly scoped offline recovery operator uses native database/volume restoration into a fresh stopped target, as described below.

The product UI now shares the marketing/docs identity: bundled Archivo and Geist Mono, the lowercase Golf wordmark, charcoal/neutral-light surfaces, lime accents and square repository panels. Workflow text is 14–16px with 13px secondary metadata and mobile touch targets. All 100 browser checks, typecheck/build and dependency audit pass; the added check covers loaded fonts, keyboard input/dialogs and 320/640px reflow (640px models 1280px at 200% layout zoom). The branding-only Docker image was `sha256:60db799910f2a014d09a5f2e79fdd2c27798422865a76bad1efb8995bdb5ae38`; its server binary is unchanged from the qualified issue-discussion image (`67c16140ea16bab6ab05be5b544c0edb8d5e0a2b3dc40887fadecd3af0dde9ec`), with no schema or API change. The final isolated native UI run passes actual private source browsing, issue/comment creation, filtered pagination, lost-response status-only resume, literal text, dark/light narrow layouts and session-revocation cleanup; screenshots were inspected. The retained native `golf-admin` account’s native administrator status is separate from the explicitly enrolled Golf role described below; the current qualified administration controls are described in the increment above. Private local credentials are excluded from Git.

The [repository browser increment](REPOSITORY_BROWSER_CONTRACT.md) resolves branches to immutable commits before traversing folders/files. It previews bounded ordinary UTF-8 text, leaves binary/large/LFS/symlink/submodule content as metadata, and distinguishes empty repositories from provider failures. Browser navigation supports deep links/history and clears private query data on authentication changes. Issue bodies are plain text; issue edit/close/reopen, labels/boards, rendered Markdown, PR comparisons, blame and PR/review mutations remain future work.

`make cli` builds `bin/golf`. PAT mode reads through the same per-user API using an ephemeral bootstrap session and closes the session after each command; API credential mode delegates its issuing session without login/logout or a cookie jar, and emits the documented `golf.cli.v1` JSON envelope. The new [local MCP adapter](MCP_CONTRACT.md) exposes the same 21 reads with `golf.mcp.v1` results and a fixed owner-configured origin and API credential or PAT; native-provider/SDK-client and separate raw-wire cancellation qualification pass. It has no managed stored-credential or OAuth/device flow, managed authentication, mutation commands, remote MCP or ACP. Normal CLI cancellation closes the session; cancellation while reading a token also unblocks stdin. Abrupt process termination remains bounded by server session expiry.

Marketing and docs have independent private repositories: [golf-website](https://github.com/mjtechguy/golf-website) (Astro) and [golf-docs](https://github.com/mjtechguy/golf-docs) (Docusaurus/MDX). Both have static production builds and manual Cloudflare configuration. No live Cloudflare site or product service has been deployed by this work. No repository CI workflows were added.

The [Helm chart](../deploy/helm/golf/README.md) packages the current shared core with existing Secret references, optional bundled PostgreSQL/forge, retained PVCs, probes, resource/security bounds, native ingress and network policies. Golf can share sessions across replicas; the forge retains one canonical writer. See [Kubernetes installation and qualification](KUBERNETES.md).

This is **not complete v1**. Self-service local enrollment/password recovery/MFA, external OIDC identity, complete organization/role administration, direct provider import, PR/review mutations and protection/merge policy, complete pipeline/runner compatibility, agents, Cloudflare resources, email/webhooks and protected deployments remain open. Bounded organization creation, execution policy, manual shell CI and connection profiles are implemented as described above. Forge capabilities reachable outside Golf are not automatically Golf features.

The two infrastructure tracks remain distinct choices over shared product policy. The portable target runs completely in Docker or Kubernetes and can mix optional Cloudflare backends with other providers. The [competition milestone](COMPETITION_READINESS.md) applies only to the Cloudflare track and requires real Workers, Artifacts and concurrent agents. It is not yet ready.

## Golf local password boundary

The [local authentication contract](LOCAL_AUTHENTICATION.md) adds operator-enrolled Golf-owned usernames/passwords, Argon2id verifiers and independently encrypted mapped provider PATs. Exact native forge/user IDs bind accounts; the Golf password never reaches the forge. Local sessions bind the account/version and expose an explicitly enrolled instance-administrator flag, while PAT/OAuth/native administrator status does not inherit that flag. This is verified role metadata, not completed administration screens or organization permissions. Reset/disable revoke local sessions and their API delegations; separate PAT/OAuth/native authority remains independent. PostgreSQL fixed-window counters and four bounded KDF slots constrain login; full abuse, MFA/step-up and idle-timeout gates remain open.

Native qualified image `sha256:44c422c7f61225cb963a8a4e8ec793ec04bb79ce821f739f144ef0c635910d18` passes `python3 scripts/local-auth-smoke.py --image <IMAGE_ID> --browser`: actual independent Golf/native passwords and explicit roles, generic wrong/unknown denials, exact Origin, private repository creation/pinned source, session/API delegation revocation, reset/disable/immutable re-enable, separate PAT authority, whole-core restart, active+disabled credential rotation/retirement/old-key removal, native account deletion and persisted rate limiting. Production-served browser password/error/logout/current-session-revocation, HttpOnly cookie, role/session/activity labels, reload and dark/light/mobile checks pass. Both fixture and entire isolated core were removed; normal local accounts were untouched by this proof. The final real-PostgreSQL race suite passes (server65.089s, database30.514s, server-command2.376s, CLI2.595s, telemetry6.822s), as do all104 browser fixtures, format/vet/generated-output checks, Helm25negative profiles and the full paths-aware source secret scan. Server binary SHA256 is `e76ab1ef512486e3ef8ea8835f04bf571040637b46d2931889030a0213044f91`.

Schema007 native encrypted recovery passes on the same qualified image: five sessions and one PKCE attempt removed; two local accounts (including one already disabled) retained but disabled and version-fenced, exact verifier/ciphertext/identity/history preserved, matching recovery events/counts, reset-only/wrong-mapping denial and explicit current-authority enablement. Previous Git/LFS/attachment/protection/signature/mutation/delegation and whole-stack-restart checks also pass. The small fixture again explicitly skips the minimum-cap negative case. This is bounded canonical Docker recovery, not reconciliation of post-backup provider decisions or a general account lifecycle.

The final rebuilt/deployed Docker index is `sha256:33befc977e44a1d2e1c893c59901b48968a093f0acbc788e00c7f4a1f907c1cb`. The two native commands above ran against `44c422c7…`, not that new index. Artifact comparison confirms the runtime image manifest is byte-identical (`sha256:bbbe9fc10cf16f2ad11a797c0ada9df3fe7feafc5ced1bd34718b2af79dddfd9`), as is its config (`sha256:1232e60c110578de1afb32a5a7153070e62f0883bf6d96f44e2f4f4905f224f4`) and server binary (`e76ab1ef512486e3ef8ea8835f04bf571040637b46d2931889030a0213044f91`); only build attestation/index metadata differs. Runtime/assets equivalence carries the qualification without claiming a second native run on the new index.

The normal local installation on port8080 now runs the rebuilt index `sha256:33befc977e44a1d2e1c893c59901b48968a093f0acbc788e00c7f4a1f907c1cb`. A retained, independently enrolled `golf-admin` Golf instance administrator signs in through the actual username/password UI. Root verified HttpOnly/persistent cookie metadata, absence of password in browser storage, and the exact same cookie/administrator session after an actual Golf backend restart; the verification session was then logged out. Existing database/forge volumes and native administrator credentials were preserved. The distinct Golf password is in a mode0600 ignored local file; no password/token is committed. The broader administrator management UI is still unimplemented. Dedicated PostgreSQL tests, native qualification projects, anonymous volumes and private test configuration were removed; permanent operator credentials remain. The shared SVG favicon now uses the actual outlined Archivo900 lowercase `g` glyph from the product/marketing/docs wordmark, without browser font dependencies.

## Read-only API credential boundary

The [credential contract](API_CREDENTIAL_CONTRACT.md) adds cookie-only owner issue/list/revoke, once-only secrets stored as digests, immutable source-session/owner/forge bindings and separate append-only lifecycle events. Requested expiry is capped by the original session; explicit revocation, expiry or termination of that session denies reads. The exact current 21 CLI/MCP reads plus identity inspection are allowlisted; writes, authentication, lifecycle management and unreviewed future procedures remain denied. Delegated reads recheck native identity and local authority before encoding a successful result. CLI/MCP can use the delegated token without obtaining an upstream secret or opening temporary sessions.

The new schema005 recovery drill passes on image `sha256:4dbc64b946d0de111cf8abf1c923c197dc5ebc46e0c207b39452883846af8632`: metadata/events remain byte-equivalent after restore, both previously revoked and unrevoked old tokens stay denied after fresh same-user sign-in, and a fresh token works after an ordinary whole-stack restart. Final real-PostgreSQL race tests pass (server38.676s/database19.931s); 86 browser fixture checks, both-mode raw MCP cancellation checks, generated-output drift, product checks and Helm qualification pass. Final native CLI/MCP qualification passes on that exact image: all 19 tools in PAT/bearer modes under both protocol revisions, CLI stdin/environment reads, no bearer session/activity additions, cancellation/SIGTERM and explicit/source/native revocation. Production browser qualification passes on the final image: real issue/copy/dismiss, expiry clamp, bearer read/write/manage denial, explicit revoke, actual issuance acknowledgment loss without resend, 21-row pagination/plaintext labels, charcoal desktop/light390px mobile and source-revocation cleanup. All native disposable containers/volumes/networks/private configuration were independently removed. This is part of P1.8/P5.5, not long-lived service accounts, configurable scopes, tenant policy, OAuth/device login, remote MCP, ACP or agent execution.

## Issue discussion boundary

The [discussion contract](ISSUE_DISCUSSION_CONTRACT.md) adds ordinary issue creation, plain-text comment creation, one explicit filtered native comment page and own-operation lookup through generated API and typed UI. A canonical UUID binds exact input/target IDs; reservation precedes the sole native POST. Verified HTTP201 receipts retain provisional IDs with an UNKNOWN receipt phase before current ID-bound postflight can record success. Neither provisional observations nor UNKNOWN replay adopts an object or posts again. Native address-based POSTs cannot atomically fence rename/delete/reuse; conditional-target and protected-publication gates remain open.

Final schema006 image is `sha256:d4d8e496b9530d60631191991e77fe333e3cc4db35d2379c144eb3bdd1df3e60`; server binary SHA256 `67c16140ea16bab6ab05be5b544c0edb8d5e0a2b3dc40887fadecd3af0dde9ec`. Full isolated real-PostgreSQL race regression passes (server51.138s/database35.523s/CLI2.112s), targeted receipt/phase/guard regression passes5.730s, all99 browser fixtures and the affected9-check OAuth fixture rerun pass, generated drift/vet/Helm25negative profiles and offline recovery validation pass. Native21-tool CLI/MCP proof passes on a fresh006 core under both protocol revisions and PAT/bearer modes, with receipt identity parity, empty-page continuation, denial and cancellation/revocation. Actual provider201 loss for issue/comment writes proves one POST per key and UNKNOWN/no-adoption across host restart. Fresh encrypted006 recovery preserves journal/events byte-equivalently, old bearer denial, own replay/native objects/no duplicates, Git/LFS/attachments/protection/SSH/signatures and new writes/whole-stack restart; its small-fixture minimum-cap negative case explicitly skips. Actual browser OAuth proves issue/comment writes and existing narrower grants remaining denied until explicit revocation/fresh consent, without redispatching rejected old keys. Normal OAuth-disabled configuration is restored.

Final production-served native browser qualification passes: real issue/comment writes,20 unrelated native comments producing an empty filtered page with continuation, browser acknowledgment loss after actual success, metadata-only close/reload/status recovery with no duplicate, exact native IDs/text, deep links, charcoal desktop/light390px mobile and real source-session revocation/private-state cleanup. The final normal-stack restart/CLI/source/Git/scope smoke also passes. These are bounded shared-core capabilities, not complete P2.2, enterprise policy, runner/agent execution, conditional native target admission or Cloudflare integration. CLI/MCP remain read-only with21 tools; API credentials cannot invoke the new writes.

## Commit-diff read boundary

The [commit-diff contract](COMMIT_DIFF_CONTRACT.md) adds one exact-object read with native root/first-parent metadata and bounded raw provider text. Generated API, CLI, typed browser navigation and native-provider proof are verified for this bounded workflow. The 512 KiB text boundary rejects oversize, invalid UTF-8 and controls instead of truncating locally, while provider output remains unverified for patch completeness or merge eligibility. Existing protection/merge gates remain open.

## Local MCP boundary

The [stdio MCP contract](MCP_CONTRACT.md) adds discovery and 21 named tools over existing CLI/API reads, using official Go SDK v1.8.0 and the two explicitly selected protocol versions. The process owner fixes the origin and exactly one source-session-bound API credential or scoped PAT; tool arguments cannot select credentials, destinations, methods or shell commands. PAT per-call temporary sessions preserve native access checks and add login/logout activity; API credential mode uses its existing session without login/logout, so discovery does not advertise side-effect-free or idempotent behavior. Bounded inputs, four active calls, deadlines and independent cleanup constrain this local adapter. Native-provider/SDK-client checks and separate raw-wire cancellation/framing checks pass. The latter reproduced the unmodified SDK's post-cancel reply and verifies Golf's bounded active-ID guard. No complete protocol-conformance, agent-client execution, remote MCP authorization, ACP, mutation approval or general task lifecycle is qualified by this increment.

## Repository-creation boundary

The [durable creation contract](REPOSITORY_CREATION_CONTRACT.md) is implemented and qualified for the supported personal forge create route. A canonical UUID v4 binds exact input to an immutable Golf account/forge; reservation and its initial event commit before the sole permitted provider POST. Replays return recorded evidence without redispatch, including after restart. Keyed callers distinguish `SUCCEEDED`, `REJECTED` and `OUTCOME_UNKNOWN`; unkeyed callers preserve earlier failure behavior but cannot deduplicate separate invocations. Successful metadata requires a current native read of the original repository ID; access loss, deletion or same-name replacement grants no cached access.

Actual browser acknowledgment loss recovers by status-only lookup after reload. A separate native fault proxy discarded the forge's real HTTP 201 and counted exactly one POST across retries and backend restart; Golf stayed unknown and did not adopt the repository by name. Current caller/foreign-account checks, rollback/concurrency tests and restored operation/event preservation pass. Browser convenience storage uses origin plus native forge user ID, not the internal Golf account ID. This is one operation-specific journal, not a general outbox, job engine, organization/tenant model, exactly-once contract or protected-write implementation.

## Credential keyring boundary

The [credential keyring](CREDENTIAL_KEYRING.md) is implemented under [ADR 0005](decisions/0005-credential-keyring-and-drained-rotation.md); final real-PostgreSQL regression and old-binary PAT/pending-verifier checks pass; live OAuth exchange across a key change remains unqualified. It adds labeled PAT/OAuth/local-session, pending-verifier and persistent local-account ciphertext, permanent label/material bindings, active-policy fencing and server-operator status/activation/bounded-rotation/retirement commands. Status can run migrations and scan/register legacy metadata. Activation requires draining all old writers, including external OAuth exchanges; database fencing cannot undo provider rotation. Retirement requires zero stored uses across all three credential families, including expired session/attempt rows and disabled local accounts, and erases no secret. This does not qualify rolling key cutover, live OAuth exchange across restoration, KMS/age migration, a FIPS profile or completed P1.3. The separate bounded Docker recovery proof below preserves key configuration/metadata and removes restored sessions/PKCE while disabling and version-fencing retained local password accounts. The ledger distinguishes this foundation from broader operational qualification.

## Recovery boundary

The [offline recovery workflow](RECOVERY.md) is implemented for the canonical three-service Docker profile with PostgreSQL 18.4, the native forge at the time and Golf schema 202610020008. It captures resolved runtime credentials, both native databases and complete forge volumes into an age-encrypted operator backup; validates bounded archive/configuration paths and hashes; requires a fresh target and exact locally available image IDs; and restores with both applications stopped. Images are not included. The restore runs a transactional all-session/all-PKCE invalidation and local-account disable/version fence, and writes independent append-only operator history while preserving identities/account/crypto history, repository-creation operations/events and key metadata. Real PostgreSQL safeguards, offline archive tests and **the complete native backup/restore drill pass**, including simultaneous restart of the restored three-service stack and disposable-resource cleanup.

All writers must be drained. The assertion and read checks do not fence administrators or future writes; restored provider revocations, memberships/protections, deletion tombstones, external OAuth rotation and outbound mirrors/queues require authoritative reconciliation before traffic opens. The pending-verifier fixture is not a live OAuth recovery proof. Kubernetes/external storage, broad inventory/scale, cross-version recovery and production RPO/RTO remain open. This is bounded P1.6 progress, not completion or automatic disaster recovery.

The final native drill verifies data restoration, credential invalidation, signed Git/hydrated LFS/attachments/protection/SSH identity, post-restore writes and simultaneous whole-stack restart. Database startup retries only connection readiness before migrations, every 250ms within the caller deadline (60s when absent), including DNS not-found as well as temporary DNS/transport failures and PostgreSQL startup/connection-slot errors. This handles Docker temporarily withdrawing PostgreSQL's service record during restart. A valid-looking typo in a hostname therefore waits for that deadline; malformed DSNs, authentication/missing-database failures and migrations are not retried. Targeted tests reproduce delayed DNS before real PostgreSQL connection/migration, bounded missing-DNS cancellation/deadlines, immediate native authentication/missing-database rejection and single-execution migration failure. The final rebuilt-image drill and full race regression both pass.

## Observability boundary

The [shared-core observability contract](OBSERVABILITY.md) adds injected zerolog completion logs, optional OTLP/HTTP API/provider/PostgreSQL traces and a separately authenticated private Prometheus listener. The real database/sql pgx connection receives the composite query tracer; operator/test pools preserve their uninstrumented path. No global logger/provider/registry is installed. Fixed methods/routes/statuses and SQL verbs bound exported labels; source/credential/identity/SQL contents and raw panic/provider/exporter errors are excluded.

The optional six-service development overlay adds Jaeger/Prometheus/Grafana and provisioned dashboards while the ordinary three-service profile remains unchanged. [ADR-0006](decisions/0006-private-observability-runtime.md) retains the original guide's Tempo/Loki/log-search requirement as an explicit remaining gap. Export is sampled and best effort: failed attempted batches have a counter/fixed diagnostic, but bounded queue overflow is not included in that counter. Jobs/runners, production SLOs/load/retention/alerting, incoming cross-service propagation and live Kubernetes collector/scraper qualification remain open. This is P1.7 progress, not task completion or durable audit evidence.

## Verified local evidence

| Check | Observed outcome | Boundary |
| --- | --- | --- |
| `make check`; `make helm-check`; final isolated-PG `go test -race ./... -count=1 -timeout 120s` | Pass: formatting/vet/unit/type/generated-contract checks, 25 rejected Helm configurations and optional metrics/tracing render cases; full real PostgreSQL regression including native traced-pool attachment and uninstrumented-pool isolation; cmd 2.554s, CLI 1.798s, server 34.088s, database 35.478s, telemetry 7.231s | New telemetry tests cover actual OTLP protobuf correlation, bounded labels/canary privacy, independent registries, sample-zero/no ambient activation, sanitized collector failure/redirect refusal/deadline, safe panic/abort/flush/hijack/103→202 and timeout504. One initial full-suite pass hit the existing positive startup fixture's 5s migration-lock deadline under concurrent native load; that positive fixture now allows 30s, while separate short cancellation tests retain their deadlines. No production/startup SLO or real cluster telemetry claim. |
| `python3 scripts/observability-smoke.py --image golf-local:observability` | Pass: isolated native six-service install; bearer rejection/legitimate metrics, actual Prometheus scrape, authenticated provisioned Grafana dashboard/Prometheus datasource health and `up=1` query; real scoped login/durable creation/source/outsider+anonymous denial; one API request with real forge and PostgreSQL child spans plus matching log IDs; bounded metric labels and credential/cookie/key/DSN/user/repo/source/SQL canary exclusion; collector-stop export-error counter while app remains usable, followed by successful export recovery | Exact proof image `sha256:8ee648f2f7a3e81b8f884ffa90112bc0258b6805d1c9d18b26ca14ac47bbcdaa`, binary SHA-256 `997a60a4c99eb5d324779cbd85f75e8a14e88446d8c70bd741d58a72a5163d2b`; native PostgreSQL/forge and digest-pinned Jaeger 2.21.0/Prometheus 3.15.0/Grafana 13.2.3. All disposable identities/containers/volumes/network removed and independently checked. Jaeger uses its stable v3 query API and standalone UI: latest Grafana's Jaeger datasource failed compatibility and was removed; Grafana's metrics datasource is qualified. No job/runner/cluster/production or expanded-topology recovery claim. Secret initialization privacy/no-overwrite check also passes. |
| Current ordinary Docker rebuild and `python3 scripts/smoke.py --cli bin/golf` | Pass: current ready dependencies, real scoped sessions/private Git/source/CLI/boundaries, least privilege, upstream revocation and logout; disposable provider fixtures removed | Monitoring disabled in this canonical profile. Running image `sha256:4f78a5861ff2acfe323aa7a5f924fa1242506c16da6559ae1169bba7dffb5c21`; server binary SHA-256 `997a60a4c99eb5d324779cbd85f75e8a14e88446d8c70bd741d58a72a5163d2b`. Historical recovery-image proof below is unchanged and was not rerun here. |

| `make check` | Go formatting/vet/tests, frontend typecheck, Buf lint and Buf/SQLC generation-drift checks pass; a deliberate temporary output drift is rejected | Database integration is explicitly skipped unless its isolated DSN is supplied. |
| `go test -race ./... -count=1 -timeout 120s` with isolated PostgreSQL | Pass: generated clients, pre-decode auth/origin checks, compressed-input bounds, typed errors, capability degradation, SQLC session scoping/transaction rollback/migration locking, encrypted sessions, create/read/logout/revocation, session management privacy/paging/foreign-ID denial, provider identity, caller/target expiry and lock waits, bulk concurrency, commit rollback and PAT/OAuth-preserving migration, six organization RPCs with immutable caller/member/team binding, malformed/unknown provider metadata, scope/visibility/expiry/revocation checks and bounded pagination, pinned source and issue/PR separation, three PR/review reads with repository/PR binding, retained/deleted/unresolved metadata, native review flags, filtered empty-page pagination and post-wait session/access rejection; transactional account events, forced insert rollback, SQL history guards, legacy PAT/OAuth preservation without fabricated history and ordered same/cross-account writes with stable snapshot reads; commit-diff metadata/path binding across internal/public origins, plain-text bounds and post-wait authorization; repository-creation reservation/events, concurrent deduplication, exact-input conflict, completion rollback/cancellation, immutable caller/current-repository ID gates and append-only history | Real PostgreSQL 18.4; forge HTTP fixtures for these tests. Disposable DB removed afterward. Final repository-creation/schema 202610020004 run passes: cmd/golf 2.536s, CLI 2.134s, server 32.191s, database 30.397s. Recovery-specific evidence is recorded below. |
| `go test -race ./internal/cli -count=1` and `make cli` | Pass: origin/TLS/redirect boundaries, stdin credentials, typed Connect requests, JSON/schema/output safety, denial, bounds, cleanup failures and cancellation during reads/token input | HTTP fixtures include `repo creation` lookup with canonical key validation, exact output/privacy and ephemeral cleanup, all six organization/team commands and three PR commands, commit diff with exact-object validation/default JSON, and audit list with exact snapshot cursors, canonical IDs/numbers, explicit pagination, private-output denial and cleanup failure. Real source reads are checked by the Compose smoke; organization/team reads and ephemeral cleanup are checked by the organization smoke; PR reads and cleanup by the PR smoke. |
| MCP increment `make check` and `go test -race ./...` | Pass: schema/catalogue checks, both protocol versions, pre-auth argument validation, exact string IDs and structured/text parity, sanitized denial, private-result withholding on cleanup failure, saturation and request/process cancellation; cmd/golf 2.292s, CLI 1.765s, server 1.520s, database 2.972s. `go mod verify`, source secret scan, Python syntax and diff checks also pass | Final transport-guard source. No isolated PostgreSQL DSN supplied for this run; database-dependent cases explicitly skipped. Prior real-PostgreSQL evidence above remains historical. Browser unchanged; no new Playwright claim. |
| `python3 scripts/mcp-smoke/run.py --cli bin/golf` | Final strengthened run passes after the transport guard: official SDK v1.8.0 client negotiates exact `2026-07-28` and `2025-11-25`; both versions exercise all 19 tools against actual private fixtures with structured/text parity, explicit pagination/exact IDs/activity snapshots and temporary-session cleanup. Full catalogue/annotations and unknown mutation-tool rejection pass. Additional native cases cover invalid input before authentication, narrow/foreign scope denial and same-process loss of access after actual collaborator/org membership removal | Actual stdio subprocesses and the pinned native forge; a loopback barrier after real API responses verifies four active calls/fifth busy, cancellation and independent logout, plus SIGTERM/four logouts/no private success. Golf server image `sha256:8e27249e71f3d119394a8fd7768b2a5332241cdf931c40b750add63ba055c14f`; this native MCP proof does not rerun the separately recorded recovery-image qualification. Fixtures/processes cleaned; historical Golf identities/events intentionally remain. Raw cancelled-response suppression is independently checked below for both versions. No coding-agent client qualification. |
| `python3 scripts/mcp-cancellation-check.py --cli bin/golf` | Pass: both versions suppress a cancelled reply while aborting the blocked HTTP read and performing logout (about 0.52s in the fixture); 32 unknown/completed cancellations and ID reuse preserve later calls; batch/oversized frames are refused before auth; duplicate active ID closes the connection with read abort/logout; stdin EOF exits cleanly | Actual process/raw JSON-RPC with a controlled HTTP fixture. Original SDK v1.8.0 behavior failed the post-cancel reply check; Golf's bounded active-ID and single-object frame guards pass. Legacy `2025-11-25` forbids client ID reuse: those cases test defensive invalid-client handling, not a recommended client pattern. This is a targeted wire/lifecycle proof, not all-method protocol conformance or a throughput/shutdown SLO. |
| `npm --prefix web run build` | TypeScript and Vite production build pass | Browser bundle only; provider behavior checked separately. |
| `npm --prefix web test` | 72 Playwright checks pass (21.8s); the final `failed_precondition` fixture target and TypeScript/production build also pass | Generated-contract fixtures include creation UUID reuse/frozen input, synchronous same-batch duplicate-submit prevention, Unicode/UTF-8 byte bounds, unknown/rejected/success states, status-only reload, browser storage bounds, current-user isolation and cancellation/private cleanup; eight commit-diff cases covering root/first-parent metadata, exact-object routes, empty/native text and unsafe HTML, byte limits, malformed selections, retry/denial/private cleanup and responsive navigation; account activity keyset pagination, refresh snapshots, metadata, malformed/nonadvancing cursors, denial/private cleanup and keyboard/mobile; PR state/merged/draft display, retained/deleted source labels, native reviews/flags, empty intermediate pages, plain-text/unsafe-link boundaries, typed deep links/history/reload, denial/expiry/logout cleanup and desktop/mobile/keyboard; OAuth options/redirect/errors/permissions/token fallback/callback handling plus optional public visibility, empty content, exact uint64 sizes and numeric refs, plus account-session pagination/metadata/privacy, confirmation/cancel, individual/current/bulk revocation, query cleanup/errors/401, dark/light/mobile/keyboard, plus organization/team typed routes, pagination/empty intermediate pages, plain metadata, native unit permissions, denied/private-cache lifecycle, reload/history, opaque team IDs and desktop/mobile, plus existing auth/create/list and branches/pagination/stale-head reselection, slash and hex refs, pinned path/history/reload, plain-text XSS boundaries, preview limits, commits, issue filtering/scopes, empty/bounded errors, private-cache denial/expiry/logout, keyboard and mobile. |
| `docker compose up -d --build` | Go/React image builds; PostgreSQL/forge/Golf start; `/readyz` returns both dependencies ready | Local loopback development profile, not production/HA/Kubernetes. |
| `make helm-check` | Strict Helm lint; bundled/external/OAuth/ingress/multi-Golf render profiles; 21 invalid configurations rejected; byte-identical Compose database initializer checked | No cluster mutation or credential values; schema/render checks are separate from live qualification. |
| `python3 scripts/kubernetes-smoke.py --kubeconfig /tmp/golf-session-verification/kubeconfig --context k3d-golf-sessions --image golf-local:session-management --cli bin/golf` | Fresh two-replica Golf install, separate restricted DB roles, one forge writer, 3 bound PVCs; live unlabeled-pod denial; real private Git push/clone, exact source/CLI, anonymous/cross-user denial; direct shared session listing on each replica plus concurrent reads, foreign-ID denial and cross-replica revocation; all-workload replacement preserves session IDs/commit/claims; external-only release shares canonical services through explicit policies; uninstall retains all original PVCs, followed by deliberate namespace cleanup | k3d 5.9.0, k3s 1.35.5, arm64 single node/local-path storage, Helm 4.2.1, the then-pinned forge/PostgreSQL. CNI enforcement qualified here; ingress/TLS, SSH exposure, Kubernetes OAuth, external-PG-only/internal-forge profile, multi-node HA/fencing and other architectures remain unqualified. |
| Production-served browser check | Real authorized repository source resolves/pins a commit and renders, issue HTML stays plain text, dark/light/mobile work, sign-out removes private content; no runtime errors | Real local Compose backend and temporary supported-API fixture setup; test user/repository removed. Prior real sign-in/create evidence also retained. |
| `python3 scripts/smoke.py --restart --cli bin/golf` | Pass: real sessions/create/list/Git push, empty state, Unicode/space paths, slash refs, binary/LFS/symlink/gitlink/size boundaries, 1,001-entry refusal, exact 256 KiB acceptance, immutable source after a push, pagination, issues vs PRs, direct private denial, scope errors, CLI JSON, persistence/outage, revocation/logout | Real pinned native forge (at the time) and PostgreSQL 18.4; the ordinary local-stack restart/CLI smoke also passes for the repository-creation backend, with temporary test users/repos removed. No live Cloudflare resources. |
| `python3 scripts/oauth-smoke.py --refresh` | Pass: actual Golf button/forge password+consent, S256/scopes, private immutable source/issues/create, cross-user isolation, denial/state/binding/replay, two concurrent refresh cycles, user-grant revocation→401 with other user still authorized, deleted client→503, logout and full cleanup | Real native forge at the time, access TTL 15 seconds and refresh-reuse invalidation explicitly checked; original 3600-second/false settings and disabled Golf OAuth restored, no `.env` or volume edits. All six organization/team reads with explicit organization consent and cross-user denial pass, and organization scope remains usable through both concurrent refresh cycles; actual OAuth session listing/current/bulk revocation and saved-cookie rejection pass using a separate disposable account; original consent-revocation evidence remains independent. Default OAuth smoke also passes. The added legacy-equivalent three-scope trial passes before/after rotating refresh; a fresh four-scope request reuses the old grant and remains denied. Actual user grant revocation followed by new consent enables organization reads. This is a real narrower-grant test, not a full old-release binary upgrade. The complete regression passes again on the final keyring image using the unchanged legacy-key configuration; it does not qualify live OAuth exchange across key activation. |
| Targeted keyring/OAuth/audit/session `go test -race` with isolated PostgreSQL | Pass: >500-row legacy validation, key/domain/material binding, activation-event rollback, mixed/expired credential families, zero-use removal, fresh JSON-only setup, busy-row partial/resume, concurrent OAuth refresh, callback expiry rechecked with database time after held-row waits without consuming expired verifiers, and metadata/history guards | Real PostgreSQL; OAuth HTTP fixtures. The full `go test -race ./... -count=1 -timeout 120s` also passed on the keyring increment (server 24.986s, database 22.350s, server-command package 2.301s, CLI 1.896s); the latest recovery regression is recorded above. |
| `python3 scripts/keyring-smoke.py --legacy-server .tmp/key-verification/pre-key-server` | Old f79bf6f PAT sessions and pending PKCE migrate with byte-identical ciphertext, IDs, bindings, expiry and kinds; three actual PAT cookies preserve session metadata through drained activation/new-key login, one-row partial rotation, restart/resume and legacy removal; pending PKCE verifier rotates and consumes on denied callback; stale legacy writes and same-label/different-material startup fail without deleting rows | Old server built from exact `f79bf6f6645dbe5eaf01b4d613a2d277e7eb212e`, then new operator/server; isolated PostgreSQL 18.4 and ordinary local forge user. Full cleanup, normal Golf configuration unchanged. No actual OAuth exchange/refresh across activation from this harness. |
| `python3 scripts/audit-smoke.py --upgrade --restart --cli bin/golf` | Pre-audit PAT sessions retain exact IDs/kinds/expiry with initially empty history; all five action classes, read:user-only authorization, foreign/future/malformed cursors, stable captured traversal after later login/logout, same/cross-account replacement, exact bulk counts including zero, no credential metadata, CLI snapshot continuation/ephemeral cleanup, restart persistence, production browser pagination/details/deep links/dark/light/mobile/revocation cleanup and logout after provider-account deletion pass | Actual old `70b3f02` service replaced with already-built audit-aware image; single-service upgrade only, not mixed-version rolling continuity. Disposable provider users and active sessions removed; immutable Golf identities/history intentionally retained. Legacy OAuth migration preservation is separately covered by real PostgreSQL tests. |
| `python3 scripts/sessions-smoke.py` | Actual PAT pagination/private metadata, malformed/foreign ID denial, individual/current/bulk/concurrent revocation, saved-cookie replay and revoked-provider rejection; production-served confirmation/cancel/private cleanup and dark desktop/light mobile controls pass | Disposable ordinary users and scoped credentials; provider credentials remain separate. Screenshots under ignored `.tmp/session-smoke/`. |
| Native role characterization (script removed 2026-10-16) | Isolated pinned provider role/API/Git assertions pass; per-unit/read-write/additive grant changes, team attachment denials, strict-viewer/maintainer and recoverable-owner limitations recorded | Supported native interfaces only, ordinary role actors; disposable provider volumes removed. This does not implement Golf role policy. |
| Source secret scan | Gitleaks passes on final tracked and new source, including both native creation harnesses | Source scanning does not establish backup provenance or validate retained encrypted archives. |
| Recovery operator unit/real PostgreSQL race tests | Pass: all mixed/expired PAT/OAuth sessions and pending PKCE records removed with exact recovery metadata; identities/account history/crypto history/key registry/policy preserved; SQL append-only guards, forced insert/deferred-commit rollback, lock/deadline handling and sanitized argument/output checks | Dedicated PostgreSQL 18.4; no provider revocation reconciliation or stale-writer fence. Operator actor is the DB role, not a human account. |
| `python3 scripts/recovery-test.py` | Pass: canonical archive paths/links/parents, duplicate/type/ownership/mode rejection, external storage/key references, private identity/no-overwrite boundaries, literal-dollar Compose serialization, kernel output-size enforcement and ciphertext-overhead arithmetic | Offline validation plus Compose parsing; no installation data mutation or actual 8 GiB/load qualification. |
| API credential real-PG and browser regression | **Pass:** targeted real-PG race suite3.317s, full real-PG race suite (server38.676s/database19.931s), 86 browser checks; cookie/bearer shared OAuth refresh across replicas, immutable source binding, expiry/revocation/post-wait authority, quota concurrency, transactional journal rollback, schema004→005 preservation and recovery invalidation | Fixtures exercise actual PostgreSQL and controlled provider transport; production UI/native proof separately recorded. No long-lived service identities or configurable scopes. |
| Final API credential CLI/MCP native and raw-wire proof | **Pass:** both token modes, all19 tools/both revisions, stdin/environment CLI, no bearer session/activity additions, private source/JSON/paging, cancellation/SIGTERM, key/source/native permission revocation; both modes' raw framing/cancellation regression | Isolated canonical core image `sha256:4dbc64b946d0de111cf8abf1c923c197dc5ebc46e0c207b39452883846af8632`; `scripts/mcp-smoke/run.py --api-credentials` with explicit disposable endpoints/container; final CLI build. No named harness or full protocol-conformance claim. |
| Schema005 encrypted native recovery | **Pass:** all previous recovery boundaries plus byte-equivalent API credential metadata/events; old revoked/unrevoked bearer keys denied after restored-session invalidation and fresh same-user sign-in; newly issued key survives whole-stack restart | `python3 scripts/recovery-smoke.py --image golf-local:api-credentials`, exact Docker image ID `sha256:4dbc64b946d0de111cf8abf1c923c197dc5ebc46e0c207b39452883846af8632`, server binary SHA256 `651bf1d77e92c5b87201d3bee642df51830551d82eaf1f08c0ba38275da0e3a6`; disposable resources removed. Fixture remains below1MiB, so minimum-cap negative case explicitly skips; no large-scale/RPO/RTO claim. Historical schema004 proof remains below. |
| `python3 scripts/recovery-smoke.py --image golf-golf:latest` | **Pass, exit 0:** encrypted native dump/fresh restore; live-writer/no-overwrite and wrong-identity/truncated-ciphertext/manifest-checksum/fresh-target rejection; stopped-application quarantine; exact session/PKCE invalidation and preserved identity/account/crypto history and key metadata after partial rotation; schema 202610020004 serialized creation-operation/event rows byte-equivalent before/after restore, original own lookup/same-key result replay and foreign-key 404 without journal change; private Git refs/signatures, hydrated LFS, attachments/protections/SSH/signing identity; fresh login/cross-user denial; new signed writes/force-push denial; simultaneous whole-stack restart persistence; complete disposable-resource cleanup | Latest schema 202610020004 run on 2026-10-02, local Docker image ID `sha256:2cb73e4238034ec564cc9e8696a30b850e1ab7d0f265df05fa87a7005b02f9ad` (not registry manifest digest). No external OAuth exchange or outbound automation in the fixture. Payload below 1 MiB explicitly reported **SKIP** for the minimum-cap negative case; output-cap/headroom arithmetic have separate offline evidence. No actual 8 GiB/capacity/load or RPO/RTO qualification. |
| `python3 scripts/repository-creation-smoke.py --restart --cli bin/golf --browser` | Pass: real create/rejection/scope gates, concurrent same-key replay and changed-input denial, own/foreign operation privacy, current-access/deleted/replaced repository binding, CLI output/logout, restart; production browser real response loss and reload/status-only recovery, dark/mobile/keyboard and revoked-session cleanup | Actual pinned native forge and current Golf. Fixtures are supported-API ordinary users/repos and are purged; immutable own-account operation history remains. Browser lost acknowledgment is distinct from the provider-loss proof below. |
| `python3 scripts/repository-creation-fault-smoke.py --server-binary bin/golf-server --database-url-file .tmp/creation-verification/database-url` | Pass: actual forge HTTP 201 discarded before Golf receives it; exactly one observed provider POST across replay/lookup and private-backend restart; durable UNKNOWN without name-based adoption; foreign and revoked-session denial; child/private/native fixture cleanup | Dedicated PostgreSQL 18.4, empty public schema and private DSN plus adjacent matching `container-name` marker are mandatory; see [preparation](REPOSITORY_CREATION_CONTRACT.md#runnable-evidence). Normal Golf database/configuration are unused. Supplied disposable PostgreSQL is retained for its operator to remove. No production fault flag or generic proxy shipped. |
| `python3 scripts/organizations-smoke.py --cli bin/golf` | Own-organization pagination, public nonmember denial, hidden-team denials, canonical cross-organization IDs, native unit permissions, member/repository pagination, missing scopes and subsequent membership revocation pass; all six CLI commands, pagination/denied output/ephemeral session cleanup and production browser sign-in/deep links/reload/source links/private cleanup/dark/light/mobile pass | Actual Compose with disposable ordinary users and supported provider interfaces; native Owners team can also be visible, and private-team GET denial is `403`. Initial harness assumptions were corrected; repositories are removed before organization deletion. |
| `python3 scripts/commit-diff-smoke.py --cli bin/golf` | Native Git roots/changes/first-parent merges/empty/rename/delete/binary/symlink/gitlink cases, size/UTF-8/control rejection, exact SHA/scope/private access, immutability after actual main advance, CLI default JSON/temporary cleanup and production browser deep links/reload/source/history/literal HTML/dark/light 390px/mobile/revoked-access cleanup pass | Actual pinned native forge and disposable native Git/provider fixtures, fully cleaned. Internal/public origin difference uses exact escaped-path metadata binding, never URL following. Raw output is not independently verified patch completeness or merge evidence. |
| `python3 scripts/pulls-smoke.py --cli bin/golf` | Private-fork metadata with repository read scopes and no issue scope, private/anonymous denial, all three procedures denied without repository scope, actual open/closed/all filtering, explicit two-page list termination, retained list heads, hidden-pending empty review page with continuation, CLI wire output/denial/temporary-session cleanup, advanced source observation preserving the original reviewed commit, production browser navigation/review pagination/deep links/dark/light/mobile and collaborator-revocation cleanup, source advance H1→H2 while an existing visible review remains bound to H1, and deleted source branch fallback pass | Actual Compose/forge with ordinary disposable users; base PR read works while direct owner access to the private fork returns 404. Supported provider setup; fixture users/repos/sessions removed. Native review metadata is not Golf eligibility; no PR or review mutation/merge capability added. |
| Native protection characterization (script removed 2026-10-16) | Live write/merge characterization and isolated cleanup pass: explicit stale-head denial, direct Git/API denials, review/check conditions, concurrent merges, scheduled head changes, scoped merger allowlist and explicit Git base leases; stale-approval acceptance reproduced 3/3 in each of two successive isolated runs | **P0.8 stays open**: no merge expected-base field, stale-review window, untrusted status author and missing full source/policy/attempt fencing. Characterization exit0 does not mean the release gate passes. |
| `python3 scripts/git-atomic-verify-smoke.py` | Unchanged source ref omitted from atomic push wire updates; an already changed source rejects the entire explicit-lease atomic push; deterministic source advance after command receipt still permits publication of the old-source candidate | Local Git 2.39.5 only; disposable repositories/local pre-receive barrier/child processes/traces removed. The deterministic local Git race does not qualify the forge or a managed publisher. |
| Native publisher characterization (script removed 2026-10-16) | Two full live characterization runs pass: exact-C publication despite lost response, experimental uncertainty/replay identity checks, transport surviving issuer death, provider-accepted old-epoch writes, private-fork objects and explicit manual finalization200/parents/tree, source H2 race and deleted-source snapshot fallback | Disposable pinned PostgreSQL/forge on Docker Desktop; scoped publisher, supported API hook instrumentation and complete cleanup. **P0.8 remains open**: the SQLite admission experiment is not product enforcement or a target-side authority fence. |
| Website `check`, `build`, `check:links`, `deploy:check`, browser smoke | Pass: 22 static routes, links/fragments/metadata, local Workers routing/404/headers, env/canonical configuration, dark/light desktop/mobile, site search/catalog/explorers/navigation | 21 content pages plus 404, four guides, 38-entry integration catalog and glossary. Fixed port4325; no live provider deployment. |
| Docs `check`, `build`, `check:build`, Wrangler dry-run and browser/version drill | Pass: strict links, dark/light desktop/mobile navigation, disposable latest/next/older snapshots and selector, agent-readable version index, static deployment bundle and local Workers asset routes/404/headers; dependency audit zero findings | Only development docs are committed; disposable snapshots removed. Real release required before version publication. |

The real provider check established the native forge's minimum scope combination: code and PR/native-review browsing use `read:user,read:repository`; repository creation uses `write:user,write:repository`; issues additionally use `read:issue`. The forge at the time required both user/repository scopes on the user repository route. UI and setup instructions expose these distinctions; insufficient tokens correctly receive denied operations rather than silently receiving broader credentials.

The Git transport check uses `git push` and `git ls-remote` to compare the exact commit. The previous immediate branch-detail API 500 was reproduced while the forge's initial-push metadata remained `empty: true`; it became healthy after initialization completed. Golf now checks that metadata before branch enumeration, and the smoke uses a bounded initialization wait. Empty state is explicit; unrelated provider failures still fail visibly. This qualifies the new read operations, not every forge API or write policy.

The current contract increment adds deterministic Buf/SQLC drift checks; generated Go and TypeScript clients; typed Connect errors; pre-decode origin/session checks and compressed-input bounds; string IDs/uint64 sizes/optional false visibility; actual TanStack routes; and PostgreSQL tests for session scoping, transactional rollback and migration locking. Native pgx, organization policy and broader schema remain open.

Optional browser OAuth is configured through a registered confidential forge application; the normal local stack remains OAuth-unconfigured after disposable tests. The public options RPC and UI gate this flow on configuration and qualified dependencies. Login/source UI screenshots retain black/charcoal/light/mobile checks, and source browsing is now a deferred bundle.

Kubernetes qualification used an isolated cluster and private explicit kubeconfig; the user's `k3d-victor-kv` context and existing Compose/site services were unchanged. The denied-client probe initially failed because BusyBox's short-name lookup did not resolve the service; full Kubernetes DNS names fixed the harness. The successful run tested actual network denial, not port-forward behavior. All temporary credentials/users/repositories/releases/namespaces were removed; the dedicated cluster was removed afterward. Helm uninstall retention was asserted before destructive disposable-namespace cleanup.

The identity increment adds real PostgreSQL evidence for state/binding/expiry/replay, PAT replacement and immutable identity linkage, cross-replica refresh serialization, transient provider and identity lookup failures, invalid grants, oversized/redirecting responses, wrong identities, update rollback, absolute expiry during row-lock waits and provider exchanges, and old-schema PAT-preserving migration. A downgrade explicitly invalidates OAuth sessions. Provider rotation cannot be rolled back if the subsequent database commit fails; that path fails closed and may require sign-in.

The [session management increment](SESSION_MANAGEMENT.md) uses non-credential decimal IDs and identity-first transactional locks; existing PAT/OAuth cookies and absolute expiry survive its additive migration. Actual PAT and OAuth controls were exercised, including saved-cookie replay rejection and concurrent bulk revocation. This does not revoke provider credentials or cancel already-authorized in-flight requests.

The [own-account activity foundation](ACCOUNT_AUDIT_CONTRACT.md) records selected successful session changes in the same PostgreSQL transaction and retains non-credential history after session deletion. Ordered account locks protect keyset snapshots; ordinary update/delete/truncate guards do not prevent a database owner changing history. There is no fabricated pre-migration history, automatic-expiry/refresh audit, failed-attempt/provider-write coverage, retention/export facility, outbox or dispatcher. Drain all old writers before asserting an audited operating window; old binaries can still mutate sessions without events. The live upgrade and restart evidence is a single-service developer qualification. Full P1.3 remains open.

An isolated native role qualification (document removed with the earlier backend) proved per-unit Git/API grants and additive membership revocation. It also establishes that issue-read permits reporting/commenting, repository admin permits deletion, and member-count guards do not guarantee a recoverable owner. Golf roles are not implemented. Exact capability decisions and enforceable alternate-path restrictions remain gates before role administration.

The [organization browser](ORGANIZATION_BROWSER_CONTRACT.md) exposes current native memberships and provider-visible teams with typed routes and six generated read operations. It checks actual self-membership before/after provider reads, immutable caller identity, team-to-organization binding and local session validity after waits. Private views are removed on denial. It adds no second membership database or editable Golf roles; missing organization scope on an existing grant requires provider grant revocation followed by new explicit consent. Empty provider pages can still have a next page.

The [PR read increment](PULL_REQUEST_READ_CONTRACT.md) adds generated list/detail/native-review procedures, typed browser navigation and `pr list/view/reviews` CLI reads. List heads are always retained snapshots; detail refs can be provider observations or retained fallbacks after source deletion. Review states, reviewed commits and stale/dismissed/official flags remain native records. The real check demonstrates authorized private-fork metadata without blanket fork access and explicit pagination through a hidden pending-review page. The expanded run also verifies real open/closed/all filters, page termination and missing-repository-scope denial across all three procedures. After a supported source update, detail observes H2 while a visible review still reports H1; the test does not require a particular stale/dismissed flag or infer Golf eligibility. Repository identity/access and local session validity are rechecked after provider waits; those checks do not atomically reserve source or review state. No Golf approval eligibility or protected publication is inferred.

The protected-write investigation (document removed with the earlier backend) established a concrete remaining P0.8 gate. The native merge API has no caller expected-base predicate; immediate merges can race asynchronous stale-review dismissal, and native status contexts accept a code writer's assertions. Tested exclusive merge accounts and explicit Git base leases are foundations, not a complete exact-head/base/candidate/approval/fencing solution. The plan now links this evidence without relaxing its requirements. [Proposed ADR 0004](decisions/0004-protected-integration-enforcement.md) specifies the managed mutation boundary and fault qualification required before selection. The local Git atomic-ref proof passes: an unchanged source ref is omitted from wire update commands and cannot provide a verify-only source lock. The publisher fault qualification establishes supported exact-C push/manual bookkeeping and reproduces provider-accepted old-authority writes, private-fork source races and deleted-source snapshot fallback. Its uncertainty journal is experimental and does not enforce H/P/A/E/F. The mutation inventory identified current unmediated ports/ingress, credential paths, OAuth exceptions and provider/background operations, including reads that initiate checks. It is explicitly static; this does not qualify a managed publisher or close P0.8. All of these must be repeated on Forgejo.

## Initial decisions and limits

See [ADR 0001](decisions/0001-initial-forge-and-vertical-slice.md). The bootstrap REST/native-history exceptions are retired by [ADR 0002](decisions/0002-generated-api-and-typed-navigation.md): existing operations use generated Connect contracts, SQLC queries and TanStack Router. Wider service schemas, identity and tenant policy remain future work. AES-GCM protects the stored upstream credential using the configured key, with authenticated session binding. The keyring increment above adds a qualified bounded rotation workflow; live OAuth exchange across activation or restore, production/Kubernetes cutover, broader recovery topologies, external secret stores and FIPS remain unqualified. The bounded Docker backup/restore proof above restores key configuration/metadata and invalidates application credentials before reopening. Browser authentication now supports a configured forge authorization-code/S256-PKCE application, with explicit scoped consent, single-use PostgreSQL state/browser binding and encrypted rotating credentials; token bootstrap remains. See [ADR 0003](decisions/0003-forge-oauth-and-session-refresh.md). The separate operator-enrolled local-password increment above adds Golf-owned password sign-in; generic external OIDC, CLI managed authentication and complete account lifecycle remain open.

Local HTTP requires explicit loopback-only insecure-cookie configuration. Remote deployment requires HTTPS. Credentials stay server-side, cookies are HttpOnly/SameSite, all RPC requests require the exact configured Origin before decoding, and authenticated upstream redirects are refused. These controls and tests do not constitute a full security audit.

Compose and Helm use separate database roles, non-root runtimes and persistent PostgreSQL/forge volumes. The Kubernetes chart shares the byte-identical initialization script and supports operator-managed external dependencies. The bounded Docker recovery runbook, PostgreSQL safeguards and full native fresh-restore/whole-stack restart drill pass. Kubernetes recovery, production TLS/controller integration, version upgrades and node/storage fencing still need qualification. StatefulSet identity and RWO claims do not establish partition fencing; manually forced stateful replacement is not supported by this evidence. The forge's own Actions remains disabled; Golf executes its own bounded manually admitted catalog. Product CI does not authorize adding repository CI workflows.

## Task progress

| Plan task | State for this increment | Remaining work |
| --- | --- | --- |
| P0.1 | Initial layout, private repos, local checks and ledger implemented | Broader contract/version inventories grow with supported features. |
| P0.2 | Full dated [guide source register](TECHNOLOGY_GUIDE_REGISTER.md): 81 grouped prescriptions, all chapters and ADRs reviewed | Review/accept pending ADR dispositions and executable acceptance obligations; complete implementation conformance at the relevant milestones. |
| P0.8 | Shared forge decision, scoped reads and isolated per-unit/additive role and protected-write characterization recorded | Protected-write/conditional-merge proof, accepted exact role matrix and bypass enforcement, full API ownership/license/recovery qualification. |
| P0.3 / P1.1 | Versioned Protobuf/Connect Go/TypeScript clients, SQLC session queries and real DB migrations verified | Wider schemas, identity/tenancy, native pgx disposition and stable public compatibility policy. |
| P1.2 / P1.8 | Operator-enrolled Golf passwords/native-ID mapping and local-only admin metadata, scoped forge OAuth/PKCE, serialized encrypted refresh, token bootstrap, account sessions and live member-scoped organization/team reads verified | Self-service enrollment/password recovery, unified suspension, external OIDC/device flow, org/team roles, service/Git credentials, MFA/step-up/idle timeout and full account lifecycle. |
| P1.3 | Encrypted credentials with bounded operator keyring/rotation plus transactional own-account session activity, append-only SQL guards and API/UI/CLI snapshot reads, and operation-specific repository-creation reservation/evidence verified | Live OAuth across activation, production key/recovery procedures, broader successful/failed event coverage, retention/export/recovery, audited mixed-version upgrades, transactional outbox and jobs. |
| P1.4 | Durable creation and operation-status UI, account activity and real-data repository/source/history/commit-diff/issue-discussion/PR/native-review and organization/team UI, themes, typed URL navigation and private-cache lifecycle verified | Issue lifecycle/labels/boards, PR/review mutations, PR comparisons/inline threads and pipeline/task/deployment surfaces. |
| P1.5 | Compose and current core Helm installation implemented; isolated single-node Kubernetes qualification recorded above | Production TLS/controller/storage profiles, multi-node failover/fencing, backup/restore/upgrades and wider provider capability qualification. |
| P1.6 | Canonical Docker encrypted capture/validation/fresh quarantined restoration and independent all-session/PKCE invalidation plus restored local-account disable/version fencing implemented; real DB safeguards, offline tests and native operation/event-preserving restore, Git/LFS/attachment/identity/new-write/whole-stack restart drill pass | Authoritative provider revocation/tombstone/outbound-work reconciliation, external object storage/databases, Kubernetes, broader inventory/scale, image distribution, cross-version recovery and production RPO/RTO. Minimum-cap negative case explicitly skipped for the small native fixture; no 8 GiB or load qualification. |
| P2.1 / P2.2 | Durable own-account create/replay/lookup with counted native uncertainty and restored journal proof, plus list and read-only repository/source/commit-diff/issue/PR/native-review plus member-scoped organization/team UI/API through the scoped forge verified | Full Git/collaboration surface, organization authorization, issue lifecycle/labels/boards, PR mutations/comparisons/blame/review policy and protected workflows. |
| P4 / G2–G3 | Persisted inherited execution ceilings, manual exact-source job queue, fenced registered Docker worker, bounded shell catalog and optional immutable S3 source storage implemented; focused browser/real-PG checks pass | Full provider engines/coordinator, full checkout, triggers/forks, secrets/OIDC/artifacts/cache, trusted protected checks, runner groups/autoscaling and Kubernetes/Cloudflare execution. |
| G1 / G2 | Existing-account team/collaborator controls, organization creation policy and encrypted immutable installation connection profiles implemented | Invitations, delegated roles, complete identity/ownership recovery, database activation/cutover, broader backend consumers and production migration. |
| P0.9 / P5.5 | Narrow development JSON CLI reads verified; local stdio MCP discovery and 21 corresponding tools pass native-provider/SDK-client and separate raw-wire cancellation/framing qualification | Remote MCP/auth, actual coding-agent client interoperability, full CLI, ACP, managed authentication, policy/audit and execution lifecycle. |
| W1 / W2 / W4 | Separate static site implementations and local builds/dry-runs | Actual public origins, deployment, full feature guides and release operations. |
| W3 / W5 | Version policy, source ownership and public-content rules documented | First real product release, generated-contract import and continuing maintenance. |

## Next work and release gates

1. Advance identity/tenant foundations and resolve the guide register’s pending ADRs and forge protected-write/conditional-merge qualification before adding protected collaboration writes. The read-only browser/CLI extension does not close those gates. Use the recorded stale-approval, trusted-check-author and missing expected-base evidence to select and qualify a supported complete enforcement design; do not assume a queue lock or UI check resolves it. Never enforce a Golf restriction solely in the UI while other forge writes bypass it.
2. For the **Cloudflare competition track**, pull forward the smallest real Worker/Artifacts task flow: scoped forks, two overlapping supported agents, cancellation, exact-commit test evidence, comparison and conflict-aware integration. Follow the [requirements/evidence matrix](COMPETITION_READINESS.md); a static website or provider logo is not proof.
3. For the **portable track**, complete expanded CI recovery qualification, then extend the verified core Kubernetes packaging with qualified execution. Keep all required core behavior usable without Cloudflare or inference; optional backends can be selected individually.
4. Qualify Actions/GitLab engine subsets and five harness/auth combinations using actual positive/negative lifecycle checks. No adapter placeholders may report ready.
5. Add protected previews/CD, email/webhooks, observability and recovery as real independently verified behavior. Preserve exact source/output identity and deny unauthorized promotion.
6. Complete the two-track installation, migration, no-AI, security/retention, backup/restore, upgrade and load/cost gates before claiming v1, scale or superiority.

Provider credentials, domains, account entitlements, production resources and Kubernetes access are not assumed. Later work can proceed independently until a concrete provider proof needs those inputs; record unavailable capabilities accurately.


### Email sign-in follow-up (2026-10-02)

Schema008 adds unique operator-enrolled case-insensitive email aliases; no profile-email identity linking. The same login field supports email and username, charging the same canonical account bucket. Operator `set-email` version-fences/revokes local sessions and dependent delegations without changing the immutable native mapping or password. Email ownership verification/self-service enrollment/change/recovery are still unimplemented. Native API and actual browser checks and the encrypted restore drill pass on image `sha256:58601e2d499e044634dc2c9e738ea08956cd5bd58afe8e1466e2c13c19dd902d`; exact restored account comparisons preserve enrolled email aliases. The normal localhost8080 retained administrator also passed actual UI sign-in, HttpOnly/persistent cookie metadata, same-cookie backend restart and sign-out on that image. All server/CLI/telemetry race packages pass; two database startup tests hit timing deadlines during the concurrent whole-suite run, then the complete isolated database race package passed on rerun20.384s. No runtime startup policy was changed to accommodate tests.

The optional token disclosure layout was then adjusted with CSS only. The104-test browser suite passed before that change; the new desktop regression passes after it, confirming unchanged story/header/footer positions and document height when the form opens. Final image `sha256:cd00a85b6b796d84e7ea0cde785e153d6ac20e2ec96402a64f78814609e006aa` contains the cached identical server binary and updated browser assets; the native auth/recovery proof ran on the preceding586 image, not this index.


### Header, theme and product language (2026-10-02)

Golf now has one remembered dark/light toggle and a user-icon disclosure in the upper-right header, including the320px mobile layout. User settings and sign-out are inside that disclosure; settings exposes current profile/role plus existing session, API-credential and account-activity controls. It does not add profile/password/email editing APIs. The forge notice was removed, and normal screen/capability/error copy uses product terminology; system readiness diagnostics and operator contracts retain concrete dependency names. Marketing and Docusaurus share the same44px sun/moon toggle, accessible next-mode labels, two-mode cycling and saved preferences; the docs control remains in the mobile header.

Validation:108 browser tests pass36.8s, product typecheck/build, ordinary `go test ./...`, gofmt/vet and updated native-helper parse checks pass. Database-dependent tests are skipped in this ordinary Go run; the earlier real-PostgreSQL/auth/restore qualification remains separate. Actual deployed browser proof passes existing-admin email login, neutral Repositories capability, persisted theme after reload, keyboard dismissal/focus return for user settings, menu-only logout, and 320px upper-right controls/reflow. Marketing/docs build checks and actual desktop/mobile theme/reload checks pass. The running product image is `sha256:c095803efda4d5df68b5e8c733b7fbce8ede76db5bab6896fac385433dbd38ba`. This increment changes UI and public message text; no migration, API schema or permission model changed.


### Git access and transport qualification (2026-10-02)

Golf now lists/adds/removes own-account SSH keys through typed `GitAccessService` RPCs and **Your account → User settings → SSH keys**. Public-key parsing uses the installed SSH library; private keys, options, multiple keys, certificates, DSA and undersized RSA are rejected. Provider responses bind to the caller's immutable native user ID and canonical SHA256 fingerprint. Delete checks ownership before native removal/absence checks. Read-only Golf API credentials cannot manage keys, native read-user scope cannot add keys, and Origin/no-store boundaries remain enforced. No database migration or new dependency was introduced.

The new `make qualify-git` combines the existing real Git/API/CLI smoke with disposable SSH/API/browser fixtures. It passes private HTTP clone/fetch, private SSH clone/fetch/push, slash branches, amended history and successful/stale-rejected force-with-lease, annotated tags, locally merged history transport, branch/tag deletion, cross-user read/deletion denial and new-connection denial after key removal. The actual served browser passes settings navigation, public/private-key validation, add/reload,320px layout, cancel and confirmed removal. The mobile screenshot was inspected. The 111-test browser suite passes 37.3s, including new unknown-write/no-auto-retry, exact-ID/confirmation and permission-cleanup tests; ordinary Go tests, typecheck/build, format/vet/generated checks and Helm bundled/external/25 negative profiles pass. Ordinary Go runs still skip database-dependent tests without an isolated DSN; native qualification uses the real local PostgreSQL-backed stack.

Qualification also exposed internal-host HTTP clone URLs: bundled Compose/Helm now pin native `PUBLIC_URL_DETECTION=never` with the configured public `ROOT_URL`. The smoke consumes the exact Golf-returned clone URLs. This Helm configuration has offline render qualification; it is not a new live Kubernetes qualification.

A separate disposable native shape proof observed `read_only:true` on user-key POST returning a stored key with `read_only:false` on pinned 1.27.3. Golf deliberately exposes no read-only account-key option. Account keys are broad persistent native credentials, not Golf-session-bound or repository-scoped agent credentials. They survive Golf logout/password reset/local-only disable; already accepted SSH connections are not killed by key removal. Unified suspension, step-up, durable key mutation/audit, scoped/expiring agent credentials and managed Git ingress remain open. PR mutations, protected merge enforcement, CI/agent execution and Cloudflare execution are not implemented by this increment. See the [Git access contract](GIT_ACCESS_CONTRACT.md).

The final running UI image index is `sha256:d1d6cf49d90877a233629814be96daf103fda5245e5a79a9045915f3f6a8c800`; its server binary is the same qualified SSH-service binary. The final breadcrumb correction passes the three targeted SSH browser tests; no further account authority or API change accompanied it.


### Historical account settings pages and policy requirements (2026-10-02)

User settings now navigates to `/account/settings` rather than a modal. A shared personal-settings sidebar links profile, full-page sessions, SSH keys, API credentials and activity, with directly addressable URLs and responsive navigation. Profile/role data is view-only; self-service email/password/profile edits, MFA, connected-provider management and notification preferences remain planned. Sessions use `/account/sessions`; only revoke confirmations are modal. Navigation cancels private reads and pending mutation requests; successful callbacks cannot populate an unmounted/different-account view. Key/session confirmations retain Escape, cancel, keyboard focus return and current-session logout behavior. Existing native helpers were updated to the route-based flow.

Official GitHub research is incorporated in implementation-plan section 6.4: all/selected/disabled repository execution, immutable selection and inherited ceilings; separate actor/event trigger permissions; qualified workflow dependencies, fork trust and scoped tokens; runner groups; scoped secrets/OIDC; rulesets; production environments; delegated administration; and model/harness/MCP/tool/network controls. G1–G6 define delivery dependencies and negative acceptance cases on both tracks. These are requirements, not implemented organization/repository controls or CI execution. Do not expose working-looking settings until supported persistence and enforcement exist.

Validation: the final 111-browser-test suite passes37.5s; ordinary Go tests, format/vet/generated checks and offline Helm profiles pass. The rebuilt local image is `sha256:531747780903c8f98b4a2b9978e108bf70036493cf205bbd076b2b4e0710c5d1`. Real PostgreSQL/native session API and production-served settings/session browser checks pass on this image, including dark/light/mobile, cancellation, confirmations, revocation and private-data cleanup. The preceding account-settings image `sha256:99d87494a775b4c04ff739d2c2abdd297d7647ea93dd5d6705b05dd1a53983e9` also passed the real SSH Git/API/browser qualification; the final rebuild changes only the session request's local abort-controller reference and retains the same server binary. No new CI workflow, live Cloudflare deployment or organization/repository policy engine is introduced.


### Historical explicit editors and shared compact tables (2026-10-02)

SSH keys, API credentials, full-page sessions and `/audit` now use one typed `DataTable` with native TanStack Table 9.2.4, shared feature/default-column configuration, exact row IDs, compact global CSS, accessible sorting and loaded-row search. Server pagination remains authoritative; filtering/sorting does not claim to cover unloaded inventory/history. Audit retains its immutable snapshot/cursor checks and all redacted event metadata. Empty inventories use the same table. Mobile tables scroll within their own region; labels, headers and readable fonts remain intact.

SSH/API creation editors open from explicit New actions; Cancel discards drafts and returns focus. One-time API secrets and unknown-write inspection retain their existing security behavior. Issue comments likewise open from Add a comment, and closing clears unsubmitted text while server mutation outcomes remain inspectable. Current browser forms use TanStack Form 1.33.5; credentials/drafts still stay out of persistent browser storage and existing validation/latches/immutable intents remain enforced. Repository/issue creation dialogs still require a separate page migration; this increment does not claim all creation dialogs are gone. Profile edits and organization/repository CI policy remain unimplemented.

Validation: all117browser fixtures pass33.0s, including table search/sort, exact IDs, fixed history, explicit editor cancellation, permission/expiry cleanup and mobile bounds. Product production build/typecheck and diff checks pass. Native SSH Git/API/browser qualification and real PostgreSQL-backed session lifecycle/browser qualification pass on the preceding shared-table image `sha256:705cfefe2220925ac3b0b19dc2feaf537d95b44ccac885c4af44cd4290c09d41`; the session browser helper's old card-text assertion was updated to the exact table session ID. Final running UI image `sha256:011744dfa94cfabbfd978218afdc26585df4906448829854b14f2f12440a485e` includes the subsequently completed audit table, shared empty credential inventory/default string sorting and compact padding/details-summary CSS, with the same server binary. The117-fixture suite covers the completed table behavior; the final CSS-only density refinement is additionally checked by the served administrator browser proof. Retained-administrator email sign-in, actual account tables, loaded audit search/sort, explicit editor/draft cancellation, desktop/mobile bounds and sign-out pass on that final image; representative served screenshots were inspected. No new database schema or CI workflow is added.


### Historical repository settings, administration coverage and public-source qualification (2026-10-02)

`RepositorySettingsService` adds browser-session-only read/edit of description, existing default branch and native issues/wiki/pull-request feature flags. Full-page `/repositories/:owner/:name/settings` shows current values before an explicit Edit action using TanStack Form and global styling. The backend binds immutable repository/owner IDs, validates canonical IDs/ref/text, checks native administration and local authority before dispatch, rejects archived/mirrored repositories, sends only supplied fields and verifies the receipt plus an independent readback. Read-only collaborators cannot edit; private outsiders cannot read. Unknown outcomes freeze further saves until refresh/inspection; no automatic retry is issued. Revisions detect stale forms before dispatch, **not atomic native compare-and-swap**. Concurrent native writes, durable mutation journaling and broader write audit remain open; this endpoint does not enforce CI, rulesets, visibility, production deployment or agent policy. See [contract](REPOSITORY_SETTINGS_CONTRACT.md).

Personal, organization, repository and explicitly enrolled instance-admin settings inventories use the shared searchable/sortable table and label ready/read-only/planned controls. `/organizations/:organization/settings` verifies current membership before showing coverage; it grants no administrative mutation. `/admin/settings` is visible only to an explicitly enrolled Golf instance administrator and contains no editable global configuration. Native organization owner/team/repository grants remain distinct from Golf instance administration. Organization invitations, team/role editors, delegated Golf permission levels, global browser configuration and inherited execution policy remain **unimplemented**. Profile remains view-only. These inventories do not complete G1/G2 or the complete settings requirements.

Validation: all123 browser fixtures pass33.1s, including explicit editor cancellation, exact IDs/changed-only fields, duplicate dispatch suppression, late receipt/navigation, unknown outcomes, private-data denial, instance gating, membership checks and mobile bounds. Ordinary `go test ./...`, format/vet/generated checks and production build pass; ordinary runs skip database-dependent tests without a DSN. A separate disposable real-PostgreSQL `TestRepositorySettings` run passes the controlled-provider lost-response/no-retry and pre-dispatch revocation cases. Native Compose RPC qualification passes with disposable owner/read-only collaborator/outsider fixtures, actual PATCH/readback, empty/false values, slash branch, stale IDs/revisions, Origin/bearer/logout denials and fixture cleanup. Final local image `sha256:3660a281f1e4dadeab8835f795f882ed88d0fc27502008a7f6a215e44c6210b2` includes a final neutral organization header change and the same server binary; qualification was repeated on that image. Actual served retained-administrator email sign-in, instance menu/coverage, personal inventory,320px bounds and logout pass. No retained account credentials changed.

Two independent [public-source qualifications](PUBLIC_REPOSITORY_QUALIFICATION.md) pass against prior image `sha256:011744dfa94cfabbfd978218afdc26585df4906448829854b14f2f12440a485e`: official pinned GitHub Actions example391 reachable commits/six workflow files and GitLab Node example36 commits/one pipeline file. Exact selected refs/SHA/blob bytes, full paginated Golf history, CLI source reads, private destination clone-back, outsider denial, disabled pipeline capability and cleanup pass. Public source was fetched without checkout/dependency installation/execution. This is repeatable source transfer via supported creation and native Git, **not a product direct-import feature, complete provider migration or CI execution**. `make qualify-public-repositories` resolves the current local image; recorded runs retain exact provenance.

GitLab's documented Custom executor maintenance status prompted a conditional executor/engine ADR gate in plan7.4/P0.5. The first manual single-job execution subset, importer SSRF/fidelity/durable-outcome requirements and remaining runner/coordinator/isolation tests are documented in the qualification report. Full GitHub/GitLab CI compatibility, org/global policy, integrated coding harnesses and Cloudflare/CD remain open. No repository CI workflow or live Cloudflare deployment is introduced.


### Historical ordinary team membership administration and instance account inventory (2026-10-02)

`OrganizationAdminService` adds GetTeamAdministration, ResolveTeamMember, AddTeamMember and RemoveTeamMember through the browser-session/Origin boundary. Current organization owners can manage existing native accounts on ordinary teams; native site/Golf instance administration supplies no override. Owner teams, including owner-valued unit grants, are locked. Requests bind canonical organization/team/user IDs and an observed team-grant revision; target identity, current ownership/membership and local session authority are rechecked before one native PUT/DELETE. A separate membership GET verifies the exact post-state. Changed grants, cross-organization teams, replaced user identity, duplicate membership state and pre-dispatch revocation fail closed. External native edits can race these address-based operations; revisions are preflight observations, not atomic native CAS or complete effective-access snapshots. No durable provider-write journal/audit, ownership recovery, invitations, team creation/grant editing or delegated Golf roles are introduced. See [contract](ORGANIZATION_ADMIN_CONTRACT.md).

The full-page `/organizations/:organization/teams/:teamId/settings` is linked from team detail. The shared table searches/sorts loaded members, with explicit Add member, existing-user resolve and grant review before adding. Removal uses a short confirmation with Escape/cancel/focus return. Unknown writes require refresh/inspection without automatic retry; stale previews never silently adopt changed grants. Cancellation, departed routes, changed accounts, revalidation and permission denial cannot revive private rows or mutation receipts. Both themes and mobile layouts use existing global CSS/TanStack Form/Table; no new dependency is added.

`InstanceAdminService.ListLocalAccounts` supplies actual redacted, paged database inventory on `/admin/settings`. Only a current operator-enrolled local password session with the Golf administrator role can read it; PAT/OAuth/native-site-admin/delegated credentials cannot acquire that authority. Native identity, local credential version/expiry/disable/session state are checked before and after the read and before successful encoding. SQL projects only enrolled names/email, immutable IDs, role, state/version and actual timestamps, scoped to the configured forge. Password hashes, encrypted credentials, key labels/bindings and session authenticators are absent. The UI includes loaded-account/email search and sorting, disabled account states and honest operator-only lifecycle text. It lists local Golf accounts, not every native/OAuth user. See [contract](INSTANCE_ADMIN_CONTRACT.md).

Account suspension/reactivation/reset/role changes and global configuration remain unimplemented in the browser. Existing operator enable requires a fresh password and freshly verified mapped credential after recovery; a bare browser toggle would bypass that contract. Future lifecycle mutation needs actor-bound audit, throttled password step-up with post-wait rechecks, target version CAS, serialized last-enabled-admin protections and an explicit break-glass policy. Local suspension also does not revoke independent native Git credentials. CI/agent eligibility, runner pools and organization/instance policy ceilings are still planned. These bounded slices advance P1.2/P1.4/P1.8 and G1, without completing their broader gates.

Validation: all137 browser fixtures pass36.7s. Ordinary Go tests, format/vet/generated checks and production build pass; ordinary tests skip DB fixtures without a DSN. Isolated real-PostgreSQL administration race tests pass9.146s, covering secret-free configured-forge inventory/pagination, native/PAT/OAuth/nonadmin/delegated denial and disable/reset/logout/expiry/provider-revocation/identity changes during waits; organization tests cover counted applied-before-lost-response/no-retry and session revocation. Final added cross-organization and owner-revocation cases pass a separate isolated organization race run2.033s. Both disposable PostgreSQL fixtures were removed.

Final local image `sha256:192439b7edeb1943b0ad3a0e7868e0a971808542a6d272528c6364af4d95fb19` passes native Compose API and actual served browser organization qualification: owner-only/member/outsider/owner-team/cross-org denials, exact identity/revision, add/remove/readback, private assigned-repository access gain and subsequent loss, stale grants, Origin/bearer/logout denial, explicit resolve/review/add/reload, cancelled draft/removal and confirmed removal at320px. The initial harness tried deleting a nonempty organization and encountered500; exact leftover fixtures were cleaned with supported repo-first deletion. The corrected harness attempts all cleanup and prints overall success only after every disposable resource is removed. `make qualify-organization-admin` reruns this proof.

Actual retained-administrator email login and served instance account/role inventory, SQL-projected secret exclusion, email search, mobile bounds and logout pass on the same final image. A disposable native site administrator PAT session is separately denied instance inventory, as are wrong Origin and its delegated API credential; that fixture is purged. Retained accounts/passwords and current database schema were not changed. No repository CI workflows, live Kubernetes/Cloudflare deployment, pipeline execution or integrated coding harness is introduced.


Cloudflare-native repository performance/settings follow-up (2026-10-09): shared native General edits for description, website and topics now have additive D1 migration0006, administrator/identity/revision checks and atomic version fences. Native capability gates prevent unsupported settings, live-stream, browser-write, review-assignment/inline/private-draft, merge and discussion-resource controls from mounting and issuing unsupported RPCs. This exposes remaining native feature gaps; it does not implement or claim full forge parity. Portable editors remain available. Eight concurrent allowlisted reads retain exclusive mutation/revocation admission; immutable Git-object LRU/deduplication remains scoped and bounded, with current grants/provider identity checked per request. Directory blob-size reads are batched, and proven head changes are projected in the folder response. Generic hashed UI assets receive private browser caching; private data/HTML keep `no-store`. Live stream refusals now use the actual Connect framing contract. A real workerd RPC target qualifies delegated provider methods alongside immutable reads.

The old disposable demo supervisor exited before completing its cleanup. Provider-cleaned previews were purged and all three evidence jobs were terminal at inspection. A recovery stop command with owned-resource preflight and an independent four-hour local systemd timer now covers the current validation window; teardown must still be verified after it executes. Full cold-read, large-repository, many-tenant throughput and recovery acceptance remain open.

Live validation for this follow-up: 94 focused native/capability tests, four cleanup supervisor/recovery tests, 11 native setup tests, full `make cloudflare-check`, portable/native builds and actual workerd UI/evidence/RPC checks passed. The uploaded control bundle matched the local bundle. Human General edits and topic clearing passed and were restored. The three-entry demo folder showed head-change projections with no directory-row history RPCs; an in-app folder-to-file navigation took 251 ms and one `GetContents` request. Sequential warmed 46-byte file reads measured about 190 ms versus 260–290 ms before, and three simultaneous reads finished in about 280 ms versus 660 ms before. These are small-fixture observations, not production latency/throughput guarantees; cold file/metadata paths still take around one to several seconds. The real six-file PR diff rendered without unsupported review/merge RPCs. The 390-pixel file layout had no document overflow, loaded Archivo/Geist Mono and no alerts. Private measurements and deployment/source hashes are in `.tmp/cloudflare-ui-speed-validation.json`.

Cloudflare-native open-source browsing/image/focus follow-up (2026-10-09): real React and Vite repositories were imported through Artifacts and enrolled in the disposable alice workspace. These are main-branch copies with history depth 100, retaining upstream licenses; GitHub issues/PRs and complete branches/tags/history were not migrated. React contains 7,252 source files and Vite 2,866. The TypeScript provider import remained unavailable for over ten minutes and was cancelled; provider 404 and removal of its unactivated Golf row were verified.

The native authenticated image RPC now binds each image to the current repository reader, provider identity, immutable commit and document containing the reference. Bounded relative images and allowlisted HTTPS images use validated redirects without forwarding forge credentials. Shared SVG sanitization retains embedded raster sponsor logos while removing active content and external references. HTML picture theme/density variants use that RPC rather than exposing source URLs to the browser. Background access revalidation on a mounted source view retains its loaded tree/images; explicit access refresh still suspends private content and denied access removes it. Mounted branch/tag observations no longer refetch on every focus; explicit refresh and source selection remain available.

Validation: full `make cloudflare-check`, portable/native production builds, the focused Go image boundary test and actual workerd RPC delegation check passed. The uploaded control bundle matched the local SHA256. Live T3 validation decoded all nine Vite README images in the dark theme and its alternate light-theme logo; the sponsor SVG retained 21 embedded raster images, with no active elements or external references. A deliberately held tab-focus access response retained the exact tree and logo DOM nodes visibly, with zero additional source/image RPCs. The README made no direct browser requests to the Vite/sponsor/badge hosts. Browser regression fixtures were updated but not run through standalone Playwright; live T3 checks provide the browser evidence. Native folders exceeding 100 direct entries and cold path-history performance remain open. No new execution jobs were started; the demo retains its 17:41:18 UTC cleanup deadline. Private import and live validation evidence is under `.tmp/cloudflare-forge/golf-native-20261009-3322fac6/`.

Additional public-repository qualification (2026-10-09): Rancher, Docker CLI, uv and Moby/Docker Engine were imported at default-branch history depth 20. OpenCode and Kubernetes were added through verified bare depth-one Git uploads after the import endpoint refused OpenCode above its observed 40 MB import limit and Kubernetes imports failed. These are actual upstream commit/tree snapshots, with licenses retained, not full mirrors. Exact provider identity and branch heads were read back before native enrollment; all temporary Git tokens were revoked and local upload snapshots removed. The six new repository roots and READMEs rendered in the signed-in T3 browser, and real Kubernetes/OpenCode source files were read through Golf's immutable RPC. Unsupported/oversized README images remain explicit placeholders.

Additive native D1 migration0007 preserves each imported default branch without assuming main or trusting the provider import's default-branch metadata. Metadata, empty-state detection, source resolution, default commit history and settings/revision use the enrolled branch. Optional folder change projections now omit unproven history when a shallow parent object is absent, while preserving current source and explicit history/diff completeness checks. Regression cases cover master/dev, stale settings revisions and shallow source without invented entry history. Full `make cloudflare-check` (101 native tests plus its other suites), the 68-test core suite, actual workerd RPC checks and final bundle/source/deployed-byte comparison passed. Cleanup preflight still passed with three existing terminal jobs and four existing previews; no new execution jobs were started and the 17:41:18 UTC timer remains active. Evidence: `.tmp/cloudflare-forge/golf-native-20261009-3322fac6/more-repos-validation.json`.

An assessment of the earlier backend's runner 5.0 release (2026-10-09, since removed) recorded the official release and exact tagged checkout/exec/library sources. Upstream execution reuse, broader checkout and a native Kubernetes executor deserve comparison with Golf's pinned act engine, under existing coordinator/authority contracts. No runner upgrade, new executor, scheduler enablement or CI compatibility claim was made.


## Cloudflare repository metadata and hardening (2026-10-09)

Native licenses/languages now come from canonical Artifacts Git at the exact displayed commit. Root license text yields conservative observed identifiers and actual immutable file links; unknown licenses retain their source paths. Durable per-repository SQLite jobs report indexing progress, resume through alarms, reuse immutable blob sizes, exclude binary/generated/vendor content, recheck current authority and obey an indexing allocation/deadline. The pinned Linguist filename map supports root attributes and stable ambiguous-suffix defaults; full content heuristics, nested attributes and the complete license corpus are not claimed. A classifier rollout refuses incompatible partial totals instead of republishing them under the current classifier.

Read-only operator priming independently verified the ten demo repository snapshots through supported Artifacts Git, revoked all short-lived read tokens and removed temporary clones. In the signed-in T3 browser, all eight imported public-repository overviews returned AVAILABLE languages/licenses and their exact enrolled commits: React, Vite, Rancher, Docker CLI, uv, Moby/Docker, OpenCode and Kubernetes. Vite displayed MIT, seventeen classified languages and2,848 indexed files; Kubernetes displayed Apache-2.0 and9 languages. Demo-only repositories with no classifiable source/license remain legitimate empty observations. Evidence: `.tmp/cloudflare-hardening-metadata-browser.json` and `.tmp/hardening-live-metadata-seed-v3.log`; these private runtime files are not committed product state.

Repository read coordination is sharded separately from the workspace mutation/identity owner. Private reads use current primary authority and a final workspace access receipt; cached immutable observations never confer permissions. Additive native D1 migrations0008/0009 supply replaceable digest-bound indexes and metadata allocation. Directory pagination supports100 entries per response from inventories bounded at10,000 immediate entries. Immutable first-parent history caches preserve the500-commit/shallow-history bounds. The actual workerd RPC check caught an observer-proxy mistake: RPC handles cannot delegate through remote `.apply`; direct named delegation now passes real commit/tree/blob/log calls and coalescing checks.

Private browser navigation retains materialized snapshot queries for ten minutes with64-query/8-MiB inactive retention bounds. Missing images no longer purge the entire repository, and disabled offscreen history placeholders do not displace materialized source. Logout, explicit repository denial and authentication loss still cancel and clear the appropriate private observations. RPC redirects are treated as expired authority without following login URLs; the shared login UI provides a reload/sign-in action and an Access-specific path when the installation reports Access. The expired live Access session was observed separately from ordinary network failures.

Release tooling binds identities, source/UI bytes, schema9, the exact live predecessor and original dispatch. Old generic UI assets are retained privately in R2 before upload, conditional writes/readback recover a lost acknowledgement under the same key, and uncertain Worker deployment is never blindly replayed. Old chunks returned200 without Golf D1 lookup stages; an unknown hash returned404. Existing tabs remain on their original immutable UI bytes. Guarded code rollback is implemented and source-tested; live canary/rollback and quarantined backup/restore remain unqualified. Owned cleanup recognizes the retained asset/index journal and refuses unrelated objects.

Hosted evidence reconciliation rechecks original queued jobs, current writers, enabled policy, attempts and expiry. A lost queue acknowledgement is retried with the same job/Workflow identity; exhausted, expired or revoked jobs cancel allocated running containers before becoming terminal. Failed cancellation acknowledgement retains retryable intent. Controlled lost-response/duplicate/expiry tests pass; this increment did not start additional hosted CI/AI jobs. General import retry/recovery, dead-letter inspection and fleet fairness remain open.

The human browser additionally followed Vite’s actual LICENSE link to its full-SHA blob and read the MIT text with no alerts. All nine README images decoded, including lazy images below the viewport. A controlled folder/root round trip reused source/image responses, but took1,609/1,005 ms and still issued optional shallow-history retries; that observation does not meet the UI readiness budget. A later visible-browser sample on the final shared UI measured warm folder/root readiness at159/118 ms with no repeated source/image reads on that pass. Optional history failures still retried when visibility enabled a newly mounted observer; a follow-up keeps already settled observations enabled from their first mount, preserving `retryOnMount: false`. That final retry correction needs a separate settled hosted sample. Evidence: `.tmp/cloudflare-hardening-final-navigation.json`.

The maintained authenticated browser benchmark passed48 exact-snapshot root/overview reads across eight repositories, concurrency4, one enrolled user/workspace, outer region EWR. First-pass p50/p95/p99:582/2,152/2,152 ms; subsequent-pass:258/322/360 ms, zero failures. Mixed compatible Worker/DO releases were observed during rollout. This meets the small warm-read budget but misses the cold1.5-second target; it is not arbitrary file/UI readiness, global latency, multi-tenant throughput or cost qualification. Evidence: `.tmp/cloudflare-hardening-benchmark.json`.

The generated [capability inventory](CLOUDFLARE_CAPABILITY_INVENTORY.md) covers all five shared protobuf files:296 procedures,44 bounded native adapters and252 missing adapters. An adapter is not full behavior or hosted acceptance. Portable identity/admin, general workflows, protected merge, advanced review, attachments, releases/wiki/packages, migration and recovery remain explicit native gaps; full local parity is unfinished.

Validation: complete `make cloudflare-check`, native/portable frontend typecheck/build, guarded release tests, actual workerd UI/session/spoof/disabled-user checks, actual RPC cache/delegation checks and D1/DO/Queues/Workflows/R2/revocation runtime checks pass. Focused portable browser-input/source-head Go tests pass; real PostgreSQL browser integration and standalone Playwright fixtures were not rerun in this increment. Regression cases cover metadata retries, shared-blob byte counts, current-access loss, binary classification, indexing allocation/deadline, classifier rollout and redirect/cache purging. The independent demo cleanup deadline remains17:41:18 UTC; a preflight confirms its three original jobs/four original previews and owned storage, without creating new execution allocations. Scheduling the timer does not prove its later teardown.

Final hosted readback at17:40 UTC returned AVAILABLE licenses/languages and the exact canonical commits for all eight imported repositories, with Worker/repository-object release agreement at `4247a74ec719bf8c3a44806987356f8cc7e35a19cf42a43f7b6319c7bd0f4d79` (Worker version `5ad6bf2a-2ebb-4702-84a0-2f7a6415f390`). Final native/portable builds, twelve focused metadata/auth/cache regressions, actual UI runtime and diff checks pass. The final cleanup preflight includes562 owned retained UI assets and the registered repository indexes; the independent17:41:18 UTC timer remains scheduled. Evidence: `.tmp/cloudflare-hardening-final-metadata.json` and `.tmp/hardening-retained-history-cleanup-check.log`.

The17:41:18 UTC stop timer actually fired but failed before effects because the user service manager could not find the NVM-installed CLI. Manual recovery then encountered the owned preview-to-control service binding. The cleaner now rejects missing CLI paths before provider effects, resumes the already-deleted domains/workflow after verifying absence, retires preview/outbound Workers before the control Worker, and deletes validated R2 objects with eight bounded workers. An independent recovery service with an explicit CLI/node PATH completed teardown by17:48 UTC. Its private journal reports all20 owned resource groups absent, including Workers, container applications/image, dispatch, queue/workflow/gateway, R2/D1/Artifacts, demo Access resources and management credential; its recovery credential was revoked in `finally`. The receipt is stopped, and the recovery service is inactive. The demo is no longer available. The five cleanup supervisor/recovery tests pass. Later partial-deletion recovery remains an operator reconciliation boundary; this correction is not a general automatic recovery guarantee.

## Hybrid runner and CFCR continuation (2026-10-12)

Newly admitted native PR tests use the versioned `golf.native.pr-test.v1` envelope; admission rejects unknown fields and versions, and the result repeats the exact source and contract after container cleanup. A bounded rollout path accepts older unversioned jobs. The PR report links an OCI publication digest to its repository Packages detail. This is the fixed approved Python test recipe, not a general native Actions/GitLab runner. Packages remains a repository-level image/report UI; no installation-wide Harbor catalog is present.

The [sanitized hosted size proof](compatibility/evidence/cfcr-managed-size-20261012.json) passed automatic five-report scans for the native CI image and real 7 MiB Docker and 128 MiB regctl images. Their created-to-finished samples were 35.783 and 37.756 seconds; the larger download stage took 16.968 seconds. CI and 7 MiB scans overlapped. CFCR refused promotion of the vulnerable CI digest. Real clients, live authority revocation, protected source previews and schema18 checks passed. The disposable run exited zero with all 25 expected resource categories absent and its stop timer cancelled. A prior passing proof had a transient dispatch absence readback; bounded retry and the repeat resolved it. Local `make cloudflare-check`, web native typecheck/build, CFCR 71 JavaScript plus three Python tests, and the focused registry checks passed. The collaborative browser could not connect to the local Packages fixture (`ERR_CONNECTION_REFUSED`), so visual interaction remains unqualified.

The broader P5/P6 objective remains open: native general workflow/pool execution, CI-imported scan evidence, a source build producing a runnable OCI image, policy and signature admission into a running container deployment, and retained production recovery/load/cost qualification. Single synthetic size samples do not support production latency or billing claims.

A new manual PR action can deploy a bounded static bundle carried in the exact
published OCI image config. CFCR verifies the config blob and current repository
read grant; Golf checks scan/trust policy, revision and every asset against the
passing canonical Git job, then copies those image bytes to the existing protected
static preview. Each reviewer request rechecks policy and current Git/repository
authority. The PR shows the image digest and expiry. A CFCR local registry test,
149 Golf core tests, the complete native Cloudflare check, native web build,
72 CFCR JavaScript plus three Python tests and publisher fixture tests pass. This
is a static image bundle, not container execution. The hosted qualification image
has deliberate vulnerabilities and cannot pass the default policy. The positive
hosted path below used an explicitly relaxed disposable severity threshold, then
restored the original threshold.

The next disposable hosted image-preview qualification required four attempts.
The first hit the harness's old 15-minute deadline during the
1.9 GiB scanner-image deployment; all 21 owned resource categories were absent
after cleanup. With the corrected 45-minute scanner window, native CI, protected
source preview, managed app, real OCI clients, managed size scans and vulnerable
CI policy denial passed. The image preview create then correctly returned 429
because the harness had allocated only two daily preview slots for its existing
static and Worker previews. That run cleaned all 23 owned categories. The quota
is now three for scanner rehearsals. A fresh retry failed before CI when the
Cloudflare Worker deployment could not find its managed container manifest while
applying Container settings; its 17 owned categories were absent after cleanup.
The fourth disposable run passed. Its CI image completed the managed five-report
scan. The default policy denied preview admission; an explicitly relaxed
disposable severity threshold allowed the static image bundle through the
protected reviewer path. The served bytes matched the tested Git asset. Restoring
the original threshold denied the already issued reviewer session and a new
grant. All 23 owned resource categories were absent after cleanup. The
[sanitized hosted receipt](compatibility/evidence/cfcr-image-preview-hosted-attempt-20261012.json)
records the failed attempts and this passing path. This proves a bounded static
OCI bundle flow under a permissive severity setting; it does not qualify
container execution, a general runner, signature/provenance approvals, or a
retained rollout. Browser interaction remains unqualified.

## Native Actions/GitLab shell profile (2026-10-12)

Cloudflare native now has an opt-in versioned single-job shell profile for PR
evidence. The operator pins either an Actions workflow under
`.github/workflows/` or `.gitlab-ci.yml`; source is compiled from the exact PR
head blob and checked again after the Container clone. Actions `run` steps keep
fresh shell boundaries. GitLab `before_script` and `script` share a shell, while
`after_script` is separate and does not mask the main result. The existing
authority and registry brokers, deadline, duplicate-admission and container
cleanup fences remain in force. Evidence reports include workflow identity and
hashes, without the compiled script body. See [profile and limitations](NATIVE_WORKFLOW_SHELL.md).

Local qualification: the complete `make cloudflare-check`, isolated worker and
parser tests, and the native entry esbuild bundle pass; the pinned YAML runtime
has no production dependency audit findings. The [sanitized hosted receipt](compatibility/evidence/native-workflow-shell-hosted-20261012.json)
records disposable Actions and GitLab Container runs. Both profiles passed a
job, reported an intentional exit-7 failure, rejected stale evidence after a
push, revoked reader access and removed all 11 owned resource categories. The
public reports omitted compiled script bodies. A separate Actions attempt hit
Cloudflare routing error 1042 during a read-only capability call; its resources
were removed and the read-only retry list was corrected before the passing run.
No production profile migration, user-managed pool, maintained Actions `uses`
execution, broad GitLab feature set, or runner UI is qualified.

## Native pinned Actions, stock GitLab Runner and socketless build slice (2026-10-12)

The customer-hosted PR adapter now accepts an opt-in `actions-act` workflow
profile for the existing pinned `act` v0.2.89 Linux v1 catalog. A host must
advertise the catalog, clone and verify the exact PR head, run the static engine
planner, then execute the pinned graph in the existing isolated inner Docker
daemon. A real local Docker test passed a dependent graph with matrix expansion
and a local composite action. The shell-only profile remains separate.

Workspace admins can enroll a stock GitLab Runner machine with a `glrt-` token.
The unchanged GitLab Runner 18.5.0 Docker executor registered directly with a
local Golf coordinator fixture, cloned the exact Git commit through its leased
job-token URL, executed the script, uploaded trace ranges and completed the
job. The coordinator also tests token rejection, terminal replay and sponsor,
lease and PR authority checks. This is the existing one-job GitLab shell
contract, not broad GitLab CI syntax or every Runner API feature.

An optional native Actions post-test build ran a pinned-base Dockerfile with
`COPY` and `RUN` on the selected rootless Docker BuildKit driver. The job had no
Docker socket, the build used `--network none`, and the 32 MiB OCI tar passed
blob and manifest verification. The result records the digest and exact source
commit. The tar is deleted with the attempt, so no CFCR publication or retained
artifact is claimed. Hosted customer-runner qualification, complete GitLab
artifact/cache/service/ID-token paths and the broad failure/load matrix remain
open. See [host configuration and tests](../cmd/golf-native-runner/README.md).

Fresh native databases now carry schema20. The guarded release tool applies
0019 and 0020 to existing D1 databases, checks the required columns and
indexes, and recovers after a lost additive migration acknowledgement. Local
release migration tests pass; a hosted schema20 deployment and rollback
rehearsal have not run.

## 2026-10-12: greenfield Forgejo default

The portable new-install profile now uses pinned Forgejo 15.0.9 in the default Compose file and Helm chart. Runtime configuration defaults to Forgejo and rejects any other `GOLF_FORGE_KIND`; it requires a stable installation UUID. The default workflow directories are `.forgejo/workflows` and `.github/workflows`; the earlier backend's directory is rejected. Public OAuth and webhook routes are `/auth/forgejo/callback` and `/hooks/forgejo/{connectionID}`. Readiness and operations report `forgejo`. CLI authentication now requires `GOLF_FORGE_TOKEN` and rejects the earlier token variable. The earlier backend's recovery and qualification scripts were then kept only as historical evidence, not new-install gates (removed 2026-10-16). Forgejo's rootless image uses the upstream `/var/lib/gitea` and `/etc/gitea` filesystem paths (Forgejo's upstream names). Some generated RPC/field names kept the earlier vocabulary until the 2026-10-16 rename.

New-install evidence: default Compose configuration and a rebuilt local stack; actual private login, repository, Git push, restart persistence and revocation smoke; fresh isolated Forgejo/PostgreSQL qualification with native PR/review, workflow precedence and reader revocation; Helm lint/render plus 25 invalid configuration cases; `make check` (including Go, generated-output, act, browser typecheck, Cloudflare, race and compatibility checks); web typecheck and 82 focused browser tests plus four code owner browser tests. The isolated qualification removes its owned containers. A live Forgejo Kubernetes rollout, optional OAuth browser flow, and Forgejo backup/restore drill remain open. Receipts from the earlier backend do not qualify those paths.

## 2026-10-14: one-command Docker Compose install

`./scripts/install.sh` (also `make install`) takes a fresh clone to a signed-in Golf administrator. It preflights Docker, Compose v2, BuildKit, amd64/arm64, Python 3, curl, free loopback ports, disk space and a same-named project running from another directory, each with a fix-it message. It runs `init-env.sh` only when `.env` is missing, starts the stack with `docker compose up -d --build`, waits on `/readyz` with progress, a timeout and log hints, and stops early if the Golf container exits. It then creates the Forgejo administrator through `forgejo admin user create --random-password`, issues a `write:user,write:repository,read:issue,read:organization` token through `forgejo admin user generate-access-token --raw` (flags checked against the pinned 15.0.9 image's `--help`), and enrolls the Golf account through `golf local-account create` from a temporary mode-0600 JSON that is deleted afterward. A generated Golf password is saved to a mode-0600 file under `.tmp/local-account/`; `--prompt-password` saves nothing. Re-running keeps `.env`, reuses an existing Forgejo user and skips an existing Golf account (`local-account inspect`). `--dry-run` prints the checks and plan; `--uninstall`/`make uninstall` only runs `docker compose down` and prints, but does not run, the destructive `down --volumes`. Forgejo reserves `admin`, so the offered default is `golf-admin`.

`init-forgejo-env.py` now records optional `COMPOSE_PROJECT_NAME`, `GOLF_HTTP_PORT`, `GOLF_FORGE_HTTP_PORT` and `GOLF_FORGE_SSH_PORT` when it first creates `.env`. `compose.yaml` (and the email, webhook and agent overlays) derive the default Golf origin and Forgejo `ROOT_URL` from those ports. Previously, a non-default port required setting `GOLF_FORGE_PUBLIC_URL`, which Golf also treats as Forgejo OAuth configuration; a first scratch run with only that variable failed at startup for that reason. Default-port installs render unchanged.

Evidence (scratch copy, project `golfinstalltest`, ports 18480/13481/12482, beside the untouched retained `golf-forgejo` stack): a fresh `--yes` install exited 0 and created `.env` and the password file at mode 0600 with no enrollment JSON left behind. `SessionService/LoginWithPassword` returned 200 with `isInstanceAdmin: true`, `GetSession` returned the user, a private repository was created through `RepositoryService/CreateRepository` with the installer's token, and a wrong password returned 401. Enrolling a second account against a pre-existing Forgejo user worked, and an immediate re-run reported the existing account and changed nothing. `--uninstall` kept both volumes. The port, project-collision and no-terminal checks failed as intended, and `shellcheck` and `make install-check` passed. The scratch project was removed with `down --volumes`. Not yet exercised: macOS/Docker Desktop, arm64, a rootful Docker host and an interactive TTY prompt session. When the installer reuses an existing Forgejo user, it does not make that user a Forgejo administrator, though the user still becomes a Golf instance administrator.
