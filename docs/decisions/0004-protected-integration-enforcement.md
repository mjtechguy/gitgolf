# ADR 0004: Enforce protected integration at the complete write boundary

**Proposed, 2026-10-02.** Acceptance depends on the executable gate below. This ADR does not enable protected integration or close P0.8. It applies equally to the portable and Cloudflare tracks.

## Decision proposed

Pursue a **fully mediated publisher using unchanged Gitea** as the first qualification candidate. Its scope is a managed deployment in which every relevant mutation crosses Golf's enforcement boundary, including writes to fork source repositories. Publish the exact tested candidate through supported Git transport with an explicit expected-base lease. Use a narrowly privileged publisher identity; workers and agent sandboxes never receive that identity's credentials.

This is materially stronger than adding a merge account and a queue mutex. The current Compose/Helm/Gitea-public-URL installations have not established this boundary. Existing or external Gitea instances with independent writers cannot advertise the protected guarantee merely by installing Golf or configuring a merge allowlist.

The immediate next task is a bounded **mutation-boundary and interrupted-publisher qualification**, described below. Do not first build the merge queue, declare capability readiness, or compensate with sleeps. If the complete boundary cannot be qualified using supported interfaces, require an upstream-supported conditional-publication extension/fix. Do not silently patch Gitea, edit provider storage, or redefine the requirement around weaker checks.

## Evidence and conclusion

The [protected-write report](../GITEA_PROTECTED_WRITE_QUALIFICATION.md) records live Gitea 1.27.3 results: expected-head rejection; absent expected-base merge input; a reproduced stale-approval window; forgeable required context names; evolving scheduled auto-merge; working scoped merge/push allowlists; and working Git base leases that do not condition the source head.

**Conclusion:** unchanged Gitea's exposed APIs and settings are not a complete enforcement boundary by themselves. A fully mediated deployment is a plausible supported composition, not yet a proved solution. Its correctness depends on exclusive mutation admission and conservative recovery, not an undiscovered Gitea compare-and-swap API. The proposed profile must reject unmanaged source writers and remain unavailable when exclusivity cannot be established.

The additional [Git primitive check](../../scripts/git-atomic-verify-smoke.py) passed on Git 2.39.5 (Apple Git-154): an atomic push containing an unchanged source ref and explicit source lease sent only the changed target ref on the wire. An already changed source rejected the entire push. This proves why an unchanged `H:H` refspec is not a remote verify-only lock after advertisement; it is not a deterministic in-flight race test or a Gitea integration test. All temporary repositories/packet traces were removed. The behavior is consistent with [Git's send-pack handling of up-to-date refs](https://github.com/git/git/blob/v2.39.5/send-pack.c) and the [atomic/lease push contract](https://git-scm.com/docs/git-push).

## Required invariant

For one integration intent, bind these values before publication:

| Value | Required meaning |
| --- | --- |
| Source identity and H | Stable forge/repository ID, full source ref, exact source commit, and PR identity. Names/URLs alone are insufficient. |
| Target identity and B | Stable target repository ID, full target ref and exact expected base commit. |
| Candidate C | Exact immutable commit tested for this source/base and merge policy, including its parents and tree. Do not regenerate a different merge commit after tests. |
| Policy P | Applicable protection, merge mode, trust requirements, membership/permission generation and deployment ownership generation. |
| Approval A | Eligible reviewer identities and applicable decisions bound to H, with dismissal/rejection/revocation handled according to P. A count or asynchronous stale flag alone is insufficient. |
| Evidence E | Trusted producer, run/attempt identity, exact C and B/H, mandatory evaluations, completed result and artifact integrity. A status context string alone is insufficient. |
| Authority F | Current publication authority/epoch, scoped intent identity and single-use/idempotent operation identity. |

At publication, these predicates must hold together over an interval containing the successful target update: source is still H; target is B; C is the authorized tested candidate; P/A/E remain valid; F may publish. The operation advances only the authorized target to C, or leaves it unchanged. A duplicate request returns the same observed outcome. A base change requires rebuilding and retesting; source/review/policy changes require invalidation under the configured policy.

Golf and Gitea still do not share a database transaction. Persist intent first, observe publication, then finalize/audit/outbox; preserve an explicit uncertain outcome across crashes. Readback alone does not prove that a previously issued writer can no longer act. This requirement follows [plan §2.4](../../GOLF_IMPLEMENTATION_PLAN.md) without making Git objects and SQL bookkeeping falsely atomic.

## Candidate managed deployment

The following are proposed implementation obligations, not current deployment claims:

1. **Admit every relevant mutation.** Route Git HTTPS and SSH receive operations, source/base API writes, web edits, review changes, PR retarget/close, membership changes, repository transfer/deletion and protection administration through one policy boundary. Default-deny unknown mutation routes. Reads may scale independently. Explicitly account for native scheduled merges, mirror synchronization, imports, maintenance and existing custom hooks; Golf Actions being disabled does not disable every Gitea background writer.
2. **Keep provider access private.** Ordinary clients cannot bypass the gateway through provider API/web/SSH ports. Authentication/consent pages need a separately qualified route allowlist; making Gitea private must not break the existing OAuth flow or accidentally expose mutations through that allowlist. Internal Golf callers must obey the same mutation contract. Network policy alone does not classify an allowed HTTP endpoint's operations.
3. **Separate ordinary actors and publication authority.** Continue per-user upstream authorization for ordinary operations. A service actor receives only explicit repository publication rights, no site administration or general protection-management rights. It cannot grant an operation that the requesting actor/policy denies. CI, agents and queue workers submit immutable intent IDs, not arbitrary Git refspecs or provider credentials.
4. **Serialize the final predicate interval.** Acquire source/target and applicable policy/identity barriers in a stable order, re-read authoritative values, and validate A/E directly against H/C. Test C outside the short final barrier. While publication is active, all admitted changes that could invalidate its predicates wait or are rejected. Material source/base changes restart candidate preparation; no entire CI run needs a long-held write barrier.
5. **Publish C, not a newly generated merge.** Use supported Git receive with explicit expected B and the precomputed candidate C. The prior qualification proves this narrow base/candidate primitive. No Golf process writes Gitea ref files or tables. How native PR state is finalized through supported APIs after exact publication is a required test, not an assumed side effect.
6. **Retain barriers for uncertainty.** An issued operation must not lose its mutation barriers solely because an application lease expired, a database connection died, a client disconnected or the publisher process exited. Persist its uncertain state. Do not let a replacement publisher change overlapping source/base/policy resources until prior provider writes are completed or authoritatively fenced and the outcome reconciled.

The initial qualification may deliberately stop protected publication after uncertain failure instead of providing automatic takeover. It must say so in capability/operations documentation. Recovery must quiesce or terminate the previous provider write processes through supported deployment operations and prove that the old process/connection cannot resume. A network disconnect alone can leave an already accepted provider request running; a new epoch stored only in Golf cannot revoke a request Gitea already accepted. Node/storage fencing remains a separate obligation before cross-node failover.

This can serialize conflicting writes per repository/resource set while permitting unrelated repositories and read/API replicas to proceed. No throughput or availability target is claimed before measurement. Cloudflare-specific coordination can be an optional implementation later; it does not remove these same requirements from the portable profile.

## Fork PRs and source authority

Locking only the target branch is insufficient. A source fork has a different stable repository ID, its own writers and often a different owner. The managed profile must intercept its writes too, order both repositories' barriers consistently, and prevent source rename/delete/transfer during publication. Qualification must use a private fork, a non-admin publisher with only explicitly required grants, and independent source/target actors.

A target-local `refs/pull/...` copy is not proof that the actual fork source ref is still H: it can lag. The adapter must qualify an authorized, authoritative source-head observation and a supported way to obtain the candidate objects without granting blanket access to private forks. If those grants/observations cannot be established, deny that protected operation; do not substitute a site-admin token.

Atomic Git push operates on the receiving repository's submitted updates, not on two independent fork repositories. An immutable imported snapshot is useful, but substituting one for a live PR source would change the contract and requires an explicit product decision. Connected GitHub/GitLab origins and independently operated source forges need their own qualified boundary; they do not inherit this managed-Gitea guarantee.

## Why hooks and existing features do not close the gate

| Mechanism | Disposition and evidence |
| --- | --- |
| Gitea merge API / native auto-merge | Retain for unprotected capabilities as separately qualified. They do not supply the full predicates above. The [pinned merge handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/pull.go) handles immediate, scheduled and manually-merged operations differently. |
| Custom Git hooks through supported API | Not selected as a complete policy extension. The [pinned hook inventory](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/git/hook.go) supports only pre-receive, update and post-receive; the [API](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/git_hook.go) manages those scripts. No hooks were enabled, installed or patched in this investigation. |
| Pre-receive authorization callback | Can reject a proposed update, but a successful check alone does not reserve fork refs, reviews or policy until commit. Arbitrarily adding a callback without a complete reservation/abort/recovery protocol moves the race. |
| Git reference-transaction hook | Git documents prepared/committed/aborted phases and ref locking, but Gitea's supported hook API above does not expose it. Even a Git ref transaction does not automatically serialize Gitea review/policy SQL or a second fork repository. See [Git hooks](https://git-scm.com/docs/githooks). |
| Direct `git update-ref --stdin` verification | Git has transactional local update/verify operations, but using them against Gitea-managed storage violates the plan and bypasses the supported receive lifecycle. See [Git update-ref](https://git-scm.com/docs/git-update-ref). Not an implementation option. |
| Webhooks or checking refs after merge | Useful for reconciliation, not prevention. They cannot retract unauthorized publication. |
| Context allowlists, stale-review flags, ordinary database/DO locks, token revocation | Individually useful but do not fence every previously issued write or atomically bind all predicates. Existing live counterexamples remain applicable. |

Gitea's [configuration reference](https://docs.gitea.com/1.27/administration/config-cheat-sheet/#security-security) documents that custom hooks are disabled by default and execute with the forge operating-system user's authority. This is a substantial extension trust boundary, not a sandbox for repository authors. Template/UI customization supplies no missing transaction guarantee. The [native receive hook](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/private/hook_pre_receive.go) rechecks several protections, but the measured stale-review result shows why invoking that existing check is not sufficient evidence.

## Upstream extension required if mediation cannot be proved

The fallback is an upstream-supported publication operation/extension at Gitea's commit boundary, not merely an extra `base_sha` field checked early in the HTTP handler. Its required contract is:

- Accept immutable intent/operation identity, target/source IDs and refs, expected B/H, exact candidate C, policy/approval identity and current publication authority.
- Validate caller permissions and candidate ancestry/tree; bind reviews to the actual H and trusted external evidence to C. Source and target must remain fenced through publication, including fork PRs.
- Reject stale authority at the effective write point and cover alternate Git/API/background writers. Storing an epoch in a queue without target-side enforcement is insufficient.
- Serialize relevant permission/protection/review changes with publication, or participate in a durable fail-closed reservation protocol that provides equivalent ordering. A signed permit that can remain usable after revocation is insufficient by itself.
- Return committed, stale/denied, or explicitly uncertain results; reconcile an idempotent operation after process/response loss without a duplicate write. Keep native PR/accounting updates recoverable.

Acceptance requires a supported release or documented extension contract plus passing integration/fault evidence. An upstream proposal has not been sent and upstream acceptance is not assumed. A supported stale-review fix should be pursued independently; it does not alone supply candidate/base/authority fencing.

## Concrete next task: P0.8-PUBLISH-1

This is a local subtask under existing P0.8, not a new roadmap phase. Implement a **disposable qualification harness for one mediated publisher**, not product UI or a general-purpose proxy. Reuse the pinned private provider fixture; exercise only the explicit mutation set needed for one same-repository PR and one private-fork PR. Keep provider/worker credentials separate and record every currently unmediated route as a blocker.

| Required experiment | Passing result |
| --- | --- |
| Ordinary actor attempts direct API/web/Git ingress; legitimate mediated reads and source push | Bypass denied at network/protocol boundary, normal authorized flow works. OAuth login/consent still works through its narrow allowed routes. |
| Pause publication after final predicate read; concurrently push source, move base, change review/membership/protection | Each conflicting mutation either orders before validation and invalidates the intent, or waits until after C is committed. Repeat with separate private-fork source/target actors; no admin substitution. |
| Submit stale or duplicate worker intent | Current publisher rejects wrong authority/identity; exact duplicate returns the same operation result. Worker never possesses a provider publishing credential. |
| Pause an already issued provider write, then lose the publisher's DB lock/process/connection and start a replacement | Replacement cannot publish or mutate overlapping resources until the old write is conclusively completed/fenced. If safe quiescence cannot be demonstrated through supported operations, this profile fails qualification. |
| Provider commits C but response or Golf finalization is lost | Reconciliation records the observed C once, verifies its source/base/candidate binding and completes supported PR bookkeeping; no blind retry. |
| Change H/B/P/A/E before publication; forge a native success context | Intent becomes invalid despite green native status; changed B rebuilds/retests, no obsolete candidate or review is accepted. |
| Existing native auto-merge/mirror/import/custom-hook path; owner emergency settings access | It is denied/quiesced under the managed profile, or invalidates protection eligibility before any new protected publication. No “audit afterward” acceptance. |

Record the exact failure model and deployment profile, then accept or reject this ADR's candidate architecture. **Only after that review** should P3.6/P4.9 build the durable merge queue on the chosen primitive. If any required path cannot be mediated/fenced, implement the supported upstream extension above or keep protected integration unavailable; continue independent browsing, collaboration and execution work without claiming this gate is complete.
