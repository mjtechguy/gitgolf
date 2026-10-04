# Operator-global Gitea reference hook qualification

Status: **attempt2 PASS for bounded operator-global hook composition; P0.8 remains open**. This packet is a qualification tool, not a production protected-write adapter. It changes no Golf runtime, ingress profile, schema, repository settings or deployment defaults.

The root-run [attempt1 manifest](../.tmp/gitea-reference-hook-attempt1/manifest.json) remains **FAILED**: it preserves positive other-branch Git/editor and ordinary-reader/outsider checks, then failure before the first rejection at missing telemetry. The encoded startup key omitted the terminating underscore of each escaped period, so the intended hook configuration was never established. Those positive controls do not qualify hook composition. All owned containers/volumes/networks were removed and foreign identities stayed unchanged; the attempted sole-bootstrap CLI purge was separately a cleanup failure. Attempt2 corrects that fixture defect and reports bootstrap token revocation plus fresh-volume disposal explicitly.

## Bounded actual receipt

The [attempt2 manifest](../.tmp/gitea-reference-hook-attempt2/manifest.json) reports `qualified_bounded_hook_composition` from frozen source `4ad746c7e863af60824b15a6f33803f2a897bc79`. The [compile receipt](../.tmp/reference-hook-frozen-4ad746c/compile-receipt.json) pins the exact source hashes and Linux/ARM64 helper; no runtime build or image pull occurs in the launcher. The root's [main checks](../.tmp/settings056-inputs-and-reference-main-check.log) also pass. This fresh provider fixture is separate from retained Golf/schema056.

| Receipt | Exact value |
| --- | --- |
| Gitea version / actual Git | 1.27.3 / 2.54.0 |
| Native image | `sha256:1c17ecaead42eb3b5391553d8708103a4beb0e86edf5b9ebc1eb269c318845f2` |
| PostgreSQL 18.4 image | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` |
| Helper SHA256 | `b2e66ffc83c9273cb44b7026f025212761d493959bd5d5dfa887161aedbc34ba` |
| Immutable fixture bundle SHA256 | `e4a692c6c8d0a2c4e914b2dba125a60cc94568fb924c27b56d82a27af03b1f3d` |

The [57 ordered events](../.tmp/gitea-reference-hook-attempt2/hook-events.json) contain 43 exact-receiver and 14 temporary-clone callbacks. All four native receive delegates returned actual success at least once; proc-receive created the independently checked native PR. `preparing`, `prepared`, `committed` and `aborted` were all observed. The two receiver marker vetoes at sequences 33/47 were followed by `aborted` at 34/48. That is a bounded observation on this pinned Git, not an abort-based safe-release or retry contract.

The native file editor returned HTTP500 for the vetoed request. Its no-update observation comes from the exact receiver's prepared rejection and independent unchanged branch/blob readback, **not** from HTTP500. This result supplies no general native500/no-effect guarantee or proof that another already issued operation stopped.

Cleanup records 4/4 ordinary actors CLI-purged, bootstrap token revoked with subsequent 401, and bootstrap account disposed through fresh-volume teardown. Owned container/volume/network counts are zero; all foreign full IDs/images/status/running match, with zero lifecycle observations. The original failed attempt is preserved, and no retained hook/policy was changed.

## Supported integration candidate and version scope

Gitea documents arbitrary native Git options in its [`git.config` section](https://docs.gitea.com/1.27/administration/config-cheat-sheet/#git---config-options-gitconfig). Its [v1.27.3 startup implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/git/config.go#L100-L105) applies those options after defaults using native global Git configuration. The fixture supplies `core.hooksPath` through that operator configuration, mounted outside native repositories. This composition is an inference from documented configuration and Git facilities; Gitea does not document it as a conditional-publication API.

The source requires Gitea **1.27.3**, PostgreSQL **18.4**, and the actual cached provider's Git **2.54.0**. Attempt2 verifies those versions, the effective hooks path before writes, and the callback's own Git version/configuration. Earlier Git 2.39.5 investigations retain their original scope.

[Git 2.54.0 hook documentation](https://github.com/git/git/blob/v2.54.0/Documentation/githooks.adoc) describes `preparing`, `prepared`, `committed` and `aborted`, and says a nonzero preparation callback rejects the transaction. It also says an `aborted` callback is not invoked for a preparation veto. However, the [pinned implementation](https://github.com/git/git/blob/v2.54.0/refs.c) calls `ref_transaction_abort` when the preparation hook refuses, and that abort path invokes the hook. The qualifier records actual states without requiring or inferring an abort notification. Neither absence nor presence of `aborted` establishes a released reservation or safe retry.

## Four owned files

- `scripts/gitea-reference-hook-smoke.py`: stdlib-only fresh-stack launcher and closed evidence writer.
- `scripts/reference-hook-fixture/main.go`: stdlib operator-owned hook fixture.
- `scripts/reference-hook-fixture/main_test.go`: transaction, delegation, context and bounded telemetry tests.
- This document: source contract, bounded actual acceptance and remaining production gates.

No native fork, native SQL update, managed repository file edit, repository-author script, global Golf lock or production policy consumer is added.

## Immutable bundle and callback behavior

The operator compiles the Go fixture for the cached native image's Linux architecture and supplies its independent SHA256. The launcher verifies ELF architecture/hash and exact cached image IDs. It never pulls images or builds binaries.

The fresh fixture creates only its random personal owner, ordinary writer, ordinary reader, outsider and token-bearing bootstrap admin. The admin bootstraps ordinary actors; positive write tests use the ordinary owner/writer, whose native `is_admin` flags must be false. A private auto-initialized repository is seeded before hook activation. Only that fresh native service is then recreated with startup configuration:

```ini
[git.config]
core.hooksPath = /opt/golf-hook-fixture
```

The equivalent supported Docker configuration key is `GITEA__git_0x2E_config__core_0x2E_hooksPath`; the [pinned environment decoder](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/config_env.go) requires the trailing underscore in each `_0x2E_` escape. Pure counterexamples reject the original missing-terminator spelling. `[git] HOME_PATH` is explicitly fixed to `/var/lib/gitea/data/home`; before any positive write, a read-only Git command using that native HOME and the exact receiver checks its effective `core.hooksPath`. Only the expected fixed path, exit code and presence/match booleans enter evidence; unexpected values/environment are never logged. The generated bundle is mounted read-only. Its fixed scripts execute the fixture with literal hook names and unchanged positional arguments. The descriptor contains only the exact fresh receiver path and `refs/heads/main`; it is not a user-authorized policy or immutable repository identity primitive.

For every callback, read-only native Git commands obtain the absolute Git directory, effective hooks path and actual Git version using the callback's inherited Git context. The fixture does not use pusher IDs, `EnvIsInternal`, command arguments or raw environment as actor authority. Those cannot bypass the marker rejection.

The native receiver path must exactly equal the operator descriptor. Any prepared transaction containing `refs/heads/main` there is rejected, including zero-old and deletion values. There is no bootstrap exception: seeding occurs before activation. Other ordinary branch updates are positive controls. This fixed marker is qualification behavior, not pattern enforcement, review/check policy or production write authorization.

The [native temporary-repository facility](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/repository/temp.go) creates editor clones under `AppDataTempDir("local-repo")`. The fixture explicitly sets `APP_DATA_PATH` and clears `APP_TEMP_PATH`; the [pinned path implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/path.go#L192-L204) puts those contexts under `/var/lib/gitea/data/tmp/local-repo/`. Reference transactions there are labeled `temporary_clone` and observed, rather than mistaken for the canonical receiver. This allowance relies only on the fresh operator-owned fixture topology. It does not establish production temporary-clone authority, namespace integrity or prevention of a hostile native filesystem writer. Other contexts are refused and make qualification fail.

Gitea's [generated hook implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/gitrepo/hooks.go) supplies pre-receive, update, post-receive and proc-receive. The fixture invokes each existing generated root delegate at the resolved receiver's `hooks/HOOK`, without changing its file, cwd, inherited environment, arguments, stdin, stdout, stderr or exit code. The generated `.d/gitea` dispatch remains native. Missing, symlinked, non-executable or writable-by-group/other root delegates fail closed. A receive callback in a temporary/unclassified context cannot silently skip its native delegate.

The binary proc-receive exchange is streamed unchanged. It is never parsed as text reference records or captured in telemetry. Actual [AGit](https://docs.gitea.com/usage/issues-prs/agit/) `refs/for/allowed/...` publication must create a native pull request with the independently known head and base; a source mock of delegate output cannot satisfy this runtime gate.

## Bounded telemetry and input

Reference input is at most 64KiB/64 unique rows, with exact spaces and final LF, full lowercase 40/64 OIDs of one width or typed symbolic reference values. Malformed, duplicate or unsupported records fail closed. This grammar deliberately covers only the ASCII ref names used by this fixture; Unicode production refs and every native transaction shape are not qualified by it.

Telemetry uses a separate 1MiB tmpfs outside provider data, with 0600 files, a local file lock, contiguous sequence numbers, at most 512 events/512KiB aggregate and 16KiB per event. It contains fixed hook/state/context/decision enums, checked Git version/configuration, typed ref/OID metadata and actual delegate exit codes. There are no credentials, raw environment/argv, source bodies, native error messages or proc protocol bytes. A preparation-stage record failure refuses that transaction. A post-receive/committed-stage record failure cannot retract a completed native update; the qualifier fails its readback/telemetry gate and supplies no durable recovery guarantee. This telemetry is neither a durable Golf journal nor a policy lock; it disappears with the owned native container.

The launcher records the exact images, helper/bundle hashes, native container/owned repository IDs, baseline commit, preparation veto status and observed callback states. Missing telemetry records only fixed availability state, directory-readability and JSON-file count; missing rows never count as a PASS. Native API bodies, Git stderr, CLI tokens/passwords and environment-bearing Compose files stay in memory/private temporary files and are removed. Only fixed stage/type/numeric source-line errors are reported. The copied fixture binary and operator configuration are outside managed repository paths; all source/ref mutations use Git or supported native APIs.

## Root-run recipe

Only the root agent executes runtime qualification. Image arguments must be full IDs already present locally; the native image must contain Git 2.54.0. Choose `arm64` or `amd64` from that exact image. Compilation is an operator action, not a launcher action:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath \
  -o .tmp/reference-hook-fixture ./scripts/reference-hook-fixture
shasum -a 256 .tmp/reference-hook-fixture
python3 scripts/gitea-reference-hook-smoke.py \
  --native-image sha256:EXACT_CACHED_NATIVE_IMAGE_ID \
  --postgres-image sha256:EXACT_CACHED_PG_IMAGE_ID \
  --hook-binary .tmp/reference-hook-fixture \
  --hook-sha256 EXACT_HELPER_HASH \
  --output .tmp/gitea-reference-hook-attempt1
```

The launcher requires at least 2GiB free in the Docker VM before stack creation, bounds database WAL and service memory/PIDs, publishes only a random loopback HTTP port, disables SSH/native Actions and uses a new random `golf-hook-10hex` Compose project. No retained policy is changed. Native startup writes its own configuration through the documented facility. The hook descriptor is activated only after seeding; the receiver repository ID is rechecked after activation.

The finalizer attempts supported native repository and ordinary-user CLI purge, recording expected/actual ordinary-user counts. The sole bootstrap administrator is not labeled CLI-purged. Instead it verifies the current bootstrap token's exact name/login, uses the supported [current-token DELETE endpoint](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/token/token.go), and requires a subsequent token read401. Its remaining account/password state is disposed with the fresh owned native/database volumes. Token revocation and volume disposal have separate receipts; revocation failure fails qualification even if volumes are removed. The finalizer tears down only the exact owned Compose project including volumes, and independently checks zero running **and stopped** owned containers, volumes and networks. Filtered foreign before/after records contain only full container IDs, image IDs, status/running, start time and restart count. Identity/image/status/running changes fail qualification. Start/restart changes are separately disclosed lifecycle observations with no cause inference; they are never labeled completely unchanged. No mutable command targets foreign containers.

## Actual qualification matrix (attempt2)

| Case | Required independent evidence | Current state |
| --- | --- | --- |
| Operator config discovery | Exact callback Git 2.54.0 and effective hooks path; supplied binary/image/hash receipts | PASS, exact frozen fixture |
| Ordinary Git writer | Successful other-branch update, native branch exact expected commit | PASS, ordinary writer |
| Native contents editor positive | Valid other-branch edit; exact native commit readback | PASS, ordinary writer |
| Reader/outsider | Native file-write and Git branch-push denial; reader clone/ref read works | PASS |
| Git main rejection | Nonzero push + receiver **prepared** marker telemetry with exact B→C + native ref/blob unchanged | PASS, fixed marker only |
| Native editor main rejection | Non-success API + receiver **prepared** marker telemetry + native ref/blob unchanged | PASS, observed 500; not a general no-effect code |
| Temporary editor clone | Actual temporary-context callback observed separately from receiver | PASS, 14 callback events |
| Delegate preservation | All four native delegate success receipts plus actual AGit PR head/base bookkeeping | PASS, real proc-receive PR |
| Callback sequence | Record actual preparing/prepared/committed/aborted presence; no abort-based release claim | PASS, all four observed |
| Cleanup/foreign scope | Owned resource zero, unchanged foreign identities, disclosed lifecycle observations | PASS, zero lifecycle differences |

Pure source tests exercise full/symbolic records, malformed/extra/duplicate/control rows, zero-old marker rejection, exact receiver separation, temp-context behavior, native internal-env non-bypass, actual local test-process binary stdin/exit preservation, missing/unsafe delegates, telemetry concurrency/sequence/aggregate bounds and closed foreign predicates. They do not prove native callback ordering or native file-editor mediation.

## Acceptance still open

The successful run establishes only bounded operator-global composition on those pinned versions and this fresh fixture. It does not establish production protection, prove a complete solution without a native extension, or mark Rules/P0.8 Ready. Missing obligations include exact H/B/C and fork resources; immutable repository/namespace and current actor/policy/review/check predicates; applicable review/identity/team SQL transitions; external/native/SSH/LFS/wiki/mirror/auto-merge/background writers; all repository init/temporary/maintenance contexts; hostile configuration or hook override; durable reservation, cancellation, acknowledged outcome and crash/recovery/node fencing. A hook cannot reserve a second repository's live fork ref or native review SQL merely by participating in a local Git transaction.

No force/deletion/multi-ref/atomic-push/symbolic publication semantics beyond syntax, protection pattern precedence, unknown-operation recovery or scalable production broker is claimed. The fresh marker's observed abort notification must never be converted into a safe retry or unlocked durable barrier.
