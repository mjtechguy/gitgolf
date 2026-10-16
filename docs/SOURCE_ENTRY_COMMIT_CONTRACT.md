# Directory row latest-change metadata

Implemented UI slice, 2026-10-03. This supplements source browsing with commit-title/date columns; it does not enable source edits, blame, rename-following history, protection or merge actions. Full repository parity remains required.

`SourceEntryCommit` uses the generated `ListCommits` path-history contract with displayed native repository ID, full source snapshot commit and the literal entry path. It asks for page1/limit1. A successful response must echo that exact repository ID, snapshot and path and contain exactly one valid full-width commit SHA and usable author date. Empty, malformed, denied or mismatched results render **Latest change unavailable**, without inventing a commit, author or date. The linked title navigates to Golf's ordinary commit diff, using the returned commit identity; it is escaped plain text, never a provider HTML link.

The returned commit may be older than the displayed snapshot. A file's most recent change is not necessarily the repository head commit. The UI validates binding and shape; it does not independently reconstruct history/ancestry or prove that an underlying formatter is complete. The native supported path endpoint and the server adapter determine history order. The server uses explicit Git literal pathspecs; earlier filenames are not followed. Directory paths select native path history rather than an invented aggregate timestamp.

## Fetching and private state

- Observe the actual metadata element with native `IntersectionObserver`, zero root margin and positive intersecting width/height. Offscreen, hidden or background-tab rows do not admit new reads. Scroll/visibility/unmount cancel queued or active reads through the request signal. Without observer support, metadata remains unloaded rather than eagerly fetching every row.
- A small module-local admission set allows at most three concurrent **directory row** RPC promises per browser application instance. It does not throttle unrelated history/source reads or prove a server/provider concurrency limit. Server cancellation and each replica's native read capacity retain their own contracts.
- No speculative fetch is sent for all1000 entries. Native path pagination uses a provider-fixed span; requesting one displayed commit does not mean the native forge returns only one row internally. The server slices its bounded native result to the generated Golf page.
- Query identity is `['repository', userId, owner, name, 'source-entry-commit', repositoryId, fullSnapshot, literalPath]`. Use shared `privateQuery` with `staleTime:0`, `gcTime:0`, no retry and an eight-second active RPC timeout. Inactive cache contents are not persisted to browser storage.
- A changed user/repository/snapshot/path is a new visible-selection identity and query. Display no cached private metadata during revalidation or while the row is offscreen. Sign-out uses the application's existing cancel-before-removal private-query boundary; late responses cannot repopulate another account. Repository denial/revocation through the existing metadata/activity boundary removes the parent workspace.
- A per-path permission/missing-history error is displayed honestly at that row. It does not assert that unrelated source access was revoked or that a protected check failed. Generic row errors do not automatically retry through a client credential or scope change.

## Layout and supported actions

The row's source navigation link and latest-change link are siblings; anchors are never nested. Shared global CSS supplies the compact grid, ellipsis and mobile second line. Dates use shared `DateLabel`; the original author name remains in metadata and hover detail. Full commit diff/navigation use shared `repositoryOptions`. No custom inventory engine, inline CSS, one-off date formatter or added dependency is introduced.

The source row remains independently keyboard accessible. An unavailable metadata response preserves source navigation when its parent source response is still authorized. File-tree operations, branch changes and underlying source previews retain their existing authorization and bounds.

## Verification and remaining acceptance

The dedicated Playwright fixture exercises exact selection/page inputs and commit navigation,1000-row viewport admission with three held RPCs, scroll cancellation/queued-read suppression, wrong path/ref/repository/SHA/date or empty/multiple evidence, denial, sign-out/late results/account separation, escaped commit text and390px light/charcoal layout. Focused tests run on an isolated4183 server; root's final suite verifies shared source-row regression behavior.

These browser fixtures prove UI/request behavior, not a live provider response, real mid-read revocation, native rename interpretation or a deployed image. Those require root's supported native API/Git read qualification and served-image captures before the implementation ledger claims them. P0.8 protected integration, latest-schema033 recovery and the broader full GitHub-style parity goal remain open.
