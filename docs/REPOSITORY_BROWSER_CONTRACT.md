# Repository browser increment

Implementation scope, 2026-10-01. Extends P1.4, P2.1 and P2.2; does not complete those tasks. Existing operations now use generated versioned Protobuf/Connect contracts; see [ADR 0002](decisions/0002-generated-api-and-typed-navigation.md).

All endpoints below require the existing Golf session, use the user's own scoped Forgejo credential, and send `Cache-Control: no-store`. Authorization is checked upstream on every request. No private content is persisted in browser storage. No new collaboration or Git write path is introduced.

Contract: [`api/golf/v1/golf.proto`](../api/golf/v1/golf.proto). Every procedure is a POST to `/rpc/golf.v1.RepositoryService/{Method}` with `Connect-Protocol-Version: 1`, `Content-Type: application/json` and the exact configured Origin. Generated clients handle protocol details. Old application REST routes are removed.

| Procedure | Request and response |
| --- | --- |
| GetRepository | `{repository:{owner,name}}` → `{repository}` |
| ListBranches | repository and optional `{page:{page,limit}}` → `{branches,page:{nextPage}}` |
| ListCommits | repository, optional ref/page; optional literal `path` requires full ref and `repositoryId` → `{commits,page,commitId,path,repositoryId}`; path selection receipt is empty for ordinary history |
| GetCommitDiff | repository and exact lowercase `commitId` → commit/parents/base, bounded `rawDiff` and numeric `byteSize`; see the [diff contract](COMMIT_DIFF_CONTRACT.md) |
| GetPullRequestDiff | repository, PR number and selected full lowercase base/head IDs → bounded native merge-base diff; changed base/head/PR binding or post-wait access is refused |
| GetRepositoryImage | repository, immutable commit/document path and literal image reference → bounded image bytes/media type; current private access is checked before and after delivery |
| GetContents | repository, optional ref/path → `{commitId,path,kind,entries,file}` |
| ListIssues | repository, optional enum state/page → `{issues,page}` |
| GetIssue | repository and positive number → `{issue}` |

Pagination defaults to page 1/limit 20 for zero values, with bounds page 10,000/limit 100. A zero `nextPage` means end. Protobuf JSON omits defaults/empty arrays; generated clients restore them. IDs are opaque strings; sizes are uint64 (decimal strings in JSON, bigint in TypeScript). States and kinds use the schema's enum names. Files contain `{entry,content?,previewReason}`; optional content is present even for empty text.

Content is decoded UTF-8 **plain text**, never HTML. A preview is limited to 256 KiB; binary, oversized, symlink, submodule and LFS content receives metadata and a reason instead. Do not follow targets or upstream download URLs. Bounded upstream responses or oversized directories fail visibly rather than returning a seemingly complete subset.

`Issue`: `{id, number, title, body, state, user: User, comments, createdAt, updatedAt, htmlUrl}`. Issue bodies render as plain text in this increment. Comments, issue mutations, rendered Markdown, PR comparisons, blame, review mutations and merges remain future work. Read-only PR/native-review browsing is documented in the [PR read contract](PULL_REQUEST_READ_CONTRACT.md).

Read-only [commit diffs](COMMIT_DIFF_CONTRACT.md) show native root/first-parent output for one exact commit, including merges against their first parent. They use a separate 512 KiB plain-text bound; provider output is not independently verified patch completeness or approval evidence.

Source navigation uses the returned commit ID to keep folder/file traversal consistent if a branch changes. Users can refresh or reselect a branch to observe a new head. Commit history is also browsable at a selected immutable commit. Branch enumeration may be paginated; never imply the first page is the complete branch list.

Errors use standard Connect `{code,message}` responses. Missing/inaccessible resources share `not_found` (404); expired/revoked credentials use `unauthenticated` (401), scopes use `permission_denied` (403), invalid input uses `invalid_argument` (400), response bounds use `resource_exhausted` (429), provider/storage failure uses `unavailable` (503). Empty contents uses `failed_precondition` (400); branch/history lists remain empty. Initial-push processing can temporarily retain empty state; arbitrary provider failures never become empty state.

The existing token scopes cover code browsing (`read:user,read:repository`). Issue browsing additionally requires `read:issue`; this combination was qualified in an earlier native qualification on a since-retired backend and has not been repeated on Forgejo 15.0.9. The local smoke check must exercise real Git pushes, slash-containing refs, source rendering boundaries, empty/private repositories, scope denial and revocation. UI fixtures supplement, rather than replace, real-provider checks.

The read-only `golf` CLI uses generated Go clients for these same procedures with a temporary Golf session. Global `--token-stdin` or `GOLF_FORGE_TOKEN` supplies a bootstrap credential; no credentials/cookies are written to disk. Commands finish by deleting the session, including after an operation fails or normal cancellation. Abrupt process termination cannot execute cleanup; server session expiry is the final limit. Output uses `{schema_version:"golf.cli.v1",data:<API response>}` and preserves pagination. Exit codes are 0 success/help, 1 operation/authentication/cleanup failure, 2 invalid usage. This does not implement the plan's OAuth/device login, full CLI, MCP or ACP.

## Provider qualification

Forgejo 15.0.9's served `/swagger.v1.json` (pinned as [`compatibility/forgejo-15.0.9.swagger.json`](compatibility/forgejo-15.0.9.swagger.json)) is the operation inventory, supplemented by the [Forgejo API usage guide](https://forgejo.org/docs/v15.0/user/api-usage/). Golf uses `/repos/{owner}/{repo}`, `/branches`, `/commits`, `/contents-ext/{filepath}` and `/issues[/{index}]`. The `contents-ext` metadata request includes `lfs_metadata`; only a previewable ordinary file gets a second request with `file_content`. Both requests use the resolved commit ID. Directory results are bounded to 1,000 entries and every upstream JSON response to 2 MiB.

Real local qualification (on the since-retired backend; not repeated on Forgejo) covers a first push, branch names containing slashes, Unicode/space paths, LFS pointer metadata without downloading its object, binary and oversized files, symlinks, gitlinks, issue/PR separation and independently scoped credentials. The initial-push branch failure was reproduced while upstream repository metadata remained empty and disappeared when that processing completed. This is a native-forge lifecycle boundary, not a retry-on-any-error policy.

Read-only API qualification is separate from P0.8's protected-write/conditional-merge gate. This increment does not claim those unsafe-to-assume operations, complete collaboration, production scale or a native Cloudflare forge.


## Current presentation and image delivery (2026-10-03)

The source RPC remains bounded text. The shared UI now renders Markdown/GFM and sanitized HTML, with heading anchors, relative snapshot links and lazy syntax highlighting. Scripts, event handlers, frames and arbitrary style declarations are removed. README images use `GetRepositoryImage`, not browser requests to the source host. See [presentation contract and visual comparison](REPOSITORY_PRESENTATION.md) for formats, source binding, external-host limits and URL compatibility. This supersedes the initial plain-text presentation statements above. Later issue/PR writes have their own [discussion](ISSUE_DISCUSSION_CONTRACT.md) and [PR mutation](PULL_MUTATION_CONTRACT.md) contracts; source presentation does not itself authorize them or protected merges.


## Current contextual source, literal history and issue editor (2026-10-03)

Optional literal-path history extends the existing `ListCommits` read without adding a write or changing ordinary unfiltered history. A path request binds the full lowercase40/64-character snapshot and current positive native repository ID; the response echoes both plus the literal path. Golf adapts the pinned native endpoint's fixed page span to its own1–100-row pages and refuses invalid totals, inconsistent spans/metadata or a mismatched identity. Wildcard/Unicode/leading-colon names use explicit literal pathspecs. Directories include descendants; earlier names are not followed across renames. [Exact API/CLI/MCP and pagination contract](PATH_HISTORY_CONTRACT.md).

Canonical source views now have bounded numbered syntax, line/range fragments, exact-path/permalink copy, preview-text attachment download and contextual History. Non-root views mount a lazy Files navigator after the main source succeeds. Shared directory rows independently request the latest literal-path change only while visible, with a three-RPC browser admission cap. These reads retain in-memory account/repository/snapshot query isolation and private access cleanup. [Navigator](SOURCE_NAVIGATOR_CONTRACT.md) and [row metadata](SOURCE_ENTRY_COMMIT_CONTRACT.md) describe their bounds. `GetContents` still has no expected native repository-ID argument or native identity receipt; a frontend query key cannot create that server fence. No atomic permission/ref snapshot is claimed.

New issue composition opens `/OWNER/REPOSITORY/issues/new`, with shared Write/Preview Markdown, cancellation and dirty-draft departure confirmation. Existing current-access checks and owner-scoped frozen request/status handling remain authoritative under the [discussion mutation contract](ISSUE_DISCUSSION_CONTRACT.md). Reload inspects a request outcome; it never reposts automatically. Human reviews, blame, tags, source mutations, generic raw/binary downloads and protected merge/squash/rebase remain requirements.

The integrated code and browser fixtures do not establish deployment. Record final served-image/native qualification in [implementation status](IMPLEMENTATION_STATUS.md); P0.8 and latest-schema033 recovery remain unresolved.
