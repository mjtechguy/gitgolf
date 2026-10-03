# Shared commit and PR diff workspace

The browser uses the same workspace for [exact commit reads](COMMIT_DIFF_CONTRACT.md) and [selected PR comparisons](PULL_REQUEST_READ_CONTRACT.md). Existing native read scopes, immutable selections, private cache removal,512KiB delivery bounds and stale/denied errors remain authoritative. This increment changes presentation and local display choices; it adds no comparison API, source write, approval or merge authority. [Current qualification](IMPLEMENTATION_STATUS.md).

## Navigation and filtering

The sidebar is a hierarchy of the **loaded changed files**, not the repository's complete source tree. Directory disclosures compact single-child chains; native path strings are never normalized into filesystem operations. Filename labels retain their complete path as accessible name/title. Stable native inventory indices bind anchors even when navigation is sorted or files are filtered. Duplicate paths remain separate entries. Rename search includes old/new names; deletion, binary and metadata-only entries retain their native identity. Navigating a displayed line reveals the corresponding sidebar entry and opens its containing folders.

Directory presentation is bounded to32 levels; deeper names remain visible as a literal remaining path, with the complete name retained on the link. Ordinary lists/navigation and native disclosures use Tab/Enter/Space; no incomplete ARIA tree widget is advertised. Sidebar scrolling stays internal. Hiding it is a display preference rather than a source mutation.

Text search, file-type checkboxes and All/Not viewed/Viewed only operate on loaded native entries. File types use the final filename suffix, case folded; suffix-less and simple dotfiles share No extension. The status reports Showing X of Y changed files while filtering. Clear/reset restores the loaded inventory without changing source commits, native text or per-file anchors. Filtered-out entries are not claimed absent from the repository or PR.

Viewed remains private in-memory state for this mounted actor/repository/comparison. It collapses a file and can be undone. It is not server-persisted, a submitted review or an approval. Reload, a new comparison, account change and access denial discard it. PR keys include immutable repository and PR IDs plus the selected base/head; commit keys include immutable repository ID and exact commit. Session/authentication and private query cleanup remain separate.

## Display preferences and syntax

Unified/Split, Wrap lines, Syntax colours and file-tree visibility are the only persisted values, under `golf.diff-display.v1`. Values are sanitized booleans. Filenames, text, filter terms, Viewed markers, source/actor IDs and native metadata are never written there. Storage failure leaves the display usable. Preferences apply across diff navigation; menu dismissal returns focus with Escape. The mutually exclusive native disclosures open upward when needed to fit the viewport. Their scrollable contents have a viewport-bound height. Resizing dismisses an open menu and returns focus to its summary when focus was inside.

Line wrapping changes CSS presentation without rewriting bytes or anchors. The full native diff remains available separately. Filename emphasis distinguishes its basename from parent context. A PR's Files changed heading, counts, display actions and fallback refresh share one toolbar rather than two header bands.

Syntax uses the existing lazily loaded lowlight renderer and shared filename/language mapping. Each displayed hunk's old and new sides are tokenized independently; context text can therefore have different token spans on each side. Rendering uses escaped React text/spans only, without executable HTML or source fetching. Unified context uses the new-side projection; added/deleted lines retain their corresponding projection. Text and old/new line numbers remain unchanged.

This is a display aid over the available patch context. It does not reconstruct missing source between hunks or prove language semantics. Language mapping accepts only own entries; filenames such as `constructor` and `__proto__` stay plain text. Unknown languages, files over65,536 characters or2,000 displayed rows, oversized hunk-side input and token nesting/count errors fall back to plain text. The overall structured limits remain500 files /12,000 rows, with the complete accepted bounded native text retained for unsupported output. These limits do not qualify large-PR performance at arbitrary scale or native formatter completeness.

## Qualification and remaining requirements

Browser regression covers nested and special names, duplicate/deep paths, native indices, rename/deletion/binary entries, keyboard disclosure/navigation, filtered Viewed transitions, original raw output, split-side multiline context, literal HTML, private storage boundaries, persistent display versus discarded private state, both themes/mobile, denied reads and authentication cleanup. The repeatable `python3 scripts/commit-diff-smoke.py --cli bin/golf` uses supported native Git/API operations in disposable private fixtures; the ledger records its actual runtime result and cleanup.

Persistent server Viewed, source-at-old/new file menus, safe file editing, whitespace-ignoring comparisons, additional context retrieval, selected commit/ranges, human inline threads/reviews, complete source tree/history/blame, richer metadata and protected merge/squash/rebase remain required. Existing reported checks and native review flags do not satisfy P0.8. Cloudflare and AI remain optional for this shared UI.
