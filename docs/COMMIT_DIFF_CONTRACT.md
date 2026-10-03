# Read-only commit diffs

Status: implemented developer-preview read contract, qualified with pinned Gitea 1.27.3 and native Git fixtures. The [implementation ledger](IMPLEMENTATION_STATUS.md) records completed evidence. This does not introduce protected writes, PR patch comparison, review eligibility or a merge service.

## Scope and identity

Golf reads one selected commit's native diff through supported Gitea 1.27.3 APIs. The caller supplies an exact lowercase 40- or 64-character hexadecimal object ID, not a branch, abbreviated SHA, tag or revision expression. Acceptance of both ID lengths is a syntax contract, not qualification of every forge object format. Both infrastructure tracks use the same session/repository boundary; no AI or Cloudflare service is required.

A root commit has no base or parents. Every nonroot commit uses its first parent as the base, including merge commits; all parent IDs remain visible in native order. This is not a combined merge diff, merge-base comparison, arbitrary two-ref comparison or PR diff. The returned commit and parent identities select immutable objects. They do not promise identical formatter bytes across provider/Git settings or versions.

## Generated API

Use `POST /rpc/golf.v1.RepositoryService/GetCommitDiff` with the exact configured Origin, Connect protocol headers and the existing opaque Golf session cookie. The [schema](../api/golf/v1/golf.proto) defines:

```json
{
  "repository": {"owner": "OWNER", "name": "REPOSITORY"},
  "commitId": "FULL_LOWERCASE_COMMIT_SHA"
}
```

Replace the example identity and SHA; the placeholder is not valid input. There are no pagination, branch-resolution or path-filter parameters.

| Response field | Meaning |
| --- | --- |
| `commit` | Existing `Commit` metadata: `sha`, `message`, `authorName`, `authoredAt`. The SHA must match the exact request. |
| `parentCommitIds` | Full immutable parent IDs in native order; empty for a root. |
| `baseCommitId` | First parent for a nonroot; empty for a root. |
| `base` | `COMMIT_DIFF_BASE_ROOT` or `COMMIT_DIFF_BASE_FIRST_PARENT`; unspecified is not a usable result. |
| `rawDiff` | Accepted native Gitea text, without Golf patch parsing or formatting. |
| `byteSize` | UTF-8 byte length of that text, uint32 and therefore a JSON number. This differs from source-entry uint64 sizes. |

Generated clients restore omitted Protobuf defaults, including an empty raw diff, zero size and empty repeated fields. Preserve object IDs as strings. An empty change is distinct from an inaccessible or nonexistent commit; provider failures cannot become a successful empty diff.

Reads require `read:user` and `read:repository`; no `read:issue` or new OAuth grant is required beyond existing repository-read authority. Golf uses the caller's provider credential, not a shared administrative token. The current provider identity must match the session’s stored immutable user/forge. Repository name, ID and access plus local session validity are checked before and after provider waits. Responses use `Cache-Control: no-store`. Those checks do not create an atomic reservation on membership or provider state, and a denied request does not return earlier private diff text.

The metadata must identify the requested SHA, include an explicit parent array, use full parent IDs of the same length and provide a valid author timestamp. Commit/repository URLs must be well-formed HTTP(S) without userinfo, query or fragment; the commit URL’s exact escaped path must equal the repository path plus `/commit/SHA`. Their origins may differ: Gitea’s repository converter uses the request origin while its commit converter uses the configured public root. Golf neither follows nor exposes that commit URL; the before/after immutable repository ID/name/access checks and exact SHA remain required. At most 1,000 parents and 2 MiB of provider JSON are accepted. The raw response, when it declares a media type, must declare `text/plain`.

| Failure | Connect code / HTTP |
| --- | --- |
| Invalid repository/commit selection | `invalid_argument` / 400 |
| Empty repository, invalid UTF-8 or unsupported control text | `failed_precondition` / 400 |
| Raw bytes, metadata JSON or parent count exceed their bounds | `resource_exhausted` / 429 |
| Missing/inaccessible commit or repository | `not_found` / 404 |
| Insufficient scope/provider permission | `permission_denied` / 403 |
| Missing, expired, revoked or wrong-identity credential/session | `unauthenticated` / 401 |
| Malformed/mismatched metadata, wrong media type or detected incomplete transport | `unavailable` / 503 |

Cancellation uses the existing Connect cancellation/deadline behavior. Provider errors are sanitized; no failed operation returns its partial raw bytes as a success.

## Text boundary and provider behavior

Golf accepts at most **512 KiB (524,288 bytes)** of raw UTF-8. Control characters other than tab, LF and CR are rejected. Oversized, invalid-encoding, unsafe-control and provider/transport errors fail visibly; Golf does not silently return a locally truncated success. This bound is independent of the 256 KiB ordinary source-file preview limit. There is no pagination or partial-diff mode.

Provider text can contain binary-change notices, rename/mode changes, escaped filenames, symlink target changes, gitlink object IDs and native “no newline” markers. Golf preserves these as plain text; it does not fetch binary/LFS objects, traverse symlinks, initialize submodules or execute embedded content. A root diff can include native `git show` metadata before its patch, including the commit author's name/email, timestamp and message. These are repository commit data, not a separately fetched account directory or an identity-verification claim.

The pinned [repository URL conversion](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/repository.go#L199) and [commit URL conversion](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/git_commit.go#L143) explain why matching absolute origins would reject valid internal/public deployments.

The provider metadata request disables files, statistics and signature-verification expansion. Native parent metadata and a separate raw `.diff` request are used; Golf does not walk an arbitrary comparison's entire commit range. Gitea selects root `git show` or a first-parent diff and applies its own formatting/rename settings. See the pinned [raw-diff API](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/commits.go#L308), [Git formatter](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/git/diff.go#L54) and [metadata conversion options](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/git_commit.go#L128).

**Raw provider output is not independently verified patch completeness.** An HTTP 200 stream can fail inside the provider after headers and contain an apparently clean end without a completion marker. Golf rejects transport/read errors it can detect but cannot infer the provider's internal Git process completed from those bytes alone. It does not validate hunk counts, reconstruct trees, verify signatures or prove that a patch can be applied. Neither the raw text, its byte count nor an immutable object ID establishes trusted check evidence, Golf approval eligibility or protected-publication readiness. P0.8 remains open.

## Browser and CLI

The browser implementation opens a commit from the **Commits** tab using the typed `?view=commits&commit=SHA` selection. It displays commit/base/parent metadata and the raw plain-text result. **Browse this commit** opens the exact selected object. Back navigation retains the history/branch selection; direct links and reload preserve the selected commit. Loading/denial/refresh states hide prior private patch text, and sign-out/expiry clears private queries. No diff payload enters localStorage or executable HTML.

The matching read-only CLI command is:

```sh
./bin/golf commit diff OWNER/REPOSITORY FULL_LOWERCASE_COMMIT_SHA
```

Global flags such as `--url` and `--token-stdin` precede `commit`; use the existing `GOLF_GITEA_TOKEN` or stdin secret input. Output is the same `golf.cli.v1` envelope, with the API response under `data`; `data.rawDiff` remains JSON-escaped. This is not a raw patch-file stdout mode. The command establishes and removes its temporary PAT session, including cleanup after operation failure; abrupt termination remains bounded by normal session expiry. No stored credential or managed CLI OAuth is added.

## Qualification evidence

`python3 scripts/commit-diff-smoke.py --cli bin/golf` passes against the actual local Gitea and native Git history. It covers roots, ordinary changes, first-parent merges, empty changes, rename/delete/binary/symlink/gitlink output; 512 KiB, UTF-8 and control boundaries; exact-SHA/scope/private-access rejection; and immutable selection after the real main branch advances. The CLI returns generated default-value JSON and removes its temporary sessions. Production browser checks pass commit selection, deep links/reload, source/history navigation, literal HTML display, dark desktop/light 390px mobile rendering and private-text cleanup after collaborator access is removed. Disposable provider fixtures and sessions are removed.

The first live attempt exposed a valid provider-origin difference between repository and commit URLs. Exact escaped-path binding now accepts internal API/public root origins while preserving repository identity and SHA checks. Real PostgreSQL/backend fixtures cover those origin differences, foreign paths, invalid schemes/queries, malformed metadata/short reads and post-wait authorization. The final full `go test -race ./... -count=1 -timeout 120s` passes (server 25.308s, database 26.934s); `make check` and all 59 Playwright checks pass, including eight added commit-diff cases. The actual PR/browser/CLI regression also passes after the shared read-boundary changes.

These checks qualify the bounded read workflow, not arbitrary future provider-stream completeness, a structured patch parser, signature verification, SHA-256 repositories, PR comparison, protected writes or merge eligibility. P1.4/P2.1/P2.2/P5.5 and P0.8 remain partial/open. No CI workflow is added.

## Current shared diff presentation

The [shared diff workspace contract](DIFF_WORKSPACE_CONTRACT.md) supersedes earlier presentation-only descriptions: compact native-index-bound folder navigation, loaded file-type/Viewed filters, persisted display booleans, optional wrapping and safe per-hunk syntax tokens now accompany the original native text. Native reads/authorization and protected-write limitations above remain unchanged. Current exact qualification is recorded in the implementation ledger.
