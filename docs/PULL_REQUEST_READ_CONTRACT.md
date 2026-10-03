# Pull-request and native-review reads

Implementation scope, 2026-10-02. This increment extends P1.4, P2.1/P2.2 and P5.5 with three read-only generated procedures, browser navigation and CLI commands. It does not implement PR creation/editing, review submission, diff/thread browsing, Golf approval policy or protected publication. Gitea remains the sole collaboration authority on both infrastructure tracks. The [implementation ledger](IMPLEMENTATION_STATUS.md) records actual validation outcomes separately from this contract.

## Generated API

The authority is [`api/golf/v1/golf.proto`](../api/golf/v1/golf.proto). Calls use `POST /rpc/golf.v1.RepositoryService/{Method}` with the existing exact-Origin check, `Connect-Protocol-Version: 1`, JSON content type and active Golf session. Generated clients handle the protocol. Responses use `Cache-Control: no-store`.

| Procedure | Request | Response |
| --- | --- | --- |
| `ListPullRequests` | `repository: {owner,name}`, optional `state` and `page` | `pullRequests`, `page.nextPage` |
| `GetPullRequest` | `repository`, positive `number` | `pullRequest` |
| `ListPullRequestReviews` | `repository`, positive `number`, optional `page` | `reviews`, `page.nextPage` |

Numbers are repository-local integers from 1 through 2,147,483,647. IDs are separate opaque decimal strings, including IDs beyond JavaScript's safe integer range. List filtering uses `IssueState`: unspecified/open defaults to open; closed includes merged and unmerged closed PRs; all includes both open and closed. Unknown enum values are rejected. Lists use Gitea's recent-update ordering rather than promising a stable snapshot across pages.

`PullRequest` includes its ID/number, plain title/body, state, optional author, creation/update times, provider URL, draft/merged flags, native merge time/commit, and head/base metadata. `PullRequestRef` includes `repositoryId`, `label`, `ref`, `commitId` and `retainedSnapshot`. Deleted/unavailable source repository IDs and unresolved commits can be empty; unavailable/deleted authors are absent rather than fabricated accounts. Protobuf JSON uses camelCase, schema enum names and omitted default fields; generated clients restore defaults. No `mergeable`, approval eligibility or trusted-check result is derived from these fields.

## Source observations and retained snapshots

Every **list head** has `retainedSnapshot: true`: Gitea's list converter uses its retained PR snapshot even when the displayed ref is a source branch name. Do not treat list head SHA as a fresh source lookup.

A detail head is marked retained when Gitea returns `refs/pull/<number>/head`. Other detail heads, and base metadata, are labeled **Provider observation**. A false `retainedSnapshot` value does not prove an independently authorized live-source read, atomic head/base freshness, or a reservation against another push. Source deletion can leave a usable PR snapshot and SHA after the original branch has disappeared.

A caller authorized to read a base PR may receive native private-fork metadata while lacking general access to that fork. Golf does not substitute an administrator credential, fetch a source repository, or grant code access merely because its ID or commit appears in a PR. Opening code elsewhere still requires that operation's authorization. The [publisher qualification](GITEA_PUBLISHER_QUALIFICATION.md) records why snapshots and expected-base leases do not establish the protected source/base/candidate contract.

Golf sends provider GET requests for these reads. Gitea’s detail handler can schedule native pull checks; a provider GET is not a guarantee of a side-effect-free upstream. Existing native automation remains governed by Gitea. See the [mutation-boundary inventory](GITEA_MUTATION_BOUNDARY_INVENTORY.md).

## Native reviews

Review records expose `id`, optional `user`, plain `body`, native `state`, `commitId`, `stale`, `dismissed`, `official`, timestamps and provider URL. States are `PULL_REQUEST_REVIEW_STATE_APPROVED`, `PENDING`, `COMMENT`, `REQUEST_CHANGES` and `REQUEST_REVIEW`. A deleted user or native team review request can have no user. A reviewed commit can be unavailable.

These are Gitea observations. `official`, approval state, a false stale flag or a matching commit does not establish Golf approval eligibility, independent reviewer identity, current policy or merge readiness. The UI labels the records and flags accordingly. Unknown states, malformed required metadata, duplicate IDs and mismatched PR/repository relationships fail visibly; the adapter does not invent success or silently discard malformed records.

## Pagination and authorization

The shared pagination contract defaults to page 1/limit 20, with ceilings of page 10,000/limit 100. PR/review pagination uses Gitea's validated `X-Total-Count`; native reviews can omit `Link` headers and filter another user's pending reviews after counting. An empty review page can therefore have a nonzero `page.nextPage`. Follow that value, not array length. Golf exposes next-page state, not the provider's unfiltered total. Missing/malformed totals and oversized provider pages fail visibly. A final supported page that still has more results produces an explicit bound error.

PATs require `read:user` and `read:repository`; `read:issue` is not part of this read contract. Scopes do not create repository access. The RPC boundary resolves the active session and any required OAuth refresh, then each read obtains the actual provider identity and matches its immutable user ID to the stored session. Local expiry/revocation is checked before and after successful provider operations without holding account/database locks during network waits.

Repository metadata is authorized before and after the PR operation. Its returned immutable ID/name must remain bound to the requested repository; every PR base and canonical PR URL must match it. Review reads first fetch and validate the PR, then require each record's native parent URL to match that PR. Provider permission errors remain errors. No administrator credential or cross-request membership cache substitutes for these checks.

The provider and Golf database cannot be checked atomically. These are repeated read authorization checks, not locks on repository membership or source refs; later revocation does not cancel a response already authorized. Existing bounded provider reads, redirect refusal, safe errors and response-size limits still apply. Unauthorized sessions receive `unauthenticated`, denied scopes `permission_denied`, inaccessible/missing PRs `not_found`, bad input `invalid_argument`, excessive responses `resource_exhausted`, and invalid/unavailable provider responses `unavailable`.

## Browser and CLI

The repository **Pull requests** tab uses `/repositories/:owner/:name?view=pulls`, with `state=open|closed|all` and `pull=<number>` for a detail. Typed routes preserve direct links, refresh and back/forward history; invalid PR numbers do not trigger provider reads. Leaving the view removes the selected PR from unrelated repository navigation.

List/detail/review queries are user/repository/selection scoped, abortable and discarded when unused. Refetch or failed authorization hides prior private results; detail denial removes nested reviews. A review-only failure stays visible within its panel. Expiry/sign-out clears private queries. Descriptions and review text are plain text, never rendered HTML/Markdown; provider links are restricted to safe HTTP(S) URLs. No PR/review payload is stored in browser storage.

The read-only CLI adds:

```sh
./bin/golf pr list owner/repository --state all --page 1 --limit 20
./bin/golf pr view owner/repository 12
./bin/golf pr reviews owner/repository 12 --page 1 --limit 20
```

Replace the repository and number with actual values. Global `--url`/`--token-stdin` flags precede `pr`; command flags follow positional arguments. Each invocation uses the existing temporary PAT-bootstrap session, logs out before emitting successful `golf.cli.v1` JSON, and stores no credentials/cookies. Data fields are `data.pullRequests`, `data.pullRequest` or `data.reviews`; collections retain `data.page.nextPage`. Normal cancellation/error cleanup and the existing exit codes remain unchanged. Managed CLI OAuth/device login and write commands remain future work.

## Verification boundary

The server's real-PostgreSQL race suite and generated-contract browser tests exercise identity/session changes, repository binding, private denial, malformed provider data, retained/deleted source metadata, native review flags, bounded/empty-page pagination and private-cache cleanup. Browser fixtures include dark/light/mobile, keyboard, direct links and history. Fixtures establish those contract behaviors; the separate live Gitea check establishes the scoped provider outcomes recorded in the ledger.

The real-provider command is `python3 scripts/pulls-smoke.py --cli bin/golf` against the local running Compose stack after `make cli`. Its disposable fixture checks supported private-fork reads, open/closed/all state filters, explicit list termination, denial without repository scope across all three procedures, native pending-review filtering, CLI cleanup, production-served browser behavior, access removal and retained refs after source deletion, then removes its users/repositories/sessions. See the ledger for run results and environment limits.

P0.8 remains open and [ADR 0004](decisions/0004-protected-integration-enforcement.md) remains proposed. Displaying native PR and review records does not enable protected integration or complete the broader forge, identity, collaboration or release gates. Repository CI remains disabled; applicable checks run locally.

The subsequent [PR Commits/Checks contract](PULL_WORKSPACE_CONTRACT.md) adds two selected read-only procedures, canonical four-tab URLs and shared history/latest-status controls. PR Files changed and sanitized Markdown supersede the initial plain-text-only display described above; the older section records its original scope.

The subsequent [PR mutation contract](PULL_MUTATION_CONTRACT.md) adds browser-session creation and single-field title/body/state/draft lifecycle operations, separate native PR IDs, displayed revisions and shared explicit editors. Read scopes and review semantics above remain distinct; human approvals and protected merging remain pending.

## Current shared diff presentation

The [shared diff workspace contract](DIFF_WORKSPACE_CONTRACT.md) supersedes earlier presentation-only descriptions: compact native-index-bound folder navigation, loaded file-type/Viewed filters, persisted display booleans, optional wrapping and safe per-hunk syntax tokens now accompany the original native text. Native reads/authorization and protected-write limitations above remain unchanged. Current exact qualification is recorded in the implementation ledger.
