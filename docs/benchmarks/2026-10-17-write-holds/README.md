# Write holds at about 110 agents: three runs on hosted

Hosted, 2026-10-17, 02:26–03:30 UTC. Plan: [`SCALE_OUT_PLAN.md`](../../SCALE_OUT_PLAN.md). Same setup as
[`2026-10-15-scale-out`](../2026-10-15-scale-out/README.md): `mj/agent-bench-3`, agentic mode on, `scripts/agent_speed_bench.mjs` in five
processes with `--think 60`, the full mix (S7 30, S6 30, S2 25, S1 5, S4 10 agents) for 8 minutes plus the 15-minute landing window, and
a Workspace probe every 20 s. The raw bench JSON stays out of git.

| Run | Deployed |
| --- | --- |
| `r1` | `main` at #169: a merge holds the whole repository; 100 ms CPU limit |
| `r2` | #171: a merge holds only its base and head; provider token leases; 1 s CPU limit |
| `r3` | #172 as well: unknown branch writes hold only merges of their branches; six jittered ref retries |

## Results

| Operation | `r1` | `r2` | `r3` |
| --- | --- | --- | --- |
| Git push, a branch each (S2) | 117 of 179, p95 21 s | 195 of 195, p95 1.9 s | **194 of 194**, p95 2.0 s |
| Push to one shared branch (S1) | 15 of 31 | 34 of 41 | 31 of 39 (6 ordinary non-fast-forward races) |
| Source API commit, branch per writer (S6) | 139 of 229 | did not start (7 of 30 setup branches unknown) | **276 of 276**, p95 3.7 s |
| Source API commit, shared branch (S6) | 176 of 243, p95 32 s | 263 of 264 | **266 of 266**, p95 6.2 s |
| Agent loop: Source API commit (S7) | 111 of 167 | 30 of 30 | **181 of 181** |
| Agent loop: `open_pull_request` (S7) | 111 of 111 | 30 of 30 | 180 of 181 |
| Agent loop: landed within 15 min (S7) | 107 of 111, p50 5.9 s | 16 of 30, p50 881 s | **180 of 180**, p50 5.8 s |
| Clone and `ls-remote` (S4) | 174 of 174 | 158 of 158 | 161 of 161 |
| Workspace probe, slowest | 12.4 s | 12.4 s | 20.4 s |

## What each run showed

**`r1`: merges starved every other branch.**
- Every merge set `repositories.write_pending`, and every push and Source API commit waited for it to clear. Agents land all the time,
  so writes to their own branches waited out their 30 s budget: "another write to … or a merge in this repository stayed in flight".
- The maintenance cron ended at the Worker's 100 ms CPU limit (`exceededCpu`). Source API commits used up to 232 ms and pushes 114 ms.

**`r2`: writes recovered; landing stalled behind unrelated unknown writes.**
- With the hold narrowed, writes reached Artifacts together. For a burst of 30 new branches the provider answered six without a ref
  status through all five retries, so they ended unknown.
- Any unknown write held every merge in the repository. All 30 pull requests were opened in those four minutes, and every landing gave
  up after 46 s ("the repository stayed busy with another write"). The maintenance sweep landed 20 of them after the six were settled.
  Each S7 agent waits for its landing, so only 30 were opened.

**`r3`: every write and every landing succeeded.**
- The one failure was one `open_pull_request` answered "could not be confirmed".
- The next limit is the Workspace queue. `open_pull_request` and CI reports still go through it: admission wait p50 6.0 s and p95
  18.0 s, against 4.0 s and 9.5 s in `r1`, because about 60 % more pull requests went through it.

## Next

- Move `CreatePullRequest`, MCP `open_pull_request` and `ReportCheck` out of the Workspace queue: the `nextId` retry and the atomic
  one-open-pull-request check from the `overlap` branch, without the rest of that change. See SCALE_OUT_PLAN "Found while measuring".
- A landing that gives up because the repository was busy waits for the next sweep, up to five minutes. A sooner retry would remove
  that gap.
