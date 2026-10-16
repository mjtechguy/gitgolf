# Literal source history and source actions

Current portable API/UI increment, 2026-10-03. Both infrastructure tracks share the contract. Cloudflare-specific execution is not established by it. Authoritative fields live in [golf.proto](../api/golf/v1/golf.proto); native reads use Forgejo's supported APIs, never native database or repository-file writes.

## API and pagination

`RepositoryService.ListCommits` accepts optional `path` and `repository_id`. A nonempty path requires a canonical positive native repository ID and a full lowercase40/64-character commit ID. The literal repository-relative file/directory path permits spaces, Unicode, wildcard characters and leading colons; traversal, empty segments, backslashes, control characters and oversized paths are rejected. Ordinary history without a path retains its existing behavior and empty selection receipt.

Path responses include exact `repository_id`, `commit_id` and `path`, projected commits and `page.next_page`. Current session/delegated credential, native caller identity and repository permission/identity are checked around provider waits, with final RPC authorization before encoding. Reads are `no-store`. The ID detects an address replacement before dispatch; subsequent reads also refuse a changed native repository. These are read observations, not a lock on native membership, configuration or refs.

Pinned native [API behavior](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/commits.go) ignores requested page size for path history. Golf reads the actual first-page span, slices the requested1–100-row Golf page across native pages, validates canonical `X-Total`, native row/count/span consistency and duplicate/commit/date/message metadata, and calculates its own next page. Misleading native Link/page-size headers are not used. Native spans above100 or invalid/bounded provider output are refused. Caller pages are1–10000; a still-incomplete last permitted page is refused with an instruction to increase page size. Each request rereads the first page; no persistent history cache or full-repository traversal is introduced.

Golf prefixes the native pathspec with Git's `:(literal)` magic, preserving ordinary glob/leading-colon filenames. This was qualified through actual native Git/API fixtures. [Git pathspec semantics](https://git-scm.com/docs/gitglossary). Native history does not follow previous filenames across renames. A directory includes its descendants. Missing paths use native not-found semantics; a provider error is never converted into empty success. Multiple native observations can detect observed drift; this does not independently prove cryptographic history completeness or freeze provider settings.

## Browser, CLI and MCP

File/directory **History** opens `/OWNER/REPOSITORY/commits/FULLSHA/PATH`, with visible literal-path context, author-date groups, ordinary pagination, exact diff links and Back to source. General Commits navigation clears the path selection; path history has no branch selector that could silently replace its full commit. The browser refuses mismatched selection receipts. Legacy query routes still resolve.

`golf repo commits OWNER/REPOSITORY --ref FULLSHA --path PATH --page N --limit N` resolves current native repository identity before the history request. `golf_repo_commits` exposes the same optional `path` through the existing MCP read tool. No new tool or write procedure is introduced. PAT bootstrap/ephemeral-session cleanup and source-session-bound Golf bearer modes remain unchanged.

Source actions use shared native disclosures, keyboard dismissal, copy status and global CSS. Copy path and Copy permalink use the exact displayed path/commit, with current line fragment. Available ordinary UTF-8 previews up to256KiB can download their exact text, including CRLF and zero-byte files. Downloads are attachment-style `application/octet-stream` Blobs; Golf does not expose active HTML at an authenticated raw-source URL. Binary/large/LFS/symlink/submodule text downloads are disabled with the reason visible. Broader native raw/blob/archive/LFS downloads remain required work.

Nonempty previews with up to12000 LF-split parts use lazy numbered source and escaped lowlight tokens. CRLF is normalized only for display; copy/download retain original bytes. `#L1` and `#L1-L3` select bounded lines, reload restores selection, and Shift-click selects a range. Invalid/out-of-range fragments select nothing. A terminal newline terminates a line rather than adding an extra numbered row; blank display rows use a layout marker. Empty or larger line counts retain the plain preview. This is not folding, blame, semantic symbols or virtualized large-file browsing.

The [contextual Files navigator](SOURCE_NAVIGATOR_CONTRACT.md) and [visible-row latest changes](SOURCE_ENTRY_COMMIT_CONTRACT.md) complete separate source navigation/metadata behavior. Their bounds and native-ID limitations must remain explicit.

## Qualification

`make qualify-path-history` creates ordinary disposable private native users/repositories, writes only through native Git/APIs, and purges its fixtures. It checks63 literal file commits crossing native50-row pages,1/20/100 Golf pages, directory history, decoy exclusion, Unicode/glob/leading-colon names, branch advancement with pinned selection, wrong-ID/private/path/ref denials, CLI and PAT/bearer MCP. The production browser checks line/range, exact copy/download, actual tree controls, reload/paging, both themes/mobile and live access revocation. It also qualifies the full-page issue editor against an owned native issue with independent readback. No source/imported workflow or model is invoked.

Real PostgreSQL race cases check pagination drift and post-wait session revocation; generated browser fixtures cover selection mismatch, token escaping, syntax/XSS, CRLF/empty/large text, keyboard and menu/layout behavior. Exact current image/results belong in [implementation status](IMPLEMENTATION_STATUS.md); source alone is not deployment evidence. Protected merge/squash/rebase and schema033 recovery remain separate unresolved gates.
