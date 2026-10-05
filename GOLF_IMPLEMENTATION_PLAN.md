# Golf implementation plan

Status: product direction and implementation roadmap; completeness review and shared Gitea first-release decision incorporated on 2026-10-01. Provider proofs and implementation evidence remain required. Explicit defaults are engineering decisions that can be revisited through ADRs.

Execution evidence: the [implementation ledger](docs/IMPLEMENTATION_STATUS.md) records the local developer preview, including bounded repository/source/history/commit-diff, issue and PR/native-review reads, member-scoped organization browsing, own-account session activity, the JSON CLI and initial local MCP adapter, durable own-account repository creation and coordinated encrypted backup/fresh restore for the canonical Docker profile. Own-account SSH key management and real local HTTP/SSH Git transport qualification are recorded in the [Git access contract](docs/GIT_ACCESS_CONTRACT.md). Each adapter's protocol/native qualification is recorded separately. The [next local completion packets](docs/LOCAL_COMPLETION_NEXT.md) track remaining consumers after the deployed fork-merge, private RustFS artifact, release-browsing/private-download, bounded existing-tag publication and own-Star increments, with maintained multi-job Actions execution qualified and deployed. These increments do not mark an entire phase, v1 or the Cloudflare competition milestone complete.

Current acceptance gaps (2026-10-05): unchanged pinned Express CI was refused with zero runs; real Express/Flask imports do not establish upstream workflow compatibility. First target remains unchanged Requests lint.yml. [Trusted Git preparation](docs/RUNNER_GIT_PREPARATION_CONTRACT.md) now has exact-H/depth1 opaque TLS PACK transport and native SHA-1/SHA-256 root/child preparation in four actual network-none Docker containers, observed resource profiles, original admitted fixture archive/tree equality and safe Git metadata export. Preparation is unadvertised and undeployed: adversarial resource-exhaustion/lost-create recovery, actual job materialization/worker integration, actual enrolled Golf/Gitea historical-H checkout, separate job token/origin, pinned remote Node24 actions and dependency egress remain gates. The credential-free metadata envelope/native engine consumer, explicit fixed-file staging and shared worker validator now have source checks; approved digest-pinned Git job-image and actual engine/coordinator qualification remain required. Current workers still use source archives.

The real xterm console has actual controlled running-job/newline and served automatic-history/wheel proofs. Snapshot-bound diff Viewed/ranges and compact disclosures retain native commit/PR/theme/mobile evidence. Current local source `4e92a5e`/core and agent worker `8e29750` runs at unchanged schema066. Repository-admin issue labels and milestone change/clear pass deployed native/browser checks; assignee editing, broader issue-writer permissions and PR metadata remain open. Recorded agent activity pages automatically through its bounded journal; a real growing Codex journal still needs served qualification. Unsupported monetary caps now block policy saves, previews and execution; zero permits supported subscription tasks without a Golf monetary cap, and paid API billing remains unavailable. Broader issue parity needs server-side search/filtering, comment edit/delete/reactions/timeline, subscriptions/templates/attachments and their role/live/uncertain-write acceptance. Trusted worker preparation composition `85e7db5` and job-scoped read credentials have source work; actual worker delivery/checkout and engine qualification remain gates, including the unchanged2-GiB Docker reserve. Static-preview067 remains unqualified locally; TLS/browser/runtime and latest-schema recovery remain open. Full Settings readiness, upstream CI, full repository parity and either infrastructure track are not marked complete. See the [phase overview and exact implementation evidence](docs/IMPLEMENTATION_STATUS.md).


Prepared: 2026-10-01. Provider-neutral capability administration and next execution sequence reviewed: 2026-10-02. Provider documentation and limits must be rechecked when implementing each integration.

Historical reference: [original planning conversation](docs/archive/plan-conversation-2026-10-01.md). That conversation contains claims about a previous build that are not verified by this checkout.

## Contents

1. [Product, requirements, and release boundary](#1-product-requirements-and-release-boundary)
2. [Architecture and authoritative ownership](#2-architecture-and-authoritative-ownership)
3. [Technology guide adoption](#3-technology-guide-adoption)
4. [Forge backends and collaboration](#4-forge-backends-and-collaboration)
5. [GitHub/GitLab connections and direct import](#5-githubgitlab-connections-and-direct-import)
6. [Modern interface and themes](#6-modern-interface-and-themes)
7. [Actions and GitLab pipeline compatibility](#7-actions-and-gitlab-pipeline-compatibility)
8. [Runners, isolation, and autoscaling](#8-runners-isolation-and-autoscaling)
9. [Agent automations, protocols, and authentication](#9-agent-automations-protocols-and-authentication)
10. [Cloudflare integrations](#10-cloudflare-integrations)
11. [Environment setup, protected previews, and production CD](#11-environment-setup-protected-previews-and-production-cd)
12. [Public interfaces and durable contracts](#12-public-interfaces-and-durable-contracts)
13. [Installation profiles, OSS, and enterprise](#13-installation-profiles-oss-and-enterprise)
14. [Security, supply chain, and government capabilities](#14-security-supply-chain-and-government-capabilities)
15. [Performance, cost, reliability, and recovery](#15-performance-cost-reliability-and-recovery)
16. [Implementation phases and tasks](#16-implementation-phases-and-tasks)
17. [Verification and release gates](#17-verification-and-release-gates)
18. [Risks, defaults, and deferred work](#18-risks-defaults-and-deferred-work)
19. [Primary references](#19-primary-references)
20. [Research review and incorporated decisions](#20-research-review-and-incorporated-decisions)
21. [Latest Cloudflare announcements and adoption register](#21-latest-cloudflare-announcements-and-adoption-register)
22. [Cloudflare showcase and portable proof](#22-cloudflare-showcase-and-portable-proof)
23. [Requirement coverage and delivery controls](#23-requirement-coverage-and-delivery-controls)
24. [Marketing and versioned documentation sites](#24-marketing-and-versioned-documentation-sites)

## 1. Product, requirements, and release boundary

### 1.1 Purpose

Golf is a better, more agentic, faster, and scalable GitHub replacement. Humans and coding agents use the same repository, collaboration, execution, and delivery operations under the same server-enforced authorization.

AI is optional. Git hosting, collaboration, deterministic automation, CI/CD, email/webhooks, protected previews, deployment and recovery work with every model provider and coding harness disabled. Agent-ready APIs, permissions and evidence remain useful to CLI tools, scripts and external automation. AI configuration is opt-in, never an installation, account, repository or core-workflow prerequisite.

The complete development loop is:

> Connect or import code → collaborate → run CI and agents → inspect a protected deployment → review evidence → merge → deploy production → observe → recover.

Golf must also enhance repositories that remain on GitHub or GitLab. Direct migration is supported, but is not required before customers can use Golf's agents, runners, previews, or deployment features.

### 1.2 Two infrastructure tracks

| Track | Required behavior |
| --- | --- |
| Cloudflare | First-class managed integrations across edge delivery, compute, runners, inference, storage, orchestration, protected previews, production deployment, DNS, access, and observability. |
| Portable/self-hosted | Runs in Docker Compose and Kubernetes without Cloudflare. May opt into individual Cloudflare integrations. Essential forge, CI, identity, agent, and delivery behavior has a portable implementation. |

The Cloudflare competition applies only to the Cloudflare-focused track. The portable track must remain fully runnable in Docker Compose or Kubernetes with no Cloudflare account; operators can select individual Cloudflare-compatible backends and mix them with local or other providers.

Deployment defaults are local PostgreSQL and RustFS object storage for Compose/Kubernetes. Database and object-storage choices are independent: Compose may use AWS S3, EKS may use managed PostgreSQL, and either may use R2. The Admin portal exposes encrypted, versioned connection profiles, current deployment defaults and connection tests. Activating object storage binds new CI sources to that exact profile version; prior sources retain their original address. Database profiles are staged for operator cutover, since changing a connection does not move data. Development installations are disposable and may be reset rather than migrated. Kubernetes uses an independently installed CNPG/Barman profile; Valkey is optional and is added only with a measured consumer. See [ADR-0007](docs/decisions/0007-postgresql-platform-and-optional-valkey.md) and [object storage contract](docs/OBJECT_STORAGE_CONTRACT.md).

These are infrastructure tracks, not separate products or editions. Use the same frontend, API contracts, domain rules, and permissions. A portable installation may use R2 or Workers AI without enabling every Cloudflare product.

### 1.3 Settled decisions

| Area | Decision |
| --- | --- |
| Name | Golf throughout UI, commands, documentation, and distributions. |
| Core | Shared portable Go/PostgreSQL core; thin TypeScript Workers integrations where appropriate. |
| Forge foundation | Gitea-backed in both infrastructure tracks for v1; Golf-native is conditional later work. |
| Pipeline inputs | GitHub Actions and GitLab CI/CD, with a published compatibility contract. |
| Runner OS | Linux in v1; unsupported OS jobs are blocked explicitly. |
| Execution | Customer hosts/VMs/Kubernetes and eligible scalable Cloudflare execution. |
| Agents | Claude Code, Codex, OpenCode, Grok Build, and Pi. |
| Authentication | Native account/subscription login where supported, API credentials, personal and managed runners. |
| Default authority | Agents propose PRs; explicit policy may authorize automatic merge, release, and deployment. |
| Inference | Optional; Workers AI is first-class when enabled, alongside Anthropic, OpenAI, xAI, compatible APIs, and local inference. |
| Protocols | UI, CLI, typed API, MCP, and ACP where the selected agent supports it. |
| UI | Modern responsive light/dark themes; dark is black/dark charcoal, not navy. |
| Cloud accounts | Customer-owned accounts first; Golf-managed hosting later. |
| Editions | Permissive OSS core and optional enterprise capabilities, with one shared core. |
| Guide | Technology Selection Guide baseline with explicit ADRs and verification for deviations. |

### 1.4 v1 boundary

V1 includes organizations/teams, repositories and Git protocols, LFS, issues/boards, PRs/reviews, branch protection, checks, releases, import/export, live GitHub/GitLab connections, supported Actions/GitLab pipelines, scalable Linux runners, all five agents, inference providers, protected previews, and production CD.

Both infrastructure tracks must work for this common surface using the same Gitea-backed forge contract. The Cloudflare track is hybrid: Gitea and Golf's authoritative core run on supported persistent origin infrastructure while Cloudflare supplies qualified developer services. A second forge implementation is not a v1 requirement.

Discussions, wikis, package registries, richer security dashboards, hosted interactive IDEs, additional OS support, and broader provider API compatibility follow as explicit expansion work. The core-forge-plus-CI/CD release boundary is the working default; broader GitHub/GitLab parity requires additional published contracts.

### 1.5 What counts as completed

A feature is complete when its real integration works, failures are represented correctly, and its acceptance tests pass. Mock execution and placeholder deployment links cannot appear as completed production capability.

Maintain separate implementation state (`planned`, `implemented`, `verified`) and installation state (`disabled`, `unconfigured`, `ready`, `degraded`). An integration is available only when verified and ready in the installation.

## 2. Architecture and authoritative ownership

### 2.1 Initial topology

```mermaid
flowchart TD
  Client[Browser / Git / CLI / API / agents] --> Edge[Optional Cloudflare edge]
  Client --> Core[Golf Go core]
  Edge --> Core
  Core --> Forge[Gitea forge through supported APIs]
  Core --> DB[PostgreSQL and transactional outbox]
  Forge --> Git[Canonical native Git storage]
  Core --> Objects[Filesystem / S3-compatible storage / R2]
  Core --> Scheduler[Pipeline and automation scheduler]
  Scheduler --> Own[Customer Linux pools and Kubernetes]
  Scheduler --> CF[Cloudflare execution adapters]
  Own --> Delivery[Preview and production deployment]
  CF --> Delivery
```

Start with a modular Go application, separately runnable background workers, and runner/deployment processes. Scale these independently when needed. Do not create a dozen services before their operational boundaries are justified.

The initial Cloudflare track is hybrid: Golf's authoritative core, Gitea and canonical Git run on customer or managed origin infrastructure while Cloudflare supplies extensive managed functions. Qualify its reachability, persistent storage, backups and failure behavior alongside the Cloudflare adapters. An all-Cloudflare forge is a separate architecture decision, not a claim of this release.

### 2.2 Owners

| Data/operation | v1 authority in both tracks |
| --- | --- |
| Repository metadata, issues, PRs, reviews, releases, forge permissions | Gitea, through supported Golf integration. |
| Canonical Git | Gitea-managed native repositories and supported Git receive paths. |
| Tasks, automations, workspaces, agent runs | Golf. |
| Pipeline orchestration, job attempts, runner leases | Golf; duplicate Gitea Actions execution disabled. |
| Projects, environments, deployment policy and records | Golf. |
| Golf membership and credential references | Golf, mapped to Gitea identities; never writes Gitea's database directly. |
| Effective repository access | Gitea authorization plus restrictive Golf policy. |
| Search, read caches, activity projections | Rebuildable derived state. |

Do not create a second editable PR or repository-permission database. Store Gitea identifiers and read projections, not competing authorities. Golf-specific policies can restrict operations but cannot grant access denied by Gitea. Gitea and Golf use separately owned databases and roles, even when they share a PostgreSQL deployment; each runs only its own supported migrations.

A repository has one canonical forge: Gitea for Golf-hosted repositories, or its original GitHub/GitLab provider in connected mode. Origin cutover and Gitea instance relocation are fenced migrations with validation, not toggles that start two writers. Any later native-forge adoption requires the same explicit migration boundary.

### 2.3 Provider boundaries

Create interfaces only where the plan has actual multiple implementations: object storage, executor, inference, origin connection, and deployment targets. Use a concrete Gitea integration with small operation sets and behavior tests; do not build a speculative native-forge abstraction. Connected-origin adapters retain their distinct source-of-truth semantics.

The Gitea and connected-origin capability catalogs report supported operations and known limitations. Infrastructure track, Gitea version or deployment profile must not silently change protection or approval semantics.

### 2.3.1 Capabilities are Golf features; providers supply implementations

A capability identifies a developer outcome, not a vendor: event intake, workflow execution, agent tasks, notifications, webhook delivery, protected previews, production deployment, object storage or optional inference. Each remains available to implement and operate on the portable track without Cloudflare. Running Claude Code, Codex, OpenCode, Grok or pi on customer machines does not require Workers, Workers AI, Sandbox or any Cloudflare account. AI-disabled installations still run deterministic tasks, Git operations, CI and delivery.

Keep four independently selected axes: **forge/origin**, **execution machine/pool**, **coding harness and its supported authentication/model connection**, and **delivery/infrastructure provider**. A repository can use native Gitea with a Docker worker, a user-authorized coding harness, R2 objects and an SMTP provider. Another can use the same core with Kubernetes jobs and Cloudflare previews. A harness subscription login is neither Golf login nor a general inference API credential. An installed binary is not a working authenticated connection. Sections 9.3–9.6 retain each provider's actual compatibility and authentication limits.

| Golf capability | Portable implementation target | Optional Cloudflare implementation | Current boundary |
| --- | --- | --- | --- |
| Canonical Git/collaboration | Gitea supported APIs and Git transports; connected origins later | Hybrid origin with optional edge protection; eligible Artifacts task repositories | Shared native forge; protected publication gate remains open. |
| Event intake and task fan-out | Verified native/provider webhooks, PostgreSQL event records/outbox and workers | Workers ingress/Queues or provider-native events with identical normalization | Native HMAC push intake and bounded sponsor-authored shell admission are qualified; broader event adapters remain planned. |
| Durable coordination | PostgreSQL queue/materialization records, deduplication, leases and bounded Golf coordinator processes | Workflows for durable multi-step waits/approvals/provider steps; Queues for buffering/delivery | PostgreSQL stores authority and run history. Managed Cloudflare coordination is a planned adapter, not an installed local dependency. |
| CI execution | Existing isolated Docker worker, later qualified Kubernetes/VM pools | Eligible Sandbox/Containers adapters with scheduler admission | Bounded manual and sponsor-authored branch-push one-job shell execution are qualified; native engine parity is not complete. |
| Agent tasks | Registered customer machines/isolated pools running the selected native harness | Eligible Sandbox task execution; optional Agents SDK coordination | All five harnesses require separate actual execution/auth qualification. |
| Objects/evidence | PostgreSQL or version-bound RustFS/S3-compatible connections | R2 through the same object contract | Real RustFS is qualified; configured R2-compatible metadata is not actual R2 qualification. |
| Email and webhook delivery | SMTP/API mail adapters and durable HTTP webhook delivery workers | Email Service plus optionally Workers/Queues delivery | Golf login aliases exist; verified mail, notification transport and delivery remain planned. |
| Protected preview and production CD | Authorized Compose/Kubernetes deployment runners plus separate preview authentication/routing | Workers/assets/Containers, Access, DNS/TLS and scoped application bindings | No production-ready preview/CD adapter is claimed. |
| Inference/retrieval | Direct model APIs or compatible/local endpoints and authorized derived search | Workers AI/AI Gateway and eligible Vectorize/AI Search | Optional, independently owned connection; never required for Git or deterministic automation. |

A provider selection binds the specific capability/scope/environment to an immutable connection/resource version and policy revision. Defaults may be inherited from the installation or organization but cannot expand native authority or a parent ceiling. Changes show the affected scopes and queued/running work; they apply to new authorized attempts, while existing source/deployment records retain historical bindings. Switching a provider is not migrating a database or moving objects. No hidden fallback may change billing owner, data region, trust, authentication or deployment target.

A worker process executes work; a queue/database/workflow engine coordinates it. For the current bounded portable shell catalog, PostgreSQL plus the existing Docker worker is sufficient; PostgreSQL does not run containers or coding harnesses. Kubernetes Jobs provide an additional executor target. On the Cloudflare track, [Workflows](https://developers.cloudflare.com/workflows/) can implement durable multi-step waits/approvals and provider orchestration, [Queues](https://developers.cloudflare.com/queues/) can buffer/fan out delivery, and [Sandboxes](https://developers.cloudflare.com/sandbox/)/[Containers](https://developers.cloudflare.com/containers/) can supply qualified execution environments. Workers alone are not a Linux shell/harness host. Select one orchestration owner for each run and record provider/resource/instance/attempt bindings; do not run competing PostgreSQL and Workflows dispatchers for the same work. Cloudflare orchestration still calls Golf's current admission/attempt/result boundaries; a managed step or delivered message is not repository authority. Disable execution/promotion retries where outcomes are ambiguous; safe read-only preparation retries remain bounded. Complex DAGs and long-lived approval workflows justify the appropriate engine when implemented, without making it a portable-core dependency.

Build this incrementally inside the current modular core and existing settings/connection patterns. Add an adapter only alongside a runnable consumer and meaningful contract test; do not scaffold a universal plugin framework or duplicate authoritative permission/resource databases. Existing object profiles establish the initial immutable-binding pattern, not evidence that every future provider picker is implemented.

### 2.3.2 Capability administration and operational evidence

Provide generic **Golf capabilities** pages at installation/organization/repository/project scope, with authorized per-capability provider selection and an explanation of effective inherited policy. Provide a separate **Cloudflare integrations** view that maps those same capabilities to usable Cloudflare services, credentials and resources. It is an implementation/health view, not a second feature system or an implication that portable agent/email/CI features depend on Cloudflare.

For each function show: selected provider and immutable connection version; owner/scope/environment; supported operation/version; required versus granted permissions; masked credential presence/expiry and authentication mode; bound account/zone/bucket/pool/domain resources; applicable quota/region/data rules; last test time/result/evidence/version; observed runtime health; current policy eligibility; and a safe reason/remediation when unavailable. Resource inventories contain secret metadata only. Read permission to a connection does not grant write permission or reveal its credentials.

Keep independent facts rather than one optimistic green badge: **implementation supported**, **configuration present**, **credentials authorized**, **resources bound**, **verification passed**, **policy permitted**, and **runtime operational**. Configured is not verified; a successful connectivity probe is not a successful developer operation; a historical verification is not current operational readiness. Define probe freshness and invalidate evidence after relevant credential/resource/configuration changes. Distinguish no consumer, not configured, unsupported, needs authorization, verifying, verified, degraded, revoked and operational states; show which fact caused the state. Do not mark a whole account healthy when only one bucket operation passed.

Tests must exercise missing/expired scopes, wrong tenant/resource, stale verification, partial provisioning, denied inherited policy, provider outage and revoked credentials. The same domain service enforces selection and operations for browser/API/CLI/MCP/ACP; adding another client surface cannot increase authority or bypass approval. Scoped capability reads remain separate from granting connections, dispatching work or activating production resources.

Capability setup uses a full settings page reached from Status: **Configure** for an implemented unbound consumer, **Manage** for saved connections, and **Setup not available yet** for unimplemented adapters. Actions name narrower supported operations (for example, Manage policies or Configure source storage) when they cannot configure the whole function. Never derive connection presence from the readiness badge alone. Settings lead with current bindings and a searchable/sortable connection inventory; explicit New/Edit opens shared TanStack Form editors, and confirmation modals only confirm destructive actions. The setup flow is add/select connection → bind resources → test the exact supported operation → select scope/default → enable, with secret write-only fields and server-enforced current authority.

Save multiple connections without requiring all to be active. PostgreSQL has one active binding per database role; storage has a default per implemented purpose, not one universal bucket. Email has a default sender per scope. Runner pools, coding-agent harness connections, webhook destinations/subscriptions and deployment targets can have multiple active entries, with explicit task/environment selection. Resolve authorized instance → organization → repository → environment defaults under inherited policy ceilings. Pin each run/delivery/deployment to an immutable connection version; switching defaults affects new work only. Database activation requires a separately qualified migration/cutover. Do not offer automatic failover or credential sharing across providers without a qualified consumer contract. Cloudflare account credentials may be reused only through explicit authorized per-function resource bindings, operation evidence and permission checks.

Current UI increment links Status to existing infrastructure profiles and execution policies; R2 setup is explicitly limited to source-storage configuration and does not establish Cloudflare qualification. Native event intake remains operator deployment configuration. Coding-agent, notification, email, deployment and other Cloudflare setup remain unavailable until their real adapters and credential/operation contracts ship. These are N4 entry points, not completion of N4 or the remaining consumers.

### 2.3.3 Deployment composition, validation and cost preview

Offer an **Admin portal → Deployment** inventory and explicit Configure/Edit flow with three starting presets: Local, Hybrid and Cloudflare-focused. Presets select defaults, not a new deployment engine or an all-or-nothing provider switch. The same per-function picker resolves supported backend connections: application compute, PostgreSQL roles, canonical Git storage, CI/agent pools, source/artifact/backup storage, email/notifications, preview/production targets, DNS/auth and observability. Show inherited defaults, selected resources and unsupported combinations before a change. A local Compose installation can opt into only R2 or DNS while retaining local databases, Git and execution. Kubernetes or remote PostgreSQL/S3 use the same capability contracts; Cloudflare remains optional in the portable track.

The implemented developer bootstrap is `make dev` / `make local-up`, combining the core, RustFS and Docker worker overlays, private credential initialization and source-bucket initialization. It preserves existing secrets/volumes and default-deny execution policies. It is a local development profile for implemented consumers, not a statement that the remaining agent/email/CD functions are complete. Valkey is not required by the current PostgreSQL queue/lease implementation; add it only for a qualified consumer with measured need. A release packaging task must validate first install, repeated start, image/port conflict, restart, local credential enrollment, Git/CI/source-storage smoke, upgrades and the full chosen topology's backup/restore. The canonical three-service recovery proof does not cover the RustFS/worker overlays.

The future deployment flow is **choose preset → pick functions/providers → connect account/backends → bind existing or planned resources → validate → review deployment and cost diff → apply approved plan → verify each function**. Store desired and observed state separately with immutable plan/config/connection versions, current scope authorization and resumable operation evidence. Adoption of existing buckets/zones/projects is explicit; never silently mutate unrelated resources. Current settings may expose only supported operations; no dead deploy buttons, fake connection checks or optimistic account-level readiness.

Validation includes account ownership, precise API scopes, service/plan eligibility, quotas/capacity, approved images/runtime, network/egress, exact zones/buckets/domains, TLS/hostname ownership, region/data policy, secrets, state durability and recovery. Resolve dependencies (for example, a qualified source store for an executor) and report the exact blocking function. Separate nonmutating preflight from bounded create/read/delete probes with cleanup. Changing a default is distinct from moving existing data; database/Git/object migrations require fenced cutover, reconciliation and rollback rather than a dropdown-triggered migration.

Cost preview is an estimate with dated official price sources, currency, account-plan/included-usage assumptions, shared allowance treatment and confidence range. Inputs include developer/repository counts, storage/growth/retention, Git transfer, CI/agent minutes and peak concurrency, allocated memory/disk, active CPU, warm/idle/sleep policy, provider requests/egress, previews/TTL, logs, email and optional model billing. Show incremental and total fixed/usage costs, low/expected/high scenarios, unavailable negotiated prices and excluded charges. Compare estimated and measured usage; Golf quotas, concurrency, retention and admissions can stop Golf-owned new work, but do not claim a provider-wide billing cap. Config changes invalidate the estimate/approval snapshot; actual-cost ingestion needs its own provider permission and freshness evidence.

**Cloudflare runtime qualification (official documentation reviewed 2026-10-02):** [Containers FAQ](https://developers.cloudflare.com/containers/faq/) documents ephemeral disks by default, immutable point-in-time snapshots for the durable_object scheduling policy, R2/FUSE mounts with different performance, explicit instance routing and no built-in stateless autoscaler yet. Docker-in-Docker is documented with constrained network setup and a root daemon; this does not inherit Golf's local worker isolation proof. [Pricing](https://developers.cloudflare.com/containers/platform/pricing/) bills provisioned memory/disk, active CPU, egress and the associated Workers/Durable Objects; [limits](https://developers.cloudflare.com/containers/platform/limits/) constrain instance sizes and account capacity. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) connects to supported existing PostgreSQL/MySQL instances; it is not a PostgreSQL hosting replacement. Revalidate these moving contracts before qualification and refresh estimates from current published rates.

A Cloudflare-focused topology may host qualified application/execution components in Workers/Containers while externalizing durable state. An **entirely Cloudflare-hosted** topology remains a separate unresolved gate: prove canonical Git filesystem locking/atomic refs/durability, database transactions/backup/restore, HTTP/SSH transport, repository affinity/scaling, restart/update/host loss and executor isolation before offering it as a supported preset. Snapshots or an R2 mount alone do not prove Git or PostgreSQL durability. The current Gitea/PostgreSQL core is retained until a supported alternative passes the same corpus; do not describe deploying the existing Compose stack inside a Cloudflare container as a qualified solution.

Deliver this through N4/N9 and P6.1/P7/P8: first the local bootstrap and existing bindings; then one actual Cloudflare account/resource adapter and mixed-provider operation; then the validated deployment plan/cost UI; finally supported Cloudflare compute with complete state/recovery proof. Each picker option requires its own adapter, tests and observable readiness. The fully Cloudflare-hosted gate is not implied by completing the hybrid path.

### 2.3.4 HTTPS edge and performance backends

Production needs a qualified HTTPS edge even when Cloudflare is absent. Provide a portable Compose reverse-proxy option (Caddy is the initial candidate for automatic certificate management), Kubernetes ingress with the operator's TLS/certificate controller, and the Cloudflare edge with a separately secured origin. Golf already serves its compiled UI and API; this edge is transport/routing infrastructure, not another product frontend. See [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https) and [TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls). Local internal-CA testing requires explicit trust setup; never silently install a root CA. Current `make dev` remains the loopback development-HTTP profile, not a production HTTPS package.

Qualify certificates/renewal, canonical host/origin enforcement, redirects, Secure/HttpOnly/SameSite cookies, proxy-header trust and client-IP spoof denial, body/upload/time limits, HTTP/2 and streaming, private upstreams, and separate SSH/Git/LFS routing. Do not cache authenticated RPC, session responses or private repository pages at a shared edge. Public immutable assets can use content-hash caching. Production hides direct application/admin/database/object-store/runner ports; operator access and health endpoints have explicit exposure rules. Cloudflare edge TLS must not be treated as origin TLS, preview authorization or a protected-write enforcement substitute.

Support Valkey as an optional real performance backend through ADR-0007, not an unused default container. First select and benchmark a consumer: bounded hot metadata projections, shared approximate rate/burst counters, or disposable live-update fan-out. Immutable repository objects/source bundles belong in the qualified native/object store, not an unbounded memory cache. Configure local or external Valkey with explicit tenant/namespace keys, authenticated/TLS transport where applicable, TTL/memory/eviction bounds, connection/time limits, availability/error behavior and health/metrics. Current Go database pools are already bounded; measure native API calls, SQL plans/indexes, pool waits and queue contention before changing limits or introducing additional infrastructure.

PostgreSQL retains durable sessions/revocation, grants/policy epochs, queues/leases/results and audit. Cached data never establishes current repository authority. Recheck access before serving cached private content; keys bind immutable repository/owner/object/config identity. Cache loss is a supported degraded path with bounded fallback/load shedding; security-sensitive quotas must not silently fail open. [Valkey Pub/Sub](https://valkey.io/topics/pubsub/) is at-most-once delivery and is not the durable job/event journal; its [persistence choices](https://valkey.io/topics/persistence/) require an explicit loss/recovery contract when state is retained. Cloudflare cache/KV/coordination choices implement their separately qualified function rather than claiming drop-in global Valkey semantics.

Use section 15.1's measured p95 goals and add p99, concurrency, error rate, queue age, cache hit/miss/stampede behavior and recovery time for each tested resource/repository class. Independently scale API replicas, bounded preparation workers and isolated execution pools, with admission/backpressure and reserved control-plane capacity. A faster cached display cannot hide an unhealthy executor or stale authority. Package/enable Valkey only when its consumer has demonstrated benefit and restart/outage/tenant-isolation proof. Add the HTTPS edge profile under P1/P2.3/P8 deployment qualification; measured cache consumers under N4/P8 performance qualification. These are required production tasks, not capabilities of the current loopback developer profile.

Local HTTPS qualification increment: [compose.https.yaml](compose.https.yaml), [edge operation contract](docs/HTTPS.md) and `scripts/https-compose-smoke.py` implement opt-in Caddy UI/API TLS, secure persistent sessions, canonical-host rejection, redirects, private CI/health/metrics denial and removal of the published Golf backend port. Local internal-CA login and backend/edge restart behavior are qualified with explicit CA validation and no host trust installation. Public ACME renewal, origin security, full native Git ingress/write fences, streaming/load/HA and expanded-topology recovery remain open under P0.8/P1/P2.3/P8; this slice does not complete production HTTPS qualification.

### 2.4 Write integrity

Enforce policy on HTTPS/SSH Git writes, API mutations, the web editor, background merges, and agent submissions. Authenticate before authorizing; never rely on post-push webhooks to reject unauthorized writes.

Gitea owns canonical repository storage and writes through its supported Git receive, API and merge operations. Golf does not write Gitea's repository refs or database directly. Qualify server-controlled protection, expected-candidate/base checks, repository ownership fencing and supported maintenance. Golf-owned task repositories may use standard Git executables and conditional ref updates independently. Never pass untrusted repository names as shell fragments.

Golf's PostgreSQL state and Gitea operations cannot commit atomically. Record a mutation intent before requesting a canonical write, perform the qualified Gitea operation, finalize from its observed result and reconcile incomplete intents through Gitea after a crash. Do not retry an ambiguous merge or transfer blindly. Emit product events from finalized observations, deduplicated with Gitea events. Test interruption at every boundary.

Checks and approvals reference exact commits. A merge candidate is tested against the current base, and its final update verifies the expected base. If the base changes, reconstruct and retest. Approval invalidation follows the configured review policy, never a stale green badge.

Gitea protection must be configured and contract-tested across protocols and background operations. See [protected branches](https://docs.gitea.com/1.27/usage/access-control/protected-branches/).

Gitea integration must close bypass routes for Golf-specific restrictions. Public Git HTTPS/SSH, web/API mutations and background merges must pass an enforceable Golf policy boundary, or equivalent backend policy proven by tests. Backend administration/internal APIs are private; generic privileged service tokens are not exposed to clients. Qualify the exact expected-head/base merge contract in P0.8; a Golf queue lock alone cannot fence other Gitea writers. Where a restriction cannot be enforced on every write path, report the capability as unsupported and block that protected workflow. Resolve any required v1 blocker through a documented supported approach or explicit scope decision, not direct ref/database writes or a silent fork. A post-write event or restrictive UI alone does not satisfy this contract.

Implementation qualification: the [pinned protected-write investigation](docs/GITEA_PROTECTED_WRITE_QUALIFICATION.md) reproduced a stale-approval acceptance window, found no caller expected-base merge predicate, and showed that code writers can satisfy native required status contexts. Exclusive merger accounts and explicit Git base leases are useful tested primitives, but do not alone close the full source/base/candidate/approval contract. P0.8 remains open; protected integration stays unavailable until a supported enforcement design passes its complete corpus. The [role qualification](docs/GITEA_IDENTITY_ROLE_QUALIFICATION.md) separately records viewer/maintainer and recoverable-owner mapping gaps. These findings apply to both infrastructure tracks and do not relax the requirements above. [Proposed ADR 0004](docs/decisions/0004-protected-integration-enforcement.md) defines a fully mediated publication candidate, its uncertainty/fork boundaries and the next P0.8-PUBLISH-1 qualification harness; it is not an accepted or implemented enforcement design. Its [pinned mutation inventory](docs/GITEA_MUTATION_BOUNDARY_INVENTORY.md) explicitly covers native API/web/Git/OAuth routes, private forks and background writers; static inventory does not prove enforced admission. The [live publisher fault qualification](docs/GITEA_PUBLISHER_QUALIFICATION.md) verifies narrow exact-C push and manual bookkeeping while reproducing old-authority/private-fork source races and deleted-head fallback; its experimental journal does not close P0.8.

### 2.5 Cloudflare Artifacts

Artifacts is first-class for eligible task/workspace repositories. It is not mandatory canonical Git storage in v1. The documented snapshot limits are 1 GB per repository and 32 MB per blob; history must be checked, not only the working tree. See [Artifacts](https://developers.cloudflare.com/artifacts/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Large repositories use native Git workspaces. Canonical Artifacts support is deferred until protected writes, conditional updates, ingress, export/restore, and workloads pass equivalent gates. No user or untrusted runner receives canonical Artifacts write credentials that bypass Golf policy.

### 2.6 Git compatibility and repository lifecycle

V1 creates SHA-1 repositories with the standard files ref backend for broad interoperability. Store the object-format identifier alongside opaque object IDs; never assume every future ID is 40 characters. Import preflight blocks unsupported SHA-256/reftable combinations rather than rewriting history. Git documents that SHA-1 and SHA-256 repositories currently lack interoperability; end-to-end qualification is required before expanding the catalog. See [git-init](https://git-scm.com/docs/git-init).

Qualify Gitea's Git receive quarantine and validation of incoming objects, limits and protected refs before accepting them. Imported hooks are data, never executable server policy. Expected-old-object updates and Git ref transactions underpin applicable Git operations; Golf must preserve them through supported Gitea paths rather than bypass Gitea to call them on canonical repositories. They do not create an atomic transaction with Golf's PostgreSQL state. See [receive-pack](https://git-scm.com/docs/git-receive-pack) and [update-ref](https://git-scm.com/docs/git-update-ref).

Schedule bounded repository maintenance, commit-graph/multi-pack optimization, integrity checks, and retention of active task/candidate refs. Coordinate maintenance with writes and backup; prune only after the retention policy releases objects. Avoid shared-clone alternates whose upstream garbage collection can destroy a dependent checkout. Qualify protocol-v2 partial clone and sparse checkout against each backend; hydrate missing objects before offline execution or export. Apply explicit limits to checkout, pack expansion, LFS, and recursive submodules; submodule URLs cannot inherit unrelated repository credentials. See [maintenance](https://git-scm.com/docs/git-maintenance), [clone](https://git-scm.com/docs/git-clone), [protocol v2](https://git-scm.com/docs/gitprotocol-v2), and [submodules](https://git-scm.com/docs/gitmodules).

### 2.7 Artifacts event and build handoffs

Qualify current Workers bindings, repository fork/import/token operations, repository event subscriptions, jurisdiction options and metrics for eligible task repositories. Preserve one authoritative repository/event owner; deduplicate provider events with Golf mutation observations. Workers Builds can own an eligible task preview build, but production branch auto-deploy must never circumvent Golf's approved candidate/promotion boundary. Use separate preview/production credentials and explicitly configured build ownership. Section 21 tracks the new announcement; canonical Artifacts remains conditional on section 2.5's integrity and protection gates.

### 2.8 Accepted first-release forge decision

Use Gitea as the shared forge foundation for both infrastructure tracks. Golf owns the developer interface, task/evidence system, CI orchestration, agent integrations and deployment experience. The Cloudflare track remains hybrid; Artifacts serves eligible task repositories and approved handoffs. P0.8 verifies the supported API inventory, identity mapping and policy boundary before the dependent implementation tasks proceed. This decision replaces the earlier dual-forge v1 proposal.

| Option | Reuse / operational shape | Main tradeoff |
| --- | --- | --- |
| Gitea-backed Golf in both tracks — selected for v1 | Gitea supplies canonical Git and conventional collaboration; Golf supplies its UI, task/evidence system, pipelines and deployment integrations. CF track remains hybrid and uses Artifacts for eligible task repositories. | Fastest route to broad forge functionality; requires proven APIs, identity mapping and enforcement of Golf policy without an invasive fork. |
| Golf-native core in both tracks — conditional later alternative | Golf would own collaboration/permissions; portable native Git and qualified CF Artifacts could be storage/execution choices beneath that one product model. | More independent ownership, but requires a separately approved implementation/migration plan for the missing forge features; Artifacts does not supply a complete collaboration application. |
| Gitea collaboration only on portable, native collaboration only on CF — deferred | Shared UI over separate collaboration implementations. | Duplicated policy/identity/migration/behavior testing; reopen only for a demonstrated requirement that the shared foundation cannot meet. |

Phase 3 therefore hardens Gitea integration, policy, migration and recovery rather than implementing another forge. Reconsider Golf-native only after a documented API/policy blocker or firm all-Cloudflare hosting requirement justifies its cost. A future ADR must define ownership, feature contracts, migration/export and verification before adding that work; do not assume Gitea can use Artifacts as its internal repository filesystem.

Use released Gitea APIs/events and supported deployment/storage configuration. Do not link its internal packages as a stable library, write its database directly, or undertake a deep fork without a measured blocker. Validate the actual UI/API operation inventory and policy boundary first. Gitea can retain forge ownership while Golf provides its own interface, but its authentication/permission model cannot simply be ignored. Canonical Git storage requires its supported persistent repository layout; R2-compatible object storage applies only to the qualified object categories. See [Gitea features](https://docs.gitea.com/), [API](https://docs.gitea.com/api/1.27/), [configuration](https://docs.gitea.com/administration/config-cheat-sheet/) and [Docker deployment](https://docs.gitea.com/installation/install-with-docker/).

Cloudflare Artifacts supplies Git-compatible repository primitives and task forks, not the entire Golf issue/review/approval/identity domain. Its documented 1 GB repository and 32 MB blob limits also constrain canonical use. Removing Gitea therefore moves collaboration/protection responsibilities into Golf; it is not merely changing a storage endpoint. See [Artifacts](https://developers.cloudflare.com/artifacts/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

## 3. Technology guide adoption

Reference: [Technology Selection Guide](https://technology-selection-guide.aws.ablabs.io/) and [full agent-readable content](https://technology-selection-guide.aws.ablabs.io/llms-full.txt). The dated [Golf adoption register](docs/TECHNOLOGY_GUIDE_REGISTER.md) records source digests, all chapter/ADR coverage, 81 grouped prescriptions, bootstrap gaps, disposition rationale and acceptance tasks. Source review is complete for that revision; pending ADRs and implementation conformance remain separate gates.

Follow applicable MUST requirements, document SHOULD deviations, and record any deliberate departures as ADRs. Maintain a requirement register: source chapter/anchor, prescription, implementation task, verification, applicability, and ADR if changed. This register covers the whole guide, not only the TL;DR summaries.

### 3.1 Stack and compliance matrix

| Guide area | Golf target (not completion status) | Verification / deliberate differences |
| --- | --- | --- |
| Architecture | Go domains under `internal`; handler/service/store; one composition root; no mutable global runtime state | Package review; no operator until an actual controller requirement exists. |
| Data | PostgreSQL, pgx, sqlc, embedded goose migrations with advisory lock; tenant-scoped reads | Real database tests, concurrent migrations, org-boundary tests. |
| Surface | Connect-RPC on chi; generated protobuf/Connect-Web clients; shared domain-error mapping; proto enums at boundaries | Generated-client and error-contract tests; REST for protocols/callbacks/health. |
| Frontend | React 19, strict TypeScript, Vite, Tailwind v4, Radix/shadcn, TanStack, Zod, Lucide | Router/Form substitutions explicitly recorded; pin compatible versions. |
| Tooling | Make targets, Air, Vite proxy, golangci-lint v2, multi-stage images | Go version derived from `go.mod`; no toolchain in normal web/API runtime images. Runner images legitimately contain toolchains. |
| Observability | zerolog JSON, OTLP tracing, Prometheus metrics, composite pgx instrumentation | Correlated logs/traces/metrics; optional local full observability Compose profile. |
| Security | JWT v5, refresh rotation, centralized authz, encrypted credentials, scanning | Git/SSH/webhook authorization has corresponding checks outside Connect interceptors. |
| Testing | Go table tests, real PostgreSQL, Playwright, gotestsum/JUnit, integration build tags | Use testcontainers/pgtestdb as prescribed; provider checks use controlled real accounts. |
| Discipline | Correctness first, source-of-truth contracts, real backends, root-cause fixes | ADRs and review checklist; no obsolete preproduction compatibility scaffolding. |
| Air-gap | Signed offline bundle, local OCI/dependency mirrors, no implicit public fallback | First boot and complete portable paths tested without external network. |
| TypeScript | Generated clients, strict types, runtime input validation, pinned toolchain | Node 24 LTS default; guide snapshots revalidated before pinning. |
| Multi-language | Go backend, TypeScript browser/Workers, small Python/Bash tooling only where needed | Workers backend exception justified in ADR; all languages share supply-chain and observability requirements. |

### 3.2 Required ADRs

- Shared Go core, Gitea in both infrastructure tracks, and selective TypeScript Workers adapters.
- TanStack Router for typed navigation and TanStack Form for the requested frontend foundation.
- Authoritative ownership and Gitea identity/permission mapping.
- PostgreSQL jobs for minimal installations; optional NATS/Cloudflare delivery at scale.
- Lightweight production profile versus the guide's full local observability stack.
- Session cookie policy: use `HttpOnly; Secure; SameSite=Lax` with explicit state/nonce/PKCE for OAuth/OIDC callbacks, CSRF protection on mutations, and origin checks. Record departure from the security chapter's Strict recommendation, which differs from the surface chapter.
- Credential encryption and government/FIPS distribution; default age path versus an approved assurance-specific path.
- Pipeline compatibility engines/coordinator subset and release contract.
- Infrastructure configuration ownership and deployment reconciliation.
- OSS/enterprise boundary and licensing.

Effect is a proposed library candidate for substantive TypeScript integration adapters, subject to a comparative Workers/portable-runtime qualification. See [ADR 0002](docs/decisions/0002-effect-typescript-adapters.md) for the concrete failure/cancellation/resource-cleanup pilot. It is not a new dependency of the Go core, UI, marketing site or docs, and does not create a second durable job authority.

### 3.3 Versions

Do not hardcode stale guide forecasts or copy old version claims. Select maintained stable versions within the chosen supported families, pin them in manifests/lockfiles/image digests, record source and verification date, and test updates through the compatibility corpus. A version update must not silently expand or weaken a published contract.

### 3.4 Guide completeness and implementation baseline

P0.2 must preserve a dated guide revision/content digest and register every normative prescription in Architecture, Data, Surface, Infrastructure/Tooling, Observability, Security, Testing, Discipline, Air-gap, TypeScript and Multi-Language, plus applicable guide ADRs. Each row has `adopted`, `deviation` or `not applicable`, with reason, Golf task and verification. Guide-site publishing choices are not automatically Golf runtime requirements. Section 3.1 is a summary, not a substitute for that register or a claim that compliance has already passed.

Specific implementation details to carry into that register: checked-in generated SQL/protobuf clients and generation-drift checks; documented JSONB schemas and tenant/soft-delete rules; ordered recovery/tracing/logging/authentication/authorization/validation middleware; bounded cursor pagination; short-lived access sessions and refresh rotation; private metrics endpoints and reproducible observability configuration; signed offline image bundles including supporting containers; reachable object-download endpoints; offline entitlement verification where applicable.

Additional ADRs required for Golf's existing choices: filesystem storage in minimal installations versus the guide's S3-only local storage prescription; optional observability profile; supported architecture bundles versus the guide's multiarchitecture requirement; explicit service endpoints/cluster DNS versus Kubernetes API discovery; and external-provider features being unavailable in disconnected installations. A deviation must retain the original requirement and rationale, not silently redefine guide compliance.

Initial source layout: thin `cmd/golf` (server/worker modes), `cmd/golfctl` (installed command `golf`) and `cmd/golf-runner`; Go domains under `internal`; SQL queries/migrations under `internal/server/database`; versioned API definitions under `api`; React under `web`; only required provider adapters under `workers`; Compose/Helm under `deploy`; fixtures under `testdata`; ADRs/runbooks under `docs`. Create directories when their first task needs them. P0.1 supplies Make targets for dev/build/generate/lint/vet/fmt/test/test-integration/migrate/check, with a fresh-clone build and no generation drift. No custom operator is needed.

## 4. Forge backends and collaboration

The active full repository-experience workstream is tracked in [the GitHub/Gitea capability matrix](docs/REPOSITORY_EXPERIENCE_PARITY.md), including code/Markdown/diffs, issue and PR mutation/review/merge, Actions, live SSE and agent progress. This expands implementation detail without closing unresolved gates.

### 4.1 Common v1 contract

The shared Gitea-backed forge contract covers repository creation/deletion/visibility, effective access, trees/files/history/blame/diffs, Git HTTPS/SSH, LFS, organizations/teams, issues/comments/labels/milestones, boards, PRs/reviews/comments, checks/statuses, protection, tags/releases/attachments, events, and import/export on both infrastructure tracks.

Reuse upstream Gitea behavior through supported APIs and events. Add Golf-owned workflow/evidence behavior only where it extends that foundation without creating competing collaboration authorities. Disable duplicate workflow execution by Gitea when Golf owns the workflow.

### 4.2 Collaboration rules

Boards describe planning stages; moving a card to Done does not imply tests passed or production deployed. Agent task status, PR status, pipeline status, and deployment status remain separate.

PR detail displays source/base commits, review state, checks, agent runs, exact tested candidates, preview links, and deployment evidence. Use optimistic concurrency for comments/settings/board mutations where conflicting edits can lose data.

Current bounded increment: the [PR read contract](docs/PULL_REQUEST_READ_CONTRACT.md) exposes list/detail/native-review observations through the generated API, typed UI and read-only CLI. List heads are retained snapshots; detail can also fall back to retained refs. Native review states/flags are not Golf eligibility or trusted evidence, and empty filtered review pages can still advance. The [commit-diff contract](docs/COMMIT_DIFF_CONTRACT.md) additionally qualifies immutable-object root/first-parent reads through API/UI/CLI, bounded to 512 KiB of native plain text. A native stream is not independently verified patch completeness or merge evidence. These implement part of P1.4/P2.1/P2.2/P5.5 only. Later bounded PR comparisons, overall reviews and inline reads are recorded below; complete mutations, anchored inline threads, policy and protected publication remain open. Qualification outcomes belong in the [implementation ledger](docs/IMPLEMENTATION_STATUS.md).

Current selected workspace increment: [PR Commits/Checks](docs/PULL_WORKSPACE_CONTRACT.md) adds two generated read-only procedures and canonical four-tab navigation, using displayed immutable repository/PR IDs and base/head commits with retained-ref observations around each page. Shared history and loaded-only check tables preserve private authorization. Real private-fork, stale-head, source-deletion and mixed-status qualification extends GX-3; detailed trusted check-run/job views, the full human review lifecycle and protected merge enforcement remain required. Native status success is not merge authority. Exact served evidence remains in the implementation ledger.

Required check context names remain stable. Changed commits invalidate previous success where appropriate. Code-owner review and protected-file changes are enforced as repository policy, not advisory UI warnings.

Current shared-core discussion increment: [ordinary issue/comment writes](docs/ISSUE_DISCUSSION_CONTRACT.md) use exact-input UUID reservations, provisional native receipt evidence and explicit UNKNOWN/SUCCEEDED/REJECTED outcomes. Filtered comment-page and own-operation reads are available to CLI/MCP; writes remain browser-session-only. Ordinary single-field issue title/body edits and close/reopen now share that durable contract and displayed revisions, with native permission and body-version qualification. Native POST/PATCH routes lack atomic expected-ID admission; title/state races, issue metadata/boards, PR/review writes, full audit/outbox and protected collaboration gates remain open. Exact final-image evidence belongs in the implementation ledger.

### 4.3 Identity

OSS includes local invite-only accounts, configurable OIDC login, organizations, teams, and safe bootstrap. Bootstrap issues a one-time administrator enrollment credential; it is invalidated after enrollment. No public default password. Local password storage uses a reviewed password-hashing implementation; hardened profiles may require external federation instead.

Prioritize genuine Golf username/password sign-in for the local developer installation; a native Gitea token input is advanced bootstrap tooling, not the primary product login. The [local authentication contract](docs/LOCAL_AUTHENTICATION.md) defines operator-enrolled Golf password verifiers, independently scoped immutable forge mappings and database-backed opaque sessions. Passwords use Argon2id with reviewed fixed parameters; do not forward Golf passwords to Gitea or store them as reversible ciphertext. HTTPS cookies are host-only `__Host-` cookies with Secure, HttpOnly, SameSite and persistent expiry; local HTTP is explicitly limited to loopback. Backend restarts do not invalidate unexpired sessions; password reset/disable, explicit logout/revocation and expiry do. Bound login attempts across replicas and password-hash concurrency, and deny account/role claims from native JSON. Recovery disables restored local accounts until deliberate re-enrollment with a fresh password and validated immutable forge credential. Self-service recovery, MFA, step-up, external OIDC and a complete instance-admin management surface remain separately qualified tasks. Use [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) as review inputs, not an automatic certification.

Login with GitHub/GitLab is separate from authorizing a repository connection. Matching an email alone cannot merge identities or grant organization membership. Account linking requires proof of control of both accounts.

Map Golf accounts and groups to Gitea identities; evaluate Gitea permissions for writes and sensitive reads. Do not mint an unrestricted administrator token for every product operation.

### 4.4 Ingress and search

Golf owns the customer-facing UI in both tracks; Gitea is a supported internal forge service, not the product frontend. Use the standard pinned Gitea deployment behind private networking and explicit ingress rules rather than assuming a separate frontend-free distribution. Native REST stays internal to authorized Golf services; expose only deliberately qualified Git/LFS/SSH routes and separately controlled operator access. Current Gitea OAuth login/consent, token setup and unfinished native workflows remain explicit development exceptions until Golf owns their supported replacements. Prove registration/sign-in, consent/revocation, Git/LFS transports, administration and denial of unintended native pages/API writes before claiming an entirely Golf-facing installation. Hiding HTML alone does not fence Git/API/background write bypasses or close P0.8.

Provide a direct Git/LFS ingress option for request sizes or protocols not suited to ordinary Cloudflare proxy limits. SSH is an explicit endpoint; ordinary Workers HTTP routing is not a generic SSH server.

Start with authorized repository-local search. Add Zoekt for indexed cross-repository code search in the scale profile. Search results, cached content, and retrieval must be filtered by effective repository access, including revocation. Content hashes are not authorization.

### 4.5 Merge queues and effective review policy

Provide a serial queue per protected target branch in v1. Construct and test an immutable candidate against the current base, retain its evidence, and merge conditionally. Moving base/head, changed policy, revoked approval, or cancellation invalidates admission; rebuild and retest. Begin with one active candidate per branch; speculative parallel trains are a later measured optimization.

Connected GitHub execution consumes `merge_group` / `checks_requested` and reports checks on the actual group commit, not the PR head. Connected GitLab execution must distinguish ordinary MR, merged-result, and merge-train candidates; unsupported instance/version/tier behavior is a named blocker, not a green approximation. Full GitLab train scheduling parity is outside the initial catalog. See [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and [GitLab merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/).

Preserve effective rules across overlapping rulesets, bypass identities, protected branches/tags, and code-owner approval requirements. Parse GitHub and GitLab CODEOWNERS as distinct formats with tested precedence, sections, identities, and approval counts where supported. Evaluate the policy file from the applicable base; a PR cannot approve itself by weakening its own rules. Agent authorship, executing principal, approving principal, and cryptographic signer are separate evidence. An agent acting for an author cannot satisfy an independent-review rule. See [rulesets](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-rulesets), [GitHub CODEOWNERS](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-code-owners), and [GitLab CODEOWNERS reference](https://docs.gitlab.com/user/project/codeowners/reference/).

### 4.6 Repository lifecycle, forks and large files

The common v1 contract explicitly includes public/private repositories, create-from-template, fork creation and upstream relationships, cross-repository PRs, draft/ready state, reviewer assignment, resolved/unresolved threads, merge/squash/rebase policies, archive/unarchive, rename/transfer and controlled deletion. Test same-repository and fork contributions through Gitea on both infrastructure tracks. Private forks retain an explicit access boundary; changing parent visibility or membership must not unexpectedly publish code. Rename/transfer updates Git URLs, origin mappings, hooks, automation, deployment and credential references; redirects never grant broader access or forward credentials to an unrelated host.

LFS v1 publishes supported discovery, batch/basic transfer, upload verification, size/hash integrity, authentication and locking behavior. Default target includes lock/list/verify/unlock with owner/admin rules; unsupported backend/transport combinations are preflight blockers. Object existence or a guessed hash never grants repository access. Enforce upload quotas before accepting bytes, expire incomplete uploads, and retain LFS objects referenced by retained branches/tags/imports. Reachable missing LFS objects block verified import/backup completion. See [LFS batch](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) and [locking](https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md).

Expose commit/tag signature verification with signer identity and trust state, separate from author email and build provenance. Never label imported or agent-authored commits as verified without actual signature verification. If signed-commit protection is enabled, every relevant path must enforce its qualified backend policy.

### 4.7 Human and machine identity lifecycle

Define owner/admin, maintainer, developer, reporter and viewer capabilities per organization/repository; environment deployment and credential administration are separate grants. Service accounts and agents receive explicit subsets. Backend mappings must preserve effective permissions or reject unsupported mappings. Document audit-visible emergency administration and prevent removing the last recoverable owner.

Support scoped expiring personal/service tokens, user SSH keys, repository deploy keys, token/key listing with last use, rotation and revocation. Store verifier hashes for opaque tokens and private keys only where Golf actually needs them. Git SSH runs an allowlisted Git command against an authorized repository, never a general shell. Publish host-key fingerprints and rotation instructions. Browser login cannot substitute for Git transport credentials.

Local accounts need verified enrollment, reset/recovery, session listing/revocation and optional TOTP MFA using maintained libraries; external OIDC can satisfy enforced MFA through validated assurance policy. Require step-up authentication for account linking, credential and recovery changes. CLI login uses a documented browser PKCE flow with loopback callback, or scoped token input for headless use; credentials use the OS store where available and restrictive files otherwise. No password/token in command arguments, history or verbose output.

## 5. GitHub/GitLab connections and direct import

### 5.1 Connection modes

| Mode | Source of truth | Behavior |
| --- | --- | --- |
| Connected origin | GitHub/GitLab | Golf receives events, runs eligible CI/agents, returns checks/comments/PRs or merge requests, and deploys projects without claiming forge ownership. |
| Migration rehearsal | Origin until cutover | Golf imports into a staging destination, reports fidelity, and validates before switching writes. |
| Imported repository | Gitea through Golf | Gitea owns new collaboration/Git writes under Golf's qualified policy boundary; historical origin identifiers remain preserved. |
| Read mirror | Explicit origin | One-way Git synchronization for authorized uses; no implicit two-way metadata synchronization. |

These modes are explicit per repository. V1 does not attempt a conflict-prone universal bidirectional forge synchronization system.

### 5.2 Provider authentication

GitHub: GitHub App installation for selected repositories, scoped installation tokens, authenticated webhooks, and user authorization for user-specific operations. Support configured GitHub Enterprise Server endpoints with version-tested capability reporting.

GitLab: OAuth for delegated access and scoped project/group/service credentials where appropriate for unattended automation. Support GitLab.com and configured self-managed endpoints. Record required scopes per operation; write APIs and Git transport require different capabilities. See [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps) and [GitLab OAuth](https://docs.gitlab.com/integration/oauth_provider/).

Connection setup includes repository/group discovery, permission verification, webhook registration where authorized, encrypted credential references, expiry/refresh, reconnect/revoke, and provider rate-limit handling. Self-hosted endpoint access is administrator-configured to prevent SSRF into arbitrary internal services.

### 5.3 Connected execution

Normalize authenticated push, PR/MR, issue, comment-command, pipeline, and release events. Record delivery IDs and deduplicate. Check current authorization at execution time rather than trusting old webhook permissions.

Results return to the origin through supported checks/statuses, comments, and PR/MR APIs. Disable writes when credentials are revoked. An origin branch moving during work creates a stale candidate, not permission to overwrite it.

Default external mutations are PR/MR proposals. Auto-merge or production deployment requires explicit policy and origin capability. Link evidence and previews to exact origin commits.

### 5.4 Direct import workflow

1. Connect account/instance and select repositories.
2. Audit history, refs, blobs, LFS, submodules, metadata, workflows, policies, and integrations.
3. Produce an unchanged/adaptable/blocked report before import.
4. Select the destination Gitea installation/organization and map identities/groups deliberately.
5. Import Git and supported collaboration metadata into a staging destination.
6. Verify refs/object integrity, attachments, counts, relationships, and fidelity losses.
7. Freeze source writes for cutover and synchronize the final delta.
8. Switch authoritative mode and ingress only after validation.
9. Reconnect secrets, environments, and deployment credentials explicitly.
10. Retain source mapping, export, and documented cutover recovery.

Import issues, PRs/MRs, comments, labels, milestones, releases, and available attachments with original timestamps/authorship references where possible. Historical users who cannot be mapped are attributed as imported identities, not impersonated active accounts. Permission and secret transfer is never inferred from imported text.

The report names unsupported package/security/wiki/discussion data. Do not silently discard it; include an export or blocker. Test public/private repositories, nested GitLab groups, large history, missing users, forks, pagination, interrupted imports, and API rate limits.

The migration auditor compares effective source and destination protection, bypass, code-owner, approval, and token policies. Unmapped identities or weaker enforcement block protected-repository cutover until explicitly resolved; copying configuration text is insufficient.

### 5.5 Event recovery and permission reconciliation

Acknowledge authenticated webhooks only after durable intake. Hydrate truncated/incomplete events through scoped APIs, handle out-of-order deliveries using observed object versions, and periodically reconcile repositories, permissions, checks, and open changes. Keep per-connection cursors and rate-limit/backoff budgets. GitHub does not automatically redeliver failed webhooks; inspect delivery records and request redelivery where authorized, with periodic state reconciliation for gaps beyond delivery retention. Do not assume GitLab instances have identical retry behavior. Revocation/removal must clear accessible projections and pause queued writes. See [failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## 6. Modern interface and themes

### 6.1 Design

Use React/TypeScript, Vite, Tailwind/shadcn/Radix, Lucide, and TanStack Router/Query/Table/Virtual/Form. Use TanStack Store only for genuinely shared non-server UI state; defer TanStack DB until a verified sync requirement exists.

Use a familiar forge workspace: repository context, source trees, commit history, issues, PRs, reviews and checks should be easy for GitHub/GitLab users to navigate. Apply Golf’s own lowercase wordmark, Archivo typography, Geist Mono code, lime accents and charcoal/neutral-light palette. Keep signed-in workspaces compact and readable; marketing-scale hero headings do not belong in routine repository screens. Typical workflow text is 14–16px and secondary metadata 12–13px minimum, with usable touch targets, zoom/reflow and measured contrast. Marketing/docs use the same brand with more editorial spacing.

Primary areas: overview, repositories, issues/boards, PRs, pipelines, automations, workspaces/runners, projects/deployments, connections, and administration. Shared navigation and consistent detail panels prevent unrelated administrative screens from becoming the product experience.

Filters/sort/pagination live in typed URLs. Paginate server data and virtualize large trees/diffs/logs. Stream logs with reconnect and sequence handling. Display actionable failure/blocker messages and capability availability.

### 6.2 Theme tokens

| Token | Dark default | Light default |
| --- | --- | --- |
| Page background | `#0C0C0C` | `#F2F2EE` |
| Panel/sidebar | `#151514` | `#FAFAF7` |
| Raised surface | `#1D1D1A` | `#EAEAE4` |
| Border | `#343430` | `#D0D0C7` |
| Main text | `#F2F2EE` | `#101010` |
| Secondary text | `#AAA9A2` | `#5D5D55` |
| Accent/link | `#D4FF3A` | `#3F6400` |

Dark mode is black/dark charcoal with neutral surfaces, not navy. Accent colors are semantic and do not replace readable labels. Verify final tokens against WCAG contrast; do not assume the table itself proves compliance.

Offer one shared header button switching dark/light, with a saved browser preference applied before rendering. Operating-system preference may supply the initial choice when none is saved; it is not a third selectable mode. Server-backed user preferences remain separate implementation work. Preview applications never share Golf's session cookies or storage origin.

### 6.3 Accessibility and verification

Keyboard navigation, visible focus, accessible labels, reduced motion, screen-reader status, responsive layouts, and readable diffs/logs are baseline requirements. Test both themes and a narrow mobile viewport. Capture representative screenshots of repository, PR, pipeline, automation, and deployment views against the real API.

### 6.4 Settings pages and granular policy administration

**Repository completion requirement:** every one of the ten sections shown on repository Settings must become genuinely configurable, enforced and qualified. [The complete repository-settings packet](docs/REPOSITORY_SETTINGS_IMPLEMENTATION.md) preserves each section's full requirements, delivery dependencies and acceptance evidence; intermediate slices must not be relabeled Ready or removed to turn the inventory green.

Research reviewed against official GitHub documentation on 2026-10-02. The controls below are Golf implementation requirements, not a claim of existing GitHub-equivalent behavior. Provider edition/visibility restrictions are not automatically Golf licensing decisions. Essential governance must work without AI or Cloudflare.

**Settings information architecture.** Use durable, directly linkable full pages with a settings sidebar, section titles, unsaved-change handling and inline validation. Account settings contain profile/email, authentication/recovery/MFA, sessions, SSH/signing keys, scoped credentials, connected identities, notifications and appearance. Organization settings contain membership/teams/roles, repository defaults and selection, CI policy, runner groups, secrets/variables, agent/MCP policy, connections, budgets, audit and retention. Repository settings contain general/features, collaborators, rulesets/reviews, CI and engines, runners, secrets/variables, environments/deployments, agents/MCP, webhooks/notifications and a clearly separated danger zone. Instance administration covers enrollment/SSO, infrastructure/capabilities, shared pools, provider connections, policy ceilings, recovery and system health. Personal repository ownership supplies the organization-equivalent policy scope without requiring users to create an organization.

Account/repository/organization settings must never be crammed into dialogs. Keep dialogs for short confirmations; migrate existing creation/edit forms to pages where they require sustained work. A save control appears only when its supported backend can actually persist and enforce the setting. Display planned sections as documentation or an explicit unavailable state, never working-looking toggles. Settings pages open with current values or inventories and explicit Add/New/Edit actions. Editors open only on request, with Cancel, draft clearing and focus return; no permanently exposed creation form. Keep tokens, fields, buttons, panels and responsive rules in the shared global stylesheet. Use TanStack Form for form state/submission and the shared TanStack Table component/configuration for compact searchable/sortable data inventories; preserve server-authoritative pagination and do not make unloaded rows appear searchable. Current profile information is read-only; the account shell and session/SSH/API credential/activity pages do not establish complete self-service identity management.

**Scope and semantics.** Enforced ceilings flow from instance → organization/personal-owner scope → repository → workflow/job or deployment environment. User preferences cannot grant execution authority. Every setting has a typed value, explicit `inherit`/override/locked semantics, version and effective-policy explanation identifying its source. Allowlist policies intersect; explicit denies dominate; numeric budget/resource maxima narrow by minimum; approval requirements accumulate. Do not apply a generic “last value wins” merge to authorization. Separate native roles, Golf permissions, feature enablement, engine compatibility and installation readiness.

For CI and agents, provide **Disabled / All eligible repositories / Selected repositories**, plus a per-repository inherited/enabled/disabled view. “All” must explicitly say whether future repositories are included; default new repositories to execution disabled until authorized. Selected scopes bind immutable repository IDs, not mutable names. Organization restriction cannot be weakened by repository/workflow configuration. Start with explicit ID selection; add custom-property/dynamic selectors only after their schema permissions, membership recalculation and privilege-escalation tests exist. Show affected repositories and effective policy before broad changes.

| Control family | Relevant GitHub precedent | Golf behavior to implement |
| --- | --- | --- |
| CI enablement and dependency policy | [Organization Actions settings](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization) | Disabled/all/selected eligibility; separate GitHub Actions and GitLab engines and published versions; allowed action/component/reusable-workflow sources and immutable pins; explicit exceptions. A Marketplace badge is not a Golf trust grant. |
| Individual workflow controls | [Workflow enable/disable](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows) | Pause one workflow without removing its source or enabling otherwise denied execution; UI/API/CLI/MCP use the same policy. Scope scheduled activation separately, keep imported/forked schedules off until approved, and publish any inactivity suspension policy. Bind identity to a verified repository/configuration path so rename, copy or re-import cannot silently bypass a security restriction. |
| Trigger authorization | [Workflow execution protections](https://docs.github.com/en/actions/concepts/about-actions-policies) | Authorize actors and event types independently of code-write permission: push, PR, manual/API/MCP dispatch, schedule, webhook and agent events. Privileged fork/upstream-run triggers stay blocked until their exact trust contract is qualified. Record why an event was denied. |
| Workflow credentials and fork trust | [Workflow permissions and fork settings](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization) | Default attempt credentials to minimal reads; explicit content/check/PR/issue/deployment permissions; independent authority to create proposals versus approve/merge. Fork approval binds exact source/config/policy identity; no secrets, trusted cache or production pool by default. Re-runs and edited fork commits re-evaluate trust. |
| Runner groups | [Repository/workflow access to runner groups](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access) | Allowed organizations/repos and exact qualified workflows, visibility/trust restrictions, labels, OS/architecture, regions/network, resource caps, pool concurrency, registration/expiry/drain/revocation. Labels select capacity; they do not authorize it. Allow administrators to forbid shared/default pools and require an approved runner group. Repository runner registration needs a separate permission. |
| Private automation sharing | [Private action/workflow sharing](https://docs.github.com/en/actions/how-tos/reuse-automations/share-with-your-organization), [nested workflow access](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations) | A consumer dependency allowlist is not a producer export grant. Private action/workflow repositories default to no cross-repository sharing; authorized producers select eligible consumers. Verify every nested dependency, prevent credential escalation, use short-lived source-read credentials and disclose code/log exposure to consumer collaborators. Keep unsupported reusable-workflow forms blocked under the initial catalog. |
| Secrets and variables | [Organization/repository/environment secret access](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) | Typed scope, selected-repository access, environment approval, read/write role separation, secret metadata only, rotation/revocation and explicit reusable-workflow forwarding. Separate CI, agent and production broker secrets. Support truthful Golf OIDC where the destination trusts it. |
| Environments and CD | [Deployment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) | Authorized branches/tags/commit evidence, named reviewers/teams, no self-approval by default, wait windows, scoped bypass with reason, exact artifact promotion, production concurrency, rollback authority and preview TTL/access. Workflow text cannot invent or gain access to a production environment. |
| Repository/organization rulesets | [Organization targeting/bypass](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization), [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) | Branch/tag/paths, force/delete restrictions, signed changes, reviews/CODEOWNERS, current-base trusted-producer checks, merge strategies/queue, stale approval handling and limited bypass. Evaluate mode is observability only, not enforced protection. Qualify direct Git/API/editor/background/agent paths first. |
| Delegated administration | [Repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization), [organization roles](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/permissions-of-predefined-organization-roles) | Separate code/issue/review permissions from managing CI, runners, secrets, agents, production, connections, policy and billing. A CI administrator need not own repositories or production secrets. Map effective native authority explicitly; do not relabel native roles as finer permissions they cannot enforce. |
| Programmatic access and integrations | [Organization token policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization), [app installation restrictions](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations) | Independently govern permitted credential types, maximum lifetime, organization approval, repository selection and integration-installation authority. Personal consent cannot grant organization access; approval binds requested scopes and repositories, with expansion requiring review. Reject noncompliant tokens at access time. Organization access withdrawal is distinct from deleting a personal credential; revoke related SSH/deploy keys explicitly rather than assuming token revocation removes them. |
| Repository classification | [Custom properties and ruleset targeting](https://docs.github.com/en/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization) | Optional typed owner/team, criticality, data sensitivity and permitted region/provider metadata. Only authorized policy administrators may edit security-relevant classifications. Renaming/transferring a repository never silently expands eligibility. Defer arbitrary query-based selectors from the initial policy slice. |
| Integrated agents and MCP | [Agent resource access](https://docs.github.com/en/copilot/tutorials/cloud-agent/give-access-to-resources), [agent firewall policy](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall) | Separate agent enablement from CI; allowed harnesses/models/providers, user-owned versus organization-owned credentials, repository scope, proposed-change authority, approvals, budgets and kill switches. Approved MCP endpoints/tools, read versus mutation, immutable skills/plugins and network access need independent policy. Test setup scripts, plugins, MCP sidecars and descendants, not only the main agent process. |

**Additional Golf controls.** For Cloudflare, restrict eligible customer accounts, zones/domain namespaces, R2/D1/KV/Queues bindings, Sandbox/Container pools, preview access and production brokers. DNS or deployment permission is separate from agent/CI eligibility. For portable deployments, apply equivalent restrictions to Docker/VM/Kubernetes pools, clusters/namespaces, registries, storage, egress and protected preview/CD adapters. Do not switch execution tracks as a silent fallback around region, trust, secret or budget restrictions. Native Workers Builds, connected GitHub/GitLab CI and Golf execution each have a single recorded owner; organization CI disabling must not falsely imply that independently configured origin builds were stopped.

Budgets/concurrency/timeouts, logs/artifact/cache retention and tenant storage caps are first-class, with maximums enforced by the scheduler/provider broker rather than estimates in the UI. Fork cache namespaces cannot poison trusted runs. Cache deletion, artifact expiry and cancellation remain distinct; preserve active evidence and releases according to retention/legal policy. Outgoing webhooks require scoped subscriptions, signing/rotation, verified destinations, delivery/retry controls and redacted payloads; email/watch preferences follow current access at delivery.

**Policy lifecycle.** Persist changes with expected-version comparison and a redacted audit record in one transaction. Ordinary editors cannot change an inherited ceiling. Changes produce a durable re-evaluation signal; job/agent admission, assignment, retries, secret/OIDC issuance, trusted check publication, merge and deployment recheck the current policy/revocation epoch. Record the original policy snapshot for evidence, but it cannot keep a revoked permission alive. A stale admin form fails rather than overwriting a newer restriction.

Define disabling effects explicitly: block new admissions immediately; fence queued/retried work; stop active work and revoke attempt credentials for security disables; quarantine late outputs so they cannot satisfy checks or deploy. A drain-only operational pause is a separate control. Provider teardown/revocation can be asynchronous, and the UI reports cancellation requested/pending/complete honestly. Re-enabling does not replay old triggers or redeploy automatically. Permission lookup/provider readiness errors fail closed.

**Delivery tasks and release gates.** These are additions to existing tasks, not another speculative service or a claim of completion:

1. **G1 — Settings pages/inventory (P1.4/P2.2):** replace account/session modals; add full organization/repository/instance settings in the phases that provide real APIs. Inventory implemented/read-only/planned controls and actor permission. Verify deep links, reload/history, keyboard/mobile, active navigation, private-data cleanup and confirmation-only dialogs. Migrate sustained creation/edit dialogs separately.
2. **G2 — Effective policy (P1.2/P1.3/P2.3):** implement the first typed execution-eligibility policy and native authority binding, immutable selected IDs, inherited locks, versioned saves, audit and revocation epoch. Table-driven policy tests must prove deny dominance, no workflow/user override, new-repo behavior, transfer/rename, cross-tenant denial, token/app scope expansion and concurrent stale saves. Do not build an arbitrary policy DSL.
3. **G3 — First CI policy slice (P4.1–P4.7):** real runner registration/group selection, all/selected/disabled CI, allowed events/workflows, scoped attempt credentials and fork approval. A denied run must produce no runner assignment or secret request. Disable during queue/run/retry must fence late results. Verify individual workflow pause cannot be bypassed by dispatch and private dependency use requires producer and consumer authorization; validate the same contract with Actions and GitLab supported subsets.
4. **G4 — Agent/MCP policy (P5.2/P5.3/P5.5/P5.7):** qualify the first actual in-Golf harness against repository scope, model/auth/credential ownership, tool/network allowlists, proposal-only defaults, cancel/revoke and budget limits. Expand to Claude Code, Codex, OpenCode, Grok and pi only with actual harness-specific evidence; do not treat MCP reads as integrated execution.
5. **G5 — Environment/resource policy (P6/P7):** qualified portable and Cloudflare preview/production restrictions, review separation, exact-plan approval, DNS/account/cluster selection, credential withholding and drift/rollback/TTL. Prove agents/builds cannot reach production credentials or bypass the broker through direct provider APIs.
6. **G6 — Settings parity acceptance (P8.1/P8.11):** exercise the role/visibility/policy matrices and save/upgrade/recovery flows on both tracks, including unauthorized API/MCP calls, disabled capabilities, active revocation, external build ownership and policy provenance. Core enforcement is not an enterprise-only cosmetic toggle.

## 7. Actions and GitLab pipeline compatibility

### 7.1 Architecture and contract

Read `.github/workflows/*.yml` and `.gitlab-ci.yml` without rewriting supported source files. Each frontend validates and compiles source-specific semantics into an immutable execution plan. The scheduler does not reinterpret conditions differently from the frontend.

Publish a versioned catalog with syntax, contexts/variables, action/component versions, supported provider endpoints, runtime requirements, security semantics, and runnable fixtures. Unsupported behavior fails preflight with file location, reason, and adaptation path. No unmeasured compatibility percentage.

Keep compilation bounded: input size, nesting, matrix expansion, include recursion, execution graph, and expression evaluation all have configured limits. Include resolution is allowlisted and commit-pinned, protects credentials across hosts, and detects cycles. Record resolved includes/action commits with the run.

### 7.2 Actions initial contract

| Surface | V1 contract |
| --- | --- |
| Events | `push`, `pull_request`, `merge_group` (`checks_requested`), `workflow_dispatch`, and `schedule`; explicit branch/path filters and correct candidate commit. Other events are blocked until cataloged. |
| Graph | Jobs, `needs`, matrices with include/exclude, supported strategy fail-fast/max-parallel, job/step conditions. |
| Expressions | Literals, documented coercions, property/index access, supported object filters, comparison/logical operators; `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`, `success`, `failure`, `cancelled`, `always`. Each has upstream-derived fixtures. |
| Contexts | Supported fields of `github`, `env`, `vars`, `secrets`, `runner`, `job`, `steps`, `needs`, `strategy`, `matrix`, `inputs`. Unsupported fields are diagnosed; null/coercion behavior follows the published reference. |
| Execution | Shell steps; pinned JavaScript, composite, and Docker action versions in the verified catalog; pre/post behavior and command-file outputs. |
| Runtime | Linux image families and explicit tool versions; job/service containers only on verified pools; no hidden hosted-runner image equivalence. |
| Control | Concurrency/cancellation, timeout, outputs, continue-on-error behavior, retry only where Golf explicitly defines it without altering Actions source semantics. |
| Services | Verified artifact/cache actions and versions, logs/checks/statuses, job tokens, approved environment gates, scoped OIDC. |

Advanced reusable workflows, `pull_request_target`, other event families, and unsupported provider APIs are blocked in the first catalog and expanded deliberately. `pull_request_target` is not treated as an ordinary untrusted PR event.

The contract is a target, not a claim that upstream `act` already supports all of it. Reuse maintained `act` components for supported parsing/action execution. Golf supplies missing orchestration/security, and only advertises entries after passing conformance fixtures. See [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [Actions runner](https://github.com/actions/runner).

The implemented increment follows the [typed dispatch contract](docs/WORKFLOW_DISPATCH_INPUTS_CONTRACT.md): source/schema-bound string, boolean, number and choice parameters; separate submitted/defaulted digests; atomic encrypted admission and current-authority runner release; unchanged legacy replay/GitLab behavior and read-only original-operation inspection. The opt-in v2 [maintained engine](docs/ACTIONS_ENGINE.md) and requested TanStack editor pass bounded source, PostgreSQL and browser checks recorded in the [ledger](docs/IMPLEMENTATION_STATUS.md). One actual native/Docker/verified-TLS1.3 run qualifies declared defaults, inert literal text, numeric truth and local-composite execution; retained localhost8080 now deploys schema059. Twelve actual served dark/light desktop/mobile editor/run/scoped-step captures now pass on the current component images; browser dispatch and remaining privacy transitions, zero/empty submitted-value execution and wider conformance/recovery remain required. Input-free GitHub workflows retain v1 admission/approvals under the v2 installation; GitLab remains legacy. Environment selectors require the actual deployment approval consumer; v2 does not adopt existing v1 secret approvals or input-declaring push workflows. These checks do not complete the broader catalog or all repository settings.

### 7.3 GitLab initial contract

| Surface | V1 contract |
| --- | --- |
| Graph | `stages`, `stage`, `needs`, selected artifact dependencies, parallel/matrix expansion. |
| Configuration | `default`, `variables`, `inherit`, `extends`; local includes and authenticated project includes pinned to a commit. |
| Rules | Ordered `rules` with supported `if`, `changes`, `exists`, and `when`; compatible `workflow:rules`. Rule variable/regex semantics have fixtures. |
| Execution | `image`, `services`, `script`, `before_script`, `after_script`, supported shell behavior, tags, timeouts. |
| Control | Manual jobs, retries with supported failure classes, `allow_failure`, interruptibility, `resource_group`, cancellation. |
| Data | Artifacts including supported reports, caches, dotenv outputs, variable precedence, protected/masked variables. |
| Security/delivery | Protected environments, supported job-token endpoints, supported `id_tokens` claims, required deployment approval. |

Remote/template/component includes, child/dynamic/downstream pipelines, provider-specific security products, unsupported release/pages behavior, and unimplemented identity federation are blocked until separately verified. Required manual or security gates cannot be ignored.

GitLab rules, stage ordering, variable precedence, and failure propagation retain GitLab meaning rather than being approximated as Actions. See [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/).

### 7.4 Execution-engine reuse

Pin GitLab Runner and implement the bounded coordinator compatibility endpoints it requires: registration/session authentication, job request/assignment, trace upload, job state updates, scoped Git fetch, artifact upload/download, and supported cache/ID-token behavior. Use Docker/Kubernetes executors where they fit. Treat a custom-executor adapter for Cloudflare jobs as a conditional feasibility option, not the selected long-term engine.

GitLab documents its Custom executor as maintenance-only (critical security fixes, no new features) and recommends actively maintained executors for new projects. Phase 0 must record an engine ADR comparing maintained Docker/Kubernetes paths with a bounded Cloudflare adapter, including ownership, upgrade and isolation costs. Validate the exact transport and any selected custom-executor lifecycle in Phase 0. Source availability does not make its coordinator interchangeable. Drop-in support for every GitHub/GitLab runner binary/version is outside v1. If an engine proof fails, its advertised support stays blocked and the task must resolve the failure before the applicable release gate.

See [GitLab executors](https://docs.gitlab.com/runner/executors/), [custom executor](https://docs.gitlab.com/runner/executors/custom/), and [autoscaling](https://docs.gitlab.com/runner/runner_autoscale/).

### 7.5 Security and execution evidence

Job tokens are attempt-scoped and least-privilege. Untrusted forks cannot receive trusted caches or secrets. Permissions and environments are evaluated by Golf even when an engine does not enforce them. Environment approvals bind exact inputs; OIDC uses a configured issuer/audience and truthful organization/repository/ref/job claims. Do not impersonate GitHub/GitLab's issuer.

Artifact/cache protocols are version-tested; `actions/upload-artifact` support is not inferred from YAML parsing. Hardcoded provider endpoints are blocked or covered by a narrowly published adapter. Never rewrite arbitrary URLs and credentials transparently.

Cross-project GitLab job-token access requires the target allowlist, authorized actor, supported endpoint, and applicable fine-grained permissions. No attempt token becomes a general user/API credential. Preflight diagnoses workflows that require unsupported package/registry endpoints. See [job tokens](https://docs.gitlab.com/ci/jobs/ci_job_token/) and [fine-grained permissions](https://docs.gitlab.com/ci/jobs/fine_grained_permissions/).

Record event causality, actor, token type, automation ID, and bounded generation depth. Provider-specific token event suppression is version-tested; avoid a blanket rule that prevents agent-created PRs from running required CI. Repeated automation dispatch is bounded independently from legitimate PR/check/deployment events. Privileged `workflow_run` remains blocked until untrusted-artifact and upstream-workflow trust checks are implemented. See [trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

### 7.6 Trustworthy checks and workflow ownership

A required check is identified by its authorized producer, workflow/policy revision, commit/candidate and attempt, not only a display name or submitted status. Ordinary repository tokens and agents cannot manufacture required success. Protect the definitions of mandatory checks; a PR that edits tests/workflows cannot remove its own required evaluation. Retain source, test-suite changes and independent evaluation results for review.

In connected mode select one execution owner for each check/workflow: origin execution observed by Golf, or Golf execution reporting an authorized distinct context. Do not silently disable origin CI. Setup shows duplicate-trigger risk and how required origin checks map to Golf results. If a provider action requires an unimplemented GitHub/GitLab API, block it even when its shell portion runs.

Fork execution has explicit approval and credential/cache/network policy at the exact commit. Approval of a previous fork revision does not authorize changed code. Repository instructions and workflow edits remain untrusted inputs; action/plugin dependencies resolve to immutable versions in each recorded run.

## 8. Runners, isolation, and autoscaling

### 8.1 Common runner contract

Pools advertise Linux distro/image digest, architecture, CPU/memory/disk, labels, action/runtime versions, service/container/image-build support, isolation, network access, trust class, region/locality, quota, warm capacity, and health.

An assignment references the exact repository/commit, immutable plan/configuration, attempt and lease epoch, deadline, resource limits, allowed network, credential references, and artifact destinations. The runner fetches assignment-scoped material through outbound authenticated connections.

Register using an expiring enrollment credential; replace it with a revocable identity and short-lived session tokens. Support heartbeat, acquire/acknowledge, log sequence/upload, terminal result, cancellation, drain, and cleanup. Fence stale attempts so they cannot publish checks or artifacts for newer work.

### 8.2 Execution pools

| Pool | Use | Scaling/isolation |
| --- | --- | --- |
| Single-host Linux | Minimal trusted installation | Fixed concurrency; dedicated processes/containers, not shared forge process. |
| Customer VM pool | Private network, custom toolchains, stronger isolation | Registered capacity and supported provisioning; ephemeral VMs for hostile workloads. |
| Kubernetes | Customer-controlled Linux scale | Job/Pod per attempt; explicit requests/limits; cluster autoscaling integration. |
| Cloudflare Sandboxes | Verified agent/build workloads | Per-task provisioning and provider/account quota controls. |
| Cloudflare Containers / CI SDK | Verified Linux CI jobs and application runtime | Provider adapter reports supported resources/network/image constraints. |

Linux amd64 is the first verified Cloudflare pool. Portable arm64 is advertised only after its image/action corpus passes. macOS/Windows requests are explicit preflight blockers in v1.

### 8.3 Scheduler

Separate pools for untrusted PRs, trusted CI, agents, and release/deployment. Use organization fairness, concurrency caps, queue age, priority classes, regional constraints, cache locality, and budget reservations. Do not let agent fan-out consume all CI capacity.

For portable scale use queued demand plus requested resources to create execution Jobs; allow cluster autoscaler to add nodes. Scale down idle managed capacity only after draining. Customer-provided fixed runners remain supported without a provider provisioner.

For Cloudflare create instances on eligible demand, enforce per-account and Golf quotas, back off on rate limits, expose capacity saturation, and retain configured warm capacity only when the provider capability is verified. Do not invent an unsupported provider `min_instances` option.

Fallback is explicit per pool/job policy, including permitted account/region and data movement. Unsupported workloads are blocked; they are never made runnable by silently granting privileges or dropping services.

### 8.4 Isolation, networking, and caches

Hosted hostile code requires a validated sandbox or VM-backed boundary. Ordinary containers and Kubernetes namespaces alone are not represented as a universal hostile-code boundary. Use runtime-class/VM pools where required; dedicate privileged workloads.

Never mount the Golf host Docker socket into untrusted jobs. Image builds use rootless BuildKit where supported or dedicated approved builders. Pool qualification covers service-container networking, nested container requirements, disk, CPU, memory, runtime, and cleanup.

Use immutable images, authorized Git mirrors, tenant/trust-separated caches, and content-addressed build inputs. Do not persist another tenant's writable checkout. Cache keys include toolchain, lockfiles, dependencies, relevant configuration, and trust. Cloudflare limits are queried/rechecked during qualification; see [Containers limits](https://developers.cloudflare.com/containers/platform/limits/).

Logs stream with sequence numbers/reconnect, artifact upload supports retry/integrity checks, and terminal success is published only after required artifact/evidence finalization. Cancellation revokes credentials and tears down execution; cleanup failures create tracked reconciliation work.

### 8.5 Agent checkout and snapshot boundaries

Git worktrees share refs and repository configuration by default. Accordingly, Golf treats them as a performance convenience for trusted same-repository tasks, not a tenant or hostile-code isolation boundary. Use independent authorized clones/filesystems for incompatible trust levels; never mount the canonical repository common directory into arbitrary agent code. See [worktree](https://git-scm.com/docs/git-worktree).

Snapshot acceleration is optional after measurement. Snapshots have tenant/task/trust ownership, encryption, TTL, dependency/image provenance, and restore authorization. Exclude credentials and token-bearing Git URLs/configuration; restore always issues fresh attempt credentials and re-evaluates policy. Cloudflare sandbox names are scoped from authenticated identity and task/attempt IDs: looking up a sandbox by name does not authorize the caller. Use documented outbound secret injection where compatible rather than exposing provider tokens inside the sandbox. See [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/).

## 9. Agent automations, protocols, and authentication

### 9.1 Event-driven model

Agents are executable development workers, not only a chat interface. Trigger from authenticated pushes, PR/MR changes, issues, approved comment commands, schedules, failed CI, deployment outcomes, or manual requests.

Each automation records name/version, repositories, trigger/filters, task template, acceptance criteria, harness, inference configuration, credential references, runner requirements, authority, budget/runtime/concurrency, and completion behavior.

The chain is:

> Event → authenticate/deduplicate → snapshot configuration and policy → task → isolated workspace → agent run → independent checks → evidence → proposal → policy-authorized completion → cleanup.

Tasks, workspaces, runs, changes, and evidence are separate entities. A run can succeed at writing a proposal while checks fail; the UI must distinguish those outcomes.

### 9.2 Defaults and examples

Default authority is read authorized code, edit isolated workspace, run allowed tools/tests, and propose a PR/MR. Direct protected-branch writes, production changes, policy changes, release signing, and broader credentials are not granted implicitly.

Examples shipped as executable templates: scheduled dependency update; PR review; failed-build repair; docs maintenance after code changes; release-note proposal; preview smoke-test repair; approved production deployment after required checks. Each template includes expected outputs and safety/evaluation examples.

Schedules have an explicit timezone, default UTC. Missed occurrences default to skip; optional catch-up creates at most one occurrence. Deduplicate by automation/version and occurrence/event. Ignore self-generated events for the same automation unless explicitly enabled with bounded depth and budget. Coalesce superseded code-change runs by policy.

Snapshot task inputs and configuration. Mid-run permission revocation stops further privileged operations. A global/org/repository kill switch cancels pending work, revokes run credentials, and blocks new admission.

### 9.3 Harness adapters

| Harness | Interface / authentication |
| --- | --- |
| Claude Code | Documented headless structured execution; native supported account/API authentication. |
| Codex | Documented CLI/app-server execution; native ChatGPT/API or supported automation credentials. |
| OpenCode | Documented SDK/server/CLI integration; provider combinations from verified catalog. |
| Grok Build | Headless structured output and ACP; documented browser/device/API login paths. |
| Pi | Pinned RPC/SDK integration; provider/authentication combinations verified from upstream package. |

Every adapter implements start, structured events, status, cancel, terminal outcome, evidence/artifact collection, and permission failure. Session reuse is opt-in within the same organization/repository/trust boundary and never shares credential state across tenants.

Use each harness's actual interface instead of requiring ACP where unavailable. See [Claude authentication](https://code.claude.com/docs/en/authentication), [Codex authentication](https://learn.chatgpt.com/docs/auth), [OpenCode providers](https://opencode.ai/docs/providers/), [Grok Build](https://docs.x.ai/build/overview), [Grok CLI](https://docs.x.ai/build/cli/reference), and [Pi upstream](https://github.com/badlogic/pi-mono).

### 9.4 Four credential domains

Keep Golf identity, coding-agent account login, model API credentials, and infrastructure/repository credentials distinct.

Personal runners retain native credentials in their owner-controlled stores. Managed runners use supported per-user isolated credentials or explicit service/API credentials. Subscription login does not create a general model API key. Never bake credentials into images or mount a shared authentication directory across users.

Publish a harness/provider/auth matrix including headless support, account restrictions, token storage, refresh/revocation, and tested versions. OpenCode documentation explicitly notes restrictions on Claude subscription plugins; do not promise arbitrary subscription reuse. Provider policy changes can disable an affected combination without disabling unrelated Golf features.

An additional documented option is OpenAI's Sign in with ChatGPT preview for eligible third-party applications, including Codex app-server. Qualification covers registered client eligibility, user/account/workspace consent, supported models/tools, refresh/revocation, and the provider's preview restrictions. Keep this separate from ordinary Golf login and API billing. In the documented environment-token setup, refresh requires restarting app-server with the renewed token and resuming the saved thread. Do not expose unsupported hosted tools or treat this as unrestricted API access. See [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

### 9.4.1 Codex-first execution and credential ownership

Start with Codex CLI in an isolated local Docker task runtime and a separate trusted account broker. Personal account setup lives inside Golf, not in an operator terminal. [The operator runtime contract](docs/CODEX_LOCAL_RUNTIME.md) pins CLI/image/security versions, private connection state, device/API setup, full-session credential serialization, bounded source/workspace/evidence, cancellation and proposal-only output. It does not grant platform authority, complete N5, or turn a cached login into verified model access. The existing no-network CI executor retains its separate contract.

The first managed account increment is **Account settings → Coding agents**: native device/API login, provider-reported account details, pending approval/cancel, explicit provider refresh, reconnect-required states, and confirmed disconnect. [Managed account contract](docs/CODEX_ACCOUNTS.md) defines browser-only personal authority, encrypted PostgreSQL native-cache restoration, versioned mutations, key lifecycle coverage, and ownership/recovery limits. Account connection alone does not enable task execution or qualify model access. Instance-managed named accounts live under **Admin portal → Coding agents**, with default-deny immutable Golf-user grants. Personal accounts remain private; authorized users receive safe shared metadata, while current enrolled local-password administrators separately manage authentication and access. Administrator status does not imply permission to use a connection. Version-fenced updates, disabled-user denial, post-provider session/role rechecks and per-connection native ownership preserve that boundary. Golf grants do not widen provider subscriptions or licensing. Provider-reported plan and metered quota snapshots include actual window durations, used/remaining percentages, reset timestamps and earned-reset counts where supported; distinguish unknown from zero, API billing from ChatGPT quota and scheduled reset from confirmed renewed capacity. Account-only refresh does not redeem credits or execute inference.

Keep three selections independent: harness/provider/auth connection, execution pool, and repository task authority. Compose defaults to container execution; an explicitly enrolled personal machine remains an alternative. Kubernetes uses approved per-task Pods/Jobs; Cloudflare uses qualified task-owned Sandbox/Containers images, with Workers/Workflows coordinating instead of running arbitrary native CLIs in a Worker. Each environment independently qualifies resource/egress/secret isolation, cancellation and checkpoint retention.

Managed connections persist encrypted versioned credential state outside disposable workspaces. Use one fenced refresh owner per connection only where the provider's supported interface permits externally managed renewal. CLI-owned credential stores instead require isolated owner-controlled state and full-session serialization until supported concurrency is proven. Never copy one writable rotating auth cache to multiple replicas. An expired lease does not prove an old runtime stopped; reconcile/quarantine before reuse. A reconnect-required state stops new admission without silently switching accounts, API billing or providers. Local native auth volumes are separate operator state and need separate recovery; a local flock is not distributed refresh fencing. Initial account-auth tests use only explicitly trusted private source and supported provider account permissions.

### 9.4.2 Claude Code and OpenCode account adapters

The next managed-account increment adds native Claude Code browser/code and Anthropic API-key setup, plus OpenCode Zen/Go/Anthropic/OpenAI API-key connections. Reuse the existing UUID-scoped encrypted credential, personal/shared ownership, versioned name/access editing and native-process lifecycle. Harness/provider identity is immutable; API-key configuration does not imply successful inference. Claude quota is unavailable unless a supported native interface reports it. OpenCode provider OAuth and Claude Console/cloud/gateway authentication require their own qualification. [Managed harness contract](docs/AGENT_CONNECTIONS.md) specifies version pins, account-only interfaces, the additive RPC compatibility boundary, Compose packaging and remaining gates.

Keep authentication in a trusted account broker inside the Compose Golf service; never import host CLI credentials or expose a Docker socket there. Disposable native task images are separate from the broker. Managed Docker task containers, Kubernetes Pods/Jobs and Cloudflare pools need executor admission, repository authority, credential fencing/refresh capture, source/secret isolation, cancellation and proposal evidence before N5/G4 can pass. Shipping account setup and image definitions does not complete those tasks. Schema024 must remain outside the qualified recovery allowlist until a complete restore drill includes every harness/provider cache.

### 9.5 Models and Workers AI

Workers AI is first-class through native Worker bindings and REST from core/runners. Include direct Anthropic/OpenAI/xAI and configured compatible/local model endpoints. See [Workers AI](https://developers.cloudflare.com/workers-ai/).

Harness and model are independent selections only when the combination is supported. Verify streaming, tool calls, context limits, multimodal needs, cancellation, usage reporting, and errors. Do not advertise Claude Code/Codex with Workers AI without actual protocol/harness support.

AI Gateway is optional routing/observability, not a model or agent replacement. Define prompt/output logging retention and model fallback policy explicitly. Do not silently change model/provider for regulated data or cache arbitrary agent sessions. See [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

### 9.5.1 Saved agent defaults and current model catalogs

The scoped usage increment provides personal, instance, organization and repository configuration: permitted account/model/variant, instructions, triggers, exact/all model ceilings, timeout/reported-token/concurrency limits and explicit per-task override permission. Monetary caps are currently unsupported: only0 is accepted for supported subscription execution without a Golf monetary cap; positive stored caps block execution rather than being silently ignored. Paid API execution and enforceable monetary/aggregate metering remain release gates. Reuse native authorization and version-fenced browser settings; account connections and execution remain separate. Discover Codex models from native `model/list`, OpenCode models/variants from its isolated native catalog (including distinct Go provider), and explicitly label Claude aliases/effort candidates as documented rather than entitlement-verified. Store sanitized catalogs against current connection versions and reject unadvertised model/variant selections. [Usage contract](docs/AGENT_USAGE.md).

Resolve nearest defaults while intersecting every required scope's enabled/model/trigger rules, taking minimum budgets and retaining higher instructions. Read-only task preview validates explicit choices without dispatch/inference. Missing policies default-deny; preview is not admission evidence. Managed Docker/Kubernetes/Cloudflare execution must add current repository/account admission, tool/egress restrictions, cancellation, aggregate metering, trigger assignment and proposal publication. Schema025 stays outside qualified recovery until an expanded complete restore drill.

### 9.5.2 Named PR review bots and local qualification

Local advisory slice verified on 2026-10-03: actual OpenCode Go/DeepSeek V4 Pro PR-open, push and authorized-mention reviews, native bot inline publication, clean fix result, duplicate polling and disabled admission. [Evidence](docs/IMPLEMENTATION_STATUS.md#managed-opencode-go-pr-review-persona-2026-10-03). Full protected publication, fork support, fair scheduling and Kubernetes/Cloudflare execution remain open.

The first CodeRabbit/Greptile-style use case is an explicitly named, advisory security reviewer powered by a connected OpenCode Go account and an exact DeepSeek V4 catalog model. Both infrastructure tracks retain the same product contract: model access, repository permissions, expiring automation sponsorship, a separate nonadministrator publishing bot and a read-only model harness. See [the executable contract and qualification boundary](docs/PR_REVIEWERS.md).

Implementation sequence:

1. Persist repository persona, exact account/model/variant, enable/open/push/mention controls, sponsor/version/expiry and configuration CAS. Keep current-value tables and explicit New/Edit forms.
2. Admit a pinned base/head/diff under current native repository administration and all required usage ceilings. Bind durable automatic receipts to the commit pair and explicit/comment intents once across later heads. Bound paid fan-out; never silently retry failed inference.
3. Run the pinned native OpenCode binary in the dedicated local Docker daemon with model tools disabled, private credentials/cache and no project config/MCP/forge publishing credentials. Qualify the actual resolved tool configuration at worker startup.
4. Validate bounded typed findings against real new-side diff paths/lines. The trusted publisher posts an exact-head native COMMENT review with inline findings and advisory checks. Revalidate current sponsor, account, policy, reviewer and PR authority; reserve publication first and retain ambiguous outcomes without reposting.
5. Expose results and historical snapshots in Golf's PR/workflow tables and details. Extend the existing durable comment journal with explicit immutable PR association, resolving issue IDs independently of pull IDs. Authorized mentions produce follow-up reviews without general shell access.
6. Run the actual flaw → inline finding/failed check → pushed fix/clean review → mention → duplicate-suppression test on pinned licensed public source imported into a private owned local repository. Record provider/runtime failures honestly and retain the demo for inspection.
7. Expand only after the first loop is qualified: signed event intake/pagination/fair scheduling, fork boundaries, collaborator mention roles, durable publisher reconciliation, thread resolution, richer context retrieval and measured precision/latency/cost. Qualify Kubernetes and Cloudflare task executors independently; no Cloudflare service is required locally.

The initial poller deliberately supports at most 25 configured repositories per pass, the first 50 open PRs/comments, same-repository nondraft PRs and 20 hourly/outstanding admissions per repository. These limits, operator-enrolled publishing credentials and native preflight races are explicit initial boundaries, not a claim of complete CodeRabbit/GitHub parity or protected integration readiness.

### 9.6 Agent access to Golf and previews

Current bounded foundation: [owner-issued read-only API credentials](docs/API_CREDENTIAL_CONTRACT.md) delegate an existing source session for CLI/local MCP, with once-only secrets, digest storage, explicit current-read allowlisting and source-expiry/revocation coupling. This does not complete long-lived service accounts, OAuth/device login, remote MCP, ACP, tenant roles or named harness execution. Verification and remaining gates belong in the [implementation ledger](docs/IMPLEMENTATION_STATUS.md).


API/CLI/MCP expose authorized task, repository, workspace, test, evidence, PR, and deployment operations. Remote MCP uses authenticated transport and operation-scoped authorization; local adapters call the same domain API. ACP connects Golf to supported agents; it is not interchangeable with MCP tool access.

Current bounded increment: [local stdio MCP](docs/MCP_CONTRACT.md) implements discovery and 19 existing CLI/API reads using official Go SDK v1.8.0, a fixed owner-configured Golf origin and scoped Gitea PAT bootstrap. Each call creates/deletes a temporary Golf session and records session activity; the adapter does not claim side-effect-free or idempotent behavior. Native-provider/SDK-client qualification covers all 19 tools under both `2026-07-28` and legacy `2025-11-25`; separate raw-wire cancellation/framing checks cover both versions. Exact evidence is recorded in the ledger. This advances only part of P0.9/P5.5; full conformance, remote authorization, ACP, tool mutations/approvals, managed credentials, actual coding-agent clients and task execution remain separate gates.

Protected preview access for agents uses configured Access service authentication, distinct from human sign-in. Limit it to the intended application/task, rotate/revoke it, and prevent forwarding credentials to unrelated redirects. See [authenticate coding agents](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).

Where supported, broker upstream secrets through a trusted proxy so arbitrary agent code does not hold long-lived credentials. If a harness requires a credential in-process, disclose that boundary, scope it tightly, isolate the process, and use short-lived credentials where available.

Remote HTTP MCP implements the pinned specification's protected-resource metadata, authorization-server discovery, resource/audience-bound OAuth tokens, PKCE where applicable, and authorization on every request. Golf tokens are not provider login tokens; token passthrough is forbidden. Test scope failures, expired sessions, revocation, redirects, malicious discovery URLs, and confused-deputy cases. Local stdio tools use owner-controlled execution and scoped Golf credentials. See [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) and [security practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices).

ACP permission requests, tool-call cancellation, session modes, and resumed sessions map to Golf's policy and audit log. Denied/cancelled approval cannot become implicit consent; a mode change cannot widen granted authority. Codex app-server uses documented initialization, thread/turn start/resume/steer/interrupt and terminal events, with experimental features gated separately. A resumed session rechecks tools, repository access, policy and budget. Checkpoint required workspace changes and evidence with bounded retention; harness text claiming completion is not terminal execution evidence. See [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls), [session modes](https://agentclientprotocol.com/protocol/session-modes), and [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Agent run details include a durable **Conversation** view for the initiating prompt and authorized follow-ups, streamed replies, plans, tool activity/results, questions and approval decisions, with real session/turn/message identities and deep links. Logs and final results remain separately scoped. Reply/continue/steer/cancel and session restoration are adapter-capability and policy gated; transcript reload never restarts execution or resends a prompt. Record uncertain delivery, serialize competing responders, and prevent replayed history from repeating tools/approvals. Noninteractive pipeline agents have explicit wait/timeout policy. PR-comment instructions require the configured trigger and current author authority. Implement and qualify this under AM-3/P5.8 using [the conversation contract](docs/ACTIONS_RUN_METADATA_AND_PROGRESS.md#agent-conversations-and-human-participation); the current final-output adapters do not complete it. Both tracks share this behavior.

### 9.7 Multi-agent changes

Parallel tasks use independent workspaces, explicit dependencies, and quotas. File reservations can be advisory but cannot replace merge/testing. Integrate changes on a candidate based on the current target, rerun required checks, and update the branch conditionally. Never equate multiple successful individual runs with a validated combined change.

### 9.8 Task execution without AI and agent instruction provenance

Use the same durable task/evidence model for deterministic commands and optional coding harnesses. Script tasks require no model, subscription or ACP session. AI installation is optional while the release still qualifies the promised harness integrations separately.

Record the selected instruction files, paths/commits, resolved skills/plugins/MCP server configuration and harness version for each agent attempt. Preserve each harness's documented instruction precedence; do not invent one universal AGENTS.md/CLAUDE.md rule. Repository-provided extensions, hooks and server definitions require the configured trust policy before execution and cannot override Golf authority. Dependency updates require an explicit resolved-version change.

A human can inspect, stop, resume or take over work with scoped workspace access and retained diffs/checkpoints. Credential expiry or lost connectivity pauses privileged activity; resume reauthorizes the task and does not duplicate external effects. Publish task provenance alongside the resulting PR: initiating user/event, acting identity, inputs, changed files, checks, costs and known limitations. Retain/export or delete model context according to explicit project policy.

### 9.9 Outbound notifications and webhooks are portable Golf capabilities

Deliver committed repository/task/CI/review/deployment events to **generic HTTP webhooks, Slack incoming webhooks or a scoped Slack bot integration**, then qualify Teams/Discord and additional destination adapters using the same delivery contract. Start with local generic HTTP and one Slack integration before email if that provides the first useful end-to-end notification. Email follows the same event/subscription/privacy model with its own delivery-specific adapter. None of these require Cloudflare; Workers/Queues may later provide their transport implementation without changing subscriptions, permissions or event identity. Slack incoming webhooks are bound to their installed channel and cannot delete posted messages; use separately qualified bot/API operations when update/delete behavior is needed. See [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) and [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/).

**Subscriptions and disclosure:** configure installation/organization/repository/project subscriptions with explicit authorized destination ownership, scope, event filters and optional environment/workflow filters. Installation administration does not automatically authorize disclosing every repository's private content. Recheck current repository access, organization policy and approved destination/audience before each attempt and manual replay. Support CI success/failure/cancel, task/proposal status, review requests and deployment readiness/failure as consumers qualify; do not advertise unavailable producers. Templates use a bounded allowlist of metadata variables, plain-text/escaped output and explicit payload-size limits, not arbitrary code or access to environment secrets. Default notifications contain minimal authorized metadata and links; private source, diffs, secret values, model context and arbitrary comment bodies are excluded unless a separately approved disclosure policy permits that class of content. Slack channel membership does not prove Golf repository access.

**Secrets and outbound boundaries:** treat incoming-webhook URLs as credentials; encrypt destination URLs/tokens in the keyring, show masked host/resource identifiers, and keep URLs, path/query secrets, authorization headers and provider responses out of logs/history. Slack bot/API credentials have explicit workspace/channel and approved scope ownership; incoming-webhook and bot authentication are distinct supported adapters. Generic endpoints use operation-bound signing keys with controlled rotation; sending arbitrary bearer credentials or caller-configured headers is denied unless explicitly supported and scoped. Validate destination scheme/port/host and resolve addresses at save/test and every delivery; block loopback, link-local, metadata and private addresses by default, recheck DNS and the actual dialed address, and reject redirects. An intentional private receiver requires a separately approved operator egress policy and equivalent resource ownership, not a tenant-entered URL bypass. Bound connect/read/total time, response bytes, concurrent attempts and request size. Test delivery uses the same destination/network/auth controls and cannot carry real private repository data by default.

**Durability and retries:** insert the immutable event/outbox record in the same Golf database transaction as its owning state change where possible. External native writes/events are observed and deduplicated through their explicit reconciliation boundary, never claimed atomically committed with Golf. Each event and destination delivery has a stable immutable ID, source producer/commit/task identity, subscription/configuration version, policy/revocation epoch, payload digest and bounded attempt history. Outbound delivery is **at least once**: include stable event/idempotency identifiers for capable receivers, document provider-specific deduplication limits and distinguish accepted response from final human receipt. A timeout after receiver acceptance can create duplicates; do not promise exactly-once Slack/email delivery. Cloudflare transport must account for documented [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Retry transient failures using bounded exponential backoff/jitter and eligible bounded `Retry-After`; separate revoked credentials, permanent failures and rate limits. Expose redacted Test delivery, history/status, next retry, bounded error category, dead-letter reason and explicit manual redelivery. Manual redelivery reauthorizes the source/destination, preserves event identity, creates a separate attempt and never automatically expands the original disclosure. Disable/revoke fences queued attempts immediately and invalidates in-flight authority; a delivery already accepted externally cannot be recalled. Re-enable does not silently replay a backlog. Signed generic webhooks retain verification guidance and rotation overlap bounds for receivers.

**Loop and load controls:** incoming replies/provider callbacks do not recursively retrigger notifications or agents without an explicitly authorized rule. Carry origin/correlation/causation IDs, mark Golf-generated comments, deduplicate subscription deliveries, cap chain depth/fan-out and enforce tenant concurrency/budget/rate limits. Outbox workers can scale with leases and bounded batches without holding a database transaction during network I/O. Crash/lease-loss and stale callback tests must prove no false success, lost committed event, leaked payload or unbounded recursive loop.

Acceptance includes a real controlled HTTP receiver and a real approved Slack destination, invalid signature/expired-token handling where relevant, same-event redelivery after a lost ACK, restart/backoff/dead-letter/manual inspection, redacted URL/token history, DNS-rebinding/private-address/redirect denial, cross-tenant destination denial, permission loss during queue/attempt and loop suppression. Additional providers and Cloudflare transports are independently qualified adapters. This section specifies planned work; current incoming local login aliases and bounded CI are not an implemented notification system.

## 10. Cloudflare integrations

### 10.1 Activation and ownership

Cloudflare services either operate Golf or are provisioned for developer applications. Selecting the track enables appropriate setup, not automatic activation of every paid service.

Each connection records account, permissions, credentials, capability/plan prerequisites, resource inventory, quota, region/data policy, and observed health. Each resource records organization/project/environment, provider ID, ownership, desired/observed configuration, retention, and reconciliation outcome.

Customer-owned account support ships first using scoped documented credentials. Do not assume a generic Cloudflare OAuth grant exists for all management APIs. Verify exact operations/permissions during setup and reconnect when changed.

### 10.2 Product-specific service catalog

Admission rule: include an integration only when it solves a named Git/developer-tool workflow, has a concrete user outcome, and has an acceptance check plus an operating/cost justification. A product announcement, potential future client, or desire to increase service count is insufficient. First reuse the existing core/native provider path; add a service when it offers a necessary capability or measured benefit. Optional AI services remain disabled unless selected. Sample-application resources qualify only when Golf actually provisions, deploys, protects or observes them through its developer workflow.

| Service | Explicit Golf use | Stage / portable behavior |
| --- | --- | --- |
| Workers + static assets | UI edge delivery, approved routing, callback/webhook adapters | V1; portable Go/container ingress. |
| R2 | Golf LFS/artifacts/caches/releases/backups; application buckets/bindings | V1; filesystem minimal and S3-compatible storage scale. |
| Artifacts | Eligible agent/task repositories and approved build handoffs | V1; native Git workspaces otherwise. |
| Sandboxes | Agent/build execution after qualification | V1; customer sandbox/VM runtime. |
| Containers | Qualified Linux CI and deployed application runtime | V1; customer OCI execution. |
| CI SDK | Managed qualified build tasks with cache/artifact integration | V1 qualification; preserve imported pipeline semantics. |
| Workers Builds | Native managed Worker build/deploy option and caching | V1 eligible projects; one owner per pipeline/deployment. |
| Container image registry | Verified image-digest storage/promotion/retention | V1 Containers; portable OCI registry. |
| Queues | Event/work buffering and external pull consumers | V1 scale option; PostgreSQL jobs/NATS equivalent. |
| Workflows | Durable provider provisioning/deployment and approval waits | V1; Golf durable state/jobs portable. |
| Durable Objects | Provider-local sessions/container coordination and live fan-out | V1 where required; core authorization/merge ownership remains authoritative. |
| Workers AI | Model inference and compatible harness backends | V1; other APIs/local providers. |
| AI Gateway | Opt-in model routing, usage, diagnostics, BYOK-only billing controls; qualified DLP/guardrails and User Insights | V1 optional; direct provider routing and portable policy. |
| Email Service: Sending + Routing | Transactional mail, reply-to-comment, email-to-issue/task; sending lifecycle events | V1; configured SMTP/API delivery and inbound adapter portable. |
| Event Subscriptions | Artifacts/email/provider events into durable Golf intake via Queues | V1 where available; portable authenticated event adapters. |
| Workers Issues + Automations | Production error context to Golf incident and agent repair proposal | V1 optional; generic incident webhook/OTel portable. |
| Registrar / cf CLI | Domain discovery and priced registration/transfer plan | Optional application setup; explicit purchase approval, existing domains default. |
| KV Instant | Qualified low-latency non-authoritative configuration caches | Optional after benchmarks; same authority restrictions as KV. |
| K2 / Basin Pipelines, Catalog, SQL | Retained CI/deployment event replay and build-time, failure-rate and infrastructure-cost analysis | Conditional scale extension only when measured volume/query needs exceed existing event/analytics paths; core correctness remains PostgreSQL/outbox. |
| Official Cloudflare MCP servers / skills | Scoped account diagnosis, documentation, binding discovery and provisioning suggestions | V1 agent setup; opt-in, pinned skills and scoped OAuth/token connections. |
| Browser Run | Protected preview smoke tests, screenshots, accessibility evidence | V1; Playwright on customer runners. |
| Access | Protected preview/app sign-in and machine authentication | V1; portable OIDC proxy/application auth. |
| Tunnel | Reach approved private origin services | V1 optional; portable networking/ingress. |
| Workers VPC | Worker access to approved private APIs/databases | Optional, capability-gated beta; private portable connections. |
| DNS + domains + TLS | Plan/apply/verify preview and production routing | V1; configurable portable DNS adapter/manual verification. |
| Secrets Store | Worker-side secret integration | V1 optional; encrypted references/KMS portable. |
| KV | Non-authoritative cache and developer app bindings | V1 app support; never sole permission/lock authority. |
| D1 | Developer app database provisioning/migrations/recovery | V1 app support; not Golf's product database. |
| Hyperdrive | Accelerate appropriate Worker SQL access to an existing DB | Optional; direct pgx connections portable. |
| Workers Logs / tail / export | Commit/deployment-linked runtime diagnosis | V1; OTel/log collection portable. |
| Gradual deployments | Worker canary/promotion/rollback policy | V1 CD; target-specific deployment strategies. |
| WAF/rate limiting/API Shield | Appropriate protection presets for Golf/apps | Hosted V1 optional; verify protocol/plan applicability. |
| Vectorize / AI Search | Optional authorized retrieval of repository docs, runbooks and CI/preview evidence for developers or agents | After core and demonstrated search benefit; ordinary code/doc search remains available. |
| Cloudflare for SaaS | Customer vanity domains and managed certificates | Managed-hosting phase. |
| Workers for Platforms | Golf-managed user Worker hosting with limits/outbound controls | Managed-hosting phase; own-account deployment first. |
| R2 retention locks | Retained evidence/audit exports | Enterprise option; verify required governance properties. |

Generic media-product integration is outside this plan: normal application configuration can use such services without a Golf-specific module. Turnstile qualifies only for abuse prevention in human enrollment flows; it cannot become a challenge imposed on Git, API, or runner clients.

### 10.3 Avoid duplicate orchestration

Choose Golf-managed CI/CD or native Workers Builds per deployment project. When native Builds owns execution, Golf records provider runs/events and policy state rather than firing a second deploy. A gated project cannot retain an independent on-push route that bypasses Golf approval.

Native Builds supports documented origins, not arbitrary Golf/Gitea URLs. Use Golf execution or an approved immutable Artifacts handoff for other origins. Any handoff is read/build-only until release policy authorizes deployment. See [Workers CI/CD](https://developers.cloudflare.com/workers/ci-cd/) and [Artifacts builds](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/).

Queues/Workflows/DO state manages transport/provider steps, while Golf owns task policy, release approval, and canonical merge intent. Recovery reconstructs provider steps from Golf records rather than starting a parallel permission system.

### 10.4 Observability and network controls

Carry correlation IDs across core, runner, Worker, container, and deployment records. Surface live logs with redaction and effective tenant access. Export to the configured OTel/log backend; do not require users to visit several consoles to diagnose a Golf deployment.

Apply sandbox/egress policies supported by the pinned runtime. Privileged/private service access is allowlisted per task. Rate limiting/WAF/API Shield presets must be tested with Connect, webhooks, Git, runner polling, and streaming; a generic JSON schema cannot validate every wire protocol.

R2/Vectorize/AI Search indexes are derived and access-controlled. Retrieval must enforce repository/document authorization before content enters model context. Deletion and permission revocation propagate to indexes/caches; test that old embeddings do not leak revoked code.

### 10.5 Official agent tooling and inference billing

Reuse Cloudflare's official API Code Mode MCP server and relevant documentation/observability/bindings servers rather than building thousands of Cloudflare-specific tools. Offer opt-in setup for compatible harnesses, scoped OAuth permission selection or CI tokens, and reviewed/pinned official skills. Diagnostic access defaults to read-only. Arbitrary agent API execution must not bypass Golf's deployment broker: production writes still require policy-authorized exact plans and evidence. Advertise only tested transport/client combinations; current servers document Streamable HTTP and legacy URL aliases that are not the deprecated SSE transport. See [official MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).

For opted-in AI Gateway, declare the billing owner, route, provider-key alias, prompt/output retention, and fallback rules. Unified endpoints consult the default BYOK alias and can fall through to Unified Billing when it is absent. Default Golf BYOK configurations to verified `byok_only` behavior; missing/revoked keys must fail rather than charge another account. Unified Billing requires an explicit owner choice and budget. Optional DLP/guardrails are capability-tested adjuncts; they do not prove immunity to prompt injection or replace repository/egress authorization. See [BYOK precedence](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), and [BYOK-only setting](https://developers.cloudflare.com/changelog/post/2026-09-14-require-provider-credentials/).

Artifacts binding/API credentials and Git repository-scoped read/write credentials are distinct. Qualify their scopes/expiry individually; never provide account-management credentials to an arbitrary Git client. See [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/).

### 10.6 Function-level Cloudflare integration map

This table maps usable developer functions, not a checklist of services to enable. All entries are planned candidates until their exact adapter/version/account/resource and operation have runnable qualification. Portable implementations remain independent. A showcase uses only the verified subset and exposes disabled/degraded reasons in the integration view defined in section 2.3.2.

| Golf function and developer outcome | Cloudflare candidate | Required proof and resource evidence |
| --- | --- | --- |
| Authenticate/deduplicate origin events before durable admission | Workers ingress; Queues for asynchronous fan-out | Raw signature validation, exact repository/connection binding, redelivery/idempotency, bounded payloads and durable ACK; Queue delivery cannot itself authorize execution. |
| Reconcile long-running task/deployment steps | Workflows; narrowly scoped Durable Objects coordination | Crash/replay/cancel semantics, durable Golf operation identity and region/trust policy; no second authoritative permissions or workflow-result store. |
| Run an approved Linux CI/agent attempt | Sandbox/Containers | Actual pinned harness/image execution, credential/egress/resource isolation, startup/cancel/lease-loss/log/cleanup tests; native engine compatibility is separate. [Sandbox documentation](https://developers.cloudflare.com/sandbox/). |
| Accelerate eligible isolated task Git workspaces | Artifacts | Existing section 2.5 size/history gates, scoped token expiry, snapshot/fork/export/revocation and source ownership; canonical forge stays hybrid. |
| Store verified source bundles, artifacts and evidence | R2 | Conditional create/replay/hash verification, private immutable binding, scoped access, cleanup/retention and restart/recovery against actual R2, not only a compatible local service. |
| Cache rebuildable capability/configuration/public-read projections | Workers KV, including KV Instant where measured | Useful measured latency improvement, versioned keys and explicit staleness behavior. Never use cache freshness for permission, lease, approval, revocation or source-of-truth decisions. [KV Instant announcement](https://blog.cloudflare.com/workers-kv-instant/). |
| Optional application/preview data and origin connectivity | D1; Hyperdrive where compatible | Separate preview data and migrations; D1 is an application binding, not an unqualified replacement for Golf/PostgreSQL. Hyperdrive connectivity requires supported origin/TLS/pooling qualification. |
| Deliver approved outbound webhooks/Slack notifications | Workers HTTP delivery and Queues transport | Same durable subscription/outbox identity, destination approval, SSRF/redirect controls, signature/token masking, at-least-once retry/dead-letter and revocation fences; no provider transport grants permission. |
| Send CI/task/review/deployment notifications and process authorized email replies | Email Service outbound; Email Routing/Workers inbound | Authorized verified sender/domain and recipient policy, actual delivery/bounce/suppression, signed reply binding and current repository access. Outbound sending is currently beta; account/plan eligibility must be checked. [Email Service documentation](https://developers.cloudflare.com/email-service/). |
| Publish protected preview and production artifacts | Workers/assets/Containers; Workers Builds only with explicit build ownership | Exact source/artifact/config, separate credentials, protection before exposure, alternate URL denial, health checks and approval-bound promotion; external automatic build paths cannot bypass Golf policy. |
| Protect preview viewers and scoped machine smoke tests | Access, optional Tunnel origin reachability | Human and machine authentication, expiry/revoke, redirect/alternate-host bypass tests, host-cookie separation; reachability alone is not authorization. |
| Bind approved domains and certificates | DNS, custom domains/Cloudflare for SaaS as applicable | Exact zone/namespace rights, adoption diff, no unrelated DNS overwrite, domain and certificate readiness plus full cleanup. |
| Provision isolated developer application resources | R2/D1/KV/Queues/DO/service bindings | Per-environment ownership, selected account/resource policy, isolation against production and idempotent provisioning; compile-time binding configuration alone is not observed readiness. |
| Route optional model traffic or run supported inference | AI Gateway/Workers AI | Actual supported harness/model combination, explicit billing owner/BYOK-only/fallback/data policy, tool/stream/cancel/usage evidence; no arbitrary subscription-token reuse. |
| Retrieve authorized repository/docs context | Vectorize/AI Search | ACL-filtered retrieval, permission/deletion propagation, tenant isolation and context provenance; embeddings cannot preserve revoked access. |
| Observe/support integration operations and protect edge endpoints | Logs/observability, Analytics Engine, WAF/rate limiting/API Shield where compatible | Correlated operation IDs, redaction/retention, cost/queue metrics and tests with Connect/Git/webhook/stream traffic. Security products do not substitute for domain authority. |

Only provision a service when it serves one of these tested functions. Shared Cloudflare connection consent may cover multiple services, but each function gets its own permission/resource checklist and last-test evidence. A failure in optional inference must not disable Git, email or deterministic CI. A production DNS/Access failure must withhold preview/deployment readiness even when compute is healthy.

## 11. Environment setup, protected previews, and production CD

### 11.1 Developer workflow

Connect repo/account → detect existing configuration → choose Workers/Containers/customer target → declare resources/domains → review provisioning diff → apply → verify → deploy → inspect protected link/logs → promote or recover.

This environment workflow is a core product feature, not a collection of unrelated Cloudflare API buttons.

### 11.2 Configuration and authority

Reuse versioned `wrangler.jsonc`/Wrangler configuration, Dockerfiles, Compose, Helm, and existing IaC where present. Do not invent a replacement infrastructure language.

Golf stores project/account/environment bindings, approved domain namespace, credentials, and policy. Repository configuration supplies application build/runtime/resource intent. Organization policy is an upper bound: repository changes cannot grant new credentials, bypass approval, or expand account access.

At plan time snapshot commit, effective app config, policy version, build outputs, and desired resources. Render a proposed diff and block conflicting ownership. Select one writer per resource: Golf, external IaC, or observe-only. External-IaC resources are applied by their approved workflow rather than overwritten by Golf APIs.

### 11.3 Reconciliation

Use stable operation IDs and dependency ordering: approved resource allocation → bindings/secrets → Access/routing protection → application deployment → DNS/TLS readiness → health → publish/promote. Serialize conflicting changes per environment/resource and fence stale attempts.

Persist desired/observed state and external IDs after each step. Retries inspect provider state before creating replacements. Track orphan resources and incomplete cleanup; only delete Golf-owned resources or explicitly approved adopted resources. Preserve previous configuration for reversible changes, but do not claim atomic rollback of all provider resources.

Drift defaults to report and pause conflicting deployment. Automatically reconcile only changes within an approved ownership/policy scope. Destroy operations on production resources require an explicit approved plan.

### 11.4 Existing-project adoption

Inventory Workers, container applications, image versions, bindings, resource IDs, secrets metadata, routes, domains, DNS, Access, and current deployment ownership. Produce an adoption diff before mutations. Unknown/unreadable secrets require reconnect; never guess values.

Preserve externally managed resources and unrelated DNS. Record the ownership boundary. A successful import of configuration is not authorization to replace the app or delete its storage.

### 11.5 Protected previews

Preview stages: requested → provisioning → protected → deploying → verifying → ready; failure/cancel/expiry/cleanup are explicit states.

Bind to repository and exact commit. Allocate environment-specific writable resources and nonproduction secrets. Configure Access protection before exposing protected code, then deploy and verify every hostname, including provider default/version URLs and alternate routes. Disable unsupported bypass endpoints or withhold readiness.

Use a separate preview domain boundary from Golf's authenticated UI. Golf cookies are host-scoped; preview applications receive none. Keep unsafe content out of Golf's origin, validate framing policy, and restrict CORS. Signed-in reviewers still execute untrusted preview JavaScript.

Provide a stable PR/branch link and exact-deployment link when available. Report protection, commit, test evidence, expiry, and readiness on the PR/MR. Browser/agent smoke tests use scoped machine access rather than public bypass.

Default TTL is seven days refreshed by successful update, with immediate teardown on closed PR unless retained by policy. Cleanup includes owned DNS, Access configuration, runtime, and disposable resources; retained data/evidence follows its own retention policy.

Workers Previews are public by default and resource isolation depends on bindings. `noindex` is not access protection. See [Previews](https://developers.cloudflare.com/workers/previews/), [resource isolation](https://developers.cloudflare.com/workers/previews/resources/), and [Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

### 11.6 Preview databases/data

Default to schema plus synthetic fixtures. Production data copying requires explicit policy and sanitization. Provision separate D1/database schemas or instances as appropriate, separate R2 buckets/prefixes with effective scoped access, KV namespaces, queues, and credentials. Prefixing alone is not treated as a security boundary unless enforced by access controls.

Run preview migrations on preview data only. Record migration version and seed input. Production service bindings are denied by default; sharing a read-only dependency is explicit. Test isolation by attempting writes from preview to production.

### 11.7 DNS, custom domains, and TLS

Support selected existing zones, verified domains, approved preview subdomains, production custom domains, and required A/AAAA/CNAME/TXT changes. Detect record conflicts, domain ownership, routing loops, and external ownership. Never overwrite unrelated MX/TXT or an existing app's records automatically.

First adoption/production routing changes show the exact diff. Preview records under an approved namespace may reconcile automatically. Wait for provider domain/certificate readiness and external DNS verification before success. Account for TTL/propagation and concurrent edits during rollback.

For Golf-managed hosting use Cloudflare for SaaS custom hostnames and certificate lifecycle, including customers with DNS elsewhere. Verify both hostname and certificate activation plus routing, not just a successful TLS handshake. See [hostname readiness](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/).

### 11.8 Production CD

V1 targets: Workers/static assets, Cloudflare Containers, customer Kubernetes, and customer Compose hosts through registered deployment runners. Provision/adopt R2, D1, KV, Queues, DO, AI, and other cataloged application bindings as required.

Build once and identify outputs by digest. Approvals bind source commit, artifact digest, effective config, target environment, and migration intent. Changed inputs invalidate approval. Promote existing immutable artifacts where supported; record deterministic environment-specific packaging when required.

Separate untrusted build/agent execution from trusted deployment. Builds produce artifacts; trusted deployment brokers receive scoped production credentials only after policy authorization. Arbitrary repository build commands cannot access those credentials.

Release stages: built → checked → staged → approved → deploying → verifying → healthy; rollback/failed/degraded states retain partial provider results.

Use configured health endpoints, smoke checks, timeout, and error criteria. Workers can use qualified gradual deployments. Containers track Worker version, image digest, rollout ID, instance distribution, and runtime health separately. Worker activation and container rollout are not transactional; see [Containers deployment](https://developers.cloudflare.com/containers/guides/deploy/).

### 11.9 Recovery and application backups

Keep known-good artifacts/configuration and implement target-specific application rollback. Use expand/contract migrations; destructive migrations require their own approved recovery plan and cannot promise automatic reverse.

For D1 applications expose Time Travel recovery plus export/restore evidence. Restoring a database may lose later writes and requires explicit approved recovery intent. See [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

For R2 applications configure private access, bindings, CORS only when required, lifecycle/retention, export/backups, and deliberate delete behavior. Separate Golf's storage credentials from application credentials. Export critical recovery material outside the active provider account when the chosen recovery profile requires it.

### 11.10 Portable previews and deployment contract

The portable path uses a configured reverse proxy/ingress with an OIDC authentication proxy (for example, a qualified OAuth2 Proxy configuration) or Golf's scoped preview gateway. The default must support Golf local-account sessions as well as configured OIDC; it cannot require Cloudflare or an external identity service. Use a separate preview origin, audience/preview-scoped short-lived grants, validated upstream identity and a restricted upstream network. Client-supplied identity headers are stripped. Host-published ports, node ports and direct runtime endpoints must not bypass protection. Machine smoke tests get task-scoped credentials. See [OAuth2 Proxy configuration](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/) for one reusable OIDC option.

Compose deployments run through an enrolled host agent with explicit permitted project paths, resource/port/volume limits and secret references. Kubernetes uses namespace-scoped deployment credentials and allowed resource kinds; neither accepts arbitrary privileged manifests, host mounts or cluster-role changes under a routine app-deploy grant. Configuration that requests more authority is a separate reviewed infrastructure operation. CI success does not authorize those changes.

Portable DNS supports a manual verified-record path in v1; external DNS adapters are individually cataloged. ACME or operator-provided TLS works with configured public/private DNS. Preview readiness requires authentication, routing, certificate and application checks. Native canary/rolling support is target-specific: plain Compose initially has documented stop/start or blue-green behavior and downtime expectations, while Kubernetes rollout health and rollback have their own checks.

## 12. Public interfaces and durable contracts

### 12.1 API, CLI, MCP, ACP

Generated Connect APIs are primary. REST exists for OAuth/OIDC callbacks, health/metrics, Git/provider protocol endpoints, webhook ingress, runner transport, and upload/streaming needs. UI, CLI, MCP, and internal orchestration call the same domain operations and authorization.

CLI command groups: `golf auth`, `repo`, `connection`, `import`, `issue`, `pr`, `pipeline`, `automation`, `run`, `runner`, `project`, `environment`, `deploy`, `audit`, and `admin`. Provide human output and stable JSON mode, predictable exit codes, and no secret values in ordinary output. Batch-safe noninteractive behavior is explicit.

MCP tools cover authorized inspection and mutations without bypassing approvals. ACP is an agent adapter/session protocol where supported, not a second Golf permission system. Document each protocol's supported version and authentication.

### 12.2 Entity minimums

| Entity | Required associations |
| --- | --- |
| Organization/account/membership | Identity, roles, linkage proofs, backend mapping. |
| Repository | Canonical mode/backend/origin, provider ID, protection, cell. |
| Pipeline/run/job/attempt | Source format, resolved config, commit, plan hash, policy, resources, lease. |
| Pool/runner/session | Capabilities, trust, enrollment/session identity, heartbeat, drain. |
| Automation/task/run | Versioned trigger/template, authority, harness/provider, limits/outcome. |
| Workspace/change/evidence | Base/head commits, attempts, checks/artifacts, expiry. |
| Connection/credential reference | Account/instance, operation scopes, secret store, expiry/revocation. |
| Project/environment | Repository, target, domains/resources, deployment policy. |
| Deployment/approval | Immutable outputs/config, approver/policy, rollout/health. |
| Managed resource/operation | Ownership, desired/observed state, external ID, reconciliation. |
| Audit/outbox | Actor/delegation, action, object, policy, outcome, idempotency/delivery. |
| Usage/reservation | Organization/job, unit, reserved/observed quantity, reconciliation. |

Use tenant keys on owned data and references; enforce them in every read/write path and resource lookup. Secrets are references, never embedded in prompts, job plans, logs, or generic entity exports.

### 12.3 Reliability rules

Mutations use idempotency where retries are expected and optimistic concurrency where lost edits matter. State and outbox commit together. Delivery is at least once; consumers deduplicate. Freeze resolved workflow/action/include versions for a run.

Runner leases and resource operations have fencing. Large logs/artifacts live outside relational rows with integrity and access metadata. Terminal results become immutable per attempt; reconciliation can add corrected observations without silently rewriting audit history.

Irreversible external effects are not claimed exactly-once. Inspect existing effects by operation ID before retry, and require operator recovery for ambiguous non-idempotent actions.

The implemented [repository-creation contract](docs/REPOSITORY_CREATION_CONTRACT.md) is a bounded first mutation journal: exact-input UUID binding per immutable account/forge, reservation plus initial event committed before one native POST, and typed unknown/success/rejection evidence. It has no dispatch worker or outbox. Repeated keys never resend, successful output rechecks current native repository ID/access, and the browser resumes status inspection only after reload. Actual Gitea acknowledgment loss remains unknown across replay/restart with one counted POST; it is not automatically adopted by name. Concurrent/rollback/privacy tests and fresh-restore operation/event preservation pass. Other operations still need their own semantics, tenant model and external-effect proofs; P1.3, P2.2 and P0.8 are not complete.

### 12.4 Notifications

V1 includes in-app activity, watch/subscription settings, digests, transactional email and user-configured outgoing webhooks with delivery/retry status. Notifications are asynchronous and never on the critical path for Git writes or merge correctness. Preferences and repository permissions apply at send time; avoid leaking private titles/diffs to removed members.

On the Cloudflare track, use Email Service Sending for outbound transactional mail and Routing/Email Workers for inbound mail. Prefer a narrow binding or scoped REST credential; SMTP is also documented. Outbound sending is currently beta and requires the appropriate paid plan; setup checks eligibility, quotas, suppression and verified sending domains. Domain onboarding plans MX/SPF/DKIM/DMARC changes with ownership/conflict checks, preserving existing mail hosting. Email Routing alone must not be represented as unrestricted transactional sending. See [Email Service](https://developers.cloudflare.com/email-service/) and [sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/).

Notifications cover invites/account verification, assignments/mentions, review requests, CI failure/recovery, preview-ready/expired, release/deployment outcomes, incidents and budget thresholds. Default content provides summaries and authenticated links, never secrets or unfiltered logs. Record queued/provider-accepted/delivered/deferred/bounced outcomes honestly. Consume documented sending lifecycle events through Event Subscriptions/Queues; recipient-server acceptance does not prove that a human read the message. Sending events exclude inbound Routing events. See [email event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/).

Portable deployments use configured SMTP or an explicit API provider, plus an inbound SMTP/provider adapter where needed. Local development uses a mail catcher. Disconnected deployments can use local mail infrastructure or leave external notifications disabled with visible capability status.

### 12.5 Inbound email and agent requests

Support project-specific issue/task addresses and scoped reply addresses for issue/PR/MR threads. Bounded MIME parsing, attachment size/type limits, malware/quarantine policy, sanitized rendering, Message-ID/thread deduplication and auto-reply loop detection are required. Attachments remain authorized objects, not public R2 links.

From-address and body instructions do not establish Golf identity or deployment authority. Associate replies using opaque scoped routing tokens and current membership checks; risky commands require Golf-authenticated confirmation. Unknown senders may create moderated external-intake issues where enabled, never privileged tasks. Repository instructions, email, issues and attached logs remain untrusted input to agents. An authorized email task can propose a change; it cannot silently approve or deploy it. Apply spam/abuse quotas and audited retention/export/deletion.

### 12.6 Public webhooks and provider event ingress

Publish a versioned event catalog for repository/ref, issue, PR/MR/review, check/pipeline, task/agent, artifact/release, preview/deployment, incident and budget events. Subscriptions select repository/environment/event filters and minimal payload fields. Include stable event/delivery IDs, event time, schema version, causal IDs and exact commit/run/deployment references where applicable.

Outbound delivery signs timestamp plus exact body using rotated per-subscription HMAC secrets, verifies TLS, provides bounded retry/backoff and dead-letter status, and exposes audited authorized redelivery. Delivery is at least once; consumers deduplicate. No exactly-once claim, global ordering assumption, credential forwarding across redirects, or executable custom formatter. Validate destination DNS/IP on every connection and retry to prevent SSRF, including rebinding and private/metadata endpoints; private destinations require an explicit constrained connection.

Inbound integrations verify each provider's documented signature/token and replay/size limits, then durably intake before acknowledgment. Test duplicated, reordered and malicious events. Cloudflare Notifications uses its documented secret header rather than Golf's outbound signature format and is plan-gated; Event Subscriptions/Queues is a separate delivery mechanism. Workers Issues generic webhooks map diagnostic context to authorized Golf incident/task records, with deduplication, severity thresholds and repair budgets. See [Cloudflare Notifications webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/) and [production issue automations](https://blog.cloudflare.com/real-time-issue-detection/).

### 12.7 Stable client and event contracts

Version public API schemas and events; publish pagination, filter/sort semantics, errors, rate-limit/retry behavior, idempotency-key scope/expiry and optimistic-concurrency rules. Additive compatible fields cannot silently change existing meaning. CLI JSON carries a documented schema version; noninteractive commands return approval-required/unsupported outcomes without waiting for hidden prompts. Provide generated clients, CLI completion/help, setup examples, MCP tool descriptions and offline documentation.

Persist notification preference, email/thread/message/delivery, webhook subscription/delivery, incident/occurrence, signing-key, Git-token/SSH-key and retention/tombstone records alongside section 12.2's entities. A provider event maps to a tenant-scoped known resource before it can create a task. Durable schema transitions are reviewed in P0.3/P1.1 rather than stored as unversioned arbitrary JSON.

## 13. Installation profiles, OSS, and enterprise

### 13.1 Profiles are independent of track and edition

| Profile | Required deployment | Optional expansion |
| --- | --- | --- |
| Minimal | Golf, PostgreSQL, Gitea, persistent Git/artifact volumes, basic health/audit/backup | Trusted Linux runner; selected Cloudflare services. |
| Team | Separate background/runner processes, object storage, scheduled backups, quotas | Full observability, search, additional pools. |
| Scale | Kubernetes, independently scaled workers/runners, HA database/storage, queue, indexed search | Regional cells and dedicated tenant placement. |
| Enterprise | Supported HA/regional distribution, federation/lifecycle, governance | Government pack, HSM/KMS, managed hosting, dedicated pools. |

Single-node profiles do not claim HA. Their security/data-integrity requirements remain intact. PostgreSQL is required rather than introducing a second product database solely to save one container.

### 13.2 Compose and Kubernetes

Use the same versioned application images, configuration schema, migrations, capability gates, and health logic. Compose deploys single-host services with named persistent volumes; bundle Gitea by default or connect an explicitly qualified external Gitea installation. Runners, object storage and observability use optional profiles.

Helm packages API/worker roles, Gitea or its external connection, execution configuration, ingress, persistent storage, resource requests/limits, probes, security contexts, secrets references, and network policy. Support external PostgreSQL/object storage instead of forcing bundled production databases.

Pin a maintained Gitea release and image digest in the version inventory. Give Gitea its own PostgreSQL database and role; Golf application features cannot directly query or migrate that database. Privileged offline backup/recovery may use documented native database tools against a stopped, drained installation and a fresh quarantined target; this narrow P1.6 operator boundary does not permit direct application writes. Begin with one active canonical repository writer and supported persistent storage. Additional Golf API/workers/runners may scale independently; Gitea HA or shared repository storage needs a separate validated topology, write fencing and recovery proof before multiple writers are enabled.

Coordinated backups include Golf's database, Gitea's database, Git repositories, LFS objects, attachments/releases, relevant configuration, encryption material and SSH/signing keys. Encrypt backup secrets and preserve supported Gitea restore procedures. Fence writes for a consistent recovery point when required; restore the pinned compatible versions and verify identities, protected refs, LFS, signatures and Golf projections before reopening writes. R2/S3 may store qualified object categories and backups; neither is assumed to replace Gitea's repository filesystem.

The current [offline recovery foundation](docs/RECOVERY.md) implements encrypted native capture/validation and fresh quarantined restoration for the canonical three-service Docker profile only: PostgreSQL 18.4, Gitea 1.27.3 and Golf schema 202610020004, with source runtime configuration, both complete Gitea volumes and locally available exact image IDs. Images are not bundled. The operator must drain all writers; repeated state checks and `--writers-drained` are not an administrator or distributed fence. Real PostgreSQL invalidation, offline archive checks and the bounded native fresh-restore/whole-stack restart drill pass in the [evidence ledger](docs/IMPLEMENTATION_STATUS.md). The small fixture skips its minimum-size-cap negative case; no 8 GiB, load or RPO/RTO result is claimed. Kubernetes, external stores/databases, cross-version restore, full inventory/scale and production recovery objectives remain P1.6 work.

Migrations run once with locking and explicit outcome; concurrent application instances do not race to alter schema. Default images run non-root where their function permits. No application cluster-admin permission. Per-job service accounts and network boundaries are explicit.

Avoid a custom Kubernetes operator in v1; normal Helm and background reconciliation cover the specified needs. Add an operator only when repeated lifecycle operations justify it.

### 13.3 Configuration and startup

Configuration is versioned and validated. Invalid security/backend combinations fail startup or disable the dependent feature with a clear diagnostic. Report effective capabilities without secret values.

External access is opt-in. The portable track must not contact Cloudflare, model vendors, registries, analytics, or fonts unless configured. API and Git health do not depend on AI providers being reachable.

### 13.4 Disconnected distribution

Bundle signed manifests/BOM, images, frontend assets, schemas/migrations, necessary action/dependency mirrors, and installation instructions. Verify signature before extraction/import. Use a local OCI registry and configured local object storage, identity, and inference.

No public-registry fallback on cache miss by default. Offline pipeline preflight identifies missing dependencies before work starts. Cloudflare and external model capabilities remain unavailable rather than simulated. All portable core paths are reachable without public-network calls.

### 13.5 OSS and enterprise

Default license for new OSS code: Apache-2.0. Complete license review of bundled/reused forge and runner components; preserve required notices. Commercial feature boundaries do not change upstream licensing obligations.

| OSS foundation | Enterprise additions |
| --- | --- |
| Shared Gitea-backed forge on both infrastructure tracks | Supported HA/regional distributions and operational support. |
| Compose and Helm/Kubernetes | Advanced identity lifecycle/SCIM and supported SAML/PIV federation. |
| Core CI, agents, CLI/API/MCP/ACP adapters | Organization-wide governance, advanced policy administration. |
| GitHub/GitLab connections and import/export | Compliance evidence workflows, retention governance/legal hold. |
| Protected previews and production CD | Dedicated tenant placement/pools and supported restricted deployments. |
| Core OIDC, authorization, encryption, audit/export, backups | HSM/KMS integrations and government/hardened distributions. |
| Own-infrastructure and Cloudflare adapters | Managed hosting, metering/billing, and service commitments. |

Do not paywall safe authorization, baseline audit export, encrypted credentials, restoration, or portability. Basic OIDC is OSS. Optional generic customer infrastructure remains usable without enterprise entitlement.

Use one core code path with actual feature modules where needed. Do not fork every domain into OSS/enterprise implementations or add empty abstractions for later licensing. License expiration disables new premium actions according to documented policy; it must not erase data, disable export, or prevent safe recovery.

### 13.6 Upgrades

Publish supported installation and runner/coordinator version ranges. V1 initially supports direct upgrade from the previous published minor release, with documented intermediate steps for older versions. Preproduction development can reset disposable data; released customer data cannot.

An upgrade preflight checks schema/version, capacity, backup verification, image availability, runner compatibility, and provider configuration. Create a recoverable checkpoint. Apply expand/contract database changes so compatible old/new processes can coexist during rolling upgrades.

Drain incompatible runners and long-running deployment operations before breaking changes. Track migration completion and interrupted upgrade recovery. Downgrading a binary is not assumed to reverse a schema migration; provide compatible rollback or restore instructions.

Test upgrade from the supported prior version, mixed compatible coordinator/runner versions, interruption during migration, and recovery into a fresh installation. Include offline bundle upgrades and key/credential rotation.

## 14. Security, supply chain, and government capabilities

### 14.1 Baseline threat boundaries

Treat repository content, workflows, instructions, issues, dependencies, build scripts, agent output, and preview applications as untrusted. They cannot expand permission, alter server policy, or create production credentials.

Enforce tenant isolation on database rows, Git paths, object storage, caches, logs, search/retrieval, credentials, and provider resource references. Role checks are centralized and protected operations reevaluate authorization at the time of execution.

Provide safe OAuth/OIDC state/nonce/PKCE, session expiration/refresh rotation, CSRF/origin checks, rate limits, account-linking proof, and revocation. Do not conflate provider OAuth login with repository-management consent.

Webhooks require provider-authenticated validation and replay/deduplication handling. Origin connections/includes/health URLs guard against SSRF, credential forwarding, malicious redirects, and unauthorized private-network access. Archive/bundle extraction guards against path traversal and unexpected executable payloads.

### 14.2 Credentials and production boundaries

Credential records carry key identifier, algorithm, and ciphertext. Support rotation and emergency revocation. The guide's age default and assurance-specific encryption require an explicit disposition; the current credential families use the narrow AES-GCM departure recorded in ADR 0001. [ADR 0005](docs/decisions/0005-credential-keyring-and-drained-rotation.md) and the [keyring contract](docs/CREDENTIAL_KEYRING.md) extend that implementation with immutable label/material binding, drained activation, bounded re-encryption and zero-use retirement checks. The ledger records bounded database and old-binary PAT/pending-verifier qualification; this adds no KMS, explicit algorithm migration, secret erasure, emergency-compromise guarantee or transparent rolling cutover. Live OAuth exchange across activation and deployment/recovery qualification remain open. It does not silently approve the full guide/security disposition.

Agent/model credentials, repository credentials, and deployment credentials are separately scoped. Long-lived Cloudflare account credentials are held by trusted control/deployment components, not arbitrary builds. Job credentials expire, are revoked on cancellation, and cannot list other tenants' resources.

Secrets must be redacted before logs/artifacts/UI/provider diagnostic export. Redaction supplements access control; it cannot guarantee arbitrary transformed secrets are undetectable. Keep live keys out of model context. Configure prompt/output retention separately from operational audit.

### 14.3 Supply-chain evidence

Pin actions/includes, image digests, toolchain versions, and dependency lockfiles. Scan history/secrets and dependencies with the guide's gosec/govulncheck/gitleaks and appropriate TypeScript/container scanning.

Generate SBOM and provenance identifying source commit, build inputs, builder identity/trust, pipeline definition, and output digest. Sign trusted release artifacts using a configured signing service; untrusted PR builders cannot use release-signing credentials.

Deployment admission verifies required signature/provenance, output digest, approved builder/policy, and exact inputs. Signing a digest without trustworthy build provenance is insufficient. Offline installations use configured local trust roots and verification material rather than relying on public services.

Test unsigned/untrusted/replaced artifact rejection, stale approval, altered image tag, compromised dependency source, and absence of production credentials in the build process.

### 14.4 Audit and retention

Current account-security increment: [own password/login-alias changes](docs/ACCOUNT_SECURITY_CONTRACT.md) and [ordinary local-account administration](docs/INSTANCE_ACCOUNT_LIFECYCLE_CONTRACT.md) add current-password confirmation, immutable identity/version checks, atomic session revocation and actor history. Login aliases remain unverified; native account provisioning, verified mail/recovery, MFA/SSO and administrator role lifecycle remain open. This advances P1.2/P1.3/P1.4/P1.8 without completing them. Live evidence is recorded in the [implementation ledger](docs/IMPLEMENTATION_STATUS.md).

Current bounded foundation: the [account audit contract](docs/ACCOUNT_AUDIT_CONTRACT.md) records five successful Golf session action classes transactionally, with own-account API/UI/CLI reads and stable keyset snapshots. Existing history is not backfilled; automatic expiry cleanup, OAuth refresh, credential-rejection deletion, failed attempts and provider writes are not events. SQL guards reject ordinary history edits but a database owner can alter them. Audit-aware writers must replace all older binaries before claiming an audited operating window; the single-service upgrade proof does not qualify mixed-version rolling audit continuity. This advances P1.3/P1.8/P5.5, without completing broader audit coverage, retention/export, outbox, jobs or recovery. Qualification is in the [implementation ledger](docs/IMPLEMENTATION_STATUS.md).

Audit login/linking, membership/policy changes, connection grants/revocation, repository writes, automation authority, runner enrollment, credential access, deployment/DNS/resource operations, approvals, and recovery. Include actor/delegated agent, repository/environment, policy/config version, commit/output, operation ID, outcome, and timestamp.

Append-only application records and controlled retention are baseline. Enterprise can export to retention-enforced storage and manage legal hold/evidence. R2 bucket locks are one available retention mechanism, not an automatic compliance claim. See [bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

Deletion has a documented lifecycle: disable new use and credentials, cancel/drain active work, remove public/private read access and projections, apply retention/hold policy, then purge owned Git/LFS/object/index/provider resources. Report delayed cleanup and backup retention; do not claim backup data disappeared immediately. Restore replays tombstones and revocations before accepting traffic. Export includes portable Git/LFS plus a versioned metadata manifest and attachment checksums, excluding live credentials.

Render README/Markdown, comments, diffs, ANSI logs and attachments as untrusted content with bounded sanitization. Serve raw active content/downloads from an isolated origin with appropriate content type/disposition; enforce CSP, framing and download authorization. Short-lived direct object URLs have a documented maximum revocation delay; hardened immediate-revocation paths use an authorized proxy. Terminal logs cannot execute browser actions or inject trusted status UI.

### 14.5 Government pack

Optional capabilities: PIV/CAC-compatible federation, stronger authentication assurance, controlled device/session access, SCIM lifecycle, separation of duties, immutable retention, evidence/control mapping, HSM/KMS, restricted egress, signed updates, disconnected distributions, and supported hardened images.

Define required evidence and deployment scope per capability. A product setting does not establish FedRAMP authorization, an ATO, or full regulatory compliance. Cloudflare service eligibility/data localization must be verified individually for the relevant workload and contract.

### 14.6 FIPS distribution

Provide an explicit `make fips-build` and frozen module/operating-environment selection. Use Go's supported FIPS mechanisms and verify the appropriate module status before distribution. A tag or runtime flag alone is not the assurance boundary.

Inventory crypto in Golf, JWT/encryption/password paths, Git/SSH, database, storage, ingress, runner engines, signing, and dependencies. Resolve default age algorithm incompatibilities through the assurance ADR; do not run an unapproved encryption path under a FIPS label. Do not require Go's assessment-only restrictive mode as a production shortcut.

Produce module/version inventory, startup/module tests, supported environment documentation, and validation evidence for the distribution. See [Go FIPS guidance](https://go.dev/doc/security/fips140).

## 15. Performance, cost, reliability, and recovery

### 15.1 Performance is measured end to end

Measure navigation, workspace readiness, queue/dispatch, first trustworthy CI result, complete pipeline, preview readiness, and release recovery. Separate cold/warm runs, cache state, repository size, resource class, and region. Compare equivalent workflows/resources rather than claiming an edge network makes builds inherently faster.

| Measure | Initial engineering target under documented benchmark |
| --- | --- |
| Metadata read API | p95 below 300 ms in serving region. |
| Warm eligible job dispatch | p95 below 2 seconds with available capacity. |
| Log delivery | p95 below 1 second after runner emission. |
| Warm workspace readiness | p95 below 10 seconds for reference repository. |
| HA metadata API availability | 99.9% monthly design target; production SLA only after operational evidence. |

Reference portable profile: 4 vCPU/8 GiB core with SSD, separate PostgreSQL/object storage, local-network dependencies, at least 10 warm Linux execution slots, 20 concurrent metadata clients, and a 100 MB checkout repository with deterministic 60-second fixture jobs. Record exact hardware/images, history/object count, latency, and dependency state with each result. Run separate 1 GB/large-history and 100/1,000-job burst profiles; these are load tests, not guaranteed hosted limits.

Cloudflare qualification records account plan, instance type, region, provider quota, network paths, and cold-start distributions. Publish results and failures; provider-derived costs/limits are date-stamped.

### 15.1.1 Stable, fast live workspaces

Treat the repository UI as a performance boundary. Completed immutable reads bind the signed-in actor, current repository ID, exact object/commit and literal path. Retain them in mounted, bounded memory; ordinary viewport exit/reentry, heartbeat, unrelated activity and focus must not refetch or rebuild those objects. Mutable metadata, issues, PRs and execution observations have separate live invalidation. Preserve decoded image/Markdown/code DOM and scroll geometry while repository authority is checked; hide private content and disable interaction during the check, then remove it on denial or sign-out. Cache entries never establish authority or cross actors/repositories. No private source persistence in browser storage or shared edge caches. Full document reload still establishes the current managed session and native access.

Required browser acceptance: repeated down/up scroll produces zero additional requests for previously completed rows; unchanged snapshot/live heartbeats produce zero source/README/image reads; metadata access checks preserve document height and accepted DOM identity; source movement remains opt-in; wrong receipts, membership loss, disabled accounts and expired sessions clear private content. Measure initial visible-row concurrency, requests/bytes per navigation, duplicate reads, long tasks, image decode, warm/cold navigation, interaction latency and layout shift on desktop and constrained mobile. Initial interaction target is p95 below200ms and CLS below0.1 under the recorded reference workload; these are engineering targets until measured.

Millions of projects/users require bounded cell-local projections and event fan-out, not a timer and native API read per client. The current live prototype uses a short Connect stream, native authority checks, two-second polling and a32-stream/four-per-user admission cap; this is a local bound, not million-user qualification. Implement scoped subscriptions backed by the durable activity/outbox cursor, coalesced invalidation, multiplexed authorized streams, reconnect replay/gap detection, backpressure and bounded per-user/repository/cell fan-out. Portable deployments may use measured PostgreSQL notifications and optional Valkey disposable fan-out; Cloudflare placement may use separately qualified Workers/Durable Objects fan-out. The durable journal and current native/session authority remain authoritative. Scale tests must cover many idle repositories, hot repositories, reconnect storms, revoked subscribers, slow clients, dependency loss and multi-replica delivery without leaking topics/private bodies or scanning all projects. Record p95/p99 delivery lag, native/SQL calls per subscriber, memory, dropped/coalesced events and recovery. Track this work under N4/P8 alongside the complete Git/UI goal.

Implementation order within N4/P8: (1) eliminate duplicate viewport/focus/heartbeat work and preserve authorized snapshot DOM, with exact served request-count evidence; (2) replace initial per-path commit-history reads with a bounded batch or repository/commit directory projection, authorize before returning cached observations, and measure native calls/bytes under cold/warm navigation; (3) replace per-subscriber polling with shared cell-local subscriptions and durable cursor replay, retaining current permission/session fences; (4) qualify both portable and Cloudflare fan-out under the workload matrix above before changing capacity claims. No stage may trade current access enforcement for a cache hit. The October4 local fixes qualify stable snapshot reads and an initial selected-head-only directory projection. The exact demo records15 first-navigation history requests (previously16; one matching row is projected). General older-history batching and shared fan-out remain required; no million-user result is claimed.

### 15.2 Capacity and monorepos

Use bounded queues, resource-aware fairness, quotas, backpressure, paginated reads, immutable-content caching after authorization, and pool-local caches. PostgreSQL jobs serve minimal deployments; add NATS JetStream for scale when benchmark evidence warrants it.

Optional affected-component CI uses a deterministic repository dependency graph, explained invalidation, stable aggregate checks, and opt-in shadow comparison before skipping jobs. Shared schema/lockfile/build config changes invalidate broadly. No LLM decides that required tests are unnecessary.

Scale Git/web/background/search/compute separately. Regional cells own organizations/repositories; cross-cell moves are fenced migrations. Do not invent globally writable branch state or promise that Helm alone makes Gitea globally distributed.

### 15.3 Cost and abuse controls

Require configured resource/concurrency limits before enabling managed execution. Reserve estimated capacity/cost before admission, enforce runtime/CPU/memory/disk limits, and reconcile observed usage. Separate estimates from provider-invoiced actuals.

At budget exhaustion stop admitting new work and apply the configured active-run cancellation policy. Provider billing delays mean an exact currency cap cannot be guaranteed; show outstanding reservations and uncertainty. Operational analytics is not the billing ledger.

Enforce organization/pool/project quotas, maximum fan-out, preview counts/TTL, artifact storage/lifecycle, and limits on expensive model requests. Detect mining/abuse in managed pools with rate/admission controls, trust policies, and investigation/audit paths. Alerts alone are insufficient.

### 15.4 Availability and objectives

| Profile | Initial recovery objective | Preconditions |
| --- | --- | --- |
| Minimal | RPO ≤24 hours; RTO ≤8 hours | Daily verified backup available, replacement host/storage available. |
| Team | RPO ≤1 hour; RTO ≤4 hours | Hourly/PITR database strategy, matching Git/object snapshots, tested restore. |
| Scale/enterprise | RPO ≤15 minutes; RTO ≤1 hour | Replication/PITR, coordinated Git/object recovery, ready replacement capacity, rehearsed cell recovery. |

These are engineering targets, not promises that an arbitrary customer's configuration achieves them. The installation reports configured protection and last successful recovery drill.

Recovery must preserve relationships among Golf's PostgreSQL state, Gitea's database, Git refs, objects, identity/SSH/signing configuration and external deployment state. Verify restored repository integrity through supported Gitea recovery procedures and reconcile Golf operation intents/outbox before permitting writes. Quarantine ambiguous mutations rather than replaying irreversible operations blindly.

The implemented operator safeguard transactionally invalidates all restored Golf sessions and pending OAuth attempts, including expired records, and writes an independent append-only recovery record without fabricating user sign-outs or altering identity/account/crypto history. Its transaction is not old-writer fencing. Restore remains quarantined until authoritative post-backup native/provider revocations, memberships/protections, deletion tombstones and outbound queues/mirrors are reconciled. Restored bytes cannot undo an external issuer's refresh rotation. The current Docker tool does not automate that reconciliation or authorize traffic reopening; a controlled fixture start is narrower evidence. See [recovery operations and remaining gates](docs/RECOVERY.md).

### 15.5 Failure behavior

| Failure | Required behavior |
| --- | --- |
| Model unavailable | Agent run pauses/fails visibly; ordinary forge remains available. |
| Runner disappears | Lease expires; safe retry policy creates a fenced attempt; ambiguous side effects require reconciliation. |
| Cloudflare unavailable | Dependent work queues/degrades; authorized fallback only; portable operations remain usable. |
| Database unavailable | No acknowledged durable mutation; read/degraded behavior is explicit. |
| Artifact finalization fails | Do not claim complete evidence; retry/failure preserves execution outcome. |
| Partial DNS/resource deploy | Record observed effects and resume/recover; no false healthy status. |
| Permission revoked | Block further sensitive operations and revoke scoped credentials. |
| Cleanup fails | Track orphan/retained resources, retries, cost, and operator action. |

Recovery tests cover PostgreSQL, Git, object storage, encryption keys, runner leases, outbox, preview resources, DNS, and partial releases. Backups count only after successful restoration and functional checks in a fresh installation.

## 16. Implementation phases and tasks

Each task records status, owner when assigned, dependencies, changed contracts, evidence links, and blockers. Mark implemented and verified separately. The plan orders dependencies; engineers may execute independent work concurrently without weakening phase gates. Phase numbers group delivery work, not strict prerequisite chains. Common forge/queue and transport contracts can be tested with controlled fixtures before real CI/providers exist; final integration gates wait for their named dependencies. Optional account-gated integrations block only the relevant capability, while every explicitly required v1 capability must pass before the complete v1 release.

Current repository bootstrap policy: create the private `mjtechguy/golf-git` repository and use local build, formatting, validation and test commands only. Do not add or enable GitHub Actions workflows, GitLab CI configuration or other repository-hosted CI automation yet. This applies to Golf's own development repository; the product's planned pipeline ingestion and execution capabilities remain in scope. Enabling repository CI is a later explicit user decision.

The initial implementation may deliver a bounded local slice that authenticates with a user's scoped Gitea token and exercises real repository operations through Golf. Label this temporary development authentication explicitly: it does not satisfy Golf local/OIDC login, sessions, organization isolation, account linking or managed credential storage. Keep tokens out of URLs/logs, avoid persistent browser storage, preserve Gitea authorization and restrict any unaudited bootstrap to local development. Minimal early HTTP handlers do not replace the planned versioned API/Connect contracts. Track the slice's actual checks separately from incomplete P1/P2 acceptance; do not present it as production-ready or completed v1.

### 16.1 Next execution sequence: portable automation first, Cloudflare adapters alongside qualified consumers

These tasks refine and order the existing P/G task families; they do not replace the phase plan or introduce a second delivery plan. They are **not completed** by this document. Preserve the current ledger's bounded manual Docker pipeline, immutable source/object bindings, profile and account lifecycle evidence. The native HMAC push-intake increment is being built; no automatic-run or autonomous-principal acceptance is inferred from its existence.

| Sequence / existing tasks | Concrete work and reasoning | Dependencies and runnable acceptance |
| --- | --- | --- |
| **N1 — Durable event intake (P2.1/P4.3/P5.1)** | First authenticate native push deliveries using exact raw-body HMAC and a per-connection secret; bind immutable forge/repository identity, bound event size and normalize only supported event fields. Record source/delivery/body hash and deduplicated durable intake before acknowledging. Keep intake separate from event-to-job dispatch. | Existing native API authorization and Golf PostgreSQL. Test invalid/missing signature, mismatched repo, body tamper, duplicate same payload, changed-payload duplicate, deleted/transferred repo, restart and ambiguous ACK. No job starts in intake-only proof. Rotation overlap/replay retention explicit. |
| **N2 — Event-to-CI admission (P4.3/P4.5/G3)** | Add one explicit qualified push-trigger subset to the compiler and durable dispatcher; record exact triggering commit/ref/config and effective policy. Treat event payload as evidence to resolve, not an executable identity or permission grant. Automatic execution needs durable authority rather than a departing human browser cookie. | N1 plus N3 before unattended release. Existing manual queue/leases/worker and supported source snapshot. Prove a real native push produces exactly one authorized run across redelivery/restart; paused workflow/inherited deny/fork/archived/mirror cases produce no assignment or secrets. Account/policy revocation fences pending and running work; no automatic replay on re-enable. |
| **N3 — Scoped automation principals (P1.3/P5.5/G2/G3)** | Implement explicit enrolled automation identities/grants bound to immutable owner/repository and allowed event/workflow/tool operations, encrypted supported provider credentials, bounded lifetime and revocation epoch. Do not extend a personal cookie forever or borrow an instance admin token. Distinguish human initiator, connection delivery actor and executing principal. | Existing identity/keyring patterns; native mapping and least-authority proof. Test mint/grant consent, foreign repo/tenant denial, source owner loss, transfer, disable/rotate/expiry, worker crash and recovery quarantine. Grant mutation/audit and result fences transactional where Golf owns state; external native limits remain explicit. |
| **N4 — Generic capabilities/provider health (P1.4/P6.1/G1/G6)** | Extend existing settings with the section 2.3.2 per-function fact/evidence model and actual provider selection only for implemented consumers. Add separate Cloudflare integration mapping/health page from the same records. Avoid dead forms for nonexistent adapters. | Existing versioned infrastructure connections; N1/N2 for event/CI consumers. Test inherited ceilings, secret masking, wrong-resource credentials, stale evidence, config change, partial health and outage. Verify operational readiness requires an actual qualified operation, not merely a saved token. |
| **N5 — Agent connections and all five harness adapters (P5.2/P5.3/P5.4/G4)** | Add ordinary full-page connection/setup flows, credential ownership, supported account/OAuth/device/API modes and isolated machine/pool selection. Implement start/events/cancel/resume/outcome per actual native harness, first one end to end, then independently Claude Code, Codex, OpenCode, Grok and pi. Provider/harness configuration is portable; Cloudflare is an optional pool/model adapter. | N3 for managed unattended authority, existing isolated runner contract. For each supported pinned harness/auth combination run a real small repository task, prove login expiry/revocation, cancellation, timeout, private isolation, restart/resume and actual terminal evidence. Unsupported combinations visible; installation or MCP discovery alone does not pass. |
| **N6 — Tasks, proposals and PR/issue comments (P5.1/P5.6/P5.7/P2.4)** | Add durable deterministic/agent task inputs, instruction provenance, tool approvals, budgets, workspace checkpoints, diffs/tests and reviewed proposal publication. Surface progress/results through Golf and authorized native PR/issue comments with correlation markers. Treat comments, repository instructions and retrieved text as untrusted input. | N3/N5; existing issue/comment intent pattern and independent current native authority. Prove duplicate-event/task suppression, private-fork isolation, current authority before comment/proposal writes, ambiguous response inspection, cancel/revoke/budget enforcement and no production credential reach. Protected merge remains blocked by P0.8, even for a successful proposal. |
| **N7 — Outbound webhooks, Slack and email (P3/P6.5/G6)** | Implement section 9.9 generic HTTP and one actual Slack adapter first, then portable email and separately qualified Teams/Discord adapters. Use a durable outbox after committed Golf observations; scoped subscriptions and authorized preferences; verified destinations, redacted payloads, HMAC signing/rotation, bounded retries/dead-letter/replay and tenant delivery diagnostics. Portable SMTP/API email adapter follows local webhook delivery; optional Cloudflare Workers/Queues transport and Email Service use the same notification contracts. Inbound email replies are a later separately authenticated operation. | Durable events and N4 connection evidence. Real controlled receiver/mailbox proof, network/destination SSRF denial, permission withdrawal before delivery, bounce/suppression, retry ordering, duplicate provider receipt, secret redaction and cleanup. Saving a login alias does not verify email or permit notification delivery. |
| **N8 — Portable protected previews (P7.1–P7.6/G5)** | Implement one actual Compose/Kubernetes deployment-runner target, immutable artifact build/promotion, separate hostname/auth boundary, scoped preview resources, expiry and cleanup. Record provisioning/protection/deploy/verify readiness separately. | N3/N6/N7 plus qualified artifacts and destination authority. Test private unauthenticated/alternate-host denial before announcing a link, commit/digest exactness, TTL/revoke, isolated data/secrets, failure at every step and orphan cleanup. Preview readiness cannot imply production approval. |
| **N9 — Cloudflare execution/email/preview adapters (P6/P7/G5)** | Qualify actual R2 first, then the selected Cloudflare worker/agent pool, Email Service, Workers/assets/Containers preview, Access and DNS resource functions from section 10.6. Use the same task, policy, source/evidence and deployment contracts; expose function-level tests/resources in the Cloudflare panel. | N4 plus the corresponding portable consumer and provider account permission/limits. Real Cloudflare end-to-end proof and denied-scope/cost/region/revoke/cleanup tests per adapter. No mock success, automatic cross-provider fallback or claim that every listed service is enabled. |
| **N10 — Production CD and release proof (P7.7–P7.10/P8/G5/G6)** | Add exact artifact/config/environment approval, independent deployment broker, controlled DNS/adoption, migration/rollback evidence and human separation of duties. Run full portable and Cloudflare demonstrations through the same generated clients and permissions. | N8/N9; P0.8 for protected merges rather than bypassing it. Test changed inputs invalidate approval, build/agent cannot obtain production credentials, cancellation/late outputs cannot deploy, provider partial failure/drift reconciliation and owned-resource cleanup. Keep native engine parity, scale/HA and whole-system recovery as their own release gates. |

**Current next-phase increment:** native receipt intake is qualified separately. [Execution policy](docs/EXECUTION_POLICY_CONTRACT.md) now has independent default-deny push ceilings at every scope; the inspection/compilation catalog admits only the documented exact-branch push subset. [Automation grants](docs/AUTOMATION_GRANTS_CONTRACT.md) adds current-admin personal PAT delegation, exact branches/workflows, bounded expiry, idempotent create, explicit revoke and full fifth-family key lifecycle. This is part of N2/N3, not automatic CI completion: schema020 now adds explicit immutable manual/push run origins and grant-bound shared worker fences. Schema021 implements bounded leased materialization, canonical signed-payload deduplication, disabled-receipt exclusion and independently verified sponsor-native push activity. The disposable push-to-RustFS/Docker proof is recorded in implementation status; this is the bounded shell subset, not provider engine parity. See [automatic push contract](docs/PUSH_AUTOMATION_CONTRACT.md). Schema021 optional local RustFS encrypted recovery and the retained stopped-writer upgrade are now qualified; schema020 alone and external/daemon-state recovery remain open. Canonical three-service schema019 encrypted recovery now qualifies grant revocation, run quarantine, preserved encrypted profiles and fifth-family rotation; the RustFS/worker topology and any future automatic-origin schema still need their own recovery proof. Dedicated automation accounts, OAuth refresh, editable credential versions and the five actual agent adapters are still separate work.

**Execution discipline:** N1 can ship as a receive-and-inspect capability. N2 must not be operational until N3 provides qualified unattended authority; implement N2/N3 in coordinated disjoint files with agreed contracts. N4 can begin using existing consumers and expand as they qualify. N5 must not block deterministic CI/email/previews; N7 can progress with deterministic events before agents. Cloudflare adapter qualification can proceed alongside the corresponding portable consumer, but cannot redefine its authorization or promise undocumented harness authentication.

For each task record source revision, exact runtime/provider/harness versions, supported operations/auth combinations, disposable fixture commands, observed results and cleanup. Add generated API/CLI/MCP/ACP operations only with the same scoped domain authorization and private-data handling; the current read-only delegation/MCP allowlists remain unchanged until deliberately expanded and tested. Do not publish a writable MCP/ACP tool merely because the browser button exists. Run required local checks and preserve the no-repository-CI restriction.

The immediate sequence is [section 16.1](#161-next-execution-sequence-portable-automation-first-cloudflare-adapters-alongside-qualified-consumers); phase tasks below remain the complete long-term scope.

### Phase 0 — Baseline and integration proofs

Depends on: none. Outcome: verified feasibility boundaries and a concrete implementation baseline.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P0.1 | Establish repository layout, local build targets, task ledger, source register, and version inventory | Minimal local build/check commands run; no repository CI workflow added or enabled; archived conversation remains unchanged. |
| P0.2 | Create full guide requirement register and required ADRs | Every applicable prescription has a task/check or explicit ADR. |
| P0.3 | Define forge/job/runner/agent/deployment contracts and fixture schemas | Generated API types and minimal contract tests. |
| P0.4 | Create Actions/GitLab corpus and exact supported-feature catalog | Positive and negative fixtures for each initial contract entry. |
| P0.5 | Prove Actions runtime and pinned GitLab coordinator/executor ADR | Real job, service, log/artifact, cancellation, and token smoke checks. |
| P0.6 | Qualify Cloudflare Sandbox/Containers/CI SDK and limits | Controlled live Linux build with resources/network/cleanup evidence. |
| P0.7 | Prove five harness interfaces and supported auth/provider paths | Real structured execution/cancel check per harness; untested combinations blocked. |
| P0.8 | Record shared Gitea v1 decision; qualify API/policy boundary, licensing and ownership | Pinned Gitea operation/identity inventory, protected-write and conditional-merge proof, dependency notices and ADRs; required unsupported paths block completion. |
| P0.9 | Qualify MCP/ACP versions, official Cloudflare tooling, and eligible ChatGPT-plan integration | Real discovery/auth/approval/cancel/refresh checks; unavailable eligibility remains explicit. |
| P0.10 | Qualify Email Service, Event Subscriptions, Issues automations and latest Artifacts/Containers contracts | Controlled send/inbound/delivery-event/error-event/fork/build checks; live access and limits recorded. |

P0.8 remains unresolved. The [protected merge implementation design](docs/PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md) gives a proposed implementation sequence: classify and fully mediate native ingress; durably reserve conflicting source/base/review/policy/identity operations; prepare and publish the exact tested candidate through supported native Git; fence already accepted uncertain writes before replacement; then qualify merge/squash/rebase/fast-forward bookkeeping, UI and scale. Its native fault matrix includes private forks, forged status success, source/base movement, revoked/expired authority and interrupted publication. An unchanged native merge route or green status alone does not meet this gate. ADR0004 remains proposed; provider-side effective-write/expiry enforcement may still be required if complete mediation cannot satisfy the promised semantics. Latest-schema recovery remains a separate unresolved release gate:033 was already unqualified, and human review journal034 requires fresh coordinated recovery proof.

Gate: proofs establish usable supported paths. A failed required integration blocks its release task; it is not replaced by a simulated success.

### Phase 1 — Portable core, identity, and interface foundation

Depends on: P0 contracts and ADRs.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P1.1 | Go/Connect/chi core, PostgreSQL/sqlc/goose, generated clients | Real DB tests, migration locking, typed API smoke check. |
| P1.2 | Bootstrap/local/OIDC identity, org/team roles, refresh/revocation | Account linking, tenant access, CSRF/origin, session tests. |
| P1.3 | Credential references/encryption, audit, outbox, jobs | Key rotation and duplicate delivery/restart checks. |
| P1.4 | TanStack shell/navigation/forms/tables, full settings pages and theme tokens; G1/G2 in6.4 | Black/charcoal and light screenshots, persisted theme, keyboard/mobile/deep links and honest enforceable-control inventory. |
| P1.5 | Compose/Helm, pinned Gitea profile, configuration validation, capability/health | Fresh install/restart on both; separate Golf/Gitea DB roles, one canonical writer and external dependencies correctly gated. |
| P1.6 | Object storage and coordinated Golf/Gitea backup/export/restore primitives | Fresh-instance restoration of both DBs, repositories, LFS/attachments/configuration and encrypted key material; integrity checks. |
| P1.7 | Structured logs/OTel/metrics and optional dev stack | Correlation across API/DB/job; dashboard smoke check. |
| P1.8 | Human/service/Git credentials, role matrix, MFA/recovery and CLI login | Scoped tokens/SSH, rotation/revocation, owner recovery, local/OIDC paths and noninteractive login checks. |

P1.6 progress is deliberately bounded: the [Docker recovery tool and operator safeguard](docs/RECOVERY.md) pass native encrypted backup/fresh restore, stopped-target quarantine, restored-credential invalidation, preserved repository-creation operations/events with own lookup and same-key replay, private signed Git/LFS/attachment/protection/identity checks, new writes and simultaneous whole-stack restart. The small fixture explicitly skips its minimum-payload-cap negative case; it is not an 8 GiB, load or RPO/RTO qualification. Wider object-storage, Kubernetes/external topology, all-repository inventory, provider revocation/tombstone and outbound-work reconciliation, and production recovery gates remain open. Backup age encryption is separate from the [application credential keyring](docs/CREDENTIAL_KEYRING.md).

P1.7 progress is scoped to the existing shared core: [injected zerolog/OTLP/Prometheus runtime](docs/OBSERVABILITY.md), current API→native Gitea/PostgreSQL traces, separate authenticated metrics and an optional Jaeger/Prometheus/Grafana development overlay. [ADR-0006](docs/decisions/0006-private-observability-runtime.md) explicitly records the guide deviation from Tempo/Loki and leaves centralized log retention/search open. Telemetry omits credentials, source text, repository/user identity and SQL statements/parameters. Jobs/runners do not exist yet, so API→job propagation, production/load/alerting/retention and live Kubernetes scraping/export remain required future qualification; this does not close P1.7. Runnable evidence belongs in the implementation ledger.

Gate: persistent authenticated portable installation with safe tenant boundaries and verified restoration.

### Phase 2 — Gitea-backed forge and origin connections

Depends on: Phase 1.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P2.1 | Backend ID/identity mappings and effective authorization | Access denied by backend remains denied in Golf. |
| P2.2 | Repository/issues/boards/PR/review/release UI and API | Common forge contract suite; board/execution states remain distinct. |
| P2.3 | Git/SSH/LFS ingress, protection, normalized events | Direct/API/editor/background write protection checks. |
| P2.4 | GitHub App and GitLab OAuth/service connections | Discovery, webhook, refresh/revoke, self-hosted endpoint tests. |
| P2.5 | Connected-origin checks/comments/PR/MR submissions | Real origin mutation under scoped permissions; revoked/stale paths fail. |
| P2.6 | Migration auditor and staged direct import/export | History/LFS/metadata report, interrupted import resume, identity/fidelity mapping. |
| P2.7 | Recover event gaps and preserve effective imported policy | Failed delivery recovery, reordered events, permission revocation, ruleset/CODEOWNERS fidelity and blocked weakening. |
| P2.8 | Ship notification preferences, email and public webhook contracts | Authorized templates, MIME/thread intake, signatures/SSRF guards, retry/dead letters and portable mail catcher. |
| P2.9 | Qualify forks, review lifecycle, rename/transfer/archive and LFS/signatures | Common fixtures for private forks, cross-repo PRs, lock ownership, signature state and resource mappings. |

P2.2 progress includes the [durable personal repository-create path](docs/REPOSITORY_CREATION_CONTRACT.md), its generated lookup API, read-only CLI and real UI. Native rejected/unknown outcomes, response loss, one-dispatch replay, current-access denial and restored history are qualified for this path only. It does not deliver remaining issue/review/release writes or protected publication.

Gate: useful Golf collaboration and origin connection without requiring migration; direct import has a verified report/cutover path. P2.8 delivers portable email/event behavior; its Cloudflare path closes with P6.9. Results APIs are tested here; real pipeline/agent callbacks close in Phases 4–5.

### Phase 3 — Gitea integration, protection, and recovery hardening

Depends on: Phase 1, P0.8 supported-operation proof and Phase 2 forge contracts. Existing P3 task IDs are retained for traceability; they now harden the selected shared foundation rather than building a second forge.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P3.1 | Harden Gitea Git ingress, supported maintenance and Golf operation recovery | Concurrent writes, object/ref integrity and interrupted API/merge recovery; no direct canonical ref/database mutations by Golf. |
| P3.2 | Reconcile Gitea collaboration projections and effective authorization | Restart/event-gap/permission-revocation suite; Gitea remains sole collaboration authority. |
| P3.3 | Enforce protection, check/approval invalidation and qualified conditional merges | Stale base/evidence and all direct/API/editor/background write-path rejection scenarios. |
| P3.4 | Harden Gitea LFS/attachments/boards and staged migration | Large objects/attachments, interrupted import/export and coordinated restoration checks. |
| P3.5 | Fence Gitea instance relocation and connected-origin cutover | One canonical writer throughout relocation; restored identities/relationships, URLs and policy verified. |
| P3.6 | Integrate serial merge queue and supported Git lifecycle controls | Exact candidate checks through qualified Gitea paths; moved-base invalidation; quarantine, object formats, maintenance/retention and safe task checkout checks. |
| P3.7 | Qualify complete repository/identity/LFS contract in both infrastructure profiles | P2.9 corpus on portable and hybrid CF origins; missing LFS, unauthorized object access and credential/signature negatives. |

Gate: the shared Gitea integration passes the forge and recovery contract on portable and hybrid Cloudflare origin profiles, with a single canonical writer and no unenforced protected write path. Merge-queue tests use controlled checks initially; real CI integration closes after P4.9. Cloudflare provider-specific operations close in Phase 6 and the full release matrix in P8.1. A second forge implementation is outside this gate.

### Phase 4 — CI frontends and customer execution

Depends on: Phase 1; engine proofs from Phase 0; forge event integration.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P4.1 | Actions preflight/compiler and expression/action catalog | Corpus including coercion/context/unsupported-security cases. |
| P4.2 | GitLab preflight/compiler and config/rules/variable catalog | Include/extends/rules/stage/failure precedence fixtures. |
| P4.3 | Scheduler, quotas, leases, attempts, cancellation and fairness | Duplicate/stale/lost runner and burst/saturation checks. |
| P4.4 | Execution engines and scoped coordinator transports | Pinned engine lifecycle, command-file/artifact/cache checks. |
| P4.5 | Single-host and Kubernetes Linux runner pools | Fresh isolated execution, autoscaling/draindown, private-network placement. |
| P4.6 | Permissions/secrets, environment approval, OIDC, fork trust | Fail-closed security corpus and truthful token claims. |
| P4.7 | Streaming logs, artifact integrity, cache trust and checks | Reconnect/upload interruption; tenant/trust poisoning checks. |
| P4.8 | Publish compatibility preflight/UI/CLI and runner image inventory | Supported source runs unchanged; blocked source explains remediation. |
| P4.9 | Qualify queue-candidate CI, event causality and cross-project job tokens | merge_group/group SHA fixtures, GitLab candidate blockers, legitimate agent PR CI, recursion bounds and denied endpoint access. |
| P4.10 | Trusted required-check producers and connected execution ownership | Forged check names rejected; workflow edits cannot remove mandatory evaluation; no accidental duplicate executor. |

Gate: supported Actions/GitLab pipelines run on customer Linux infrastructure with security semantics preserved.

Implementation order and explicit conformance cases are detailed in the [Actions compatibility packet](docs/ACTIONS_COMPATIBILITY_IMPLEMENTATION.md). Manual dispatch and configured push are independent first-class paths; test manual-only, push-only, both and neither, using an actual Git push as well as explicit dispatch. Import never enables execution automatically. AC-0 qualifies a pinned maintained execution engine under Golf admission rather than extending the shell-only compiler into a general interpreter; ignored engine fields must be enforced or rejected before execution. AC-1–AC-9 cover event policy, durable job graphs, exact checkout/actions, controls/data flow, tokens/secrets/artifact/cache services, reuse/events, portable scaling, Cloudflare/hybrid execution and release/upgrade gates. The current shell catalog and actual run/log proofs do not establish full Actions compatibility, and native automatic scheduling must not bypass Golf policy or introduce a second execution owner.

Actions is the common execution workspace: ordinary workflows, standalone coding agents and PR-review automation share a chronological inventory and full-page drilldown, with clear kind badges and independently authorized outputs. Agents can also be real steps inside a workflow; those parent/job/step relationships must be persisted by the executor, not inferred from matching commits. The [run metadata and progress contract](docs/ACTIONS_RUN_METADATA_AND_PROGRESS.md) specifies AM-1–AM-6: typed mixed paging/navigation, durable admission/actor/source/attempt metadata, resumable trusted agent/tool/log events, job/matrix progress, embedded-agent policy and outputs, retention/scale/recovery. Use the GitHub Actions work hierarchy with Golf styling and real recorded metadata; unknown actor/usage/cost/progress is not fabricated. Private initiating-user task visibility remains intact when runs enter the common Actions inventory.


### Phase 5 — Agent automations and inference

Depends on: Phase 4 isolation/evidence and origin/forge operations.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P5.1 | Versioned triggers/schedules/filters/dedupe/recursion handling | Duplicate/missed schedule/self-generated event tests. |
| P5.2 | Tasks/workspaces/changes/evidence and parallel integration | Exact base/head evidence and combined-change retest. |
| P5.3 | Five harness adapters and personal/managed authentication | Real start/events/cancel/outcome per supported combination. |
| P5.4 | Workers AI/direct APIs/local inference and optional Gateway | Streaming/tools/errors; incompatible combinations rejected. |
| P5.5 | CLI/API/MCP and supported ACP sessions | Same permission/audit path, typed errors, noninteractive checks. |
| P5.6 | PR/MR completion, policy-authorized merge/release/deploy requests | Default cannot directly merge; policy override requires checks. |
| P5.7 | Budgets/revocation/kill switch and evaluation templates | Active revocation/cancellation and regression examples. |
| P5.8 | Implement protocol approvals and scoped session recovery | MCP audience/discovery negative checks; ACP deny/cancel/mode behavior; app-server resume after renewal with fresh policy. |
| P5.9 | Deterministic task path, instruction provenance and human handoff | AI-disabled tasks pass; untrusted plugin/MCP changes blocked; resume/takeover preserves policy and evidence. |

Gate: triggered and scheduled agents perform real repository work and submit tested proposals; all five harnesses have verified supported paths.

### Phase 6 — Cloudflare execution and first-class services

Depends on: core execution/credential contracts and provider proofs.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P6.1 | Account connection, scoped permission verification, resource inventory | Missing scope/plan/credential paths exposed before work. |
| P6.2 | Workers edge, R2, eligible Artifacts workspaces | Private storage/repo access; large-history fallback; restore/export. |
| P6.3 | Queues/Workflows/DO adapters and reconciliation | Duplicate events and interrupted operations without dual authority. |
| P6.4 | Scalable Cloudflare CI/agent pools, quota/budget/fallback | Live corpus subset, saturation/cancel/cleanup, authorized fallback. |
| P6.5 | Workers Builds and registry execution ownership | No double deployment; approved immutable outputs/digests recorded. |
| P6.6 | Browser Run, Access machine auth, logs/tail/export | Protected test/screenshot and commit-linked runtime diagnosis. |
| P6.7 | Optional VPC/Tunnel/Secrets/Hyperdrive and protection presets | Private connectivity and protocol-compatible access/limits. |
| P6.8 | Integrate scoped official MCP, safe Sandbox snapshots and explicit Gateway billing | No broker bypass or cross-tenant restore; BYOK missing-key failure; approved billing and credential separation. |
| P6.9 | Implement CF email/events, task-repo handoffs and production-issue intake | Scoped sending/routing, protected Builds preview, dynamic approved container sizing and incident-to-task evidence. |

Gate: Cloudflare runs real qualified pipelines/agents; no unsupported runtime capability is silently assumed.

### Phase 7 — Environment reconciliation, protected previews, and production CD

Depends on: verified CI, deployment credentials, and target adapters.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P7.1 | Project/environment model, config snapshots, provisioning diffs | Repo configuration cannot expand organization authority. |
| P7.2 | Adopt existing Workers/Containers/resources and assign ownership | Read-before-write inventory; unrelated resources unchanged. |
| P7.3 | Resource reconciliation/locks/drift/cleanup | Interrupted create/update/delete and stale-operation fencing. |
| P7.4 | Access-protected previews, domain separation, machine test access | Every route/hostname checked; no Golf session exposure. |
| P7.5 | DNS/domains/TLS planning, autoconfig, conflict/recovery | Exact diff, ownership, readiness, propagation and rollback checks. |
| P7.6 | R2/D1/KV/Queues/DO/AI app bindings and preview fixtures | Preview write cannot reach production; data cleanup verified. |
| P7.7 | Workers/assets/Containers/Compose/Kubernetes deployments | Real target rollout and exact immutable output linkage. |
| P7.8 | Approval, provenance verification, promotion, canary and health | Stale/tampered output rejection; Worker/container partial failure. |
| P7.9 | Rollback, D1 recovery, backups, PR links, TTL and orphan reporting | Application versus data recovery distinguished; cleanup failures visible. |
| P7.10 | Portable preview auth and bounded host/Kubernetes deployment | Local-account/OIDC/machine access; bypass ports denied; privileged Compose/manifests rejected; target rollback verified. |

Gate: new/adopted applications get protected temporary links and authorized production deployment with DNS, bindings, runtime logs, verified health, and recovery.

### Phase 8 — v1 hardening, migration, and release

Depends on: Phases 1–7 shared contract gates.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P8.1 | Full shared-forge/track/installation acceptance matrix | Gitea-backed Golf on portable and hybrid CF tracks, with Compose/Kubernetes origin installations where applicable. |
| P8.2 | Rehearse GitHub/GitLab migration and connected-origin use | No forced migration, fidelity reports, cutover/write fencing. |
| P8.3 | Benchmarks, saturation/soak, provider fault injection | Published reproducible datasets/resources/results and blockers. |
| P8.4 | Tenant/security/supply-chain and emergency disable checks | Cross-tenant/credential/provenance/revocation negative tests. |
| P8.5 | Backup/restore, upgrade, interrupted operations and recovery | Measured RPO/RTO targets and functional fresh-instance drills. |
| P8.6 | Signed images/SBOM/provenance/offline bundles | Admission/verification succeeds offline; tampered bundle rejected. |
| P8.7 | Documentation, compatibility catalogs and runbooks | Setup/adoption/upgrade/revoke/restore workflows reproducible. |
| P8.8 | End-to-end demonstrations for all agents and targets | Real evidence, no placeholders or unavailable checks marked passing. |
| P8.9 | Exercise research-derived boundary regressions | Git/worktree/GC, queue/policy, event recovery, protocol auth/session and Gateway/Sandbox negative scenarios pass. |
| P8.10 | Rehearse and record lifecycle showcase plus portable proof | Real parallel-agent comparison, exact tested deployment, incident repair, cleanup/cost ledger and Compose/Kubernetes evidence. |
| P8.11 | Close completeness matrix, public contracts and data lifecycle | All v1 requirements mapped and verified; deletion/export/restore revocation, safe content rendering and AI-disabled gates. |

Gate: Golf core-forge-plus-CI/CD v1 is production-reviewable with explicit limitations and operational evidence.

### Phase 9 — Enterprise and wider product coverage

Depends on: verified core and measured demand/operational requirements.

| ID | Task | Acceptance evidence |
| --- | --- | --- |
| P9.1 | Regional cells/HA, enterprise identity lifecycle and dedicated pools | Failover/relocation/federation/revocation drills. |
| P9.2 | Retention/governance/legal hold/evidence and government distribution | Capability-specific evidence and supported crypto/environment inventory. |
| P9.3 | Golf-managed hosting with Workers for Platforms/Cloudflare for SaaS | Tenant limits/outbound controls, domains/certs, metering/abuse controls. |
| P9.4 | Advanced Actions/GitLab semantics and provider APIs | Versioned conformance corpus expansion. |
| P9.5 | Discussions/wikis/packages/security surfaces/interactive workspaces | Supported Gitea/Golf feature contracts and migration fidelity; native-forge work requires a separate approved ADR and plan. |
| P9.6 | Authorized semantic retrieval and large-scale analytics | Revocation/deletion isolation, derived-not-authoritative usage. |
| P9.7 | macOS/Windows and additional provider execution | Platform/image/runtime corpora and scheduling qualification. |

Gate: each expansion is independently verified; no unsupported enterprise/compliance marketing based on settings alone.

## 17. Verification and release gates

### 17.1 Test approach

Use the guide's Go table/integration/browser tooling, real PostgreSQL, and real Git repositories. Keep tests meaningful and behavior-based. Provider contract tests use controlled live resources/accounts; missing credentials mark them unavailable, not passing. Local emulators prove local behavior, not provider production parity.

Run checks appropriate to changed contracts. Use race tests for concurrent Go paths, property/corpus tests for parsers/expressions, and fault injection for leases/reconciliation. Preserve evidence with version/config/commit references.

### 17.2 Required scenarios

| Area | Positive and negative coverage |
| --- | --- |
| Forge | Clone/fetch/push; all protected write paths; unauthorized access; concurrent/stale merge; refs/object integrity; imported identities; export. |
| Connections | GitHub/GitLab discovery/webhooks, refresh/revoke, connected checks/PRs/MRs, self-hosted instance, rate limits/SSRF boundaries. |
| Import | Large history/LFS/submodules/forks; metadata mapping/fidelity; missing credentials/users; interrupted resume/cutover. |
| UI | Both themes, black/charcoal tokens, persisted/system mode, keyboard/accessibility/mobile, long diffs/logs, error/blocker states. |
| Actions | Every published expression/context/action version; dependencies/matrix/control/outputs/services/artifacts; unknown semantics blocked. |
| GitLab | Include/extends/rules/variables/stages/needs/parallel/failure/manual gates; unsupported components/child pipelines blocked. |
| CI security | Fork secret isolation, caches, token scope, truthful OIDC, required approvals, privileged/network mismatch. |
| Runners | Queue fairness, scale up/down, saturation, lease loss, stale completion, cancellation, quotas, cleanup. |
| Agents | All five real harnesses; schedule/events; supported account/API paths; budget/revocation/kill switch; recursive events; combined evidence. |
| Inference | Workers AI binding/REST, direct/local providers, streaming/tool/errors, model compatibility and fallback consent. |
| Previews | Access on all URLs, machine auth, cookie/origin isolation, safe databases/bindings, exact links, expiry and cleanup. |
| CD/DNS | New/adopted projects, external ownership, conflict/drift, TLS readiness, digest/provenance, Worker/container rollout failure, recovery. |
| Portability | No Cloudflare dependency, offline first boot, local assets/models/mirrors, no implicit external requests. |
| AI optional | Disable every model provider and harness; Git/import/review, script-triggered automation, CI, email/webhooks, protected previews, production deployment and recovery still work on both tracks. UI/API clearly report optional AI unavailable without blocking core actions. |
| Recovery | Coordinated DB/Git/object restore, outbox/operation replay, ambiguous effect quarantine, upgrades, key rotation, provider account loss. |
| Assurance | Required crypto inventory/module evidence, federation assurance, audit/retention export, profile-specific environment checks. |

Research-derived release checks additionally cover: fully rejected pushes leaving no newly accepted refs or quarantined objects (partial and atomic multi-ref pushes tested separately); safe maintenance while active task refs retain required commits; credential-free independent hostile checkouts; unsupported object formats blocked; current-base queue candidates and moved-base cancellation; CODEOWNERS/ruleset bypass fidelity; webhook gap recovery and stale-event handling; cross-project token denial; legitimate agent PR checks without automation loops; MCP wrong-audience/token-passthrough/SSRF rejection; ACP denied approval and resumed-session revocation; cross-tenant Sandbox name/snapshot rejection; and Gateway missing-key requests causing no unauthorized fallback charges.

Email/webhook release checks cover: protected summaries after membership removal; spoofed sender and stale reply-token rejection; unsafe MIME/attachment handling; duplicate/auto-reply loops; sending event ordering and bounce suppression; DNS mail conflicts; outbound signature verification/key rotation; SSRF/rebinding/redirect attempts; authorized redelivery; provider outages/dead letters; production issue bursts coalesced into bounded repair tasks; and no privileged action authorized by inbound text alone.

### 17.3 End-to-end demonstrations

1. Connect GitHub and GitLab repositories without migration; discover projects, receive an event, run supported checks, and return a PR/MR proposal.
2. Import repositories into Gitea-backed Golf on each infrastructure track with a preflight/fidelity report and verified history/LFS/collaboration data.
3. Run supported GitHub Actions and GitLab pipelines unchanged on customer Linux and qualified Cloudflare pools; show an unsupported pipeline blocked before execution.
4. Run each required agent from an event or schedule, collect tests/evidence, and produce a PR/MR under default authority.
5. Use Workers AI from a supported harness or direct Golf AI task; show unsupported combinations unavailable rather than failing mysteriously.
6. Create a protected exact-commit preview with safe bindings/data, machine tests, DNS/TLS readiness, and PR link.
7. Adopt an existing Cloudflare project and deploy a verified release without overwriting unrelated resources.
8. Deploy a new Worker and a container project with R2/other declared bindings, approval, runtime logs, and target-specific health.
9. Demonstrate partial deployment/DNS failure, safe retry, rollback/recovery, preview cleanup, and emergency stop.
10. Run Golf in portable Compose and Kubernetes without Cloudflare; restore/export and boot the disconnected bundle.

### 17.4 Release evidence

Release artifacts include pinned version inventory, dependency notices, guide compliance/ADR register, compatibility catalogs, security scan results, benchmark definitions/results, restoration/upgrade evidence, known limitations, and operational runbooks.

A release cannot claim both infrastructure tracks verified from one profile's result, present the hybrid Cloudflare track as an all-Cloudflare forge, claim a native forge that has not been implemented, call Linux compatibility universal, claim provider integration from a mock, or claim government/FIPS compliance without appropriate distribution evidence.

## 18. Risks, defaults, and deferred work

### 18.1 Highest risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Gitea API/policy limits may block requested behavior | Early supported-operation and all-write-path proofs; fail closed, preserve one authority, resolve blockers explicitly; native forge is conditional later scope. |
| Two pipeline ecosystems have server-side semantics | Exact bounded contract, early engine/coordinator proof, upstream-derived corpus, fail closed. |
| Cloudflare changes quickly | Date-stamped capability qualification, pinned adapters, live checks and explicit readiness. |
| Managed resource/CD partial failures | Desired/observed records, ownership, fencing/idempotency, reconciliation and fault tests. |
| Agent credentials/subscription support differs | Per-combination catalog, isolated native login, documented APIs, no token repurposing. |
| Untrusted previews appear safe behind login | Separate origins/cookies, isolated resources/data, protected alternate URLs, machine auth. |
| Backend/projection drift | Single authority, read projections, reconciliation and effective permission checks. |
| Cost overruns/provider quota | Admission reservations, hard resource/runtime caps, queue limits, usage reconciliation and uncertainty reporting. |
| Unsupported government claims | Capability-specific distributions/evidence; no global flag substitutes for assurance. |

### 18.2 Explicit defaults

- System UI theme initially; explicit dark mode uses black/dark charcoal.
- Core forge plus CI/CD v1; one Gitea-backed forge shared by both infrastructure tracks.
- Cloudflare track is hybrid; canonical core/Gitea require supported persistent origin infrastructure.
- Current private repository bootstrap uses local checks only; repository CI workflows remain disabled/uncreated until explicitly requested.
- Linux only; unsupported OS jobs blocked.
- Customer-owned Cloudflare accounts first.
- Connected-origin mode does not change repository ownership; migration is explicit.
- Agent completion creates a PR/MR; policy overrides authorize further steps.
- UTC schedules, skipped missed occurrences, bounded optional catch-up.
- Private previews, separate writable resources, synthetic fixture data, seven-day TTL.
- Drift reports and pauses conflicting deploys; approved owned preview resources can reconcile automatically.
- PostgreSQL plus jobs for minimal profiles; scalable queues/search are optional.
- Local/OIDC identity and audit/export in OSS; premium governance independent of Cloudflare track.
- No unconfigured external service calls, silent model fallback, public preview bypass, or unverified completion claims.

### 18.3 Deliberate deferrals

Defer a second Golf-native forge, universal GitHub/GitLab API parity, arbitrary upstream runner binaries, canonical Artifacts Git, global multi-writer repositories, custom Kubernetes operator, universal bidirectional forge sync, TanStack DB, and media products without a specific application need. A native forge requires a demonstrated Gitea blocker or explicit all-Cloudflare hosting requirement and a separate ownership/migration/acceptance plan.

These deferrals reduce implementation burden without removing requested capabilities. Add them when a migration blocker or measured operational requirement makes them necessary, and give them a separate contract/test gate.

### 18.4 Implementation evidence still required

No implementation claimed in the archived conversation is assumed verified. Current scoped results are recorded in the implementation ledger; they do not complete the whole plan. Engine interoperability, provider authentication eligibility, exact live limits, and distribution assurance are proof tasks, not established facts. They remain visible blockers until the assigned phase produces evidence.

## 19. Primary references

Links are implementation sources, not proof that an integration has already been built. Recheck availability, limits, versions, plan requirements, and licensing at the relevant task.

### Guide and foundations

- [Technology Selection Guide](https://technology-selection-guide.aws.ablabs.io/)
- [Full guide for agents](https://technology-selection-guide.aws.ablabs.io/llms-full.txt)
- [Guide source](https://github.com/alphabravocompany/technology-selection-guide)
- [Gitea documentation](https://docs.gitea.com/)
- [Gitea protected branches](https://docs.gitea.com/1.27/usage/access-control/protected-branches/)
- [Actions runner source](https://github.com/actions/runner)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitLab CI syntax](https://docs.gitlab.com/ci/yaml/)
- [GitLab executors](https://docs.gitlab.com/runner/executors/)
- [GitLab custom executor](https://docs.gitlab.com/runner/executors/custom/)
- [GitLab autoscaling](https://docs.gitlab.com/runner/runner_autoscale/)
- [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [GitLab OAuth](https://docs.gitlab.com/integration/oauth_provider/)

### Agents

- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [Grok Build](https://docs.x.ai/build/overview)
- [Grok CLI/authentication](https://docs.x.ai/build/cli/reference)
- [xAI model API](https://docs.x.ai/overview)
- [Pi source/package interfaces](https://github.com/badlogic/pi-mono)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Official Go MCP SDK v1.8.0](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0)

### Cloudflare execution and AI

- [Artifacts](https://developers.cloudflare.com/artifacts/)
- [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- [Artifacts build integration / CI SDK](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/)
- [Sandboxes](https://developers.cloudflare.com/sandbox/)
- [Containers](https://developers.cloudflare.com/containers/)
- [Containers limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Container deployment](https://developers.cloudflare.com/containers/guides/deploy/)
- [Container image management](https://developers.cloudflare.com/containers/guides/image-management/)
- [Workers Builds / CI/CD](https://developers.cloudflare.com/workers/ci-cd/)
- [Queues](https://developers.cloudflare.com/queues/)
- [Workflows](https://developers.cloudflare.com/workflows/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [Vectorize](https://developers.cloudflare.com/vectorize/)
- [AI Search](https://developers.cloudflare.com/ai-search/)
- [Browser Run](https://developers.cloudflare.com/browser-run/)

### Cloudflare delivery, data, and operations

- [Workers Previews](https://developers.cloudflare.com/workers/previews/)
- [Preview resource isolation](https://developers.cloudflare.com/workers/previews/resources/)
- [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Coding-agent Access authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/)
- [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Secrets Store](https://developers.cloudflare.com/secrets-store/)
- [R2](https://developers.cloudflare.com/r2/)
- [R2 retention locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Gradual Worker deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Cloudflare for SaaS hostname readiness](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [API protection](https://developers.cloudflare.com/use-cases/apis/protect-apis/)
- [Managed data pipelines](https://developers.cloudflare.com/pipelines/)
- [Go FIPS guidance](https://go.dev/doc/security/fips140)


## 20. Research review and incorporated decisions

Reviewed against primary documentation on 2026-10-01. Findings below are design decisions inferred from documented capabilities and constraints, not evidence of implemented interoperability. The initial technology-guide adoption register remains in section 3; this review strengthens Git, forge, execution, and agent boundaries rather than replacing that stack.

| Finding and reason | Implementation decision | Tasks / stage |
| --- | --- | --- |
| Worktrees share repository state; task snapshots can retain secrets. | Independent clones for hostile boundaries; authenticated snapshot ownership, fresh credentials on restore. | P3.6, P6.8; v1. |
| Git writes and object lifecycle need more than storage capacity. | Quarantine, conditional ref transactions, bounded maintenance, active-ref retention, object-format preflight and safe submodules. | P3.6; v1. |
| PR head checks do not prove a queued merge candidate passed. | Serial Golf queue through qualified Gitea operations; GitHub merge_group input and exact GitLab candidate qualification; speculative trains deferred. | P3.6, P4.9; v1. |
| GitHub/GitLab protection and CODEOWNERS semantics differ. | Format-specific effective-policy migration; blocked weakening and unmapped required approvers. | P2.7; v1. |
| Webhook delivery alone cannot guarantee synchronization. | Durable intake, scoped hydration/redelivery and periodic permission/state reconciliation. | P2.7; v1. |
| Agent-created events need both CI coverage and recursion limits. | Actor/token-aware causality, bounded automation generations, separate required PR/check execution. | P4.9; v1. |
| Job tokens have cross-project and endpoint restrictions. | Allowlist plus effective actor/endpoint permissions; no generalized credential substitution. | P4.9; v1. |
| MCP authorization and ACP session consent are distinct protocols. | Pinned discovery/audience/scope contracts; approval, cancellation and resume policy checks. | P0.9, P5.8; v1. |
| Supported subscription integration is provider-specific. | Qualify documented Sign in with ChatGPT preview alongside native account/API paths; eligibility and restrictions explicit. | P0.9, P5.8; available combinations only. |
| Cloudflare already supplies broad MCP and agent skills. | Reuse scoped official tools; keep Golf production broker authoritative. | P0.9, P6.8; v1 optional. |
| Gateway BYOK can otherwise fall through to a different billing path. | Verified BYOK-only default; owner-approved Unified Billing, retention and optional DLP/guardrails. | P6.8; v1 optional. |

Additional sources for this review are linked beside each requirement in sections 2.6, 4.5, 5.5, 7.5, 8.5, 9.4/9.6 and 10.5. Recheck each live provider contract during its proof task; documentation availability is not account eligibility or a passing test.

Further expansion is intentionally conditional: speculative merge trains when serial queues bottleneck; additional Git object/ref formats when real imports require them; registry/package/security compatibility when concrete workflows need it; and deeper Cloudflare products when an application or measured operational requirement justifies activation. Preserve the two deployment tracks and shared policy core throughout.


## 21. Latest Cloudflare announcements and adoption register

Research window: September 30–October 1, 2026, checked on October 1. Announcements identify opportunities; implementation must verify current API documentation, availability, pricing, account eligibility and security semantics. This register retains only announcements with a concrete Git/developer-tool use. Entries marked conditional are candidates for that specific need, not commitments to add a dependency. General agent-workspace products and standalone model-training experiments are excluded from implementation scope.

| Announcement / primary source | Golf adoption and boundary | Stage |
| --- | --- | --- |
| [Next Git platform / Artifacts](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) — Oct 1 | Open-beta task repositories with bindings, fork/token/event handoffs, jurisdiction choice and Builds integration. Blog and developer changelog differ on Oct 14/15 billing start; verify current pricing/account terms before use. Canonical storage remains gated. | P0.10 / P6.9; demo priority. |
| [Faster agent sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/) — Sep 30 | Qualify runtime image/instance selection from approved catalog, pin active attempts and benchmark cold/warm starts. Snapshot public beta has the ownership/secret controls in 8.5. Never transfer a provider speedup claim to Golf without measurement. | P0.6 / P6.9; demo priority. |
| [Production issue detection](https://blog.cloudflare.com/real-time-issue-detection/) — Sep 30 | Generic authenticated automation webhook → deduplicated Golf incident → scoped agent investigation → tested proposal; tie diagnostic context to deployed version, redact it. | P0.10 / P6.9; demo priority. |
| [Auto Router](https://blog.cloudflare.com/auto-router/) — Sep 30 | Optional evaluated routing for compatible harness/API paths. Explicit allowed model/provider set, data policy and budget; default pinned models. Responses/WebSockets support must be qualified, not inferred from another API. | Optional proof after P5; no release dependency. |
| [User Insights](https://blog.cloudflare.com/ai-model-overuse-user-insights/) — Sep 30 | Pseudonymous task/run/user labels for opted-in usage diagnostics; reconcile against Golf reservation/usage ledger, avoid uploading unnecessary prompts or identity. | P6 extension / demo where enabled. |
| [Registrar and cf CLI](https://blog.cloudflare.com/simplifying-domains/) — Sep 30 | Search and priced purchase/transfer plan; explicit owner approval before spending or changing registration. DNS setup for existing domains remains the default. | Optional P7 application setup. |
| [AI Search GA](https://blog.cloudflare.com/ai-search-ga/) — Oct 1 | Optional authorized project docs, runbooks and screenshot retrieval; isolate indexes/filter by current access, deletion and residency. Track announced Nov 1 billing start. | After core; demo extension with public/synthetic corpus. |
| [KV Instant](https://blog.cloudflare.com/workers-kv-instant/) — Oct 1 | Private-beta qualification for tiny, rarely updated non-authoritative config: announced 1 MB namespace, 10,000 keys, one write/namespace/second, $100/MB/month storage and $0.10 per write/delete/list. Benchmark and cap costs; never use for logs, run state or merge/permission authority. | Conditional on a measured read-heavy developer configuration bottleneck and accepted cost; classic KV default. |
| [K2 event streams](https://blog.cloudflare.com/cloudflare-k2-streams/) — Oct 1 | Large-scale retained event replay/fan-out; qualify batch/latency semantics. Queues remains the task-delivery default. | Conditional on measured CI/deployment event volume and replay/fan-out needs; workload proof required. |
| [Basin GA](https://blog.cloudflare.com/cloudflare-basin/) — Oct 1 | Pipelines → R2/Iceberg Catalog → SQL engineering analytics for CI time, incidents and cost. PostgreSQL remains operational truth; analytics access/retention is scoped. | Conditional on measured build/failure/cost analysis needs beyond existing SQL; exclude from demo until justified. |

The Artifacts announcement includes a competition requiring concurrent agents, permissive open-source source code, runnable instructions, and a 5–10 minute demo; its stated deadline is October 14, 2026. The user has requested competition alignment for the Cloudflare track: Workers and Artifacts are required in a genuine concurrent-agent workflow. Track it as a separate delivery milestone, without promising complete v1 by the deadline. This does not authorize submission, public visibility or license changes. Verify current rules and follow the [competition readiness matrix](docs/COMPETITION_READINESS.md). Source: [competition details](https://blog.cloudflare.com/next-git-platform-on-cloudflare/).

## 22. Cloudflare showcase and portable proof

### 22.1 Demo thesis and visible evidence

Show Golf helping a developer move from intent to maintained production, with multiple agents producing comparable changes and a human retaining control. Every scene has a visible user outcome, real provider resource/run evidence, and an exact commit. The demo interface includes light and black/charcoal themes, a resource map separating Golf infrastructure from application infrastructure, scoped connection health, stage timings, cost and cleanup status.

| Scene | Developer outcome | Appropriate Cloudflare services / evidence |
| --- | --- | --- |
| 1. Bring a project | Connect GitHub/GitLab or import into Golf; show policy/workflow fidelity and blockers. | Workers entry/callbacks; canonical backend clearly labeled; R2 imported attachments/LFS. |
| 2. Turn intent into work | Authorized email creates a tracked issue/task; optional signed external webhook creates a second task. | Email Routing Worker, durable event intake/Queues, optional Workers AI classification; no email-implied privileged authority. |
| 3. Compare parallel agents | At least two real supported harnesses start from the same commit in independent task repos; compare diffs, tests, resource use and retained context. | Artifacts binding/forks/scoped tokens/events; Sandbox/Containers with approved per-task image/size; Workers AI or direct supported inference through optional Gateway. |
| 4. Prove the changes | Execute a supported Actions workflow and a supported GitLab pipeline, stream logs, reuse safe caches and show exact candidate evidence. | Qualified CI SDK/Containers/Sandbox pool; R2 artifacts/caches; DO live coordination where needed. Show an unsupported job blocked accurately. |
| 5. Review a running preview | Deploy each qualified candidate to a temporary private URL, test it and display screenshots/results next to the comparison. | Workers assets/Builds or Containers; Access human/machine auth; Browser Run; DNS; isolated R2/D1/KV bindings as required by the sample app. |
| 6. Ship deliberately | Reviewer selects a change; queue retests integration, authorized promotion deploys exact digest/commit to existing or new live app. | Workflows for provider steps where chosen; DNS/TLS; Worker gradual deployment or qualified Container strategy; no competing auto-deployer. Email Sending + signed webhook announce outcome. |
| 7. Close the operational loop | Controlled production fault creates an incident; agent retrieves scoped context, proposes a repair, passes checks, previews, then awaits review/policy promotion. | Workers Issues/Automations webhook, Logs/traces/OTel, official observability MCP; same evidence chain and budgets. Show rollback and verified recovery. |
| 8. Show scale and ownership | A bounded burst scales runners while respecting tenant quotas; previews expire and resources are cleaned. Show who owns each bill/resource. | Queues and qualified execution autoscaling, R2 retention, Gateway usage/optional Insights; optional Basin analytics when real ingestion exists. |
| 9. Prove the second track | Run the same supported core workflow on Compose and document/rehearse Kubernetes; CF is disconnected. | Local Git, PostgreSQL, configured object storage, mail catcher/SMTP, isolated customer runners and portable preview protection. |

### 22.2 Showcase delivery tasks and acceptance

P8.10 depends on the selected scenes' relevant tasks, not on all optional products. Maintain a demo manifest pinning code, backend, images, pipeline/action/harness versions, account capabilities, domain, resources, quotas, sample data and reset/cleanup procedure. Identify bootstrap waiting periods and pre-provision only what the demo discloses. Rehearsal validates repeatability, stable event IDs and surviving temporary provider failures.

The core journey also has an AI-disabled rehearsal: create the issue manually or by authenticated email/webhook, run scripted tasks and CI, review, preview, deploy and recover without inference. The parallel-agent scene is optional for the AI-disabled product demonstration, but mandatory for the Cloudflare competition entry: at least two real agents must overlap in execution, use isolated Artifacts repositories and a genuine Workers control path. Show comparable diffs, provenance, conflicts and a human selection/review outcome. Neither the portable track nor its release gates acquire a Cloudflare or AI dependency from the competition.

For a 5–10 minute recording, show the core journey live; link deeper import, all-five-harness, Kubernetes and scale evidence separately. Identify elapsed-time compression or prerecorded segments explicitly. Do not substitute fake terminals/provider outcomes for unavailable access. Verify private previews reject unauthenticated visitors and expiring machine grants stop working. Deliberately show one failing candidate, one denied action, rollback/recovery and cleanup so the demo demonstrates useful control as well as speed.

Measure time from task intake to first agent action, checked proposal, protected preview and healthy production; include queue wait, cold/warm starts, cost per checked change and cost per repair. Compare against a declared GitHub/GitLab workflow baseline with equivalent checks/resources before claiming faster. Optional AI Search, Basin, Registrar and routing scenes earn inclusion by a visible user benefit and actual qualification; they are not decorative dependencies.


## 23. Requirement coverage and delivery controls

### 23.1 Requirements traced to delivery

| User requirement / necessary supporting contract | Specification | Tasks and release evidence |
| --- | --- | --- |
| GitHub replacement with shared Gitea forge in both tracks | 2, 4 | P0.8, P2.1–P2.3/P2.9 and P3.1–P3.7; shared fork/Git/review/LFS/protection corpus and supported Gitea ownership/recovery. |
| Deep useful Cloudflare integration; no service-count goal | 10, 21 | P0.6/P0.10, P6; each activated service has a developer outcome and verified account capability. |
| Cloudflare-independent Compose and Kubernetes | 11.10, 13 | P1.5, P4.5, P7.7/P7.10, P8.1; both installs and protected CD tested without CF. |
| GitHub/GitLab connection and direct import | 5 | P2.4–P2.7, P8.2; connection and fenced import evidence for each origin. |
| Actions/GitLab pipelines on scalable own/CF runners | 7, 8 | P0.4–P0.6, P4, P6.4; bounded compatibility corpus and burst/failure evidence. |
| Five agents, supported OAuth/account and API usage | 9 | P0.7/P0.9, P5.3/P5.8; actual supported authentication/execution per harness. |
| CLI, API, MCP, ACP and deterministic automation | 9.6/9.8, 12 | P1.8, P5.1/P5.5/P5.8/P5.9; scoped protocol/session/JSON contracts. |
| AI optional throughout both tracks | 1.1, 9.8, 17 | P5.9, P8.1/P8.11; complete no-AI core journey. |
| Temporary protected deployed links | 11.5–11.6/11.10 | P7.4/P7.9/P7.10; human/machine protection, exact commit, TTL and cleanup. |
| Live CF projects, DNS, R2, containers and resources | 11 | P7.1–P7.9; adoption, provisioning diff, bindings, promotion, health and recovery. |
| Email through CF; inbound/outbound webhooks | 12.4–12.6 | P2.8, P6.9; real sending/routing/delivery events and portable equivalents. |
| Separate marketing/docs repositories, static Cloudflare deployment, versioned MDX | 24 | W1–W5; site builds, accessible themes, version drill, configured origins and generated-reference provenance. |
| Modern light and black/charcoal dark UI | 6 | P1.4, P2.2, P8.1; accessible real-data screens in both themes. |
| Technology Selection Guide with reasoned deviations | 3 | P0.2, P8.7; full revisioned prescription register and ADR evidence. |
| OSS/enterprise with one portable core | 13.5 | P0.8, P9; license/edition matrix, offline entitlement and export safety. |
| Faster/scalable with defensible claims | 8, 15 | P4.3/P4.5, P6.4, P8.3; equivalent workload baselines and resource/cost reports. |
| Cloudflare competition plus lifecycle demo; portable track remains independent | 22 and [entry matrix](docs/COMPETITION_READINESS.md) | P8.10; reproducible evidence, parallel agents plus no-AI proof. |
| Identity, supply chain, retention and recovery | 4.7, 13–15 | P1.8, P4.10, P8.4–P8.6/P8.11; scoped credentials, trusted checks and restored data. |

### 23.2 Delivery milestones and task readiness

Use these milestones rather than promising all v1 scope at a demo deadline: M0 proofs and architecture/guide decisions; M1 useful Gitea-backed portable forge/connection with qualified identity, protection and recovery; M2 deterministic Actions/GitLab execution on customer pools; M3 optional five-agent support and qualified hybrid CF execution; M4 protected previews and production delivery on both tracks; M5 hardening, migration, documentation and verified v1. A demonstration may be a clearly labeled vertical slice through these milestones and does not waive the remaining v1 work.

Before a task becomes ready, assign an accountable implementation owner and reviewer, exact predecessor task IDs, files/contracts to change, runnable positive/negative acceptance checks and expected evidence. Break large task rows into local checklists under the same stable ID. Unassigned owner or unknown estimate is explicit; do not invent staffing or delivery dates. Track planned/in-progress/blocked/implemented/verified independently of installed capability state. A changed requirement updates the corresponding task, test and coverage row together.

Key integration dependencies: P0.8 closes Gitea policy/conditional-merge feasibility before dependent Phase 3 work; P3.6 + P4.9 close queue/CI integration; P2.8 + P6.9 close CF email; P5.6 + P7.8 close agent-requested production promotion; P6.6 + P7.4 close private browser tests; P7.10 + P1.8 close portable local-account preview access; P8.1/P8.11 require the shared Gitea forge on both infrastructure tracks. No later feature is treated as already available to an earlier phase.

### 23.3 Remaining proof decisions and honest completion

P0 must resolve the Actions engine subset, pinned GitLab coordinator interoperability, Gitea policy enforcement boundary, five harness/auth eligibility combinations, CF compute/Artifacts/Email account capabilities, supported storage/ingress profiles, and complete guide deviation register. The plan specifies their outcomes and blocking behavior; it does not establish feasibility merely by listing tasks. Where a required proof fails, revise the implementation approach or record a scope decision before calling the affected capability complete.

The review closes identified specification gaps, not all possible future requirements. The plan is ready to drive Phase 0; the complete v1 claim requires the coverage matrix, compatibility catalogs, real integration evidence, operations drills and documented limitations to pass. Government/FIPS and conditional analytics/optimization products remain separate expansion gates. Review the plan at each milestone and after an upstream breaking change.

## 24. Marketing and versioned documentation sites

### 24.1 Repository and delivery boundaries

Maintain separate repositories for [product](https://github.com/mjtechguy/golf-git), [marketing](https://github.com/mjtechguy/golf-website) and [documentation](https://github.com/mjtechguy/golf-docs). All start private. Marketing and docs build to static assets, deploy independently to Cloudflare Workers Static Assets, and also work on ordinary static hosts. Commands remain manual; no repository CI yet. Public visibility, license selection, live deployment and competition submission are separate actions.

Marketing follows the local Victor website's design language: black/charcoal and warm light surfaces, lime accents, condensed Archivo headings, monospace detail, strong rules and square geometry. Use original Golf content, responsive navigation, accessible focus/contrast and reduced-motion support. Explain the shared product, two tracks, optional AI, lifecycle and measured proof. Separate available functionality from roadmap. Configure real application/docs origins before publication; never imply a hosted service or benchmark advantage without evidence.

Marketing must have the content depth of the full Victor reference, not only its homepage styling: substantive product/workflow, Cloudflare, self-hosting, agents/protocols, runners/pipelines, previews/deployment, security/ownership and status/roadmap material. Use shared navigation and original diagrams to connect the topics. Lightweight architecture/workflow exploration, capability filters, accessible FAQs and copyable verified setup commands should help visitors make actual decisions. Every interaction distinguishes implemented behavior from proposed architecture; a planned service must not appear to be running.

Reserve a future interactive demo environment, to be built **after the corresponding product/tool interactions exist**. Derive it from real screens and contracts, with deterministic synthetic fixtures, reset behavior, clearly visible demo mode, and no real secrets, repository writes, infrastructure spending or messages. A simulation must never manufacture provider proof or substitute for the competition's real concurrent-agent demonstration. Document the future demo acceptance/storyboard now; do not ship an empty or misleading demo CTA. Marketing development/preview uses fixed port **4325**, independently of Victor; docs uses 3000 and the app 8080.

### 24.2 Documentation framework and version contract

Use Docusaurus with Markdown/MDX, Git source ownership and a custom Golf theme. Its built-in snapshots and versioned sidebars satisfy the versioning requirement without writing a custom release framework. Fumadocs/Nextra remain alternatives for deeper application integration; Mintlify is an alternative if managed hosting becomes the priority. Start with one Golf documentation instance; add independently versioned instances only for independently released products. Reading/building docs requires neither Cloudflare nor AI.

Development guides live in `docs/` at `/docs/next/`. After a verified product release, run `docs:version`, commit `versions.json`, `versioned_docs/` and `versioned_sidebars/`, and record the product tag/commit and compatibility inventory. Latest stable resolves at `/docs/`, older snapshots at `/docs/<version>/`; test these routes and the selector. Do not invent a stable release. Document supported/EOL versions and redirect policy. Backport critical security corrections to maintained snapshots without silently changing historical API contracts.

Coverage includes installation (Compose and qualified Kubernetes), both tracks, identity/admin, Git/import/connections/review, runner compatibility, agents/authentication, CLI/API/MCP/ACP, previews/CD, Cloudflare resources, email/webhooks, recovery, upgrade, troubleshooting and security. Each topic labels unsupported behavior honestly. Publish an implementation-status page and generate agent-readable `/llms.txt` and `/llms-full.txt` from the same public source, with version/authority guidance. Documentation never grants agent permissions.

### 24.3 Generated references and Forge qualification

The product repository owns the executable API contract. Derive reference from that contract (planned protobuf/Connect and an approved OpenAPI export); the docs repository owns guides and reviewed generated output. Pin product revision, schema digest, generator/plugin versions and artifact checksums in an import manifest. CLI examples must match shipped help; MCP/ACP reference must match qualified versions. Keep cross-repository imports manually reviewed while CI is disabled and check schema/reference drift during releases.

Cloudflare Forge is a conditional generator, not the documentation frontend or an initial docs dependency. Its initial release focuses on Cloudflare CLI generation; prove required SDK/docs output against Golf before adoption. Verify license, deterministic generation and usable output. Use an established compatible generator if Forge cannot satisfy the required output. Do not maintain a second hand-edited API contract solely to use Forge. Sources: [Forge announcement](https://blog.cloudflare.com/forge-open-source-generation-pipeline/), [Forge source](https://github.com/cloudflare/forge), [Docusaurus versioning](https://docusaurus.io/docs/versioning), [multi-instance docs](https://docusaurus.io/docs/docs-multi-instance).

### 24.4 Tasks and acceptance

These extend P1.4/P8.7; assign implementation/review owners in the execution ledger.

| Task | Deliverable | Acceptance |
| --- | --- | --- |
| W1 | Independent marketing site and Victor-inspired design | Deep original multi-page content; useful accessible interactions; black/light/mobile/keyboard checks; working navigation and static production build; isolated port4325. |
| W2 | Independent Docusaurus site and development guides | Markdown/MDX, broken-link build gate, themes, generated agent-readable output and verified current setup instructions. |
| W3 | Version/release and generated-reference workflow | Disposable snapshot drill proves stable/next/older routes; actual release required for committed snapshot; schema/version provenance and drift checks. |
| W4 | Manual Cloudflare/static deployment configuration | Wrangler dry-run, configured public origins, headers and documented deployment/rollback; live deployment recorded separately. |
| W5 | Publication and maintenance quality | No credential/private-content leaks or unsupported claims; accessible layout, source/version navigation and documented support/edit policy. |

The bootstrap can establish W1/W2 and local W4 evidence while live hosting, full feature documentation and generation integration remain outstanding. Record exact evidence in each README and the product ledger.


### Local email login increment (2026-10-02)

Golf-owned password login accepts an operator-enrolled unique email or username. Both aliases share account throttling and the existing opaque HttpOnly session model. Schema008 preserves prior mappings and adds optional email aliases; operator `set-email` advances the credential version and revokes local sessions/dependent delegations. Provider profile emails do not link identities. Email ownership verification, self-service change with step-up/reverification, notification of changes, recovery tokens and enterprise identity lifecycle remain required before public enrollment.

### Connection inventory interaction rule

Coding-agent connection inventories use compact Lucide icon actions with accessible names and hover hints. Item metadata and provider quota details belong in a read-only details modal with keyboard dismissal and focus return. Add/Edit/Rename expose explicit TanStack Form editors; Disconnect uses confirmation. Personal rename preserves immutable connection identity, credentials and ownership, while instance name/access changes retain administrator authorization and optimistic versions. Shared-use permission never implies management or private usage access. Common global table, modal and page-stack styles own layout and spacing.


### Implementation update: bounded manual Codex tasks (2026-10-03)

The portable Docker track now implements browser-managed manual Codex ChatGPT tasks: current scoped usage/account/model admission, pinned ordinary-file source capture, durable request receipts, exclusive native account ownership, worker leases/revocation checks, confirmed cancellation, private isolated workspace, final summary/proposed patch and terminal worker-loss outcomes without automatic replay. See [execution contract](docs/AGENT_TASKS.md) and [current evidence](docs/IMPLEMENTATION_STATUS.md). This advances the managed-agent execution phase; it does not complete the broader agent, HA/recovery or Cloudflare gates.

Remaining implementation tasks: qualify Claude/OpenCode/Grok/Pi and API-billed execution independently; add automation credentials and push/PR-comment dispatch; task API/MCP/ACP access; fair queueing and scope-specific aggregate quotas; crash-safe credential checkpoints/resume; artifact-store snapshots; reviewed proposal publication; task audit/event history; Kubernetes/Cloudflare adapters and canonical schema026 recovery. Cloudflare infrastructure remains optional for this portable path. No repository CI workflows are added.

### 2026-10-03 visual and live implementation references

Element-level screenshot acceptance is recorded in the [visual audit matrix](docs/GITHUB_VISUAL_AUDIT.md#element-level-comparison-and-layout-priorities): diff preferences/ranges/file filters/menus, branch row actions/check details, desktop/mobile tags/releases and the compare-to-create flow. Prioritize shared page/toolbars and contextual file navigation, then real compare/lifecycle and supported row operations. Keep matched screenshots and accessible control snapshots for both themes, mobile, open menus, long content, empty and denied states. This reference work does not qualify pending implementations or change the P0.8 protected-merge gate.

The [GitHub visual audit](docs/GITHUB_VISUAL_AUDIT.md) records actual page/row/menu comparisons and remaining controls under GX-1–GX-8. The [repository activity contract](docs/REPOSITORY_ACTIVITY_CONTRACT.md) defines the initial private Connect invalidation stream, immutable snapshot behavior, bounded admission/replay and unqualified distributed/proxy/log acceptance. The implementation ledger records tests and served-image qualification; neither reference completes full GitHub parity or protected merge enforcement.

### Actions run and log continuation implementation reference

Canonical full-page run detail and sequence-paged loaded logs now implement another GX-2/GX-5 slice. Current scope, cursor/privacy/cancellation boundaries and remaining job/step/engine/ACP work are documented in [pipeline execution compatibility](docs/PIPELINE_EXECUTION_COMPATIBILITY.md#current-actions-run-workspace). This does not replace P4/P6 requirements or establish protected merge authority.

### Worker-recorded step progress and interaction follow-up

The narrow single-job executor now records start/finish events independently of stdout, exposes named step outcomes/times, and supports zero-based step log links with snapshot-bound boundaries. The [runner isolation contract](docs/RUNNER_ISOLATION_CONTRACT.md) describes the private worker event origin and native exec lifecycle; [pipeline compatibility](docs/PIPELINE_EXECUTION_COMPATIBILITY.md#current-actions-run-workspace) retains multi-job/engine, artifacts/cache, rerun and safe agent/ACP work. Schema031 remains beyond the qualified recovery checkpoint.

Expanded GitHub screenshots cover branch/clone menus, file controls and row filtering/sorting/density. Shared branch search, protocol/copy controls and literal code/path copy advance GX-1/GX-3/GX-7; authenticated write menus and remaining lifecycle controls need their own native operation contracts. The [visual audit](docs/GITHUB_VISUAL_AUDIT.md) records evidence and remaining tasks. P0.8 protected merge/check enforcement remains required and unresolved.

The expanded visual pass compares11 actual public GitHub page types at matched desktop/mobile widths plus history author/date menus. Compact authored-date commit rows, exact SHA/source actions, shared issue/PR comment cards and mobile work-tab scrolling advance GX-1/GX-7. Authenticated row/settings/merge controls, richer filters and full collaboration remain required. Evidence and follow-up acceptance criteria are in the [visual audit](docs/GITHUB_VISUAL_AUDIT.md); P0.8 remains unresolved.

Ordinary issue editing/lifecycle advances GX-4 using explicit inline editors, separate title/body/state intents and the existing durable owner-scoped journal. The [discussion contract](docs/ISSUE_DISCUSSION_CONTRACT.md#edit-close-and-reopen-ordinary-issues) records actual native permissions, body-version admission and non-atomic title/state limitations; latest-schema recovery and remaining collaboration requirements stay open.

PR creation/lifecycle advances GX-4 with two generated browser-session writes, separate native PR IDs and shared explicit issue/PR editors. Native body versions, displayed source/base/revision observations and durable receipt/readback detect stale or uncertain outcomes without retries. [PR mutation contract](docs/PULL_MUTATION_CONTRACT.md) retains the non-atomic native-address/title/state limits, latest-schema033 recovery gap and required full-page compare/create UI, human review/metadata and protected integration work.

Shared diff layout/navigation advances GX-1/GX-3/GX-7: changed-file hierarchies, native-index-stable loaded file-type/Viewed filters, persisted display-only preferences, wrapping and bounded safe syntax colours. The [workspace contract](docs/DIFF_WORKSPACE_CONTRACT.md) preserves private snapshot boundaries, raw output and remaining server Viewed/source/review/whitespace/context/merge requirements. This does not close protected integration or full forge parity.

Full-page compare/New PR advances GX-4 with generated exact-selection comparison reads, independently authorized renamed forks, paged loaded-only branch menus, shared commits/diffs and explicit ready/draft Markdown composition. Original commits/drafts remain pinned through target/source live activity; access loss clears private content and reload inspects only outcome metadata. [Comparison contract](docs/REPOSITORY_COMPARISON_CONTRACT.md) records native500-commit/512KiB bounds and non-atomic/completeness limits. The screenshot pass adds actual clone/branch menus and a compact accessible mobile header under shared CSS. Tags/ranges, richer source/row controls, human reviews, merge/squash/rebase, broader runner/ACP progress and latest-schema recovery remain requirements; P0.8 is unresolved.


### 2026-10-03 contextual source and full-page issue integration

A further implemented GX-1/GX-4/GX-7 slice adds pinned literal file/directory history through the existing generated `ListCommits`, CLI command and `golf_repo_commits` MCP tool. A nonempty path requires exact snapshot/native repository identity, with validated echoed selection and Golf pagination adapting the pinned native fixed span. Literal Unicode/glob/leading-colon paths do not become patterns; rename-following history is excluded. [Exact history/actions contract](docs/PATH_HISTORY_CONTRACT.md).

Shared source components now provide bounded numbered syntax, line/range permalinks, copy path/permalink and exact ordinary-preview UTF-8 attachment download. Non-root views use a mobile-collapsed lazy [Files navigator](docs/SOURCE_NAVIGATOR_CONTRACT.md) with loaded-expanded-only filtering, bounded expansion and private query cleanup. Shared source rows expose independently linked [latest-change title/date](docs/SOURCE_ENTRY_COMMIT_CONTRACT.md), admitted only while visible with three directory-row RPC promises per browser instance. A one-row request may still read a native fixed history page; this is not a server concurrency/throughput claim. `GetContents` still lacks a native expected-ID receipt, and frontend query identity cannot supply one.

New issue composition moves to canonical `/OWNER/REPOSITORY/issues/new`, with explicit shared TanStack Write/Preview, Cancel and dirty-draft departure confirmation. Existing actor-bound durable frozen intents, uncertainty and status-only reload remain unchanged. This adds a composition surface rather than another mutation authority. The [implementation ledger](docs/IMPLEMENTATION_STATUS.md) records bounded final combined served-image/browser/native qualification; this does not complete the full repository or protected-integration requirements.

Remaining acceptance includes blame, tags, repository-wide finder, generic raw/binary/LFS downloads, source mutations, human reviews/metadata, richer history/compare, full Actions/ACP progress, scale and both infrastructure tracks. The [proposed protected publication design](docs/PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md) retains complete merge/squash/rebase/fast-forward scope and its required boundary/fault/recovery proof. P0.8 and latest-schema033 recovery remain unresolved; this increment neither closes the complete plan nor changes the optional Cloudflare/AI portable core.

### 2026-10-03 initial human overall reviews

An implemented and locally qualified GX-4/P2.2 slice adds generated immediate COMMENT/APPROVED/REQUEST_CHANGES authoring and own-operation inspection, binding the original displayed native repository/PR IDs, revision and full base/head. An independent migration034 journal commits exact-input/body fingerprints and actor identity before one native POST, stores provisional receipt evidence, and completes only after independent authorized readback. Identical keys never repost, and lost/malformed/absorbed responses retain unknown outcomes. Browser-session writes remain separate from read-only Golf API delegation. [Contract, served evidence and remaining acceptance gates](docs/PULL_REVIEW_MUTATION_CONTRACT.md).

The [actual native characterization](docs/PULL_REVIEW_NATIVE_QUALIFICATION.md) proves reviewer/self/reader permissions, draft/closed/merged behavior, exact native receipts, old-head reviews, pending-inline absorption, hidden pages and duplicate POSTs. A body-only native POST can submit an existing pending draft; reject observed own pending reviews, scan all bounded native pages including empty visible pages, validate the effective configured page span, and require zero native comment count in receipt/readback. This detects rather than fences a concurrently introduced draft. A current-head change after dispatch may still yield a valid review of the original snapshot; show that earlier snapshot explicitly. Native `official`/`stale` flags are not current eligible Golf approval or merge authorization.

The shared native page-size adapter now observes the supported API maximum before/after reads and uses the effective configured span for PR lists, native review lists, repository-wide filtered discussion comments, collaborator lists and pending-review preflight. Real-PG tests qualify hidden 50-row native pages and current-actor pending discovery at row 101; unit tests reject missing/negative/drifting settings. Pending preflight is bounded to 2000 native rows/pages and an implemented 15-second whole-scan child context; exact budget exhaustion is not yet qualified. A confirmed submission later dismissed remains SUCCEEDED with its current native dismissal flag; original pending receipt/readback still require an undismissed review. Setting observations are not a configuration lock.

Final `make check` and the full 390-test browser suite pass; broad real-PostgreSQL race tests pass 119.601s. Additional interrupted-preflight real-PG proof passes 1.960s: caller cancellation during a partial native scan completes a durable rejection and replay sends zero POSTs. Exact 15-second exhaustion remains unqualified. `make qualify-pull-reviews` passes actual Golf/native decisions, zero-comment independent readback, replay/conflict, self/wrong-target/pending refusal, own-status, PAT/bearer and Origin boundaries on image `sha256:5e4ca543693c1d6fa86e3d7a5d3b1ce76d2a2a937874c2985fc80df15e0b9ae1`. Actual production Review changes composition/Markdown preview is explicit rather than modal, fits both themes at 1280px/390px, publishes a real review visible in Conversation, and removes a private unsent draft after live access revocation. Disposable actors/repositories/sessions are cleaned. Fixture tests separately establish uncertain-result/status-only reload behavior; native happy-path proof does not simulate a lost response. No source/imported workflows, paid inference or remote writes run.

Next acceptance tasks: exact slow-scan exhaustion, actual Golf in-flight old-head/lost-response/cancellation races, larger provider pagination corpus and restart/recovery; human inline/multiline drafts, suggestions, replies, resolve/reopen/dismiss, requested reviewers/teams/CODEOWNERS and trusted merge evidence. Full merge/squash/rebase and native/ACP Actions progress remain required. Schema 034's Down refusal preserves the published-review journal; a fresh coordinated backup/restore must retain its unknown/success/rejection/event records and invalidate credentials/sessions. Neither latest-schema 033 nor034 recovery is presently qualified. No phase or the overall repository parity goal is complete.

### 2026-10-03 initial inline review-comment reads

An implemented GX-3/GX-4 read increment adds generated `GetPullRequestReviewComments`, explicit lazy comment expansion in Conversation and the Files changed comments panel, `golf pr review-comments` and `golf_pr_review_comments` MCP. Requests bind exact native repository/PR/review IDs and the full reviewed commit; responses retain bigint IDs, the independently observed review and a separately observed current PR head, which can be empty when source metadata is unavailable. Browser-session, PAT and owner-issued read-only bearer reads retain current caller/repository authority. The [read contract](docs/PULL_REVIEW_COMMENTS_READ_CONTRACT.md) records the exact API and UI bounds. The bounded served Golf/native/browser/CLI/PAT-bearer MCP qualification passed for implementation `b99de7a` on image `sha256:ce7530520f0456a55d9188e99412f3e3ec3b48830f2413baf932220f8137ec31`; the implementation ledger records provenance and cleanup. That actual deployed read proof does not qualify inline writes or a later changed deployment.

The supported native endpoint returns a complete unpaged array and ignores `page`/`limit`. Golf refuses more than 100 comments, JSON over 2 MiB, bodies over 256 KiB and stored hunks over 64 KiB; it never presents truncation as a complete thread. Review identity, selected commit, count and header observations must match before/after the read. Own PENDING is readable; another user's pending review is rejected before child fetch. Sorting uses parsed creation time and exact numeric ID. These checks do not lock the child collection: concurrent body/resolver edits can leave the parent count/header unchanged. The implemented 15-second operation cap still needs exact exhaustion proof. Real-PG read/authority race fixtures pass 21.936s and CLI/MCP race fixtures pass 2.029s; separate production UI/native/CLI/PAT-bearer MCP54-comment proof passes, with all fixtures purged and exact image/evidence in the implementation ledger.

The [native inline characterization](docs/PULL_REVIEW_COMMENTS_NATIVE_QUALIFICATION.md) qualifies 53 rows despite a 50-row API maximum, large/empty bodies, old/new file lines, same-review replies, resolver ghosts and original context retained after head movement, rename and deletion. Native `position`/`original_position` mean new/old file lines, not latest/original relocated coordinates or thread IDs. Child commits are line/blame metadata and can differ from the selected review head; empty original commits do not establish the reviewed base. Shared compact comment headers, safe Markdown, dates and escaped hunk disclosures show these observations without inventing current source anchors. Resolution is per comment, preserving a non-null ghost resolver as resolved while its unavailable identity is omitted; a resolved parent and unresolved same-line reply can coexist. Private content remains in memory and is hidden during authority revalidation, then removed on account/selection/access loss. Complete external native-edit invalidation still requires producer reconciliation; arbitrary native body/resolver changes are not guaranteed live updates.

Human inline/multiline batch authoring, durable private drafts, replies, suggestions, edit/delete, resolve/reopen, dismissal and correct original/current diff mapping remain required. Future reply writes must independently read and authorize the parent review: native reply POST accepts a known comment ID from another user's hidden pending review even though that review's comments GET returns 404. Native review creation also writes comments before submission without one encompassing transaction; a failed batch can leave partial pending state. Reserve exact ordered comment inputs and reviewed-diff identities durably, reject observed pre-existing pending drafts, independently verify every returned child and retain uncertain/partial outcomes without reposting or adopting an unrelated draft. Neither a successful native POST nor a shared line proves complete-thread visibility or write authority.

The expanded [native boundary fixture](docs/GITEA_BOUNDARY_FIXTURE.md) advances metadata/current-user identity and PAT/Bearer-PAT wrong-target/replay checks. Its experimental qualification does not close P0.8 admission, complete mediation or effective-write fencing. This read increment adds no migration; latest-schema 034 coordinated recovery, protected merge/squash/rebase, full review collaboration and both-track scale remain open.


### 2026-10-03 exact PR comparison and inline authoring sequence

An implemented GX-3/P2.2 preparation packet strengthens the existing `GetPullRequestDiff` rather than adding a second comparison engine. Requests require exact native repository/PR IDs and displayed branch-tip/head objects. Responses echo those bindings and separately expose `mergeBaseCommitId`, the actual native old-side comparison object; PR metadata may leave it unavailable, but a diff requires it. Retained PR head, native identity and merge-base observations bracket the bounded read. A diverged base tip B and source H with common M displays **M→H**, while the branch-tip field remains B. The browser validates the original displayed merge base, hides mismatched/stale receipts, binds cache/anchors/Viewed to the correct native objects, and names the divergent tip separately. CLI/MCP share the exact-ID receipt; read delegation gains no write authority. [Comparison contract](docs/PULL_DIFF_CONTRACT.md).

Local evidence: TypeScript and whitespace checks pass; **443/443 browser tests pass in 2.6m** after the shared responsive correction; six focused toolbar cases pass in 8.4s at 1280/390/320px in both themes. The earlier 116-test affected suite passed 58.5s, including seven new cases for divergent old-side anchors/Viewed reset, wrong repository/PR/merge-base receipts and unavailable/malformed metadata before dispatch. **The new served exact-ID private-fork comparison qualification passed** on image `sha256:c8875d57eaa3d5f17760bdc1751aedf4830d16cd76bc33350f9879f1813ca769`; all four fixture actors and the private base/renamed fork were purged. Supported Git clone/fetch independently proves common M versus branch-tip B, blob identities and exact raw diff bytes. API/CLI/PAT-bearer MCP, base-only authority without general fork read, wrong ID/head/outsider/Origin denial, four actual theme/mobile browser captures, live private revocation and stale target after movement pass. The actual 390px capture exposed cramped toolbar labels; the global correction now wraps complete controls without shrinking/breaking labels, with final 443-test browser proof; replacement-image served recapture passes on `sha256:1f81b70aec461e5d2591ffb58ab17ede5f1b13fa07e18e97b60bb29a12d47017`. Exact final image, native Git/blob/diff evidence, test results and cleanup belong in the implementation ledger. No new writer or migration is introduced.

The [actual inline-write characterization](docs/PULL_INLINE_WRITE_NATIVE_QUALIFICATION.md) passes serial supported Gitea 1.27.3 cases with five fixture actors and the repository purged. It proves a merge base distinct from the branch tip; a supplied historical review head can coexist with current-head stored hunk context and different line/blame objects. Appending/submitting an own pending review can rebind its header while retaining earlier children. Both later-child 500 and final-submit 422 failures left a pending child. Knowing a hidden foreign pending parent ID allowed a reply and author resolution despite 404 on reads. These native observations are requirements for conservative Golf admission/receipts, not a qualified Golf writer, private-fork authoring or a target-side write fence.

The [inline implementation design](docs/INLINE_REVIEW_IMPLEMENTATION_DESIGN.md) supplies the following ordered packets under GX-3/GX-4/P2.2/P2.9/P5.5. They apply to both infrastructure tracks with AI/Cloudflare optional; complete human and agent review parity remains required.

| Packet | Concrete implementation and acceptance | Current state |
| --- | --- | --- |
| IR-0 | Characterize actual merge-base/context, historical head, pending append/submit, partial batch and hidden-parent behavior through supported APIs; retain original/current bytes and cleanup evidence. | Serial same-repository characterization passed; private forks, in-flight head/base/pending races, lost transport and effective-write fencing remain unqualified. |
| IR-1 | Exact native IDs and actual merge base in existing diff API/Go mapping, retained-head observations, browser selection/old-side metadata, CLI/MCP receipts; actual diverged private-fork comparison and denied source access. | Implemented with local and served private-fork comparison proof; shared responsive correction passes 443 browser tests; replacement-image served requalification passes; final provenance is in the implementation ledger. Server coordinate admission and authoring controls are not included. |
| IR-2 | Parse/validate exact displayed coordinates server-side; retain actor-bound original comparison; encrypted owner-only drafts/immutable CAS versions, explicit shared row/workspace editors and two-device/restart/revocation checks. | Bounded encrypted private working collections implemented under migration036/review_content with real-PG and served/native/browser proof; see the private draft contract. Complete two-device, backend-restart, byte-boundary/SQL lost-acknowledgement and latest-schema recovery acceptance remain open. |
| IR-3 | Freeze one exact draft version/batch; durable owner/key reservation and shared actor/PR exclusion with overall reviews; one native dispatch, independent full-child/context verification, partial/unknown status-only inspection. | Bounded source implementation now integrated with independent PostgreSQL/native HTTP and browser-fixture evidence; see the [publication contract](docs/PULL_INLINE_PUBLICATION_CONTRACT.md). Durable predispatch refusal and success-only live updates are implemented; bounded replacement-image managed-browser/native publication, revocation and known-success restart qualification now pass. 500/422 can follow writes; no blind retry, remainder publication, guessed adoption or replacement-key bypass. Full packet acceptance remains open. |
| IR-4 | Explicit native own-PENDING synchronize/adopt/submit/discard with original-comparison provenance and frozen child inventory; do not absorb another draft or silently retarget a saved review. | Required; existing own-pending read-only inspection is qualified, not draft mutation. |
| IR-5 | Currently visible exact-parent replies, per-comment resolve/reopen, published edit/delete/dismiss and known Golf-origin parent relations; qualify roles/privacy/concurrency/uncertain outcomes. | Required, not implemented. Native same-line comments lack parent IDs; one resolved row is not a resolved conversation. |
| IR-6 | Native-compatible multiline/whole-file coordinates, suggestions and exact guarded apply commits; provider extension where supported metadata is absent. | Required, not implemented. Line 0 or two positive sides must not impersonate a range/file contract. |
| IR-7 | Explicit scoped review-write delegation for CLI/MCP, shared browser/agent semantics, both themes/mobile/keyboard/privacy and actual served/native qualification. | Required; current API credentials/MCP are read-only. No provider token or forged browser Origin grants agent write authority. |
| IR-8 | Latest-schema fresh-target coordinated restore of comparison/draft ciphertext, complete journals/unknown effects and native pending state; invalidate restored authority and verify no accepted request resumes. | Required; latest-schema036 recovery remains unqualified. Do not merely expand the recovery allowlist. |

Before dispatch, each immutable entry must bind a unique legitimate old/new file line in the exact shown diff; child blame commits cannot establish that context. After any possible acceptance, lost/malformed/partial/mismatched outcomes remain unknown without replay, even after a browser/server restart. Native parent visibility must be authorized independently before a reply or resolve, and missing thread ancestry stays explicit. IR-2–IR-8 need their own API/Go/SQL, real-PG race, browser, supported-native and served evidence. P0.8 protected merge/squash/rebase, complete original/current mapping, source authority, exact timeout exhaustion and coordinated latest-schema036 recovery remain open; no phase or the complete Golf goal is closed.

Priority correction for the existing managed bot writer: apply the same native findings to `reviewer_worker.go`, whose earlier publication checks covered only review ID/publisher/head and lacked publisher-owned pending preflight or complete independent child receipt. Preserve publication uncertainty independently of snapshot freshness; changing the head, reviewer configuration or intent must not erase a possible native effect or permit a fresh key to absorb its pending children. Freeze exact native target/PR identity, actual old object, reviewed head, accepted diff and publication inputs, and reuse strict coordinate admission rather than retain a second permissive parser. Add durable same-publisher/native-PR exclusion, pending pagination, receipt/body/event/child/context verification and non-replaying inspection; conservative legacy handling must not manufacture original dispatch evidence. Test concurrent intents, pending beyond filtered pages, partial500/422, lost native/SQL acknowledgements, restart, source/context drift and late authority loss. The bounded agent inline-review feature remains a full requirement; do not close this task by silently downgrading it to body-only comments or treating native header success as verified publication. Existing happy-path proof does not satisfy these new acceptance criteria. The repair's [publication contract](docs/REVIEWER_PUBLICATION_CONTRACT.md) and [current qualification ledger](docs/IMPLEMENTATION_STATUS.md#managed-reviewer-publication-repair-2026-10-03) distinguish source/real-PG/actual-native-helper evidence from served-worker/provider and recovery qualification. IR-2 private draft backend and UI work proceeds in parallel, without native publication authority.

### 2026-10-03 native feature and URL integration follow-up

The [native feature and URL audit](docs/NATIVE_FEATURE_AND_URL_AUDIT.md) records the supported API/Git boundary and currently exposed versus missing product surfaces. Retain native repository/transport capabilities rather than rebuilding them; Golf owns its UI, typed contracts, automation and durable intent. This integration direction is implemented for bounded features, not complete Gitea/GitHub parity.

The latest bounded source increment implements redundant path-owned query removal, canonical repository settings with legacy aliases, authorized tree/blob and legacy normalization, and shared deep-link selector validation. Optional native unit configuration now distinguishes false/unknown; disabled Issues/PR controls and deep work panels are gated, metadata revalidates on mutable activity, and unsupported Wiki configuration is read only. These flags do not grant authority or establish that an enabled external tracker is an internal unit. Readable branch/tag entry links still require a qualified slash-ref/path resolver and exact immutable operation snapshots. Prioritize unified account-disable/Git ingress, protected merge/direct-native write enforcement, complete collaboration and native branch/fork/import/release coverage; maintain distinct GitHub/GitLab CI engine requirements. The audit does not close P0.8, latest-schema036 recovery or the full implementation goal.

### 2026-10-03 shared diff mobile density follow-up

Source-qualified shared diff toolbar controls use labeled icons and global CSS with44px mobile targets. The initial affected141 browser cases and `make check` pass. Subsequent grouping and actual replacement-image inspection reduce the 390px toolbar from235px to138px, preserving desktop49px and mobile touch targets; exact capture/image provenance is recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md). This does not close full native inline publication, readable-ref URLs or the collaboration/forge parity gate.

### 2026-10-03 saved native inline publication integration

The [publication contract](docs/PULL_INLINE_PUBLICATION_CONTRACT.md) records integrated managed-browser saved-version publication, immutable reservation/shared native-actor exclusion, independent complete native receipts, durable predispatch refusal and success-only human review live activity. Final isolated PostgreSQL/native and combined main browser checks pass as recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md). The bounded replacement-image managed-browser/native publication, cross-tab update, revocation and known-success restart qualification now pass; exact runtime/evidence identities are in the ledger. Native draft lifecycle/replies/resolve/suggestions, follow-up review attempt history, complete authority/ref fencing, protected merge and coordinated latest-schema recovery remain required; the full implementation goal and IR-3 packet acceptance are not closed.

### 2026-10-03 readable source URL implementation design

The [readable source URL design](docs/READABLE_SOURCE_URL_DESIGN.md) preserves ordinary branch/tag browsing addresses and separate immutable commit permalinks. RS-1 first binds GetContents/images and all browser/README/navigator/CLI/MCP callers to current native repository ID and exact commit receipts, including default and legacy inputs. RS-2 adds bounded exact ref resolution, slash/name collision handling, readable routing, explicit Latest and Copy permalink actions, and safe same-ID rename handling where qualified. The document assigns disjoint ownership and native/served-browser evidence gates. At this documentation checkpoint neither packet was implemented. Subsequent RS-1 qualification is recorded below; readable URLs, latest-schema037 recovery and complete native feature parity remain open.

### 2026-10-03 exact source foundation and repository layout follow-up

RS-1 is now implemented through `eabe5b9`: typed default/branch/tag/commit resolution, expected native repository ID and exact source/image receipts across browser/README/navigator/CLI/MCP, and exact object-based sibling workflow reads. Bounded source/real-PG/native and replacement-image served qualification pass, with runtime identities, cleanup and limitations in [implementation status](docs/IMPLEMENTATION_STATUS.md). This supersedes only the earlier RS-1 design-only state. RS-2 still must retain readable branch/tag addresses, resolve slash/name ambiguity exhaustively, provide explicit Latest/Copy permalink and qualify same-ID rename/recreation. Current SHA normalization is not that completion.

The deep GitHub/Gitea layout review adds a repository sidebar packet: align root refs/Code toolbar inside the left column with About at the top of the right rail; expose exact-ID/current-authority-bound About, safe website, topics, indexed language byte statistics, detected license IDs and honest native star/watch/fork counts. Reuse shared components/global CSS and keep the bounded Golf workspace, both themes/mobile/keyboard and private late-result clearing. Native indexed languages/licenses are repository observations, never selected-SHA facts. Contributors need a complete supported source or a separately designed bounded Golf index; recent commit authors cannot become a total. Releases/assets, watch/star/fork actions, repository-linked packages and Golf deployment/environment visibility remain separate feature adapters with their own authority, pagination and native/served tests. No fake disabled links, partial totals or invented successful integrations.

Follow-up archive qualification should independently compare normalized whole-workspace ordinary bytes/PAX commit for an old full SHA versus a SHA-looking moved branch/tag, including unchanged workflow but changed other source and Git archive attributes. Native source inspection currently resolves full object IDs before ref guessing, so do not label archives vulnerable to the `contents-ext` precedence bug without actual evidence. Preserve explicit snapshot/archive semantics and future LFS/submodule/.git requirements.

### 2026-10-03 repository overview qualification checkpoint

The [sidebar review](docs/REPOSITORY_SIDEBAR_PARITY_REVIEW.md) is now followed by a bounded implemented [overview contract](docs/REPOSITORY_OVERVIEW_CONTRACT.md): exact-ID/current-authority About, website/topics, optional native counts, indexed languages/licenses and aligned root Code toolbar, including empty repositories. Shared README controls are condensed and both Golf themes/compact mobile layouts retained. Source/real-PG,157 affected browser cases and final actual native/served two-tab revocation proof pass; provenance and limits are in [implementation status](docs/IMPLEMENTATION_STATUS.md). This closes only that narrow sidebar task. Complete contributor aggregation, snapshot resources, releases/assets and watch/star/fork mutation UX, repository-linked packages, protected deployment/environment links, issue/PR contextual metadata and CLI/MCP overview parity still need their own adapters/authority/pagination/served acceptance. The two-track full implementation goal remains open.

### 2026-10-03 all-page GitHub familiarity acceptance

The [route inventory](docs/ALL_PAGE_ROUTE_COVERAGE.md) expands visual acceptance to every registered page family and its embedded workspace, rather than only repository Code. Compare primary GitHub page hierarchy, contextual navigation, content widths, typography, row density, action placement, breadcrumbs, tabs, empty states and mobile behavior while retaining Golf's charcoal/light/lime identity. The [all-page review](docs/ALL_PAGE_UI_PARITY_REVIEW.md) distinguishes actual public references, authenticated reference gaps, historical captures and fresh served evidence. Golf-only infrastructure/agent/admin surfaces use consistent shared conventions without implying a nonexistent GitHub counterpart.

Acceptance tasks: provision disposable supported-native personal/org/reader/outsider fixtures; visit each canonical page with the correct authority; capture both themes at desktop/mobile widths; inspect open/cancel editors and menus; record route/state/actor/image/config provenance and unexpected RPC/page errors. Fix shared layout/table/navigation rules first, then route-specific issues, and repeat only affected captures after changes. Empty Actions is not run/step/log proof, unconnected agents are not execution proof, and signed-out GitHub settings gates are not authenticated settings references. Keep unsupported routes/features in the explicit remaining inventory. Preserve current permission, exact source/review receipts and uncertain-write behavior during every layout change.

The initial shared increment compacts empty/small inventories, aligns profile label/value columns, moves mobile login form first, removes ordinary native-token login UI, and condenses narrow contextual settings navigation. Focused tests and later final served captures are tracked separately in the implementation ledger. This does not close complete native collaboration, CI-engine compatibility, protected merge or the two-track product goal.


### Local native squash and authority refresh increment (2026-10-04)

Frozen `d03feff` is deployed at schema065 with matched core/runner/agent images, verified backups and unchanged accounts/sessions/connections/history. Ordinary unprotected same-repository and explicitly bound private-fork squash now work, including fork `main` → upstream `main`. Requested merge/squash confirmation respects allowed native methods; optional commit text stays transient. Durable immutable methods preserve historical merge fingerprints and unknown outcomes remain original-key inspection only. Two actual supported-native/browser proofs pass source/PR/H/C/single-parent/target and custom text hashes, restart/replay, denials, eight combined theme/size captures and owned cleanup. Real database checks (35.083s) and 106 serial UI cases pass. Current private PR denial also remains latched through background updates until explicit reauthorization. Failed native-reader and parallel source-fixture attempts remain preserved in [implementation status](docs/IMPLEMENTATION_STATUS.md); [merge contract](docs/STANDARD_PULL_MERGE_UI_CONTRACT.md) scopes all receipts.

This advances ordinary repository/PR parity on the shared portable core. Rebase, atomic expected-base/protected integration/P0.8, full CI compatibility, release publication, executable protected previews/CD, enterprise role/identity acceptance, scale, Kubernetes/Cloudflare qualification and latest-schema coordinated recovery remain required. No incomplete Settings row or overall phase becomes Ready from these bounded results. Parallel next packets address authorized existing-tag release publication, Actions filter-preserving drilldown, visible Checks search and common layout density.
