# Repository feature parity execution plan

Authorized on 2026-10-10: complete repository administration, collaboration,
CI/CD, Golf Apps, security/insights and broader planning across Golf's shared UI.
Cloudflare-native uses Artifacts for canonical Git and native Cloudflare services;
portable local/Docker/Kubernetes retain their independent installation path.
This document tracks delivery, not a claim that these capabilities already work.

## 2026-10-11 execution checkpoint

The six latest priorities remain separate acceptance gates. Current native adapter
coverage is 91/298 shared procedures; this count is not feature-parity percentage.

| Priority | Delivered and checked in this increment | Still required |
| --- | --- | --- |
| Protected merge | Exact-source merge observations, current writer/source/target/lock diagnostics, revocation tests and shared mobile/desktop UI | Protected publication across every write ingress, trusted check/review authority, conflict strategies and uncertain-publication recovery. Native merge remains disabled. |
| Independent CFCR CI integration | Opt-in job broker, live execution-bound credentials, immutable job tag, isolated upload sessions and verified digest receipt; real Docker and Golf runtime checks | Hosted registry plus actual native publisher, general image-build workflows and signed workload provenance |
| Deployment lifecycle | Existing guarded release rehearsal and protected preview tests run against the new source | Complete user-facing environment approval/promotion/history/rollback and independently old frontend compatibility |
| Collaboration | Existing shared file finder plus newly available native PR diagnostics | Browser writes, inline threads, full release/fork workflows and remaining adapters |
| Performance and scale | Exact short linear comparison avoids traversing all history; 10,000-commit synthetic graph and 60 DAG oracle tests; hosted 1,000-commit history | Large file trees/diffs, branching-history bounds, concurrent independent principals/tenants and global load/cost qualification |
| Populated demo | Disposable real Git, PR/review/check/CI and protected static/Worker preview fixtures; service-auth browser navigation | A lasting curated demo with large repositories and the complete issue-to-merge-to-image-to-production journey |

The CI and performance contracts are in [CFCR integration](CFCR_INTEGRATION.md)
and [speed qualification](CLOUDFLARE_SPEED_QUALIFICATION.md). Hosted outcomes and
owned-resource cleanup are recorded in [implementation status](IMPLEMENTATION_STATUS.md).

## Delivery rules

- Reuse the shared protobuf contracts, routes, forms, tables and portable behavior.
  Implement native adapters instead of forking a second product UI.
- Show current values first, with explicit Edit/Add actions. Enable settings only
  when their reads, writes and enforcement work. Split capability flags when only
  part of a page is supported; never show a fake successful operation.
- All reads, mutations, streams, jobs, registry requests and preview visits use
  current tenant/repository authority. Private caches do not cache authorization.
- Persist mutation identity and original receipts. Version-fence edits; a lost
  response must be inspectable without repeating an external side effect.
- Keep source tests, real local runtime tests and hosted qualification distinct.
  No changes to existing tenants' visibility or destructive lifecycle operations
  during qualification. Use disposable fixtures and stop them after testing.
- Do not extend the populated demo's existing deadline or relax Cloudflare Access.
  The existing $10/day test envelope remains in effect.

## 1. Repository administration and authority

- [ ] General: rename with stable repository identity and old-link handling,
  validated default branch, description/website/topics, feature settings,
  repository templates, visibility transitions, archive/unarchive, transfer and
  deletion with explicit confirmation, operation inspection and owned cleanup.
- [ ] Native direct collaborators: inventory, enrolled-account resolution,
  read/write/admin changes, removal, durable receipts, stale-write protection,
  actor/target validation and immediate denial on subsequent revoked access.
- [ ] Invitations: accept/decline/revoke/expiry, duplicate-recipient handling,
  workspace enrollment and verified identity; no privilege from email alone.
- [ ] Teams: membership, repository grants, effective-role calculation, team
  removal and organization ownership. Preserve a recoverable administrator.
- [ ] Git credentials: repository-scoped HTTPS credentials, expiry/revocation,
  one-time secret display and audit. Portable SSH/deploy keys keep their existing
  transport; native settings describe supported transport honestly.
- [ ] All administration is visible in the same settings navigation, with native
  sub-capabilities for collaborators, invitations, teams and deploy keys.

Acceptance: admin/reader/writer/outsider and cross-workspace matrices, self/owner
protection, stale revisions including change-away/change-back, concurrent writers,
lost responses and original receipt lookup, pagination, disabled accounts,
revocation during reads/streams/jobs, shared UI desktop/mobile and both builds.

## 2. Protected source and complete PR merge

- [ ] Branch/tag rules, required checks/reviews, CODEOWNERS policy, allowed merge
  methods, force-push/delete restrictions, bypass permissions and audit history.
- [ ] Apply rules at every canonical write ingress, including Git HTTP, browser
  edits, API writes, merges, bots, imports and operator tooling.
- [ ] Inline and pending reviews, replies/resolution, review assignments,
  requested changes, dismissal rules and invalidation on a new head.
- [ ] Merge/rebase/squash consumers, conflict handling and exact candidate checks.
  Reviewer and check authority must be current and bound to the candidate.
- [ ] Durable publication journal; uncertain provider publication fences later
  writes until independently reconciled. Never replay ambiguous publication.
- [ ] Auto-merge and merge queue only after basic protected publication qualifies.

Acceptance: actual Artifacts Git clients, concurrent pushes and policy updates,
stale reviews/checks, spoofed reported checks, revoked reviewers, rejected direct
pushes and force pushes, conflict cases, lost acknowledgements and recovery.
Provider ref-update/compare-and-swap guarantees are a prerequisite to claiming
protected merge. Merely storing rules is not enforcement.

## 3. Everyday repository collaboration

- [ ] Browser create/edit/delete/upload/rename with exact source selection,
  binary/size limits, author identity, conflict detection and protected writes.
- [ ] Labels, assignees, milestones, issue forms/templates, attachments, reactions
  and activity; bounded sanitized Markdown and authenticated downloads.
- [ ] Release create/edit/delete, existing/new tag rules, immutable asset identity,
  uploads/downloads, retention and audit; release immutability as an enforced policy.
- [ ] Wiki browsing/history and authorized editing; distinct wiki source identity.
- [ ] Forks and cross-repository PRs with private source access and explicit
  credential restrictions for fork-origin execution.

Acceptance: source-bound results, permission loss, concurrent edits, escaping and
attachment content boundaries, empty repositories, large repositories and a
real create issue -> PR -> review -> checks -> merge -> release user journey.

## 4. CI/CD, environments and agent administration

- [ ] General workflow configuration, workflow permissions and dispatch;
  supported GitHub Actions/GitLab syntax continues to follow the compatibility plan.
- [ ] Execution resource inventory: portable pools and native allocations,
  scheduling, cancellation, concurrency, retries, logs and artifact retention.
- [ ] Repository/organization/environment secrets and variables, encryption,
  rotation, job-scoped disclosure, log masking and fork restrictions.
- [ ] Environment branch policy, approval, deploy history, rollback and production
  authorization separate from automatic previews.
- [ ] Preview resource policy/budgets, domains/DNS, current-reader Access grants,
  expiry and owned-resource cleanup; failures must remain inspectable.
- [ ] CFCR integration: job-scoped image push, digest receipts, image references
  on runs/releases/deployments, retention and revocation. CFCR remains independent.
- [ ] Agents: tools/model policy, repo permissions, approval requirements,
  schedules, spending limits, cancellation and audit of generated PRs.

Acceptance: genuine passing/failing jobs, denied egress, cancellation/timeout,
secret non-disclosure, stale/revoked credentials, exact image digest, isolated
concurrent jobs, protected URLs, expiry and confirmed cleanup. A configuration
editor alone does not satisfy an execution or deployment capability.

## 5. Integrations and Golf Apps

- [ ] Native webhooks: event selection, signing-secret rotation, asynchronous
  delivery, bounded retries/backoff, delivery inspection and explicit redelivery.
- [ ] Golf App registration, immutable app identity, installation and repository
  selection, explicit requested permissions and approval for expansions.
- [ ] Short-lived installation credentials, revocation, bot attribution,
  permission-limited API/event access and current tenant authority.
- [ ] Scheduled automation with durable deduplication, concurrency/cost limits,
  cancellation and PR creation under branch rules.
- [ ] First consumers: external CI/checks, AI code review and scheduled improvement
  PRs. Keep inference advisory unless explicitly authorized to mutate.

Acceptance: uninstalled/revoked tokens deny access, permission escalation refused,
cross-tenant isolation, signed webhook verification, SSRF/redirect/DNS controls,
duplicate and out-of-order delivery, interrupted schedules and budget exhaustion.

## 6. Security and insights

- [ ] Dependency inventory and update PR automation through Golf Apps.
- [ ] Secret/code/dependency scanning integrations with source-bound findings,
  dismissals, ownership, suppression audit and optional protected-merge rules.
- [ ] Repository security overview and advisory workflow.
- [ ] Contributor/activity insights and CI/deployment performance; integrate
  Operations observations rather than introducing a separate monitoring product.
- [ ] Accessible bounded charts, explicit sampling/time windows and empty/unknown
  states; no invented provider usage or billing numbers.

Acceptance: real scanner results, stale findings, untrusted output sanitization,
secret redaction, permission-scoped reports and measurable query/index budgets.

## 7. Projects and Discussions

- [ ] Projects with issue/PR links, status fields, filtering, ordering and board/list
  views; workspace ownership and per-repository visibility on linked resources.
- [ ] Discussions with categories, comments/replies, answers, moderation,
  notifications and repository permissions.
- [ ] Planning and discussion toggles in General settings; search and live updates
  follow the existing private query and activity conventions.

Acceptance: inaccessible linked repositories stay private, concurrent reorder/edit
conflicts, pagination, moderation role checks, keyboard/mobile flows and live
revocation. These require new shared contracts and portable/native consumers.

## Cross-cutting completion gate

- [ ] Update `CLOUDFLARE_CAPABILITY_INVENTORY.md` for every adapted RPC.
- [ ] Add reviewed additive D1 migrations and fresh-install schema; update native
  release/schema diagnostics and local runtime module lists together.
- [ ] Run targeted authority/mutation tests, real workerd tests and shared UI tests;
  build portable and native bundles and run `make cloudflare-check`.
- [ ] Qualify local/Docker/Kubernetes/Cloudflare behavior separately; record actual
  served release hashes and avoid attributing source changes to an old deployment.
- [ ] Benchmark cold/warm navigation, files, history/diffs and concurrent readers
  after the added settings/services; preserve source caching and authority checks.
- [ ] Complete upgrade/rollback, backup/restore and migration fidelity gates before
  declaring production parity or scalable global SaaS readiness.

## Execution ledger

2026-10-10: accepted full scope above. Existing shared navigation/layout is complete;
native General edits remain limited to description, website and topics. Work starts
with native collaborator administration and capability-aware shared subpanels.
All other unchecked items remain required; this plan does not defer or remove them.


### Native direct collaborator adapter (2026-10-10)

Implemented in source and qualified locally:

- All six `RepositoryAccessService` procedures, using existing shared contracts
  and the existing access editor; five procedures newly adapted.
- A single indexed inventory query, account resolution, explicit read/write/admin
  changes, removal and actor-bound historical receipts. No provider calls are
  needed for these D1 operations.
- One atomic receipt/grant transaction, current administrator admission rechecked
  in SQL, self-change refusal, inactive recipient refusal for grants, and tombstone
  generations for removed/re-added collaborators. Revision triggers also observe
  operator grant changes. Lost acknowledgements inspect the original operation.
- Separate native invitation/team/deploy-key flags keep their absent adapters from
  being called. Portable subpanels remain available. Organization IDs and user IDs
  no longer incorrectly collide in shared collaborator controls.
- Additive migration0011, fresh schema, release preflight/readback and schema-aware
  rollback rehearsal. Existing schema10 manifests remain supported.
- Grant changes publish existing live activity topics, waking current-authority
  stream checks without changing the wire protocol.

Validation: 86 browser cases across access/invitations/teams/deploy keys; 87 focused
native core/activity tests; 13 release-helper tests; `make cloudflare-check`; both
frontend builds; real local workerd/D1 grant/replay/removal and Access/UI checks.
The real D1 check caught trigger-inclusive mutation counts; the adapter now handles
those counts while preserving the atomic grant/receipt invariant.

Hosted schema11 rollout and native human administration acceptance remain open.
No live tenant grants were changed, no jobs/AI runs were started, and the existing
demo deadline was not extended. The remaining sections above are still required;
this increment does not complete full feature parity.


### Native invitations and everyday collaboration (2026-10-10)

Implemented in source, with shared portable/native UI controls:

- All seven invitation procedures: existing-account preview, create/list, personal
  inbox, accept/decline, revoke and original receipt lookup. Explicit consent,
  seven-day maximum expiry, duplicate-pending prevention, actor-bound receipts,
  issuer/recipient identity generations and issuer grant generations. Acceptance
  rechecks authority inside the D1 transaction and commits the grant and receipt
  together. Replaying a receipt never regrants removed access. Private invitation
  details are withheld after authority loss. This does not implement email delivery,
  enrollment, organization membership or teams.
- Repository label/milestone create, edit, delete and paginated inventory; canonical
  IDs, unique names, revision checks, explicit refused receipts, deletion tombstones
  and original operation inspection. Shared issue/PR metadata assignment and filters
  include labels, exclusive label groups, assignees and milestones. Closed/archived
  resources cannot be newly selected. Milestone counts reflect current discussions.
- Resource updates advance linked discussion revisions; deletion removes links.
  Concurrent role/account/resource changes refuse metadata writes. List metadata
  uses three batched reads instead of per-row metadata queries, with bounded row and
  byte budgets and shared label decoding within a page.
- Comment edit/delete for the current author or repository administrator. Exact
  discussion identity, author/admin authority and revision are checked in the same
  D1 transaction as the original receipt. Historical replay does not restore deleted
  content. Reactions, notification subscriptions and timelines remain disabled.
- Mutation activity refreshes issues, PRs and open resource inventories. Native
  selectors request repository labels; portable selectors retain inherited labels.
- Additive migrations0012/0013, fresh schema, guarded migration/readback/recovery,
  diagnostics and schema-aware release rehearsal now target schema13. Older release
  manifests remain supported. Every newly adapted shared procedure is inventoried:
  63 bounded native adapters of 297 procedures (234 still missing).

These increments do not complete the full roadmap. Hosted rollout, invitations for
new users, teams, repository lifecycle/Git credentials, protected merge, full CI/CD,
Golf Apps, scanning/security, Projects and Discussions remain required. No hosted
resources, live grants, Access policies or demo deadline were changed.

Validation: 118 focused browser cases (access/invitations, issue/PR metadata,
comments and live updates), 95 native core tests, seven activity tests and 15 release
helper tests pass. Both production frontend builds, `make cloudflare-check`, real
local workerd/D1 mutation/receipt/trigger checks and built UI/Access admission and
spoof-rejection checks pass. All temporary test runtimes exited. Vite still reports
an existing entry chunk above 500 kB; this increment does not qualify cold-load or
global-scale performance. Full portable server/Docker/Kubernetes journeys and hosted
schema13 migration/rollout were not run.


### Native engagement and collaboration hardening (2026-10-10)

Source implementation adds native issue/PR description and comment reactions, own
subscriptions, permission-filtered notification inbox and mark-read receipts.
Activity records and subscriber notifications commit with the admitted change;
revoked accounts receive no new notifications and cannot read retained ones. This
is in-app delivery, not email. Timeline history starts at schema14; earlier actions
are not fabricated or backfilled. Subscriptions are bounded to1,000 per discussion.

Discussion creation, plain-text/state/draft edits, new comments, reviews and
reported check paths now recheck active identity,
current credential, role/access generation and discussion revision inside their
receipt transaction. Refused admission produces neither an effect nor a successful
receipt/event. Comment IDs respect the AUTOINCREMENT high watermark after deletion.
Issue/PR/comment/review/check inventories batch authors; issue counts are selected
in the page query. A regression check requires constant D1 query counts when a page
grows from one to twenty issues.

Shared native discussion UI enables engagement independently of unavailable
attachments/templates. The native entry document identifies its sign-in runtime,
so an expired Access session still offers Access instead of a disabled password
form when authentication-option discovery cannot complete.

Additive migration0014 contains reaction/subscription generation triggers, activity
and inbox indexes, and deleted-comment cleanup. Release preflight/readback and
lost-acknowledgement recovery cover the migration; prior manifests remain supported.
Inventory now records66 bounded adapters /297 shared RPCs;231 remain missing.
**The full parity roadmap above is still incomplete.** Protected merge, teams,
lifecycle, complete CI/CD, Golf Apps, security, Projects and Discussions remain
required. Hosted rollout/qualification is recorded separately after deployment.


Hosted result (2026-10-10,05:43 UTC): migrations0011–0014 applied and read back,
then guarded release `feb2122ac0f74c01f538accf45fb15c07801ef761d18b16e51a396ec35d03ad1`
deployed as Cloudflare version `0fb349b8-90b3-467f-b644-96d25569db49`. The served
`/native/diagnostics` matched that digest and schema14.31 actual hosted requests
qualified resource/metadata changes, reactions, subscriber delivery, inbox mark-read,
transactional activity, original receipt replay and denied reads after revocation.
The verification issue in canonical (#4) was closed and its temporary label removed.

The seven existing repositories remain present. Two metadata reads per Vite,
Kubernetes, Rancher and Moby observed377–741ms on the first sample and129–219ms on
the repeated sample, including this machine's network path. These are small
samples, not a load test or global percentile claim. Full human UI acceptance after
the update remains open because the shared Access session expired; normal browser
navigation correctly returns the Access sign-in page. No email code was requested.

The old demo supervisor had exited. The user's new hosted-update request was
applied with the previously selected four-hour duration: a confirmed independent
stop timer is armed for2026-10-10 09:37:55 UTC. No CI or agent jobs were started;
the prior two preview leases remain expired. Temporary qualification access uses
a service token plus the current machine IP and repository grants, rather than an
IP-only bypass. Credential/policy retirement is recorded in the private installation
receipt. This release updates tested collaboration behavior; it does not complete
the unchecked roadmap or renew expired deployment previews.


## 2026-10-10 — Settings navigation correction

The user's report referred to the repository settings sidebar, not Cloudflare
Access login. The shared sidebar filtered out every unavailable native adapter,
so only General and Access appeared. All nine existing settings destinations now
remain visible: General, Access, Git credentials, Rules and merge policy,
Workflows, Runners, Secrets and variables, Environments and Webhooks. Mobile uses
the same inventory. Unavailable sections open their reported capability reason;
editors remain unmounted and do not call unsupported APIs. Failed capability
reads retain navigation and allow an explicit refresh. Direct settings URLs wait
for runtime discovery instead of briefly mounting a portable editor on native.

This fixes navigation and visibility, not native implementation parity. It adds
no RPC adapters, branch protection, general workflow execution or webhook worker.
The native inventory remains 66/297. The unchecked backend tasks above remain
required; visible unavailable sections must never be described as working parity.

Validation: 13 distinct focused browser cases across local/Docker/Kubernetes/native,
desktop/mobile, every unavailable destination, history navigation, delayed/failed
capability discovery and explicit recovery. The initial two new tests used hidden
responsive controls incorrectly; corrected locators passed. 102 native core tests,
both production builds, built native UI/Access admission and make cloudflare-check
passed. No schema migration or new paid execution was needed.

Hosted sidebar verified on release `f187dea82c56…` / version
`cf6513e4-a0f1-4226-a67c-f002d3bd49de`. Initial Worker/DO version skew converged at 06:02:34 UTC; actual Worker and
workspace API headers both match the new release and report its detailed
capability descriptions. General/Access, all nine entries and unavailable-page navigation were
verified in the signed-in shared browser. The existing shutdown timer is unchanged.

### Native webhook delivery (2026-10-10)

All five existing Webhook RPCs now have native adapters and reuse the shared
editor. Schema15 adds encrypted subscriptions, transactional source/discussion/
native-test outboxes, durable original receipts, sponsor generation checks,
bounded delivery leases/retries and an installation attempt budget. Operations
shows queue age/count, failed deliveries and recorded maintenance outcomes.
Installation policy explicitly approves destination origins and a dedicated
Secrets Store encryption key; unsupported email controls remain separately gated.
See CLOUDFLARE_NATIVE_SETUP.md for payload/signature format and setup.

This is a bounded native implementation, not completion of the whole integrations
section: automatic events start at installation; Actions topics represent native
tests, not arbitrary workflows. Receipts have no automatic archive/pruning yet.
General workflow execution, rules/protected merge, execution values and deployment
environment controls remain required; the sidebar alone does not complete them.

### Native branch locks and tag restrictions (2026-10-11)

- [x] Adapt all three existing Rules RPCs to native D1, using Access-authenticated
  repository administration and the existing shared forms/tables/receipts.
- [x] Enforce literal/trailing-prefix branch locks and account-ID tag allowlists on
  canonical Golf Git admission, including administrators and overlapping rules.
- [x] Recheck access, identity, credentials and rules at write reservation; deny
  stale operations without creating orphan Git operations or provider effects.
- [x] Commit policy and original receipt atomically; preserve lost-response replay,
  reject stale edits and stop rule changes during unresolved canonical writes.
- [x] Refuse rollback to pre-rules code; verify compatible predecessor bytes.
- [x] Add migration0016, new-install schema, release checks, native inventory and
  runtime-specific editor controls. Keep unsupported review/merge/team controls
  out of the native form and reject them in the backend.
- [x] Qualify source/security, migration, portable/native browser, both builds and
  actual local workerd/Access/D1 paths. See the status ledger for evidence.
- [ ] Qualify schema16 against a new, independently bounded hosted installation.
- [ ] Implement trusted review/check enforcement and protected integration with
  commit/approval freshness, fast-forward ancestry and explicit bypass policy.

The inventory now records 74/297 bounded native adapters, with 223 still missing.
These three adapters implement locks and tag restrictions, not the complete
portable Rules behavior. General Actions/workflow execution, execution values,
repository deployment environments and the other unchecked sections remain open.
The existing demo is fully removed and no provider resources were started here.

### Native repository Git credentials (2026-10-11)

- [x] Four shared Git transport/credential RPC adapters, own-account management in
  the shared desktop/mobile settings route, one-time secrets and paginated metadata.
- [x] Repository-only HTTPS read/write modes, Basic/Bearer admission, five-minute
  to one-hour lifetimes, explicit revocation and at most 100 live credentials.
- [x] Bind account/repository identity and grant generations; deny API use,
  cross-repository use, restored grants/identities and writes by read credentials.
- [x] Recheck credentials inside canonical write reservation and before returning
  Git reads. Preserve the existing enforced branch locks/tag restrictions.
- [x] Schema17 migration/recovery and generated shared binding metadata; honest
  Access sign-out semantics without inventing a portable source-session identity.
- [x] Source/runtime/real Git client, shared browser, portable Git and release checks.
- [ ] Hosted Access machine admission plus actual Artifacts clone/fetch/push and
  revocation qualification for the new credential type.
- [ ] Receive-outcome RPC, general recovery and retained-credential metadata pruning.

Native adapter coverage is now 78/297; 219 procedures remain without adapters.
Access stays enabled, SSH is not implemented, and no hosted environment was started.


### 2026-10-11 — Schema18 review collaboration and General default branch

- [x] Native reviewer request/cancel, consented enrolled identities, revisions,
  remove/re-add fencing, targeted inbox notification and completion on publication.
- [x] Native private pending overall summaries: create/edit/publish/discard,
  source staleness, own-author denial, privacy and original-operation recovery.
- [x] Native admin dismissal/restoration, latest/current-source constraints and
  shared lifecycle UI; approval eligibility remains a protected-merge task.
- [x] Exact-base bounded GitHub-style CODEOWNERS suggestions with unsupported-rule
  reporting. This is advisory, without automatic requests or team membership.
- [x] Native existing default-branch editor, atomic settings/authority guard,
  source invalidations and matching Golf Git HEAD advertisements.
- [x] Additive migration18, compatible rollback floor, generated adapter inventory,
  shared builds, targeted browser/backend and real local workerd/D1/Access checks.
- [x] Bounded hosted service-account qualification of schema16–18, actual Artifacts,
  scoped credential/branch-lock/private-draft fixtures, default-branch Git HEAD,
  guarded rollout/rollback/promotion and complete owned teardown.
- [ ] Positive hosted human-only reviewer/credential/rules mutations and secure
  browser authentication; service credentials must continue to be denied.
- [ ] Complete protected merge, inline/saved-diff review authoring and thread
  interactions, then browser writes and lifecycle before general CI/CD migration.

Evidence:150 focused backend/Git tests,48 browser tests,22 release tests, full
Cloudflare checks and both builds pass. The updated inventory is89/297 bounded
adapters;208 remain. No whole section above becomes complete from this increment.
That source-only checkpoint started no cloud resources. Subsequent hosted release
`d20a2a027cb1d…` passed the bounded service-account suite and all 24 owned resource
groups were removed at 06:00 UTC; see the latest
[implementation status](IMPLEMENTATION_STATUS.md). Small fixture timing and one
live-event observation do not establish large-repository or global scale targets.


### Repository discovery and keyboard polish (2026-10-11)

- Shared **Go to file** dialog and `t` shortcut on local, Docker, Kubernetes and
  Cloudflare-native. Case-insensitive filename/path terms search the whole bounded
  snapshot, including unopened directories; results link to that exact commit.
  Enter opens the first match; arrow keys navigate results. No file bytes are
  downloaded for search. The UI renders at most 50 matches and reports the total.
- New authenticated `GetRepositoryFileIndex` contract. Portable traversal uses
  supported forge object APIs with current permission checks before and after.
  Native traversal uses Artifacts, four concurrent reads and shared-tree reuse;
  immutable D1/R2 indexes avoid repeat provider reads under fresh authority.
- Complete results or an explicit error: at most 10,000 files, 512 directories
  including root and 1 MiB of path bytes, plus existing literal-path bounds.
  Submodule repositories are not traversed. This is filename search, not full-text
  code search or an unbounded large-repository search index.
- The dialog discards its private inventory on close and rejects wrong repository,
  commit and malformed-path responses. No filename inventory enters browser
  storage. Shared dialog focus restoration now survives StrictMode effect replay.
- Native clone menus link directly to repository Git credentials. Portable SSH
  configuration remains linked when SSH transport is available.

Validation: 25 file-finder/source-navigation browser checks passed, including all
four runtime profiles at phone and desktop widths, literal Unicode paths, unchanged
SPA document identity, keyboard focus, authority loss and malformed/oversized
inventories. Native cache tests verify a warm read with Artifacts unavailable and
reject access loss despite the saved index. Both frontend builds, the server unit
suite, `make cloudflare-check` and real local workerd/Access/D1 runtime checks pass.
Race-enabled PostgreSQL authority checks and the hosted Git inventory comparison
also passed; release and cleanup evidence is recorded in the implementation status. No protected-merge acceptance is implied.
