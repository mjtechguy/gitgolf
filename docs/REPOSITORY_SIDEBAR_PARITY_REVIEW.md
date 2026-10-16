# Repository sidebar and layout parity review

Reviewed 2026-10-03. This is a read-only design and source review, not qualification of a new product feature.

## Evidence and provenance

Public, signed-out GitHub captures were made with agent-browser 0.38.2 in a fresh isolated browser session. References are a public open-source forge repository on GitHub (since unlinked), [golang/go](https://github.com/golang/go), that forge repository's README file, its public Issues view, and one of its public pull requests. No user browser session or credentials were imported. Both light and dark repository root views were captured at 1280 and 390 pixels; file, issue and PR contextual examples were captured in light mode at 1280. These establish observed layout, not authenticated GitHub permissions or all responsive states.

The ignored local evidence directory is `.tmp/repository-sidebar-review/`: eight root/sidebar PNGs, three contextual PNGs and `public-metrics.json`. Metrics record the actual scroll position: some light/mobile captures settled a few pixels below document origin. Use document coordinates (viewport position plus scrollY), not an assumed zero scroll. The dark desktop root capture has scrollY=0. GitHub counts and public page content are volatile; none should be copied into fixtures as expected constants.

Golf source was inspected through main `eabe5b9910d503cd58ae28991ead0cd5d51b9d8d`, before the in-progress overview/sidebar implementation. A fresh anonymous localhost:8080 session showed sign-in only. The authenticated Golf comparison uses retained actual native-fixture images `.tmp/url-unit-served-proof/native-draft-code-{dark,light}-{1280,1920,390}.png`, qualified earlier on source bfbb5de and runtime c385df. The pictured private fixture has been purged. These are historical served observations, not fresh screenshots of current main or the later 44e runtime. No native fixture, login or deployment was performed during this review.

## Main conclusion

Golf already has a useful right-column foundation and approximately GitHub's desktop file-row density. Its largest root Code layout problem is that the ref/Code toolbar sits **above both columns**. The Code button is consequently over the About rail, and About starts a toolbar row below the branch selector. Put the toolbar inside the left Code workspace, then align About with its top. Enrich that rail with verified repository information; do not fill it with repeated visibility/default-branch/history details or invented activity.

Retain Golf's black/charcoal surfaces, lime accent, logo, typography and shared controls. GitHub supplies information hierarchy and spatial relationships, rather than a new color system.

| Observation at 1280 px | Public GitHub root | Historical Golf root | Recommendation |
| --- | --- | --- | --- |
| Left workspace | x32, width904 | x24, width928 | Preserve Golf's wider usable workspace |
| Right rail | x976, width272 | x976, width280 | Existing 280px rail is appropriate |
| Column separation | 40px | 24px | Retain 24px; avoid adding more wasted space |
| About heading top | y206 | y255 | Align with the ref toolbar, not the file banner |
| Desktop file rows | about41px | about41px | Keep density; do not globally shrink text |
| Rail heading | 16px | 16px | Keep readable section headings |

At 1920, Golf's existing 1440px maximum provides a coherent content cap; a wider screen should increase the left workspace without stretching prose indefinitely. At 390, GitHub removes the About heading/desktop rail, keeps one compact branch/Code row, shows abbreviated file metadata and places lower metadata modules after the main content. Golf's current branch inventories occupy another row and its file rows wrap commit metadata. Those are useful data-dependent differences, not evidence that every row must be forcibly shortened. Prioritize a stable toolbar, readable long filenames, and a compact summary over hiding meaningful controls.

## What is implemented, available, and missing

| Section | Current Golf baseline | Supported native data and limit | Required next step |
| --- | --- | --- | --- |
| About | Description; visibility, default branch, updated date; root Code only | Native repository includes website and several counters currently omitted from Golf's repository model | Bounded current-repository overview; safe website link; remove redundant rail rows |
| Topics | No repository chips | Paged `GET /repos/{owner}/{repo}/topics`, with total header | Show real topics; no dead search links; explicit authorized Edit later |
| License/resources | Exact README preview exists | `GET .../licenses` returns indexed identifiers; source APIs can inspect actual resource files | Separate indexed license identity from exact selected-file links |
| Stars/watchers/forks | No header counters/actions | Native repository counts plus stargazer/subscriber/fork APIs | Read-only counts first; independently implement mutations and recovery |
| Languages | No meter | `GET .../languages` returns stored language-byte statistics without indexed commit/time | Honest repository-index label; validated byte totals; text legend |
| Releases | Tags exist; no release workspace | Native release list/latest/asset APIs, separately permissioned release unit | Real release route and unit-aware reads before sidebar links |
| Contributors | No complete contributor inventory | No contributors route found in pinned API router | Real authorized aggregation/index design; recent authors are a different feature |
| Packages | No repository registry workspace | Owner/package APIs exist; linked repository metadata requires correct filtering and authority | Repository-linked package inventory and actual destination |
| Deployments/environments | No qualified per-repository deployed-environment inventory | Golf's infrastructure configuration is not evidence of a project deployment | Build portable CD projection and live protected deployment links first |

Native source, reviewed on the since-retired backend and linked here at its Forgejo 15.0.9 counterpart (not re-qualified), supports the metadata described above: [repository schema](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/structs/repo.go), [API routes and permission guards](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/api.go), [topics API](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/topic.go), a license API on the since-retired backend (no Forgejo 15.0.9 counterpart is linked), and [language API](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/language.go). These are source observations; pagination, permission and freshness behavior still require runnable Golf/native evidence.

The language endpoint reads stored statistics by repository ID; its response does not identify the indexed commit. Label it **Repository language statistics**, with an accessible explanation that it is provider-indexed and not tied to the viewed snapshot. A selected historical tag must not make this meter appear exact for that tag. See [stored language statistics](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/models/repo/language_stats.go).

A release is not a tag count. Native latest excludes drafts and prereleases; release `target_commitish` is not necessarily an exact commit. A source link must resolve the typed tag and retain its peeled commit. Release-unit access must be checked separately from Code access. See [release handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/release.go) and [release schema](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/structs/release.go).

## Ranked implementation tasks

### 1. Align the root Code workspace and About rail

`web/src/RepositoryBrowser.tsx:160–161` and `web/src/styles.css:743,762`: move the toolbar into the left column of the root source layout. Keep nested file browsing independent of the root sidebar. Use one shared sidebar section primitive with heading, optional real count/action, content and separator. Desktop controls remain compact; mobile targets remain at least 44px.

`web/src/styles.css:653,766–772`: retain the 1440px cap, 24px desktop gutters, 280px rail and existing typography. Use min-width:0, wrapping URL/topic text, and one responsive grid rule. Do not add page-local layout engines or repeated card padding around every rail section.

### 2. Ship truthful About/topics/licenses/counts/languages

Introduce a lazy root-only overview query bound to the displayed native repository ID and current caller authority before and after the read. Return independently classified optional sections; absent/error/unavailable must not become zero, empty or success. Keep current repository metadata separate from exact snapshot resources. Cancel and erase private query data on sign-out or revocation. Renamed/replaced repositories must not silently populate the old workspace.

At the review baseline, backend/UI peers were implementing this narrower overview slice; the subsequent qualified checkpoint is recorded below. It intentionally excludes releases, contributors, packages and deployments.

Website links should admit safe schemes and use clear labels. Topics should wrap as small chips; make them links only when a real authorized search exists. GitHub documents that its topic names can be public even on private repositories; Golf should retain tenant/private visibility rather than copying that discovery behavior. See [GitHub topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

Validate language names, byte counts, bounded inventories and overflow before percentages. Use a stable token palette, text names and percentages, not color alone. Distinguish an available empty index from unavailable statistics. Counts may start as plain text; do not show actionable Star/Watch/Fork controls until real writes exist.

### 3. Consolidate README and actual resource navigation

`web/src/RepositoryReadme.tsx` already uses `.github`, root and docs priority with exact repository/commit binding. Preserve it and the existing GFM/image rendering. Add selected-snapshot license/contributing/security/code-of-conduct links only when files really exist and can be read. GitHub's [README rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) are a useful navigation reference.

The historical Golf README uses a header followed by a separate nearly empty Source toolbar. Consolidate that action into the resource header to recover vertical space while preserving the bound source/permalink behavior. Do not invent resource tabs from conventional filenames alone.

### 4. Keep context-specific sidebars

Public file view uses a left file tree and the remaining width for content; it does not retain root About. Golf's SourceNavigator and exact source workspace already follow that direction. Keep file actions and tree/search local to that context.

Public PR conversation uses Reviewers, Assignees, Labels, Projects, Milestone and Development sections; Files changed uses its own diff workspace. Golf's existing conversation comparison/merge sidebar should grow through real supported metadata, not become a repository About column. Issue detail similarly needs actual assignees/labels/milestone state. The captured GitHub Issues route rendered its newer Issues-wide left-navigation layout, so it is evidence of a contextual issue workspace, not a universal permanent repository sidebar. Preserve Golf's compact list/table conventions.

### 5. Build contributors, releases, packages and deployments honestly

Contributors requires a portable, authorized aggregation design with a defined revision span, mailmap/identity policy, bot handling, bounded indexing and visible freshness. A handful of commit authors must not be labeled Contributors or given a fabricated total. If a useful earlier slice is added, name it Recent authors and disclose its selected range. Avatars must come from authorized user identities with safe URLs/fallbacks, not exposed commit emails.

Release/package sections need real destination pages and permissions. Deployment sections need actual environment/status/provider data, protected links and expiry. These capabilities apply to both tracks; Cloudflare supplies adapters for the Cloudflare track rather than becoming a core requirement. Keep these acceptance criteria open until qualified.

## Shared component and acceptance guidance

Use `RepositorySidebar` plus small `RepositorySidebarSection` and resource/stat-link primitives, with shared global styles. Use 16px section headings, 14–15px content and readable 13px secondary metadata. Reuse Lucide icons, native links/buttons, accessible names and visible keyboard focus. Avoid icon-only status meaning, tooltips as the only label, unbounded topic wrapping or dynamic provider CSS. Static metadata sections do not need a table engine; true inventories should use Golf's shared TanStack/DataTable rules. Keep explicit Add/Edit actions and requested forms instead of permanent bare forms.

Before marking this slice verified, exercise both themes at 1280/1920 and390/320; rich and empty repositories; long Unicode names, URLs and topics; unavailable/empty language indexes; repository rename/replacement; wrong native ID; private permission loss; selected historical commit versus current repository metadata; independent section failure; and keyboard/touch disclosure behavior. Verify no horizontal page overflow, no hidden meaningful controls and no private-data residue after revocation. Qualify release-unit/package permissions independently when those features are implemented.

This review uses the fresh [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) for accessibility and interaction checks. Screenshot artifacts are ignored local evidence and are not included in the documentation commit. Full GitHub parity, contributor indexing and all deployment/registry workflows remain open.

## Subsequent bounded implementation

The root toolbar alignment and scoped About/topics/licenses/counts/languages slice is now implemented and locally served-qualified through `c35dc86`; see [overview contract](REPOSITORY_OVERVIEW_CONTRACT.md) and [final evidence ledger](IMPLEMENTATION_STATUS.md). Actual new root measurements place both columns at y208, retaining280px rail/24px gap and Golf styling; mobile places the sidebar after README. Shared README heading/actions are consolidated. This checkpoint uses new native fixture captures, not the historical Golf baseline above. Contributors/resources/releases/packages/deployments and contextual issue/PR metadata remain required follow-ups.
