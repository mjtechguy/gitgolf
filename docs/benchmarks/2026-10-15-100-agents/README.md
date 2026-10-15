# 100 agents in one repository (hosted, 2026-10-15)

Material for the agentic mode write-up (blog post with charts). Raw bench output is in `data/`. `summary.csv` is generated
by `python3 summarize.py` and is the source for every chart. Status context is in
[AGENTIC_MODE_PLAN.md](../../AGENTIC_MODE_PLAN.md) (target: at least 100 agents in one repository) and
[IMPLEMENTATION_STATUS.md](../../IMPLEMENTATION_STATUS.md).

## Setup

- **Deployment:** `https://demo.gitgolf.mjtechguy.com`, Cloudflare-native Golf: a Worker, a Workspace Durable Object, D1 and
  Artifacts. Schema 48.
- **Repository:** `mj/agent-bench-3`, with agentic mode on:
  - low-risk paths `docs/**`;
  - landing without a person;
  - required check `bench/ci`;
  - revert on failure.
- **Load generator:** `scripts/agent_speed_bench.mjs`, five processes in parallel from one workstation. Each process has its own
  API token (write, this repository only, 24 h). Agent rate budgets were at their defaults.
- **Agent model:** `--think 60`. Each agent pauses 30 to 90 s (jittered) between operations and starts at a random point in its
  first minute. This approximates "100 agents each writing about once a minute", the plan's sizing.
- **CI stand-in:** a loop in a signed-in administrator browser session reported `bench/ci` = success on every new pull request
  head every 5 s. Golf never lands a head on which no check has reported, and reporting a check needs an administrator.
- **Duration:** 30 minutes of load. In-flight pull requests then had up to 15 minutes to land.

| Scenario | Agents | What each agent does |
| --- | --- | --- |
| S7 | 30 | The whole agent loop: Source API commit to a new `agent/…` branch, `open_pull_request` over MCP, then poll until it lands |
| S6 | 30 | Source API commits: a branch each for 15 min, then all 30 on one shared branch with `onStale: merge` for 15 min |
| S2 | 25 | Git pushes, a branch each |
| S1 | 5 | Git pushes racing on one shared branch: fetch the tip, commit, push |
| S4 | 10 + 10 | Shallow clones and `ls-remote` (10 readers), during paced pushes (10 writers) |

That is about 110 agents in one repository. (S5, the API reads, was skipped: the RPC reads do not accept API tokens.)

## Baseline (before the fixes)

From `summary.csv`, run `baseline`:

| Scenario / operation | Attempts | Failed | p50 | p95 | Failure outcomes |
| --- | --- | --- | --- | --- | --- |
| S7 agent loop: landed within 15 min | 69 PRs | **55 (80 %)** | — | — | 55 land timeouts |
| S7 Source API commit | 71 | 1 | 21.6 s | 37.2 s | 412 |
| S7 open PR (MCP) | 70 | 1 | 28.4 s | 44.8 s | tool error (fence) |
| S6 commit, a branch each | 382 | **53 (14 %)** | 13.8 s | 36.6 s | 412 "An unresolved operation fences further changes" |
| S6 commit, shared branch | 371 | **101 (27 %)** | 24.6 s | 40.4 s | 98 × 412, 3 × 503 |
| S2 Git push, a branch each | 462 | 32 (7 %) | 29.8 s | 69.7 s | 31 remote rejected, 1 × 503 |
| S1 Git push, shared branch | 65 | 42 (65 %) | 26.7 s | 60.8 s | 23 non-fast-forward (expected races), 19 remote rejected |
| S4 shallow clone | 122 | 0 | 42.7 s | 99.0 s | — |
| S4 ls-remote | 113 | 0 | 30.7 s | 60.3 s | — |

**Single pull request, idle system:** landed 193 s after its check passed (about 4¾ min after opening). Landing waited for the
maintenance sweep.

## What was wrong

1. **Policy landing ran only in the maintenance sweep.**
   - The sweep runs every 5 minutes and takes at most 20 pull requests per sweep. Actions completions also trigger it.
   - A reported check or a newly opened pull request never triggered a landing.
   - Agents produced pull requests faster than the sweep landed them, so the queue only grew: 14 of 69 landed.
2. **A merge reserved the whole repository, and other writers failed instead of waiting.**
   - Each landing is a merge, and a merge holds `repositories.write_pending` for a few seconds.
   - Meanwhile Source API commits answered 412 "An unresolved operation fences further changes", and Git pushes were refused with
     "the repository is finishing a merge".
   - With landings throughout the run, that refused 14–27 % of Source API commits, plus Git pushes.
3. **Everything for one repository queues through one Workspace Durable Object.**
   - p50 latencies of 14–43 s at about 2 operations a second show the queue itself is long.
   - That is the deferred `RepositoryWrites` split (AGENTIC_MODE_PLAN AM-1 item 5). Its revisit trigger, p95 above 30 s, was
     crossed in this run.

## Fixes (deployed 2026-10-15 14:56 UTC)

- **Land on the passing check (`landSoon`, `cloudflare/forge/src/land-queue.mjs`).**
  - When a check is reported or a pull request is opened, Golf runs the targeted `autoLand` for that head after the response.
  - The sweep stays as the backstop.
  - Smoke test: one pull request landed **11.7 s after opening**, against 193 s or more after its check on the baseline.
- **Wait instead of failing behind a merge.**
  - A Source API commit treats the repository reservation like a busy branch, within its existing 30 s budget.
  - A Git push waits up to 20 s for its branch or the repository before Git's refusal report.

## After the fixes

Run `fixed`, the same mix: results are added below when the run completes.

## Chart plan (for the blog post)

All numbers come from `summary.csv`. If images are generated with an image model (Codex, gpt-image-2), give it the exact
values and check every label and bar against the CSV before publishing. For exactness, a chart rendered from the CSV with the
generated image as the frame or illustration is safer.

1. **"Did the agent's pull request land?"** S7: landed within 15 minutes versus timed out, baseline against fixed. Two stacked bars.
2. **Time to land.** One pull request on an idle system (193 s → 11.7 s), and the S7 land latency distribution under load,
   baseline against fixed.
3. **Write failures under load.** Failure percentage per operation: S6 branch, S6 shared, S2 push, S7 commit. Grouped bars,
   baseline against fixed.
4. **Latency.** p50/p95 per operation, baseline against fixed, with the 30 s line (the `RepositoryWrites` revisit trigger).
5. **The setup.** A diagram of 110 agents → one repository: Git, Source API, MCP, land queue, CI check.
