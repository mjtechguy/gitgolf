# Forgejo transition plan

Date: 2026-10-11. Direction: accepted by the user. Execution: **in progress; existing-install cutover blocked**.
Decision: [ADR 0009](decisions/0009-forgejo-portable-backend.md).
Current implementation, commands, evidence and limits: [Forgejo setup](FORGEJO_SETUP.md).

Make Forgejo the default forge for new local, Docker and Kubernetes Golf
installations, and migrate existing Gitea-backed Golf installations without losing
repository data or weakening authority. Gitea becomes a temporary migration and
rollback dependency. It is not the target of a permanent dual-provider roadmap.
The shared Golf UI, generated API, CLI, automation and delivery contracts remain
the product surface. Cloudflare-native SaaS continues to use Artifacts, D1,
Workers and its existing native adapters.

This document authorizes a concrete implementation sequence, not a live data
cutover or deletion. Existing runtime configuration remains unchanged. Every
unchecked task below is future work; previous Gitea test receipts do not qualify
Forgejo. The user's decision supersedes the earlier Gitea-default direction.

## 1. Baseline and decisions

Observed in the current source:

- `compose.yaml` pins `gitea/gitea:1.27.3-rootless`, with native Actions disabled.
- `internal/server/forge.go` uses Golf's HTTP client against `/api/v1`; the main
  module does not embed the Gitea server. This boundary can be adapted in place.
- `GiteaURL`, `GITEA_URL` and native identity fields reach authentication,
  encrypted credentials, operation journals, automation and authorization.
  Changing a URL or reusing a numeric ID is not an identity migration.
- `internal/workflowpath/path.go` accepts only `.gitea/workflows` and
  `.github/workflows`; `.forgejo/workflows` requires coordinated changes.
- Compose overlays, Helm, setup, operator recovery and many native test fixtures
  assume Gitea service names, paths, CLI commands and image identities.
- Current feature/protection/recovery gaps in [implementation status](IMPLEMENTATION_STATUS.md)
  remain open. A backend change does not complete them.

Upstream constraints, checked on 2026-10-11:

- Forgejo documents transparent upgrades only from Gitea through 1.22, via
  Forgejo 10. Our 1.27.3 source is outside that path. We will use a fresh target
  and supported import/API/Git transfer, not an image replacement over the old
  database. Do not downgrade the source to manufacture eligibility.
  [Upgrade guide](https://forgejo.org/docs/latest/admin/upgrade/).
- Start qualification on the **15.0 LTS line**, using the latest reviewed patch
  and exact image digest at execution time. Its published support window reaches
  July 2027. A newer supported line may replace this choice if a required API is
  missing; record the reason and rerun its matrix before shipping. Do not use
  floating `latest`, major-only tags or development builds.
  [Release schedule](https://forgejo.org/docs/latest/admin/release-schedule/).
- Treat API compatibility as an endpoint-specific hypothesis. Inventory the
  pinned server's actual OpenAPI and behavior, including Forgejo-specific routes.
  [API usage](https://forgejo.org/docs/latest/user/api/usage/).
- Forgejo 9+ is GPLv3+. Keep it separately operated and integrated through
  supported protocols. Record distribution notices/source obligations for the
  shipped artifacts and any modifications. Copying upstream source into Golf or
  a Worker is a separate licensing decision, not an implicit migration shortcut.
  [License FAQ](https://forgejo.org/faq/#is-forgejo-licensed-under-the-gpl).

## 2. Target architecture and scope

| Installation | Target | Migration boundary |
| --- | --- | --- |
| Developer/local | Golf + Forgejo + existing PostgreSQL arrangement | Fresh setup first; retained developer data follows the same fidelity rules |
| Docker | Rootless, digest-pinned Forgejo with private backend network | Separate new database/volumes; coordinated Golf identity migration |
| Kubernetes | Forgejo workload and explicit persistence/external-service settings | New PVC/database targets; preserve old resources until retirement gate |
| Cloudflare origin bridge | Golf bridge backed by Forgejo | Qualify Access/OAuth origins and provider routing before changing the origin |
| Cloudflare-native | Existing Artifacts/D1/Workers backend | No forge replacement; shared UI/API regression tests only |
| Independent CFCR | Existing registry installation and authority contract | No automatic rebinding of registry identities or migration of packages into CFCR |

Keep the current PostgreSQL and optional object-store choices. Do not combine this
swap with a database engine, UI framework, CI coordinator or registry replacement.
Reuse existing transport/helpers; add provider-specific handling only for measured
differences. Keep historical names inside signed evidence and migration records.

## 3. Work packages and dependency order

| Package | Deliverable | Depends on | Exit evidence |
| --- | --- | --- | --- |
| FJ-0 | Dependency, data and API inventories; frozen version pins | None | Reproducible source/target profiles and complete discrepancy register |
| FJ-1 | Forgejo configuration and existing HTTP boundary adapted | FJ-0 | Config/identity/transport tests; unsupported methods fail explicitly |
| FJ-2 | Disposable Forgejo fixture and portable runtime qualification | FJ-1 | Actual server/Git/permission/role/credential tests |
| FJ-3 | Workflow discovery and CI behavior on Forgejo | FJ-2 | One execution owner, exact-source CI and cancellation/revocation proof |
| FJ-4 | Migration planner, transfer journal and identity mapping | FJ-0, FJ-1 | Dry-run manifest, restart/failure tests and fidelity reconciliation |
| FJ-5 | Shared UI, packaging, Operations and recovery | FJ-2, FJ-3 | Local/Docker/Kubernetes matrix and fresh-target recovery |
| FJ-6 | Full dress rehearsal from Gitea 1.27.3 | FJ-3, FJ-4, FJ-5 | Migration, rollback, performance and security receipts |
| FJ-7 | Change new-install defaults; controlled existing-install cutover | FJ-6 | Served-version proof and reconciled destination state |
| FJ-8 | Retire Gitea deployment dependency | FJ-7 | Retention/restore gates satisfied; no active Gitea runtime dependency |

FJ-4 inventory can proceed alongside fixture work. Do not flip production defaults
merely because repository listing works. No duration or zero-downtime promise is
made before the first full migration rehearsal measures data size and throughput.

## 4. FJ-0 — Inventory and freeze

- [ ] Capture source commit/dirty-state digest, Golf schema, actual installed
  Gitea version/image, database versions, storage topology and active integrations.
  The Compose pin is not evidence of every user's running version.
- [ ] Select and verify Forgejo release/image digest for each supported CPU
  architecture; record source provenance, release notes and support expiry.
- [ ] Inventory every forge request method/path and decode/write assumption in
  `internal/server`, CLI, workers, scripts and UI links. Include Git HTTP/SSH,
  LFS, raw/archive routes, OAuth, package protocols and webhook payloads.
- [ ] Compare with the target's actual OpenAPI. Record each operation as same,
  adapted, absent, or needing behavioral proof. Never synthesize an endpoint
  because the same screen exists in Forgejo.
- [ ] Inventory every Golf table, encrypted payload, cache key, durable intent,
  external reference and audit receipt containing forge URL or native IDs.
- [ ] Enumerate users, organizations, teams, repositories, forks, issues/PRs,
  refs, LFS, releases, attachments, packages, secrets and historical runs with
  counts/bytes. Include archived, empty, disabled and private objects.
- [ ] Inventory direct writers and consumers: Git clients, backend UI/API,
  runners, agents, import/mirror schedulers, webhooks and external bots.
- [ ] Produce an endpoint register and a per-data-class transfer capability report
  tied to the exact source/target versions. Unknown fidelity blocks migration.

Acceptance: every current Golf operation and retained data class has a disposition;
the inventory can be reproduced without mutations, secret output or unbounded scans.

## 5. FJ-1/FJ-2 — Configuration and runtime integration

### Configuration transition

- [x] Introduce explicit forge kind (`forgejo` or temporary `gitea`) and neutral
  Golf URL/workflow settings. Implemented names: `GOLF_FORGE_KIND`, `GOLF_FORGE_URL`,
  `GOLF_FORGE_WORKFLOW_DIRS`; fresh Forgejo setup is currently a separate profile.
- [x] Accept existing `GITEA_URL` and `GOLF_GITEA_WORKFLOW_DIRS` as documented
  transition aliases. Reject conflicting values; do not silently choose one.
  Existing installations without a kind retain their current Gitea behavior
  until deliberately migrated. New setup emits Forgejo explicitly.
- [x] Add a neutral CLI forge-token input alias while keeping the existing
  `GOLF_GITEA_TOKEN` transition path and token-kind ambiguity checks. Never
  reinterpret `GOLF_API_TOKEN` or `GOLF_NATIVE_TOKEN` as a provider credential.
- [ ] Include forge kind and installation identity in diagnostics and persisted
  bindings. A different backend at the same URL must fail closed until the
  migration commits its verified destination binding.
- [ ] Keep protobuf field numbers, routes and public operation IDs stable.
  Rename internal fields incrementally only where their consumers migrate together.
- [ ] Validate rootless image UID/GID, config location, environment conventions,
  SSH behavior, API origins, allowed callback hosts and health endpoints against
  the pinned image. Do not copy Gitea container settings without checking them.
  [Docker installation](https://forgejo.org/docs/latest/admin/installation/docker/).

### Behavior to qualify against the actual server

| Area | Required checks |
| --- | --- |
| Authentication | PAT scopes, OAuth/PKCE/refresh, Golf password-to-provider mapping, explicit Golf/admin roles, MFA/recovery, disabled accounts, current revocation |
| Repository access | Personal/org ownership, teams, invitations, read/write/admin, visibility, archive, transfer, deletion, name/ID reuse and pagination |
| Source | Git HTTP/SSH, clone/push, HEAD, tags, symlinks, binaries, Unicode paths, immutable file/index/history/diff, LFS and submodules |
| Collaboration | Issues, labels, milestones, assignments, comments, reactions, subscriptions, PRs/forks, pending/published reviews, inline anchors, review requests and dismissal |
| Protected writes | Branch/tag rules, all direct write ingress, exact candidate/review/check binding, stale-state refusal, uncertain mutation reconciliation |
| Other forge data | Releases/assets, wiki Git, packages, deploy keys, webhooks, mirrors, imports, organization/account settings and native notifications |

- [ ] Run owner/admin/writer/reader/outsider and cross-organization matrices.
- [ ] Inject errors, malformed pagination, response loss, restart, revocation
  during reads/writes and same-name replacement. Keep ambiguity visible.
- [ ] Preserve every currently qualified operation or block the default change
  on its regression. Previously disabled features stay disabled until qualified.
- [ ] Audit direct Forgejo UI/API access as well as Golf-mediated access. Golf
  policy checks do not prove that independent native writes obey the same rules.
- [ ] Reuse current native smoke harnesses with explicit provider profiles;
  retain their historical Gitea receipts and add new Forgejo receipts.

## 6. FJ-3 — CI, automation and registry publishing

Golf remains the execution coordinator for this transition. The target's native
Actions scheduler starts disabled, matching current Golf deployment policy.
Selecting Forgejo Runner is a later, separately qualified execution integration;
do not run two schedulers for one push. Forgejo documents its own workflow and
runner behavior: [Actions administration](https://forgejo.org/docs/latest/admin/actions/),
[GitHub Actions differences](https://forgejo.org/docs/latest/user/actions/github-actions/).

- [x] Add `.forgejo/workflows` across discovery, inspection, source resolution,
  policy hashing, dispatch, push admission, worker validation, UI and fixtures.
- [ ] Define and qualify the Forgejo profile's directory precedence from the
  pinned upstream behavior. Preserve `.gitea`/`.github` sources during transition;
  detect shadowed directories and require an explicit recorded selection change.
  Never silently execute a different file after switching providers.
- [ ] Re-admit workflows under the new provider/source identity and selected
  directory policy. Old approved graphs and cached authority are not transferable.
- [ ] Qualify unchanged representative workflows, real checkout, immutable action
  pins, credentials, private dependencies, services, artifacts, caches and logs.
  Keep current compatibility limits visible; YAML parsing is not execution parity.
- [ ] Cover manual/push/PR events, fork credentials, cancellation, timeouts,
  sponsor revocation, retries and provider outage without duplicate execution.
- [ ] Cancel/drain existing jobs at cutover; quarantine ambiguous side effects
  and reconcile their original receipts. Never replay a migrated pending job.
- [ ] Update agents/bots and webhook consumers to the new source identity. Keep
  migration imports from sending mail, firing production webhooks or starting CI.
- [ ] Preserve CI-to-CFCR current-job/current-source authorization and immutable
  digest semantics. Forge migration neither enables publishing nor grants packages
  access. Native CFCR bindings tied to Artifacts remain untouched.
- [ ] Audit runtime dependencies separately from the server replacement. Do not
  blindly delete Gitea-named provenance, fork history or license notices from the
  existing execution engine. Record any remaining runtime dependency explicitly.

## 7. FJ-4 — Data transfer and identity migration

### Method and fidelity rules

Use a fresh Forgejo database, storage and installation identity. Prefer supported
repository import APIs where their exact versioned behavior passes the fidelity
fixture. Fill proven gaps through supported APIs and normal Git/LFS/package
protocols. No direct mutation of either forge's database or repository files is
part of the application or transfer tool. The existing offline recovery exception
does not authorize cross-product schema surgery.

Do not claim that native import preserves every field. For each class record
`verified`, `reenrollment required`, `preserved as historical archive`, or
`blocked`, with counts and an explicit reason. Active repository source,
permissions and required collaboration cannot silently degrade to an archive.
If supported interfaces cannot preserve required data, keep the source intact
and stop that installation's cutover pending a reviewed transfer method or a
specific operator decision about the documented loss. New empty installations
can still ship once their separate qualification gates pass.

| Data | Transfer requirement and reconciliation |
| --- | --- |
| Git repositories | Compare every required branch/tag/ref and object ID, annotated tags/signatures, default HEAD, reachable history and repository properties. Record provider-owned hidden refs separately; retain PR source commits even after source branch deletion. Run Git integrity checks on owned transfer clones. |
| LFS, wiki, submodules | Transfer actual LFS objects and verify pointer OID/size; compare wiki refs/history; preserve gitlink commits and review submodule URL routing without rewriting signed history. |
| Users/orgs/teams | Explicit source installation + kind + ID → destination ID map, owner recovery path, disabled status and membership reconciliation. No account linking from matching usernames or email alone. |
| Access and protection | Recreate equivalent grants, visibility, branch/tag rules and exceptions before exposure; test effective access and direct native ingress. Missing enforcement blocks opening writes. |
| Issues/PRs/reviews | Reconcile counts, numbering where possible, authorship, dates, state, head/base/fork bindings, comments, pending-review privacy, inline anchors, assignments and review history. Unpreserved fields become named blockers, never synthetic approvals. |
| Labels/milestones/projects | Preserve mappings, memberships, status and references. Inventory project/board data even if Golf does not yet expose it. |
| Releases/attachments | Compare tags, metadata, filenames, sizes, content digests and visibility; downloaded content remains authenticated and untrusted. |
| Packages | Transfer with supported package protocols; compare versions/digests, ownership, visibility and attachments/referrers where applicable. No implicit move into independent CFCR. |
| Hooks/mirrors/integrations | Recreate disabled first, verify destinations/ownership, rotate secrets and re-enable once; keep delivery IDs and original events distinguishable. |
| Credentials | Re-enroll provider PATs, OAuth clients/grants, SSH/deploy credentials and runners as needed. Do not assume passwords, MFA state, secret keys or token ciphertext are portable. |
| Runs/logs/artifacts/audit | Preserve Golf history and immutable receipts with original source attribution. Native histories without an exact importer need a usable, access-controlled archive and an explicit fidelity disposition. Old checks cannot approve a new candidate. |

### Golf-owned state

- [ ] Preserve stable Golf identities where supported, using an audited migration
  operation to create new provider bindings. Never update immutable bindings with
  an ad hoc SQL search/replace or reuse a source numeric ID on faith.
- [ ] Scope mappings by source and destination installation, object kind and ID;
  enforce one-to-one constraints and detect duplicate/missing targets.
- [ ] Inventory references in execution settings, secrets, encrypted credentials,
  agents, deployments, notification subscriptions, API grants, audit/history and
  original operation journals. Update only current-state bindings that have an
  explicit migration rule; retain immutable historical evidence unchanged.
- [ ] Where encryption authenticated data includes provider URL/identity, use
  the existing credential/keyring service for authorized rewrapping or reenrollment.
  Blindly changing the accompanying columns is not a valid credential migration.
- [ ] Invalidate sessions, OAuth attempts, delegated grants, preview reviewer
  grants, streams, browser caches, backend caches and source-bound admission state.
  Revalidate current roles; never revive previously revoked accounts or jobs.
- [ ] Preserve private pending drafts/reviews only with verified author mapping
  and privacy; otherwise quarantine them for their owner without publishing them.
- [ ] Old repository/issue/PR links resolve through verified mappings or an honest
  historical view. Do not redirect solely on matching names/numbers. Redirects
  cannot forward credentials across origins or bypass destination authorization.

### Transfer tool contract (to implement)

- [ ] Provide plan/export/import/verify/status phases with a durable operation ID,
  exact version pins, source watermark, expected target identity and resume cursor.
- [ ] A dry run makes no destination changes and reports limits, bytes, missing
  support, required reenrollment and proposed identity mappings.
- [ ] Keep exports encrypted/private, paths and redirects validated, remote
  sources allowlisted, requests bounded, pagination complete and secrets redacted.
- [ ] Journal each target creation/import intent before dispatch. On response
  loss, inspect by recorded identity; do not blindly create another user/repo/PR.
- [ ] Import into a private, externally quarantined destination with email,
  hooks, runners, agent jobs and mirrors disabled. Preserve active source reads
  only until the explicit freeze; do not treat a moving export as final truth.
- [ ] Produce machine-readable and operator-readable reconciliation reports with
  exact hashes/counts, exceptions, remaining work and cleanup ownership.

## 8. FJ-5 — Shared UI, packaging, Operations and recovery

- [ ] Preserve the shared repository frame, tabs, settings sidebar, routes,
  fonts, keyboard controls, live updates and responsive layouts across runtimes.
- [ ] Replace current-product Gitea labels with Forgejo/provider-aware copy;
  retain Gitea labels for historical records and migration-source settings.
- [ ] Capabilities report implemented behavior on the detected server. Missing
  adapters have precise reasons; a Forgejo version string cannot mark a page ready.
- [ ] Operations shows provider kind/version, installation identity, observed
  health, latency/errors, queues, resource use and migration progress/blockers.
- [ ] Update Compose base/overlays, init scripts, local HTTPS, CLI help, sample
  environment configuration, docs and smoke fixtures together.
- [ ] Update Helm values/schema/templates/checker/NOTES and external-forge mode.
  Preserve PVC/database ownership; upgrading a chart must not automatically mount
  a Gitea database into Forgejo or rename/delete retained volumes.
- [ ] Preserve existing explicit URLs, ports and SSH host identity decisions;
  refresh known-host and OAuth callback instructions only with verified changes.
- [ ] Extend `scripts/recovery.py` and its validations for the new topology and
  actual current Golf schema. Old Gitea archives remain restorable with their
  original profile; restore must never infer a cross-product upgrade.
- [ ] Rehearse coordinated backup/restore of Golf + Forgejo + object storage,
  including credential quarantine, drained writers, fresh targets and reenrollment.
  Existing bounded Gitea recovery evidence is not a Forgejo recovery result.

## 9. FJ-6 — Required qualification matrix

Run existing applicable checks locally; the repository still prohibits adding
repository CI workflows. Fixtures may contain workflows as controlled test data.

| Gate | Evidence required |
| --- | --- |
| Source/contracts | Config alias conflicts, URL/kind identity fences, API differences, migration-map integrity, encryption and workflow precedence tests; generated API stability |
| Real portable runtime | Actual pinned Forgejo + PostgreSQL; Git HTTP/SSH/LFS; credentials/roles; collaboration/settings/package operations; restart and revocation |
| Migration fidelity | Rich Gitea 1.27.3 fixture with personal/org/private/public/empty/archived/forked repos; pending reviews, binary assets, histories and disabled users; full reconciliation |
| Fault recovery | Interrupted import, response loss, target restart, expired transfer credential, duplicate names/IDs, storage exhaustion, missing LFS/blob, concurrent source write and failed mapping transaction |
| Shared browser | Served local/Docker/Kubernetes UI, desktop/mobile, direct links, settings, source/PR navigation, sign-in/out, late private responses and live invalidation |
| CI and delivery | Exact-source run, pass/fail/cancel, fork isolation, revoked sponsor, no duplicate scheduler, logs/artifacts, protected preview expiry and digest receipt where allocated |
| Cloudflare regression | Existing native builds/checks and shared UI; Artifacts authority and CFCR execution contracts unchanged; bridge-specific proof when its origin changes |
| Performance | Same fixtures/machine/versions, cold and warm source/history/diffs/search, concurrency 1/4/16, payload size, errors, p50/p95, CPU/memory and cache state |
| Recovery/rollback | Measured full-stack restore and frozen-source rollback; explicit handling of target writes after cutover |

Starting commands include `make test`, `make test-integration`,
`make generate-check`, `make web-check`, `make engine-check`,
`make compatibility-check` and `make cloudflare-check`, plus the selected actual
native smoke and Helm checks. Inspect each target's prerequisites and ownership;
do not run an operator smoke against an existing installation accidentally.

Performance acceptance: no regression beyond an agreed baseline budget on
currently qualified scenarios; investigate >10% p95 changes rather than claiming
success from median alone. Record failed/limited large-repository cases. Declare
the hardware and fixture envelope; this is not a global SaaS SLO. Performance work
must not cache current permissions or weaken exact-source checks.

Each receipt records source state, schema, server/image/runner pins, actor classes,
fixture ownership, expected/actual outcomes, duration, missing scope and cleanup.
Use high ports and scoped service credentials; timebox resources and confirm their
absence afterward. Cloud tests retain the approved $10/day envelope; no additional
cloud spend is needed to author this plan or qualify the initial local fixture.

## 10. FJ-7 — Cutover runbook

New-install defaults and existing-install migration are distinct release gates.
An existing installation cannot be cut over until its own fidelity report passes.

1. **Prepare:** freeze reviewed source/target versions, record backup/restore
   evidence, measured outage estimate, source/target identities and rollback
   instructions. Build the destination privately; verify its capacity and support.
2. **Freeze all writers:** maintenance admission at Golf and native HTTP/SSH/API;
   stop native/Golf CI, agents, mirrors, hooks and scheduled producers. Drain or
   cancel work and reconcile uncertain effects. A Golf UI banner alone is not a
   write fence. Keep external callbacks and runners fenced too.
3. **Capture:** take a coordinated source backup and final inventory/watermark.
   Prove the source stopped changing. Re-export/reconcile changes since rehearsal;
   do not assume that Git fetch synchronizes collaboration metadata.
4. **Transfer:** import into the quarantined target using the durable journal,
   verify every data-class reconciliation and stage Golf identity/binding changes.
   Missing data or mismatched authority stops cutover while the source is intact.
5. **Bind and verify:** commit the reviewed Golf migration under maintenance,
   invalidate old authority, enroll fresh credentials and route private validation
   traffic to Forgejo. Verify source/read/role behavior and direct native policy.
   Use owned canary data for writes; the target remains closed to general users.
6. **Open traffic:** switch the reviewed routing/configuration, confirm the served
   Golf/Forgejo versions, enable one execution owner and then enable outbound
   integrations deliberately. Observe real user and machine paths.
7. **Observe:** monitor errors, latency, permission denials, queue backlog, imports,
   delivery duplication and resource use. Keep source backups and the old instance
   offline/quarantined through the retention period. Gitea never remains a second
   writable authority.

### Rollback has two different boundaries

- **Before general target writes:** restore the frozen source routing and Golf
  state as one reviewed unit; invalidate target grants and verify source authority.
  No target-only user work exists to reconcile. Never point the old Gitea image
  at the Forgejo database.
- **After target writes:** freeze both sides and inventory all new Git and
  collaboration effects. Prefer forward repair. Reverse migration requires its
  own verified transfer and reconciliation; old snapshots cannot absorb new work.
  A DNS or image rollback alone would lose data. Record the measured recovery
  path and affected users before choosing it.

No unattended deletion of the source follows a successful smoke test. The final
operator cutover/retirement action must reference the concrete reconciliation,
backup and rollback artifacts; this planning request does not execute that action.

## 11. FJ-8 — Retirement and ongoing support

- [ ] After the documented retention window and a successful Forgejo restore
  drill, retire the specific old workloads, routes, credentials and storage through
  an explicit ownership inventory. Retain encrypted historical exports as required.
- [ ] Remove Gitea from new-install defaults, current setup/recovery assumptions
  and the release qualification matrix. Keep legacy migration/restore code only
  for a published compatibility window, with clear end-of-support criteria.
- [ ] Deprecate old environment/CLI aliases with warnings and a published removal
  milestone; do not surprise retained installations with an automatic provider flip.
- [ ] Leave factual Gitea references in old evidence, license notices and source
  provenance. A zero-match text search is not the retirement criterion.
- [ ] Pin security updates, record support expiry, rehearse upgrades and rerun the
  API/permission/regression matrix before each new supported Forgejo major line.
- [ ] Update the [Gitea API/CI plan](GITEA_CI_COMPATIBILITY_PLAN.md) into a
  Forgejo-targeted operation backlog while preserving its historical evidence and
  independent GitHub Actions/GitLab compatibility goals.

## 12. Completion criteria and first implementation batch

The swap is complete when fresh installations use Forgejo, each retained
installation has a verified transfer or explicit unresolved disposition, current
Golf capabilities have their Forgejo proofs, recovery and rollback are usable,
and no active Gitea service is required by the supported destination. Cloudflare
native remains independently qualified. Missing full GitHub parity is tracked
separately and is not hidden by declaring the provider migration complete.

Start with **FJ-0 → FJ-1 → FJ-2**:

1. Capture current contracts/data dependencies and pin the reviewed Forgejo image.
2. Add explicit provider/config identity and transition aliases with tests.
3. Boot one disposable rootless Forgejo/PostgreSQL fixture and qualify auth,
   repository/Git access, one PR/review flow and immediate revocation.
4. Publish the compatibility discrepancy register before widening implementation.
5. Continue through CI, transfer tooling and deployment qualification in the order
   above; keep existing installations running until their migration gate passes.

The original planning turn made no runtime changes. The implementation now has
explicit provider configuration, persisted binding checks, workflow/UI/CLI support,
separate Compose/Helm profiles, an API dependency register, private staging tooling,
and actual native/CI/import qualification. Only checked items above are completed.

The native importer lost a private pending review in the owned rehearsal. Staging
reports retain this blocker; current-state identity mapping, complete fidelity,
coordinated recovery, performance/role qualification and retirement remain open.
The existing default and retained installations have not been switched. All
owned disposable stacks were removed; no Cloudflare allocation was required.
