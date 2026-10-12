# Golf Cloudflare build and scale plan

The [robustness and Operations execution plan](CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md) is the detailed implementation queue for the current reliability work. The integrated [Golf Operations dashboard](OPERATIONS.md) shows runtime metrics, service bindings, observations and maintenance results without deploying Grafana in Cloudflare. Its execution ledger distinguishes implemented source from hosted qualification.

Optional monetization follow-up (2026-10-09): discuss seller-controlled paid repository entitlements (time-bounded read access) and per-use Golf Apps/MCP/API/export charging after UI parity. Cloudflare Monetization Gateway uses x402 and signed payment context; verify origin authorization and retain current repository permission checks ([overview](https://developers.cloudflare.com/monetization-gateway/), [validation](https://developers.cloudflare.com/monetization-gateway/configuration/payment-validation/)). It is closed beta with current US buyer/seller eligibility. Payment does not confer write/merge authority or revoke downloaded copies. Do not automatically charge every Git protocol request. No payment rules, wallets, financial transactions or entitlement implementation are authorized by this planning discussion.

Database and identity follow-up (2026-10-09): the native workspace currently uses D1/SQLite. Cloudflare can also provision PlanetScale Postgres/MySQL and bill usage through the Cloudflare account, with Workers connections through Hyperdrive ([provider announcement](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)). Track this as an additional customer application resource and optional PostgreSQL backend evaluation; neither provisioning nor a native backend switch is implemented or live-qualified. Cloudflare Email Service is the candidate for transactional notifications and incoming email consumers; current native email consists of Access login codes only. Access supports account-wide logo/name/header/footer/background branding; exact Golf sign-in layout would need a separate Golf entry page and supported authentication handoff. Do not change unrelated Access applications through shared branding. Golf Apps discussion follows shared UI parity.

Native delivery increment (2026-10-09): [Access login and native reviewer controls](CLOUDFLARE_NATIVE_SETUP.md#access-login-and-native-reviewer-ui), current-source proposal comparison, automatic private static preview publication after approved passing tests, scoped preview service RPC, reviewer grants/expiry and optional single-dispatch Browser Run are implemented. The [status ledger](IMPLEMENTATION_STATUS.md) distinguishes local security/runtime qualification, hosted publication and remaining authenticated delivery gates. Access is the native UI's default sign-in; Golf retains workspace/repository authority. Public SaaS onboarding/IdPs and Access seat economics still require validation. This bounded static consumer is not the planned general app provisioning, protected integration or global SaaS acceptance.

Draft for discussion, 2026-10-07. Build a complete agent collaboration and application delivery workflow on Cloudflare, then extend it into a global managed SaaS. Keep the portable product usable without Cloudflare and let self-hosted operators adopt individual integrations.

This companion refines P5/P6/P7/P8 in the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md). The user selected fully Cloudflare-native hosting as the long-term managed SaaS target on 2026-10-07. The existing Gitea/Go/PostgreSQL core is a migration bridge, while the portable product retains its independent supported implementation. Native authority and forge cutover still require a concrete ADR and qualification; no existing owner changes merely because a service appears here. Current implementation and provider evidence remain in the [status ledger](IMPLEMENTATION_STATUS.md).

## Current priority: Cloudflare reliability and repository speed (2026-10-09)

The user prioritized a robust, seamless Cloudflare deployment before further runner/backend or integration expansion. The next milestone is a measured deployment and repository-browsing foundation on the existing native services. This is planned work, not a production-readiness claim; existing CF0–CF7 evidence remains in the status ledger.

The first hardening increment is implemented and deployed: repository reads have separate Durable Objects with a final current-authority check at the workspace; generic hashed assets retain their old bytes across releases and avoid per-asset Golf database reads behind Access. Private immutable navigation retains materialized observations for ten minutes within 64-query/8-MiB bounds. Directory reads paginate 100 entries from inventories bounded at 10,000 immediate entries; commit, directory and overview projections use private, digest-bound D1/R2 indexes. Languages and actual root license files are indexed from canonical immutable Git. Current authorization still uses first-primary D1 and the workspace mutation fence.

The signed-in eight-repository benchmark passed 48 exact-snapshot reads at concurrency four in EWR: first-pass p95 2,152 ms and subsequent-pass p95 322 ms. This is one user/workspace and small root/overview responses, not global, multi-tenant or arbitrary-file acceptance. The cold budget remains unmet. Release manifests, retained assets, guarded code rollback and original-key indexing/evidence reconciliation have source and runtime checks; a live canary/rollback drill, quarantined restore, generalized import recovery, dead-letter operations and scale qualification remain open. See the [capability inventory](CLOUDFLARE_CAPABILITY_INVENTORY.md) for every shared RPC and the [status ledger](IMPLEMENTATION_STATUS.md#cloudflare-repository-metadata-and-hardening-2026-10-09) for exact evidence.

Implement in this order:

1. **Measure and make releases safe.** Add redacted request IDs, Server-Timing, stage durations and version/schema diagnostics for Worker, DO queue, D1, Artifacts, rendering and background jobs. Establish signed-in browser cold/warm navigation and per-tenant load baselines using the imported repositories. Create separate staging/release manifests, additive migration checks, immutable retained asset sets, mixed-version contract tests, canary smoke checks and code rollback. A code rollback must not imply a destructive database rollback. Exercise interrupted deployment and restore into a disposable target. Cloudflare documents [eventual Worker/DO code rollout](https://developers.cloudflare.com/durable-objects/platform/known-issues/); test compatibility in both directions.

2. **Make the browsing path fast.** Deliver generic hashed JS/CSS/fonts through a versioned edge asset path under the configured Access policy without repeated Golf database reads for each file. Keep private API data separately authorized. Introduce a bounded per-user/repository/commit in-memory navigation cache, with current access checks before remounting private source and immediate purge on account/logout/denial. Reuse existing bootstrap contracts and deduplicate metadata/source requests. Build snapshot-bound paginated directory and path-history indexes asynchronously; keep current source readable while optional indexes are pending. Stop rescanning history on ordinary file navigation. Canonical Git stays in Artifacts; any R2 cache/index output is private, replaceable and keyed by tenant, provider identity and immutable source.

3. **Remove workspace-wide contention deliberately.** Separate repository read/index coordination from workspace identity/budget administration and per-run execution. Specify tenant routing, D1 partitions, placement and current authorization ownership before moving existing authority. Qualify repository/organization revocation and cross-repository operations across objects; splitting the existing mutation fence without a replacement is unsafe. Cloudflare recommends coordinating at a logical unit rather than a global singleton ([DO guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). Use D1 sessions/bookmarks and replicas for safe read models, while permission/revocation decisions retain qualified fresh authority; bookmarks alone do not reveal another actor's latest revocation ([D1 replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

4. **Make background work and recovery independent of the operator laptop.** Finish durable original-key retry/reconciliation for imports, indexing, CI, AI and preview provisioning using existing Queues/Workflows. Add bounded retries, dead-letter inspection, tenant fairness, backpressure, spending reservations and resource ceilings. Hosted expiry/reapers must retire disposable jobs/resources even if the local demo supervisor disappears. Verify duplicate delivery, worker eviction, provider throttling, lost responses, cleanup backlog and restoration of D1/Artifacts/R2 state without stale credentials or approvals becoming active.

5. **Prove scale and finish the supported experience.** Test multiple tenants and increasing concurrent browsers separately from expensive job capacity. Publish p50/p95/p99, errors, request counts and cost per operation. Exercise current read-denial behavior with warmed caches and other tenants' load. Complete native collaboration/settings consumers and image/large-file behavior under honest capability gates; upgrade execution breadth only after the browsing/deployment gate is stable. Evaluate ArtifactFS for large sandbox startup only after its FUSE/runtime/scoped-token contract is qualified ([ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)).

Proposed first performance budgets: visible interaction feedback within 100 ms; signed-in warm file/folder readiness p95 below 500 ms and cold readiness p95 below 1.5 seconds in each named test region. Define warm cache, payload sizes, concurrency and measured readiness explicitly; these are targets, not achieved global guarantees. Tab focus should issue no redundant source/image reads; route return should reuse immutable bytes after the required access check. Releases must keep already-open tabs usable. Increasing directory size must paginate rather than produce the current 100-entry refusal. No permission checks may be weakened to reach latency targets.

The next qualification packet is cold-read improvement, canary/rollback and quarantined restore, then multiple independent tenants with revocation and cost measurements. The existing disposable demo retains its explicit stop deadline; this packet does not extend it or close the global SaaS acceptance gate.

## Product outcomes

Golf connects repositories, coordinates concurrent agents, retains context and proposals, executes tests, provisions application resources, publishes protected previews and helps humans review exact changes. Cloudflare integrations serve both Golf itself and the applications developed through Golf.

Support two independent choices:

| Choice | Modes |
| --- | --- |
| Where Golf runs | Portable Compose/Kubernetes; Golf-managed Cloudflare-focused SaaS. |
| Who owns application resources | Customer Cloudflare account; Golf-managed tenant allocation. |

A self-hosted Golf instance may deploy to Cloudflare. A managed Golf customer may bring their own account. Resource identity, credentials, costs and deletion rights must follow the selected account model rather than the location of Golf's UI.

### Selected product defaults

The user selected these defaults on 2026-10-07:

- Organization/workspace tenancy owns projects, membership, resource allocations and budgets. Personal users receive a personal workspace. Repository permissions remain independently enforced; workspace membership alone does not reveal private repositories or previews.
- Implement Golf-managed application resources first for the competition and SaaS workflow, then customer-owned Cloudflare accounts through the same provisioning contracts. Self-hosted customer-account support remains part of the portable path.
- Private previews admit authenticated users with current repository read access. Repository access loss also removes preview access. Automated browser and agent tests use separate preview-scoped machine credentials.
- Canonical Git in the first native release uses Artifacts for eligible repositories. Larger repositories remain on the migration bridge until a Cloudflare-native large-repository path qualifies. Admission checks complete history and blob limits before migration; no silent truncation or automatic ownership switch is allowed.
- The first native forge milestone delivers repositories, permissions, issues, PRs, reviews, checks, concurrent agents and protected previews. Remaining forge features migrate afterward. Existing tenants stay on the bridge until their required feature contracts are supported.
- Eligible PR pushes automatically provision/update protected previews within an operator-approved resource policy and budget. Each push still requires authenticated durable event intake, current scoped automation authority and an exact source/configuration/resource plan. Requests outside that approved envelope require a newly reviewed plan; production deployment retains separate approval.

Map these defaults into the native authority ADR and provider acceptance. Account ownership, Access configuration or a cached permission observation cannot override current repository authorization.

Live prototype setup selected on 2026-10-07: use the repository-bound `golf` Cloudflare CLI OAuth profile and its verified account. The user enabled Workers Paid; subsequent namespace discovery succeeds. The approved testing envelope is **$10 USD/day including infrastructure and AI**. Treat this as admission/planning policy, not a provider-enforced billing cap. The bounded agent proof uses OpenCode1.18.34 and Workers AI GLM4.7 Flash in disposable owned resources. On 2026-10-08 the user confirmed **`previews.mjtechguy.com`**, with a separate hostname per preview, and **Golf-backed short-lived reviewer grants** backed by current repository read access. Native CLI inspection confirms `mjtechguy.com` is active in the selected account. The earlier `mhtechguy.com` spelling was corrected explicitly by the user. Cloudflare Access remains the outer gate; machine tests use distinct scoped credentials. These selections authorize the target and identity path, but do not establish deployed DNS, certificates, Access or application readiness.

## Competition milestone

Control hostname update (2026-10-08): use `gitgolf.mjtechguy.com` following the user's suggestion after the initial `golf.mjtechguy.com` selection. The separate [bridge setup](CLOUDFLARE_SETUP.md) now has source-qualified Workers assets/API routing, isolated Compose/TLS and R2 configuration. No control-domain deployment or canonical Git migration is established by that work. Artifacts remains the canonical Git destination for eligible native repositories; existing agent-fork proofs do not mean Gitea repositories have moved. Keep native repository/authority implementation central rather than treating the bridge as the completed Cloudflare track.

Demonstrate two real agents working concurrently from a recorded commit, with independent Artifacts repositories, retained task context, visible proposal comparison and a deliberate overlapping change or moved base. Test the combined candidate, deploy it with isolated D1/R2/AI bindings, verify its protected custom-domain preview and publish exact-version evidence into the PR.

The competition closes October 14, 2026 at 11:59 p.m. Pacific. Workers and Artifacts must participate in concurrent agent work. Submission requires a 5–10 minute video, source, run instructions and MIT, Apache 2.0 or BSD 2/3 licensing. Judging weights prototype originality/quality at 50%, collaboration at 25% and usability at 25%. Source: [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).

The demo application should make provisioned services observable: a small project dashboard with D1 records, R2 attachments and a Workers AI summary endpoint. One agent changes the UI, another changes the API, and a controlled overlap exercises integration review. The app is developed and deployed through Golf's actual product workflow. Clef recommends task/test routing; the selected coding harness performs the code changes.

The competition milestone does not require an entire forge rewrite, complete CI compatibility or every harness. Protected canonical merge remains unavailable until P0.8 passes. An exact tested candidate in a Golf-owned task repository can be reviewed and previewed without claiming protected canonical publication or production release.

Native PR evidence increment (2026-10-08): [Queues/Workflows/R2 and optional Clef/AI Gateway](IMPLEMENTATION_STATUS.md#native-queued-pr-evidence-2026-10-08-bounded-live-api-qualified) now participate in one actual private, source-bound native PR metadata workflow. This establishes the asynchronous evidence consumer and its separate allocation/cleanup contracts; it does not establish executed candidate tests, agent result ingestion, protected previews or managed application hosting. Those product consumers remain the next use of the services in the map below.

Subsequent execution increment (2026-10-08): [Containers/Sandbox tests and completion telemetry](IMPLEMENTATION_STATUS.md#native-pr-container-execution-and-metrics-2026-10-08-bounded-hosted-api-qualified) connect real exact-PR-head execution to that native authority. Hosted passing/failing test results, intercepted network denial, policy/concurrency bounds, immutable reports and complete teardown are qualified. Analytics Engine writes have source/unit/native build validation only. This narrows the CI gap; native agent task admission/editing and automatic protected application delivery remain the next product consumers. The approved unittest profile is not general Actions compatibility or fleet-scale acceptance.

Native agent increment (2026-10-09): [authorized PR agent execution](IMPLEMENTATION_STATUS.md#native-pr-agent-execution-2026-10-09-bounded-hosted-api-qualified) now connects two actual concurrent agents to current native PR authority and separate Artifacts forks, with tested proposal/context retention and complete teardown. This supersedes task admission/editing as an entirely unimplemented consumer; the initial API-only single-file profile still needs native controls, comparison/integration and automatic protected application delivery. The service map remains an adoption plan, not a claim that every integration or phase is complete.

## Architecture and ownership

The selected product destination and proposed native storage/coordination boundaries are recorded in [ADR0008](decisions/0008-cloudflare-native-saas-ownership.md). The bounded account inspection and live Worker/R2/Artifacts proof are described in the [foundation contract](CLOUDFLARE_FOUNDATION_CONTRACT.md); exact evidence and remaining product gates are in the status ledger.

Use the existing frontend, generated API contracts, identity/keyring, native forge adapter, run manifests, immutable objects, environment policies and deployment records. Add implemented Cloudflare consumers at those boundaries. Reuse Wrangler configuration and standard provider tooling; do not introduce another infrastructure language or generic provider framework.

| State or operation | First implementation | Cloudflare-native destination |
| --- | --- | --- |
| Canonical repositories, issues, PRs, reviews and forge permissions | Gitea through supported APIs; connected GitHub/GitLab retain their own authority. | Golf-owned collaboration with qualified Artifacts canonical storage or another proven Git backend; separate ADR and migration. |
| Effective access, approval policy, run admission and credentials | Existing Golf/PostgreSQL authority plus current native permissions. | Explicit tenant-owned authority partition and revocation contract; qualify D1/DO before cutover. |
| Task Git workspaces and proposals | Artifacts for eligible repositories; native Git fallback. | Same workspace contract, independently of canonical forge. |
| Immutable outputs and evidence | Existing private object-store contract, qualified on R2. | R2 with exact digest, account/resource identity and retained access policy. |
| Preview application data | Dedicated D1 and R2 resources; isolated bindings. | Same contract for customer and managed accounts. |
| Run coordination and live connections | DO owns its assigned provider coordination; Golf retains admission and terminal outcome. | Partition by project/run/session; no competing result owners. |
| Long-running provisioning steps | Workflows drives the provider lifecycle for an admitted Golf operation. | Tenant-sharded execution with the same operation identity and reconciliation rules. |
| Asynchronous work | Queues transports admitted work; outbox/event journal retains durable intent. | Independent bounded consumers and tenant fairness. |
| Search and analytics | Derived, access-controlled projections. | AI Search/Vectorize and Basin/Analytics Engine as workloads justify them. |

Record one owner for each state transition. A provider workflow may coordinate deployment steps, but cannot grant repository access, fabricate test results or approve a release. Do not simultaneously orchestrate one run through Golf CI and Workers Builds.

D1 is not a PostgreSQL connection replacement. A native control-plane migration needs schema, transaction, authority, restore and cutover qualification. Partition by tenant/project: D1 currently limits a database to 10 GB and executes its queries serially. Read replicas, caches and search indexes cannot establish current permission or revocation state. Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

The native managed service must own collaboration as well as storage: repository lifecycle, issues, PRs, reviews, checks, permissions, publication journals, protected integration and export/recovery. Artifacts supplies Git primitives rather than those forge features. Keep the same frontend/domain contracts across portable and native implementations, and use contract tests to control behavior differences. Scope the first native tenant to qualified repository sizes; larger repositories remain on the bridge until a Cloudflare-native storage path passes its own gates. Ephemeral Container disks or an unqualified R2 filesystem mount do not satisfy canonical Git persistence.

## Service adoption map

“Demo” means a proposed competition acceptance target, not an implemented integration. “Platform” means the subsequent repeatable developer workflow. “Scale” means a named expansion with its own gate.

| Service | Golf infrastructure use | Application or developer use | Delivery |
| --- | --- | --- | --- |
| Workers and static assets | Entry API, authenticated callbacks and broker endpoints. | Application/API hosting and previews. | Demo |
| Artifacts | Independent task forks, scoped Git access and source events. | Inspectable proposals, context and workspace history. | Demo |
| Clef / Clef Flash | Advisory task, test and escalation decisions. | Optional typed-decision API binding. | Demo |
| Workers AI | Qualified inference and summaries. | Provisioned AI endpoint in the demo app. | Demo |
| AI Gateway | Supported provider routing, usage and billing configuration. | Per-project inference visibility and controls. | Demo, subject to harness compatibility |
| Sandbox / Containers | Real Linux agent and test execution. | Development servers; deployed container applications later. | Demo / Platform |
| Durable Objects | Scoped coordination and live run updates. | Stateful application bindings. | Demo / Platform |
| Workflows | Provision, protect, deploy, verify and clean up. | Durable app workflows when requested. | Demo / Platform |
| Queues | Buffered indexing, notifications and cleanup. | Application queue provisioning. | Demo / Platform |
| D1 | A native metadata/authority migration only after its ADR. | Separate preview DB, schema and fixtures. | Demo / Platform |
| R2 | Immutable private outputs, logs and screenshots. | Isolated attachment storage and bindings. | Demo |
| Workers Previews / Builds | Explicit build ownership and deployment observations. | Stable PR and immutable deployment URLs. | Demo |
| DNS, custom domains and TLS | Approved preview namespace. | Protected branded development URLs. | Demo |
| Access / Zero Trust | Human and machine preview access. | Reviewer policy applied before publication. | Demo |
| Browser Run | Browser tests and screenshot evidence. | Inspect exact deployed behavior from the PR. | Demo |
| Secrets Store and Worker secrets | Trusted credential references. | Nonproduction, environment-scoped app secrets. | Platform; demo uses qualified supported mechanisms |
| Logs, traces and Analytics Engine | Correlated diagnostics and measured fleet behavior. | Commit/deployment-linked runtime troubleshooting. | Demo / Platform |
| Workers for Platforms | Managed execution of customer Workers. | Golf-hosted multi-tenant apps and previews. | Scale |
| Cloudflare for SaaS | Customer hostname/certificate lifecycle. | Customer-owned branded app domains. | Scale |
| KV | Rebuildable caches. | Isolated app namespaces. | Platform |
| Hyperdrive | Optional bridge to existing SQL origins. | Connect approved application databases. | Platform |
| AI Search / Vectorize | Permission-aware repository and evidence retrieval. | Search indexes provisioned for customer apps. | Platform |
| Agents SDK / Dynamic Workers | Durable interactive agents and scoped lightweight code/tool execution. | Agent applications and generated tools. | Platform, per concrete workflow |
| Web Search | External research with retained source provenance. | Optional application research feature. | Platform |
| Email Service | Review/run notifications and authenticated intake. | Application transactional mail. | Platform |
| Monetization Gateway / x402 | Optional paid API/MCP/export admission with verified payment context and independent repository authority. | Seller-selected paid repository read entitlements; per-use Golf Apps/agent tools. | Follow-up discussion; closed beta, eligibility and entitlement/revocation contracts required |
| Tunnel / Workers VPC | Approved private-origin connectivity. | Customer-private dependencies. | Platform |
| WAF / Turnstile / rate limits / API Shield | SaaS abuse controls appropriate to each protocol. | Application protection presets. | Platform |
| Flagship | Controlled product feature rollout. | Application flags when requested. | Platform |
| K2 | Replayable multi-consumer event streams. | Application event logs. | Scale |
| Basin | Run/deployment analytics over retained data. | Application analytics pipelines. | Scale |
| Agent Memory | Scoped retained context. | Agent application memory. | Scale; private-beta access required |
| Cloudflare CLI and official MCP tooling | Resource inventory, diagnosis and scoped provisioning tools. | Operator/agent setup under Golf policy. | Setup / Platform |

Media integrations such as Images, Stream and Realtime are available to application configuration and deployment plans when an actual app uses them. Add dedicated Golf controls only with a concrete consumer. Wallets remain a future exploration: current handle reservation does not establish a working payments feature.

Service references: [developer catalog](https://developers.cloudflare.com/), [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/), [Artifacts](https://developers.cloudflare.com/artifacts/), [Sandbox](https://developers.cloudflare.com/sandbox/), [Workflows](https://developers.cloudflare.com/workflows/), [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/), [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/), [K2](https://developers.cloudflare.com/k2/), [Basin](https://developers.cloudflare.com/basin/), [Agent Memory](https://developers.cloudflare.com/agent-memory/), [Wallets](https://developers.cloudflare.com/wallets/), [CLI](https://developers.cloudflare.com/cf/).

## Delivery phases and acceptance

### CF0 Account discovery and architecture decisions

Before provider writes, inspect the CLI/tool versions, selected account and zone, service availability, permissions, quotas, billing owner, existing resource inventory and preview-domain options. CLI login is operator access; product execution gets scoped credentials through the existing encrypted connection model. Establish a dedicated development namespace and an ownership manifest for test resources.

Record the selected Cloudflare-native SaaS destination, workspace tenancy, managed-resources-first order and repository-reader preview policy in the ownership/migration ADR. Decide the preview domain, identity provider, spending envelope and one supported harness/model combination. Document gaps without inventing success. Inspect installed service interfaces before selecting beta dependencies.

Gate: an account capability report, named resource scope, observable cost limits and an agreed ownership diagram. CLI access alone does not pass the gate.

The encrypted product Cloudflare profile now reuses Infrastructure connections with independent Workers/R2/D1/Artifacts read observations. Real PostgreSQL authority/encryption checks and the controlled-native served browser pass. This closes the management-profile slice, not native workspace tenancy or a provider billing cap; see the [product foundation contract](CLOUDFLARE_FOUNDATION_CONTRACT.md#product-account-profiles-and-operator-storage).

### CF1 Workers and real storage foundations

Deploy one small Worker using the selected toolchain. Qualify R2 through the existing `internal/objectstore` contract, including conditional create, replay, verified download, anonymous denial and cleanup. Create/import/fork one eligible Artifacts repository and exercise ordinary Git fetch/push with scoped credentials. Reuse existing versioned connection, credential and capability records.

Artifacts currently limits repositories to 1 GB and blobs to 32 MB; inspect complete history during admission and expose the native-workspace fallback. Git workspaces and binary build artifacts retain distinct storage roles. Source: [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Gate: real Worker/R2/Artifacts resource IDs, exact source hashes, denied-scope checks and cleanup evidence. A local S3-compatible fixture does not qualify R2.

The [2026-10-07 live foundation receipt](../.tmp/cloudflare-foundation/golf-cf1-20261007-9504515f/ownership.json) passes this bounded disposable resource proof, including actual bindings, immutable R2 behavior, verified import/fork/push, scoped denials and teardown. The [repeatable operator runner](../scripts/cloudflare-foundation-smoke.py) reuses native CLI OAuth and Golf's existing object store. Product versioned management connections/tenant authorization and full-history migration remain open. The temporary bearer-protected workers.dev probe does not qualify Access previews; its actual source/runtime and cleanup ceilings are in the foundation contract. Next is the CF2 task consumer and two overlapping real agent runs.

### CF2 Concurrent agents and candidate evidence

Start two real overlapping runs in independent Artifacts repositories. Use the existing harness and task contracts; retain prompt/instruction provenance, starting commit, checkpoints, stdout/events, cancellation and exact proposal commits. Add Clef advisory routing and qualify the selected inference/API Gateway path. Stream authorized updates through provider-local coordination without replacing Golf's current result authority.

Preserve both proposals during overlap or moved-base conflict. Create and test a new integration candidate; prior tests cannot become its checks. Store private logs and outputs in R2 and expose comparison, context and result provenance in Golf.

Cloudflare Containers supports Docker-in-Docker under specific settings, but rootless Docker and iptables manipulation are unsupported. Port the runtime deliberately and requalify egress, credential isolation, timeout, cancellation and cleanup rather than importing the local runner's proof. Source: [Containers FAQ](https://developers.cloudflare.com/containers/faq/).

Gate: real concurrent execution, successful and failed tests, conflict handling, cancellation and retained inspectable outputs. Harness installation alone is insufficient.

The [2026-10-08 operator prototype receipt](../.tmp/cloudflare-foundation/golf-cf1-20261008-0496f62e/ownership.json) passes concurrent native OpenCode/Workers AI execution, private Artifacts proposals, real test failure/success, Clef advice, in-flight cancellation/timeout, a real merge conflict, fresh exact-candidate tests, stale-parent promotion withholding and complete owned teardown. The [agent contract](CLOUDFLARE_AGENT_CONTRACT.md) records its narrow authority and execution bounds. Next, connect this runtime to Golf's existing authorized task/result consumer and comparison/context surfaces; the disposable operator proof does not complete full CF2 product acceptance.

### CF3 Application resource provisioning

Extend the existing environment/deployment consumer with a Cloudflare target. Read repository Wrangler/build configuration and the selected account policy; show the exact plan for D1, R2, bindings, nonproduction secrets and resource ownership. Start with the demo application's resource types, then extend supported binding types as consumers ship.

Persist desired/observed state, provider IDs and original operation identity before crossing provider effects. Inspect ambiguous outcomes before retrying. Adoption is read-before-write, with external-IaC resources kept under their selected owner. Cleanup deletes only resources owned by that environment and reports unresolved orphans.

Gate: repeatable create/inspect/reconcile/cleanup, missing permission, conflicting ownership, partial provider failure, stale attempt and preview-to-production isolation checks.

Migration093 implements the first operator storage consumer: one empty D1/private R2 pair tied to a current repository environment and immutable encrypted account version. Durable dispatch/acknowledgement, original-only inspection, concurrency/version/authority fences, collision refusal, unknown-effect retention, same-name replacement protection and exact-owned removal have real PostgreSQL/race checks. Native live Golf RPC creation/replay/cleanup passes with independent provider absence and credential revocation. The served UI passes saved-account selection, permission refusal, private editor clearing and absent-intent recovery. This storage slice does not deploy an application or satisfy the complete CF3 gate; Wrangler/build plans, bindings, secrets, resource policies/budgets and preview/production qualification remain required.

### CF4 DNS and protected PR previews

Automatically admit eligible PR-push previews only within the approved account, namespace, resource types, quotas and budget. Bind them to a revocable automation principal rather than a long-lived human browser session. Deduplicate events and fence superseded attempts so an older push cannot overwrite a newer PR link or deployment selection. Cancellation, policy changes and budget exhaustion must prevent later unapproved effects while preserving original-operation inspection and owned cleanup.

Provision an approved dedicated preview domain, using native wildcard preview routing where appropriate. Bind the candidate deployment to its exact source, artifact digest, configuration, resource set and environment version. Apply Access before publishing a link. Integrate reviewer admission with current repository access and use separate machine credentials for browser tests.

The selected base is `previews.mjtechguy.com`; each deployment receives its own child hostname. Keep the base separate from Golf's authenticated control origin. Do not change unrelated zone records or the account's existing Google Access identity provider. The disposable native qualification creates its own Golf OIDC provider and exact-host Access application; both are removed afterward. The existing Google provider is preserved.

Migration094 implements the first operator-configured Golf sign-in issuer through Access's [generic OIDC integration](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/). The separate issuer adds a reachable HTTPS Golf issuer, an exact registered Access callback, confidential client authentication, short-lived single-use authorization codes, signed identity tokens and public verification keys. It reuses encrypted managed sessions and current native identity checks. Operator signing/client secrets are mounted in owner-only files; product account-profile/keyring administration of those keys remains open. Keep Golf session cookies and provider credentials off preview origins; never give human reviewers a shared Access service token.

Reuse the portable preview grant contract: a 60-second, single-use, hashed launch grant bound to the exact deployment, reviewer and parent session. Adapt its trusted handoff to the Access login flow; test that an Access redirect cannot lose or disclose the grant. A valid Access identity token alone does not grant repository access. The preview broker must check the current repository reader and live Golf grant before returning application content, including after access loss or logout. Cloudflare signs its own Access token; Golf grants do not substitute for that signature. Browser grants and machine credentials remain separate. Source PostgreSQL/race and Worker boundary checks qualify the grant/broker behavior. An explicitly authorized existing Google Access seat can instead be bound by operator configuration to one native Golf reader; that external identity must authenticate through Google and still pass Golf’s repository checks. This does not change Golf-issued OIDC aliases or impersonate the Google account. The native test qualifies Access-before-route, TLS, exact artifact/binding health and actual email-code Access admission with a mapped existing seat. Browser artifact/storage delivery and repository revocation pass while both Access and Golf sessions remain live. Golf-issued alias admission remains seat-limited and the existing Google OAuth client is deleted; those sign-in modes are not marked native-qualified.

Verify DNS, certificate, routing, Access and application health independently. Test unauthenticated denial, permitted reviewer access, wrong reviewer/tenant denial, revocation and every alternate provider/custom hostname. Keep preview origins separate from Golf's authenticated origin.

Publish a stable PR URL and immutable exact-deployment URL through Golf's supported forge publication path. A link update is its own journaled effect, with current authority and ambiguity reconciliation. Closing the PR or reaching TTL expires access and schedules owned-resource cleanup; retained evidence has its own policy.

Worker Previews supplies code/config/URL isolation and automatic separate DO/Container resources. D1/R2/KV account resources need explicit separate bindings. Native provider PR comments do not establish a Golf/Gitea publication adapter. Source: [Worker Previews](https://developers.cloudflare.com/changelog/post/2026-09-22-worker-previews/).

Gate: protected custom-domain preview, exact-version PR receipt, Browser Run evidence and verified teardown. Compute health without access or TLS readiness does not make the preview ready.

### CF5 Competition rehearsal

Run the entire story from a clean fixture: task intake, overlapping agents, proposals/context, conflict, tested candidate, isolated app resources, protected preview, PR evidence and cleanup. Include real Clef routing and app inference where qualified. Record timings, supported versions, account prerequisites and known limits. Rehearse reproducible setup and failure recovery before recording the 5–10 minute demonstration.

Target a feature freeze by October 12 and rehearsal/recording on October 13, retaining October 14 for fixes and submission preparation. These are proposed checkpoints, not delivery guarantees. If a dependency threatens the date, preserve Workers, Artifacts, real concurrency and review/conflict behavior first; report any missed requested integration explicitly and retain its platform task.

Gate: repeatable live demo, source-bound evidence, run/cleanup instructions and prepared video. Source publication, license changes and submission are separate owner actions.

### CF6 Repeatable application platform and production delivery

Expand account onboarding, resource adoption, drift views, template detection and binding support. Add customer account mode and Golf-managed allocation with explicit credential/billing ownership. Bring Email Service, search, KV, private connectivity and other integrations into actual product consumers.

Deploy immutable outputs through the trusted broker. Production approval binds commit, output digest, effective configuration, environment and migrations. Validate health, gradual rollout where supported and rollback/recovery separately for code and data. Do not enable an independent on-push deployment route that bypasses this decision. Protected canonical publication remains dependent on P0.8.

Gate: new and adopted projects can provision, preview, promote, observe and recover through the same Golf policy contracts; arbitrary build commands cannot obtain production credentials.

### CF7 Global SaaS and measured scale

Implement the selected Cloudflare-native destination under an authority/forge migration ADR before moving live state. Specify tenant home/placement, repository ownership, D1 partitions, DO responsibilities, fresh authorization/revocation reads, import/export, rollback boundary and reconciliation across stores. Build a bounded native collaboration consumer first: repository, issue, PR, exact-commit review/check and permissions. Qualify protected Git publication and every ingress before enabling it. Migrate a disposable tenant first; preserve one writer during cutover. Add the remaining forge capabilities under the same compatibility and evidence contracts, with explicit unsupported states until they pass.

Run the managed control plane and forge state on qualified Cloudflare services; external Gitea/PostgreSQL is not a required component of the destination. Existing stateless Go helpers may run in qualified Containers where that is simpler than a rewrite. Keep the portable Go/PostgreSQL/Gitea implementation as its own supported hosting path. The bridge can serve existing tenants while native tenancy gains functionality, but native migration status must remain visible.

Partition work by tenant/project/run rather than one global DO, queue consumer or database. Separate active Linux execution capacity from agent records and live connections. Use per-tenant admission, weighted fairness, queue limits and provider quotas; distinguish exact authorized spending reservations from eventual edge rate limits. Add Workers for Platforms and Cloudflare for SaaS for managed customer applications/domains.

Measure queue wait, runtime start, test completion, preview readiness, p50/p95/p99 latency, failure/retry rate, provisioned resource use and cost per completed task. Start with 2, then 10 and 25 concurrent real jobs when account capacity and budget permit; agree larger load/soak targets from those results. Run disconnect, duplicate-delivery, worker loss, tenant overload, provider throttling and cleanup backlog scenarios. Report idle sessions and active execution separately.

Introduce K2 for replayable multi-consumer events and Basin for retained fleet analytics when those consumers need them. Qualify permission-aware search and memory before admitting private context. Regional failover and recovery must prove that restored credentials, leases and approvals do not resume with stale authority.

Gate: published workload/limits/results/cost, tenant isolation, saturation behavior and recovery proof. A scalable architecture diagram is not a capacity result.

### CF8 Portable parity and complete release

Exercise the same task/evidence/environment/deployment contracts on Compose/Kubernetes without Cloudflare. Preserve local-account access and portable object storage, execution, protected preview and notification paths. Cloudflare-specific APIs remain optional capabilities with explicit unsupported states.

Close the complete CI, protection, identity, harness, canonical recovery and release gates independently of the competition milestone. Compare both hosting paths using the same acceptance scenarios and retain target-specific deployment/restore limits.

Gate: complete release evidence for the claimed supported profile. The competition demo does not close the full product roadmap.

## Shared implementation and validation contract

Existing starting points are `internal/objectstore`, run/source/artifact consumers, the environment version/policy model and deployment intent/approval/read consumers. See [object storage](OBJECT_STORAGE_CONTRACT.md), [environments](REPOSITORY_ENVIRONMENTS_CONTRACT.md), [artifacts](WORKFLOW_ARTIFACTS_CONTRACT.md) and [static preview](LOCAL_STATIC_PREVIEW_CONTRACT.md). Reuse their identities, current authorization and original receipt patterns; broaden a consumer only with its own acceptance. The current static-preview adapter is bounded and is not a general Cloudflare runtime.

Every provider operation records connection/version, account, native target, environment, original intent, exact source/config/artifact, provider resource IDs, stage, observed outcome and cleanup status. Never retain provider credentials in manifests. Propagate correlation IDs into logs and test receipts.

Run appropriate local source, PostgreSQL and UI checks. Provider qualification then uses disposable real resources and independent readback, including failure paths. Keep fixtures distinct from live provider proof. Re-run changed dependencies rather than repeatedly running unrelated suites. Preserve the existing restriction on repository-hosted CI workflows.

### First coding milestone

Start with CF0/CF1: record the native ownership ADR, extend the existing versioned connection/capability consumer for selected Cloudflare operations, and ship one real Worker/R2/Artifacts vertical slice. Use native provider APIs/tooling and the existing object-store adapter; do not build every service adapter before an end-to-end consumer exists.

The milestone exercises scoped account inspection, a Worker request, a private immutable R2 write/read, and an eligible Artifacts import/fork/fetch/push. Record exact resources, operation identities and denied-scope/cleanup outcomes. Source checks may use controlled fixtures before CLI access; provider readiness requires actual resource evidence afterward. This milestone creates the foundation for CF2 concurrent execution and CF3/CF4 provisioning/previews, without claiming the full native forge is complete.

## Decisions for the next discussion

1. How should D1 and Durable Objects divide native durable records, serialization and current authority? The first native forge scope, Artifacts-first storage and workspace tenancy are already selected.
2. The selected account/profile, active `mjtechguy.com` zone, `previews.mjtechguy.com` base and $10/day testing envelope have a bounded native DNS/certificate/Worker/D1/R2 health and teardown proof. Native human admission, immutable content/storage and revocation now pass through the authorized existing seat and temporary email-code provider.
3. Golf-backed short-lived reviewer grants and the OIDC bridge are implemented for one operator-configured target. The bounded email-code browser admission/storage/revocation proof passes; durable automatic PR admission, provider reconciliation/publication and TTL cleanup still gate CF4.
4. Which supported coding harness/model should we qualify first, and which inference owner pays for agent runs versus application APIs?
5. What concrete resource/quotas policy defines the approved automatic-preview envelope, including retention, refresh, cancellation and budget admission? Automatic eligible previews and managed resources first/customer accounts next are already selected.

Resolve these in order while retaining the same end-to-end product goal. Provider inspection and implementation contracts can progress independently; dependent provisioning starts only when its target and ownership are known.
