# Agent workspace mode — proposal

> Superseded in part on 2026-10-14: stages 2–5 below are replaced by
> [`AGENTIC_MODE_PLAN.md`](AGENTIC_MODE_PLAN.md) (Source API, concurrent Git traffic,
> API tokens and remote MCP, landing without a global lock, the agentic inbox). The
> first increment and the constraints in this document still apply.

Status: first read-only native view implemented, 2026-10-13. Selective checkouts,
new agent execution and storage changes remain proposals. Existing portable Forgejo transition and native
Artifacts/D1/Workers decisions remain in force.

## What prompted this

Anthropic's [Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control)
describes Scion, an online, server-oriented system for an unusually busy monorepo.
Its relevant ideas are repository queries without checkouts, immutable object
caches, selective file materialization, and derived indexes computed eagerly or
on demand. Anthropic explicitly limits the applicability of replacing Git. Its
move toward post-merge testing reflects its workload, not a requirement for Golf.
The following design is our proposed application of those ideas, not a claim
that Golf has Scion's architecture or performance.

## Product shape

Add an optional **Agent workspace** view inside a repository. Keep the familiar
Code, Issues and Pull requests experience as the default. The workspace should
show a task's intent, assigned agent, base and proposed commit, changed paths,
review state, exact-source CI, preview, cost and landing outcome together.

Use a repository-local navigation entry, not another global user/organization
dropdown. Initially this should assemble existing agent proposals, PRs, evidence
and preview records. A new durable task entity is justified only if those records
cannot represent the workflow. Show absent capabilities explicitly.

## Sequence and acceptance gates

| Stage | Proposed work | Evidence required before progressing |
| --- | --- | --- |
| 0: Measure | Record checkout time/bytes, source API latency, index lag, cache hits and CI queue wait. Compare cold/warm runs and concurrency 1/4/16 on fixed small and large fixtures. | p50/p95, errors, resource cost and immutable source identities; separate network/auth time from source work. |
| 1: Present existing work | Compact task/proposal view using TanStack Router/Query/Form and shared global components. Link existing PR, evidence and preview rather than duplicate them. | Human and agent actions agree on current source and authority; stale evidence is visible; desktop/mobile navigation works. |
| 2: Avoid needless clones | Inventory existing resolve/tree/file/history/diff APIs. Let metadata-only agent tasks use them; add a missing query only for a demonstrated caller. | Results agree with Git on qualified fixtures, including merges, renames and shallow-history limits; fewer downloaded bytes for the same task. |
| 3: Selective job inputs | Pilot an opt-in, immutable file manifest for one reviewed CI profile. Materialize only declared source plus required build configuration/dependencies. Retain ordinary checkout fallback. | Same test result and source digest as checkout; executable bits, symlinks, submodules, LFS and Git-dependent tools handled or explicitly refused. |
| 4: Shared immutable work | Reuse existing source/index caches. Key derived results by installation, repository, commit and algorithm version. Precompute cheap hot metadata; defer costly blame/content indexes until used. | Cross-tenant isolation, current access checks, bounded storage/eviction, duplicate-work suppression, cache-loss recovery and measured provider savings. |
| 5: Higher throughput landing | Improve cancellation of superseded work and display dependent changes. Consider batched landing only after measuring contention. | Existing approval, protected-branch and exact-source tests still gate each accepted result; integration tests and rollback are demonstrated. |

## Constraints worth preserving

Sparse input is a performance choice, not directory-level authorization. Ordinary
Git access can expose reachable objects outside a selected directory. A future
path-permission feature needs an independently reviewed protocol and repository
boundary; it cannot be implemented by hiding files in the UI.

Authorize each source read before serving cached bytes, and recheck authority at
writes/landing. Immutable data does not make cached permission decisions safe.
Use the provider APIs; no direct forge database or repository mutations.

Keep derived indexes disposable and reconstructible from authoritative source.
Bound pre-reading by demand and budget: indexing every blob eagerly can make
cold starts slower and amplify costs. A cache outage must not create unlimited
fallback traffic to Artifacts or the portable forge.

Do not replace Git, introduce a custom object protocol, deploy host cache daemons,
or weaken required pre-merge checks for the retained demo. Reconsider a new
storage backend only after the staged measurements demonstrate a provider limit
that supported APIs, caching and selective materialization cannot address.

## First follow-up

Start with instrumentation and a read-only Agent workspace assembled from current
proposal/CI/preview records. Ship no automatic merges or new execution authority.
Treat responsiveness, correctness and reduced job startup cost as separate
acceptance criteria. Link this work to the existing agent, source indexing and CI
roadmaps rather than declaring a second complete forge implementation.


## First increment delivered

`/:owner/:repo/agents` and `/agents/:number` assemble existing PRs, current source,
agent/evidence states, test outcomes, source-qualified previews and an on-demand
report. Shared TanStack tables keep the view compact and searchable. The mode
adds no mutation endpoint, schema, execution authority or dependency. Existing
PR review/check pages provide the action controls. Reported token/call usage is
shown for agent runs; absent usage and monetary costs are not fabricated.

The initial native UI chunk is about 3.2 kB gzip. Lists are bounded to 100 PRs,
100 repository evidence runs and 100 previews, with visible truncation. It has no
cross-repository task graph, independent task creation, agent assignment editor,
or new portable-runtime consumer. The retained demo has CI evidence but agent
execution is disabled; no model was called to manufacture a proposal.

Operations now includes source/evidence/preview p50 and p95. The repeatable
Alchemy observability option enables its existing bounded history and sampled
logging. Browser qualification compares eight indexed, pinned repository
snapshots at concurrency 1/4/16; it is not cold-cache or fleet-scale proof.
[Measurements](compatibility/evidence/agent-workspace-reads-20261013.json) retain
exact identities, request outcomes, bytes and stage totals.

Stage 0 remains partial: checkout bytes/time, CI queue delay, index lag, large
monorepos and multi-tenant load still need measurements. Current cached reads
spend substantial time in D1 and final authority checks. Evidence and preview
inventories now use explicit read-only routes that overlap within the existing
eight-reader limit. Both authority and execution queues retain mutation fences;
the original mixed-action routes remain exclusive. No permission cache was added.
Further work should measure redundant current-source observations or a bounded
read projection. Do not infer that caching permissions or relaxing mutation
fences is safe from these timings.
