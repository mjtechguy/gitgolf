# Own repository Star preference

Star is a current own-account preference. It grants no repository write, delegation, source or merge authority. The integrated source and bounded native/served proof below do not make repository settings or the full product Ready. Retained deployment is recorded separately in the [implementation ledger](IMPLEMENTATION_STATUS.md).

## API and current authority

`RepositoryService.GetRepositoryStar` takes `repository: RepositoryKey` and required `repositoryId`. `SetRepositoryStar` additionally requires `ownerId`, `nativeUserId` and a present `starred` boolean, including explicit `false`. IDs are canonical positive signed64 decimal strings. Both return `preference` with the observed canonical repository key, repository/owner/native-user IDs, a required present `starred` boolean and optional decimal `starsCount`. Missing count means unknown; zero is retained. Count and preference are independent current native observations, not an atomic total or selected-SHA receipt.

Both procedures require a managed browser session and matching Origin; API bearer credentials do not authorize them. A bounded15-second operation checks the current native actor/session and exact repository/owner identity before and after native observations. Replacement, transfer, logout or current private-read denial refuses the result. Instance administration provides no substitute native repository authority.

The supported native own-Star endpoint is `/user/starred/OWNER/REPO`: GET204 means starred; GET404 means unstarred only within those current exact repository/actor fences. A native403 from disabled Stars or insufficient feature scope is not false and is not automatically a repository-access denial. After the remaining repository/actor/session fences succeed, optional unavailability returns `FailedPrecondition` without a preference. A late actual authority denial takes precedence.

An explicit Set issues exactly one native PUT or DELETE and requires204, followed by matching current preference and identity readback. There is no journal, native CAS, operation key, automatic retry or rollback write. An attempted write with unresolved acknowledgement/readback returns a fixed `Unavailable` notice; actual authentication/private-read denials retain their privacy error codes. Current state cannot establish which operation caused it.

## Browser behavior

The shared repository header shows **Star** or **Unstar** from a validated current observation. An explicit click sends one desired-state mutation; pending double clicks cannot dispatch another. Success uses the matching response, while uncertainty offers **Inspect current preference**, a GET-only action. Inspection/reload observes current native state and never adopts it as the original write receipt or resends a mutation.

Original desired state and uncertainty stay in memory, not browser storage. Account/target changes, signout and parent revalidation hide private observations; late responses cannot restore an old scope. Actual permission loss clears repository-private content. Optional feature unavailability preserves the otherwise authorized repository. Exact sidebar metadata invalidation follows a validated mutation or inspection; it does not manufacture a new count.

## Bounded evidence

[PostgreSQL/race and boundary checks](../.tmp/repository-stars-postgres-attempt1.log) pass2.844s with the owned database removed. Tests cover explicit false/unknown count, large native IDs, wrong identities, exact native status handling, disabled feature versus real authority loss, logout, accepted-response loss and no duplicate write. [Integrated source checks](../.tmp/settings-stars64-main-check-attempt1.log) pass. The source browser suite passes24 cases ([log](../.tmp/repository-stars-ui-worktree/.tmp/stars-ui-evidence/tmp-stars-browser-qualified.log)); mocked responses are source regressions, not actual native proof.

[Actual attempt2](../.tmp/repository-stars64-served-attempt2/qualification/manifest.json) qualifies two ordinary managed actors and one private native repository on frozen component `9ddc7e7213cb7b910753e682de98d8d361f6ffae`, core `sha256:1e7cd578843ab585fdfd3d6dcced31f320c05df1f95128167fad6fe03ffb7e80`. Both actors explicitly Star and Unstar; independent supported native reads verify own preference and counts. Wrong original repository/owner/user IDs have no effect, current reader removal denies reads/writes, and restart uses GET-only current inspection without effect attribution.

The [actual browser manifest](../.tmp/repository-stars64-served-attempt2/qualification/browser/manifest.json) passes one explicit Star click, reload without another Set, and four subsequent read-only dark/light1440/390 captures. It records exactly one Set request/response and no persisted credentials. The [parent receipt](../.tmp/repository-stars64-served-attempt2/parent-manifest.json) records passed owned cleanup and unchanged foreign container identities. Its reused scope string says release reads; the Star-specific child manifests establish the qualified feature scope. That original label is preserved.

[Attempt1](../.tmp/repository-stars64-served-attempt1/parent-manifest.json) remains failed at the first browser view, with cleanup passed. It is not relabeled by attempt2. Optional-feature and uncertainty cases have source/database evidence; actual native lost acknowledgement, simultaneous changes, every feature-disabled deployment, Watch/Fork preferences and broader repository completion remain unqualified.

The prepared helpers are [native/managed qualifier](../scripts/repository-stars-smoke.py) and [actual browser driver](../scripts/repository-stars-browser.mjs). Their `--self-check` modes open no resources. Actual execution requires an operator-provisioned fresh closed stack, exact core image/source, loopback endpoints and a fresh owner-only output directory; the operator disposes the stack after helper-owned actors/sessions are purged or disabled.
