# Scale-out plan: moving long I/O-bound work out of the Workspace Durable Object

Status: S1–S3 built; S1, S2 and the MCP part of S3 measured on the hosted demo, 2026-10-15. S6 built, its analytics reads checked against the live API. S4 not needed yet; S5 slice 1 (inventory, autoscaler metric, approved capacity requests) on hosted; slice 2 (pool caps, organization and repository runner shares) built and tested locally, not deployed. Follows AGENTIC_MODE_PLAN AM-1 item 5 and AM-6, and replaces the "RepositoryWrites split only if CPU
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
- **Status (2026-10-15, later): the rest of S3 is built.**
  - `/native/source/files|tree|blame|grep` run in the Worker. The route sets the read authority after the grant check, and
    `confirmReadFromD1` confirms it after the read.
  - `RepositoryReads` (the UI's per-repository reads) confirms with `confirmReadFromD1` instead of `GetRepositoryAccess` on the
    Workspace, so no repository read enters the Workspace queue.
  - Found while deploying it: `RepositoryReads` kept the Workspace stub from its constructor. The Workspace restarts on every deploy,
    and the kept stub stayed broken. For about three minutes after each deploy, per-repository reads (the UI's repository pages,
    anonymous public reads) answered 503 "Repository access could not be confirmed". With the D1 confirmation and a fresh stub per
    call, a deploy on the hosted demo kept 27 of 27 probe reads answering 200.
  - Regular-expression grep is unblocked, not enabled. A hostile pattern would now end its own Worker request at the CPU limit
    instead of stalling the shared object. Enabling it is a separate product change.

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
- **Status (2026-10-15): slice 1 deployed on the hosted demo (schema 49); slice 2 built and tested locally, not deployed (schema 52 not
  applied on hosted).** See [RUNNER_CAPACITY.md](RUNNER_CAPACITY.md).
  - **Inventory:** `cloudflare/forge/src/capacity.mjs`, `POST /native/capacity/read`, operations administrators only, in the
    stateless Worker. Page `/admin/capacity`, next to Estimated costs. It covers:
    - self-hosted Forgejo and GitLab runners, pooled by engine and label names with the claim's own matching rule: registered,
      active and online runners, running, queued and the oldest wait, plus jobs no active runner can take;
    - native pools, Cloudflare containers and agent and SSH hosts.
    - Container `max_instances` is not bound into the Worker, so the allocation is shown as not known. Golf's own admission limit
      (2 PR test and agent proposal containers) is shown as such.
  - **Metric:** `GET /native/capacity/metrics?engine=…&labels=…` for KEDA `metrics-api` or an HPA. It is read with a read-only
    `golf_capacity_` token that an administrator creates and revokes on the page; the token is shown once, stored as SHA-256,
    expires, and is accepted on no other route. The public Worker passes it through Access as a machine route. Golf never starts
    machines.
  - **Requests:** schema 49 `capacity_requests`. A request raises one field of `evidence`, `previews` or `agent-budgets`.
    - It is validated by the policy's own bounds; above the ceiling, up to what a deploy can allocate, it is marked needs-deploy.
    - The estimated monthly cost change uses S6's measured cost per CI run for daily admissions; other settings have no cost model
      and say so.
    - A different administrator approves or declines; the requester can withdraw.
    - Approval applies through `installation.mjs` `applyInstallationChange`, the `/native/installation` path, with the same typed
      confirmation, 10-minute Access sign-in for widening, revision fence and audit row.
    - A needs-deploy request records APPROVED with the `golf_cloudflare.py update` step, and is applied after the deploy raises the
      ceiling.
    - Every action is audited.
  - **Slice 2: pool caps and runner shares** (`capacity-policy.mjs`, `capacity-shares.mjs`, schema 52 `capacity_shares`):
    - **Pool caps:** the installation policy `runner-pools` caps running jobs per self-hosted pool (engine plus label names). The deploy
      value is "no caps". Narrowing saves at once; raising or removing a cap needs the typed key and a recent Access sign-in, and is
      audited.
    - **Shares:** running jobs and runs a day per organization (all its repositories) and per personal repository.
      - The installation sets them (`runner-shares`) and may enforce them. An organization owner narrows the organization's; a
        repository administrator narrows the repository's within its organization's.
      - Organization owners request more; a different operations administrator approves with the organization's name typed. The grant
        is written in the same batch.
    - **Enforced where work starts, atomically:**
      - a pool cap and the running shares are counts inside `claimPipelineJob`'s conditional `UPDATE`;
      - repositories and organizations at their share are left out of the candidates, so runners take other work instead of stalling;
      - the daily share is a count inside the run's conditional `INSERT`; a run over it is recorded `REFUSED` with the reason.
      - Concurrent claims are tested not to overshoot either limit.
    - **Inventory and metric:** each pool's cap and held jobs; each share's running, queued, held and runs today. The metric adds `held`,
      `claimable` and `cap`; the KEDA example now scales on `claimable`.
  - **Remaining for S5:**
    - a native pool's `max_parallel` as an installation policy, and requests that raise a pool cap;
    - shares for PR test containers, agent proposals and host tasks (slice 2 covers Actions pipeline jobs and runs);
    - container `max_instances` bound into the Worker;
    - container time in the request cost;
    - slice 2 on hosted (schema 52) and the organization and repository panels viewed there;
    - a bench run at a newly approved limit, with queue wait and cost per run recorded.

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
- **Status (2026-10-15): built, tested locally; not yet verified on the hosted demo.**
  - `cloudflare/forge/src/costs.mjs`, route `POST /native/costs/read` (`read` and `estimate`), operations administrators only;
    page `/admin/costs` (`web/src/EstimatedCosts.tsx`), next to AI usage in the admin navigation.
  - Price table in code, Workers Paid list prices checked against the pricing pages on 2026-10-15, one source URL per rate.
  - Usage: one GraphQL request per dataset, each with a month-to-date and a 7-day window alias, 5 s timeout each. A refused field,
    a refused token or a timeout degrades only that dataset's meters, with the reason.
  - Read: Workers requests (this Worker), Durable Object requests and active time (account), D1 rows (this database) and size,
    R2 Class A/B and storage (this installation's buckets), Queues operations (account), Artifacts operations (this namespace).
  - Not read, named as such: Workers CPU (`cpuTimeUs` is unconfirmed; read if the API accepts it), Durable Object SQLite rows and
    storage, Artifacts storage, Containers, Workers AI neurons (Golf's ledger is on AI usage), Vectorize.
  - What-if: unit costs per applied write, per landed pull request (both all-in) and per CI run, from the 7-day window over
    `git_operations` APPLIED, `land_operations` LANDED, `pipeline_runs` and container test runs; containers from concurrent
    count and instance size; self-hosted runners from an entered hourly rate. Every assumption is editable.
  - Deploy: `prepare.mjs` now binds `OPERATIONS_DATABASE_ID` and `OPERATIONS_BUCKETS`. Without them, D1 rows are read for the
    whole account and D1 size is not read.
  - **Open:** a hosted read to confirm each dataset and field. The S5 tie-in is built for daily admissions (S5 slice 1); other
    capacity settings have no cost model yet.
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

## Next measurements

The scale-out benchmark and the blog post ("110 agents. One repository.") promise these. Each run records success, latency,
Workspace admission wait and cost from Estimated costs (unit costs per applied write and per landed pull request).

1. **The full mix again at about 110 agents** with everything deployed. The last full run came before the landing fixes and lost
   its Source API committers to a setup fetch.
2. **Runner capacity at an approved limit (S5 evidence):** a capacity request approved by a second administrator, then a bench run
   with CI at the new limit: queue wait and cost per run.
3. **A bigger run** (for example about 250 agents), after 1 and 2, with abort criteria: the home page over 5 s, or 5xx bursts.
4. **Cost:**
   - billed Artifacts operations per landed pull request, before and after the isolate object cache;
   - token create/revoke per Git request (see "Outside Golf").
5. **Smart Placement** (future deploy support): D1 latency from the Worker before and after, when the deploy tooling supports it.

Each run is short (6 to 10 minutes plus the landing window) unless a longer one is the point, because benchmark runs are what drive
this installation's Artifacts bill.

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
- Regex grep: unblocked by S3, not enabled (see S3).
