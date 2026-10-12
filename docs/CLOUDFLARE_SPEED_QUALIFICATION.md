# Cloudflare speed: measurements, changes and remaining gates

Updated 2026-10-10. This is a qualification record for the native demo, not a global latency guarantee or a declaration of full native forge parity. The complete work queue remains in [the robustness plan](CLOUDFLARE_ROBUSTNESS_OPERATIONS_PLAN.md); per-RPC coverage remains in [the capability inventory](CLOUDFLARE_CAPABILITY_INVENTORY.md).

## 2026-10-11 short comparisons over deep history

Comparisons first inspect bounded linear paths from both selected commits. When
those paths intersect before a merge node, their exact set difference is known
without traversing older ancestors. The implementation validates both commits,
shares duplicate reads and falls back to the existing bounded DAG walker whenever
that proof is unavailable. It does not infer ancestry from timestamps or return
an incomplete comparison as success. A three-commit proposal over a synthetic
10,000-commit history needs four commit reads. Tests include reversed comparisons,
missing commits, 60 generated DAGs checked against an exhaustive oracle and
existing real Git patch application cases.

Hosted run `golf-native-20261011-4e4a3c97` pushed 1,000 real additional commits into
its disposable Artifacts repository. The exact one-commit comparison completed
in **429 ms**, then **283 ms**, with one selected commit and no changed files.
Its nine-path warm file inventory took **177 ms**; five metadata reads took
318/292/209/190/220 ms. These observations use one service principal and a small
unchanged tree. They do not qualify a large working tree, branching-history
scalability, global concurrency or an empty-cache cold start. Historical
Kubernetes/Rancher comparison-limit refusals below remain unresolved evidence.

After final release convergence, eight further exact comparisons at concurrency
four all passed identity checks: 1500/1530/1542/1493/389/436/448/380 ms (median
970.5 ms). Both Worker and repository response release headers matched
`09a8e092a63b289e0f736df56f068172be2dfc5d16d84c809be6bf852124b611`.
Cache temperature was not controlled following rollout. The first batch's roughly
1.5-second latency is retained, not described as an instant experience. This is
one principal on a small tree, not independent tenants or multi-region load.
Receipt: `deep-comparison-concurrency.json` in the owned run directory.

After rollback and promotion, a second eight-request/concurrency-four sample also
passed every identity/release check: 1102/1102/1098/1100/588/786/580/765 ms (median
942 ms). All reported coordination queue times were zero. Artifacts open reached
446–449 ms on two requests, token creation took 54–188 ms, and D1 totals were
28–192 ms. Warm immutable-object hits and shared pending reads were observed.
These overlapping stages do not sum to client wall time; the remaining transport
and platform overhead is not isolated by this sample. Receipt with raw timing:
`deep-comparison-promotion.json`. Provider setup/token overhead and burst latency
remain optimization targets; authorization and mutable-ref freshness must remain
current when reducing these reads.

The shared browser preserved document identity through repository → PR list →
PR detail, used Archivo and had no horizontal overflow at 1280×800. The temporary
private service-auth transport is not human-cookie or secure-context evidence.
The native merge panel displayed current observations while refusing publication.
See this run's `ownership.json` and `merge-browser-proof.json` under
`.tmp/cloudflare-forge/`; final lifecycle results are in implementation status.

## Measure the entire interaction

Separate click-to-feedback, click-to-content, the next visible animation frame, long tasks, layout shifts and request latency. A fast API can still produce a slow interface; a fast cached interface does not prove that cold provider reads are fast. Record visibility state: a hidden collaborative browser can delay animation frames and first paint even after the DOM and network work finish.

For each repository, measure metadata/default HEAD, overview, root directory, nested directory, README, referenced images, commit history and commit diff. Repeat at concurrency 1 and 4. Record immutable commit, repository identity, request ID, outer region, Worker release, repository-object release, status, payload size and Server-Timing. A first pass is not proof of an empty provider, edge or D1 cache. Never exclude refusals from the failure count or silently choose a smaller diff to make a large-repository benchmark pass.

`cloudflare/forge/browser-benchmark.mjs` provides these bounded scenarios through `extended: true`. It accepts at most eight repositories, eight iterations and four concurrent requests, with a ten-second request deadline. Failed identity checks, errors and timeouts remain in the report. Response bodies and credentials do not enter its observations. Browser automation should start a bounded run and collect its result separately if the collaborative browser tool's own timeout is shorter than the run.

## What is cached

| Layer | Current implementation | Authority and bound |
| --- | --- | --- |
| Browser | Immutable source pages, README/image data, accepted navigation observations; intent-only source prefetch | Private in-memory query cache; ten-minute retention, 64 inactive-query/8-MiB bounds; new admission checks current repository access; signout/denial clears private observations |
| Repository Durable Object | Immutable Git commits, trees, blobs and commit-keyed logs; duplicate concurrent reads share their pending result | Scoped by account/namespace/repository identity; 128 objects/4 MiB, objects at most 1 MiB; bounded 4,096-entry blob-size map; mutable refs are not cached |
| D1 | Immutable directory/file/history/overview and completed commit-diff results | Current grants checked before reads and at final workspace authority; SHA-bound keys and payload hashes; 256 KiB per payload, 64 entries/repository, 256/workspace, 24-hour expiry |
| R2 | Durable copy of replaceable read indexes and retained hashed frontend assets | Private bucket, conditional writes, hash/readback, bounded reconciliation and owned cleanup |
| Browser assets | Content-addressed JS/CSS/fonts/images | Access remains the outer gate; immutable private asset headers; old release hashes retained during deployment |
| Cloudflare upstream fetch cache | Anonymous allowlisted external README image responses | Only HTTP 200 gets a five-minute edge TTL; redirects/errors bypass cache; document membership, redirect hosts, image type and size are still validated; Golf's private RPC response remains no-store |

Redis is not used in this native path. Adding a remote key/value round trip is not inherently faster than the existing local object cache or immutable D1 index. KV's eventual consistency must not become repository-permission, mutable-ref, merge or quota authority. Wider edge caching of private immutable bytes needs an authenticated outer Worker, a private inner origin and explicit account/repository keys. Do not cache a private authorization decision together with shared content.

The index/object limits above are prototype resource bounds, not suitable default promises for an unrestricted global SaaS. Increase them only with eviction, cost, memory and concurrent-tenant evidence.

## Implemented in this increment

- [x] Measure Access identity, actor lookup, repository grant, D1 calls, Artifacts open/info/log/read stages, final workspace authority and coordination queue time independently.
- [x] Overlap independent Artifacts info/default-head reads, waiting for both to settle before disposing the provider handle.
- [x] Count immutable object hits/misses, shared in-flight reads, immutable index hits/misses and provider failures.
- [x] Persist a bounded window of performance observations in Workspace Durable Object SQLite and expose it through the existing administrator-only Operations dashboard.
- [x] Show mean/p95 request and metadata timing, individual stages and cache ratios. The window is the latest 2,048 RPC observations within 30 minutes. Streaming watches are excluded. Existing execution/queue-age/provider observations remain separate.
- [x] Remove background language indexing from the foreground repository-read admission queue. The independent index queue still serializes index batches; generation/result fences prevent a stale batch overwriting a replacement job.
- [x] Stop redundant provider scanning when a verified immutable overview has already been populated through the canonical-Git metadata operator.
- [x] Overlap independent diff-side commit/tree/blob reads and graph reads, including failure settlement before disposal.
- [x] Cache completed immutable commit diffs within the existing D1/R2 index bounds.
- [x] Join discussion-author/profile reads to avoid the second lookup for every author.
- [x] Keep authorized source and README content mounted during refresh. Denial still clears the private view.
- [x] Keep the sidebar visible during automatic language-progress polling; explicit refresh and denials retain their existing access behavior.
- [x] Memoize unchanged numbered source rendering; preserve line anchors, fragment selection and keyboard access.
- [x] Render invalid source query strings through the ordinary missing-page view instead of the generic reload error screen.
- [x] Exercise expired/replaced index jobs, provider errors, stale job completion, private source refresh, sidebar refresh, malformed addresses and cached-content revocation.

Overlapping stage totals are not additive wall time. Observations belong to one workspace, not the entire account. Request timing ends when the RPC response is returned, not when an arbitrary streaming body finishes. The dashboard is read-only; collected usage and billing must keep their actual provider source/window rather than infer dollars from request counts.

## Hosted observations and final rollout

The disposable namespace is `golf-native-20261010-014e4e98`, with an independently armed stop at 04:58:57 UTC. The final source release for this increment is `0d521b4763766fa80db9973294bdff2ec184c96d6d892e8721437590d8a215b6`, Worker version `e16c6e17-c81f-44cb-a3c5-017ecd9a9d09`. Provider acknowledgement alone does not qualify the release: repository Durable Objects can temporarily serve the compatible predecessor. Check both release headers before attributing a measurement to the final implementation.

Before the independent-index-queue change, a four-repository run observed first-pass p50/p95 of 805/2,428 ms and subsequent-pass p50/p95 of 1,009/2,169 ms. Queue stages reached roughly two seconds while background metadata jobs ran. This run also retained pending language indexes, an incorrectly selected test image URL and an oversized Rancher diff as failures. The corrected image fixture uses the actual `vite-dark.svg` reference from Vite's README.

Warm Vite API reads subsequently measured about 130–200 ms after background contention cleared. A visible root navigation sample reached DOM content at 113 ms and the next animation frame at 113 ms, with no observed long task. This is a small controlled sample, not browser-wide INP or a cross-region SLO. Hidden-tab first-paint/frame observations were excluded from conclusions about paint speed.

One cold metadata request observed Artifacts open at 621 ms and log at 396 ms, versus D1 at 58 ms. Those measurements justify measuring provider I/O separately from CPU profiles. The Operations dashboard successfully reported cache ratios and timing observations; a mixed cold/warm run showed about 64% immutable-index hits. A higher hit ratio is not itself an acceptance criterion if misses or permission checks remain slow.

The final 03:14 UTC run contains 108 requests across all five imported repositories, concurrency four, three iterations. Every sample reports the final release in both Worker and repository-object headers. All 45 directory/file reads, 15 repository metadata reads, 15 overviews, 15 history reads and three referenced-image reads passed exact identity checks. Nine of 15 diffs passed; all six failures were the explicitly retained Kubernetes/Rancher comparison-limit responses (HTTP 429). No timeouts or other failures occurred. Queue time was zero in every sample; this run did not force a new background index batch.

| Scenario | Samples | Failures | Median | p95 |
| --- | ---: | ---: | ---: | ---: |
| File/directory reads | 45 | 0 | 183 ms | 274 ms |
| Repository/default HEAD | 15 | 0 | 198 ms | 685 ms |
| License/language overview | 15 | 0 | 195 ms | 421 ms |
| History | 15 | 0 | 176 ms | 197 ms |
| Referenced README image | 3 | 0 | 176 ms | 191 ms |
| Commit diff | 15 | 6 | 383 ms | 2,251 ms |

Across all scenarios, the first pass had median/p95 237/1,325 ms with two failures; subsequent passes had 172/1,279 ms with four failures. The successful warm subset had median/p95 170/219 ms, **excluding those four failed diffs**. These subsets must not replace the all-request failure count. Earlier runs had different fixtures/cache state and are diagnostic context, not a controlled percentage-speedup experiment.

Final served UI measurements put warm root-directory DOM readiness at 96 ms and warm `package.json` readiness at 72 ms, with no observed long task in the small navigation sample. The collaborative browser suspends rendering between tool calls; its delayed animation-frame timestamps are not valid end-user paint/INP measurements. Invalid initial selector observations are retained without invented timings. Layout shifts during navigation remain visible in the raw observations; slower devices, cold paint, large source files and stable geometry still need qualification.

The human Operations read also reports matching final Worker/workspace release headers, actual timing/cache observations and zero queued/running evidence jobs. Its 30-minute window includes earlier releases and deliberately failing tests; it is not a final-release-only percentile. Receipts are under `.tmp/cloudflare-forge/golf-native-20261010-014e4e98/`: `machine-repository-benchmark.json`, `speed-browser-qualification.json`, `warm-cache-revocation.json` and `worker-cpu-after.pprof`.

Validation passed: full `make cloudflare-check` (152 native tests and 14 frontend unit tests, plus bridge/agent checks), native/portable frontend builds, real workerd/D1/DO/Queues/Workflows/R2 authority checks, and 47 Cloudflare operator tests. The broader focused browser run initially passed 114/118 cases; the four malformed-query failures were fixed and the seven affected route/source cases passed on rerun. Four sidebar refresh/revocation cases also passed. The entire web suite and Docker/Kubernetes served UI were not rerun.

## Repository fixtures and fidelity

The demo now includes Vite, Kubernetes, Moby, Rancher and Cloudflare Workers SDK, in addition to canonical collaboration/CI/preview fixtures. Each imported repository is an explicitly described default-branch snapshot with the latest ten commits. These are not all-ref/full-history migrations. Imported heads were checked through Git and upstream commit/tree identities. Initial provider credentials were revoked. Kubernetes' import endpoint failed; the same reserved repository was recovered through verified normal Git transport after confirming provider absence.

Kubernetes' canonical-Git overview operator indexed 25,883 included files and detected Apache-2.0. It computes from the Artifacts snapshot rather than copying GitHub language statistics. Vite, Moby, Rancher and Workers SDK completed their live native language indexes. Missing older parents in shallow snapshots cannot establish a file's older last-change commit.

Large HEAD diffs in Rancher and Kubernetes exceed the current native comparison bounds. These failures remain visible in the benchmark. Full support requires a file inventory plus paged/lazy per-file patches and explicit large/binary handling; merely increasing one memory limit or returning a fabricated partial patch is not acceptance.

## Live profiling

[Cloudflare's on-demand profiling](https://blog.cloudflare.com/workers-on-demand-profiling/) captures CPU or heap profiles from active Workers and Durable Objects. It complements Server-Timing; it does not cache data or explain remote I/O waiting on its own.

```sh
cf --profile golf workers versions profile VERSION \
  --worker-id WORKER --duration-ms 10000 --profile-type cpu > worker-cpu.pprof
go tool pprof -top worker-cpu.pprof
```

Pin account/profile/version, send bounded representative traffic during capture, and retain the profile with that release's benchmark. Use `--namespace-id` and `--actor-id` to target a particular active Durable Object. Never treat an idle-only capture, or the provider's “no recent executions” response during rollout, as proof that there is no CPU bottleneck. The first five-second capture here was idle-only; a later ten-second active capture contained Worker call stacks, mostly idle/runtime work. It is not sufficient evidence to name a specific CPU optimization target.

The final ten-second CPU capture succeeded during the final benchmark. About 40% of samples were idle and 45% had unresolved symbols; identified stacks included provider instrumentation, hashing and serialization. This validates the profiling workflow, but symbol resolution and per-object captures are needed before attributing CPU cost to a particular application function.

## Unattended testing and Access presentation

The test machine used an expiring Access Service Auth credential restricted to its exact public `/32`, plus a separate native Golf identity. It was not an anonymous IP bypass. The identity had read access to test repositories, write access only to the canonical fixture, and no Operations administrator role. The secret stayed in a private local receipt; an independent timer retires it. This avoids emailing sign-in codes during unattended API testing. Human browser Operations checks still use the human administrator's Access session.

After qualification, the temporary policy was removed before its service token (Cloudflare refuses to delete an in-use token). Independent readback confirmed the token absent, original human policies preserved, native credential revoked, test user inactive and local secret removed. Its separate cleanup timer was then stopped. `machine-retirement-proof.json` records these assertions.

The demo's original supervisor was no longer running at final inspection. The maintained recovery path now retires only the original owned Worker previews through Golf's native revoke API before deleting their provider cleaner. It checks the original service token and application inventory, rotates that owned token, uses a five-minute native cleanup credential, rejects redirects, checks the purge receipt and revokes the credential in `finally`. The 18 supervisor/recovery tests pass. The independent 04:58:57 UTC stop timer remains active with bounded retries; actual deadline teardown has not yet happened. The direct read-only cleanup preflight still refuses while applications are unpurged, preserving their cleaner.

To stop this owned demo immediately, including managed preview cleanup:

```sh
python3 scripts/cloudflare_demo.py stop .tmp/cloudflare-forge/golf-native-20261010-014e4e98/ownership.json
```

Inspect the ownership/recovery receipts for completed absence; a stop request or armed timer alone does not prove retirement.

After warming Vite's immutable README index, removing this test principal's grant denied all four concurrent post-revocation requests. Restoring the original read grant restored access. This is hosted warm-cache revocation evidence, not an in-flight revocation proof; the latter has controlled source/runtime regression coverage.

[Access login-page branding](https://developers.cloudflare.com/cloudflare-one/reusable-components/custom-pages/access-login-page/) supports organization branding, but the login-page appearance applies to the Zero Trust organization. It is not arbitrary per-application Golf HTML/CSS. Do not rebrand other applications in a shared Zero Trust account as a side effect of this app-specific request. For a dedicated Golf Access organization, use the existing `web/public/golf.svg`, organization name “Golf”, dark background `#090909`, and copy “Sign in to Golf” / “Repository access is checked by Golf.” Host the logo on an intentionally public asset origin. The current shared account's global appearance was not changed.

## Remaining performance and completeness gates

1. Verify final Worker/DO release agreement, repeat contention tests while an index is actively advancing, and retain before/after observations separately.
2. Capture visible cold entry, warm folder/file/back navigation, slow-network feedback, large text/highlighting, long README/image layout and large diff interaction. Record click-to-feedback, content readiness, frames, long tasks and layout shifts independently.
3. Keep immediate navigation feedback and stable panel geometry; avoid hiding a whole page for unrelated metadata refreshes. Preserve accessibility, browser find, selection and line anchors before introducing virtualization.
4. Implement paged file-diff inventories and lazy patches, then qualify large real HEAD changes. Keep current bounds and failures honest until then.
5. Build a persistent commit/path index before claiming deep-history last-change lookup at scale. Qualify full-history import, LFS, submodules, unusual paths and maximum eligible objects independently.
6. Measure multiple concurrent principals and independent workspaces from more than one actual geographic location. Add overload/fairness/cost acceptance before global SaaS claims.
7. Move fleet-wide latency/cache analytics off the single-workspace retained-sample journal when actual request volume warrants it. Keep permission/merge authority on strong, current reads.
8. Complete native collaboration write gaps—workspace membership, refs/files, advanced issue resources, inline/pending reviews and protected merge—against the existing per-method checklist. Current issue/PR/review/check/CI/preview fixtures do not establish full local parity.

Protected merge remains a separate authority implementation: exact base/head, current grants, trusted tests, eligible reviews, branch policy, original operation identity, Git compare-and-swap and ambiguous-write reconciliation must all be enforced. Neither cached metadata nor a passing reported check grants publication authority.
