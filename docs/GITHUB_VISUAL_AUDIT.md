# GitHub visual and interaction audit

Reviewed 2026-10-03 against actual public GitHub pages and the running local Golf Compose installation. GitHub provides the work layout reference; Golf retains its charcoal/light surfaces, lime accent, Archivo type and logo. Matching appearance does not establish feature parity or provider compatibility.

## Evidence and scope

The initial paired capture contains 18 screenshots at 1280 × 900: repository Code, README file, issue list, PR list, PR conversation, PR Files changed, commit history, commit diff and Actions. Additional captures cover the public issue conversation, Actions run summary, branch and clone menus, and Golf profile/infrastructure settings. GitHub was signed out. Its run summary was visible, but job logs required sign-in and were not visually exercised. Authenticated GitHub settings, write menus, approval/merge controls and private data were not exercised or claimed verified.

Primary reference pages:

- [Repository](https://github.com/pallets/flask), [README file](https://github.com/pallets/flask/blob/main/README.md), [issues](https://github.com/pallets/flask/issues), [issue conversation](https://github.com/pallets/flask/issues/6146).
- [PR list](https://github.com/pallets/flask/pulls), [PR conversation](https://github.com/pallets/flask/pull/5918), [changed files](https://github.com/pallets/flask/pull/5918/files).
- [History](https://github.com/pallets/flask/commits/main/), [commit](https://github.com/pallets/flask/commit/d73fa1cdcbd8b1465c151db8924ba58b1dd14e35), [Actions](https://github.com/pallets/flask/actions), [run summary](https://github.com/pallets/flask/actions/runs/37081133574).

Public GitHub content changes. Its newer issue workspace also differs from its PR workspace: the issue list has a contextual sidebar, while repository tabs remain the main PR navigation. Golf should share spacing and primitives without forcing every workflow into an identical shell.

Ignored local artifacts are retained under `.tmp/github-visual-audit/`. `manifest.json` records initial URLs, screenshots, dimensions, row measurements and active elements; `after-manifest.json` records served Golf dark/light desktop/mobile captures and overflow checks. Paired accessibility snapshots preserve the visible controls. This directory contains local development fixture data and is not a distributable documentation asset.

## Comparison and decisions

| Area | GitHub observation | Implemented Golf refinement | Missing capability / next task |
| --- | --- | --- | --- |
| Repository header | Compact owner/repository identity; contextual tabs immediately below | One-line identity and visibility; shared breadcrumbs; removed redundant back link/owner eyebrow | Canonical owner profile and permission-aware watch/star/fork controls |
| Code tree | About column, roughly 41px rows, folders before files, small leading icons | 40px rows, folders first, About metadata column, shared 16px padding and 14px text | Last commit/date per path, path history, file finder and tag inventory |
| Code menu | Clone protocols and copy affordance; branch/tag picker with search | Real HTTPS/SSH addresses in a Code disclosure; account SSH settings link; existing paged branch picker | Explicit copy buttons, archive downloads, tag selection and loaded-branch search |
| README/file | Separate content controls, heading outline, source actions | Safe rendered/source toggle, images and syntax, pinned file URLs and breadcrumbs | Outline, history/blame/raw/download/edit actions and larger-file UI |
| Issue/PR rows | Strong title, concise author/number/time, state icon, trailing comment/check metadata | Shared TanStack filtering/sorting configuration; loaded-only search, sort, counts and state selection; compact metadata and comment icon | Server query grammar, labels/assignees/milestones/review filters, aggregate counts, selection/bulk operations and permission-aware row menus |
| Issue conversation | Title/status above bordered description and activity; metadata at right | Shared discussion summary/card/main/sidebar pattern, explicit comment editor, private draft survives background revalidation | Author avatar, timeline events/reactions, edit/delete/close/reopen, relationships, assignment and labels |
| PR conversation | Workspace tabs above discussion; metadata sidebar; chronological activity | Tabs above description; native reviews/discussion before automation inventory; comparison details at right | Unified event timeline, Commits/Checks tabs, reviewers/assignment, human review submission and draft/ready transitions |
| PR Files changed | File navigation, compact hunk rows, Viewed, view preferences and file menu | Existing file navigation/filter, split/unified, collapse, line anchors and session Viewed; shorter header | Inline threads/suggestions, persistent Viewed, whitespace/context controls, syntax in diffs, accessible file actions and trusted checks |
| Commits | Concise grouped history and direct SHA/source/diff actions | Existing exact source/diff links and shared compact list rules | Grouped dates, verification/author avatars, history search, comparison and per-path commits |
| Actions | Contextual workflow sidebar; runs before configuration; run/job/step/log workspace | Runs and coding tasks before inspection; canonical run workspace, summary/source receipts and sequence-paged log search/download; settings/policies remain separate; shared live invalidations refresh authorized observations | Workflow navigation/server filters, job/step graph/events, high-volume logs/line permalinks, rerun, artifacts/cache and broader execution engine |
| Settings | Contextual navigation and scoped current values rather than work-page clutter | Existing account/repository/org/admin layouts and shared searchable inventories; profile and infrastructure screenshots retained | Authenticated GitHub reference pass and remaining supported policy/lifecycle wiring |
| Live status | Work changes appear without repetitive refresh controls | Shared private Connect stream; refresh controls hidden when connected, visible on disconnection; immutable source/comparison remain pinned | Multi-replica/proxy/load qualification, retention and safe native/ACP progress logs |

Do not place an inert “…” button, review/merge control, fake count, cached check success, unsupported workflow action or nonexistent deployment link merely to match a screenshot. Implement the underlying operation, exact authority/outcome contract and failure state first. Native supported APIs remain the forge boundary.

## Visual acceptance

Use the same viewport and theme for each comparison. Check populated, empty, loading, denied, long-title, long-path and large-diff states. Inspect the viewport screenshot as well as the full page; a page can have correct individual cards but place work below the fold.

Desktop baseline: 14px interface text, 16px Markdown, 40px file rows, 16px panel padding, 20px shared section gap, compact tabs and controls. Mobile retains 44px touch targets, wrapping navigation, single-column metadata and no document horizontal overflow. Code/diff/table regions may scroll internally. Keep visible keyboard focus, accessible control names and explicit loaded-only filtering limits.

Final served-image qualification captures ten Golf pages in both themes at1280×900 and390×844, producing40 screenshots with no document horizontal overflow. The full250-test browser suite passes. At the desktop reference viewport:

| Work position | Golf before | Golf after | GitHub reference |
| --- | ---: | ---: | ---: |
| First Code tree row | 467px | 318px | 307px |
| First PR diff row | 773px | 588px | 450–478px, depending on header/content |
| Actions run-table header | 682px | 436px | Different workflow-sidebar structure; compare workspace rather than an identical row |

These are vertical positions within the viewport, not row heights. Golf source rows remain40px versus approximately41px in the reference. PR list rows tighten from107px to94px; further metadata/control alignment remains open. Different data, permissions and signed-out GitHub controls prevent pixel equality from being a functional acceptance test.

Measured acceptance and test/image revisions are recorded in [implementation status](IMPLEMENTATION_STATUS.md). The full requirements remain in [repository experience parity](REPOSITORY_EXPERIENCE_PARITY.md); this audit supplements GX-1 through GX-8 rather than completing them.

### Actions run follow-up

The actual retained automatic shell run now opens in the full-page workspace; desktop/mobile dark/light captures are retained as `golf-action-run-*-after.png`. The first screenshot exposed search/action wrappers missing the shared classes; final markup uses the existing `search-input` and `row-actions` styles. The current worker produces no structured per-step events, so the workspace does not infer a job graph from stdout.
