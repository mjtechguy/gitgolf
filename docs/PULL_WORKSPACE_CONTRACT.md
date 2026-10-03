# PR Commits and Checks workspace

Current development scope, 2026-10-03. This extends the [PR read contract](PULL_REQUEST_READ_CONTRACT.md) and [selected diff workspace](PULL_DIFF_CONTRACT.md). Both infrastructure tracks use the same user-scoped native collaboration adapter. It does not complete GX-3, human reviews, workflow execution compatibility or protected merging.

## Generated selection and transport

`RepositoryService.ListPullRequestCommits` and `ListPullRequestChecks` accept:

```json
{
  "selection": {
    "repository": {"owner": "OWNER", "name": "REPOSITORY"},
    "repositoryId": "IMMUTABLE_NATIVE_REPOSITORY_ID",
    "pullRequestId": "IMMUTABLE_NATIVE_PR_ID",
    "number": 12,
    "baseCommitId": "FULL_LOWERCASE_BASE_SHA",
    "headCommitId": "FULL_LOWERCASE_HEAD_SHA"
  },
  "page": {"page": 1, "limit": 20}
}
```

Placeholders above are explanatory, not runnable fixture values. Select actual immutable IDs and base/head commits from current repository/PR detail. IDs are positive canonical signed-64-bit decimal **strings**; the PR number is a canonical integer1–2147483647. Base/head hashes must be full lowercase40/64-character object IDs with equal hash width. Missing/unresolved comparison commits fail; they are not an empty result.

Use generated Connect clients and the existing POST/exact-Origin/protocol/session contract. Responses have `no-store`, echo the verified `selection`, and include `commits` or `checks` plus `page.nextPage`. Limits default to page1/20, with ceilings page10000/100. Validated native `X-Total-Count` determines continuation, not array length or native JSON page totals. Malformed totals, unknown metadata and oversized payloads fail visibly. The native bounded-response ceiling remains2MiB. Browser and explicitly allowlisted owner-issued **read-only** Golf API credentials can use these reads. The local CLI/MCP command/tool catalogs have not yet added them.

## Authorization and snapshot observations

Each page verifies the current native caller against the immutable session user and authorizes the base repository. Its native repository ID must match the displayed selection. Current native PR detail must match the displayed PR ID, number and complete base/head commits. The native base-repository `refs/pull/NUMBER/head` must resolve to that same selected head **before and after** the payload read. PR detail is then rechecked for IDs, base/head commits, refs, source repository ID, open/closed state and merged flag. The outer repository/session authority boundary rechecks successful reads without holding DB/account locks across network waits.

A changed selection or retained ref returns `failed_precondition` (Connect HTTP400), withholding rows. Native branch metadata can advance before retained-ref import, or change during branch deletion. The UI must ask for fresh comparison metadata; it must not silently follow another head or reuse older successful checks. These are repeated observations, **not atomic locks**, cross-provider transactions, elimination of ABA races or proof of the native endpoint's internal comparison/cache completeness. A later revocation does not cancel a response already authorized.

PAT scopes are `read:user` and `read:repository`; these procedures do not require `read:issue`. Underlying native permissions remain necessary. No administrator credential or independently fetched source repository substitutes for caller authority. A base PR reader may inspect retained private-fork commits/diff without obtaining general access to that fork. Selected base-repository commit/source links still require their own read authorization.

## Commits

Golf reads pinned native `/repos/OWNER/REPOSITORY/pulls/NUMBER/commits`, disabling files and verification projections. Native code still computes comparison/stat metadata before paginating; small bounded responses do **not** prove large-PR scalability. The pinned native handler compares a retained PR head against the current base for unmerged PRs, and against its stored merge base after merge. This endpoint is PR history, not a general two-dot branch compare operation.

Rows retain exact SHA, complete bounded plain message, author name and author date, preserving native order. Each SHA/hash width, native repository/commit URL, date, text bound and duplicate SHA within the page is validated. Browser loaded pages deduplicate SHA and group only consecutive local-calendar author dates. Shared history rows provide exact-diff title/SHA links, full-SHA copy, pinned-source links and a named literal-text full-message disclosure. Author date is not committer date or signature verification. Native verification/check summaries are not fabricated.

## Checks

Golf reads `/repos/OWNER/REPOSITORY/commits/FULL_HEAD_SHA/status`: **latest native status per context**, reported to the base repository for the selected PR head. This does not include fork-only statuses, historical status revisions, detailed check-run annotations, job trees/logs or independently trusted Golf execution receipts.

A row contains its decimal string ID, context, state, description, optional publisher, creation/update times and optional target link. Known states are pending, success, failure, error, warning and skipped. Exact combined SHA/repository identity, positive unique row IDs, unique contexts per page, valid publisher/time/text metadata and page bounds are required. Native `statuses:null` is accepted only for an explicitly counted zero collection. Unsafe URL schemes, embedded userinfo credentials and invalid/bounded URLs remove the external-link action; Golf never fetches those targets. Safe external HTTP(S) links remain publisher-provided navigation metadata, not validated destinations.

Pinned native JSON `state` and `total_count` cover the **returned page**, not the entire context collection. Golf deliberately omits a global passing aggregate and exposes no merge eligibility from these fields. A native repository writer can publish status contexts. Reported success/skipped/pending is not trusted execution proof, required-check fulfillment or approval. Different statuses across pages can change during paging: duplicate contexts across loaded browser pages fail visibly and require refresh. There is no collection snapshot or stable cursor across concurrent changes.

## Browser and live behavior

The four workspace tabs are Conversation, Commits, Checks and Files changed. Canonical routes use `/OWNER/REPOSITORY/pull/NUMBER`, `/commits`, `/checks`, `/files`. Legacy `?view=pulls&pull=NUMBER&pullView=commits|checks|files` remains readable. Direct links, reload and browser history preserve the view; breadcrumbs have one current leaf.

Commits reuse the repository's compact shared history. Checks use the shared TanStack table/global CSS, accessible state and action icons, loaded-only search/sort/pagination and explicit native **Load more**. Private queries are abortable, have no retained cache after unmount and hide prior rows during access refetch, denial or expiry; logout clears private state. Text never executes as HTML. Charcoal/light mobile tabs share44px targets, horizontal navigation, active-tab reveal and keyboard-focus reveal. Resizing must preserve the focused tab rather than scroll back to the selected tab.

Comparison metadata and commit lists stay pinned through live activity. A new source/PR event shows explicit **Refresh comparison**. Check observations for the pinned selection refresh on relevant Golf PR/Actions invalidations and visible reconnect fallback; changed native identity fails rather than silently following the new head. Native changes that do not enter Golf's event mechanism are not promised immediate live coverage.

## Qualification and remaining tasks

`make qualify-pull-workspace` uses disposable private native users/repos/forks, supported APIs and browser sessions on the running Compose installation. It checks two-commit and latest-context pagination, private source denial, bounded PR diff access, mixed reported outcomes, scope/Origin/API-delegation boundaries, stale selection after native head advance, no inherited checks on the new head, retained history after source deletion, production-served dark/light desktop/mobile and revoked-access cleanup. Only read observations refused as stale are polled while native hooks settle; no mutation is resent. Fixtures are purged. No imported/source workflow or paid model is executed.

The real-PostgreSQL race suite checks session/caller/repository/PR/head/ref changes, current authority during provider waits, malformed/oversized responses, nullable zero statuses and pagination. Generated-client browser fixtures check four-tab routing, stale/malformed responses, loaded paging/deduplication, search/safe links, private-cache clearing, live pinning, explicit refresh and both themes/mobile keyboard behavior. Exact outcomes and final image revisions belong in [implementation status](IMPLEMENTATION_STATUS.md), not this contract.

Still required: detailed trusted CI/job/check-run workspaces, large-PR performance qualification, persistent Viewed, human inline/multiline threads, suggestions, draft reviews and PR lifecycle/metadata; CLI/MCP exposure; multi-replica/proxy streaming and all protected merge/approval/candidate/check enforcement under P0.8. The four tabs do not close those gates.

Primary references: [GitHub PR workspace](https://docs.github.com/en/pull-requests/get-started/about-pull-requests), [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks), [GitHub commit statuses](https://docs.github.com/en/rest/commits/statuses), pinned [Gitea1.27.3 PR commits handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/pull.go), [native status handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/status.go), [combined-status converter](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/status.go).
