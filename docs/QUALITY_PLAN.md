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

## Q-3 Keep it green

- A documented local gate for UI changes: affected specs, then the full suite before merging a change that touches shared
  components.
- A faster tier (smoke specs per area) that runs in a few minutes.
- When repository CI is allowed, the same tiers become its workflows.

## Not in this plan

- Hosted runtime failures (rare 503s and connection resets under agent load) are tracked in
  [SCALE_OUT_PLAN.md](SCALE_OUT_PLAN.md) and the scale-out benchmark.
