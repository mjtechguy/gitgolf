# Scale-out plan: moving long I/O-bound work out of the Workspace Durable Object

Status: S1, S2 and the MCP part of S3 built and measured on the hosted demo, 2026-10-15; S4–S6 proposed. Follows AGENTIC_MODE_PLAN AM-1 item 5 and AM-6, and replaces the "RepositoryWrites split only if CPU
is the limit" condition with measured evidence. Benchmark: [benchmarks/2026-10-15-100-agents](benchmarks/2026-10-15-100-agents/README.md).

## Evidence

At about 110 paced agents in one repository (`mj/agent-bench-3`, hosted):

| Observation | Value | Source |
| --- | --- | --- |
| Workspace object CPU | 1.3–2.9 s per minute (about 4 % of one core) | GraphQL `durableObjectsPeriodicGroups`, 16:20–16:56 UTC |
| Workspace object active time | 60 s per minute (always busy) | the same |
| One Source API commit | 14.5–47.4 s in the admission queue, against 0.95–1.26 s of work (D1 0.3–0.6 s, Artifacts 0.2–0.5 s) | full Server-Timing samples |
| Making D1-ordered writes overlap (branch `admission-overlap`) | the whole demo stopped answering within 8 minutes; rolled back | benchmark README, run `overlap` |
| Provider | a merge answered `ERR artifacts_git_receive_pack_busy` | the merge journal |

**Conclusions:**
- The object is not CPU-bound. It is **waiting**.
- Every request of the installation goes through one object and its admission queue (`core.mjs` `serialize`). Long I/O-bound
  transfers hold its slots: clones and fetches (buffered, up to 32 MiB), pushes with a 20 s fence wait, and Source API commits
  with a 30 s merge-retry loop.
- Exclusive requests convoy behind them. Loosening the admission classes only lets more long waits pile up inside the same object.
- Per Cloudflare's limits, an object is single-threaded, with a soft limit of about 1,000 requests a second, and does not get
  bigger. The six-connection limit applies per request, not per object.
- Capacity therefore has to come from **running this work in the stateless Worker**, which scales horizontally, with D1 as the
  only ordering. Moving it into a different single object would not help.

## Principles

- **D1 stays authoritative.** The ref fence (`ref-writes.mjs` `reserveRefWrite`, `git_ref_writes`, `repositories.write_pending`),
  the merge journal and the collaboration admission INSERTs already order every write. Nothing in this plan relies on the
  Workspace queue for correctness.
- **The Workspace keeps coordination, not I/O:**
  - activity streams, webhook and email drains, automations and CI triggers, reached by RPC (`owner.activityChanged()`,
    `owner.automations()`), as `PipelineRun` already does;
  - the in-memory rate-budget counters, charged by a short RPC that does not enter the admission queue;
  - maintenance alarms.
- **Each move is measured on its own** with the bench mix at 30, then 60, then about 110 agents. Abort when the home page takes
  more than 5 s or any request answers 5xx in a burst.
- **Precedent:** `actionsGit` (`forgejo-runner.mjs`) already serves upload-pack from the stateless Worker with D1 and Artifacts
  only.

## Phases

### S1: Git reads (`info/refs`, `git-upload-pack`) in the stateless Worker

- `public.mjs` serves `/git/<owner>/<repo>.git/info/refs` and `git-upload-pack` itself, before the Workspace hop:
  - `actor()`;
  - the token scope;
  - `authorizedRepository()`;
  - `gitRequest()` to Artifacts.
- After the provider answers and before responding, a D1 re-check of the grant: the grant row itself, not only `access_version`,
  because deleting a grant does not bump it. This replaces "a queued revocation fences later reads" with "a committed revocation
  fences": the same guarantee for the client, without queue order.
- Rate budget: one `owner.chargeBudget(kind, key)` RPC (in memory, not queued) before the provider call.
- **Expected effect:** clones and fetches leave the queue. They are the longest transfers, and every exclusive request waits for
  them.
- **Risk:** low. Reads only, with precedent.
- **Status (2026-10-15): built and deployed on the hosted demo.**
  - `public.mjs` `statelessRoute()` sends `info/refs` and `git-upload-pack` to `core.mjs` `handle()` in the Worker.
  - The budget is charged by the Workspace's `chargeBudget` RPC, which charges its own counters under its cached policy.
  - After the provider answers, `git()` reads the grant again with `authorizedRepository()`.
  - Measured with S2 and S3 at about 30, 60 and 110 agents: [benchmarks/2026-10-15-scale-out](benchmarks/2026-10-15-scale-out/README.md).

### S2: pushes and Source API writes in the stateless Worker

- `git-receive-pack`, `/native/source/commit` and `/native/source/branch` run in the Worker. Their ordering is the D1 reservation
  they already take, and the 20 s and 30 s wait loops then occupy no shared slot.
- After a write: `owner.activityChanged()`, pipeline intake (`dispatchPipelineIntake` already runs outside the object for
  `PipelineRun`), and automation events through `owner.automations()`.
- **Risk:** medium. Every side effect the Workspace's `dispatch` runs in its `finally` (activity, webhooks, email, `runCI`,
  automations) needs an explicit post-write call. List them, test each.
- **Status (2026-10-15): built and deployed on the hosted demo.**
  - Routes: `git-receive-pack` and its advertisement, `/native/source/commit` and `/native/source/branch`.
  - Side effects:
    - after the response, the Worker calls the Workspace's `writeSettled(selection, ok, status)` RPC. It runs what the queue's
      `finally` ran (webhook and email drains, live activity) and the CI pass. It is not an admission.
    - `automationsQueued`, `notifyLanding` and `notifyPipeline` call the Workspace by RPC, as `PipelineRun` does.
    - `pipelineCoordinator` is the `PipelineRun` namespace.
  - Ordering and authority: the D1 ref reservation each write already takes. Its guard carries the grant, credential, identity
    and rules versions, so a committed revocation fences a write without queue order.
  - Found while measuring: every write also asked for an exclusive CI pass in the queue. Passes are now coalesced
    (`worker.mjs` `runCI`): writes during a pass share one more round, and a full batch asks for another.

### S3: Source reads and per-repository reads without the Workspace hop

- `/native/source/files|tree|blame|grep` run in the Worker (or in `RepositoryReads`, keeping its object cache).
- `confirmRead` re-checks D1 directly instead of calling `GetRepositoryAccess` on the Workspace, which today puts every
  per-repository read back into the Workspace queue.
- **Decision needed:** revocation semantics change from queued to committed, as in S1.
- **Status (2026-10-15): the MCP part is built and deployed on the hosted demo.** Remote MCP was most of the Workspace's load:
  agents poll `get_pull_request`.
  - The Worker reads the JSON-RPC body and serves what the Workspace would admit as a read or a transfer (`mcp.mjs` `mcpClass`):
    read tools, `initialize`, `tools/list`, `commit_changes` and `create_branch`.
  - Every repository read a tool makes is confirmed against D1 after it runs (`core.mjs` `confirmReadFromD1`): the request's
    credential, grant and role are read again, so a revocation committed during the read refuses its result.
  - Other tools (`open_pull_request`, `comment`) still go to the Workspace.
  - Still open in S3: `/native/source/files|tree|blame|grep`, and `RepositoryReads` calling `confirmReadFromD1` instead of the
    Workspace's `GetRepositoryAccess`.

### S4 (only if still needed): per-repository coordination object

- If, after S1–S3, collaboration writes (pull requests, checks, comments) still convoy, move the remaining exclusive work for a
  repository into a per-repository object.
- **After the S1–S3 runs, not needed yet.** At about 110 agents the Workspace's admission wait was 0 ms at p50 and 1.8 s at p95
  (`s2e`). `open_pull_request` took 2.2 s at p50 and CI reports 1.1 s.
- Repositories then stop sharing one queue. One hot repository still has one queue for its exclusive work, but without the
  transfers in it.

### S5: runner capacity that scales, with approval

Runner capacity comes from three places:
- Cloudflare Containers: PR test tasks, agent proposals, SSH host tasks.
- Self-hosted Forgejo and GitLab runners, for example the `golf-ci` kind cluster.
- Agent and SSH hosts: `max_concurrent` per host.

The base scaling above stops the forge from being the bottleneck; this phase makes runner capacity grow on purpose.

- **Every capacity knob is an installation policy, using the existing model:**
  - the operator allocates a ceiling at deploy (container `max_instances`, daily CI admissions, concurrent container tasks);
  - administrators set the working value at or below it;
  - narrowing saves at once;
  - widening needs the typed setting name and a fresh Access sign-in, and is audited.
  - Raising a ceiling itself is a deploy (`golf_cloudflare.py update`) that shows the plan and the cost change first.
- **Organization and repository shares:** concurrency and daily runs per organization and repository, within the installation
  value, following the admin → organization → repository policy hierarchy.
- **Self-hosted pools:**
  - Golf publishes queue depth and wait time per pool (labels or tags) as a metric an autoscaler can read, for example a
    Kubernetes HPA or KEDA scaler for the `golf-ci` runners;
  - a pool's concurrency cap is a policy;
  - Golf never starts machines itself.
- **Capacity requests:**
  - an administrator or organization owner proposes a higher limit, with the estimated cost change (S6);
  - an operator approves or declines in the admin UI;
  - the request, the approval and the applied value are audited.
- **Evidence:** a bench run at the new limit, with queue wait and cost per run recorded.

### S6: estimated costs in the admin UI (now and when scaling up)

An **Estimated costs** page under Admin → Operations.

- **Running now:**
  - month-to-date and projected month, per Cloudflare service: Workers requests and CPU, Durable Object requests and duration, D1
    rows read and written plus storage, R2 operations and storage, Queues, Containers vCPU, memory and disk time, Workers AI
    neurons, Vectorize, Artifacts;
  - the source is Cloudflare's analytics API (GraphQL), read with the existing read-only analytics token;
  - plan allowances (for example what Workers Paid includes) are subtracted and shown.
- **Rates:**
  - a reviewed price table in code, with the source URL and an "as of" date per rate, kept up to date in release review;
  - the page shows the date and links, labels every figure as an estimate, and is not a bill;
  - services Golf cannot price, or cannot read usage for, are listed as such, never shown as $0.
- **Scaling up (what if):**
  - inputs: agents, writes per agent per minute, pull requests landed per day, CI runs per day, concurrent containers, self-hosted
    runner hours;
  - output: the projected monthly cost per service, from **unit costs measured on this installation** (for example D1 rows and
    Durable Object requests per landed pull request, from the bench and from live analytics);
  - each assumption is shown and editable.
- **Tie-in with S5:** every capacity request and ceiling change shows the cost change before it is approved.
- **Usage Golf already records exactly** stays as recorded: AI runs (Workers AI usage, provider tokens and costs as reported) and
  agent tasks (usage as the tool reports it).

## Found while measuring

- **Merge bases on long histories (fixed).**
  - `repository-diff.mjs` `comparison()` fell back to reading the full ancestry of both tips, capped at 500 commits, whenever the
    base had moved by a merge.
  - On a repository past that size, every pull request whose base had moved failed its landing evaluation (`resource_exhausted`),
    and `autoLand` skipped it without a trace.
  - The fallback is now Git's date-ordered `paint_down_to_common`, bounded at 2,000 commits.
  - Verified on hosted: pull request #530 had waited 18 minutes with a passing check, and landed at the first sweep after the deploy.
- **Automatic CI passes (fixed).** Every write asked for an exclusive CI pass in the queue. Passes are now coalesced.
- **Busy merges (fixed).**
  - Artifacts answers a receive-pack it cannot take now with `ERR artifacts_git_receive_pack_busy`, before running any command.
  - The merge journal kept that as an unknown outcome, which fenced the whole repository until maintenance: two to seven minutes,
    with every write stalled.
  - It is now settled as `provider_refused` at once, and the land retries it.
  - At about 110 agents, applied writes went from bursts with four-minute gaps to 48–67 a minute.
- **Distance to D1 (future support, not scheduled).**
  - The Workspace runs next to the D1 primary (`ENAM` on the demo). The stateless Worker runs where the request lands: Seattle or
    Dublin in these runs.
  - Each D1 call from the Worker took about 100 ms, against about 20 ms from the object. A clone makes 5–6 calls.
  - Smart Placement (`placement: { mode: 'smart' }`) or a placement hint for the Worker would remove most of this. The Alchemy
    Worker resource does not expose placement yet. Support for it is a future deploy option, not part of this plan.
- **Logging.** `golf.land_soon_skipped` says why a targeted landing did not land a head. `golf.request_unconfirmed` records the error
  behind a generic 503.

## Outside Golf

- Artifacts answered `ERR artifacts_git_receive_pack_busy` under load. Every write to one repository (push, Source API commit,
  merge) is a receive-pack to the same Artifacts repository.
- Each phase's benchmark records how often the provider reports busy. If writes to one hot repository plateau there, the limit is
  the provider's per-repository concurrency, and the answer is batching (for example the land queue merging several pull requests
  per receive-pack), not Golf scale-out.
- `gitRequest` mints and revokes a 60 s Artifacts token on every call: two extra provider round-trips per Git operation. Reusing
  a token within a request is a cheap follow-up.

## Not in this plan

- Streaming pushes above 8 MiB stays tied to S2.
- Regex grep stays refused until S3 moves reads out of the shared object.
