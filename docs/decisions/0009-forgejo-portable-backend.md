# Forgejo as the portable backend

Status: accepted 2026-10-11. Forgejo is Golf's only portable (self-hosted) forge.
Current setup and limits: [Forgejo setup](../FORGEJO_SETUP.md).

Forgejo is the forge for local, Docker and Kubernetes installations and for the
origin-backed bridge. This supersedes the earlier forge choice in
[ADR 0001](0001-initial-forge-and-vertical-slice.md).

Golf retains its shared interface, generated API, supported-protocol integration,
current authority checks and execution coordinator. Forgejo owns repository and
collaboration data; its supported HTTP API and Git protocols are the integration
boundary. The Cloudflare-native target in
[ADR 0008](0008-cloudflare-native-saas-ownership.md) remains Artifacts/D1/Workers.
CFCR remains a separate registry. No server, database or runner replacement is
implied on the native Cloudflare path.

Pin one reviewed Forgejo LTS patch and image digest at a time. A newer Forgejo
version needs its own API and behavior qualification before the pin moves. Missing
supported operations block the affected release rather than weakening Golf
contracts. Evidence remains attributed to the server on which it was collected;
receipts gathered on a different forge do not qualify Forgejo.

## Addendum: record through 2026-10-16

- 2026-10-11: Forgejo accepted as the portable backend.
- 2026-10-12/13: Forgejo 15.0.9 became the default for fresh Compose, Helm and
  `install.sh` installs.
- 2026-10-16: the owner retired the earlier backend. No Golf installations
  were backed by it, so the planned data transfer and identity migration (FJ-4),
  the dress rehearsal (FJ-6) and the existing-install cutover (FJ-7) are superseded
  by that decision; they were not done. Retirement (FJ-8) is done in the same
  change: the earlier backend was removed from code, packaging, qualification and
  documentation. The separate transition plan was folded into this record.

Done and proved:

- Configuration: `GOLF_FORGE_KIND`, `GOLF_FORGE_URL`, `GOLF_FORGE_INSTANCE_ID` and
  `GOLF_FORGE_WORKFLOW_DIRS`; the kind must be `forgejo`.
- A persisted installation binding (`golf_forge_installation`) fails closed when the
  configured kind, origin, instance ID or workflow directories change. It does not
  remotely attest the server's identity.
- Readiness rejects unsupported versions (exact 15.0.9 pin).
- `.forgejo/workflows` discovery, with shadow diagnostics for lower-precedence
  directories.
- Compose and Helm pin the default Forgejo image; only Linux amd64 is qualified.
- The disposable `make forgejo-qualify` run passed on 2026-10-16
  ([receipt](../compatibility/evidence/forgejo-qualify-20261016.json)) and on
  2026-10-11 ([receipt](../compatibility/evidence/forgejo-local.json)).
- Forgejo CI receipts:
  [PSF Requests lint](../compatibility/evidence/requests-forgejo-deep-20261011.json)
  and [worker loss](../compatibility/evidence/worker-loss-forgejo-deep-20261011.json).

Still open for Forgejo:

- Forgejo recovery beyond the small core drill. On 2026-10-17 `recovery-smoke.py`
  passed on Forgejo 15.0.9 with local RustFS ([RECOVERY.md](../RECOVERY.md)). The
  Access-core059 drill cannot run on Forgejo-era images, and a core-only backup,
  large fixtures and managed agent harness state are unqualified.
- A receipted live Kubernetes rollout. The [Helm chart README](../../deploy/helm/golf/README.md)
  records one-node k3d/kind runtime proofs on 2026-10-14, but no receipt for them is
  retained in the repository, and [Forgejo setup](../FORGEJO_SETUP.md) still lists a
  live rollout and recovery trial as open.
- A full per-operation API assessment; most operations are unassessed.
- Administrator and cross-organization role matrices.
- Response-loss and malformed-pagination fault injection against Forgejo.
- Capability readiness beyond the version pin.
- Provider version and latency in Operations.
- arm64 qualification.
- A support-expiry and upgrade rehearsal for the next Forgejo line.
