# Repository browser increment

Implementation scope, 2026-10-01. Extends P1.4, P2.1 and P2.2; does not complete those tasks. These bootstrap REST endpoints are not yet the plan's stable generated API.

All endpoints below require the existing Golf session, use the user's own Gitea token, and send `Cache-Control: no-store`. Authorization is checked upstream on every request. No private content is persisted in browser storage. No new collaboration or Git write path is introduced.

Base: `/api/repositories/{owner}/{repo}`. Names are validated path components, not arbitrary upstream URLs. Pagination defaults to page 1, limit 20 (maximum 100), using `next_page` only when more data exists.

| GET route | Response |
| --- | --- |
| Base | `{repository: Repository}`; existing fields plus `empty: boolean`, `clone_url: string`, `ssh_url: string`. |
| `/branches?page=&limit=` | `{branches: [{name, commit_id, protected}], next_page?}`. |
| `/commits?ref=&page=&limit=` | `{commits: [{sha, message, author_name, authored_at}], next_page?}`. Optional ref defaults to the repository's default branch. |
| `/contents?ref=&path=` | `{commit_id, path, kind, entries?, file?}`. Resolve the selected ref to a commit once, then read only that commit. Empty path means root. |
| `/issues?state=open|closed|all&page=&limit=` | `{issues: [Issue], next_page?}`; default open, excludes pull requests. |
| `/issues/{number}` | `{issue: Issue}`; rejects pull-request numbers. |

`entries`: `{name, path, type, sha, size}[]`, where type is `dir`, `file`, `symlink` or `submodule`. `kind` is `directory`, `file`, `symlink` or `submodule`. `file`: `{name, path, type, sha, size, content?, preview_reason?}`. Content is decoded UTF-8 **plain text**, never HTML. A preview is limited to 256 KiB; binary, oversized, symlink, submodule and LFS content receives metadata and a reason instead. Do not follow symlink/submodule targets or upstream download URLs. Bounded upstream responses or oversized directories fail visibly rather than returning a seemingly complete subset.

`Issue`: `{id, number, title, body, state, user: User, comments, created_at, updated_at, html_url}`. Issue bodies render as plain text in this increment. Comments, issue mutations, rendered Markdown, diffs, blame, reviews and merges remain future work.

Source navigation uses the returned commit ID to keep folder/file traversal consistent if a branch changes. Users can refresh or reselect a branch to observe a new head. Commit history is also browsable at a selected immutable commit. Branch enumeration may be paginated; never imply the first page is the complete branch list.

Errors use the existing `{error:{code,message}}` shape. Inaccessible/missing upstream resources return the same 404. Expired/revoked credentials return 401; insufficient scope returns 403; bad input returns 400; oversized source responses return a visible bounded-response error; provider failure returns 502. An empty repository has `empty: true`, empty branch/history lists, and contents returns `409 empty_repository` because no commit/tree exists. Gitea may briefly retain `empty: true` while processing an initial push; refresh after processing completes. Do not invent a source tree or treat an arbitrary provider 500 as an empty repository.

The existing token scopes cover code browsing (`read:user,read:repository`). Issue browsing additionally requires `read:issue`; this combination was qualified against pinned Gitea 1.27.3. The local smoke check must exercise real Git pushes, slash-containing refs, source rendering boundaries, empty/private repositories, scope denial and revocation. UI fixtures supplement, rather than replace, real-provider checks.

The read-only `golf` CLI calls these same endpoints with a temporary Golf session. Global `--token-stdin` or `GOLF_GITEA_TOKEN` supplies a bootstrap credential; no credentials/cookies are written to disk. Commands finish by deleting the session, including after an operation fails or normal cancellation. Abrupt process termination cannot execute cleanup; server session expiry is the final limit. Output uses `{schema_version:"golf.cli.v0",data:<API response>}` and preserves pagination. Exit codes are 0 success/help, 1 operation/authentication/cleanup failure, 2 invalid usage. This does not implement the plan's OAuth/device login, stable generated clients, full CLI, MCP or ACP.

## Provider qualification

The pinned Gitea 1.27.3 instance's `/swagger.v1.json` is the operation inventory, supplemented by the [official API guide](https://docs.gitea.com/1.27/development/api-usage/). Golf uses `/repos/{owner}/{repo}`, `/branches`, `/commits`, `/contents-ext/{filepath}` and `/issues[/{index}]`. The `contents-ext` metadata request includes `lfs_metadata`; only a previewable ordinary file gets a second request with `file_content`. Both requests use the resolved commit ID. Directory results are bounded to 1,000 entries and every upstream JSON response to 2 MiB.

Real local qualification covers a first push, branch names containing slashes, Unicode/space paths, LFS pointer metadata without downloading its object, binary and oversized files, symlinks, gitlinks, issue/PR separation and independently scoped credentials. The initial-push branch failure was reproduced while upstream repository metadata remained empty and disappeared when that processing completed. This is a Gitea lifecycle boundary, not a retry-on-any-error policy.

Read-only API qualification is separate from P0.8's protected-write/conditional-merge gate. This increment does not claim those unsafe-to-assume operations, complete collaboration, production scale or a native Cloudflare forge.
