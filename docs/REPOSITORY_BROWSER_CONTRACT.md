# Repository browser increment

Implementation scope, 2026-10-01. Extends P1.4, P2.1 and P2.2; does not complete those tasks. Existing operations now use generated versioned Protobuf/Connect contracts; see [ADR 0002](decisions/0002-generated-api-and-typed-navigation.md).

All endpoints below require the existing Golf session, use the user's own scoped Gitea credential, and send `Cache-Control: no-store`. Authorization is checked upstream on every request. No private content is persisted in browser storage. No new collaboration or Git write path is introduced.

Contract: [`api/golf/v1/golf.proto`](../api/golf/v1/golf.proto). Every procedure is a POST to `/rpc/golf.v1.RepositoryService/{Method}` with `Connect-Protocol-Version: 1`, `Content-Type: application/json` and the exact configured Origin. Generated clients handle protocol details. Old application REST routes are removed.

| Procedure | Request and response |
| --- | --- |
| GetRepository | `{repository:{owner,name}}` → `{repository}` |
| ListBranches | repository and optional `{page:{page,limit}}` → `{branches,page:{nextPage}}` |
| ListCommits | repository, optional ref/page → `{commits,page}` |
| GetContents | repository, optional ref/path → `{commitId,path,kind,entries,file}` |
| ListIssues | repository, optional enum state/page → `{issues,page}` |
| GetIssue | repository and positive number → `{issue}` |

Pagination defaults to page 1/limit 20 for zero values, with bounds page 10,000/limit 100. A zero `nextPage` means end. Protobuf JSON omits defaults/empty arrays; generated clients restore them. IDs are opaque strings; sizes are uint64 (decimal strings in JSON, bigint in TypeScript). States and kinds use the schema's enum names. Files contain `{entry,content?,previewReason}`; optional content is present even for empty text.

Content is decoded UTF-8 **plain text**, never HTML. A preview is limited to 256 KiB; binary, oversized, symlink, submodule and LFS content receives metadata and a reason instead. Do not follow targets or upstream download URLs. Bounded upstream responses or oversized directories fail visibly rather than returning a seemingly complete subset.

`Issue`: `{id, number, title, body, state, user: User, comments, createdAt, updatedAt, htmlUrl}`. Issue bodies render as plain text in this increment. Comments, issue mutations, rendered Markdown, diffs, blame, review mutations and merges remain future work. Read-only PR/native-review browsing is documented in the [PR read contract](PULL_REQUEST_READ_CONTRACT.md).

Source navigation uses the returned commit ID to keep folder/file traversal consistent if a branch changes. Users can refresh or reselect a branch to observe a new head. Commit history is also browsable at a selected immutable commit. Branch enumeration may be paginated; never imply the first page is the complete branch list.

Errors use standard Connect `{code,message}` responses. Missing/inaccessible resources share `not_found` (404); expired/revoked credentials use `unauthenticated` (401), scopes use `permission_denied` (403), invalid input uses `invalid_argument` (400), response bounds use `resource_exhausted` (429), provider/storage failure uses `unavailable` (503). Empty contents uses `failed_precondition` (400); branch/history lists remain empty. Initial-push processing can temporarily retain empty state; arbitrary provider failures never become empty state.

The existing token scopes cover code browsing (`read:user,read:repository`). Issue browsing additionally requires `read:issue`; this combination was qualified against pinned Gitea 1.27.3. The local smoke check must exercise real Git pushes, slash-containing refs, source rendering boundaries, empty/private repositories, scope denial and revocation. UI fixtures supplement, rather than replace, real-provider checks.

The read-only `golf` CLI uses generated Go clients for these same procedures with a temporary Golf session. Global `--token-stdin` or `GOLF_GITEA_TOKEN` supplies a bootstrap credential; no credentials/cookies are written to disk. Commands finish by deleting the session, including after an operation fails or normal cancellation. Abrupt process termination cannot execute cleanup; server session expiry is the final limit. Output uses `{schema_version:"golf.cli.v1",data:<API response>}` and preserves pagination. Exit codes are 0 success/help, 1 operation/authentication/cleanup failure, 2 invalid usage. This does not implement the plan's OAuth/device login, full CLI, MCP or ACP.

## Provider qualification

The pinned Gitea 1.27.3 instance's `/swagger.v1.json` is the operation inventory, supplemented by the [official API guide](https://docs.gitea.com/1.27/development/api-usage/). Golf uses `/repos/{owner}/{repo}`, `/branches`, `/commits`, `/contents-ext/{filepath}` and `/issues[/{index}]`. The `contents-ext` metadata request includes `lfs_metadata`; only a previewable ordinary file gets a second request with `file_content`. Both requests use the resolved commit ID. Directory results are bounded to 1,000 entries and every upstream JSON response to 2 MiB.

Real local qualification covers a first push, branch names containing slashes, Unicode/space paths, LFS pointer metadata without downloading its object, binary and oversized files, symlinks, gitlinks, issue/PR separation and independently scoped credentials. The initial-push branch failure was reproduced while upstream repository metadata remained empty and disappeared when that processing completed. This is a Gitea lifecycle boundary, not a retry-on-any-error policy.

Read-only API qualification is separate from P0.8's protected-write/conditional-merge gate. This increment does not claim those unsafe-to-assume operations, complete collaboration, production scale or a native Cloudflare forge.
