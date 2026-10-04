# Operator-global Gitea reference hook qualification

Status: **source-only fixture prepared; native execution pending**. This packet is a qualification tool, not a production protected-write adapter. It changes no Golf runtime, ingress profile, schema, repository settings or deployment defaults. No hooks have been installed by this source work. P0.8 remains open.

## Supported integration candidate and version scope

Gitea documents arbitrary native Git options in its [`git.config` section](https://docs.gitea.com/1.27/administration/config-cheat-sheet/#git---config-options-gitconfig). Its [v1.27.3 startup implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/git/config.go#L100-L105) applies those options after defaults using native global Git configuration. The fixture supplies `core.hooksPath` through that operator configuration, mounted outside native repositories. This composition is an inference from documented configuration and Git facilities; Gitea does not document it as a conditional-publication API.

The source requires Gitea **1.27.3**, PostgreSQL **18.4**, and the actual cached provider's Git **2.54.0**. The root agent observed the last version through a read-only native version command. That observation does not qualify these new hooks. Earlier Git2.39.5 investigations retain their original scope.

[Git2.54.0 hook documentation](https://github.com/git/git/blob/v2.54.0/Documentation/githooks.adoc) describes `preparing`, `prepared`, `committed` and `aborted`, and says a nonzero preparation callback rejects the transaction. It also says an `aborted` callback is not invoked for a preparation veto. However, the [pinned implementation](https://github.com/git/git/blob/v2.54.0/refs.c) calls `ref_transaction_abort` when the preparation hook refuses, and that abort path invokes the hook. The qualifier records actual states without requiring or inferring an abort notification. Neither absence nor presence of `aborted` establishes a released reservation or safe retry.

## Four owned files

- `scripts/gitea-reference-hook-smoke.py`: stdlib-only fresh-stack launcher and closed evidence writer.
- `scripts/reference-hook-fixture/main.go`: stdlib operator-owned hook fixture.
- `scripts/reference-hook-fixture/main_test.go`: transaction, delegation, context and bounded telemetry tests.
- This document: source contract and still-pending runtime acceptance.

No native fork, native SQL update, managed repository file edit, repository-author script, global Golf lock or production policy consumer is added.

## Immutable bundle and callback behavior

The operator compiles the Go fixture for the cached native image's Linux architecture and supplies its independent SHA256. The launcher verifies ELF architecture/hash and exact cached image IDs. It never pulls images or builds binaries.

The fresh fixture creates only its random personal owner, ordinary writer, ordinary reader, outsider and token-bearing bootstrap admin. The admin bootstraps ordinary actors; positive write tests use the ordinary owner/writer, whose native `is_admin` flags must be false. A private auto-initialized repository is seeded before hook activation. Only that fresh native service is then recreated with startup configuration:

```ini
[git.config]
core.hooksPath = /opt/golf-hook-fixture
```

The equivalent supported Docker configuration key is `GITEA__git_0x2Econfig__core_0x2EhooksPath`; the [pinned environment decoder](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/config_env.go) decodes those escaped periods. The generated bundle is mounted read-only. Its fixed scripts execute the fixture with literal hook names and unchanged positional arguments. The descriptor contains only the exact fresh receiver path and `refs/heads/main`; it is not a user-authorized policy or immutable repository identity primitive.

For every callback, read-only native Git commands obtain the absolute Git directory, effective hooks path and actual Git version using the callback's inherited Git context. The fixture does not use pusher IDs, `EnvIsInternal`, command arguments or raw environment as actor authority. Those cannot bypass the marker rejection.

The native receiver path must exactly equal the operator descriptor. Any prepared transaction containing `refs/heads/main` there is rejected, including zero-old and deletion values. There is no bootstrap exception: seeding occurs before activation. Other ordinary branch updates are positive controls. This fixed marker is qualification behavior, not pattern enforcement, review/check policy or production write authorization.

The [native temporary-repository facility](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/repository/temp.go) creates editor clones under `AppDataTempDir("local-repo")`. The fixture explicitly sets `APP_DATA_PATH` and clears `APP_TEMP_PATH`; the [pinned path implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/path.go#L192-L204) puts those contexts under `/var/lib/gitea/data/tmp/local-repo/`. Reference transactions there are labeled `temporary_clone` and observed, rather than mistaken for the canonical receiver. This allowance relies only on the fresh operator-owned fixture topology. It does not establish production temporary-clone authority, namespace integrity or prevention of a hostile native filesystem writer. Other contexts are refused and make qualification fail.

Gitea's [generated hook implementation](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/gitrepo/hooks.go) supplies pre-receive, update, post-receive and proc-receive. The fixture invokes each existing generated root delegate at the resolved receiver's `hooks/HOOK`, without changing its file, cwd, inherited environment, arguments, stdin, stdout, stderr or exit code. The generated `.d/gitea` dispatch remains native. Missing, symlinked, non-executable or writable-by-group/other root delegates fail closed. A receive callback in a temporary/unclassified context cannot silently skip its native delegate.

The binary proc-receive exchange is streamed unchanged. It is never parsed as text reference records or captured in telemetry. Actual [AGit](https://docs.gitea.com/usage/issues-prs/agit/) `refs/for/allowed/...` publication must create a native pull request with the independently known head and base; a source mock of delegate output cannot satisfy this runtime gate.

## Bounded telemetry and input

Reference input is at most 64KiB/64 unique rows, with exact spaces and final LF, full lowercase 40/64 OIDs of one width or typed symbolic reference values. Malformed, duplicate or unsupported records fail closed. This grammar deliberately covers only the ASCII ref names used by this fixture; Unicode production refs and every native transaction shape are not qualified by it.

Telemetry uses a separate 1MiB tmpfs outside provider data, with 0600 files, a local file lock, contiguous sequence numbers, at most 512 events/512KiB aggregate and 16KiB per event. It contains fixed hook/state/context/decision enums, checked Git version/configuration, typed ref/OID metadata and actual delegate exit codes. There are no credentials, raw environment/argv, source bodies, native error messages or proc protocol bytes. A preparation-stage record failure refuses that transaction. A post-receive/committed-stage record failure cannot retract a completed native update; the qualifier fails its readback/telemetry gate and supplies no durable recovery guarantee. This telemetry is neither a durable Golf journal nor a policy lock; it disappears with the owned native container.

The launcher records the exact images, helper/bundle hashes, native container/owned repository IDs, baseline commit, preparation veto status and observed callback states. Native API bodies, Git stderr, CLI tokens/passwords and environment-bearing Compose files stay in memory/private temporary files and are removed. Only fixed stage/type/numeric source-line errors are reported. The copied fixture binary and operator configuration are outside managed repository paths; all source/ref mutations use Git or supported native APIs.

## Root-run recipe

Only the root agent executes runtime qualification. Image arguments must be full IDs already present locally; the native image must contain Git2.54.0. Choose `arm64` or `amd64` from that exact image. Compilation is an operator action, not a launcher action:

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

The finalizer attempts supported native repository/user purge, then tears down only the exact owned Compose project including volumes. It independently checks zero running **and stopped** owned containers, volumes and networks. Filtered foreign before/after records contain only full container IDs, image IDs, status/running, start time and restart count. Identity/image/status/running changes fail qualification. Start/restart changes are separately disclosed lifecycle observations with no cause inference; they are never labeled completely unchanged. No mutable command targets foreign containers.

## Actual qualification matrix (pending)

| Case | Required independent evidence | Current state |
| --- | --- | --- |
| Operator config discovery | Exact callback Git2.54.0 and effective hooks path; supplied binary/image/hash receipts | Source prepared, not run |
| Ordinary Git writer | Successful other-branch update, native branch exact expected commit | Source prepared, not run |
| Native contents editor positive | Valid other-branch edit; exact native commit readback | Source prepared, not run |
| Reader/outsider | Native file-write and Git branch-push denial; reader clone/ref read works | Source prepared, not run |
| Git main rejection | Nonzero push + receiver **prepared** marker telemetry with exact B→C + native ref/blob unchanged | Source prepared, not run |
| Native editor main rejection | Non-success API + receiver **prepared** marker telemetry + native ref/blob unchanged | Source prepared, not run |
| Temporary editor clone | Actual temporary-context callback observed separately from receiver | Source prepared, not run |
| Delegate preservation | All four native delegate success receipts plus actual AGit PR head/base bookkeeping | Source prepared, not run |
| Callback sequence | Record actual preparing/prepared/committed/aborted presence; no abort-based release claim | Source prepared, not run |
| Cleanup/foreign scope | Owned resource zero, unchanged foreign identities, disclosed lifecycle observations | Source prepared, not run |

Pure source tests exercise full/symbolic records, malformed/extra/duplicate/control rows, zero-old marker rejection, exact receiver separation, temp-context behavior, native internal-env non-bypass, actual local test-process binary stdin/exit preservation, missing/unsafe delegates, telemetry concurrency/sequence/aggregate bounds and closed foreign predicates. They do not prove native callback ordering or native file-editor mediation.

## Acceptance still open

Even a successful run only establishes the bounded operator-global composition on those pinned versions and fresh fixture. It does not establish production protection or mark Rules/P0.8 Ready. Missing obligations include exact H/B/C and fork resources; immutable repository/namespace and current actor/policy/review/check predicates; applicable review/identity/team SQL transitions; external/native/SSH/LFS/wiki/mirror/auto-merge/background writers; all repository init/temporary/maintenance contexts; hostile configuration or hook override; durable reservation, cancellation, acknowledged outcome and crash/recovery/node fencing. A hook cannot reserve a second repository's live fork ref or native review SQL merely by participating in a local Git transaction.

No force/deletion/multi-ref/atomic-push/symbolic publication semantics beyond syntax, protection pattern precedence, unknown-operation recovery or scalable production broker is claimed. The fresh marker's observed abort notification must never be converted into a safe retry or unlocked durable barrier.
