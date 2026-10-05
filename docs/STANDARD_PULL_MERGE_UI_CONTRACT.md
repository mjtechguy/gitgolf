# Standard native pull-request merge UI

The source supports bounded native merge commits and squash through `golf.pull.standard-native-merge.v1` (same repository) and `.v2` (explicitly bound fork source). The schema065 packet is backend `805c9b1`, requested UI `f1acd399`, and helper `9b06b6037` with the same-name negative correction `ff6acf0`. Its native squash/served qualification, retained deployment and latest-schema recovery are pending separate receipts. Source fixtures do not qualify full protected integration, all Git writers or trusted checks.

## Current selection and confirmation

**Inspect merge observations** remains an explicit read. A freshly validated open, non-draft, unmerged PR may open **Merge pull request** only with exact canonical repository/native owner/PR/source identities, selected full H and revision, current readable named branch, known unprotected target, and positive ordinary writer/native caller observations. The selected strategy must be explicitly enabled by current native configuration. Protected, unknown, changed-head or unavailable targets remain unavailable. Observations grant no executable permit: the backend independently rechecks current authority, source and target before its supported native write.

Forks require all three exact source fields: canonical key, repository ID and owner ID. Source/target refs may have the same spelling (for example fork `main` → upstream `main`) only with an explicitly bound different source repository. A same-name unbound request is invalid before journaling; different-ref legacy unbound fork refusal retains its existing durable REJECTED behavior. Current source privacy remains required for bound fork submission and historical inspection.

The shared requested dialog shows source, target and H. **Merge method** offers **Create a merge commit** and **Squash and merge** only when each is allowed. Cancel receives initial focus; Escape closes without dispatch. **Commit title** and **Commit message (optional)** start empty for native defaults. Optional custom text is exact and form-memory-only (UTF8 title≤255 bytes, message≤6000 bytes); a nonempty title must already satisfy the native title rules. It is sent once on initial confirmation, never stored in browser intent or reconstructed by inspection. Squash has **Squash pull request #N?**, **Confirm squash merge** and **Native squash merge confirmed.** labels. There is no force, automatic merge, branch deletion or rebase control.

## Immutable original operation

Before one `SubmitStandardPullMerge`, the tab stores only original operation/actor/repository/owner/PR IDs, number, revision, H/B and named refs under an origin/account/repository/PR-scoped key. Bound forks add their exact source identity; squash adds `method: "squash"`. Ordinary merge omits this field, preserving historical v1/v2 metadata and request fingerprints. Explicit wire `merge` is normalized to the omitted legacy method before fingerprinting. The durable method cannot change under an original key; custom text is also fingerprint-bound without plaintext persistence. Synchronous guards prevent duplicate submissions; corrupt storage blocks new changes. Server exclusion remains authoritative if browser storage is lost.

Reload makes no mutation or automatic status lookup. **Inspect original merge** sends only `GetStandardPullMergeOperation` with original identity; it needs no custom text or new selection. RESERVED and DISPATCH_UNKNOWN preserve uncertainty and block replacement. Missing/denied/malformed results do not prove no effect. Exact REJECTED/preflight_refused allows an explicitly reviewed fresh selection; verified SUCCEEDED displays the historical full output commit, not current deployment or merge eligibility. H/B/revision/refs, actor/target/source IDs, method/contract, phase, timestamps and success-only output/actual-base hashes must match before adoption. A known original is inspected before admitting new method work; no historical operation silently changes method or resends.

Native merge readback requires the current PR/source/H and output C, ordered parents `[actual B, H]`, and current target C. Squash requires the exact current PR/source/H and C, one parent `[actual B]`, and current target C. Selected B remains comparison context: neither method provides atomic expected-base enforcement. Squash ancestry and a native merged flag do not establish content equivalence or cryptographically verified integration. Native/external writers are not atomically fenced by these separate observations; full P0.8 acceptance remains open.

The component is keyed by actor/repository/PR, preserving an own historical receipt across inventory refresh. Current-access refresh masks private data and controls; scope/account changes or unmount invalidate callbacks. Authority denial clears parent PR data through the existing private-query seam. Original metadata remains inspection-only after uncertainty. `clearOtherStandardMergeIntents` supports global session/logout cleanup even when the component is unmounted. No editor bundle is eagerly required.

## Evidence and runnable qualification

Historical [schema061 native/browser proof](../.tmp/standard-merge061-served-attempt2/qualification/manifest.json) on `234d471` passes one same-repository writer merge, independent native output/parents/target, original replay/reload/restart and reader/protected/fork refusals. [Owned cleanup](../.tmp/standard-merge061-served-attempt2/parent-manifest.json) and [running verification](../.tmp/settings-061-running-proof/manifest.json) pass. The separate [schema063 fork proof](../.tmp/standard-fork063-served-attempt2/qualification/manifest.json) covers one explicit source-bound fork merge and current private-source denial. Neither historical receipt qualifies squash or the new same-name fork case.

The earlier merge/observation/workspace source suite passes 103 cases in 1.3m, followed by 29 merge cases in 9.1s and 29 observation/privacy/navigation cases in 35.9s after final context guards. The new requested-method/text UI packet passes 103 affected source cases; backend source tests cover method immutability, default fingerprint compatibility, enabled-strategy refusal and exact method-specific readback. These are source fixtures, separate from native effects and recovery.

The [existing qualifier](../scripts/standard-pull-merge-smoke.py) and [browser helper](../scripts/standard-pull-merge-browser.mjs) retain their default merge recipe. Pure receipt, method, ancestry and text-tamper checks pass without runtime resources:

```sh
python3 scripts/standard-pull-merge-smoke.py --self-check
node scripts/standard-pull-merge-browser.mjs --self-check
# Root/operator provisions an exact fresh owned stack first; existing target flags remain required.
python3 scripts/standard-pull-merge-smoke.py \
  --stack-root "$STACK_ROOT" --project "$OWNED_PROJECT" \
  --compose-file "$FRESH_COMPOSE" --env-file "$FRESH_ENV" \
  --image "$EXACT_CORE_IMAGE" --source-revision "$FULL_SOURCE_COMMIT" \
  --golf-url "$OWNED_GOLF_LOOPBACK" --native-url "$OWNED_NATIVE_LOOPBACK" \
  --output "$FRESH_PRIVATE_OUTPUT" --method=squash --browser --restart
# A separate fresh output/fixture adds: --fork --same-branch-fork
```

The prepared squash recipe makes two supported-native source commits, confirms one ordinary writer operation, independently verifies exact PR/H/C and the single parent/target, and checks original replay, changed-method refusal and restart. The UI variant edits owned literal title/body once, compares native message/hash without plaintext manifest retention, validates no text in local/session storage, reloads read-only, explicitly inspects the original once, and captures four font-settled dark/light 1440/390 views. Reader/protected and private-source refusals remain enforced. It never sends a native merge directly, starts/builds/pulls a stack or claims accepted-response-loss/protected integration qualification. Root owns actual execution and complete owned cleanup before any readiness change.
