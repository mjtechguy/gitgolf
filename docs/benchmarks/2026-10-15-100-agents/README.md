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

## After the fixes (run `fixed`, the same mix)

| Scenario / operation | Failed: baseline → fixed | p50: baseline → fixed | p95: baseline → fixed |
| --- | --- | --- | --- |
| S2 Git push, a branch each | 6.9 % → **0.8 %** | 29.8 s → 69.2 s | 69.7 s → 98.2 s |
| S6 commit, a branch each | 13.9 % → **7.4 %** (now waits, then 60 s client timeouts) | 13.8 s → 23.4 s | 36.6 s → 58.1 s |
| S6 commit, shared branch | 27.2 % → **1.4 %** | 24.6 s → 40.9 s | 40.4 s → 56.8 s |
| S4 shallow clone | 0 % → 25 % (60 s client timeouts) | 42.7 s → 83.7 s | 99.0 s → 145.2 s |
| S4 background pushes | 13 of 175 refused → 1 of 148 | 29.1 s → 62.5 s | 63.7 s → 100.0 s |
| S7 landed within 15 min | 14 of 69 → 17 of 68 (see the caveat below) | — | — |

**Deployment throughput was flat:**
- **Successful writes** (pushes, Source API commits, opened pull requests): 0.75/s on the baseline, 0.70/s after the fixes.
- **Successful reads** (clone, ls-remote, fetch): 0.18/s, then 0.11/s.
- **What the fixes did:** they turned refusals into waiting, and the waiting shows up as latency. They did not add capacity.

**What this says:**
- A hundred agents writing about once a minute need about 1.7 writes/s plus reads. One repository moves about 0.7.
- The earlier 2.4 writes/s was a different load: closed-loop Source API commits only, no Git transfers, pull requests or landings.
- The limit is the repository's one Workspace Durable Object.
  - Commits and Git transfers are already the overlapping `transfer` class (up to 24 at once), and MCP reads are `read`.
  - So the likely ceiling is the object's single thread doing all the CPU work: packs, tree merges, upload-pack.
  - The next run records each request's Server-Timing (`queue` = waiting for admission, `worker` = the request) to confirm that.

**Caveat on S7 in run `fixed`:**
- The browser CI stand-in's tab reloaded and the loop stopped, until about 15:13 UTC. Pull requests opened in the meantime had no check, so they could not land.
- When restarted, the loop reported one check about every 30 s (each report is a write in the same queue). Pull requests had waited 6–20 minutes for their check.
- Run `fixed2` repeats the mix with the CI stand-in inside the bench: each S7 agent reports `bench/ci` right after opening its pull request, using a short-lived administrator credential.

## Run `fixed2`: the same mix, with Server-Timing

The S7 CI stand-in moved into the bench, so each agent reports `bench/ci` itself. Every HTTP operation now records its
Server-Timing: `queue` is the time waiting for admission in the Workspace, and `worker` is the whole request inside the Worker.

| Scenario / operation | Failed: baseline → fixed2 | p50: baseline → fixed2 | p95: baseline → fixed2 | Server queue p50 / p95 | Server worker p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| S2 Git push, a branch each | 6.9 % → **0 %** | 29.8 s → 40.3 s | 69.7 s → 107.4 s | (Git client) | (Git client) |
| S6 commit, a branch each | 13.9 % → **1.4 %** | 13.8 s → 17.7 s | 36.6 s → 53.7 s | 0.0 s / 0.0 s | 17.5 s / 52.5 s |
| S6 commit, shared branch | 27.2 % → **2.2 %** | 24.6 s → 30.4 s | 40.4 s → 56.2 s | 0.0 s / 0.1 s | 30.2 s / 55.5 s |
| S7 commit | 1.4 % → 3.0 % | 21.6 s → 23.9 s | 37.2 s → 55.9 s | 0.0 s / 0.9 s | 23.7 s / 52.5 s |
| S7 open PR (MCP) | 1.4 % → 7.7 % | 28.4 s → 41.4 s | 44.8 s → 60.0 s | 0.4 s / 2.6 s | 36.4 s / 58.2 s |
| S4 clone | 0 % → 8.9 % (client timeouts) | 42.7 s → 60.9 s | 99.0 s → 130.5 s | (Git client) | (Git client) |

**Throughput:** successful writes 0.75/s (baseline), 0.70/s (`fixed`), 0.78/s (`fixed2`). Successful reads were 0.18/s, 0.11/s and
0.15/s.

**The key finding:** for every HTTP write, the server's admission queue is about zero.
- The Worker-side time is almost exactly what the client sees: S6 17.5 s server against 17.7 s client.
- Requests get in at once (commits and Git transfers are the overlapping `transfer` class), and are slow while they run.
- The limit is execution inside the one Workspace Durable Object, which holds every repository of the installation. Admission
  rules are not the limit.
- Two candidates, both ending in the same place: the object's single thread shares CPU across 20+ concurrent requests (packs, tree
  merges, upload-pack), or the storage calls it makes slow down under load.

**S7 in `fixed2` is not valid.** The bench's check report omitted `repositoryId`, so all 60 reports got 404 and nothing could land.
That was caught after the run. The fixed bench landed a single pull request 5.4 s after opening it (commit 1.9 s, PR 2.0 s,
check 0.45 s). Run `fixed3` repeats the whole mix with it.

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
