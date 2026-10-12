# Cloudflare and CFCR qualification — 2026-10-12

This packet exercises disposable native Golf and the separately deployed CFCR registry. It uses scoped machine credentials, unique Workers/Artifacts namespaces, D1/R2 storage, and short-lived Access policies. The retained user demo is not replaced. The operator's $10/day planning envelope and prompt cleanup requirement apply. A successful test is evidence for the stated slice, not full GitHub compatibility or enterprise capacity certification.

## Completed local and independent hosted checks

| Check | Result | Scope |
| --- | --- | --- |
| CFCR custom tests | 44 JavaScript and one Python test passed | Local workerd; protocol, authentication, policy, storage faults, signatures, scanning boundaries |
| Official OCI Distribution v1.1.1 | 75 passed, four conditional skips | All four categories, pinned unmodified upstream suite; local workerd |
| Docker publication | Passed | Real 7 MiB push/pull and image identity |
| Chunked publication | Passed | Real regctl 128 MiB import and Docker pull |
| Job-scoped Docker credential | Passed | Fixture job authority; cancellation denies later pull |
| Golf–CFCR private bindings | Passed | Local D1/workerd authority and fixture CI execution |
| Cosign | Passed | OCI signature, SLSA attestation, trusted-key and subject verification |
| Scanner tools | Passed for gzip and zstd | Real pinned Syft/Grype/Trivy, bounded archive extraction |
| 10 GiB storage | Passed in 1,319.133 seconds | Restart during upload, restart after publication, complete download hash, suffix range and physical reclamation; one transport retry retained |
| Golf Cloudflare checks | Passed | Existing source/runtime/build checks |
| Live environment provisioning | Passed | Actual Golf D1/R2 provisioning and removal |
| Hosted CI resilience | Passed and removed | Concurrent replay, final-slot contention, cancellation, failed tests, cross-repository and revocation fences |

Local CFCR receipt: [cfcr-local-full-20261012.json](compatibility/evidence/cfcr-local-full-20261012.json).
Hosted resilience receipt: [ci-hosted-resilience-20261012.json](compatibility/evidence/ci-hosted-resilience-20261012.json).

The 10 GiB result is **not** hosted CPU/memory/client-timeout qualification. Native CI executes the approved Python test module. It does not execute general GitHub Actions or GitLab YAML, or run Docker builds inside that native job.

## Hosted integration under test

The maintained harness now accepts `--registry-host` and optional `--registry-scanner-image`. It bootstraps Golf, deploys CFCR bound to Golf, then binds Golf to CFCR with explicitly approved CI publication. The test repository publishes an actual OCI manifest/config/layer through the native job's broker, without registry credentials in the process environment.

Acceptance requires an exact source-bound CI digest, independent registry verification, a real Docker pull, Docker/regctl publication, Cosign verification, native scanner reports, live authority/revocation checks and all owned cleanup. Hosted OCI conformance excludes cross-repository mounting because the Golf product issues single-repository credentials; the complete local protocol suite covers that path.

The full profile also exercises Artifacts Git, collaboration, Queues/Workflows/R2 evidence, Clef through AI Gateway, isolated agents, protected static/Worker previews, Browser Run, Workers for Platforms, Secrets Store, private preview D1/R2, and guarded release rollback/promotion. Positive human-only mutations remain outside a service-principal run.

## Findings retained from failed attempts

1. `golf-native-20261012-9157a715`: scanner image upload exceeded the original five-minute deployment window. The CLI detached Docker, leaving the upload outside its parent process group and preventing pipe drainage after timeout. The exact owned upload was stopped. The harness now terminates detached uploads only for its recorded account/image tags, using process descriptors to avoid PID reuse, and bounds pipe drainage. The registry upload window is now 15 minutes within the overall 45-minute deadline.
2. That partial deployment exposed an R2 cleanup parser assumption: this CLI returns an array. Cleanup accepts the actual array and requests a bounded 1,000-object inventory. The original empty bucket was independently removed and absence verified. Regression tests cover both partial deployment identity and array inventory.
3. `golf-native-20261012-f490c2cc`: CFCR deployed and retired successfully, but the second Golf build failed because the CLI had removed its local uploaded image tag. Native preparation now restores the recorded, immutable approved image tag for every build. All owned resources were removed.
4. `golf-native-20261012-c7da74e2`: a restart overlapped the prior Secrets Store cleanup. The existing isolation guard refused to adopt it. This attempt's resources were removed; subsequent testing waits for that cleanup.
5. Vite's ten-commit provider import succeeded. Kubernetes' direct import failed and the provider object was confirmed absent. A separately verified single-commit Git push succeeded: 31,421 files, 276,473,806 uncompressed tree bytes. The direct-import failure is not counted as a successful import feature. A one-commit snapshot cannot qualify complete history or diffs against missing parents.
6. `golf-native-20261012-07a3a7de` and `golf-native-20261012-68b32cda`: actual native CI lost its first registry upload connection. Local private-binding tests now also upload/read real blobs and still pass, so they do not reproduce this hosted failure. Both attempts removed every recorded resource category. [Failed hosted receipts](compatibility/evidence/cfcr-hosted-failures-20261012.json) retain the failing execution and cleanup results. Infrastructure exceptions in the registry broker now terminate a job as `LOST`, destroy its container and preserve a bounded, credential-redacted diagnostic; they cannot be reported as ordinary successful execution.

7. Attempts `a2e1ce42`, `6b5550f1` and `80b5d8d9` reproduced the missing registry authority as an infrastructure failure (`LOST`, container destroyed). `0428687c` hit Secrets Store creation HTTP 500; `04ed4887` hit an unauthorized scanner-image manifest lookup. Owned resources were removed; ambiguous Secrets Store creation was independently checked absent and partial-run stop timers cancelled.
8. A disposable A → B → Durable Object → A service-binding probe passed on Cloudflare. A second probe bundled the actual Golf `PackagesAuthority` and used real disposable D1 tables: read/write/admin authority passed. Both probes were removed.
9. The full container/agent build entrypoints omitted `PackagesAuthority`, while configuration still advertised it. Both now re-export it. All three entrypoints have bundle-export regression checks, and production preparation rejects a configuration whose exports are absent from the built JavaScript. This is a deployment defect, not evidence that Cloudflare cannot support the callback pattern. The next full deployment confirmed that native CI publishes its exact-commit OCI image and destroys its container. Its later independent Python registry client hit Cloudflare Browser Integrity error 1010; an explicitly identified Golf client passed that edge check. The harness now supplies its client identifier and has a request regression test. This attempt was fully removed; Docker/signing qualification passed on the following attempt; native scanner qualification remains open.

## Shared UI checks

The repository browser and file navigator regression suite passed 55 checks.
Immutable file history now uses the existing memory-only navigation cache and its
64-entry/8 MiB limits. A shared authority hook gates retained source/history before
display. Additional portable and native browser tests prove a warm history return
does not fetch history again and permission loss hides/evicts the retained data.
The native case checks current repository access rather than reloading Git data.

A collaborative-browser pass against the fifth hosted attempt confirmed loaded
Archivo fonts, no horizontal overflow at 1280×800, persistent repository tabs and
the Settings sidebar, same-document navigation and incoming live activity. No
long tasks were captured in that short navigation sample. Settings remained in a
loading state during the competing qualification workload; this is an open
finding. Large-repository imports finished, but cleanup began before their
benchmark: those attempts supply **no large-repository latency evidence**.

The final isolated Settings/native/live suite passed 46 checks, including theme/mobile settings coverage and returning to a PR check tab without moving its selected commit. An earlier combined run had one transient PR live-selection failure; three isolated repetitions and the final combined suite passed. Its cause was not established, so these results do not establish that the intermittent failure is impossible.

The latest hosted browser pass also rendered all nine Vite README images (logo, badges and sponsors). Opening `packages` preserved the document and took 657 ms in a single proxy-mediated sample. This is not a latency percentile.

## Large-repository timing evidence

A four-concurrent-request benchmark against ten-commit Vite and Kubernetes imports completed 60 real hosted reads. [Raw timing receipt](compatibility/evidence/large-repository-reads-20261012.json): first-pass p50 1,019 ms / p95 1,951 ms; repeated-read p50 231 ms / p95 6,109 ms. All HTTP responses were 200, but eight overview observations failed the completeness gate because indexing was unfinished. Those are failures, not passing language statistics.

The slowest four repeated reads each spent approximately six seconds in final workspace authorization while the full CI/agent workload was active. Their D1 calls totaled 69–119 ms and cached content required little or no provider work. This isolates a coordination wait, not browser painting or a missing Redis cache. The final check remains deliberately intact: removing it without an equivalent revocation fence would weaken private-source protection. A quiet-workload comparison and a safe reduction in contention are still required. These are single-user/single-region results, not global capacity evidence.

A second loaded-workspace sample ([receipt](compatibility/evidence/large-repository-reads-scanner-profile-20261012.json)) measured first-pass p50 1,304 ms / p95 2,099 ms and repeated-read p50 450 ms / p95 1,674 ms. All eight incomplete overview observations remained failures. The better tail does not close the coordination or indexing gates.

Final authority timing now exports queue, D1, actor and grant durations separately to Server-Timing and Operations. Regression coverage validates bounded numeric stages and the dashboard aggregates; it retains the final authorization fence.

## Preview discoverability

Native PR conversation and Checks views now show a PR deployments panel for the selected commit. Run rows link their own deployment, with hostname, copy action and expiry. Matching requires both job and commit identity; unrelated repository previews are filtered out. Expired/purged previews become history, and authority errors remove the controls. Repository Actions uses the same run controls after selecting a PR. This does not imply that portable workflow-run pages already aggregate every deployment as an inline card; their deployment history/detail path remains separate.

The 390 px regression covers expiry without reload, foreign job/wrong-commit exclusion and permission loss. It exposed a shared copy-control accessibility message escaping the table's scrolling area; a positioned copy-control container fixes that page overflow. The combined repository/navigation/merge-observation suite passed 102 checks; the selected-commit follow-up passed both targeted checks and type checking.

## Scanner boundary

`a7b09d0d` deployed the real scanner image and independently verified native CI publication. Its scanner failed before producing any reports. All owned resources were removed. The scanner now executes a readiness probe without waiting on the running flag, arms idle shutdown after readiness and rechecks cancellation before execution. A local native runtime attempt still failed with `Container failed to start`; the existing documented Miniflare proxy startup blocker remains. Its exact newly created proxy was removed. The harness now cleans only the container/proxy names derived from its own admitted scanner Durable Object. Hosted startup investigation continues separately; successful standalone Syft/Grype/Trivy tests are not claimed as native Container success.

## Speed and experience gates

Measure actual hosted requests with `cloudflare/forge/browser-benchmark.mjs`: metadata, overview, root/nested directories, README, README image, history and diff, repeated with concurrency four. Keep errors, identity mismatches and incomplete indexing in the results. First pass does not mean an empty provider cache. Capture Server-Timing and release identities.

Use the collaborative browser with a short-lived private service-auth transport to inspect persistent repository navigation, settings tabs/sidebar, fonts, overflow, loading states, long tasks and document identity. This transport cannot qualify a human Access cookie, secure-context behavior or positive human-only settings operations.

## Remaining acceptance boundaries

Production multi-region/multi-tenant load, hosted 10 GiB finalization limits, disaster recovery, billing enforcement and full native forge parity remain separate gates. Configured optional services are not counted as tested integrations. No email is sent by this qualification.

## Final hosted client and indexed-read follow-up

`golf-native-20261012-a205a6ae` passed native exact-source publication and independent manifest verification, Docker pull of that CI digest, a 7 MiB Docker roundtrip, a 128 MiB regctl/Docker roundtrip, Cosign signatures and one SLSA attestation. Immutable tags, promotion, retention holds, read-only push denial, cross-repository denial and live permission downgrade/revocation passed. The pinned official OCI v1.1.1 client recorded **71 passed, zero failed, eight skipped**; single-repository Golf credentials do not exercise cross-repository mounting. Client credentials, signing keys and images were cleaned. [Client receipt](compatibility/evidence/cfcr-hosted-clients-20261012.json) records the executed client script hash. Final installation cleanup is recorded separately below.

The initial sample in that deployment had first-pass p50 1,486 ms / p95 2,540 ms and repeated-read p50 273 ms / p95 394 ms, with eight incomplete-index failures ([receipt](compatibility/evidence/large-repository-reads-registry-profile-20261012.json)). Nested timing isolated one 1,668 ms authority queue wait with 59 ms of authority D1 work. After indexing finished, a fresh 60-read sample had **zero failures**, first-pass p50 575 ms / p95 1,124 ms and repeated-read p50 223 ms / p95 832 ms ([receipt](compatibility/evidence/large-repository-reads-indexed-20261012.json)). This later sample overlapped release rehearsal: it is not a controlled quiet-workload comparison. Both repositories are ten-commit imports, not full upstream history.

The shared browser verified the new deployment panel on an actual hosted PR Checks view, including the selected commit, per-run protected links, hostname, copy action and expiry. This used private service-auth transport; it does not validate a human Access login. Desktop and a later loaded 390 px hosted viewport both had no document-level horizontal overflow. The latter used the desktop browser at a narrow viewport, not a physical phone. A final line-break-only expiry-spacing adjustment passed both local preview regressions after the hosted build. The Settings package-policy inventory also finished loading after focus revalidation.

A dedicated hosted probe with the production scanner class still failed startup with a provider internal-error reference before producing reports. Its Worker, Container application and uploaded image were removed. Readiness/cancellation unit coverage and standalone scanner-tool success do not qualify native scanner execution.

The final release rehearsal reached guarded rollback after the baseline and target release converged. Rollback preflight failed on a provider D1 query with HTTP 403 / API error 7403 (account invalid or unauthorized for that service). No successful rollback or promotion is claimed. This supersedes the preliminary suspicion that convergence itself had timed out; the observed mismatch did eventually resolve. The full profile is failed despite passing registry and UI subsets. Owned cleanup proceeded immediately.

Cleanup completed at **02:11:23 UTC**: every recorded resource category is absent, including Workers/DO namespaces, Container applications/images, registry resources, D1/R2, Artifacts namespace, managed previews, queues/workflows, Access apps/service token, Secrets Store and owned API tokens. The independent cleanup timer is inactive. The temporary browser proxy stopped and its private bootstrap file was removed. No retained user demo was replaced. The client receipt and failed-profile receipt include final cleanup.
