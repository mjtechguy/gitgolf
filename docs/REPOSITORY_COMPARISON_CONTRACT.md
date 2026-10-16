# Repository comparison and New pull request

Golf's shared portable/Cloudflare core now exposes a bounded native comparison and a full-page New PR flow. AI and Cloudflare are optional. This extends the [PR mutation contract](PULL_MUTATION_CONTRACT.md), not protected merge authority. Exact qualification and served images belong in the [implementation ledger](IMPLEMENTATION_STATUS.md).

## Selection-bound read

`RepositoryService.GetRepositoryComparison` accepts a `RepositoryComparisonSelection`: target and source repository keys, their positive immutable decimal-string IDs, existing named base/head branches and their displayed full lowercase40/64-character commit IDs. Both commits must have the same width. Empty/invalid branches and `refs/` prefixes are refused. Target and source access are independently revalidated, including caller identity, native repository identity and current Golf session before and after successful waits.

The read uses supported Forgejo comparison APIs. Same-repository addressing selects exact `baseSHA...headSHA`; another source selects explicit `baseSHA...owner/repository:headSHA`, supporting renamed private forks. The named branches must still match the selected commits before and after the native JSON/diff reads. Missing, rebound, inaccessible or changed selections fail rather than following new heads. These are repeated observations, not ref locks, atomic target-ID predicates or ABA prevention.

Returned commit IDs must be full-width, unique and valid. Native commit URLs must identify the separately authorized source repository and exact commit; they are validated, never fetched. Author/time/message fields are bounded. The native comparison JSON is unpaged, bounded to500 returned commits, and its `total_commits` must match the array. This count describes the native response; it does not independently prove that the provider emitted every commit.

Raw diff uses the existing512KiB content-type/UTF-8/control bounds and returns an exact byte count. The native formatter has no completion marker, so Golf does not claim independently verified patch completeness. No mergeability, trusted passing decision, review approval or merge availability is inferred. Large comparisons outside these preview limits are refused; tags, arbitrary ranges and full-scale comparison remain required.

The generated read accepts browser sessions and existing owner-issued read-only Golf API delegation, with the underlying native read scopes and repository permissions. Exact Origin applies to browser requests. PR creation remains browser-session-only; adding this read does not grant delegated writes or add a new CLI/MCP command.

## Work page and explicit editor

`/OWNER/REPOSITORY/compare` accepts optional `base`, `head`, `sourceOwner` and `sourceName` query strings. Repository names and named branches remain explicit inputs; slash-containing branches do not become ambiguous route segments. New pull request links open this page. Base/head menus page native branches and search only loaded rows. Source selection accepts an explicit owner/repository and independently reads its native identity; it is not a global repository finder.

An explicit Compare action pins the loaded branch commits. Files changed and Commits reuse the shared diff/history components; source commit links use the source repository, including a renamed fork. Open pull request exposes the shared TanStack discussion form and safe Markdown preview. Title/description and ready/draft values bind the original comparison. Only a one-commit comparison suggests that commit's title. An empty comparison cannot open a fresh proposal. Branch/source changes are disabled while the editor or an unresolved creation intent is open.

Target and source activity watches refresh branch observations without replacing the pinned comparison or unsent draft. A changed or currently rechecked branch disables fresh submission until the original comparison can be validated. Independent source-fork access loss removes the comparison/editor and unsent private text; target/session loss uses the existing broader private-cache cleanup. Live activity does not promise immediate visibility of arbitrary native changes outside Golf's event mechanism.

Creation captures its UUID-bound payload once in memory. Tab storage retains only owner/repository/kind/key metadata. Reload uses GetIssueMutation to inspect the result without restoring source text or resending the native POST; a removed source branch cannot prevent that metadata-only status inspection. Missing, mismatched, inaccessible or uncertain results retain the key. Confirmed results navigate to the canonical PR. The mutation contract retains native dispatch, receipt/readback and non-atomic limitations.

## Visual and accessibility contract

Selectors, menus, editor, commit rows and diff controls use shared components/global CSS. Desktop remains compact; mobile preserves44px interactive targets. Branch disclosures keep bounded scrollable content, fit above/below when necessary, and dismiss with Escape/focus return. Both themes preserve Golf's Archivo typography, lime accent, black/charcoal dark background and neutral light theme.

Actual GitHub/Golf pairs cover default pages, open branch/clone menus, comparison commits/files and the explicit editor at1280px/390px. The compact mobile global header keeps workspace selection, account and theme controls on one row; personal repositories and organizations remain reachable through the workspace switcher. The comparison controls use two aligned source/branch rows. Screenshots establish layout, not native permissions or protected merging.

## Remaining requirements

Human review submission/inline threads, richer metadata and row actions, server-side branch/repository finding, tags/ranges, additional diff context/whitespace controls, CLI/MCP coverage and protected merge/squash/rebase remain open. No SQL migration is introduced by this read/UI. Schema033 recovery remains refused beyond the operator's qualified checkpoint; latest coordinated recovery and P0.8 protected integration are unqualified.

Primary sources: [pinned comparison API](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/compare.go), [native comparison parsing](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/common/compare.go), [PR source selection](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/pull.go), [GitHub PR creation flow](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request).
