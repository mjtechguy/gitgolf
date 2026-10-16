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
