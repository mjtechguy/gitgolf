# Managed reviewer publication boundary

This packet repairs the existing managed bot's inline publication. It does not introduce human inline editing, persisted private drafts, agent write delegation or protected merge. Source and runtime qualification are recorded separately in the implementation ledger.

## Selection and admission

Every newly admitted run captures exact native repository and PR IDs, the observed target tip B, merge base M, head H, raw M→H patch and its SHA-256. The server rereads the bound comparison under the sponsor's current authority before and after publication, and separately observes the publisher's current native identity, target, open/nondraft/unmerged state and all three objects. These observations do not lock native refs or prevent an intervening native change.

The strict parser supplies a complete bounded file/hunk/row inventory. Findings select actual new-side coordinates, with no fallback from malformed, binary, ambiguous or incomplete patches. Rename authoring remains denied until the native path-limited context behavior is qualified. Known unsupported scanner, control-character and retained-context limits are denied before POST; read inventory is preserved where possible. Final escaped bodies must fit the independent receipt validator, rather than relying only on limits for raw model output.

The publisher scans its own native reviews using the observed configured page span and a bounded, total-based inventory. Empty pages may hide other actors' pending drafts; they do not establish inventory completion. Any existing publisher-owned PENDING review, malformed/incomplete response or changed configuration refuses publication. This scan is not an atomic fence against a directly created native draft arriving afterward.

## Durable once-only dispatch

Migration035 adds immutable comparison metadata, a metadata-only publication journal and append-only phase events. An advisory transaction lock and unresolved-effect uniqueness bind the native forge, publisher actor, repository and PR. A committed reservation freezes the existing findings and payload fingerprint. Only that reservation owner can commit dispatch intent and issue one POST; status reads, restart and repeated intake never resume a dispatch.

Before dispatch, a known preflight refusal may record `rejected` and release that reservation. After dispatch intent, every unverifiable result remains `dispatch_unknown`, with the run shown as `publishing` or `publication_unknown`. Head changes, reviewer edits, supersession and fresh manual/mention/automatic intents cannot erase or bypass that exclusion for the same actor and target. Storage loss after native acceptance retains the committed uncertainty. No timeout, body search, guessed native ID or automatic retry clears it.

The native review header and complete child collection are read independently. Success requires exact review/author/target/decision/head/body, unique child identities, complete count, exact body/path/new-side coordinate multiplicity and strictly bound native hunk context. Historical-header/current-hunk mixtures fail validation. Authority and selected comparison are rechecked afterward. Success proves that bounded historical observation; it does not prove atomic native effects, current eligible approval, absence of concurrent absorption or merge readiness.

## Legacy and privacy boundaries

Old publishing, unknown and outdated rows conservatively block their original publisher/repository/PR-number domain because an original dispatch may have been erased. The migration invents no native PR IDs or reconstructed history. Previously published receipts retain their original historical proof; they are not upgraded to complete child/context verification.

New journal/events retain identity, fingerprints and fixed reason codes. Existing run patches and findings retain their preexisting plaintext storage model; this packet does not retrofit their encryption. Per-child receipt IDs are validated but not persisted as individual immutable receipts. Original persona configuration is fingerprinted in the constructed payload and is not reconstructible from a later edited reviewer. No automated reconciliation is implemented.

Exclusion is publisher-specific, rather than a common human/bot fence. A different publisher is a different exclusion domain. Direct native writers remain outside Golf's atomic control. Coordinated schema035 recovery remains unqualified; the recovery tool continues to reject schemas outside its qualified allowlist.

## Runnable evidence

Real isolated PostgreSQL fault/race tests cover durable dispatch, simultaneous reservation, unknown-outcome replay prevention, immutable evidence, legacy migration, complete receipt mismatches, hidden-page pending preflight, escaped output limits and supersession during held preflight. The native parser probe separately compares actual selected/current contexts. The optional native publication helper proof uses supported local native APIs and a disposable Golf database; it exercises deterministic findings without inference. It is not an end-to-end provider or served-worker qualification. Exact executed results belong in [implementation status](IMPLEMENTATION_STATUS.md).
