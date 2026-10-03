# Repository presentation and visual reference

2026-10-03 increment. GitHub remains the layout/interaction reference; Golf keeps its charcoal/lime palette and Archivo/Geist fonts. This is an implemented presentation slice, not a claim of complete GitHub parity.

References captured in a separate signed-out browser at 1280 × 720: [Flask repository](https://github.com/pallets/flask), [README file](https://github.com/pallets/flask/blob/main/README.md), [issues](https://github.com/pallets/flask/issues), [PR list](https://github.com/pallets/flask/pulls), [PR conversation](https://github.com/pallets/flask/pull/5918), and [changed files](https://github.com/pallets/flask/pull/5918/files). Public pages change over time; these screenshots are visual references, not fixtures of native Golf data.

| Reference observation | Shared Golf implementation | Remaining work |
| --- | --- | --- |
| Roughly 41px code rows, compact borders and headers | Shared compact source rows with independently linked latest-change title/date, loaded only for visible rows | Tags, repository-wide file finder and larger source virtualization |
| Readable 14px UI / 16px documentation, 32/24/20px document headings | Shared application and Markdown typography, list markers, striped tables, bounded code and compact conversation spacing | Complete README outline, richer embedded media and document formats |
| Repository/file breadcrumbs and contextual tabs | Shared workspace breadcrumbs and source directory breadcrumbs; Code/Issues/PRs/Actions/Settings tabs | Owner profile routes and full capability-aware navigation |
| Meaningful issue, PR, commit and file paths | Canonical owner/repo paths; issue and PR numbers in path; `/pull/N/files`, `/commit/SHA`, immutable `/tree/SHA/path` and `/blob/SHA/file`, literal `/commits/FULLSHA/PATH` history and source line fragments | Branch-name source URLs and canonical settings paths |
| Explicit PR branch comparison and file actions | Compact PR state/title, base/head comparison, unified/split diff, collapse, Viewed, search, line anchors and selection-bound native Commits/Checks tabs | Full metadata editing, human reviews, trusted checks and protected merges |
| HTML logo blocks and source image sizing | Sanitized HTML/alignment; managed image bytes and shared dimension rules | Arbitrary image-host policy, WebP/AVIF, attachments and authenticated remote assets |

Legacy `/repositories/owner/repo` query links still open. New paths retain branch/filter context; immutable source IDs avoid ambiguous slash refs. Invalid commit IDs, numbers and path traversal fail before repository reads. Browser back/forward/reload and legacy links are tested.

## Private image contract

`GetRepositoryImage` requires current caller identity/repository read access before and after waits, an exact commit ID, a bounded ordinary source document and a literal image reference in that document. Relative paths resolve inside the same repository/commit; ordinary native content must match its metadata and size. Symlink/submodule/LFS images are refused. The maximum image payload is 256 KiB; raster dimensions are bounded. PNG/JPEG/GIF and SVG are supported.

External HTTPS images use explicit host allowlisting, public DNS-address validation and an address-pinned connection, no redirects, no proxy, a six-second timeout, a bounded read, and no caller/provider credentials. Browser rendering uses returned data URLs rather than direct remote requests. Remote images remain mutable independently of the source snapshot. There is no durable image cache, arbitrary network proxy, or generic attachment service in this slice.

SVGs render as image data URLs after DOMPurify SVG sanitization. Scripts, stylesheets, external references, embedded documents, animation and image/use elements are removed. A bounded presentation-property subset is converted from logo style attributes; arbitrary CSS is discarded. HTML is parsed then sanitized before React renders it. Comments without an immutable source-document context retain image placeholders.

## Real import fixtures

All private fixtures are owned by local `golf-admin`; upstream code and workflows were not executed. Default automation remains disabled on additional imports.

| Upstream | Local repository | Pinned commit | Coverage |
| --- | --- | --- | --- |
| pallets/flask | golf-review-demo | d73fa1cdcbd8b1465c151db8924ba58b1dd14e35 | HTML logo, SVG styles, code fences and Markdown links |
| expressjs/express | readme-express | 7ef98448f8b38099ab1ded55e458538ad47a51e7 | External logo/badges, long README and source links |
| sindresorhus/awesome | readme-awesome | bc98e517ddca672f55f9857d714fc3ea3c3540b2 | Relative SVG, HTML alignment, long nested lists and remote images |
| octocat/Spoon-Knife | readme-spoon-knife | d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9 | Small Markdown README and public links |

First-push metadata can lag and native default-branch metadata must match the pushed main branch. Qualification uses supported native branch configuration and bounded read retries, without replaying creation or direct database/repository changes. Temporary Git credentials are revoked after qualification.

The subsequent [GitHub visual audit](GITHUB_VISUAL_AUDIT.md) expands the reference set and records shared work headers, About/discussion metadata columns, loaded-list search/sort and run-first Actions. [Live activity](REPOSITORY_ACTIVITY_CONTRACT.md) describes the current private invalidation stream and its limits.


## Contextual source and issue composition (2026-10-03)

The current integrated source adds a contextual Files navigator on non-root views, numbered syntax-coloured text with line/range permalinks, literal pinned file/directory history, an explicit source-actions menu and latest-change title/date in directory rows. Shared global CSS and existing date/copy primitives retain compact Golf branding. Mobile Files starts collapsed above the source rather than consuming permanent workspace width. [Navigator contract](SOURCE_NAVIGATOR_CONTRACT.md), [row metadata contract](SOURCE_ENTRY_COMMIT_CONTRACT.md) and [history/actions contract](PATH_HISTORY_CONTRACT.md) define exact bounds and authorization limits.

Files filtering covers loaded expanded folders only. Closed siblings are not recursively fetched. Latest-change reads start only for visible rows, with at most three directory-row RPC promises per browser instance; requesting one displayed commit can still read a provider-fixed history page internally. Missing or mismatched metadata displays unavailable instead of an invented author/date. Numbered preview is bounded to12000 LF-split parts; empty/larger previews retain plain text. Exact UTF-8 preview download is an attachment Blob, not an authenticated active-HTML raw route. Blame, rename-following history, tags, generic native downloads, source mutations and full-repository file search remain required.

New issue composition is now an explicit full-page `/OWNER/REPOSITORY/issues/new` editor with Write/Preview, Cancel and dirty-draft departure confirmation. It reuses the existing TanStack discussion composer and durable issue request journal rather than introducing another mutation engine. Permission loss and uncertain outcome handling retain their existing contract. Ordinary single-field issue/PR edits remain contextual editors; human reviews and metadata operations remain requirements.

These are implemented integration changes. Final combined served-image qualification and matched captures must be recorded in the [implementation ledger](IMPLEMENTATION_STATUS.md) before calling this complete in a running installation. Existing prior screenshots retain their own provenance. Protected integration and latest-schema033 recovery remain separate unresolved gates.
