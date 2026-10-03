# Native feature and URL audit

Reviewed 2026-10-03 against Golf source `44a9c7823718a9a942f28cc5e7797d9b82b38a67` and the installed Gitea 1.27.3. Both infrastructure tracks retain the same supported native API/Git boundary. This is an implementation inventory, not full parity qualification.

## Native integration

Golf's custom UI calls its own typed API; `internal/server/forge.go` translates to supported `/api/v1` requests using the current caller's provider credential. Exact-target reads independently recheck native identity and current permissions. Native Git handles repository objects and transport; Golf owns sessions, journals, private drafts, policies and agent orchestration. The inspected product adapters do not write the native database or canonical repository files directly. Follow the [pinned native API router](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/api.go) and installed OpenAPI when adding features, rather than assuming the latest documentation matches this installation.

| Area | Current integration | Remaining product coverage |
| --- | --- | --- |
| Source | Repository creation, source/history, branches/tags, commit/PR comparisons, Git clone/fetch/push through native transports | File editing/upload, branch/tag mutations, blame, richer search and fork/import/mirror UI |
| Collaboration | Issues/PRs, comments and lifecycle, overall human reviews, bounded inline reads; separate encrypted Golf private drafts | Native inline publication/drafts, replies/resolve, dismissal, suggestions, reviewers/CODEOWNERS, labels/assignees/milestones/reactions |
| Administration | Own SSH keys/profile, general repository settings, collaborators, organization/team reads and bounded membership edits | Full organization/role lifecycle, transfer/archive/delete, unified suspension and Git credential ingress |
| Native capabilities | Supported adapter reads/writes above | Releases/assets, notifications/watch/star, Wiki, packages and remaining native features need deliberate adapters/UI and tests |
| CI | Native Actions deliberately disabled; Golf's own bounded shell engine | Maintained GitHub/GitLab workflow execution, multi-job/actions/matrices/services/reusable workflows, artifact/secret/provenance and executor parity |

Two immediate integration gaps deserve explicit tasks. Repository settings expose native Wiki/Issues/PR toggles while navigation always shows Issues/PR and has no Wiki surface; enabled units and usable Golf controls must agree. Golf passwords and `golf_ro_` API credentials are not native HTTP Git credentials. SSH keys normally remain independent of browser logout/password changes, but disabling a Golf account must eventually enforce the intended suspension across native Git/API ingress as well. See [Git access contract](GIT_ACCESS_CONTRACT.md). Protected merge and bypass/write-path enforcement remain the P0.8 release gate.

## URL contract

Golf already uses familiar `/OWNER/REPO`, `/issues/N`, `/pull/N/files`, `/commit/SHA` and `/actions/runs/ID` shapes. Gitea does not impose the custom browser URLs. Its API and Git transport URLs are separate interfaces.

Current source links are immutable `tree/SHA/path` or `blob/SHA/path`; branch/tag names are query context, not proof that a ref still points to the selected SHA. This avoids ambiguity between slash-containing refs and paths. GitHub supports both ordinary branch/ref URLs and immutable SHA permalinks; see [GitHub permanent-link documentation](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files).

The current implementation needs cleanup:

1. Strip `ref` when the route already encodes that SHA, and remove unrelated list/source query state while preserving deliberate return context.
2. Add canonical `/OWNER/REPO/settings` and supported settings subpaths, retaining old `/repositories/...` aliases.
3. Normalize legacy links even when their selected SHA is unchanged; distinguish directories (`tree`) from files (`blob`) using authoritative returned kind.
4. Apply equivalent validation to canonical and legacy deep links.
5. Add readable branch/tag entry URLs through an explicit resolver that handles slash refs, branch/tag name collisions, literal paths, renamed repositories and current authority. Resolve to an exact snapshot for API/agent/review operations; keep explicit immutable permalinks. Do not silently resolve ambiguity by guessing.

Source evidence: `web/src/navigation.ts`, `web/src/router.tsx`, `web/src/RepositoryBrowser.tsx`, `web/src/RepositoryRefs.tsx`; supported adapter evidence: `api/golf/v1/golf.proto`, `internal/server/forge.go`, `internal/server/pulls.go`, `internal/server/repository_settings.go`, `internal/server/git_access.go` and `compose.yaml`. Existing route/ref tests cover slash branches, back/forward/reload, exact tag commit selection and authority failures. They do not establish completed readable-ref URL or native feature parity.
