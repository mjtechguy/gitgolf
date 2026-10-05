# Trusted runner Git preparation

Source `9867129` adds read-only Git preparation to the existing runner attempt
boundary. It is a first step toward real Git workspaces and unchanged imported
CI, not an enabled worker checkout or a job credential. Current workers still
download the existing ordinary-source archive.

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
   TLS. Materialize a fresh credential-free Git workspace; independently verify
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
