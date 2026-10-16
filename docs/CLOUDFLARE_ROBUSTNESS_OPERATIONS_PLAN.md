# Golf Cloudflare robustness, performance and operations implementation plan

Date: 2026-10-09. Owner: Golf engineering. Status: implementation in progress.

This is the execution plan for the user's request for a robust, fast Cloudflare-native Golf and an administrator operations dashboard across local, Docker, Kubernetes and Cloudflare deployments. It extends, rather than supersedes, CLOUDFLARE_BUILD_PLAN.md, CLOUDFLARE_NATIVE_SETUP.md, the compatibility goals in ACTIONS_COMPATIBILITY_IMPLEMENTATION.md and the generated CLOUDFLARE_CAPABILITY_INVENTORY.md. IMPLEMENTATION_STATUS.md remains the evidence ledger. A checklist is not deployment evidence.

The [2026-10-10 speed qualification](CLOUDFLARE_SPEED_QUALIFICATION.md) records the cache architecture, request/paint profiling method, deployed indexing and UI fixes, five-repository measurements, explicit large-diff failures and remaining performance/feature gates. Ordinary file/folder reads passed at median/p95 183/274 ms; six oversized diff failures remain part of the 108-request result. This evidence does not close global scale or complete native parity.

## 1. Product decisions and scope

- Managed SaaS targets Cloudflare-native hosting. The portable Forgejo/PostgreSQL installation is the migration bridge and remains an independent supported self-hosted path.
- Organizations/workspaces own projects, members, allocations and budgets. A personal user receives a personal workspace.
- Golf-managed app resources come first; customer-owned Cloudflare accounts follow the same explicit provisioning and retirement contracts.
- Artifacts is canonical Git for eligible native repositories. Oversized repositories stay on the bridge until an independently qualified large-repository path exists. Do not silently truncate imports.
- Deliver the complete collaboration loop: source, issues, PRs, reviews, checks, concurrent agents, protected previews and protected merge. An attractive shared UI does not substitute for backend compatibility.
- Repository readers may open private previews. Revoke access immediately when their current repository permission changes. Access is an outer identity gate; Golf remains the authorization authority.
- Approved preview policies permit automatic deployment on eligible pushes. Production retains its separate approvals.
- The approved test envelope is $10/day, including AI, as a planning constraint. It is not a Cloudflare billing cap. Previously owned demo resources are stopped and removed; this plan does not reopen an unbounded demo.
- Use the shared frontend, fonts, styles, tables and forms in all profiles. Show runtime-specific controls honestly. Do not advertise a configured binding as healthy or a model as a separate infrastructure product.
- Golf Apps is the extension direction: external connections and unique tools, including scheduled improvement agents and review bots. App identity, scoped installation grants, quotas and revocation precede arbitrary execution.

## 2. Baseline and known gaps

The source baseline contains Workers, Artifacts, D1, R2, Durable Objects, Queues, Workflows, Containers/Sandbox, Workers AI, AI Gateway, Access, DNS/custom domains, secrets and Workers for Platforms consumers. Browser Run snapshots and Analytics Engine writes have narrower acceptance. Clef is a Workers AI model consumer. General Workers Builds, native transactional email, AI Search/Vectorize, optional Hyperdrive/Postgres, customer hostname lifecycle and monetization are not completed integrations.

Portable monitoring already exists: JSON logs, Prometheus counters/histograms, OpenTelemetry traces, health/readiness endpoints and an optional Docker Grafana/Prometheus/Jaeger overlay. Kubernetes exposes protected metrics and allows an external collector but does not install Grafana or an operator. Native settings currently show allocation/policy inventories and per-PR evidence; there is no complete shared operational dashboard.

The last bounded exact-root/overview benchmark across eight repositories measured warm p95 322 ms and cold p95 2152 ms, with one authenticated workspace and concurrency four. This is not a global or arbitrary-file SLO. The pre-plan shared contract inventory has 296 procedures, 44 bounded native adapters and 252 missing adapters. Do not convert that count into a percentage of complete product behavior.

## 3. Completion and evidence rules

Each deliverable advances through DESIGN, IMPLEMENTED, SOURCE-VERIFIED, LOCAL-RUNTIME-VERIFIED, HOSTED-VERIFIED and OPERATIONS-QUALIFIED. Record the exact command, source/release identity, schema, tenant scope, resource ownership and cleanup result. Missing metrics remain unknown; a successful empty response must not become a zero-failure claim.

A deployment is robust only after failure injection and restoration, not merely a passing build. Performance acceptance requires both cold and warm measurements and permission-revocation tests. Optional services must fail independently without blocking ordinary repository browsing. Never use cached/replicated identity data to broaden current authorization. No direct Forgejo database/repository writes are authorized.

## 4. Ordered work packages

| Package | Concrete deliverable | Dependencies | Completion gate |
| --- | --- | --- | --- |
| O1 | Shared admin Operations RPC and UI | Existing sessions, telemetry, shared components | Current-admin authorization, redaction, unknown/zero handling, portable and native build/tests |
| O2 | Native administration and maintenance evidence | O1, additive D1 migration | Explicit native role; no repository-creator elevation; revocation during reads withheld |
| O3 | Provider telemetry and usage collection | O1/O2, approved scoped credential | Bounded background snapshots, source timestamps, partial failures, hosted provider qualification |
| R1 | Hosted maintenance/recovery | O2, existing journals and cron | Per-stage outcomes, continued cleanup after failures, bounded retries, no second effects |
| R2 | Full allocation lifecycle and orphan cleanup | R1, ownership ledger | Resumable teardown and safe refusal on changed provider identity |
| P1 | Cold-read and source-navigation optimization | Existing immutable indexes | Benchmarked cold/warm paths and unchanged permission checks |
| P2 | Multi-tenant regional load and capacity | O3/P1 | Repeatable latency/error/cost evidence under contention and revocation |
| D1 | Guarded releases and rollback qualification | Existing release operator | Canary, Worker/DO/schema compatibility, actual rollback proof |
| D2 | Quarantined restore and disaster recovery | D1, ownership and backups | Actual D1/Artifacts/R2 restore, authorization and credential quarantine |
| F1 | Complete native collaboration and forge parity | O2, protected mutation contracts | Method-by-method consumer, tests and hosted proof |
| I1 | Email notifications | Native event/outbox authority | Verified sender, bounded durable delivery and suppression |
| I2 | Repository search/retrieval | F1, immutable indexing | Permission-aware indexing/querying and deletion/revocation |
| I3 | SaaS abuse controls | O3, exact protocol inventory | Limits and abuse tests for browser/RPC/Git/preview traffic |
| A1 | Golf Apps, scheduled bots and installation grants | F1/R1/I1 | Scoped installation, idempotent work and human-review PR delivery |
| S1 | Customer accounts/domains/optional SQL | R2/D2 | Independent account setup and migration acceptance |

## 5. O1: shared administrator Operations dashboard

User clarification: the Cloudflare dashboard is an integrated Golf page showing overall metrics, connected services and their status. Do not deploy Grafana, Prometheus or a collector stack into Cloudflare. The optional Docker Grafana overlay remains independent; native data comes from Golf journals and Cloudflare APIs.

### Contract

Add a generated OperationsService/GetOperationsDashboard RPC, using the same Connect transport as the rest of Golf. Responses contain runtime profile, scope, generated timestamp, release, service observations, metrics and explicit notices. No arbitrary URL, SQL or provider resource query is accepted from the browser.

Service observations have fixed IDs, label, state, data source, last-check time and a sanitized detail. States distinguish available, configured, disabled, degraded, unknown and unavailable. The exact vocabulary is enforced in tests. A configured provider binding is not a successful health probe. A provider status-page outage and a Golf allocation outage are separate facts.

Metrics have fixed IDs, label, optional numeric value, unit, source, observed time, measurement window and state. Missing values are absent, not NaN, Infinity or zero. Counters are labeled cumulative since process start; durable inventory gauges are labeled current snapshot; estimates and invoices never share a field. Histogram quantiles are estimates from recorded buckets and require observations.

### UI

- [x] Add /admin/operations and an administrator navigation entry across profiles.
- [x] Reuse DataTable, shared style tokens, DateLabel, errors and private query conventions.
- [x] Show runtime, scope, refresh state, release and snapshot timestamp.
- [x] Show service states, their sources and their actual observation times.
- [x] Show usage/latency/backlog rows with explicit units and unavailable values.
- [x] Support manual refresh; periodic refresh only while visible, with cancellation on unmount and logout.
- [x] Do not show previous private observations after an authorization error.
- [x] Preserve zero as zero, unknown as unknown and disabled as disabled.
- [ ] Use accessible headers, keyboard navigation and loading/error states.
- [ ] Expose capability/setup links separately from operational health.
- [x] Native admin overview must not invoke missing portable account-management RPCs.
- [ ] Organization drilldown follows an explicit separate authorization contract; do not enable it by accepting a workspace string from the client.

### Portable backend

- [x] Reuse requireInstanceAdmin and recheck it after waiting for observations.
- [x] Reuse bounded dependencyChecks for PostgreSQL/Forgejo readiness.
- [x] Gather from the injected Prometheus registry, never scrape a public metrics URL.
- [x] Aggregate bounded HTTP/forge/database counters and histogram buckets.
- [x] Calculate approximate p50/p95/p99 only for populated distributions.
- [x] Display trace exporter failures and telemetry configuration independently.
- [x] Do not export route labels, usernames, repository names, paths, SQL or credentials.
- [x] Docker/Kubernetes retain independent monitoring setup; no new collector dependency for the Golf page.
- [ ] Add job/runner journals through bounded queries after baseline authorization is qualified.

### Native backend

- [x] Add explicit native operations administrators in an additive migration.
- [x] Seed only the explicitly enrolled workspace owner during fresh operator setup.
- [x] Existing installations require deliberate administrator enrollment, not automatic can_create conversion.
- [x] Access human identity plus current active D1 role authorize workspace-wide data.
- [x] Repository writers, creators and arbitrary Access identities do not gain operational authority.
- [x] Scoped machine operational credentials are a later explicit role; ordinary native bearer Git tokens are denied.
- [x] Recheck active/admin role immediately before returning a snapshot.
- [x] Read aggregate job/preview/index/resource inventories without private source or prompts.
- [x] Count current expired-but-unpurged resources and queued oldest age accurately.
- [x] Retain unavailable provider-level bytes/requests/cost as unknown until their collector exists.
- [x] Add last-attempt/last-success/outcome evidence for each maintenance stage.
- [x] Expose release and additive schema observations without marking rollback verified.

### Security and tests

- [x] Anonymous, ordinary user, repository creator, disabled user, revoked admin and delegated Git bearer denied.
- [x] Revocation during observation collection withholds the response.
- [x] Same-origin Connect envelope and existing Access audience gate remain required.
- [x] No-store response/cache policy and request cancellation remain active.
- [x] Provider failure strings, source, email, resource credentials and arbitrary request labels excluded.
- [x] Empty telemetry, true zero counters, populated histograms and partial collector failure tested.
- [ ] Render portable/native fixtures including errors, unknown values and stale observations.

## 6. O3: provider observability, usage and budgets

- [ ] Opt-in validated observability settings with bounded sampling and explicit retention.
- [ ] Structured logs contain request ID, fixed operation category, release, status and duration only.
- [x] Sanitize thrown exceptions at scheduled/workflow boundaries before enabling provider capture.
- [ ] Use Workers managed metrics/traces and GraphQL Analytics API for provider snapshots.
- [ ] Use D1 request/row/storage metrics; do not confuse rows scanned with stored bytes.
- [ ] Observe R2 bytes/operations, Artifacts allocation/limits, Queues backlog, Workflow outcomes, Containers runtime and AI token observations when their APIs actually supply them.
- [x] Scope a server-side read credential; do not send it to the dashboard/browser.
- [x] Validate account/resource identity against the installed ownership ledger.
- [ ] Poll in a background job with deadline, pagination bounds and per-service failure isolation.
- [x] Cache provider snapshots with source/time; never poll the whole account on each page render.
- [x] Dashboard refresh reads retained observations and does not allocate resources.
- [x] Document unavailable provider dimensions explicitly instead of extrapolating.
- [ ] Keep reservations, observed consumption, provider estimates and invoice totals separate.
- [ ] Enforce local quota admission from authoritative reservation journals; do not treat Analytics Engine samples as quota authority.
- [ ] Alert on stale collectors, error/latency growth, backlog age, failed cleanup and budget-envelope proximity.
- [ ] Admin alert destinations and opt-in notifications must be explicit; no unsolicited external messages.

## 7. R1/R2: recovery, expiry and resource ownership

Current preview expiry runs in hosted cron and request checks; whole-demo retirement still depends on an operator supervisor. These are different lifecycles.

- [x] Refactor hosted maintenance into independent named stages: CI intake, preview cleanup, evidence reconciliation and read-index retirement.
- [x] Persist fixed-key last-start/last-completion/outcome/counter records; no raw provider exceptions.
- [x] Continue other stages when one fails; preserve an overall failure for operator visibility.
- [ ] Keep stage effects behind the original workspace/operation serialization.
- [x] On cron retry, use existing job/resource IDs; never create a replacement execution merely because acknowledgement was lost.
- [ ] Expired previews deny reads immediately even before resource retirement finishes.
- [ ] Cleanup processes bounded pages and reports remaining work honestly.
- [ ] Handle abandoned PUBLISHING/UNKNOWN allocations via journal reconciliation.
- [ ] Distinguish pending resource deletion from a purged preview record.
- [ ] Verify current provider identity before deleting any resource.
- [ ] Finish permanent failure inbox/dead-letter consumer with original-key inspection and replay policy.
- [ ] Add a hosted owner for demo expiry, outside the resources being retired.
- [ ] Ownership-ledger expiry and cleanup state survive operator disconnects.
- [ ] Delete dependents/service bindings before parent Workers; preserve unrelated account resources.
- [ ] Resume deletion at every resource boundary, including after token/namespace/database partial removal.
- [ ] Use a short-lived least-privilege cleanup credential and revoke it after completion.
- [ ] Inject provider rate limits, missing resources, stale identity, lost acknowledgements and temporary outages.
- [ ] Record cleanup lateness and remaining resources; do not claim a deadline passed if it did not.

## 8. P1/P2: fast browsing and scalable tenancy

### Read path

- [ ] Trace root/overview/tree/blob/history/image stages separately, including D1/Artifacts/admission delay.
- [x] Batch duplicated metadata reads; deduplicate concurrent requests for the same immutable key. Default-source bootstrap and shared source/navigator/README reads have focused regression coverage.
- [ ] Keep per-repository DO coordination to avoid workspace-wide read bottlenecks.
- [x] Preserve the final current workspace authorization check after remote read waits. Native reads and every activity frame retain current-authority fences.
- [ ] Cache immutable content by account, namespace, repository identity, commit and classifier version.
- [ ] Mutable refs resolve fresh; never use a cached branch pointer as merge authority.
- [ ] Build metadata/history asynchronously and expose indexing/error/retry states.
- [ ] Paginate tree/history/PR/issues; bound query size and total traversal.
- [ ] Avoid polling or refetching settled shallow-history failures repeatedly.
- [x] Retain private in-memory observations only within the bounded authenticated session cache. Retained source still requires current repository access.
- [x] Preserve old hashed frontend assets across guarded deployments. The navigation release retains 113 current/predecessor assets.
- [ ] Access redirects expire private state and provide a usable login/reload flow.
- [ ] READMEs retain safe image proxy compatibility and explicit denied-host behavior.

### Load qualification

- [ ] Define a maintained benchmark matrix: empty/small/medium/large eligible repositories, wide trees, deep history, large text/binary files, LFS/submodules and imported shallow histories.
- [ ] Measure cold and warm p50/p95/p99, error rate, transferred bytes and cost per scenario.
- [ ] Run concurrent browser/API traffic with indexing, agents, CI and previews in the background.
- [ ] Use multiple independent tenant partitions and verify fairness under contention.
- [ ] Run from multiple available geographic test locations; record actual locations, not intended ones.
- [ ] Revoke access during cache hits, queued reads and remote payload transfers.
- [ ] Publish tested limits; do not promise unlimited Git payloads or global sub-100 ms loads.
- [ ] Set performance targets only after repeatable baselines; treat cold 2.15-second p95 as an optimization target, not an acceptable global SLO.

## 9. D1/D2: releases, rollback and disaster recovery

- [x] Build immutable release manifests with source digest, assets, Worker/DO identity, schema and predecessor.
- [x] Require additive compatible migrations before code rollout.
- [x] Lock the operator release transaction and read back independently served identity.
- [ ] Canary new release and metadata classifier behavior before whole-instance activation.
- [ ] Record Worker/DO version skew and upgrade/restart behavior.
- [ ] Qualify version-only code updates without redeploying unchanged cron triggers; verify scheduled maintenance/collector propagation independently of the release acknowledgement.
- [ ] Guard rollback against new irreversible schema/resource mutations.
- [ ] Prove a live rollback, including old assets, current auth and background jobs. Exact served predecessor/re-promotion and retained assets pass in the bounded hosted rehearsal; the full authorization/background-job compatibility matrix remains open.
- [ ] Snapshot D1 with documented Time Travel/export retention, Artifacts Git and R2 private evidence ownership.
- [ ] Restore into a fresh quarantined target, with all execution, publication, webhook and notification writers disabled.
- [ ] Reconcile job leases and old secrets/tokens without replaying protected side effects.
- [ ] Validate references, grants, source, issues, PRs, reviews, checks and evidence hashes.
- [ ] Measure RPO/RTO and publish the tested recovery boundary.
- [ ] Keep portable backup/restore setup independent and preserve existing data.

## 10. F1: native forge parity

Implement by behavior, not only an RPC switch. The appendix lists every shared method. For each method, review callers, role matrices, native storage/API constraints, original operation key, readback, permission revocation and frontend presentation. A portable identity setting may intentionally differ under Access; record that substitution explicitly.

Priority order:

1. Workspace/member/team administration, repository collaborators, scoped credentials and audit observations.
2. Repository refs/files/lifecycle, complete source history and bounded import fidelity.
3. Issues/comments, labels/milestones, reactions/subscriptions and notifications.
4. PR creation/forks, inline/pending reviews, review requests, exact-head checks and protected merge.
5. Workflow policies, execution values, multi-job CI, runners/agents and durable cancellation/recovery.
6. Environments/deployments, artifacts/attachments, releases/packages/wiki/imports/mirrors.
7. Account/profile/security adaptations, all remaining settings and runtime-aware capability states.

Acceptance for each supported behavior requires current authority, input validation, stale-write fencing, no duplicate provider effects, sanitized errors, pagination, shared UI and tests. Native protected merge must independently verify exact refs, required reviews, checks, grants and approval before Git publication; AI reports do not authorize merge. General Actions compatibility remains governed by ACTIONS_COMPATIBILITY_IMPLEMENTATION.md, including the runner release implications and unchanged upstream workflow tests.

## 11. New Cloudflare services with real consumers

| Service family | Concrete Golf consumer | Required gate |
| --- | --- | --- |
| Workers observability / GraphQL analytics | Operations health/latency/usage dashboard | Scoped read access, source timestamps, safe logs |
| Email Service | PR/review/run notifications and admin alerts | Verified sender, outbox, suppression, duplicate/failure semantics |
| AI Search / Vectorize | Search code and retained PR evidence | Per-tenant immutable indexing, current query authorization, deletions |
| WAF / rate limits / Turnstile / API Shield | Browser, RPC, Git and preview abuse controls | Protocol-specific rules; no HTML challenge injected into Git/API |
| Hyperdrive / optional managed Postgres | Approved customer SQL app resources and bridge acceleration | Real external DB lifecycle, schema and backup contracts |
| Cloudflare for SaaS | Customer-controlled branded hostnames | Ownership validation, cert/status, revocation and cleanup |
| KV | Rebuildable application caches | Never authoritative permission or quota storage |
| Agents SDK / Dynamic Workers | Interactive Golf App tools and agent sessions | Scoped tools, retained context and bounded execution |
| Workers Builds | General source build pipeline | Exact source identity, reproducible output, cancellation and isolation |
| Web Search | Agent research with retained citations | Explicit network policy, usage limits and source provenance |
| Tunnel / Workers VPC | Customer-private dependencies | Scoped connectivity and private-origin threat model |
| Flagship | Controlled rollout of qualified features | Audited feature/config ownership and safe defaults |
| K2 / Basin | Durable event consumers and retained fleet analytics | Replay/deletion/privacy contracts and measured need |
| Agent Memory | Tenant-scoped agent context | Provider eligibility, memory isolation and deletion |
| Monetization Gateway / x402 | Optional paid tools/repository read entitlements | Eligibility, payment validation, independent repository grants, refunds/revocation |
| Images / Stream / Realtime | Golf Apps that actually use media or collaboration | Concrete application consumer and resource policy |

These are distinct backlog items. Catalog availability is not account eligibility or an implemented integration. Access OTP email does not establish Golf transactional Email Service. Hyperdrive accelerates external databases; D1 remains the current native metadata authority.

## 12. Golf Apps and scheduled AI tools

- [ ] Define installation identity, owner workspace, approved repository selection and revisioned scopes.
- [ ] Separate external OAuth connection secrets from installation grants.
- [ ] Add webhook/event delivery with deduplication, signatures and retry journals.
- [ ] Scheduled improvement bot uses durable scheduled invocation and original run key.
- [ ] Agent operates in an independent Artifacts fork with approved file/network/model limits.
- [ ] Bot opens a real reviewable PR with exact source, tests and evidence; it cannot bypass protected merge.
- [ ] Code review tools publish source-bound observations, not fake execution attestations.
- [ ] Uninstall/revocation cancels future admission and invalidates credentials immediately.
- [ ] Tenant quotas limit active jobs, tokens, previews and retained outputs.
- [ ] Marketplace/billing is separate from the first installation/runtime implementation.

## 13. Setup and operator documentation

- [ ] Document local process, Docker, Kubernetes, Cloudflare bridge and native setup separately.
- [ ] Every optional integration has prerequisites, least-privilege scopes, exact configuration, test, failure states and retirement steps.
- [ ] No cloud credential is required to start portable Golf.
- [ ] Native setup enrolls Access owner identity and explicit ops admin separately from Git tokens.
- [ ] Existing installation upgrades require migrations, role enrollment, release preparation and readback.
- [ ] Docker monitoring uses existing overlay; Kubernetes uses an external collector/scraper setup.
- [ ] Dashboard is read-only first; retry/cancel/cleanup actions require separate current authority and original-key contracts.
- [ ] Publish an integration matrix: absent, planned, implemented, source-qualified and hosted-qualified.
- [ ] Document test envelope, quotas, provider eligibility and what is not a hard billing limit.

## 14. Verification and release checklist

- [ ] Generated Go/Connect/TypeScript output and contract inventory have no drift.
- [ ] Focused Go authorization/telemetry tests pass; PostgreSQL-backed integration tests separately recorded.
- [ ] All native Node tests, migration tests and private payload tests pass.
- [ ] Shared frontend typecheck and portable/native builds pass.
- [ ] Applicable Python operator tests and syntax checks pass.
- [ ] Existing Cloudflare check target passes after code changes.
- [ ] Product-native shared browser validates desktop/mobile/theme, navigation, Access expiry, admin denial and zero/unknown/error rows.
- [ ] Native local workerd validates real D1/DO/cron/RPC boundaries where available.
- [ ] Hosted test uses a dedicated bounded ownership ledger and explicit auto-stop window.
- [ ] Hosted evidence includes source/release/schema, provider facts and owned-resource absence after retirement.
- [ ] Do not commit credentials, logs, runtime data or private ownership files.
- [x] Update this plan and IMPLEMENTATION_STATUS.md with narrower completion and remaining work.

## 15. Sources and related documents

Official provider references checked during planning: [catalog](https://developers.cloudflare.com/directory/), [Workers observability](https://developers.cloudflare.com/workers/observability/), [D1 observability](https://developers.cloudflare.com/d1/observability/), [Queues dead letters](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). Consult exact current product documentation before new provider configuration; beta names and eligibility can change.

Repository references: OBSERVABILITY.md, deploy/observability/README.md, CLOUDFLARE_BUILD_PLAN.md, CLOUDFLARE_NATIVE_SETUP.md, CLOUDFLARE_CAPABILITY_INVENTORY.md, RECOVERY.md and IMPLEMENTATION_STATUS.md.

## 16. Execution ledger

Execution update, 2026-10-09: the integrated dashboard and reliability/release increments are implemented below. Checked tasks describe source implementation; they do not imply a live deployment or complete work package. Subsequent bounded hosted rehearsals and their failures/cleanup are recorded in IMPLEMENTATION_STATUS.md. No Grafana, Prometheus or collector stack is deployed in Cloudflare.

| Work package | Implementation | Qualification | Remaining gate |
| --- | --- | --- | --- |
| O1/O2 | Shared RPC/UI, portable metrics, native explicit admin role, batched inventories and historical service activity implemented | Both UI builds/typecheck; Go telemetry and real PostgreSQL/race authority checks; native local workerd Access/role/revocation; actual hosted human Operations/API/font/layout and ready-demo activation | Deployed Docker/Kubernetes checks; portable job journals and organization drilldown |
| O3 | Optional fixed-Worker Analytics collector, read-only Artifacts/R2 probes and sampled safe request logs implemented | Controlled provider responses; actual scoped Analytics Read query/eligibility with explicit token retirement; actual local scheduled/R2 probe; configuration/privacy/throttle/last-success tests | Hosted collector invocation remains unobserved despite installed schedule; provider retention and broader usage/billing collectors |
| R1 | Independent recorded maintenance stages, original-job bounded retry and optional durable dead-letter intake implemented | Stage failure isolation/privacy tests; real local D1/DO/Queues/Workflows/R2 and dead-letter persistence checks | Live provider outage/replay qualification, general recovery controls and all interrupted deletion cases |
| P1 | Bounded immutable blob-size cache added to existing authorized repository reads; Operations read does not serialize workspace mutations | Oversized-body metadata reuse, scope/size bounds, zero-size and current-authority regression checks | New cold/warm hosted measurements and remaining read-path/load acceptance |
| D1 | Additive schema0010 upgrade and schema10 preflight; guarded rollback/re-promotion and hosted rehearsal implemented | Actual hosted schema10 rollout,111 retained assets and exact served rollback/re-promotion; SQLite lost-ack migration replay and uncertain provider writes fenced | Canary/DO compatibility matrix; quarantine restore |
| R2 | Independent host stop timer, resumable ownership-checked recovery and original-preview lease renewal implemented | Actual ready-demo original leases/timer; focused timer/process/deletion/renewal tests; actual failed-attempt retirement and repeat recovery after absence; pending recovery token revocation | Cloudflare-owned retirement and unknown app-effect reconciliation |
| P2 | Bounded browser measurements include overview/root/file reads, finite deadlines and transport failure samples | Actual settled18 exact/200 reads across two small fixtures; warm p95/p99=326ms; initial metadata-pending samples retained; concurrency/identity/private-error tests | Large-repository and cold-cache measurements, multi-workspace/global load and overload acceptance |
| D2/F1/I1/I2/I3/A1/S1 | Open | Existing narrower proofs only | Acceptance described above |

## 17. Shared-RPC task appendix

This appendix is the method-level work queue at plan creation. The generated capability inventory remains authoritative for current adapter coverage. This appendix retains its 296-procedure baseline; the new OperationsService/GetOperationsDashboard adds one bounded adapter. The current inventory is 297 procedures, 46 bounded adapters and 251 missing native adapters, so complete native forge parity remains open. Each row needs design/behavior review, implementation or explicit runtime substitution, focused tests, and actual hosted acceptance. Existing bounded adapters still require their documented broader behavior gates.

| Task | Procedure | Contract | Baseline native adapter | Required acceptance |
| --- | --- | --- | --- | --- |
| F-001 | `AgentControlService/GetAgentControl` | agent_control088.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-002 | `AgentControlService/SubmitAgentCommand` | agent_control088.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-003 | `AgentControlService/ListWorkflowAgentChildren` | agent_control088.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-004 | `RepositoryFileBatchService/SubmitRepositoryFileBatch` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-005 | `RepositoryFileBatchService/GetRepositoryFileBatchOperation` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-006 | `DiscussionAttachmentService/ListDiscussionAttachments` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-007 | `DiscussionAttachmentService/DownloadDiscussionAttachment` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-008 | `DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadState` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-009 | `DiscussionAttachmentUploadService/SubmitDiscussionAttachmentUpload` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-010 | `DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadOperation` | forge089.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-011 | `SessionService/GetAuthenticationOptions` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-012 | `SessionService/BeginForgeOAuth` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-013 | `SessionService/LoginWithPassword` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-014 | `SessionService/CompletePasswordMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-015 | `SessionService/LoginWithForgeToken` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-016 | `SessionService/GetSession` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-017 | `SessionService/ListSessions` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-018 | `SessionService/RevokeSession` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-019 | `SessionService/RevokeOtherSessions` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-020 | `SessionService/Logout` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-021 | `ApiCredentialService/CreateApiCredential` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-022 | `ApiCredentialService/ListApiCredentials` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-023 | `ApiCredentialService/RevokeApiCredential` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-024 | `GitAccessService/ListSSHKeys` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-025 | `GitAccessService/AddSSHKey` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-026 | `GitAccessService/DeleteSSHKey` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-027 | `RepositorySettingsService/GetRepositorySettings` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-028 | `RepositorySettingsService/UpdateRepositorySettings` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-029 | `RepositorySettingsService/UpdateRepositoryTopics` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-030 | `RepositoryService/ListRepositories` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-031 | `RepositoryService/CreateRepository` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-032 | `RepositoryService/GetRepositoryCreation` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-033 | `RepositoryService/GetRepository` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-034 | `RepositoryService/GetRepositoryOverview` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-035 | `RepositoryService/GetRepositoryStar` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-036 | `RepositoryService/SetRepositoryStar` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-037 | `RepositoryService/ListRepositoryReleases` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-038 | `RepositoryService/GetRepositoryRelease` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-039 | `RepositoryService/ListBranches` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-040 | `RepositoryService/ListTags` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-041 | `RepositoryService/ListCommits` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-042 | `RepositoryService/GetCommitDiff` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-043 | `RepositoryService/ListPullRequestCommits` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-044 | `RepositoryService/ListPullRequestChecks` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-045 | `RepositoryService/GetPullRequestDiff` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-046 | `RepositoryService/GetRepositoryComparison` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-047 | `RepositoryService/GetRepositoryImage` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-048 | `RepositoryService/ResolveRepositorySource` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-049 | `RepositoryService/GetContents` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-050 | `RepositoryService/ListIssues` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-051 | `RepositoryService/GetPullRequestDiscussion` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-052 | `RepositoryService/GetIssue` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-053 | `RepositoryService/ListRepositoryLabels` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-054 | `RepositoryService/ListRepositoryAssignees` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-055 | `RepositoryService/ListRepositoryMilestones` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-056 | `RepositoryService/ListIssueComments` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-057 | `RepositoryService/CreateIssue` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-058 | `RepositoryService/CreateIssueComment` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-059 | `RepositoryService/UpdateIssue` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-060 | `RepositoryService/CreatePullRequest` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-061 | `RepositoryService/UpdatePullRequest` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-062 | `RepositoryService/GetIssueMutation` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-063 | `RepositoryService/SubmitDiscussionResourceOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-064 | `RepositoryService/GetDiscussionResourceOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-065 | `RepositoryService/ListPullRequests` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-066 | `RepositoryService/GetPullRequest` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-067 | `RepositoryService/ListPullRequestReviews` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-068 | `RepositoryService/GetPullRequestReviewComments` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-069 | `RepositoryService/GetPullRequestReviewDraft` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-070 | `RepositoryService/SavePullRequestReviewDraft` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-071 | `RepositoryService/DeletePullRequestReviewDraft` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-072 | `RepositoryService/PublishPullRequestReviewDraft` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-073 | `RepositoryService/GetPullRequestInlineReviewMutation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-074 | `RepositoryService/CreatePullRequestReview` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-075 | `RepositoryService/GetPullRequestReviewMutation` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-076 | `OrganizationService/ListOrganizations` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-077 | `OrganizationService/GetOrganization` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-078 | `OrganizationService/ListTeams` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-079 | `OrganizationService/GetTeam` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-080 | `OrganizationService/ListTeamMembers` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-081 | `OrganizationService/ListTeamRepositories` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-082 | `OrganizationAdminService/GetTeamAdministration` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-083 | `OrganizationAdminService/ResolveTeamMember` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-084 | `OrganizationAdminService/AddTeamMember` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-085 | `OrganizationAdminService/RemoveTeamMember` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-086 | `InstanceAdminService/EnrollRegularLocalAccount` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-087 | `InstanceAdminService/ResetRegularLocalPassword` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-088 | `InstanceAdminService/ResetRegularLocalMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-089 | `InstanceAdminService/EnableRegularLocalAccount` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-090 | `InstanceAdminService/DisableLocalAccount` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-091 | `InstanceAdminService/ListLocalAccounts` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-092 | `InstanceAdminService/ListGolfUserAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-093 | `InstanceAdminService/ChangeGolfUserAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-094 | `InstanceAdminService/GetGolfUserAccessOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-095 | `AuditService/ListAuditEvents` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-096 | `CapabilityService/ListCapabilities` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-097 | `RepositoryAccessService/GetRepositoryAccess` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-098 | `RepositoryAccessService/ListRepositoryCollaborators` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-099 | `RepositoryAccessService/ResolveRepositoryCollaborator` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-100 | `RepositoryAccessService/SetRepositoryCollaborator` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-101 | `RepositoryAccessService/RemoveRepositoryCollaborator` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-102 | `RepositoryAccessService/GetRepositoryAccessOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-103 | `WorkflowService/InspectWorkflows` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-104 | `ExecutionPolicyService/GetExecutionPolicy` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-105 | `ExecutionPolicyService/UpdateExecutionPolicy` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-106 | `WorkflowRunService/PrepareWorkflowDispatch` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-107 | `WorkflowRunService/DispatchWorkflow` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-108 | `WorkflowRunService/GetWorkflowRun` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-109 | `WorkflowRunService/GetWorkflowDispatch` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-110 | `WorkflowRunService/ListWorkflowRuns` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-111 | `WorkflowRunService/CancelWorkflowRun` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-112 | `WorkflowRunService/GetWorkflowRunLogs` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-113 | `OrganizationCreationService/GetOrganizationCreationPolicy` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-114 | `OrganizationCreationService/UpdateOrganizationCreationPolicy` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-115 | `OrganizationCreationService/CreateOrganization` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-116 | `InfrastructureConnectionService/ListInfrastructureConnections` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-117 | `InfrastructureConnectionService/SaveInfrastructureConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-118 | `InfrastructureConnectionService/TestInfrastructureConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-119 | `InfrastructureConnectionService/ActivateInfrastructureConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-120 | `InfrastructureConnectionService/ProvisionCloudflareEnvironmentResources` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-121 | `InfrastructureConnectionService/GetCloudflareEnvironmentResources` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-122 | `InfrastructureConnectionService/ListCloudflareEnvironmentResources` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-123 | `InfrastructureConnectionService/RemoveCloudflareEnvironmentResources` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-124 | `ProfileService/GetProfile` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-125 | `ProfileService/UpdateProfile` | golf.proto | Bounded adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-126 | `AccountSecurityService/GetAccountSecurity` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-127 | `AccountSecurityService/ChangeOwnPassword` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-128 | `AccountSecurityService/ChangeOwnLoginEmail` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-129 | `AccountSecurityService/GetOwnMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-130 | `AccountSecurityService/BeginOwnMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-131 | `AccountSecurityService/ConfirmOwnMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-132 | `AccountSecurityService/DisableOwnMFA` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-133 | `AccountSecurityService/RegenerateOwnMFARecovery` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-134 | `AutomationGrantService/ListAutomationGrants` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-135 | `AutomationGrantService/CreateAutomationGrant` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-136 | `AutomationGrantService/RevokeAutomationGrant` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-137 | `CodexAccountService/ListCodexConnections` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-138 | `CodexAccountService/CreateCodexConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-139 | `CodexAccountService/SetCodexConnectionAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-140 | `CodexAccountService/GetCodexConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-141 | `CodexAccountService/StartCodexLogin` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-142 | `CodexAccountService/CompleteAgentLogin` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-143 | `CodexAccountService/CancelCodexLogin` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-144 | `CodexAccountService/RefreshCodexConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-145 | `CodexAccountService/DisconnectCodexConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-146 | `AgentUsageService/GetAgentUsage` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-147 | `AgentUsageService/SaveAgentUsage` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-148 | `AgentUsageService/ListAgentModels` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-149 | `AgentUsageService/PreviewAgentTask` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-150 | `AgentTaskService/CreateAgentTask` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-151 | `AgentTaskService/ListAgentTasks` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-152 | `AgentTaskService/GetAgentTask` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-153 | `AgentTaskService/CancelAgentTask` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-154 | `AgentTaskService/ListAgentTaskEvents` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-155 | `ReviewerService/GetReviewer` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-156 | `ReviewerService/SaveReviewer` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-157 | `ReviewerService/ListReviewerRuns` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-158 | `ReviewerService/RequestReview` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-159 | `RepositoryActivityService/WatchRepository` | golf.proto | Bounded adapter | [x] behavior; [x] role/revocation; [x] failure/replay; [x] UI; [x] bounded hosted final-release mutation/sidebar acceptance (2026-10-10; small fixture) |
| F-160 | `ActionRunService/ListActionRuns` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-161 | `ActionRunService/GetActionRun` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-162 | `RepositoryDeployKeyService/ListRepositoryDeployKeys` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-163 | `RepositoryDeployKeyService/AddRepositoryDeployKey` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-164 | `RepositoryDeployKeyService/DeleteRepositoryDeployKey` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-165 | `RepositoryWebhookService/ListRepositoryWebhooks` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-166 | `RepositoryWebhookService/SaveRepositoryWebhook` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-167 | `RepositoryWebhookService/ListRepositoryWebhookDeliveries` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-168 | `RepositoryWebhookService/TestRepositoryWebhook` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-169 | `RepositoryWebhookService/RedeliverRepositoryWebhook` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-170 | `RepositoryTeamAccessService/ListRepositoryTeamAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-171 | `RepositoryTeamAccessService/AttachRepositoryTeam` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-172 | `RepositoryTeamAccessService/DetachRepositoryTeam` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-173 | `RepositoryLifecycleService/GetRepositoryLifecycle` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-174 | `RepositoryLifecycleService/ChangeRepositoryArchiveState` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-175 | `RepositoryLifecycleService/GetRepositoryLifecycleOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-176 | `RepositoryLifecycleService/DeleteRepository` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-177 | `RepositoryLifecycleService/GetRepositoryDeletionOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-178 | `EmailNotificationService/ListEmailTransports` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-179 | `EmailNotificationService/SaveEmailTransport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-180 | `EmailNotificationService/ActivateEmailTransport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-181 | `EmailNotificationService/DeactivateEmailTransport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-182 | `EmailNotificationService/GetOwnEmailNotifications` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-183 | `EmailNotificationService/RequestEmailVerification` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-184 | `EmailNotificationService/ConfirmEmailVerification` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-185 | `EmailNotificationService/SaveOwnEmailPreference` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-186 | `EmailNotificationService/GetRepositoryEmailSubscription` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-187 | `EmailNotificationService/SaveRepositoryEmailSubscription` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-188 | `EmailNotificationService/ListOwnEmailDeliveries` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-189 | `EmailNotificationService/RedeliverOwnEmail` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-190 | `RepositoryExecutionValueService/ListRepositoryExecutionValues` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-191 | `RepositoryExecutionValueService/SaveRepositoryExecutionValue` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-192 | `RepositoryExecutionValueService/DeleteRepositoryExecutionValue` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-193 | `RepositoryExecutionValueService/GetRepositoryExecutionVariable` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-194 | `RepositoryExecutionValueService/SaveRepositoryExecutionBinding` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-195 | `RepositoryExecutionValueService/DeleteRepositoryExecutionBinding` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-196 | `RepositoryExecutionValueService/GetRepositoryExecutionValueOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-197 | `RepositoryInvitationService/PreviewRepositoryInvitationRecipient` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-198 | `RepositoryInvitationService/CreateRepositoryInvitation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-199 | `RepositoryInvitationService/ListRepositoryInvitations` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-200 | `RepositoryInvitationService/ListOwnRepositoryInvitations` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-201 | `RepositoryInvitationService/RespondRepositoryInvitation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-202 | `RepositoryInvitationService/RevokeRepositoryInvitation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-203 | `RepositoryInvitationService/GetRepositoryInvitationOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-204 | `RepositoryRulesService/GetRepositoryRules` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-205 | `RepositoryRulesService/MutateRepositoryRules` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-206 | `RepositoryRulesService/GetRepositoryRuleMutation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-207 | `RunnerControlService/GetInstanceRunners` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-208 | `RunnerControlService/UpdateRunnerControl` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-209 | `RunnerControlService/GetRepositoryRunners` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-210 | `RunnerControlService/GetInstanceRunnerLimits` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-211 | `RunnerControlService/SetInstanceRunnerLimits` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-212 | `RunnerPoolService/ListRunnerPools` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-213 | `RunnerPoolService/SaveRunnerPool` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-214 | `RunnerPoolService/GetRepositoryRunnerPlacement` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-215 | `RunnerPoolService/SetRepositoryRunnerPlacement` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-216 | `GitTransportService/GetGitTransport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-217 | `GitTransportService/CreateGitCredential` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-218 | `GitTransportService/ListGitCredentials` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-219 | `GitTransportService/RevokeGitCredential` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-220 | `GitTransportService/GetGitReceiveOutcome` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-221 | `OrganizationExecutionValueService/ListOrganizationExecutionValues` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-222 | `OrganizationExecutionValueService/SaveOrganizationExecutionValue` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-223 | `OrganizationExecutionValueService/DeleteOrganizationExecutionValue` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-224 | `OrganizationExecutionValueService/GetOrganizationExecutionVariable` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-225 | `OrganizationExecutionValueService/GetOrganizationExecutionValueOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-226 | `RepositoryEnvironmentService/ListRepositoryEnvironments` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-227 | `RepositoryEnvironmentService/SaveRepositoryEnvironment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-228 | `RepositoryEnvironmentService/DeleteRepositoryEnvironment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-229 | `RepositoryEnvironmentService/GetRepositoryEnvironmentOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-230 | `PullMergeObservationService/GetPullRequestMergeObservation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-231 | `StandardPullMergeService/SubmitStandardPullMerge` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-232 | `StandardPullMergeService/GetStandardPullMergeOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-233 | `WorkflowArtifactService/GetWorkflowArtifact` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-234 | `RepositoryReleasePublicationService/SubmitRepositoryReleasePublication` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-235 | `RepositoryReleasePublicationService/GetRepositoryReleasePublicationOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-236 | `RepositoryDeploymentService/PrepareStaticDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-237 | `RepositoryDeploymentService/CreateRepositoryDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-238 | `RepositoryDeploymentService/GetRepositoryDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-239 | `RepositoryDeploymentService/ListRepositoryDeployments` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-240 | `RepositoryDeploymentService/ReviewRepositoryDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-241 | `RepositoryDeploymentService/ActivateRepositoryDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-242 | `RepositoryDeploymentService/RevokeRepositoryDeployment` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-243 | `RepositoryRefMutationService/SubmitRepositoryRefMutation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-244 | `RepositoryRefMutationService/GetRepositoryRefMutationOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-245 | `RepositoryFileMutationService/GetRepositoryFileMutationAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-246 | `RepositoryFileMutationService/SubmitRepositoryFileMutation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-247 | `RepositoryFileMutationService/GetRepositoryFileMutationOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-248 | `DiscussionCollaborationService/GetDiscussionEngagement` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-249 | `DiscussionCollaborationService/ListDiscussionTimeline` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-250 | `DiscussionCollaborationService/ListOwnForgeNotifications` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-251 | `DiscussionCollaborationService/ListIssueTemplates` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-252 | `RepositoryReleaseManagementService/SubmitRepositoryReleaseOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-253 | `RepositoryReleaseManagementService/GetRepositoryReleaseOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-254 | `PullReviewRequestService/GetPullReviewLifecycleState` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-255 | `PullReviewRequestService/SubmitPullReviewLifecycle` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-256 | `PullReviewRequestService/GetPullReviewLifecycleOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-257 | `PullReviewRequestService/GetPullCodeOwners` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-258 | `PullReviewRequestService/GetPullReviewCommentState` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-259 | `PullReviewRequestService/SubmitPullReviewCommentInteraction` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-260 | `PullReviewRequestService/GetPullReviewCommentOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-261 | `PullReviewRequestService/GetPullReviewRequests` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-262 | `PullReviewRequestService/GetPullReviewTeamCandidates` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-263 | `PullReviewRequestService/SubmitPullReviewRequest` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-264 | `PullReviewRequestService/GetPullReviewRequestOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-265 | `RepositoryMirrorService/GetRepositoryMirrorStatus` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-266 | `RepositoryMirrorService/SubmitRepositoryMirrorOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-267 | `RepositoryMirrorService/GetRepositoryMirrorOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-268 | `RepositoryWikiService/ListRepositoryWikiPages` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-269 | `RepositoryWikiService/GetRepositoryWikiPage` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-270 | `RepositoryWikiManagementService/GetRepositoryWikiWriteContext` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-271 | `RepositoryWikiManagementService/SubmitRepositoryWikiOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-272 | `RepositoryWikiManagementService/GetRepositoryWikiOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-273 | `RepositoryWikiManagementService/ListRepositoryWikiRevisions` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-274 | `ForgePackageService/ListRepositoryPackages` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-275 | `ForgePackageService/GetRepositoryPackageFiles` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-276 | `OrganizationLabelService/ListOrganizationLabels` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-277 | `OrganizationLabelService/SubmitOrganizationLabelOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-278 | `OrganizationLabelService/GetOrganizationLabelOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-279 | `PullReviewAuthoringService/GetPullReviewAuthoringState` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-280 | `PullReviewAuthoringService/SubmitPullReviewAuthoringOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-281 | `PullReviewAuthoringService/GetPullReviewAuthoringOperation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-282 | `ProviderImportService/ListProviderConnections` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-283 | `ProviderImportService/CreateProviderConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-284 | `ProviderImportService/UpdateProviderConnection` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-285 | `ProviderImportService/PreviewProviderImport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-286 | `ProviderImportService/SubmitProviderImport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-287 | `ProviderImportService/GetProviderImport` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-288 | `PackagePublicationService/GetPackagePublicationAccess` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-289 | `PackagePublicationService/SubmitPackagePublication` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-290 | `PackagePublicationService/GetPackagePublication` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-291 | `PackagePublicationService/DownloadGenericPackageFile` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-292 | `MirrorObservationService/GetMirrorSyncObservation` | golf.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-293 | `PasswordRecoveryService/RequestPasswordRecovery` | password_recovery090.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-294 | `PasswordRecoveryService/CompletePasswordRecovery` | password_recovery090.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-295 | `PasswordRecoveryEnrollmentService/GetOwnPasswordRecoveryEnrollment` | password_recovery_enrollment090.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
| F-296 | `PasswordRecoveryEnrollmentService/SaveOwnPasswordRecoveryEnrollment` | password_recovery_enrollment090.proto | Missing native adapter | [ ] behavior; [ ] role/revocation; [ ] failure/idempotency; [ ] UI; [ ] hosted |
