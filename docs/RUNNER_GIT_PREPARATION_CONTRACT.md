# Trusted runner Git preparation

Server source `9867129` adds read-only preparation endpoints. Sandbox `69f47ad`
and parent transport `e2c0c1b` now prove real TLS/native Git preparation in actual
network-none Docker containers. Preparation remains unadvertised and outside
assignments/jobs; neither packet is deployed. Current workers use original source
archives. The earlier host-Git loopback consumer is historical/source-only.

## Transport and authority

The two endpoints are:

- `GET /internal/ci/attempt/ID/git/info/refs?service=git-upload-pack`
- `POST /internal/ci/attempt/ID/git/git-upload-pack`

Both require TLS1.3, the enrolled worker credential and the original live attempt
token. Those control credentials remain outside source jobs: they also authorize
heartbeat, logs and completion. No browser session, native/sponsor PAT, enrollment
key or attempt token becomes `GITHUB_TOKEN` or a checkout credential file.

The attempt selects the original native repository/owner and admitted commit H.
Requests cannot choose another repository, native URL or Host. Canonical paths,
query and headers are checked; Cookie, Origin, compression and Git v2 are refused.
POST accepts one bounded protocol-v0 want for H, depth1, optional shallow H and
the supported terminal negotiation. Arbitrary wants/haves, additional commits,
filters, other depths and receive-pack are refused. Native advertised ref bytes
remain native; capabilities are narrowed to the preparation contract. This is
not unrestricted history or GitHub checkout endpoint compatibility.

The existing supported-native transport receives only the resolved native actor
and credential. It never receives worker-control, browser or proxy identity
headers. Redirects and unexpected MIME/encoding fail closed. Request bodies are
limited to4KiB; advertisements to2MiB; pack responses to64MiB, with the existing
four shared read-buffer slots and request deadlines.

Native repository/owner/current ordinary read access, original actor and exact
H/workflow blob are observed before and after buffering. Manual runs recheck
their original managed session; push runs recheck their durable sponsor grant,
including current authority and expiry independently of browser logout. Before
any bytes are released, the existing SQL fences recheck policy, execution values
and approvals, worker controls, pool/placement/resources, running state and the
original lease. Success includes `Golf-Source-Commit` and `Golf-Workflow-Blob`;
failed final checks expose neither private pack bytes nor a success receipt.
Responses are no-store. Native observations are not an atomic external-native
fence, and already delivered bytes cannot be recalled.

## Evidence and remaining work

### Current parent and native sandbox

The Go parent uses the fixed enrolled origin and validates TLS1.3, exact current
H/workflow receipts, no-store, MIME, bounded bytes and no encoding or redirects.
It clears the copied HTTP client's cookie jar; ambient cookies are not sent.
It chooses only advertised shallow/no-progress/ofs-delta and the matching object
format, sends one want H/depth1/done, and never requests side-band or thin-pack.
The response parser handles only shallow H (with optional LF), flush and NAK;
all PACK object/delta decoding stays with native Git. Foreign/duplicate shallow
objects, ACK/ERR/unshallow/side-band and malformed framing fail closed. Pack
header count is bounded to8194 and transport bytes to64MiB; native index-pack
also enforces its input limit and original pack checksum.

Only opaque PACK bytes and public exact source identifiers enter the disposable
sandbox. It has no enrollment/attempt/provider credentials, external URL, Docker
socket, mounts, inherited native configuration or source-selected executable.
The cached image must be approved, content-addressed, Linux/current architecture
and have no declared volumes. The profile is bounded by the original admitted
JobResourceBinding and ceiling1 CPU/256MiB/no extra swap/32 PIDs/30 seconds,
read-only root, uid1000, capabilities dropped, no-new-privileges, network none,
128MiB workspace tmpfs and32MiB temporary tmpfs. Effective Docker inspect is
checked before PACK transfer. No fallback increases restrictive admitted limits.

Template-free native init selects SHA-1/SHA-256, sets shallow H, and executes
index-pack --strict --stdin --threads=1 --max-input-size=67108864 --no-rev-index
--index-version=2, without --fix-thin. Detached HEAD, commit type/count, shallow
state, exact workflow blob/type and tree are checked. Native strict fsck must
produce no dangling-object report. Listing is bound to the original admitted
archive digest, every regular blob byte/mode and workflow identity before use.
The only exported regular files are .git/HEAD, .git/shallow and the original
pack plus its native idx. Links, extra/duplicate paths/PAX, changed PACK bytes,
foreign index identity and nonzero tar tails are refused; output modes normalize
to0444. No checkout, filter, hook, LFS or submodule hydration occurs. Known owned
containers are force-removed after failure/cancellation; final cancellation
clears results. A lost create receipt can leave an unknown-ID labeled container:
RequireCleanWorker refuses reuse and explicit fenced CleanupWorker is required.
That failure mode needs real recovery qualification before activation.

[Actual source-bound Docker evidence](../.tmp/git-preparation-actual-final/manifest.json)
passes27.083s for SHA-1/SHA-256 root and child commits through a real TLS
Git2.39.5 origin into native container Git2.54.0. Four actual kernel cgroup/mount
profiles and complete owned removal are recorded. It uses a3.4-MiB scratch
qualification image built from the already-cached owned Gitea Git binaries with
no package download; this is not a distribution/Compose release contract.
Original regular-file admitted fixture archive equality is checked. Full worker
race20 top-level cases passes3.213s, full internal runner race13.270s and vet
passes. Controlled lifecycle tests additionally cover native corrupt/dangling
packs, restrictive profiles, metadata substitution, cancellation and ownership/
cleanup refusal. Adversarial memory/disk exhaustion and lost-create recovery
are still source-only or unqualified; positive profile observations do not prove
all such failures. This is not actual Gitea/enrolled Golf transport or enabled CI.

### Earlier host consumer and server evidence

The [final worker source receipt](../.tmp/runner-git-worker-preparation-final-proof/manifest.json)
binds four committed worker/checker files. All 18 full-package race cases pass
in2.559s with no skips, and runner vet passes. Nine actual TLS1.3/Git2.39.5
consumer scenarios include success, malformed/duplicate receipts, MIME and
compression refusal, native denial, redirects, cancellation and insecure-client
refusal. The origin uses an owned real `git http-backend`, not actual Gitea or
the enrolled Golf server. Success fetches exact H at depth1 into a fresh
unmaterialized repository and independently compares its native tree with the
original archive SHA, all blob bytes/executable modes and workflow identity.
Separate actual SHA-1/SHA-256 repositories exercise changed/missing/extra files,
links, directory-inventory limits and malformed tree/object receipts.

The worker broker retains controller credentials only in Go HTTP headers. Git
receives a separate random, local, read-only preparation nonce; the broker closes
before success, and neither nonce nor controller credentials appear in repository
files. Git uses fixed installed binary paths, a fresh template-free init, hermetic
configuration/environment, disabled hooks and automatic maintenance, no checkout
or source filters, and bounded process/HTTP deadlines. Process groups are killed
on cancellation; failed workspaces are removed. Buffered response and stdout
limits are enforced. The historical host consumer bounds do **not** establish native Git memory,
disk or CPU ceilings. The intended integration now uses the bounded sandbox
above; activation still requires adversarial/recovery qualification and a
separate credential-free job metadata envelope.
The tree checker does not authorize arbitrary host extraction, filesystem
aliases or checkout transformations. Archive export attributes that change or
omit committed bytes must fail equality; no transformed archive is silently
substituted for the original admitted source.

The [source receipt](../.tmp/runner-git-source-proof/manifest.json) binds all four
tested server files to the committed source. Seventeen top-level real PostgreSQL
and race cases pass, including nine manual/push scenarios for late native access,
workflow, lease, policy, redirect, grant-expiry and sponsor-role changes. Owned
schemas and the disposable test container are removed. Native responses in those
database cases remain HTTP fixtures.

A separate installed Git2.39.5 check uses a real local `git http-backend` and an
owned two-commit repository: fetch/checkout yields exact H, depth1, one commit and
the expected file bytes. It tests the actual negotiation grammar, not an actual
Gitea/Golf end-to-end checkout. The original failed database attempt remains
preserved; its decorator rounded a deliberate bigint native ID, and later its
database entered recovery. Correcting the decoder and using a fresh larger
bounded database fixture earns a separate passing receipt, not a relabeled
failure. This source packet is not deployed in localhost8080.

Next tasks retain the original compatibility goal:

1. Integrate an explicitly declared trusted-worker preparation capability over
   TLS after adversarial resource-exhaustion/lost-create recovery is qualified
   against the observed sandbox profile. Add a separate
   verified Git metadata envelope without changing original archive identity or
   exposing controller credentials. Materialize a fresh job Git workspace; verify
   H, its tree and the original workflow blob, with no hooks, implicit LFS or
   submodule hydration. Qualify native Gitea transport, historical H/ref movement,
   cleanup, cancellation and worker loss before enabling it.
2. Implement a separate short-lived read-only job checkout token and compatible
   checkout-origin URLs. The pinned action uses `/OWNER/REPO` and Basic
   `x-access-token`; human `/git/OWNER/REPO.git` credentials do not satisfy it.
3. Qualify pinned remote Node24 actions and restricted dependency egress, plus
   the original push/PR declarations, contents permissions and job timeout.
   Run unchanged Requests lint.yml; no YAML rewriting, silent action replacement
   or inspector relaxation counts as acceptance.

See [Actions implementation](ACTIONS_COMPATIBILITY_IMPLEMENTATION.md) for the
remaining service, event, token, runner and UI requirements. Kubernetes,
Cloudflare, protected integration and latest-schema recovery remain separate.
