# Trusted runner Git preparation

## Current opt-in source profile (2026-10-07)

`GOLF_RUNNER_GIT_PREPARATION_IMAGE` now enables the existing preparation →
credential-free envelope → fixed staging → native engine path for explicitly
approved registry-digest-pinned images. Advertisement requires an actual verified
TLS1.3 coordinator response; initial polling cannot downgrade a configured Git
worker to an archive Actions assignment. Unknown profiles, missing consumers and
insecure clients fail closed. The default remains unset; this is source plus
owned-instance qualification, not a retained rollout.
The preparation image and every selected Actions platform image must separately
be approved and contain usable Git/tar. This opt-in does not install Git into an
archive-only job image; missing native tools refuse setup before job release.

Enrolled native evidence, collected on the since-retired backend (receipt
removed with it; not repeated on Forgejo), executed historical admitted H in two independent fresh jobs after its native
branch advances. Independent native Git fetch/readback verifies H, actual tree,
workflow blob and executable100755 mode in each job. That backend's REST commit
tree field aliased H, so the field is not accepted as independent tree evidence.
Original source/archive, graph ordering, scoped logs and restart/replay identities
remain bound. An abrupt SIGKILL during a real source step leaves owned residue;
normal worker startup refuses it. Explicit coordinator recovery marks the
original attempt lost before exact-owned cleanup; no replacement run is created.

[Actual image/engine evidence](compatibility/evidence/actual-git-engine.json)
binds the OCI platform manifest, configuration, compressed layers/diff-IDs and
actual installed Git execution. Git jobs have read-only roots and native
local-driver tmpfs mounts:128MiB workspace,32MiB act environment,64MiB tool cache,
32MiB temporary space and8192 inodes per mount. Mounts, ownership, options and
existing cgroup/resource settings are inspected before source release. Real byte
and inode exhaustion, wrong-tree refusal with no frames, cancellation and lost
create acknowledgement recovery pass. Lost-create uses a controlled CLI that
drops the acknowledgement after real owned Docker creation. All owned resources
are removed; unrelated container identities remain unchanged.

Five small vendored act changes apply native volume options after upstream's
initial cleanup and stream tar through fixed `docker exec` argv into running
mounts. They preserve upstream defaults for legacy jobs and carry a reconstructible
hash-checked patch. Actual rootless Docker exposed both ineffective archive copies
under tmpfs and read-only-root archive-write refusal; subsequent hashes and native
Git readback remain mandatory.

The trusted preparation profile remains exact-H/depth1/v0 and network-none.
The later separate [remote Actions profile](ACTIONS_REMOTE.md) qualifies genuine
private exact-H/depth1 checkout, scoped job credentials and controlled dependency
egress; on Forgejo, see the 2026-10-11 [Forgejo Requests receipt](compatibility/evidence/requests-forgejo-deep-20261011.json).
Statements below about an undelivered candidate describe historical receipts.
Broader checkout, long-step refresh and the full A1 exit remain open; neither
opt-in profile is deployed to the retained installation.

## Historical preparation-only checkpoints

The paragraphs below preserve the scopes of earlier receipts; their statements
about unadvertised preparation and missing job quotas are superseded only by
the bounded current profile above.

Server source `9867129` adds read-only preparation endpoints. Sandbox `69f47ad`
and parent transport `e2c0c1b` now prove real TLS/native Git preparation in actual
network-none Docker containers. Preparation remains unadvertised and outside
assignments/jobs; neither packet is deployed. Current workers use original source
archives. The earlier host-Git loopback consumer is historical/source-only.

Source `b34aee2` now supplies a closed credential-free Git manifest/metadata
archive and the native engine consumer. Source `063776b` adds explicit
`ExecuteGit` staging before engine startup; `8621bfe` shares the worker/engine
archive/tree/path validator. [Envelope evidence](../.tmp/git-source-envelope-final-proof/manifest.json),
[staging evidence](../.tmp/actions-git-source-staging-final-proof/manifest.json) and
[shared worker evidence](../.tmp/git-snapshot-shared-proof/manifest.json) pass their
source/native-local checks. No assignment, advertisement or runtime activation
follows. Actual Docker engine transfer/materialization needs an approved
registry-digest-pinned Git job image and resource/cleanup qualification. The
scratch preparation image's local OCI index/content identity alone does not
satisfy the registry-digest-pinned job-image gate. Existing job volume storage has no hard disk quota;
preparation tmpfs limits cannot be claimed for that job workspace.

Worker composition `85e7db5` joins fixed TLS PACK transport, native preparation,
original archive manifest and a final source fence under one deadline. Source
and controlled native/TLS checks pass; no runtime activation follows. Qualifier
`89461dd` verifies OCI index→platform→config→compressed layer→diff-ID linkage.
Actual attempt1 failed its old identity assumption before Docker writes.
[Attempt2](../.tmp/actions-git-source-actual-attempt2/manifest.json) stops at the
unchanged2-GiB reserve with1,330,460KiB available. Its read-only probe is removed;
no registry, preparation/job container or upstream run is created.

## Job-scoped Git credentials: source-only candidate

Source `83032fa` adds a separate sealed `golf_job_git_` credential namespace with
AEAD domain `runner_job_git_read`. Only an enrolled TLS1.3 worker with the original
live attempt can request a credential for an actually started, unfinished,
admitted graph job. Expiry is at most5 minutes and clipped to the original lease;
current job/attempt/session or sponsor/policy/approval/worker/resource/key state
remain required. It has no independent per-token revoke inventory.

The issuer is `POST /internal/ci/attempt/ID/job-git-credential`. Job requests use
Basic username `x-access-token` against the configured canonical HTTPS PublicURL:
`GET /OWNER/REPO/info/refs` and `POST /OWNER/REPO/git-upload-pack`. Native ref
metadata discovery covers the bound repository, including other branch names
and object IDs; only object fetching is restricted to exact admitted H/depth1.
Foreign-H fetch and cross-repository discovery are refused. Neither control nor
native provider credentials enter this capsule or the native request.

These new job routes inherit the ordinary15-second router limit. They do not
have the separately routed managed-human Git transport's longer deadline.
Current source qualification uses real PostgreSQL with controlled native/graph
fixtures; it is not deployed token delivery, native forge checkout or pinned checkout
compatibility. Worker coordination and PublicURL can be different origins;
actual authenticated issuer reachability, exact job delivery/rotation/masking,
TLS/origin and Git protocol behavior must pass before activation. No Host spoof,
HTTP fallback or leaked worker token is a substitute.

The candidate job route now accepts one exact `Git-Protocol: version=2` header,
separately from trusted worker preparation, which still rejects that header.
The pinned [checkout source](https://github.com/actions/checkout/blob/9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/src/git-command-manager.ts)
explicitly selects v2 for fetch. [V2 source/database evidence](compatibility/evidence/job-git-v2.json)
passes real native Git fresh/repeated exact-H/depth1 fetches plus separate live
graph/late-revocation cases for v0/v2. Capabilities are narrowed to ls-refs and
shallow fetch; wants, shallow markers and haves can name only H. Protocol framing
accepts native Git's optional final LF and the bounded have-H acknowledgement
round. Foreign objects, filters, deeper history, server options, packfile URLs,
unknown commands and duplicate headers/capabilities remain refused. Repository
metadata discovery is unchanged in scope. This is based on the
[Git v2 contract](https://git-scm.com/docs/gitprotocol-v2), not a custom Git codec.
SHA-256 framing has source counterexamples; the real v2 client fixture is SHA-1.
Controlled native responses in PostgreSQL cases do not qualify actual Forgejo v2,
private token delivery, action execution or the complete checkout options.

Eight additional native Git source cases qualify nested paths, export-ignore/
export-subst inequality, symlink/gitlink refusal, literal LFS pointer preservation,
disabled local hooks/helpers and forged .git tree export refusal. No configured
private submodule/LFS/remote endpoint is contacted. The [source receipt](compatibility/evidence/a1-checks.json)
distinguishes those native Git checks from Docker and private job transport.

Independent review reproduced a separate approver's native-admin revocation
between response buffering and byte release. Correction `557f8d0` rechecks that
separate native actor before final SQL locks, rejects issuer userinfo/opaque URL
aliases and explicitly caps handler requests at15 seconds. The [source receipt](../.tmp/job-git-approval-source-proof.json)
preserves the original private200 regression and final14.555-second real
PostgreSQL/race pass without skips or leftover owned resources. Independent
read-only review binds the exact committed files; external native edits after
the final observation remain non-atomic. Shared forwarding correction `9c6063c` rejects Go's transparent
gzip decoding as well as visible Content-Encoding. Its [source receipt](../.tmp/git-response-encoding-source-proof/manifest.json)
uses the actual Go transport for all four upload/receive advertisement/result
paths. This shared guard is included in current core `99630ef`; its source tests
do not qualify live native Git responses or job credential delivery.

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

The later [local Node24 Actions profile](ACTIONS_REMOTE.md) composes this trusted preparation with separately scoped job Git capsules, immutable public actions and authenticated dependency egress. Preparation itself remains v0 and credential-free; source job reads can negotiate bounded v2 with the native smart-HTTP service preamble. Its runtime evidence and remaining PR/private-action/checkout-option scope belong to that profile. Historical evidence below retains its original limits.

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
qualification image built from the already-cached owned Git binaries of the
since-retired native backend image, with
no package download; this is not a distribution/Compose release contract.
Original regular-file admitted fixture archive equality is checked. Full worker
race20 top-level cases passes3.213s, full internal runner race13.270s and vet
passes. Controlled lifecycle tests additionally cover native corrupt/dangling
packs, restrictive profiles, metadata substitution, cancellation and ownership/
cleanup refusal. Adversarial memory/disk exhaustion and lost-create recovery
are still source-only or unqualified; positive profile observations do not prove
all such failures. This is not actual Forgejo/enrolled Golf transport or enabled CI.

### Earlier host consumer and server evidence

The [final worker source receipt](../.tmp/runner-git-worker-preparation-final-proof/manifest.json)
binds four committed worker/checker files. All 18 full-package race cases pass
in2.559s with no skips, and runner vet passes. Nine actual TLS1.3/Git2.39.5
consumer scenarios include success, malformed/duplicate receipts, MIME and
compression refusal, native denial, redirects, cancellation and insecure-client
refusal. The origin uses an owned real `git http-backend`, not actual Forgejo or
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
above; activation still requires adversarial/recovery qualification and
actual qualification of the separate credential-free job metadata envelope.
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
Forgejo/Golf end-to-end checkout. The original failed database attempt remains
preserved; its decorator rounded a deliberate bigint native ID, and later its
database entered recovery. Correcting the decoder and using a fresh larger
bounded database fixture earns a separate passing receipt, not a relabeled
failure. This source packet is not deployed in localhost8080.

Next tasks retain the original compatibility goal:

1. Extend the current explicitly negotiated exact-H profile only as required by
   genuine checkout: specify and qualify protocol-v2/history/tags/sparse/submodule/
   LFS behavior, archive attributes and hostile source configuration. The bounded
   historical source and resource/recovery proofs above do not imply these options.
2. Complete longer-step refresh, broader expiry/revocation runtime cases and the
   remaining checkout options around the implemented short-lived read-only job
   capsule. The opt-in profile uses `/OWNER/REPO` and Basic `x-access-token`;
   human `/git/OWNER/REPO.git` credentials stay separate.
3. Extend the qualified sponsor-authored Requests push path to its declared PR
   trigger and wider permission/runtime behavior. The local Node24 profile keeps
   the original source and genuine actions; source rewrites, silent replacements
   or inspector relaxation do not count as acceptance.

See [Actions implementation](ACTIONS_COMPATIBILITY_IMPLEMENTATION.md) for the
remaining service, event, token, runner and UI requirements. Kubernetes,
Cloudflare, protected integration and latest-schema recovery remain separate.
