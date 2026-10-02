# Technology Selection Guide adoption register

Reviewed: **2026-10-01**. This is the source review and implementation gap register for [plan task P0.2](../GOLF_IMPLEMENTATION_PLAN.md#phase-0--baseline-and-integration-proofs), not a certificate of guide compliance. The first executable Golf slice is substantially smaller than the guide baseline. **P0.2 remains open** until the pending decisions below have ADRs and every applicable requirement has an accepted disposition with an assigned task/check. Completing that planning gate does not require pretending later implementation phases have passed.

The guide is a technology baseline for Golf's shared core. It does not require the portable track to depend on Cloudflare, or require AI for core workflows. Cloudflare competition requirements apply only to the Cloudflare variant; see [competition readiness](COMPETITION_READINESS.md). No repository CI workflow is authorized. Where the guide prescribes CI gates, Golf must provide local checks now and defer automated execution until separately authorized.

## Source revision and review scope

The official navigation index and complete Markdown export were retrieved over ordinary HTTPS. The review read all 22 content blocks, including detailed prescriptions, examples, pitfalls, version tables, and ADRs—not only chapter summaries. Repeated requirements are consolidated in the rows below. The register covers every discovered prescriptive subsection; source section names identify the underlying detailed contract. It does not replace those source texts with a new, weaker specification.

| Artifact | Retrieval date | Bytes | SHA-256 of response body |
| --- | --- | ---: | --- |
| [Official navigation index](https://technology-selection-guide.aws.ablabs.io/llms.txt) | 2026-10-01 | 6,128 | `4afa05644682a3d2b01433af72dd8a2d356d3d03160462eb0473388dede23989` |
| [Complete source export](https://technology-selection-guide.aws.ablabs.io/llms-full.txt) | 2026-10-01 | 273,955 | `13ec22a5d0dfa4789b91e2e3101bed4d9e19982db444c8c66ad4173159e6ada0` |

The home and technical chapters identify their last review as 2026-05-08; the ADR overview is dated 2026-05-11. These are upstream review dates, not independent confirmation that every recommended release is current on October 1. The index names a source repository, but the retrieved export does not establish an immutable upstream commit. The content digest is this review's revision identifier. All 22 chapter/ADR URLs linked below returned HTTP 200 during this review. A future refresh must compare the new body and decision changes, retain the old digest, and requalify affected Golf tasks. Next routine review: **2027-01-01**, earlier for security advisories or a material upstream change.

Scope limits: the guide's linked external manuals, upstream source repository history/README/changelog, Pioneer donor implementation, and runtime-specific release forecasts were not comprehensively reviewed as part of this register. Their correctness is not implied. No production security assessment, air-gap trial, Kubernetes qualification, FIPS assessment, or complete implementation conformance test was performed for this document. The full upstream text is not republished here.

## How to read and execute the register

- **Adopt** means a target requirement, not completed code. The source's MUST/SHOULD/MAY force remains intact; a SHOULD departure also needs rationale.
- **Defer** names the task or trigger that makes a requirement applicable. It is not permission to ship the affected capability without its controls.
- **Deviation** means the guide and Golf differ. Only [Golf ADR-0001](decisions/0001-initial-forge-and-vertical-slice.md) is currently accepted; [ADR-0002](decisions/0002-effect-typescript-adapters.md) proposes a bounded Effect pilot, without adopting the dependency; other ADR references below are decision topics to write, not invented accepted records.
- **Not applicable** is limited to the named conditional subsystem or upstream publishing choice. If Golf later introduces that subsystem, reassess the row.
- `TG-xx.yy` identifiers are stable register IDs. `P*` identifiers refer to the [implementation tasks](../GOLF_IMPLEMENTATION_PLAN.md#16-implementation-phases-and-tasks). A check described here is an acceptance obligation unless the implementation evidence section explicitly says it ran.

Before closing a row, the implementer records the exact source revision, relevant code/ADR, command or review evidence, positive and negative cases, and remaining limitations in the implementation ledger. Security and protocol requirements must retain their detailed source conditions when translated into executable checks. A passing stack smoke test does not close unrelated rows.

## Home and introduction

Source: [Home](https://technology-selection-guide.aws.ablabs.io/) and [Introduction](https://technology-selection-guide.aws.ablabs.io/00-introduction/), including keyword definitions, audiences, document conventions, and review cadence.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-00.1 — Normative keywords and audience | Adopt the distinction between obligations, recommendations, and optional choices. Golf cannot relabel a source MUST as optional merely because the first slice is small. | P0.2: each departure has its original source and a reasoned ADR; reviewer checks applicable MUST and SHOULD clauses, including those outside TL;DRs. |
| TG-00.2 — Self-contained chapters, headings, examples, review dates | Adopt readable, dated technical contracts. Literal donor paths and the guide's one-H1 publishing format describe its documentation; do not create matching Golf packages merely to copy examples. | P0.1/P8.7: links and examples resolve in the intended Golf distribution; run documentation checks locally. |
| TG-00.3 — Version snapshots and guide forks | Adopt a revisioned baseline and quarterly review. Golf references the guide; it is not presently distributing a renamed guide fork. Fork-specific site URL/license replacement is not applicable. | P0.2: keep digest and refresh diff; preserve attribution/license obligations if source content is later republished. |

## Architecture

Source: [Architecture](https://technology-selection-guide.aws.ablabs.io/01-architecture/), covering layout, package boundaries, composition, the three-layer pattern, and conditional operator guidance.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-01.1 — `internal`, thin commands, explicit public packages | Adopt. The initial `cmd/golf` and `internal/server` layout follows the broad boundary; future generated APIs need an intentional versioned public contract. | P0.1/P1.1/P0.3: review imports and exported surface; an external Go consumer can use only the intended client packages. |
| TG-01.2 — Domain handler/service/store and local helpers | Adopt without creating empty layers. Current session SQL is still inline in the server package; this is not the final domain/storage boundary. | P1.1: move persistence behind the concrete session/identity store as it grows; SQL generation and handler boundary review pass. |
| TG-01.3 — One composition root; injected configuration and dependencies | Adopt. Environment reads are in `cmd/golf`; constructors receive configuration. `slog.SetDefault` is still global logger state and needs removal or a narrowly justified exception. | P1.1/P1.7: instantiate two independently configured servers in one process; configuration/logger state cannot cross instances. |
| TG-01.4 — Explicit initialization order and handwritten wiring | Adopt constructor wiring already used by the small service. Do not add a dependency-injection generator without a real benefit. | P1.1: initialization failure leaves no listeners or leaked pools; shutdown releases resources in the required order. |
| TG-01.5 — Operator stages, per-resource locking, enum conversion, leader election | Defer conditional guidance. Golf does not need a custom Kubernetes operator for its first Helm distribution. Crossplane/CAPI and operator framework choices are not dependencies today. | P1.5/P7.3: standard deployment/reconciliation first. Any later operator ADR must cover stages, ownership, locks, leadership and restart fencing before implementation. |

## Data

Source: [Data](https://technology-selection-guide.aws.ablabs.io/02-data/), covering engine/driver, generated queries, migration behavior, ciphertext schema, JSONB, soft deletion/tenancy, and notifications.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-02.1 — PostgreSQL and native pgx pool | Adopt target. Golf uses PostgreSQL and pgx's `database/sql` adapter today; the adapter is a real deviation from the guide's native-pool preference, not proof of complete pgx adoption. | P1.1: use native pgx for application stores; isolate any migration adapter. Otherwise approve an ADR covering instrumentation and transaction consequences. |
| TG-02.2 — sqlc annotated queries and checked-in generation | Adopt. SQLC now generates concrete session queries; local generation-drift checks and PostgreSQL transaction/scoping tests are implemented. | P1.1/P0.1: generate queries before builds, check a clean diff, and exercise generated methods against PostgreSQL; avoid a generic query builder. |
| TG-02.3 — Embedded goose, timestamp migrations, Up/Down, locking | Partially implemented: embedded goose and startup advisory locking exist. `00001_sessions.sql` is sequence-named, not the prescribed timestamp convention. Do not rename an applied migration casually. | P1.1/P8.5: decide the initial schema-version transition; test two starters, lock release on failure, failed migration blocking readiness, and supported rollback/recovery. |
| TG-02.4 — Ciphertext key/algorithm identity and rotation | Partially implemented: stored key labels, permanent material bindings and bounded drained re-encryption cover sessions/PKCE verifiers under [ADR 0005](decisions/0005-credential-keyring-and-drained-rotation.md). The algorithm remains the explicit AES-GCM implementation, without a per-record algorithm column; the broader age/envelope/assurance disposition stays open. | P1.3/P8.5: version stored ciphertext, read historic keys, resume rotation, reject tampering, and restore keys with the database. Migration must preserve existing sessions or explicitly revoke them. |
| TG-02.5 — JSONB schema, write validation, indexing | Defer until task/provider configuration is persisted. Golf must avoid accepting arbitrary opaque JSON as a substitute for a versioned job or deployment contract. | P0.3/P1.3/P7.1: invalid and stale schema versions fail predictably; chosen indexes match measured queries. Fixed fields remain typed columns. |
| TG-02.6 — Tenant scoping, soft deletion, foreign-key boundaries | Adopt for tenant-owned domain data. Bootstrap users/sessions have no organization model; physical session revocation is an intentional security lifecycle to document separately from durable resource deletion. | P1.2/P8.4/P8.11: cross-org reads, writes and references fail; deleted resources disappear from ordinary reads; explicit audit/retention jobs are reviewed exceptions. |
| TG-02.7 — LISTEN/NOTIFY as disposable wake-up signal | Defer optional transport until scheduling needs it. PostgreSQL jobs/outbox remain authoritative; a notification cannot be the only record of an agent task or deployment. | P1.3/P4.3: disconnect/reconnect loses no durable work; dedicate and close the listening connection; namespace and bound payloads. |

## Surface and contracts

Source: [Surface](https://technology-selection-guide.aws.ablabs.io/03-surface/), covering RPC/router, middleware, error mapping, pagination, authentication, enums, frontend providers, and both routing options.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-03.1 — Connect on chi; explicit REST routes | Adopt target. Chi hosts generated Connect services for existing operations; ADR-0002 retires the bootstrap application REST exception. Health handlers remain explicit HTTP. | P0.3/P1.1: generate server/browser clients and run shared contract tests; retain explicit health, Git and callback protocol handlers. |
| TG-03.2 — Ordered recovery, correlation, logging, authentication, authorization, validation | Adopt. Current recovery, deadlines, origin checks and bounded bodies cover only part of this chain. | P1.1/P1.2/P1.7: malformed input and denied requests retain correlation, emit safe logs, and cannot reach domain writes; propagate cancellation. |
| TG-03.3 — Central typed errors and safe unknown errors | Adopt. Existing operations now map closed domain errors to sanitized Connect codes. Wider domains remain future work. | P0.3/P1.1: domain failures map consistently across clients; unexpected upstream/SQL errors cannot expose tokens, SQL or internal addresses. |
| TG-03.4 — Bounded opaque cursor pagination | Adopt target. Repository listing currently uses bounded numeric upstream pages; preserve truthful Gitea limitations rather than promise snapshot semantics. | P1.1/P2.2: document opaque Golf cursor contents/version/limits; invalid cursor, concurrent updates and last-page behavior have contract tests. |
| TG-03.5 — Short access lifetime, refresh rotation, normalized principal | Deviation for bootstrap: opaque 12-hour server sessions, no JWT/refresh workflow. ADR-0001 permits bootstrap sign-in but does not settle the production session architecture. | P1.2/P1.8: identity/session ADR; refresh replay, revocation, issuer/audience checks where applicable, and human versus machine credential separation. |
| TG-03.6 — Browser cookies and native bearer clients | Adopt server-side browser credentials; current HttpOnly/Lax cookies and exact mutation origins are implemented. Production Secure-cookie handling and OAuth callback state/nonce/PKCE need full identity qualification. | P1.2/P1.8: localhost exception cannot enable insecure non-loopback deployments; test cookie/bearer precedence and CSRF negatives. |
| TG-03.7 — Proto enums and one database conversion boundary | Defer until generated domain contracts land; do not invent unvalidated string states independently in workers and the UI. | P0.3/P1.1: unknown wire values and unrecognized DB values fail safely; schema/API rollout order preserves supported clients. |
| TG-03.8 — React providers and a single routing system | Adopt React/typed clients; planned TanStack Router is a guide-supported alternative that still requires Golf's ADR. ADR-0002 records the implemented TanStack Router alternative and retires native history. | P1.4: record the typed-navigation tradeoff; verify loaders, pending/error states, authentication redirects and lazy route boundaries. Never install both router systems. |

## Infrastructure and tooling

Source: [Infrastructure and Tooling](https://technology-selection-guide.aws.ablabs.io/04-infra-tooling/), covering Air, Vite, Make, images, version derivation, development orchestration, local Kubernetes, and the linter pack.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-04.1 — Air per binary and predictable rebuild/stop behavior | Defer until improving the Go inner loop; Compose currently rebuilds. Avoid creating configs for nonexistent runner/worker binaries. | P0.1: watched extensions/exclusions, debounce, failed-build handling, environment and graceful replacement work for actual commands. |
| TG-04.2 — Vite proxy/HMR and build metadata | Partially adopt. Relative API/health proxies exist; version metadata and WebSocket proxy are absent. Keep development listening on loopback by default rather than blindly copying a wildcard host. | P0.1/P1.4: deliberate container-host override, working HMR and future log-stream proxy, reproducible version/commit/date injection. |
| TG-04.3 — Make as the reproducible command interface | Adopt target. Current targets cover a subset; generate/lint/migrate and complete check dependencies remain missing. | P0.1: fresh checkout has one documented local command sequence; format check does not rewrite files; generation happens before dependent builds. |
| TG-04.4 — Multi-stage, pinned, minimal non-root runtime images | Partial: multi-stage and non-root exist. Alpine runtime retains a shell/package manager; tag pins are not digest pins; production labels are absent. This is a development image, not qualified production hardening. | P1.5/P8.6: immutable minimal API/web image, numeric UID, CA trust, required health probes and OCI metadata; do not apply toolchain-free runtime rules to build-runner images. |
| TG-04.5 — Derive Go version from the module | Adopt target. Dockerfile currently repeats the Go version as a literal; matching today does not prevent drift. | P0.1/P1.5: build argument or generated build invocation has one authoritative version and a local mismatch check. |
| TG-04.6 — Dev orchestration, safe defaults, lifecycle and logs | Proposed deviation: retain Compose as the process supervisor instead of a duplicate PID/nohup manager. Add missing status/log/migration conveniences only where they improve the actual workflow. | P0.1/P1.5: document tracked defaults versus ignored secrets, prerequisites, teardown and log retention; repeated up/down leaves persistent data intact. ADR required for omitted literal script interface. |
| TG-04.7 — Local Kubernetes environment | Defer to P1.5 qualification. Choose one tested k3s/k3d workflow. Reject automatic world-readable kubeconfig and unsolicited node uncordoning: neither is necessary for Golf compatibility. | P1.5: explicit selected context, least-privilege credentials and fresh-cluster install; no unrelated cluster mutation. Document the safer deviation. |
| TG-04.8 — golangci-lint v2 STANDARD pack | Adopt target; not yet configured. Carry the actual pack's settings, exclusions, local import prefix and read-only module behavior into a versioned config rather than merely installing the binary. | P0.1/P8.4: local lint/vet/format/security checks pass; exceptions are narrow and justified. |
| TG-04.9 — Automated build/test gates | Defer CI execution because the user explicitly requested no CI. Local equivalents remain required; this does not disable Golf's future pipeline-execution product. | P0.1/P8.1: documented commands and evidence now; no `.github/workflows` or equivalent pipeline added as a side effect. |

## Observability

Source: [Observability](https://technology-selection-guide.aws.ablabs.io/05-observability/), including logging, OTel initialization, Prometheus, pgx tracing, optional Loki push, the dev stack, and private metrics.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-05.1 — zerolog structure and correlation | Adopt target. The injected zerolog runtime now correlates HTTP request completion with recording traces. Job correlation remains open; see [ADR-0006](decisions/0006-private-observability-runtime.md). | P1.7: API→DB→job identifiers link evidence; bound incoming IDs, redact credentials, keep CLI stdout machine-readable, and avoid double JSON encoding. |
| TG-05.2 — OTel resources, exporters, sampling and shutdown | Shared-core OTLP/HTTP resources, explicit sampling and bounded shutdown are implemented; common runner/Workers identity and job propagation remain open. | P1.7/P6.6: trace context survives the job handoff; partial init failure cleans up; disabled export is safe; shutdown flushes within a deadline. |
| TG-05.3 — Private Prometheus endpoint and bounded series | Shared-core private bearer-authenticated listener and bounded-label registry implemented; wider long-running services remain open. | P1.7/P8.3: scrape on an authorized private path, refuse public unauthenticated exposure, and prove tenant/repository/request IDs do not create unbounded labels. |
| TG-05.4 — Composite native pgx instrumentation | Actual database/sql pgx query callbacks now record both metrics and spans; no SQL/arguments/DSN attributes. This is one composite query tracer, not a general future callback fan-out framework. | P1.1/P1.7: query metrics and spans both appear, supported callbacks fan out, and sensitive bind values stay out of telemetry. |
| TG-05.5 — Log shipping and bounded direct push | Prefer collecting stderr through the installation's collector. Optional direct Loki transport requires an operational need; never enable both paths for the same stream. | P1.7: collector outage cannot block Git/API work; any buffer has time/size limits and visible drops. |
| TG-05.6 — Four-service observability dev environment | Accepted scoped deviation under [ADR-0006](decisions/0006-private-observability-runtime.md): optional Grafana/Prometheus/Jaeger overlay. The original full Tempo/Loki environment and centralized log storage/search remain unmet; minimal installations retain three services. | P1.7: version-controlled dashboards/provisioning and an opt-in smoke check; disabled observability export never disables core workflows. |

## Security

Source: [Security](https://technology-selection-guide.aws.ablabs.io/06-security/), including the threat-model baseline, encryption, rotation, tokens, RBAC, scanners, secret history, assurance builds and dependency maintenance.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-06.1 — Threat model and application-security baseline | Adopt. A secure bootstrap cookie test is not an assessment of tenant, Git, untrusted runner, preview or deployment boundaries. | P8.4/P0.2: maintain a dated threat model and risk/control mapping; review at least quarterly and after boundary changes; explicitly track ASVS-level gaps. |
| TG-06.2 — age default and external key custody | Accepted narrow deviation: AES-256-GCM bootstrap under Golf ADR-0001, extended by ADR-0005 for labeled credentials and drained rotation. Keep key reads in composition and inject crypto dependencies; do not follow examples that would move environment reads into stores. | P1.3: crypto ADR resolves long-term format/KMS support; verify nonce uniqueness, authentication failure and no plaintext credentials in browser, logs or database. |
| TG-06.3 — Historic-key reads and resumable rotation | Bounded implementation qualified: historic-label reads, interrupted/busy-row resume and both-table zero-use retirement are recorded in the [keyring contract](CREDENTIAL_KEYRING.md). Activation requires draining old issuers; retirement erases no secret. Production cutover, live OAuth across activation, envelope keys and fresh-backup restore remain open. | P1.3/P8.5: mixed-key rows remain readable during restartable rotation; old-key retirement waits for verified zero use; production key changes are audited. |
| TG-06.4 — JWT validation, rotating refresh and request credential rules | Adopt the production identity controls where JWT is selected; the exact architecture remains to be settled alongside opaque sessions. | P1.2/P1.8: algorithm allowlist, claims validation, revocation/replay tests, and documented bearer/cookie priority. No browser-storage access/refresh tokens. |
| TG-06.5 — Central authorization, tenant principal and denial audit | Adopt for all entry points, not only Connect. Gitea token scoping is an upstream limit, not Golf organization authorization. | P1.2/P2.1/P8.4: shared permission matrix covers API, Git, SSH, MCP, jobs and deployment; each denied sensitive action is attributable without exposing credentials. |
| TG-06.6 — Vulnerability, static and secret-history checks | Adopt local gosec/govulncheck and history-aware secret scanning; no CI automation yet. Track severity, triage time and reviewed suppressions. | P0.1/P8.4: scan the shipping toolchain/dependencies and full intended history; an injected test secret/high-severity fixture is detected; remediation includes credential rotation where necessary. |
| TG-06.7 — FIPS build prescription | Defer assurance distribution to P9.2. Do not copy an old Microsoft-Go/BoringCrypto recipe and claim FIPS compliance from a tag or endpoint. Golf's plan requires a qualified crypto boundary and environment evidence. | P9.2 and plan §14.6: choose current validated components via a dedicated ADR and evidence review; ordinary AES bootstrap and standard builds make no assurance claim. |
| TG-06.8 — Dependency updates and response windows | Adopt an explicit maintenance policy. Guide snapshot pins do not justify stale vulnerable dependencies; automated repository update jobs remain unconfigured pending authorization. | P0.1/P8.4: record runtime/dependency inventory, security patch process and compatibility results; exceptions have owners and expiry. |

## Testing

Source: [Testing](https://technology-selection-guide.aws.ablabs.io/07-testing/), covering table cases, actual databases, boundary fakes, browser runs, JUnit output, and build separation.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-07.1 — Table cases, subtests, safe parallelism and cleanup | Partially adopted. Existing Go cases cover several credential and request boundaries; parallelism is not a blanket setting when tests share mutable state. | P1.1/P8.1: negative boundary cases remain meaningful, per-test resources are cleaned, and race-enabled uncached runs pass. |
| TG-07.2 — testcontainers plus pgtestdb and matching PostgreSQL | Target adoption pending. Current integration tests use a real configured PostgreSQL database and isolated schema, not the prescribed testcontainers/template-clone harness. | P1.1/P8.1: migrate test setup or record an equivalent isolation ADR; use production migrations and a qualified matching server version; prove concurrent-test isolation. |
| TG-07.3 — No database mocks; deliberate provider boundaries | Adopt. Current tests use actual SQL with an HTTP Gitea fake, and a separate real Compose smoke. Neither fixture API behavior nor a mocked browser response proves provider compatibility. | P0.8/P8.1: preserve both fast boundary checks and actual pinned-Gitea contract tests; introduce controlled real-account tests for cloud integrations. |
| TG-07.4 — Playwright configuration, authentication and failure evidence | Partially adopted. Existing browser tests use API fixtures; they are UI contracts, separate from the recorded actual-stack browser smoke. | P1.4/P8.1: configurable test target, isolated authenticated state, deliberate worker parallelism, no failure-hiding retries, and retained failure artifacts for actual-stack journeys. |
| TG-07.5 — gotestsum/JUnit, race and uncached execution | Adopt target for repeatable local evidence; gotestsum/JUnit is absent. `make test` lacks race/count flags while integration target includes them. | P0.1/P8.1: local acceptance command produces machine-readable results and runs the intended suite uncached with race checks where supported. |
| TG-07.6 — Integration build tags and Docker-free unit tests | Target adoption pending. Today environment gating skips DB tests when unconfigured; there is no integration build-tag split. | P0.1/P1.1: fast suite does not require Docker; explicit integration command cannot report success after silently skipping its database coverage. |

## Engineering discipline

Source: [Discipline](https://technology-selection-guide.aws.ablabs.io/08-discipline/), covering its seven project principles, language/style references, and excluded donor agent directories.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-08.1 — Correctness, modularity and contract source of truth | Adopt. Golf's capability states must reflect actual readiness; unused abstractions and placeholder provider success conflict with this requirement. | P0.3/P8.11: each advertised operation has authoritative ownership and an evidence-backed contract; duplicate enum/state definitions are eliminated. |
| TG-08.2 — Disconnected operation and real-backend tests | Adopt for the portable core; external-provider features visibly unavailable offline are a necessary documented exception, not a simulated fallback. | P1.5/P8.1/P8.6: core journeys work with egress denied and no AI/Cloudflare account; provider-specific negative states are testable. |
| TG-08.3 — Root-cause fixes and controlled preproduction cutovers | Adopt clean initial contracts while preserving data users have actually entrusted to Golf. “Preproduction” is not permission to destroy persistent sessions/repositories without a migration decision. | P8.5: a change identifies all callers and stored data; flaky behavior gets a cause and regression case rather than an unexplained retry. |
| TG-08.4 — Style, configuration and explicit guidance | Adopt a reviewable Go/TypeScript style and twelve-factor configuration where compatible with durable forge state. Resolve competing style rules in a small local convention. | P0.1: `AGENTS.md`, formatting and review checks agree; credentials remain external to source. |
| TG-08.5 — Donor agent-runner exclusion | Not a ban on agent tooling. The source excludes its donor's private `.claude` procedures from the guide; Golf still needs Claude Code, Codex, OpenCode, Grok and Pi adapters. | P0.7/P5.3/P5.9: runtime-neutral repository instructions and harness-specific adapters have explicit provenance and permissions. |

## Air-gap and portable distribution

Source: [Air-gap](https://technology-selection-guide.aws.ablabs.io/09-airgap/), including offline initialization, registry bundles, signatures, object storage, discovery, resolver order and cluster-local integration.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-09.1 — Egress-denied core and endpoint inventory | Adopt for portable installations. Current Compose pulls external images and is not an offline distribution. Offline enterprise entitlements must not require a phone-home service. | P1.5/P8.6/P9.2: redacted startup endpoint inventory and denied-egress first boot; Git/collaboration/local execution continue with optional external providers disabled. |
| TG-09.2 — Local OCI registry, every supporting image, architectures | Adopt signed-bundle delivery. Any limited architecture release needs a stated deviation from the guide's multiarchitecture prescription; no arm64 claim based on amd64-only testing. | P8.6: include sidecars/init/runner images, persistent registry data and matching manifests; install separately on each advertised architecture without public pulls. |
| TG-09.3 — Signed manifest/bundle verification before extraction | Adopt. Trust roots must arrive through the operator's trusted channel; a bundle cannot appoint its own trusted signer. | P8.6: offline integrity/signature checks reject tampering, untrusted keys and invalid validity policy before extraction/loading; optional cosign path is qualified independently. |
| TG-09.4 — Local S3 and reachable object URLs | Proposed deviation: filesystem storage for the minimal profile, S3-compatible service for scalable profiles. Internal and browser/runner-facing endpoints must remain distinct where needed. | P1.6/P8.6: ADR plus the same object contract suite; signed downloads work from actual clients, private data remains private, and restart/retry behavior is safe. |
| TG-09.5 — Kubernetes API discovery | Proposed deviation: explicit service URLs/cluster DNS by default. Compose cannot require Kubernetes API discovery, and Golf should not need extra API privileges merely to locate configured PostgreSQL. | P1.5: endpoint override and stale/unready endpoint failure tests; if discovery is introduced, add bounded cache/backoff, named-port resolution and least-privilege permissions. |
| TG-09.6 — Layered registry resolution without public fallback | Adopt. A missing local action/runner image must produce a useful blocked state; silently reaching Docker Hub would invalidate a disconnected installation. | P4.4/P8.6: local→explicit configured fallback→failure; audit selected source and reject unsigned/disallowed artifacts before execution. |
| TG-09.7 — Local cluster control plane and optional APIs | Conditional. Kubernetes deployments use scoped in-cluster credentials; plain Compose must remain independent. Crossplane or optional CRDs are not universal installation prerequisites. | P1.5/P4.5/P7.10: absence of optional APIs is explicit, ordinary health/readiness does not require cluster-admin rights, and disabled integrations do not prevent startup. |

## TypeScript and browser stack

Source: [TypeScript](https://technology-selection-guide.aws.ablabs.io/10-typescript/), covering React, Vite, styles, both routing paths, data, forms, icons, Node and frontend tooling.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-10.1 — React function components, strict types and build checks | Adopt; React, strict TypeScript and typecheck-before-build exist. Current selected package versions are recorded in lockfiles, not copied from the guide's May table. | P1.4/P0.1: actual clean-install build and browser checks qualify changes; use explicit component/export conventions. |
| TG-10.2 — Vite aliases, proxies, metadata and static output | Partially adopted. Alias and metadata features should be added only with consistent TS/Vite configuration; the app is a static SPA served by Golf. | P0.1/P1.4: deep links and API paths work in dev and deployed builds; test future WebSocket paths when introduced. |
| TG-10.3 — Tailwind, accessible Radix/shadcn primitives and class merging | Adopt target; current UI uses Tailwind/native controls, not the complete component foundation. Do not add empty component wrappers simply to claim adoption. | P1.4: implement actual complex controls with keyboard/focus coverage; black/charcoal and light tokens remain consistent. Qualify Tailwind v4 configuration rather than blindly copying an older config filename. |
| TG-10.4 — Router choice, authentication loaders, route boundaries | Planned deviation via the guide's explicit alternative: TanStack Router, justified by typed Golf navigation. ADR-0002 implements typed TanStack routes/search with deep-link/auth/cache checks. Ignore unverified predictions about future React Router releases. | P1.4/P0.2: ADR compares maintenance/onboarding cost with type safety; protected content never flashes before authorization and route failures are recoverable. |
| TG-10.5 — Query cache and generated Connect transport | Adopted for existing operations: TanStack Query plus generated Connect-Web transport, cancellation and authentication cache clearing. | P1.1/P1.4: cache keys separate principals/tenants; mutations invalidate the right data; sign-out clears private state; any refresh deduplication is concurrency-tested. |
| TG-10.6 — Runtime schemas and form state | Planned deviation: TanStack Form instead of react-hook-form; Zod remains the runtime-validation target. Neither is implemented in the bootstrap form. | P1.4/P0.2: ADR explains substitution; nested/server errors, pending submission and invalid inputs work without duplicating incompatible domain rules. |
| TG-10.7 — Icon and module imports | Adopt selective Lucide imports; qualify the installed major rather than downgrading merely to match the snapshot. | P1.4: accessible labels for icon-only controls and inspected production bundle; no entire icon-set payload. |
| TG-10.8 — Node versions, package manager and local quality loop | Adopt Node 24 LTS default and lockfile installs. Docker builder is Node 24; repository-wide developer runtime pin and full frontend lint/unit setup still need review. npm is allowed; pnpm is a recommendation, not a reason to churn a working lockfile. | P0.1/P1.4: one runtime policy covers local/container builds; add Vitest tests when behavior warrants unit coverage, while preserving meaningful Playwright journeys. |
| TG-10.9 — Server-side TypeScript and SSR boundaries | Go remains the primary Golf backend. TypeScript Workers adapters require a language ADR; independent Astro marketing/Docusaurus documentation do not silently turn the authenticated application into an SSR product. | P0.2/P6.2 and plan §24: publish runtime/boundary decisions per artifact; packaging and security checks cover each actual runtime. |
| TG-10.10 — Temporary token-storage allowance | Reject the chapter's temporary localStorage token exception because it conflicts with the security chapter and Golf's existing cookie boundary. | P1.2/P1.4: browser storage contains theme/preferences only, never provider/access/refresh secrets; reload and sign-out tests preserve that boundary. |

## Multi-language policy

Source: [Multi-Language Considerations](https://technology-selection-guide.aws.ablabs.io/11-multi-language/), including its decision tree, Python/Bash/YAML terminals, exception ADRs and shared operational requirements.

| ID / source area | Golf disposition and reason | Task and acceptance |
| --- | --- | --- |
| TG-11.1 — Go default; explicit language decision | Adopt Go core and browser TypeScript. Cloudflare-only TypeScript services are selective adapters, not a second implementation of identity/domain policy. | P0.2/P6.2: ADR names driver, alternatives, boundary and sustainable ownership for each added runtime. |
| TG-11.2 — Python data/scripts toolchain | Current stdlib `scripts/smoke.py` is bounded test orchestration, not a Python runtime service. Proposed narrow deviation: do not install an entire Python dependency/test toolchain for a dependency-free script. | P0.1/P8.1: document the supported interpreter and exercise the script; if Python dependencies or services appear, introduce locked environments, lint/type/test checks and ownership. |
| TG-11.3 — Short strict Bash and safe command behavior | Adopt for initialization glue. Keep complex or stateful logic in an actual language; do not expand setup scripts into another process supervisor. | P0.1: shellcheck, quoting/error handling and repeated invocation checks; help/dry-run behavior for future destructive operator tools. |
| TG-11.4 — Helm/YAML and avoiding duplicated deployments | Adopt a qualified Helm distribution with values/schema and pinned images. Guide Helm/Crossplane versions need current qualification; optional controllers are not prerequisites for Golf. | P1.5: lint/render and actual-cluster validation; changes flow through templates rather than copied per-environment manifest trees. |
| TG-11.5 — Pins, lockfiles, SBOMs and trusted supply chain | Adopt across every shipped artifact, including runners and Workers adapters. Exact lock resolution is not sufficient if runtime images remain mutable tags. | P0.1/P8.6: inventory, scan, sign and verify all relevant components; security fixes can override a routine refresh cadence with recorded qualification. |
| TG-11.6 — Consistent runtime, telemetry and test quality | Adopt shared correlation and contracts, with language-specific tooling only where a real component exists. | P1.7/P6.6/P8.1: trace context survives cross-language calls and error/permission semantics agree; no runtime is omitted from release evidence. |
| TG-11.7 — Consolidate or delete when complexity exceeds benefit | Adopt as an ongoing review rule. Golf should avoid adding speculative operators, helper daemons or generalized provider frameworks before the task requires them. | P0.2/P8.7: new language/component ADR includes ownership and removal/consolidation alternatives; unused tools are removed rather than indefinitely maintained. |

## Upstream ADR coverage

These are the guide's ADR numbers, distinct from Golf ADR-0001. All were read. They explain the guide's decisions; they are not automatically accepted Golf decisions.

| Source | Golf disposition | Task/check |
| --- | --- | --- |
| [ADR overview](https://technology-selection-guide.aws.ablabs.io/decisions/) and [template](https://technology-selection-guide.aws.ablabs.io/decisions/0000-template/) | Adopt dated status, context, drivers, alternatives, consequences and supersession links. | P0.2: pending exceptions below become reviewable Golf ADRs; do not rewrite the historical reasoning of superseded decisions. |
| [0001 — Hybrid documentation](https://technology-selection-guide.aws.ablabs.io/decisions/0001-hybrid-doc-structure/) | Adopt living product contracts plus durable decision history. | P0.2/P8.7: current docs link the active decision; historical records remain discoverable. |
| [0002 — MkDocs Material](https://technology-selection-guide.aws.ablabs.io/decisions/0002-mkdocs-material/) | Not a runtime mandate. Golf has selected separate Astro marketing and Docusaurus/MDX documentation repositories; forcing MkDocs would discard those product-specific choices. | Plan §24/P8.7: retain independent docs-framework rationale, version navigation and accessible searchable output. |
| [0003 — RFC 2119](https://technology-selection-guide.aws.ablabs.io/decisions/0003-rfc-2119-tone/) | Adopt precise normative technical contracts. Human-facing marketing prose need not be rewritten as standards language. | P0.2: requirements preserve force; explanatory text and acceptance evidence are distinguishable. |
| [0004 — Human-reviewed version snapshots](https://technology-selection-guide.aws.ablabs.io/decisions/0004-version-snapshot-no-automation/) | Adopt dated guide review. Its ban on guide-repository version automation does not prohibit a future approved Golf dependency-update process. | P0.1/P0.2: compare source revision and qualify actual product versions; honor the user's independent no-CI instruction. |
| [0005 — Excluded donor agent directories](https://technology-selection-guide.aws.ablabs.io/decisions/0005-no-claude-subdir-content/) | Limit applies to donor material, not Golf's agent support. | P5.3/P5.9: do not import unrelated private runner policy; support the five requested harnesses deliberately. |
| [0006 — React Router canonical, TanStack alternative](https://technology-selection-guide.aws.ablabs.io/decisions/0006-react-router-v7-canonical/) | Planned TanStack selection must use its allowed exception with Golf-specific rationale. | P0.2/P1.4: one router; compare the guide's onboarding argument with Golf's typed-navigation need. |
| [0007 — Agent-readable documentation](https://technology-selection-guide.aws.ablabs.io/decisions/0007-llms-txt-inclusion/) | Adopt generated public documentation discovery and full-text export where appropriate. This is useful to deterministic agents as well as AI clients. | Plan §24/P8.7: generate from published/versioned navigation, local drift/link checks, exclude secrets and unpublished implementation claims; preserve attribution for reused material. |

## Conflicts and decisions still needed

| Decision topic | Resolution required before the affected milestone |
| --- | --- |
| Accepted first-slice exceptions | Golf ADR-0001 covers Gitea bootstrap identity and AES-GCM; ADR-0003 adds scoped Gitea OAuth/PKCE and encrypted serialized refresh, with local/external OIDC and organization policy still pending; ADR-0002 retires its temporary REST/native-history exceptions with generated contracts and typed routes. It does **not** approve every missing guide requirement listed here. Preserve its limited scope. |
| Data and layering | Native pgx, wider schema version transition, session retention versus soft deletion, tenant constraints and ciphertext metadata need P1.1–P1.3 implementation or explicit exceptions. |
| Identity and cookie policy | Resolve short access/rotating refresh versus server sessions; choose the production lifecycle. The surface chapter's Lax cookie guidance and security chapter's stricter recommendation differ. Golf's OAuth/OIDC flows need a documented Lax policy with state/nonce/PKCE and mutation protections. |
| Frontend substitutions | TanStack Router tradeoff/versions are recorded in ADR-0002; Form and wider runtime validation remain pending. The guide's React Router release forecast is not evidence that the forecast occurred. |
| Development/runtime tooling | Decide minimal production base image, version derivation, Compose as supervisor, local lint/reporting and PostgreSQL test harness. The initial convenient setup is not the production exception record. |
| Observability | Record zerolog versus existing slog and optional local stack; satisfy metrics/correlation requirements regardless of exporter choice. |
| Portable/offline profiles | Record filesystem versus S3, explicit URLs/DNS versus API discovery, supported architecture bundles and external features unavailable offline. A disconnected installation may not silently fall back to a public service. |
| TypeScript/Python boundaries | Record selective Workers runtime exception and the small dependency-free Python smoke script; avoid treating either as permission for an unrelated second backend. |
| Source inconsistencies | Data makes ciphertext metadata stronger than Security's column-shape wording: use the stronger rotation-ready target. Architecture keeps environment reads in composition despite encryption examples. Security wins over temporary browser token storage. Node chapter's maintained-LTS policy wins over an older non-LTS tooling snapshot, subject to actual release qualification. |
| Assurance and local-cluster safety | Reject a build-tag-only FIPS claim and broad kubeconfig permission changes. These decisions need explicit current evidence or safer local alternatives, not literal recipe copying. |
| CI | User instruction controls: no repository pipeline now. Keep required checks executable locally and distinguish absent automation from absent verification. |

## Initial implementation evidence and next sequence

This source review inspected `cmd/golf`, `internal/server`, embedded migrations, `go.mod`, `Makefile`, `Dockerfile`, `compose.yaml`, frontend package/config files, the existing ADR and [implementation ledger](IMPLEMENTATION_STATUS.md). It did not rerun all tests merely to write this document. The ledger is the dated record of actual commands and outcomes.

| Observed in the initial slice | Limit of the evidence |
| --- | --- |
| Go/chi API, PostgreSQL via pgx stdlib, embedded goose, explicit configuration, Gitea API boundary | SQLC/Connect/generated contracts now exist for current operations; native pgx, tenant model and wider domain layering remain open. |
| Opaque hashed sessions, encrypted upstream token, HttpOnly cookie, exact origin checking and upstream permission enforcement | Bootstrap token login is not OAuth/OIDC, rotating identity, organization authorization, key rotation or enterprise assurance. |
| React/strict TypeScript/Vite/Tailwind/Query/Lucide, black/charcoal and light UI | Router/Connect-Web now implemented and qualified for existing operations; Form/Zod/Radix remain open. UI fixture tests prove only their stated UI contracts. |
| Local Make checks, actual PostgreSQL integration tests, actual Compose Gitea smoke and browser evidence recorded in the ledger | No repository CI, Kubernetes proof, offline bundle proof, complete provider corpus, security assessment or full guide gate. |
| Compose uses separate Golf/Gitea PostgreSQL roles; pinned version tags include PostgreSQL 18.4 and Gitea 1.27.3 | Tags are not image digest pins; this is not a claim that those are latest releases or fully supported under every target environment. |

Execute next in this order:

1. **P0.2:** approve the bounded ADR topics, prioritizing identity, data, frontend and portable-profile decisions. Record owners and milestone deadlines; leave deferred capabilities explicitly unavailable.
2. **P0.1/P1.1:** complete local command/toolchain reproducibility, production image boundaries, native data/query contracts, migration transition and generated API surface. Preserve the actual Gitea authorization regression corpus while changing plumbing.
3. **P1.2/P1.3:** implement real account/organization permissions and a versioned credential/session lifecycle before adding agent, runner or deployment authority.
4. **P1.4/P1.7:** complete the routed accessible interface and private observability; verify failures and cancellation, not only successful requests.
5. **P1.5/P1.6/P8.6:** qualify Kubernetes, restore and offline distributions independently of the Cloudflare showcase; then expand provider/harness acceptance in their own phases.

The P0.2 planning gate requires accepted dispositions, necessary ADRs and traceable task/check coverage. Implementation conformance is earned later by attaching the corresponding evidence, row by row. Product completion still requires the full [release gates](../GOLF_IMPLEMENTATION_PLAN.md#17-verification-and-release-gates), including real provider behavior, recovery, tenant isolation and AI-disabled portable workflows.
