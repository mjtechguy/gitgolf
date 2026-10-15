# Scale-out plan: moving long I/O-bound work out of the Workspace Durable Object

Status: proposed 2026-10-15. Follows AGENTIC_MODE_PLAN AM-1 item 5 and AM-6, and replaces the "RepositoryWrites split only if CPU
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

### S2: pushes and Source API writes in the stateless Worker

- `git-receive-pack`, `/native/source/commit` and `/native/source/branch` run in the Worker. Their ordering is the D1 reservation
  they already take, and the 20 s and 30 s wait loops then occupy no shared slot.
- After a write: `owner.activityChanged()`, pipeline intake (`dispatchPipelineIntake` already runs outside the object for
  `PipelineRun`), and automation events through `owner.automations()`.
- **Risk:** medium. Every side effect the Workspace's `dispatch` runs in its `finally` (activity, webhooks, email, `runCI`,
  automations) needs an explicit post-write call. List them, test each.

### S3: Source reads and per-repository reads without the Workspace hop

- `/native/source/files|tree|blame|grep` run in the Worker (or in `RepositoryReads`, keeping its object cache).
- `confirmRead` re-checks D1 directly instead of calling `GetRepositoryAccess` on the Workspace, which today puts every
  per-repository read back into the Workspace queue.
- **Decision needed:** revocation semantics change from queued to committed, as in S1.

### S4 (only if still needed): per-repository coordination object

- If, after S1–S3, collaboration writes (pull requests, checks, comments) still convoy, move the remaining exclusive work for a
  repository into a per-repository object.
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
