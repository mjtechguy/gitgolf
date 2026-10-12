# Native Packages integration

The optional CFCR integration connects the native forge to the separate `golf-cfcr` Worker using private service RPC. It does not change the portable package backend.

An installation adds `registry: {worker: "golf-cfcr", origin: "https://registry.example.com"}` to `forge.json` and reruns native preparation before deployment. Preparation exports `PackagesAuthority` even before the binding is added, allowing staged installation: updated Golf, CFCR bound to Golf, then Golf bound to CFCR. The authority refuses access until the registry integration is configured. No D1 migration is needed.

Repository Settings shows **Packages → Enable packages** to administrators. An enabled repository gets a Packages tab with a bounded tag inventory, registry commands, one-hour credential issuance and revocation. Readers receive pull-only credentials; writers/admins can publish. CFCR calls the actual current D1 authority for every request. UI-supplied identities and permissions are never trusted.

The binding pins installation origin, native repository ID, Artifacts identity and namespace. Renaming/reusing a namespace cannot silently adopt the previous registry binding. Credentials are returned once, held in component state and cleared on dismissal, expiry, session changes or authorization failure.

Local evidence (2026-10-10): `make cloudflare-check`, native UI build/typecheck, CFCR `check:golf` and `check:build` passed. CFCR's official OCI Distribution v1.1.1 suite passes all four categories with 75 passed and four conditional skips, and a real Docker push/pull passes. Browser automation could not reach the local fixture; visual behavior and hosted integration remain unqualified. See sibling `golf-cfcr/docs/OCI_COMPLIANCE.md` for exact scope, limits and remaining release gates. No production deployment was performed.

The storage extension separates blob size from request size: defaults are 10 GiB per blob, 50 MiB per request and 100 GiB per repository, configurable in CFCR's `registry.json`. Packages displays charged/reserved storage and chunked upload commands using regctl. CFCR now implements durable R2 multipart finalization, storage reservations, generation-safe explicit-deletion collection, active download leases and protected repository-owned mounts. The local fault suite covers storage failures, lost acknowledgements, process restart, revocation, expiry, overload and reclamation; hosted behavior remains a separate gate. See sibling `golf-cfcr/docs/STORAGE_AND_UPLOADS.md` for runnable checks and precise deletion semantics.

The complete local 10 GiB proof passed: restart during upload, restart after publication, full download digest verification, suffix range, physical reclamation and zero charged quota. A separate 128 MiB regctl chunked import was pulled successfully by Docker. CFCR's custom suite now has 25 passing tests, including persistent HTTP connections after rejected upload chunks. These results do not replace hosted CPU/memory/load or browser qualification.

## CI publishing broker (2026-10-11)

CFCR remains a separate installation. To let approved native test jobs publish
OCI output, set `registry.ci: true` alongside `registry.worker` and `registry.origin`
in Golf's `forge.json`, retain an approved `tests` policy, regenerate native output
and deploy both compatible Workers. The default is false. Preparation refuses
non-boolean values and CI publishing without an approved test policy. Enable
Packages for the destination repository through its existing administrator UI.

Newly admitted jobs capture the registry origin and repository in their immutable
execution snapshot. Existing jobs do not acquire publishing access retroactively.
During the running test stage, the approved process receives `GOLF_REGISTRY`,
`GOLF_IMAGE` and `GOLF_COMMIT`. The image name ends in `:ci-<job UUID>`. These are
coordinates, not secrets. Outbound registry requests pass through Golf's private
broker; it issues a credential bound to the exact repository, actor, job, source
commit, policy digest and deadline. CFCR rechecks Golf's current authority on
token exchange and each request. Credentials last at most ten minutes; the broker
reuses bounded in-memory tokens without disclosing them to repository code.

Jobs can push to their own job tag or an immutable digest and pull within their
repository. They cannot replace an existing job tag with different bytes, delete
artifacts, invoke registry management, publish another tag, cross repositories or
adopt another job's upload session. Cancellation, permission loss, source changes
and policy changes deny subsequent access. General external egress stays denied.

After a successful test process, Golf reads the job tag, independently hashes the
manifest and checks its registry digest. A missing tag means no publication;
other failures cannot create a successful receipt. The private evidence report
records registry, repository, tag, digest and exact source commit only after
successful container cleanup. The shared report UI shows the digest-qualified
image. This receipt is not a signed build attestation.

Validation: CFCR has 42 passing JavaScript tests plus its archive-boundary check.
`node scripts/golf-check.mjs --ci` exercises the actual Golf Worker, D1 and private
bidirectional service bindings with a seeded running job and fixture Git provider;
moving its source refuses subsequent access. `node scripts/docker-check.mjs --job`
builds, pushes and pulls a real Docker image, verifies its identity and denies a
pull after job cancellation, using a fixture job authority. Native broker/task
tests cover admission, credential isolation, digest mismatch and cleanup failures.

The maintained disposable hosted rehearsal now accepts `--registry-host` and
`--registry-scanner-image`. It stages the two private bindings, provisions an
owned registry, runs an actual native OCI publisher and independently checks its
digest before real Docker/regctl, signing, scanning and authority tests. Cleanup
retires both sides of the binding before deleting the owned registry Worker,
scanner allocation/image and R2 bucket. Partial deployments retain ownership
evidence and use the same recovery cleanup.

See [the 2026-10-12 qualification packet](CLOUDFLARE_FULL_QUALIFICATION_2026-10-12.md)
for actual results, including failed hosted attempts. Availability of this harness
does not mean all its gates have passed. General Docker image build workflows,
signed workload provenance and hosted registry recovery/load remain separate
qualification requirements.

Hosted follow-up (2026-10-12): actual native CI digest publication and Docker pull,
Docker/regctl roundtrips, Cosign signature/attestation, policy enforcement and live
Golf permission revocation passed. Hosted OCI v1.1.1: 71 passed, eight conditional
skips. Native scanner startup still fails before reports; standalone scanner
success does not close that gate. See the qualification packet for receipts.

## Hybrid execution work

The [hybrid execution and CFCR plan](HYBRID_EXECUTION_AND_CFCR_PLAN.md) defines
the independent registry, customer runner, managed execution, database/evidence
reuse and CI-to-preview delivery phases. CFCR owns its scanner jobs; this does not
turn scanner enrollment into general Golf Actions/GitLab runner support.
