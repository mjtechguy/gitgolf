# Trusted runner Git preparation

Source `9867129` adds read-only Git preparation to the existing runner attempt
boundary. Worker preparation source `2545199` and final checks at `0641832` now
exercise a real installed Git consumer. This is still a step toward real job
workspaces and unchanged imported CI: preparation is not advertised or integrated
into assignments. Current deployed workers use the ordinary-source archive.

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
limits are enforced. These bounds do **not** establish native Git memory, disk or
CPU ceilings for adversarial packs. Source-only preparation remains disabled
pending that qualification and a separate credential-free job metadata envelope.
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
   TLS after native process memory/disk/CPU isolation is qualified. Add a separate
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
