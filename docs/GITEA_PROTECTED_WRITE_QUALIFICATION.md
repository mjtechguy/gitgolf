# Gitea protected-write qualification

Verified 2026-10-02 against **Gitea 1.27.3-rootless**, PostgreSQL **18.4-alpine3.24**, arm64, in an isolated disposable provider. This records the P0.8 investigation required by [plan §2.4](../GOLF_IMPLEMENTATION_PLAN.md); it does not implement Golf protection, reviews, merge queues or service credentials.

**P0.8's protected-write gate remains open.** Supported Gitea settings enforce several useful controls, but the tested merge API does not provide Golf's complete expected-head/expected-base contract. The investigation also reproduced a stale-approval acceptance window and showed that an ordinary code writer can publish a required success status. Those findings require an enforceable design decision before Golf advertises protected integration.

## Reproduction and evidence boundary

```sh
python3 scripts/gitea-protection-smoke.py
# Alternate unused loopback port:
python3 scripts/gitea-protection-smoke.py --port 3019
```

The [harness](../scripts/gitea-protection-smoke.py) uses Python's standard library, Docker Compose and ordinary Git. It starts its own randomly named PostgreSQL/Gitea project on loopback port 3018, with no Golf service and no changes to the normal development Compose deployment. It creates one disposable private organization and repository, then exercises supported APIs and Git HTTP as distinct non-site-admin users. Its setup/cleanup administrator never stands in for an ordinary actor during a permission or merge assertion.

Provider passwords use a temporary `0600` file; tokens remain in memory and Git's process environment, outside URLs/command arguments/output. The script does not override `HOME`, read/write provider tables, patch hooks, or modify provider repository files. Local Git commits and temporary working copies are ordinary clients. Requests reject redirects, time out and cap responses at 2 MiB. Fixture resources are purged, the dedicated volumes/project are destroyed, and container/volume/network absence is checked.

This is a **behavior-characterization harness**: successful completion means its stated outcomes were checked, including limitations. It is not a passing release gate. The rapid-push trial reports its observed count; a run that misses a timing window cannot establish its absence. A narrow, explicit `405 Please try again later` response is retried while a PR's background conflict check settles, after verifying it remains unmerged. Conflicts, transport failures and ambiguous outcomes are not blindly retried.

## Results through ordinary actor credentials

| Control / operation | Live result | Qualification limit |
| --- | --- | --- |
| Push-disabled protected `main`, admin override blocked | Developer and organization owner Git pushes fail; both actors' create-file API calls return `403`; branch ref stays unchanged. | These are Git HTTP and contents API paths. SSH, web-editor sessions and every alternative mutation route are not proved here. |
| Protection administration | Developer PATCH/DELETE protection returns `403`. | Authorized owner can still change the rule; that is a separate administration boundary. |
| Required approval plus `golf/test` status | Missing conditions return `405`; settled dismissed approval also returns `405`. | Counts/context names alone do not establish freshness or trusted check authorship. |
| Synchronous merge with obsolete `head_commit_id` | `409`; base remains unchanged. | Positive proof of the supplied head predicate, after other policy checks settle. |
| Another PR advances the base | `block_on_outdated_branch=true` denies the original PR (`405`). With it disabled, the same head-qualified request merges against the advanced base. Final parents are exactly `[advanced base, requested head]`. | “Not behind current base” is not a caller-supplied base equality predicate. |
| Two concurrently released merge requests, different PRs from one observed base | Runs produced one success/one conflict, and another run produced two successes. Every successful head remained an ancestor of the final base. | Finite concurrency evidence, not a deterministic internal interleaving proof. Two sequentially completed successes are legal without expected-base input. |
| Force merge by owner | Strict rule denies it (`405`); explicitly disabling the admin-override block allows it. | Owner/settings authority can invalidate stronger Golf assumptions. |
| Push-enabled `release`, force push disabled | Fast-forward accepted; forced rewind rejected; branch retains the accepted commit. | Separately proves force-push restriction rather than merely disabling all pushes. |
| Required status author | Developer posts success to the required context on its own PR head; that status satisfies the tested merge requirement. | Native context matching is not Golf's trusted test-producer policy. |
| Scheduled auto-merge | Request supplies head H1; after H2 is pushed and receives fresh approval/status, background merge integrates H2. | Scheduled intent is not an immutable H1 condition. Do not use it to publish a fixed tested candidate. |
| Explicit Git expected-base lease | Stale expected base rejects the candidate and preserves the new base; rebuilt candidate publishes at its exact SHA. Publication still succeeds after its source branch advances. | Conditions the base update, not source-head/review/policy state. |
| Exclusive merge allowlist | Only a dedicated ordinary merger account can merge (`200`). Developer, reviewer and owner are denied immediate and scheduled merge (`405`); merger cannot directly push while push is disabled or change protection. | Useful primitive; no Golf distributed coordination, lease fencing or emergency-administration invariant is implemented. |

Gitea documents push, force-push, review and override settings in its [protected-branches guide](https://docs.gitea.com/1.27/usage/access-control/protected-branches/). The table is the narrower evidence actually obtained, not a claim that the guide's every-protocol statement was independently qualified.

## Expected head is supported; expected base is not in the merge API

The script reads the **live pinned Swagger schema** and asserts the complete merge-option field set. There is a `head_commit_id`; there is no expected-base field. `merge_commit_id` is used for marking an already manually merged PR, not as a target-branch compare-and-swap condition. The [pinned API handler](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/pull.go) passes only the head condition to synchronous merge, while its scheduled path does not retain that condition.

The merge preparation compares the supplied head with the fetched head before building the merge. That matches the live stale-head rejection. See [merge preparation](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/pull/merge_prepare.go). A supplied head protects which source snapshot is integrated; it does not prove that the current source ref remains unchanged forever afterward.

The provider builds against its current fetched base and pushes normally; intervening non-fast-forward updates can therefore reject the push. Its merge lock is scoped to a pull request. Neither mechanism asserts equality with Golf's earlier base observation. The harness's intervening-PR case establishes this without relying on a lucky internal race. See [merge implementation](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/pull/merge.go).

Golf must not reinterpret “Gitea rejected some concurrent pushes,” a preflight GET, `block_on_outdated_branch`, or a Golf queue mutex as complete expected-base fencing. Similarly, a server-generated merge commit is not automatically the exact precomputed integration commit tested by Golf.

## Reproduced stale-approval window

The fixture enables `required_approvals=1`, `dismiss_stale_approvals=true`, `block_admin_merge_override=true`, and the required status context. An ordinary developer performs this sequence:

1. Open a PR at H1 and obtain the reviewer's approval on H1.
2. Push H2, which adds another file and changes the PR content.
3. Publish the required success status on H2.
4. Immediately request an ordinary merge with `head_commit_id=H2`, without force merge.

Three fresh PRs in each of two successive isolated runs merged successfully. For each accepted merge, the script checked the final parents `[B,H2]` and verified that every recorded review still referenced H1. No review on H2 was submitted. An earlier exploratory run also observed acceptance after GET showed the new head and `mergeable=true`.

By contrast, waiting until the review API reported dismissal caused merge to return `405`. This supports an asynchronous invalidation window, rather than a configuration that never dismisses reviews. The [push-update service](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/pull/pull.go) performs stale marking/dismissal during update processing; the [approval counter](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/models/issues/pull.go) counts official, non-dismissed reviews and optionally excludes reviews already marked stale. Those source observations explain the result but are not a deterministic proof of every possible interleaving.

**Disposition:** block a Golf claim that native dismissal alone enforces exact-commit approval freshness. `ignore_stale_approvals` was not qualified as a remedy; it also depends on stale state, so do not assume it closes the timing window. A safe candidate must validate review identity against the exact head and fence source changes through publication, with every alternative merge path covered. Merely delaying the UI or sleeping before merge does not provide that guarantee.

## Status and administration trust

The tested developer's own status satisfied `golf/test`; the fixture explicitly labels it as an assertion, not executed CI. The [pinned route](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/api.go) permits status creation to a code writer. Golf therefore cannot accept a success context name alone as trusted execution evidence while the same writer retains that route.

An exclusive merge account could independently verify Golf-owned run identity, producer, exact head/base/candidate, attempt and result before publication. That still requires preventing ordinary users and agents from reaching an alternative merge path, and making the merger credential inaccessible to untrusted work. No such Golf service, policy gateway or evidence verifier is built by this task.

The owner can edit or remove protection. Explicit emergency administration must invalidate the active policy/queue assumptions and require reconciliation. An audit event after an unauthorized write is not prevention. The [merge-policy checker](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/pull/check.go) also has distinct immediate, scheduled and force-merge behavior; an adapter must account for each.

## Feasibility options and remaining decisions

| Option | Qualified foundation | What must still be proved before selection |
| --- | --- | --- |
| Gitea synchronous merge API with explicit head, protected base and one scoped merge actor | Allowlist excludes tested ordinary/owner immediate and scheduled merges; actor has no site-admin or protection-management privileges. | All alternative base writes, existing scheduled work, settings changes, source freshness, trusted checks, and a durable coordinator whose stale holders cannot issue writes. A database lock alone does not fence an already issued upstream request or a stale process holding credentials. Exact caller-base/candidate contract must be preserved explicitly, not silently weakened. |
| Precompute candidate and publish through standard Git with an explicit expected-base lease | Stale base rejected; matching base published the exact candidate. Owner/developer direct pushes denied when only the merger was push-allowlisted. | The lease does not atomically assert the PR source ref, reviews, settings generation or producer identity. Need immutable/fenced source input, policy checks, exact candidate evidence and supported PR finalization/reconciliation. No direct Gitea ref/database writes. |
| Supported upstream extension/fix | The API and source identify the missing predicates and stale-review boundary. | Qualify an upstream-supported atomic head/base/candidate and approval contract, then pin and repeat the corpus. Do not silently fork or patch provider storage to bypass the plan. |
| Defer protected integration | Existing read-only browsing and ordinary repository access remain useful. | Expose protected queue/merge as unavailable until its complete enforcement contract is verified. This is an honest scope decision, not P0.8 completion. |

The expected-base lease form uses an explicit value (`--force-with-lease=refs/heads/main:<expected>`), not an implicit remote-tracking assumption. Despite the flag's name, the intended candidate update is a fast-forward; force-rewriting remains disabled. See the [official Git push documentation](https://git-scm.com/docs/git-push). The live fixture publishes a candidate with parents `[B,H1]` after the source branch changes to H2, and confirms H2 is not its ancestor. That is a counterexample to treating the base lease as a combined head/base predicate. This narrow primitive is not a drop-in implementation of Golf's full merge contract.

## Required follow-up gates

| Plan gate | Required next evidence |
| --- | --- |
| P0.8 | Record an accepted enforcement design/ADR for exact head/base/candidate and approval identity, address the reproduced window, and enumerate every alternate mutation path. Keep unsupported protected operations disabled. |
| P1.8 / P2.1 | Scoped merger identity, protected policy administration, stable actor mappings, credential rotation/revocation, emergency access and actual protocol-level authorization. |
| P3.6 / P4.9 | Test queue coordination loss, competing writers, source/base changes, duplicate attempts, pre-publication checks, in-flight request uncertainty, policy changes and reconciliation from observed upstream state. |
| P4.7/P4.10 | Bind trusted check evidence to the exact candidate and authorized producer; deny forged contexts or results from untrusted jobs. |

Not qualified: SSH/deploy-key behavior, web-editor authorization, protected-file patterns, signing, ruleset precedence/globs, branch rename/delete, every force/bypass configuration, cross-repository forks, squash/rebase/fast-forward API merge modes, LFS, multi-node provider behavior, network partitions, deterministic pause-inside-provider races, or incident recovery. Both infrastructure tracks share these unresolved product guarantees; Cloudflare infrastructure does not supply a missing forge authorization predicate.
