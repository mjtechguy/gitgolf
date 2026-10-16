# Protected integration: implementation design and qualification sequence

Proposed implementation design, 2026-10-03. Applies to both infrastructure tracks. **No protected merge, squash, rebase, merge queue or new publication authority is implemented or qualified by this document.** P0.8 remains open. This expands [proposed ADR 0004](decisions/0004-protected-integration-enforcement.md) into work packages; it neither accepts that ADR nor relaxes the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md).

## Decision and evidence

Continue with the fully mediated publisher experiment on an unchanged native forge. The earlier experiment ran on the since-retired backend; it has not been repeated on Forgejo 15.0.9. First prove a complete admission boundary and interrupted-publication behavior in a disposable installation. Build production merge authoring only after that gate passes. Keep the scoped publisher and exact-candidate Git transport; do not replace them with a preflight check followed by the native merge endpoint.

Earlier live protected-write and publisher qualifications and a mutation-boundary inventory, all on the since-retired backend and not repeated on Forgejo, established these constraints:

| Primitive | Supported useful behavior | Remaining gap |
| --- | --- | --- |
| Native synchronous merge | Explicit expected head and native permission/protection checks | No caller expected base or precomputed candidate; native approval dismissal can lag a push |
| Native required status context | Displays producer assertions and enforces configured names | A code writer can assert the required success; the name is not trusted execution evidence |
| Scoped merge/push allowlists | Tested denial of ordinary/owner publication under the configured strict rule | Authorized settings changes, alternate writers, old accepted requests and fork source writes remain separate boundaries |
| Exact Git candidate plus explicit base lease | Publishes the selected C; rejects a changed B | Does not reserve live source H, review decisions, membership, policy or publisher authority |
| Supported manual-merge bookkeeping | Records an already published candidate in native PR state | Requires independent proof of the actual published object, operation identity and finalization outcome |
| Durable experimental uncertainty record | Stops the experiment from replacing an issued operation | Does not enforce a new epoch inside an already accepted native write |

The pinned [merge API handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/pull.go) passes an expected head to synchronous merge and uses a distinct scheduled path. Its PR read handler can start delayed checking. Native merge uses a provider lifetime context, so request cancellation does not establish write cancellation. [Pinned merge service](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/pull/merge.go).

**Conclusion:** current native routes alone cannot implement Golf's full protected contract when independent writers remain. A managed gateway is a candidate composition whose exclusivity must be demonstrated. A supported upstream conditional-publication extension remains the fallback if complete mediation cannot be proved. This decision retains the required merge/squash/rebase scope; it does not turn the missing enforcement into an optional feature.

## Read-only current installation observations

On 2026-10-03, the then-running local installation used the since-retired backend, with loopback native HTTP `3001→3000` and SSH `2222→2222` published. `GET http://localhost:8080/readyz` returned database and forge ready. Running Golf image prefix was `b54ca4a502f5`. These are exposure/readiness observations, not authenticated policy or protection proof. No token, password, environment or native database was read for this inventory; no mutation or restart was performed.

The checked-in [Compose configuration](../compose.yaml) exposes those direct native ports, disables native Actions, and does not establish the proposed mutation broker. The [Helm network policy](../deploy/helm/golf/templates/networkpolicy.yaml) admits Golf to native HTTP and configurable ingress to native HTTP/SSH; it classifies peers and ports, not HTTP operations. Neither topology currently proves complete mutation admission. Other running projects were outside this task and were not changed.

Safe repeatable inspection, without resolving Compose environment secrets:

```sh
docker ps --filter name=golf- --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
curl -fsS http://localhost:8080/readyz
```

These commands intentionally do not claim to enumerate background schedules, mirrors, custom hooks, grants or in-flight native child processes. Those need supported authenticated inventory plus a disposable negative qualification. Do not infer their absence from readiness, Actions being disabled, an empty Golf queue or an inaccessible native HTML page.

## Smallest architecture that can satisfy the invariant

Use existing PostgreSQL for durable admission records and a dedicated broker for native mutation dispatch. A new general workflow engine, Valkey lock or Cloudflare Durable Object is unnecessary for the first experiment. Coordination storage is not itself the effective write fence.

1. **One complete provider boundary.** Native HTTP/SSH are unreachable by ordinary clients, agent/runner containers and general Golf replicas. Native HTTP access goes through an authenticated operation classifier. Workers cannot contact the native provider directly, possess publisher credentials or submit arbitrary upstream requests/refspecs. Read handlers may pass through the classifier without publication reservations only when their actual effects have been classified; `GET` is not a universal exemption.
2. **One mutation admission owner.** Every admitted operation is bound to the stable forge/account/repository IDs, current authorization and an exact operation class before upstream dispatch. Do not rely on a convention that individual handlers remember to call a lock function. All native outbound write access is structurally confined to the broker. Direct operator intervention follows the separate suspension/quiescence workflow below.
3. **Durable reservations.** Before dispatch, commit a reservation and an immutable dispatch intent in Golf PostgreSQL. Conflicting mutations cannot pass a reservation in `dispatching`, `uncertain`, `published` or `finalizing`. Losing a process, SQL connection, HTTP client, heartbeat or wall-clock lease does not release it. A database outage denies new conflicting dispatches. Read/API replicas can remain available when their permitted reads are safe.
4. **Short final predicate interval.** Prepare and test C outside the final reservation. Reserve the relevant source, target, PR, review and policy resources; reread H/B/P/A/E/F; then publish while all mutations that could invalidate them are excluded. Release only after the native write has a classified terminal outcome and native bookkeeping is reconciled. No CI job holds the final reservation throughout its execution.
5. **Supported Git publication.** Construct candidates only in Golf-owned temporary repositories. Fetch through supported authorized Git transport. Publish exactly one declared target branch update through native receive, with `--force-with-lease=refs/heads/TARGET:B`, and independently require B to be an ancestor of C. Never write provider refs, hooks, tables or repository paths directly. Explicit leases use full object IDs; implicit remote-tracking leases are disallowed. [Git push contract](https://git-scm.com/docs/git-push).
6. **Conservative recovery.** An uncertain issued write blocks overlapping mutations until supported provider process/node quiescence and reconciliation prove the old operation cannot later publish. A new SQL epoch, disconnected socket, token revocation or successful subsequent GET cannot supply that proof. Automatic cross-node takeover is not admitted until separately qualified node/storage fencing exists.

Absolute time expirations are an additional feasibility check, not a mutation that a gateway can make wait. If P requires a credential, approval, evidence or deployment authority to remain valid at the effective native write instant, an expiry while an accepted write is paused must reject that write. A client timeout or “sufficient remaining lifetime” estimate cannot prove this. Qualification must either establish supported provider-side expiry enforcement at publication, or an explicitly accepted operation-authority contract whose validity is reserved for that admitted operation and whose revocations are ordered by admission. Do not silently grandfather session/grant expiry to make the experiment pass. If the existing required semantics demand immediate expiry/revocation of an in-flight native write, unchanged-provider mediation is insufficient and the upstream effective-write extension is required.

For the first disposable experiment, an **instance-wide final mutation reservation** is a defensible simplification: all classified native mutations use it, so source forks, team grants and repository transfers cannot fall outside a partially implemented resource graph. Ordinary preparation/test execution and safe reads remain concurrent. Measure the final critical interval. Before production throughput claims, replace it with a qualified stable-ID resource graph; do not silently omit identity-wide or organization-wide conflicts to gain speed. Both configurations must preserve the same safety predicates.

HTTP Git receives can initially reserve the entire operation without parsing every packed object, because the instance-wide barrier excludes all conflicting mutations. Still validate authenticated repository identity, permitted receive service, protocol/body bounds and unsupported push options/forms before forwarding. Classify multiple refs, force/delete/tag/wiki/AGit/create-on-push semantics; reject forms not yet qualified. A minimal single-branch fixture is a proof step, not completion of all ordinary Git operations.

The first managed fixture may leave SSH off while proving HTTP admission. Full SSH parity remains required: add an authenticated protocol-aware adapter that participates in the same reservations, or qualify a supported provider extension. A raw SSH tunnel or native public listener cannot advertise the managed protected guarantee.

## Integration intent and admission state

The proposal is an immutable record, not a merge eligibility boolean. Preserve values and evidence separately from display labels:

| Binding | Fields / meaning |
| --- | --- |
| Identity | Forge ID, target/source native repository IDs, native PR ID and issue ID, immutable requester/sponsor identity; names are routing metadata only |
| Selection | Full source and target refs, exact H and B, selected merge strategy, canonical request fingerprint and caller idempotency key |
| Candidate | Exact C, tree ID, ordered parents or replay chain, object format, candidate-generation configuration/version and signing result where required |
| Policy | Applicable rule resolution, generation, enabled modes, required checks/reviewers/code owners, linear history/signing/conversation rules and deployment eligibility generation |
| Approvals | Native review IDs, exact reviewed commit, reviewer immutable identity, eligible current grants/team membership, decision and dismissal/revocation information |
| Evidence | Authorized producer/enrollment, immutable workflow definition, exact candidate, run/attempt/lease identity, policy/grant epoch, final result and required artifacts |
| Authority | Scoped publisher identity, deployment/provider incarnation and durable reservation/operation identity; unrelated account presence is insufficient |

Recommended proposed states:

```text
requested → preparing → waiting_for_evidence → ready
    ready → reserved → dispatching → published → finalizing → completed
                 ↘ invalidated           ↘ uncertain       ↘ uncertain
    preparing / waiting / ready → canceled / rejected / invalidated
```

`uncertain` has no time-based path back to `ready`. Cancellation after dispatch is a request to inspect/reconcile, not an assertion that publication was prevented. A server crash after reserving but before a proven dispatch boundary is also conservative: use broker process/intent evidence to classify it; do not infer “not sent” from missing acknowledgment. A duplicate key never dispatches again. Different input with the same key is rejected. A new key overlapping an uncertain operation is denied until that operation is safely reconciled.

Do not define a protected state from an existing issue-mutation journal, ordinary runner observation or native `mergeable` flag. Those have different effect and authority contracts. Proposed tables and generated procedures need their own migration, immutable-history guards, recovery treatment and API authorization design before implementation.

## Candidate semantics for every required merge mode

Pin Git/toolchain and effective merge configuration in candidate evidence. Start with ordinary textual repositories in the disposable proof, then extend the corpus to rename/delete conflicts, submodules, binaries, LFS, attributes, signatures and large histories before claiming their support. Never execute repository-supplied hooks, external merge drivers, filters, helpers or arbitrary config while preparing a trusted candidate. Use clean controlled configuration and scoped fetch credentials; credentials must not reach tests or artifacts.

| Mode | Exact publication contract | Required qualifications |
| --- | --- | --- |
| Merge commit | C is generated once from B and H, has ordered parents `[B,H]`, and its tree is the accepted merge result. Test C and publish that identical object. | Conflicts, unrelated history, fast-forwardable source still producing the selected merge mode, deterministic configuration and message/author/signing changes invalidating C |
| Squash | C has single parent B and the accepted squashed integration tree derived from the selected B/H. H need not be an ancestor of C. Preserve attribution and the immutable source selection in Golf's operation record. | Multiple source commits, conflicts, empty result, binary/mode/rename changes, exact user-selected title/body and attribution, supported native manual bookkeeping despite absent H ancestry |
| Rebase and merge | Construct a controlled replay chain whose first new parent is B and whose final commit is C; record original→replayed object mapping. Test the final chain and publish it without rewriting the source branch. | Empty/cherry-picked commits, conflict behavior, source merge commits and explicit replay policy, attribution/signature loss and required signature handling, native finalization for rewritten history |
| Fast-forward | C=H and B must be an ancestor of H; no generated replacement commit. | Changed B, non-ancestor denial, exact evidence at H and source freshness during publication |

Rebase is not assumed equivalent to cherry-picking every reachable commit. Decide and expose how source merge commits and empty commits are handled; prove that policy with a native fixture. If linear-history or signed-commit policy excludes a candidate/mode, explain that specific denial rather than changing mode silently. [Git merge semantics](https://git-scm.com/docs/git-merge), [Git rebase semantics](https://git-scm.com/docs/git-rebase).

A mode/message/author/signing change generates a different candidate and invalidates candidate-bound evidence. Source H change invalidates exact-head approval/evidence. Target B change creates a new candidate and re-runs candidate-required checks. Returning to an old H or B does not revive revoked grants, dismissed reviews or prior publication authority.

## Approval and trusted check evaluation

Review presence/count is insufficient. Collect every required native review page, verify stable PR/reviewer identity, exact reviewed H, current decision and dismissal, and resolve effective reviewer/team eligibility under P. Deduplicate reviewers; honor active change requests, author self-approval restrictions, configured code-owner requirements and required conversation resolution. Missing/ambiguous/incomplete review or ownership data yields a typed blocked reason. Do not accept an asynchronously refreshed stale flag in place of the reviewed commit. Native review submission records commit identity, but freshness and eligible grants still require Golf's final binding. [Pinned review service](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/pull/review.go).

Human review creation/dismissal/re-requesting can be built independently through supported APIs with immutable selection and uncertainty handling. Protected publication stays gated until those mutations participate in the complete admission boundary. A read-only list of old reviews is useful display evidence, not authorization to merge.

Required Golf checks use Golf-owned finalized execution evidence at the selected candidate. Validate exact run/attempt/grant/policy identity and current issuer authority; reject canceled, superseded, partial, unknown or terminal results from the wrong producer/candidate. Agents may supply advisory reviews and proposals; a successful agent reply alone is not a trusted required check. An optional external check producer needs explicit enrollment and its own provenance/revocation contract.

Native commit statuses remain visible as native observations. An ordinary writer posting `success` under a required-looking context does not satisfy trusted Golf evidence. UI badges must distinguish observed provider statuses, trusted completed checks and publication readiness. A native status failure may be an additional configured denial; native success cannot override missing trusted evidence.

## Private forks, independent writers and connected origins

The managed guarantee applies only when both source and target plus their relevant identity/policy authorities share the qualified boundary. Resolve and authorize actual native source repository/ref H; a retained target PR ref, deleted source fallback or cached list head cannot substitute. Obtain private fork objects through separately authorized supported transport, without a site-admin shortcut. Source rename, transfer, deletion, permission removal and branch rewrite are conflicting admitted mutations.

For a connected external GitHub/GitLab repository, import/sync creates a Golf-owned destination with recorded provenance. The external live branch does not share Golf's reservation. Do not advertise immutable live-source enforcement for an external source unless its provider has a separately qualified effective-write contract. Preserve imports, synchronization and cross-forge workflows as requirements; classify their protection semantics explicitly.

Operator or owner changes cannot silently bypass this promise. Emergency operation enters `suspended`, excludes new admissions, settles or fences issued writes, then grants narrowly scoped native access. Resume requires a new eligibility generation and a complete native state/config/background-writer inventory. An owner clicking Edit protection in Golf uses the same reservation; an out-of-band provider owner or cluster administrator is a privileged operating boundary whose use suspends the guarantee. This is not protection against the host/storage administrator secretly modifying the installation.

## Native PR bookkeeping and post-merge branch deletion

After exact-C publication, verify the observed target, candidate parents/tree, operation identity and retained authority. Under the reservation call the supported `manually-merged` API only for the bound PR/C. Preserve `published / finalization pending` if bookkeeping is unknown. Native history membership alone is not proof that this operation published the authorized candidate. The pinned native service checks that the supplied commit exists in branch history; Golf must supply the stronger selection proof. [Manual merge service](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/pull/merge.go).

Independently qualify bookkeeping for merge, squash, rebase and fast-forward: rewritten source ancestry and native PR-check processing can differ. The API/manual style must be enabled for the scoped broker without opening ordinary manual-mark routes. Reconciliation may inspect observed outcome; it must not repost after uncertainty merely because an old PR GET still shows open. Provider asynchronous processing and native auto-detection need explicit experiments.

Source branch deletion is a separate post-merge intent with expected current source H, present authority and default/protected-branch rules. If source changed after completion, retain it. Delete failure does not turn a successful merge into a failed publication. Do not enable native automatic deletion while it remains an unmediated mutation or lacks the selected identity/lease behavior.

## Implementation work packages

All tasks below are required pending work, not completion claims. Work remains aligned with P0.8/P2.3/P3.6/P4.9 and the existing parity matrix.

| Order | Work package and concrete deliverable | Acceptance / dependency |
| --- | --- | --- |
| 1 | `P0.8-BOUNDARY-1`: add disposable fixture topology with private provider, classified broker ingress and native HTTP Git receive; reuse scoped actors and existing publisher fixture. Capture version/digest and complete admitted operation inventory. | Demonstrate direct API/web/SSH/internal-port denial, authorized reads/pushes, local email/password login and exact OAuth consent/exchange/revocation. Unknown routes denied; method alone never decides safety. No main runtime change. |
| 2 | `P0.8-ADMISSION-1`: add durable before-dispatch reservations to the fixture. Begin with one instance-wide conflicting mutation domain, explicit operation/body fingerprints and stable IDs. | Concurrent source/target/review/policy/identity mutations order correctly; SQL loss/restart never opens an uncertain reservation. No blanket native bearer proxy. |
| 3 | `P0.8-PUBLISH-1`: reuse exact-C supported receive and manual bookkeeping; add source/base/approval/producer/authority barriers and deterministic pauses. | Complete counterexample corpus becomes negative evidence: no old-authority/source/policy publication. Both same-repository and private-fork actors pass without admin credentials. |
| 4 | `P0.8-RECOVER-1`: qualify interrupted accepted write plus supported provider quiescence; preserve reservation/operation across Golf/broker restart and fresh recovery target. | Old provider/child cannot resume after fence. Reconciliation is not blind retry. Latest schema033 refusal stays unchanged until its complete recovery contract separately passes. New publication schema extends recovery gates rather than ignoring them. |
| 5 | Accept or reject ADR0004 based on 1–4. If rejected, specify the upstream-supported extension contract and qualify a supported release; do not ship a silent native fork. | No merge-readiness claim or production publication before accepted design and complete gate evidence. |
| 6 | Productize immutable integration intents, candidate preparation and broker; generated typed read/write/status procedures, CLI/MCP bindings, audit and private activity invalidation. | Reuse explicit current values/Add/Edit UX and TanStack forms; enforce Origin, user/sponsor authority, exact request identity and non-retrying status inspection. No publisher secret in clients/runner/agent. |
| 7 | Add exact-mode merge/squash/rebase/fast-forward candidates and test workflows on those candidates. | Each mode passes candidate/object/ancestry/conflict/bookkeeping corpus, including empty/replayed/binary/signing policy. CI producer trust is separately established. |
| 8 | Deliver GitHub-style merge panel, strategy menu, check/review reasons, candidate queue state, final merged receipt and separate delete-branch action. | Real native actions; draft/conflict/check/review/authority reasons visible. Authenticated screenshots both themes/widths; live changes invalidate selection without silently re-authorizing it. |
| 9 | Scale reservation domains, qualify mediated SSH, resource graph, multiple broker/read replicas and provider-version upgrades. | Stable lock order includes cross-fork/org/team/user resources; concurrency/partition/load evidence. Unknown version/route/background writer disables protected eligibility. Full ordinary Git capability corpus remains required. |

The first task is a qualification topology, not a production general proxy. Keep its operation set narrow and explicitly report denied pending families. Passing the narrow experiment is a prerequisite to implementing those families, not permission to claim entire provider mediation. Product installation changes need corresponding Compose/Helm/TLS/recovery tests, including configured generic remote infrastructure and optional Cloudflare backends.

## Native fault and negative test matrix

Every pause must occur at a recorded point in the actual provider/broker request path. A random sleep, serial happy path or mock returning an expected status cannot prove ordering. Existing characterization harnesses may be reused but their exit zero does not mean P0.8 passes.

| Experiment | Required result |
| --- | --- |
| Pause after final rereads; advance source H or target B independently | Conflicting write orders first and invalidates C, or waits through publication. No publication using obsolete binding. Repeat private fork and same repository. |
| Pause accepted receive; kill broker / lose SQL / disconnect client | Replacement and all overlapping admitted writes remain blocked. Resuming old accepted write cannot race a replacement. |
| Pause accepted write; revoke publisher or change policy/approval | Mutation cannot take effect ahead of the reserved publication; if it already ordered before admission, old intent is denied. Revocation return semantics reflect that ordering. |
| Provider accepts C; response or SQL finalization is lost | One observed exact update; persistent unknown/published state, safe readback and supported bookkeeping reconciliation; no duplicate push. |
| Same key concurrent requests, different key overlapping unknown request | Same input has one dispatch; changed input rejected; different key cannot bypass uncertainty. |
| Forged success context, fake stdout event or stale attempt outcome | Native observation visible if authorized; trusted Golf requirement remains unsatisfied. |
| H1 approval then H2 push, immediate native stale dismissal lag | Golf rejects H1 review for H2 irrespective of native stale flag. An independently accessible native merge route is a failed boundary. |
| Draft, conflicts, unresolved review/conversation, ineligible reviewer | Specific denial; target unchanged; no force/admin bypass through the same user endpoint. |
| Rename/transfer/name reuse/source deletion mid-admission | Stable-ID mismatch or reserved ordering; no write to reused route identity; no retained-ref replacement for live source. |
| Existing auto-merge, mirror, import, custom hook or operator writer | Managed eligibility rejected or source demonstrably quiesced before admission. Inspect previously queued/accepted work, not just configuration flags. |
| Alternative HTTP/web/SSH/deploy-key/internal endpoint and Git push form | Denied without raw provider access, or independently classified/authenticated/reserved. Include alias paths, double encoding, slash refs, query/body variants and method overrides. |
| Failed/restarted/recovered publication database | No old cookies/grants/attempt authority revived; uncertainty preserved. Latest-schema recovery remains refused until exact coordinated recovery passes. |
| Merge, squash, rebase, fast-forward with manual bookkeeping response loss | Published object exactly matches selected candidate; PR outcome reconciles once; unsupported native bookkeeping behavior blocks that mode until fixed. |
| Source advances after completed merge but before deletion | Completed merge remains successful; advanced source branch survives. |

Record exact native/Git/toolchain/image versions, real actor roles, relevant config digests, immutable selections, final target objects, counted native writes, chronological barrier events and cleaned owned resources. Exclude secrets/headers/pack contents/private source from public logs. Run on disposable projects with no imported workflow execution, paid inference or remote pushes. Do not overlap the primary runtime's qualification/deployment.

## Infrastructure tracks and capability presentation

Portable Docker/Kubernetes use the same publisher and supported provider transport; PostgreSQL remains sufficient for durable intent/admission bookkeeping. R2/S3/RustFS may retain bounded candidate evidence/artifacts under current authorization. Object storage does not reserve a Git branch. Valkey can accelerate cache/notifications later but cannot replace the durable uncertainty barrier.

Cloudflare may supply optional edge ingress, Access/operator perimeter, storage, queues and coordination. Cloudflare Workers/Queues/Durable Objects cannot revoke a native Git write already accepted by a container or independent provider. Both tracks require the same native write admission, source/policy fencing, exact trusted candidate and conservative recovery. Add a Cloudflare broker execution/transport adapter only after the portable contract is qualified; test provider-container lifetime and recovery separately rather than inheriting Docker fencing claims.

Show detailed readiness at the level where it is true: observations for native permissions/reviews/statuses; configured candidate requirements; managed-boundary qualification state; durable intent state and typed blocked/unknown reasons. A green check row or an active integration backend must not light up protected merge readiness. The user-facing panel can follow GitHub's layout and strategy controls while preserving Golf's explicit current capability state.

## What is complete after this design

Research, implementation sequencing and a read-only local exposure/readiness inventory are complete. No gate was rerun or changed, no production code/schema/runtime was modified, and no protected publication is enabled. Remaining tasks above are concrete implementation work under the full original repository/PR/Actions parity goal. P0.8 and schema033 recovery remain unresolved.
