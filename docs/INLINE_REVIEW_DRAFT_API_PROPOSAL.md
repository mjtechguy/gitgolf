# IR-2 private inline-review draft API proposal

Prepared 2026-10-03. **Backend source integrated in `9f51f5f`, UI in `3be5828` and final spaced-path correction in `cf90c40`; bounded replacement-image served/native/UI qualification passes; broader gates remain open.** This records the first SQL-only Golf draft slice under the [inline implementation design](INLINE_REVIEW_IMPLEMENTATION_DESIGN.md), after the [qualified exact PR comparison](PULL_DIFF_CONTRACT.md). It applies to the portable and Cloudflare tracks with AI/Cloudflare optional. It does not create a native PENDING review, publish comments, approve/request changes, resolve a conversation or authorize merge.

Use three owner-only RPCs, the existing Go/Connect API and PostgreSQL, retained encrypted comparisons, immutable draft versions and explicit CAS. No worker or separate native-publication journal is required for these private SQL mutations. Keep one active Golf draft per authenticated owner/forge/native PR; history and tombstones remain separately identifiable. Ownership is server-derived from the current managed actor and its stable forge mapping, never a caller-supplied user ID. Instance administration is not access to another user's draft.

The bot-publication correction and strict shared coordinate parser/schema035 have been integrated separately. This draft backend reuses that exact parser; it does not keep a second permissive parser. Its migration is036, with Golf-owned tables only. Both035 and036 now compose in the integrated SQL models. UI is integrated and locally deployed with the bounded final served proof below; latest-schema recovery and broader acceptance remain separate gates.

## Wire contract

Field numbers and names below match the generated backend/UI contract in this packet. Repository/PR IDs retain canonical positive signed 64 decimal strings; commits retain full lowercase 40/64-character equal-width IDs. Versions and target generations use canonical signed64 decimal strings: draft version `"0"` only for creation; target generation `"0"` denotes a never-created slot, positive values thereafter, maximum 9223372036854775807. Reject leading zeros, signs and overflow, and refuse increment at the maximum. Draft/entry/operation/comparison UUIDs are canonical UUIDv4 strings.

```proto
message PullReviewDraftTarget {
  RepositoryKey repository = 1;
  string repository_id = 2;
  string pull_request_id = 3;
  uint32 number = 4;
}
message PullReviewDraftCapture {
  PullRequestSelection selection = 1;
  string expected_pull_revision = 2;
  string merge_base_commit_id = 3;
  string diff_sha256 = 4;
}
message PullReviewDraftComparison {
  string id = 1;
  PullReviewDraftCapture capture = 2;
  string parser_version = 3;
  string raw_diff = 4;
  uint32 byte_size = 5;
}
enum PullReviewDraftSide {
  PULL_REVIEW_DRAFT_SIDE_UNSPECIFIED = 0;
  PULL_REVIEW_DRAFT_SIDE_OLD = 1;
  PULL_REVIEW_DRAFT_SIDE_NEW = 2;
}
message PullReviewDraftCoordinate {
  uint32 file_index = 1;
  uint32 hunk_index = 2;
  PullReviewDraftSide side = 3;
  uint32 line = 4;
  string path = 5;
}
message PullReviewDraftEntry {
  string id = 1;
  PullReviewDraftCoordinate coordinate = 2;
  string body = 3;
}
message PullReviewDraft {
  string id = 1;
  PullReviewDraftTarget target = 2;
  string user_id = 3;
  string version = 4;
  PullReviewDraftComparison comparison = 5;
  string summary = 6;
  repeated PullReviewDraftEntry entries = 7;
  string created_at = 8;
  string updated_at = 9;
}
enum PullReviewDraftOperationKind {
  PULL_REVIEW_DRAFT_OPERATION_KIND_UNSPECIFIED = 0;
  PULL_REVIEW_DRAFT_OPERATION_KIND_SAVE = 1;
  PULL_REVIEW_DRAFT_OPERATION_KIND_DELETE = 2;
}
message PullReviewDraftReceipt {
  string operation_id = 1;
  string draft_id = 2;
  PullReviewDraftTarget target = 3;
  PullReviewDraftOperationKind kind = 4;
  string expected_version = 5;
  string accepted_version = 6;
  string comparison_id = 7;
  string accepted_target_generation = 8;
  string expected_target_generation = 9;
}
message GetPullRequestReviewDraftRequest {
  PullReviewDraftTarget target = 1;
  string draft_id = 2;
  string operation_id = 3;
}
message GetPullRequestReviewDraftResponse {
  PullReviewDraft draft = 1;
  PullReviewDraftReceipt receipt = 2;
  string current_version = 3;
  bool deleted = 4;
  string target_generation = 5;
}
message SavePullRequestReviewDraftRequest {
  PullReviewDraftTarget target = 1;
  string draft_id = 2;
  string expected_version = 3;
  string operation_id = 4;
  oneof comparison {
    PullReviewDraftCapture capture = 5;
    string comparison_id = 6;
  }
  string summary = 7;
  repeated PullReviewDraftEntry entries = 8;
  string expected_target_generation = 9;
}
message SavePullRequestReviewDraftResponse {
  PullReviewDraftReceipt receipt = 1;
  PullReviewDraft draft = 2;
  string current_version = 3;
  string target_generation = 4;
}
message DeletePullRequestReviewDraftRequest {
  PullReviewDraftTarget target = 1;
  string draft_id = 2;
  string expected_version = 3;
  string operation_id = 4;
  string expected_target_generation = 5;
}
message DeletePullRequestReviewDraftResponse {
  PullReviewDraftReceipt receipt = 1;
  string current_version = 2;
  bool deleted = 3;
  string target_generation = 4;
}
```

`user_id` is the server's current wire actor ID for UI binding; SQL ownership also retains the authoritative managed principal and forge actor/mapping. Requests contain no user selector. A response naming another actor/target/comparison is rejected before displaying private content. Existing `PullRequestSelection` supplies repository key, native repository/PR IDs, number and base-tip/head objects; capture adds displayed revision, actual old-side merge base and SHA-256 of the exact displayed UTF-8 diff, including trailing newlines. There is no decision or publication field.

## First capture versus editing a retained comparison

On first Save, require expected version 0 and `capture`, reject a supplied comparison ID, and independently require `target` and `capture.selection` to agree on repository address, native IDs and number. Resolve the current target through supported APIs; compare its native IDs, displayed revision, base tip/head and actual merge base, including the retained-head observations from IR-1. Independently read the bounded diff and compare its exact SHA-256 to the displayed capture. Derive the returned byte count from the server-owned bytes. Never accept client source text, client parser output or a digest alone as provider authority. A drifted first save fails without retaining a replacement snapshot or overwriting the unsent editor.

Parse the server-owned bytes and validate every selected side/path/file/hunk/line. Indices refer to the original native inventory before browser filtering/sorting. OLD uses the legitimate old path/line; NEW uses the legitimate new path/line. Context rows permit an explicit side. The line must be positive and at most 2147483647. Reject unspecified sides, unsafe paths, unsupported/ambiguous/overlapping coordinates, malformed/oversized structured previews, binary/submodule/metadata-only rows and newline notices. The first slice allows one entry per exact coordinate and unique entry IDs; multiline, whole-file and suggestions require separate contracts.

The transaction stores an immutable actor/forge/target-bound comparison and version 1. Retain server-derived original provenance, parser version, exact raw bytes/digest and validated coordinate context. Preserve the selected base tip, actual M and head H separately; a line/blame object is not any of these identities.

Later Save requires the exact saved draft ID, positive expected version and its immutable `comparison_id`; reject a new `capture` or a different comparison. The server decrypts/validates the retained comparison and validates the complete replacement summary/entry collection against it. A current native push may make the saved context earlier; **do not fetch today's diff to replace saved M/H**. Save/Get/Delete must still independently resolve current repository/PR IDs and current owner/target authority before and after supported-provider waits. Another PR with the same number or another repository at an old address does not inherit the draft.

After rename/transfer, the request uses the current authorized routing address; immutable IDs remain identity. The returned active target uses the current resolved address, while the original comparison and accepted receipt retain their original routing observations. Compare those historic records by immutable target/forge identity rather than demanding old names equal new names. Changing routing metadata never remaps original M/H, grants source credentials or broadens general private-fork access. Qualify this distinction before advertising rename/transfer continuity.

## CAS, operation lookup and deletion

Get returns `target_generation`, including canonical0 when the owner/native-target slot has never existed. Save/Delete require an explicit `expected_target_generation` in addition to the draft version. Every accepted operation advances that generation by one under the managed owner/session and target locks. The target slot is retained permanently: Delete, a new draft UUID and a routing rename never reset it. A slow capture admitted at generation0 cannot create after generation1 save, generation2 delete or generation3 replacement. Operation lookup precedes CAS only to return an exactly matching already accepted intent; a missing receipt never bypasses generation admission. Receipts preserve both expected and accepted generation.

Save replaces the bounded working contents in one transaction and appends an immutable version; entry UUIDs remain stable for edits. CAS conflict is explicit and preserves local unsaved text. No automatic conflict merge or overwrite. Capture/version ciphertext, the current-version pointer and accepted-operation receipt commit atomically. Existing-version/tombstone rows can carry the operation identity; do not scaffold a native dispatch engine. Exact duplicate operation/input returns its original accepted receipt without adding a version; changed input under an operation ID fails. Define equality over canonical typed intent, not JSON property order/escaping. Preserve entry order and exact text; changing either is a changed intent. Validate receipt owner/target/draft/operation/expected/accepted version/comparison; an accepted version is not necessarily the current version after another device edits.

Get with only `target` discovers the current owner's active draft. A supplied `draft_id` selects that exact owned history/tombstone; an optional `operation_id` requires that draft ID and inspects its exact accepted Save/Delete receipt without mutation. A lost first Save already has a client UUID, so reload need not guess the draft from body text. A missing receipt while the original request could still run is **not proof of zero effect**. Keep the operation unresolved; do not infer cancellation from browser abort, absence or elapsed time. The retained owner/native-target generation is the transactional CAS fence across delete/new-draft lifecycles. A conflicting replacement requires its explicitly observed generation; no timer invents success. `ABORTED` denotes a rolled-back CAS refusal. Known precommit capture/quota/CAS and final-handler input refusals additionally carry `Golf-Draft-Effect: none`. Changed-intent receipt conflicts preserve the accepted operation and do not receive that assertion. Transport/commit errors and postcommit authority refusals remain unresolved until exact receipt inspection; a postcommit native identity failure is `UNAVAILABLE`, without no-effect metadata. Logout/401 clears private text regardless of unresolved metadata. A lookup never sends the omitted body or resumes a save.

Delete requires the current version, records a new version/tombstone and removes the active working draft in one transaction. It does not delete a native review or reset a version counter. Never recreate the deleted UUID. Get returns deletion/receipt/version metadata without deleted summary, entries or source. A new draft uses a new UUID, subject to the same active-target/CAS admission; unresolved prior operations cannot silently bypass that admission. Retained encrypted history and eventual purge need explicit policy. After verification evidence is purged, deny content replay rather than invent equality; preserve minimal operation identity/tombstone metadata so IDs cannot become reusable.

Keep persisted drafts independent of the existing overall-review journal and native PENDING inspection. This API has no native POST/PATCH/DELETE; every provider call is a qualified read. Native publication, owner pending adoption/discard and externally uncertain outcomes remain IR-3/IR-4.

## Content, transport and encryption bounds

The limits are independent and enforced server-side before any draft commit:

| Bound | Initial limit / meaning |
| --- | --- |
| Entries | At most 20 unique entries; each has a stable UUID and one valid coordinate. |
| Summary | At most 6000 UTF-8 bytes; may be empty for a private working draft. |
| Entry body | Non-whitespace, at most 6000 UTF-8 bytes each; valid text/control policy from review input. |
| Selected literal path | Nonempty, at most 4096 UTF-8 bytes; no absolute/traversal/control/backslash path. |
| Decoded working content | At most 256KiB across summary, every body and every selected path, plus separately bounded metadata. Check UTF-8 byte counts, not JS characters. |
| Raw retained diff | Existing 512KiB/500-file/12,000-row IR-1 bounds; unsupported structured rows remain read-only. |
| Encoded Save request | At most 2 MiB complete JSON transport bytes, including escaping/metadata, independent of decoded bounds. Get/Delete retain the existing16KiB metadata-only request ceiling. |
| Encoded complete draft response | 6MiB complete JSON transport ceiling, retaining the smaller decoded diff/content limits; reject without partial content. |

Twenty maximum bodies plus a maximum summary and 20 maximum paths total 207,920 decoded UTF-8 bytes before metadata. JSON escaping can expand legal text several-fold; e.g. a serializer may encode `<` as six bytes. A 6000-byte field is not necessarily 6000 wire bytes. The request/response ceilings accommodate that expansion but remain independent checks, including excessive escaping or duplicate/unknown transport material. Do not silently lower a decoded limit by assuming JSON size equals text size. Test the actual Connect serializers and adversarial encoded inputs. The browser estimates decoded sizes and reports precise validation errors, but the backend owns all limits. Retention is bounded by100 Save versions per draft,1000 encrypted records/128MiB per managed owner, and10,000 records/1GiB per instance. A create counts two records; edits and Delete count one. A transactional quota lock serializes the instance bound. Delete has reserved metadata capacity of500 records/8MiB per owner and5000 records/64MiB per instance, allowing all active drafts at the save-record ceiling to be tombstoned. Delete never frees retained encrypted history or permits UUID reuse. No purge API is enabled; reaching retention limits refuses additional saves explicitly rather than erasing verification evidence. A later purge policy must preserve receipt/tombstone identity and must be independently qualified.

Encrypt the raw comparison and complete draft payload, including paths, context and operation-input verification material, through a deliberate review-content domain in the existing [keyring](CREDENTIAL_KEYRING.md). Associated data binds record type, key label, managed owner/forge/native target, comparison/draft/version. Do not reuse the infrastructure credential domain. The packet includes the family in startup key checks, usage, rotation and retirement; it preserves immutable content during re-encryption. Actual latest-schema restore validation remains unqualified. No bodies/paths/context in logs, audits, shared repository events, browser storage or command arguments. Hashes are not encryption.

**Private Save/Delete must not emit shared repository activity**, which would expose draft existence/owner/operation. Explicit read refresh is sufficient for the first slice; later owner-scoped invalidation/polling needs its own authority/privacy contract. Only qualified native publication may subsequently emit the shared pull activity/outbox event.

## Exact illustrative Save request

This is illustrative JSON for `golf.v1.RepositoryService/SavePullRequestReviewDraft`, not a runnable fixture or success receipt. The hash/IDs are illustrative; a real browser supplies hashes of its independently qualified displayed bytes and its managed session/Origin.

```json
{
  "target": {
    "repository": {"owner": "alice", "name": "sample"},
    "repositoryId": "7", "pullRequestId": "13", "number": 3
  },
  "draftId": "11111111-1111-4111-8111-111111111111",
  "expectedVersion": "0",
  "expectedTargetGeneration": "0",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "capture": {
    "selection": {
      "repository": {"owner": "alice", "name": "sample"},
      "repositoryId": "7", "pullRequestId": "13", "number": 3,
      "baseCommitId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "headCommitId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "expectedPullRevision": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "mergeBaseCommitId": "cccccccccccccccccccccccccccccccccccccccc",
    "diffSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  },
  "summary": "",
  "entries": [{
    "id": "33333333-3333-4333-8333-333333333333",
    "coordinate": {
      "fileIndex": 0, "hunkIndex": 0,
      "side": "PULL_REVIEW_DRAFT_SIDE_NEW",
      "line": 1, "path": "src/example.ts"
    },
    "body": "Consider validating this input before using it."
  }]
}
```

A later edit uses the same draft/entry IDs, expected returned version and target generation, a fresh operation UUID and `comparisonId` instead of `capture`; it resends the complete bounded working collection. The expected comparison is the retained one, even when current PR head differs.

## UI integration and acceptance

Extend the shared `DiffViewer`/`DiffHunk`/`DiffSyntax` with optional side/line actions and an editor row, using original file/hunk indices and the same behavior through syntax/Suspense fallback. A new small `PullReviewDraft` component owns current-authorized Get, frozen comparison, TanStack Form, Write/Preview, explicit Save/Cancel/Edit/Delete and receipt inspection. `PullRequestBrowser` exposes an explicit Draft action and Current changes versus Saved draft snapshot when needed. Existing immediate overall `PullReviewComposer` remains separate and clearly states that it does not publish saved inline entries. Use shared Markdown/compact list primitives and global CSS; no settings modal, duplicated table engine or eager per-line RPC.

Only Add/Edit opens a form. Plus actions expose path/side/line labels and remain keyboard usable without hover. Escape/Cancel returns focus to the triggering control; dirty discard and Delete use confirmation only. Plain Enter inserts a newline. Unified/split/filter/syntax changes preserve coordinate and unsent input; collapsing/removing the focused file requires a deliberate close/focus destination. Missing/invalid/ambiguous/raw-fallback rows have no authoring control. Preserve the known actual M/H anchors and reset selection only on an explicit comparison change.

Existing saved snapshots reopen exactly after a push/restart and show earlier/current/unavailable observations honestly; current target access is still required. Unsaved first-capture content remains only in memory and cannot silently save/remap after selection drift. Keep constant PR navigation outside private content hidden during revalidation. Abort reads synchronously, guard late generations against owner/target/session changes, and clear all private content on logout, 401 or live permission loss. Browser storage may hold only scoped draft/operation IDs, expected version and target metadata; no bodies, paths, source or content fingerprints. Reload performs only owner-authorized reads/receipt inspection, never automatic Save/Delete. A successful private save says **Saved privately in Golf**, not submitted/approved/native pending.

The backend packet owns the generated API, strict-parser reuse, migration036, encrypted comparisons/versions/tombstones, generation and version CAS, key lifecycle and Go/real-PG evidence. UI work consumes these contracts separately; backend tests alone do not establish browser or actual served behavior. The separately integrated UI owns the shared renderer changes, draft component/integration, global CSS and focused browser tests. Do not enable native publication or new CLI/MCP write authority in this packet.

Required evidence: exact add/delete/context/old/new coordinates and renamed/deleted/quoted/Unicode paths; duplicate/overlapping/malformed/binary rejection; cross-target capture and wrong hash/IDs/revision; first-save drift; saved old M/H after pushes; current native identity after rename/transfer; owner/administrator/delegation denial and post-wait revocation; two-device CAS; exact duplicate versus changed-input operation; lost save/delete acknowledgements and late requests across tombstone/new-draft admission; restart/tombstone preservation; ciphertext/AAD substitution, missing keys, rotation/quotas; no shared event or plaintext leakage; encoded escape-heavy boundaries; both themes at 1280/390/320px, focused line actions, dirty navigation, syntax fallback, explicit refresh and late-result cleanup. Use real PostgreSQL and served owned fixtures for the relevant paths. Proposal text, mocked UI, existing read/bot successes and schema 035 correction do not establish these results.

## Backend packet evidence (isolated, 2026-10-03)

Nineteen top-level private-draft tests and their subcases pass under `go test -race` against a dedicated disposable PostgreSQL18.4 instance in45.514s. They cover ordinary old/new/add/delete/context/rename/quoted-Unicode coordinates, original inventory indices, malformed/unsupported selection denials, exact M/B/H/revision/hash capture, concurrent version CAS, typed text/order/operation replay, lost acknowledgement lookup, immutable tombstones and UUID refusal, a delayed generation0 capture after save/delete/recreate, retained snapshots after head movement and routing rename, managed owner/admin/native identity denials, capture revocation and owner-lock wait revocation/expiry, postcommit authority uncertainty, encrypted history/AAD guards, restart/key rotation/missing-key/retirement and DELETE receipts, actual escape-heavy transport bounds and version quotas. Five hundred saves reach the1000-record owner limit, further creation is refused, and all500 drafts can be tombstoned using exactly500 additional records.

The broader isolated PostgreSQL race selection covering drafts, key lifecycle, PR diff/workspace/review and RPC paths passes130.987s. Combined main035+036 draft/key/publication race coverage passes80.355s; its actual034→latest fixture passes2.295s after old-schema seed data is created before constructing the latest runtime after upgrade. All Go packages, Go vet, TypeScript, buf lint, generated Go/TypeScript comparison, SQLC drift and whitespace checks pass. The reused parser bytes match the separately integrated035 parser exactly. Test database schemas are disposable; these checks do not write the ordinary Golf/forge databases. No native publication or shared repository activity is emitted by this packet.

These are backend source/real-SQL results with supported-provider test doubles; they do not qualify actual native/provider routing, served browser interactions, the Cloudflare track, latest-schema recovery, native inline publication or complete IR-2 UI acceptance. At that original backend checkpoint, separate UI and actual served/native qualification was still required. The final bounded replacement-image proof below supersedes that pending status without extending recovery/publication guarantees.

The concise [private-draft backend contract](PULL_REVIEW_DRAFT_CONTRACT.md) records integrated behavior, refusal/uncertainty semantics, evidence and the remaining served/native/UI gates.

## Current combined source/runtime boundary

The final combined source includes browser spaced-path parser correction `cf90c40a5fed6aa1605fba5e1764fe4e41352af1`, with unchanged API schema digest. A genuine native spaced filename had been parsed incorrectly in the UI, hiding eligible private-draft line controls; the shared renderer now retains its literal path. The focused 35 parser/private-draft browser cases pass 44.1 seconds and TypeScript passes. The preceding deployed trial passed six Code captures and four ordinary draft-workspace captures, but its spaced-file private-draft run failed; those observations are historical and do not constitute complete final qualification.

The replacement is deployed locally on Golf image `sha256:af5d1116be903514b91374b2cc9deae2d98bc9743e3fc47465b5dc2b46403647` (OCI config `sha256:b0f07bf22cdbe47dc3940bf197ce28e98cf0c4647d7800274481b7993864fd0e`). Worker is `sha256:2a001aea3fff1c2f24ab6234a14db65f1c66dcea4ee6013cf3cb6e1e20da4a3a`; runner remains `sha256:3d4f34ae307ab5f01c710c342597217dd986b0ff73a37fcd509e5b4ddd8dbbb3`. Deployment exits 0, database/forge readiness passes, queues are empty and schema 036 is applied. Actual replacement-image qualification now passes, as recorded below; the 14 captures retain this exact image identity and do not relabel earlier screenshots.

This qualification remains SQL-only private Golf draft work; it does not enable native inline publication, PENDING mutation, replies/resolution or protected merge. Latest-schema036 recovery remains open.

Final actual served/native qualification exits 0 on the unchanged replacement image before/after the run (`.tmp/private-review-drafts-final-qualified.log`). It verifies exact native tag-object/peeled-commit identities and observed totals, selected-snapshot latest-commit receipts, wrong-ID/current-authority/privacy denials, retained comparison, version CAS, target-generation delete/recreate fencing and exact operation replay. Actual spaced/Unicode path Add/Edit/Save/Reopen succeeds with the literal native path and empty terminal TAB delimiter. No native review or shared repository activity is emitted by private drafts. The API checkpoint before subsequent browser edits contains two draft identities, five versions and seven encrypted content records; these are not final retained counts after browser saves.

Fourteen actual Code, ordinary workspace and private-draft viewport captures accompany the checks. Root visually inspected Code at 1920/390px and the private workspace at 390px. The 1920px Code workspace measures 1440px wide at x240, with desktop 41px and mobile approximately 72.5px source rows. On the plain 390px Files changed capture, the toolbar is 235px high and starts around y528, with first code around y901 in a 900px-tall viewport; patch content remains below the fold, so further shared density refinement stays open. The desktop toolbar is 49px high around y382, with first code around y561. Native actors/repositories are purged, temporary sessions/bearers revoked and Golf fixture accounts disabled. Encrypted Golf draft history remains retained by design rather than being directly deleted.

The final renderer change passes 79 affected commit/compare/PR browser cases in 1.1 minutes and 35 parser/private-draft cases in 44.1 seconds with TypeScript checks. This bounded Docker/native/browser evidence supersedes earlier source-only/pending 036 statements; earlier 034/image/gallery proofs retain their original scope. It does not establish full 514-case rerun, genuine network byte-boundary/SQL acknowledgement-loss behavior, backend-restart/two-device browser qualification, Cloudflare execution or latest-schema 036 recovery. Discarded-response-body status inspection is narrower than a real commit/network-loss drill. Native IR-3 publication, protected merge/P0.8 and canonical URL/native feature gaps remain open.
