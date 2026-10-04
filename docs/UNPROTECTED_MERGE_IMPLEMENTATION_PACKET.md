# Native unprotected merge workspace: implementation packet

Proposed 2026-10-04 against product source `830ebb7dd991d85588c9aaaa11db081789dc5708` and pinned Gitea1.27.3. This isolated proposal implements nothing and qualifies no merge. No native requests, fixture, migration, protocol changes or deployment were performed for this research.

## Recommendation and release gate

Build the exact, authorized **merge observation/workspace** first and separately characterize native immediate strategies. Do not enable a merge action on the strength of `mergeable=true`, an unprotected preflight observation or a native expected-head field.

[ADR0004](decisions/0004-protected-integration-enforcement.md) explicitly retains native merge API/auto-merge for separately qualified unprotected capabilities. The full protected H/B/C/P/A/E/F invariant in that ADR and the [protected merge design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md) remain required. An unprotected native operation would be a distinct contract: immediate integration of fetched source H against the provider's fetched base, without a caller-conditional B or pretested C guarantee. It is not protected integration, a merge queue, auto-merge or trusted check evaluation.

There is one concrete **dispatch blocker**: native POST does not accept `require_unprotected=true`. A branch can become protected after Golf observes it as unprotected. The handler accepts protected merges when native checks pass; the receive path can permit admin bypass. `force_merge=false` does not mean “reject every protected branch.” Thus the current deployment cannot guarantee the categorical refusal of protected targets for the whole successful write interval. A Golf transaction or a second GET cannot repair that interval.

Before dispatch can be enabled, qualify a supported way to preserve protection absence through the write, covering native protection administration, retargeting, already-issued requests and independent provider access. A narrowly mediated protection/retarget boundary may be investigated as a subset of the existing ADR, but it is not established by present ingress. Alternatively obtain an upstream-supported conditional unprotected operation. Without either, ship truthful observations and retain unavailable dispatch. Choosing weaker “observed unprotected at admission, native protection later governs” semantics would be a new explicit decision; it must not be silently substituted for the existing protected-workflow refusal.

## Pinned native facts

| Supported surface | Actual meaning | Consequence |
| --- | --- | --- |
| GET `/repos/{owner}/{repo}/branches/{branch}` | Handler finds the exact branch and its first effective protection rule. Converter emits `protected` and caller `user_can_merge`; rule name is restricted to repository administrators. | Require explicitly present booleans and exact branch/commit. No admin-only rule listing, inferred wildcard matching, or missing=false fallback. These remain observations. |
| Repository metadata | Explicit allow flags for merge, squash, rebase, rebase-merge and fast-forward-only, plus default style. | Allowed strategy is not merge readiness. Preserve false versus omitted metadata. |
| POST `/pulls/{number}/merge` | Immediate modes: `merge`, `squash`, `rebase`, `rebase-merge`, `fast-forward-only`. `manually-merged` is bookkeeping, not this operation. | Expose only independently qualified modes; do not translate names into equivalent algorithms. |
| `head_commit_id` | Compared to the source fetched into the temporary merge repository before merge construction. | Reject stale H; this does not fence later live-source changes or specify B. |
| Native merge construction | Fetches current base, generates result, performs normal push, then postprocesses native PR/accounting. Lock is per PR. | A changed base may be integrated; postprocessing can fail after Git success. Native output is not Golf's pretested C. |
| Native operation lifetime | `Merge` uses the provider hammer context instead of the request cancellation context. | Timeout/client abort does not prove no effect; never blindly resend. |
| Scheduled merge and branch deletion | Separate effects/branches in the same endpoint. | Hard-code `merge_when_checks_succeed=false`, `force_merge=false`, `delete_branch_after_merge=false`; omit manual merge ID. Separate future operations need their own qualifications. |

Primary pinned sources: [branch handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/branch.go#L31), [branch conversion](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/convert.go#L65), [merge form](https://github.com/go-gitea/gitea/blob/v1.27.3/services/forms/repo_form.go#L522), [repository options](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/structs/repo.go), [merge handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/pull.go#L883), [native permission/readiness checks](https://github.com/go-gitea/gitea/blob/v1.27.3/services/pull/check.go#L142), [head preparation](https://github.com/go-gitea/gitea/blob/v1.27.3/services/pull/merge_prepare.go#L63), [merge/push/postprocess](https://github.com/go-gitea/gitea/blob/v1.27.3/services/pull/merge.go#L222), [protected receive](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/private/hook_pre_receive.go#L170). Existing live limitations are in [protected write qualification](GITEA_PROTECTED_WRITE_QUALIFICATION.md) and [publisher qualification](GITEA_PUBLISHER_QUALIFICATION.md); their historical unprotected merge does not qualify this product slice.

## Contract to freeze before implementation

Reuse `RepositoryKey`, canonical signed64 decimal native IDs, lowercase full native-format object IDs, UUIDv4 operation IDs and the existing exact pull selection. Do not infer identity from owner/name alone. The observation is new read data, not an executable permit.

Proposed messages/RPCs (names provisional; no descriptor added):

- `GetPullRequestMergeObservation(target)` requires canonical repository key/native repository ID, PR number/native PR ID. Returns current canonical routing and immutable IDs; source repository/ref/H, target repository/ref/B, M if independently established, current pull revision; explicit current unprotected/protected/unknown and caller merge-allowed/denied/unknown observations; allowed strategy inventory with observed native default; open/draft/merged/conflict/checking observations and capability reason codes. Return a fingerprint of those observations for stale confirmation detection only. No readiness percentage or authorization token.
- Later `MergePullRequest(target, sourceRepositoryId, sourceRef, baseRef, observedHeadCommitId, observedBaseCommitId, expectedPullRevision, observationFingerprint, strategy, operationId, title?, message?)` freezes one explicit action. `observedBaseCommitId` detects changed preview before dispatch; it must not be named `expectedBase` or described as a native write lease. The same key plus changed input is refused; replay returns journal status without another POST.
- `GetPullRequestMergeMutation(target, operationId)` is inspection only. Returns frozen IDs/refs/H/observed B/strategy/input fingerprint, phase, bounded failure code and separately verified native observations. It cannot adopt another actor's merge, dispatch a missing record, or infer no effect from404.

The write/status surface is managed browser-session plus exact Origin only initially, with no PAT/bearer or MCP write grant. Observation delegation can be separately allowlisted read-only after exact ID/authority tests. No new CLI merge command until its explicit authorization contract is qualified.

Use source/target ID and ref checks before and after each bounded read through `withRepositoryRead`/managed-session helpers. Reobserve current caller identity and native write authority, exact PR ID/number, actual live source branch and current base branch. Reject retained PR refs, deleted/renamed source refs, missing source repository, retargeting, target/source transfer, archived/mirror/disabled PR unit, draft/closed/merged and unsupported/unsettled metadata. Never use instance-admin credentials as a native write override. Same-repository PRs are the initial positive corpus; private forks require their own independently authorized source observations before inclusion.

Refuse every observed protected target, even when native `user_can_merge=true`. Golf protection/merge policy is not yet implemented: an unknown or unqualified applicable policy is a refusal, not equivalent to “none.” CI execution policy is not merge policy. At implementation time define the explicit instance/repository capability admission state; don't invent an implicit absence or a checkbox that creates enforcement. Even confirmed preflight absence does not satisfy the interval gate above.

One bounded read deadline (propose15s), exact native count/identity validation, no external fetch and no broad cache apply. Confirmation must show a selected immutable H; refresh/reload cannot silently replace it. Reobservation is required at explicit dispatch; no background or live event can invoke a write.

## Durable effect and privacy design

A future migration number is **unallocated**; migration039 belongs to Actions. Do not create040 as part of this proposal.

Reuse the existing managed-session reservation/event patterns, but reserve merges across the **target forge/repository/base ref**, not per user or only per PR. Different PRs and actors can overlap the same target. The journal orders Golf intents only; it must explicitly disclaim fencing direct native/Git/background writers.

Freeze forge identity, Golf/native actor and original session identity, native source/target/PR IDs, names as historical observations, refs/H/observed B, strategy, operation UUID, request/body fingerprints and timestamps before possible dispatch. Store private title/message only in deliberately encrypted content with full keyring startup/rotation/retirement/recovery accounting, or omit custom content in the first slice and deliberately use native defaults. A journal fingerprint alone cannot reconstruct later mutable native defaults or prove their exact original contents. Never log authorization, private commit message bodies or raw provider errors.

Phases: `RESERVED` → either durable `REJECTED` before any POST or durable `DISPATCH_UNKNOWN` before the single POST → `SUCCEEDED` only with an actual native acknowledgement plus complete qualified independent receipt. Append immutable bounded phase events. An uncertain record cannot become rejected, expire, be erased by head/config changes, or release its exclusion on process/lease/session timeout. Failed reservation SQL means no POST. Lost reservation/dispatch acknowledgement means inspection, not a new key.

HTTP status alone is insufficient for finalization: native postprocess can report failure after push. Treat any outcome after possible dispatch conservatively, including405/409 until the exact rejection class is independently qualified; transport/proxy errors and SQL receipt loss remain unknown. A fresh status read reporting unmerged does not prove the original native process cannot still finish. Unknown reconciliation must retain observations separately from attribution and not automatically promote a matching third-party merge or replay the request. An operational resolution path needs supported quiescence/fencing proof; recovery acceptance must preserve all exclusions/events/encrypted content.

Do not claim a received200 plus compatible readback proves exclusive authorship against concurrent independent writers. It establishes an acknowledged operation and observed native outcome; distinguish that from uncertain compatible observations. Readback fields must include native merger identity when available and validated, native PR merged state/time/output ID, exact object existence and strategy-specific graph/tree proof. Recheck current authority before exposing private receipt data. Access denial clears UI content while retaining only original operation identity for later explicit inspection.

## Strategy qualification and receipt strength

Qualify each strategy separately; initially release only those whose exact native result can be established. Suggested order is merge commit and fast-forward, then squash, rebase and rebase-merge; this does not remove any mode from the full goal.

| Mode | Required real proof beyond merged=true |
| --- | --- |
| Merge commit | Native result commit exists; two ordered parents include the actual native fetched base and exact H. If first parent differs from observed B, report actual base advancement explicitly; never claim preview-B fencing or candidate test success. Independently verify object graph/tree with supported APIs/Git. |
| Fast-forward-only | Diverging base is refused; successful result is exact H and previous actual target is its ancestor. No generated commit or merge-commit claim. |
| Squash | Exact native output and actual parent/base; independently show the intended merge result/tree for selected H and actual base. H need not be an ancestor, so an ancestry-only receipt is invalid. |
| Rebase | Verify bounded entire rewritten range, actual base, resulting tree and correspondence to selected source changes. Output is not H; don't label it as tested H/C or infer patch equivalence from final state alone. |
| Rebase-merge | Verify rewritten range plus generated merge parents/tree under native algorithm; distinguish it from ordinary rebase and ordinary merge. |

Native merge is permitted to advance against provider-current B only under the separately declared unprotected contract. Protected exact-C tests/producer evidence never inherit this result. If source/base moves so the qualified receipt cannot be reconstructed or independently verified, retain uncertainty; don't reduce proof to header metadata to declare success.

## Qualification packets and file ownership

| Packet | Concrete deliverable / files | Acceptance |
| --- | --- | --- |
| UM0 admission and missing predicate | NEW qualification harness using existing disposable supported native/API/Git fixture patterns; no retained configuration changes. | Exact branch protected false/true at wildcard matches; ordinary writer/reader/admin; allowed modes, draft/closed/conflict/checking/empty; stale H and source deletion; deterministic pause before native dispatch then add an otherwise satisfied protection rule; record whether native merges. Also characterize rule/policy/permission/PR-retarget change after actual provider admission. Counterexample keeps dispatch unavailable. |
| UM1 read workspace | NEW `internal/server/pull_merge_observation.go` +tests; additive messages/registration/read allowlist only after freeze; NEW `web/src/PullMergeWorkspace.tsx` integrated in PullRequestBrowser. | Before/after repository/source IDs and current authority, missing versus false flags, wrong-target/stale selection, no private data on late denial; bounded fake-HTTP and real-PG tests. No executable merge button. |
| UM2 durable native writer, only after interval gate | NEW merge helper/tests and DB queries/generated SQL; coordinated new migration; additive browser-only mutation/status RPCs. Shared exclusion and encrypted-content lifecycle in existing helpers as needed. | Real-PG duplicate changed-intent/concurrent actors+PRs, SQL loss before/after dispatch, reserved/unknown restart, no new-key bypass, native independent readbacks and complete mode receipts; no schedule/force/delete side effects. |
| UM3 served workspace | Shared component, TanStack Form, browser tests and supported-native served helper. | Actual explicit confirmation/one POST; exact receipt/reload/status only; cross-tab native effect refresh; lost response/late access removal clears private details; dark/light1440/390 screenshots and keyboard controls. |
| Protected parallel work | Existing ADR/P0.8 implementation packets. | Complete H/B/C/P/A/E/F interval, every ingress/background path, uncertain writer fencing, trusted evidence and fresh coordinated recovery. Not replaced by UM0–3. |

Actual native qualification must include normal merge/squash/rebase/rebase-merge/FF, their disabled settings, source/base changes, role/permission/protection changes, two different PRs to one base, parallel same-key calls, native success with lost response, postprocessing failure, SQL receipt loss, status-only inspection and provider-request continuation after Golf cancellation/restart. Tests must distinguish local fake-provider faults, actual provider evidence and served UI. Deterministic barriers use supported isolated proxy/transport boundaries; a pause before dispatch proves only that boundary, not an interior provider interval. Do not install provider hooks in the retained stack or infer a race absent from a finite trial.

## Compact developer workspace

Replace the always-visible implementation paragraph with a compact shared PR merge-status box at the bottom of Conversation. Show current observed status, strategy menu when a qualified strategy exists, and the existing native merged record for historical outcomes. Keep comparison details, receipt and unavailable reason in explicit disclosures; ordinary work UI should not be crowded by policy architecture prose.

While dispatch is unavailable, show “Merge unavailable” and an accessible concise reason; don't render a misleading enabled green button. If qualified later, `Merge` opens an inline confirmation editor with the selected strategy/H and observed base; TanStack Form handles custom message. A separate final explicit confirm sends the frozen operation once. No settings modal, automatic retry or generic loading spinner implying success.

Unknown/reserved states show status inspection and original immutable context. Rejected states may offer a new explicit preview/action only after a durable no-dispatch receipt. Success shows the actual resulting commit/native record and honest receipt proof level. Preserve unsent private reviews and separately frozen review publication keys; merging is a distinct operation. Responsive controls use existing button/heading/panel tokens, Lucide icons, readable fonts and touch targets, not a new table/layout engine.

## Source validation and limits

This proposal is based on read-only source/contract review and primary pinned sources fetched2026-10-04. Source files were read in an isolated worktree; they are not served-runtime evidence. No test was run to claim the protection-transition race reproduced here, and no merge was performed. The existing P0.8 counterexamples remain applicable and are not relabelled as passing qualification. Both infrastructure tracks share these predicates; Cloudflare orchestration does not supply a missing forge transaction. Full protected publication, full collaboration, strategy qualification, latest-schema recovery and the full Golf plan remain open.
