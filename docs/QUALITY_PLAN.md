# Quality before beta

Date: 2026-10-16. Status: proposed, started 2026-10-16.

Golf is alpha. Before it leaves alpha, the test suites that guard the product must be green on `main`, so a red run means a change broke
something. Today they are not, and status entries repeatedly record "the full browser suite was not rerun".

## Where it stands

- **Browser suite (Playwright, `web/tests/*.spec.ts`, 137 spec files):**
  - About 2,210 tests; a full run takes well over 25 minutes on a 12-core machine.
  - On 2026-10-13, 334 failed on unmodified `main`.
  - Changes since then compare their affected specs against a `main` baseline instead of expecting a pass. Recurring examples:
    `repository-routes`, `instance-admin`, `capabilities`, `issues`, `repository-browser`.
  - Some failures may come from load or parallelism (tests that pass alone and fail in a full parallel run).
- **Web unit tests (`node --test web/tests/*.test.ts`):** two known failures on `main`: `navigation-cache` (module resolution)
  and one `runtime-capabilities` test.
- **Forge suite (`node --test cloudflare/forge/*.test.mjs`):** green (about 764 tests, one skipped).
- **No repository CI workflows yet** (AGENTS.md), so nothing enforces the suites; every change runs them locally.

## Q-1 Baseline and triage

- A full run of `main`, recorded as a dated baseline with the failing test list (machine, worker count, duration).
- Each failure classified:
  - **stale expectation:** the UI changed on purpose and the test did not;
  - **real bug:** the product is wrong;
  - **flaky:** passes alone, fails under load, timing;
  - **environment:** fixtures, ports, missing build output.
- **Exit:** a triage table in this document with counts per class.

## Q-1 baseline (2026-10-16)

Triage only: no product or test changes. The raw list, with each test's group and first error line, is
[quality/2026-10-16-baseline-failures.txt](quality/2026-10-16-baseline-failures.txt).

**Run.**

- Machine: AMD Ryzen 5 5600X (6 cores, 12 threads), 62 GB RAM, Linux 6.8, Node 24.15, Playwright 1.63, Chromium headless
  shell. Other projects' test suites were running on the machine at the same time.
- Base: `origin/main` at 8df0d6f, in a git worktree with its own `npm ci` in `web/` and `cloudflare/agents/`.
- Config: the repository's `web/playwright.config.ts`, run through an uncommitted wrapper that changes only the port (4279
  instead of 4179) so parallel worktrees do not collide. Vite dev server, mocked RPC fixtures, no retries configured.
- Full run: `--workers=6 --retries=0`, **28.3 min**.
- Rerun of the failures: `--last-failed --workers=4 --retries=0`, 22.9 min.

**Totals.**

| | Tests |
| --- | ---: |
| Total | 2,557 |
| Passed | 2,266 |
| Failed in the full run | 208 |
| Skipped | 83 |
| Failed again in the rerun (deterministic) | 194 |
| Passed in the rerun (flaky) | 14 |

**Counts per class** (208 failures):

| Class | Tests | Groups |
| --- | ---: | --- |
| Stale expectation (the UI or its contract changed on purpose; test or fixture did not) | 185 | A–F, H |
| Real bug (probable, confirm while fixing) | 4 | I, J |
| Flaky (passes on rerun, or depends on load) | 19 | 14 flaky, K (5) |
| Environment | 0 on this base | G: 3 on b0cefe7, fixed by installing `cloudflare/agents` dependencies |

**Root-cause groups**, ordered by how many tests each fix would turn green:

| Group | Class | Tests | Specs | Example and evidence | Likely fix (Q-2) |
| --- | --- | ---: | --- | --- | --- |
| A. Fixture reports no runtime capability manifest | stale | 156 | `pull-review-comments` 45, `repository-environments` 36, `pull-review-draft-publication` 32, `pull-review-drafts` 30, `infrastructure-connections` 10, `repository-deletion-route` 2, `capabilities` 1 | `pull-review-drafts`: the **Private draft** button never appears. It sits inside `<RuntimeFeature id="pull.advanced-reviews">`, and the fixture answers `ListCapabilities` with 501, so `runtimeFeature(undefined)` hides it. `repository-environments`: the fixture's exhaustive route throws `Expected value: "ListCapabilities"`. Admin pages show "Not available here: settings availability could not be checked". `capabilities`: the manifest has no `runtimeProfile` or `settings.infrastructure`, so **Manage connections** is hidden. | Answer `ListCapabilities` with `portableRuntimeFixture` (`web/tests/runtime-fixture.ts`, already used by 66 test files), adding `pull.advanced-reviews` where needed. |
| B. Image placeholder text changed | stale | 7 | `source-identity` 4, `issues` 1, `pull-requests` 1, `repository-browser` 1 | Tests expect `"<alt> (image preview unavailable)"`; since fa4dbd3 (#1) the placeholder shows only the alt text, labelled `"<alt>: image unavailable"`, and nothing when there is no alt text. | Assert on the new label and on alt-less images rendering nothing. |
| H. Layout, token or column changes | stale | 6 | `workflow-run-typed-inputs` 2, `codex-connections` 1, `workspace` 1, `instance-admin` 1, `repository-browser` 1 | `codex-connections`: gap 16 px, expected 20 (`--section-gap` is 16 px since #1). `workflow-run-typed-inputs`: expects the 390 px terminal to wrap "passe/d."; it no longer wraps. `workspace`: brand colours per appearance changed. `instance-admin`: searching "Disabled" now also matches the new **Authenticator** column. `repository-browser` README: one `<img>` where 0 were expected; README images resolve to an exact commit and are served via `GetRepositoryImage` (check that `src` is a `data:` URL). | Update each expected value; derive the wrap from the terminal width instead of hard-coding it. |
| E. New RPC or native route missing from the fixture | stale | 6 | `repository-creation` 3, `workspace-switcher` 1, `repository-routes` 1, `data-table` 1 | Traces: `ListProviderConnections` 404 on the new-repository and home pages, which adds a second `role=alert` (strict-mode violation) and, at 320 px, horizontal overflow in `workspace-switcher`. `ListGolfUserAccess` 404 in `data-table`. `/native/config` and `.../shares/read` 404 in the native runner chooser. | Add the procedures and routes to each fixture. Re-check the 320 px overflow once the alert is gone; if it persists, it is a real bug. |
| D. Workspace switcher only on home and organization pages | stale | 4 | `workspace-switcher`, `repository-compare`, `native-forge078-integration`, `repository-routes` | `getByRole('button', { name: 'Switch workspace' })` not found on repository and settings pages; `.workspace-switcher` is null in the frame-alignment test. Since 882ba28 (#3) `App.tsx` mounts it only for `home` and `organizations`. | Assert the switcher on home and organization pages only, and drop it from the repository-page frame check. |
| C. Native PR evidence and preview reads moved | stale | 4 | `pull-merge-observation` | The fixture serves `/native/pr-evidence` and `/native/pr-preview`; since b8e5e85 (#5) the app reads `/native/pr-evidence/read` and `/native/pr-preview/read` (404 in traces: "Fixture route unavailable"). | Serve the `/read` paths in the fixture. |
| K. 1000-row latest-change reads stall under parallel load | flaky | 5 | `source-entry-commit` | Rows stay at "Reading latest change…" and `state.calls` stays 0. The header "Loading latest commit…" read is held by the same `ListCommits` hold. Fails with 4–6 workers; 4 of the 5 passed alone (`--workers=1`) on b0cefe7. | Make the fixture's hold apply only to row reads, or wait for the header read before counting. Investigate whether row reads queue behind the header read. |
| I. Duplicate reads after the parent run revalidates | real bug (probable) | 3 | `agent-task-events` 2, `workflow-run-workspace` 1 | The maximum journal (513 events) should drain in 17 reads; it took 30–34. The trace shows `GetActionRun` refetching about 1 s later and the whole journal draining again from cursor 0. `workflow-run-workspace` reads log page `16` twice. | Keep a completed journal or log across parent revalidation instead of restarting from 0. |
| F. Settings inventories moved behind the "Capability diagnostics" disclosure | stale | 2 | `instance-admin`, `profile-settings` | The tables "Instance settings" and "Personal settings" are rendered only after **Capability diagnostics** is opened (since 36f7d01, in line with "forms open only on request"). | Open the disclosure first, or assert on the overview's current content. |
| J. Sign-out leaves the review editor up until logout returns | real bug (probable) | 1 | `pull-review-create` | With the logout response held, the **Review changes** region stays mounted (`Expected: 0, Received: 1`). `logout` clears private state only in `onSuccess`. | Clear private UI when sign-out starts, for example in `onMutate`, then confirm the intended behaviour. |
| G. `cloudflare/agents` dependencies not installed | environment | 0 (3 on b0cefe7) | `native-releases` 2, `native-attachments` 1 | `Cannot find module …/cloudflare/agents/node_modules/yaml/browser/index.js imported from cloudflare/forge/src/native-workflow.mjs`. | Document `npm ci` in `cloudflare/agents` as a setup step for the browser suite. All three passed once it was run. |

**By first error line** (194 deterministic): `locator.click` timeout 111 (mostly A: waiting for **Private draft** or
**Show inline comments (3)**); `toContain` 36 (A, `repository-environments`); `toBeVisible` 13; `toBe` 7; `toContainText` 7;
`locator.focus` timeout 4; `toHaveText` 4; `toHaveCount` 4; `toEqual` 2; `toHaveAttribute` 2; and one each of
`getBoundingClientRect` on null, `locator.fill` timeout, `toHaveLength` and `toBeLessThanOrEqual`.

**Flaky** (failed in the full run, passed in the rerun; fix the wait or isolation, not the timeout):

- `action-runs.spec.ts:35` proposed task diff reuses shared syntax/line/display controls light
- `forge089.spec.ts:15` batch controls fit light 390
- `instance-admin.spec.ts:104` unconfirmed disable never retries and requires state inspection before another attempt
- `issues.spec.ts:482` lost issue-edit acknowledgement reloads with metadata only and never sends another PATCH
- `issues.spec.ts:555` known native issue metadata is compact, inert and access-bound in light 1440px
- `issues.spec.ts:692` assignee inventory is unpaginated and bounded with loaded search, scrolling and 100-selection cap
- `missing-resource-refetch.spec.ts:33` a missing organization answers once and its error screen stays until Try again
- `organization-create.spec.ts:20` organization creation is explicit, cancel is empty, private-only response is verified
  and listing refreshed
- `organizations.spec.ts:68` organization/team routes paginate… (on b0cefe7 it failed every time with `GetRepositoryOverview`
  missing from the fixture)
- `pull-merge-observation.spec.ts:76` observation 403 stays masked… (a second "Fixture procedure not supplied" alert
  sometimes appears, which makes it a strict-mode violation)
- `pull-native-merge.spec.ts:92` requested squash confirmation and immutable method receipt 390 light
- `pull-requests.spec.ts:649` loaded PR activity sorting excludes unavailable comment counts in light 390px
- `repository-creation.spec.ts:89` transport failure permits same-key retry… (shares group E's extra alert)
- `repository-sidebar.spec.ts:74` a transient refresh failure keeps the shown details, says so, and recovers on its own

**Earlier run on b0cefe7** (superseded by the base above): 2,540 tests, 212 failed, 83 skipped, 28.8 min at 6 workers. A
fully serial rerun (`--workers=1`, 65 min) passed 16 of them. The remaining failures fell into the same groups, plus G.

**Web unit tests** (`node --test web/tests/*.test.ts`, 25 tests: 23 pass, 2 fail, on b0cefe7 and on 8df0d6f):

- `navigation-cache.test.ts`, environment (the test runner cannot load the module). `src/queryClient.ts` imports
  `./gen/golf/v1/golf_pb` without an extension (since fa4dbd3, #1). Node's type stripping needs explicit extensions, and the
  generated `golf_pb.ts` uses TypeScript `enum`s, which strip-only mode rejects (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). With a
  resolver that appends `.ts` plus `--experimental-transform-types`, all 5 tests pass. Fix: keep the generated-code import out
  of `queryClient.ts` (move the session bootstrap parsing to its own module), or run this test with transform types and an
  explicit extension.
- `runtime-capabilities.test.ts` "native operations route…", stale expectation. It asserts that `settingForRoute(
  'instance-settings', view, true)` starts with `settings.` for `agents`. Since fdac521 (#70) the native `/admin/agents` page
  maps to `agents.hosts`. Fix: expect `agents.hosts` for `agents`.

## Q-2 Burn down

- **Stale expectations:** update the test to the intended behaviour, citing the change that made it.
- **Real bugs:** fix the product, with the test as the regression.
- **Flaky:** fix the wait or isolation; never add retries or longer timeouts to hide them.
- **Environment:** fix the fixture or the setup script.
- **Exit:** the full suite and the web unit tests are green on `main` twice in a row.

**Status, part A (2026-10-16): stale expectations, groups A–F and H, and the two web unit tests.** Started; exit not met.

- Changes: tests and fixtures only, plus one move of product code. The Cloudflare-native session bootstrap moved from
  `web/src/queryClient.ts` to `web/src/sessionBootstrap.ts`, which `main.tsx` calls. `queryClient.ts` therefore no longer
  imports the generated `golf_pb.ts` and runs under plain `node --test`. This was chosen over a test-only loader with
  `--experimental-transform-types` so that every unit test keeps running with the same command.
- Web unit tests: 29 of 29 pass (`node --test web/tests/*.test.ts`). `npm run typecheck` passes.
- Full browser run, same wrapper as Q-1 (port 4379), `--workers=6 --retries=0`, 27.9 min. The machine was heavily loaded by
  other worktrees (load average about 21 on 12 threads).

  | | Q-1 baseline | After part A |
  | --- | ---: | ---: |
  | Total | 2,557 | 2,557 |
  | Passed | 2,266 | 2,420 |
  | Failed (including timeouts) | 208 | 54 |
  | Skipped | 83 | 83 |

- Groups A–F and H (185 in the baseline): 10 still failed in the full run.
  - A: 9 (`pull-review-comments` 8, `pull-review-drafts` 1). Answering `ListCapabilities` exposed a load-dependent failure:
    an opened inline-comment panel collapses again. The whole spec passes at 2 workers (46 of 46) and fails 6–13 tests
    when run alone at 6 workers. Not fixed here; treat it as flaky.
  - E: 1, a **real bug**. At 320px the workspace switcher dropdown overflows the viewport even with the extra alert gone:
    `.workspace-switcher-dropdown` is `left:0` from a trigger at x≈104 with `max-width:calc(100vw - 32px)`, so it ends at
    x≈392. Its test (`workspace-switcher.spec.ts` "header switcher…") stays red until `styles.css` is fixed.
  - B, C, D, F, H: 0.
- Other failures in the same run: I 3 and K 5 (owned by another change), 3 of the Q-1 flaky list, and 33 not in the
  baseline. All 33 are in specs or tests that part A did not change, or they passed again. A rerun of those 33 at 3 workers
  left 7 failing. 5 of those 7 then passed on both `main`'s copy and this branch (`issues` 758 ×2 and 810,
  `pull-requests` 530 ×2). The other 2 are `pull-merge-observation` 76 (a Q-1 flaky test) and `repository-file-changes` 38.
- Second-level stale expectations found while fixing (cited in each test): the home page's `.workspace-intro` became
  `.repository-index` (fa4dbd3). Wide layouts without top navigation hide the workspace menu (27098d4). The OCI receipt's
  attestation note became an "Inspect scan, SBOM and policy" link (ffc79ac). Brand, Flare surface and accent tokens changed
  with the layout study (2cf0b71). The native runner chooser needs `/native/config` and `/native/capacity/shares/read`.
- Remaining for Q-2: groups I, J and K; the flaky list; the switcher overflow bug; the `pull-review-comments` collapse under
  load; then two consecutive green runs.

**Status, part C (2026-10-16): product fixes for the switcher overflow, the inline-comment collapse and group K.** Exit not
met. Same wrapper as Q-1 (port 4579). Other worktrees loaded the machine throughout (load average 9–33 on 12 threads).

- **Switcher overflow (E, real bug).** Below 720px the dropdown was positioned from the trigger (x≈104 at 320px) at a fixed
  300px width. It now anchors to the header: `left:16px`, `max-width:calc(100% - 32px)`. Measured at 11 widths from 320 to
  1440px in every appearance and layout: the dropdown stays inside the viewport. `workspace-switcher` passes 4 of 4;
  with `repository-compare`, `native-forge078-integration` and `workspace`, 64 of 64.
- **Inline-comment panel collapse (A, 9 tests).** Root cause in the product: the review list shows "Loading reviews…"
  while it revalidates, which unmounts its rows, and the panel's open state lived in the row. Any revalidation closed an
  opened panel. The open state now lives in the review list (`PullRequestBrowser.tsx`), keyed by review and commit, and the
  panel reopens with a fresh read. What revalidated in the specs: their fixtures rejected `WatchRepository` with HTTP 501,
  which Connect reports to a stream as Unknown. `RepositoryLive` treats that as a dropped stream and revalidates pulls
  after 0, 1, 2, 4… s, so under load a retry landed after the panel opened. Both specs now answer it as a Connect stream
  reports Unimplemented. A new test drops the stream on purpose with the panel open; it fails without the product fix.
  The "Files changed comments fit" measurement also raced the lazy syntax highlighter replacing the diff rows; it now
  measures in one read. Before: `--workers=8 --repeat-each=3`, at least 20 failures. After: `--workers=6`, 77 of 77;
  `--workers=6 --repeat-each=3`, 231 of 231.
- **Group K (source rows under load).** Each of up to 1000 rows mounted a query observer (one cache entry per row), its
  own IntersectionObserver and two page listeners, all twice in development StrictMode. Every cache event of a
  private-navigation query also rescanned the whole cache for retention. Now one shared observer and one pair of listeners
  serve all rows, a row mounts its query only when it is visible, settled or retained, and the retention scan skips
  queries without data. With CPU throttled 4×, the mount task dropped from 2.12–2.19 s to 1.63–1.82 s (3 runs each); the
  same directory without row changes takes about 1.7 s. With CPU throttled 3× (2 workers, 2 repeats): before, 4 of 10
  failed; after, 10 of 10 passed. The spec now waits for the 1000-row listing before asserting on row reads.
  Unthrottled: `--workers=6 --repeat-each=3`, 177 of 177; `--workers=12 --repeat-each=3`, 177 of 177.
- Remaining: rendering the 1000-row listing in the development build is one main-thread task (about 1.7 s at 4× CPU).
  Under heavier load (3× CPU at 3 workers, or 4×) the listing, or the 3-slot read queue reaching row-980, can still exceed
  the 5 s expectation in both old and new code. `rpc.ts`'s `reject()` for `WatchRepository` should answer with an HTTP 200
  Connect end-stream error (`unimplemented`); every spec that relies on it currently gets fallback revalidation. Not
  changed here (test infrastructure is owned elsewhere).
- Checks: `npm run typecheck`, `npm run build`, `npm run build:native` pass; `node --test web/tests/*.test.ts` 29 of 29.
  Specs covering the touched components (`layout-presets`, `pull-requests`, `pull-review-create`, `repository-browser`,
  `source-navigator`, `source-identity`, `readable-source`, `missing-resource-refetch`) at 6 workers: 248 passed and 5
  failed at load average 29; the 5 (`layout-presets` 124, `repository-browser` 338, `pull-requests` 530, 566, 612) passed
  on rerun at 2 workers (20 of 20).

**Status, part B (2026-10-16): test isolation and the flaky list.** Tests and fixtures only. Same wrapper as Q-1 (port
4679). Three causes explain the flaky list:

- **The live stream never settled (`rpc.ts`).** `WatchRepository` is the only server-streaming procedure. Connect clients
  derive a stream's error code from the HTTP status alone, so `reject()`'s HTTP 501 reached `RepositoryLive` as Unknown:
  a dropped stream. That means an immediate revalidation of issues, pulls, actions and agents, then reconnects with
  revalidation after 1, 2, 4… s for the rest of the test. `reject()` now answers `WatchRepository` the way a Connect server
  reports a stream error: HTTP 200, `application/connect+json`, one end-of-stream frame carrying the code. `not_found`
  still becomes `unimplemented`, which settles the page on "Manual updates". `unavailable` still drops the stream, so the
  offline tests are unchanged. Measured on `issues`, `pull-requests`, `repository-browser` and `repository-sidebar` (228
  tests, traces at 6 workers): 6,858 RPCs and 389 stream calls before, 6,471 and 288 after. `issues` "known native issue
  metadata… light 1440px" went from 58 to 33 RPCs.
- **Harness pages reloaded every page on the dev server.** 25 specs write a harness page (and sometimes a module) into
  `web/.tmp`, inside Vite's root, in `beforeAll`, and delete it in `afterAll`. Once Vite has served a harness, rewriting or
  deleting it sends `full-reload` to every open page of every worker, so whatever test was running elsewhere lost its page
  (the Vite log showed `page reload .tmp/pull-native-merge.html` each time). Deleting also broke other workers still using
  the file, and `{flag:'wx'}` made `beforeAll` throw `EEXIST` when two workers ran the same spec. The new
  `tests/harness-file.ts` writes a harness only when its content changes, atomically, and never deletes it (`.tmp` is
  ignored by git). The two per-worker harnesses (`repository-deletion`, `repository-environments`) now share one file.
- **Catch-alls answered absent procedures with `not_found`.** 39 fixtures did this; 38 are changed
  (`workspace-switcher.spec.ts` is owned elsewhere). On repository pages, a NotFound from a repository-scoped read such as `GetRepositoryStar` denies the
  whole repository (`RepositoryStars.tsx` calls `onAuthorityDenied`). Whether a test saw the page or "We can't show this
  repository" depended on which answered first. Those catch-alls now answer `unimplemented`, as a server lacking the
  procedure would.

Each test on the flaky list. "Main" is `origin/main`'s tests, run with `--repeat-each=5 --workers=6` on all of them
together: 35 of 151 runs failed. A second run with traces gave the causes (Vite reconnecting mid-test means a reload):

| Test | Main | Root cause | Fix |
| --- | ---: | --- | --- |
| `action-runs` 35 | 3/10 | Mid-test reload from a harness rewrite | Harness writes |
| `forge089` 15 | 1/10 | `EEXIST` from `{flag:'wx'}` | Harness writes |
| `instance-admin` 106 | 0/5 | Could not reproduce | None |
| `issues` 484 | 0/5 | Could not reproduce | None |
| `issues` 557 (four variants) | 2/20 | Mid-test reload; stream retries re-read the issue | Harness writes, `rpc.ts` |
| `issues` 694 | 3/5 | Stream retry re-read `ListRepositoryAssignees` (asserts at most 2 reads) | `rpc.ts` |
| `missing-resource-refetch` 33 | 9/15 | Mid-test reload re-read the missing resource | Harness writes |
| `organization-create` 20 | 1/5 | The listing refetch's "Loading your organizations…" status coexists with the "created" status | Wait for the refreshed listing first |
| `organizations` 68 | 3/5 | Catch-all `not_found` for `GetRepositoryStar` denied the repository | Catch-all `unimplemented` |
| `pull-merge-observation` 76 | 3/10 | Unanswered `GetPullReviewRequests` raised a second alert | Fixture answers it |
| `pull-native-merge` 92 | 1/20 | Mid-test reload; `EEXIST` | Harness writes |
| `pull-requests` 651 | 2/20 | Mid-test reload | Harness writes |
| `repository-creation` 92 | 2/5 | Mid-test reload | Harness writes |
| `repository-sidebar` 74 | 3/5 | Mid-test reload discarded the shown details | Harness writes |
| `repository-file-changes` 38 | 1/5 | "No buttons" after an account switch held only until the new account's access read answered; `EEXIST` | Hold that read until the assertion |
| `api-credentials` 203 (found here) | 1/5 | Released the late secret before the click had unmounted the form | Wait for the unmount |

The same tests on this branch: 0 failures in 155 runs (two invocations, because the edits moved three tests' line numbers; the second ran without the others' load). `pull-requests` 280 relied on the stream fallback: after a list failure,
**Refresh repository access** re-reads only the repository, and the list recovered because the dropped stream revalidated
it. It now uses the list's own **Try again**.

- **Product bug found (`repository-compare` 66).** In `BranchPicker.tsx`, **Load more branches** keeps focus and then
  becomes disabled ("Loading…"). Chrome fires `focusout` with no related target, and `disclosureDismiss.onBlur`
  (`RepositoryUI.tsx`) closes the picker, so the user loses the list they asked to extend. It is timing-dependent: on
  `main` the test passes at 5 workers and fails at 1; on this branch it fails 4 of 6 at 6 workers. Not fixed here (product
  code).
- Broad sample: every spec importing `rpc.ts` (123 files) in 4 groups at 6 workers: 2,471 passed and 3 failed
  (`repository-compare` 66 above; the switcher overflow, fixed in part C; `layout-presets` 124, a `page.goto` timeout that
  passed 5 of 5 on rerun).
- Full run on dc53e4f plus these changes, before part C: `--workers=6 --retries=0`, **17.5 min**, load average about 23.
  2,557 tests: 2,475 passed, **3 failed**, 83 skipped (part A: 54 failed). The 3 were `repository-compare` 66,
  `workspace-switcher` 40 and `pull-review-comments` "Files changed comments fit light 320". After rebasing onto part C,
  the last two passed (3 of 3 and 12 of 12 at 6 workers).
- Checks: `npm run typecheck` passes; `node --test web/tests/*.test.ts` 29 of 29.
- Remaining for Q-2: the `BranchPicker` focus bug, then two consecutive green runs.

**Status, part D (2026-10-16): full runs on `main` and the last races.** Parked; exit not met. All runs used the Q-1
wrapper, `--workers=6 --retries=0`, on a machine loaded by other work (load average 15–33 on 12 threads), about 19–23 min
each. 2,563 tests per run.

| Run | Commit | Passed | Failed | Cause of the failure, and fix |
| --- | --- | ---: | ---: | --- |
| 1 | 1b1a3e5 + #158 | 2,480 | 0 | — |
| 2 | 5cbd5f7 | 2,479 | 1 | `workflow-log-console` 50: the test released a held font before the denial rendered (test race, #159) |
| 3 | ab06093 | 2,479 | 1 | `pull-review-comments` 67: development's remount made one or two comment reads by timing (product, #160) |
| 4 | ab06093 | 2,480 | 0 | — |
| 5 | cad12af | 2,479 | 1 | `agent-controls088` 43: a parent run check discarded an explicit "Refresh controls" (product bug, #161) |
| 6 | cad12af | 2,479 | 1 | `agent-task-events` 66: 513 journal rows re-rendered after a refetch took over 5 s under load (render cost) |

- Fixes, each with a test that fails without it: `BranchPicker` keeps the picker open while "Load more" disables itself
  (#158); the console test waits for the denial before the font completes (#159); inline comments read once per open in
  every build (#160); an explicit control refresh interrupted by a parent check runs again (#161).
- From 208 failures at the Q-1 baseline to 0–1 per full run. Every failure since part C has been a different one-off, and
  the last was render time, not logic.
- Parked on 2026-10-16 in favour of platform work. What remains: large lists (the 513-row agent journal, 1000-row source
  directories) re-render every row after a refetch and take seconds in the development build under load; making those
  renders cheaper is product work that would also remove this class of timeout. Then two consecutive green runs.

**Status, part E (2026-10-16): large lists.** Product changes, no virtualization: every row stays in the DOM. Rows of the
agent journal, source directories and commit history are memoized components, so other updates no longer render unchanged
rows; `DateLabel` reuses two `Intl.DateTimeFormat`s instead of building one per call (486 ms of a journal re-render's CPU
profile); directory entries are sorted once per listing with one collator; journal and directory rows use
`content-visibility:auto`. The journal still hides its rows during every read and parent check (the privacy rules are
unchanged), so a read still mounts all rows again; it is the mount that is cheaper. Measured with Playwright at 4× CPU, the
`main` and branch builds interleaved, median of 5, load average about 4 (time from data arrival to the next frame with all
rows; for the refresh, the longest task):

| List | Development before → after | Production before → after |
| --- | ---: | ---: |
| Journal, 513 withheld rows, refetch | 1,087 → 757 ms | 383 → 140 ms |
| Journal, 513 screened rows, after the parent check | 1,142 → 790 ms | 417 → 167 ms |
| Directory, 1000 rows, first render | 2,042 → 1,822 ms | 989 → 623 ms |
| Directory, refresh of an unchanged listing (longest task) | 1,062 → 136 ms | 231 ms → none |

- Remaining: the development build's first directory render is still one task of about 1.5 s at 4× CPU: React's
  development checks run per element, twice under StrictMode, for about 17 elements per row. Production commits the same
  rows in about 0.45 s. If that still times out under load, the next step is mounting the rows in chunks after the first
  screenful, not windowing.
- Checks: `agent-task-events` and `source-entry-commit` at `--workers=6 --repeat-each=5`, 500 of 500; specs for the other
  touched lists and date labels, 486 of 486. Three new tests fail on `main`.

## Q-3 Keep it green

- A documented local gate for UI changes: affected specs, then the full suite before merging a change that touches shared
  components.
- A faster tier (smoke specs per area) that runs in a few minutes.
- When repository CI is allowed, the same tiers become its workflows.

## Not in this plan

- Hosted runtime failures (rare 503s and connection resets under agent load) are tracked in
  [SCALE_OUT_PLAN.md](SCALE_OUT_PLAN.md) and the scale-out benchmark.
