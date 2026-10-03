# Private PR review drafts — IR-2 backend contract

Source packet `9f51f5f`, prepared2026-10-03. **Backend source, real PostgreSQL tests and the final served/native browser qualification cover the bounded private Golf working-collection slice. Schema036 recovery and native review publication remain unqualified.** This applies to both infrastructure tracks with AI/Cloudflare optional. The [wire proposal and implementation details](INLINE_REVIEW_DRAFT_API_PROPOSAL.md) now match the generated contract. The broader [inline review design](INLINE_REVIEW_IMPLEMENTATION_DESIGN.md) remains required.

## Scope and current authority

A private Golf draft is an owner-scoped, encrypted working collection tied to one immutable comparison. It is not a native PENDING review, publication, approval, request for changes, resolution or merge permission. These endpoints issue supported provider reads only. They do not emit shared repository activity or execute inference/workflows.

| RPC | Result / required intent |
| --- | --- |
| `GetPullRequestReviewDraft` | Current owner's active draft discovery; or exact owned draft/tombstone and optional operation receipt. Operation lookup requires the original draft UUID. Never resumes a write. |
| `SavePullRequestReviewDraft` | Explicit UUIDs, expected draft version and target generation, bounded complete summary/entries. Version0 requires first capture; later versions require the immutable comparison UUID. |
| `DeletePullRequestReviewDraft` | Exact owned UUID, current positive version and target generation, fresh operation UUID. Commits an immutable tombstone, without native deletion or erasing retained verification evidence. |

All three require a managed Golf session, the exact configured Origin and current provider actor/native target access. PAT/bearer API delegation is denied by the existing procedure allowlist, including private Get. Instance administration grants no read/edit override. Request identities have no user selector. Authorization precedes receipt disclosure; native repository/PR IDs, number and current routing authority are independently rechecked around provider waits. Expired/revoked callers are revalidated after managed owner/session lock waits.

Current names locate the target; immutable IDs identify it. After an authorized rename, the returned active draft uses the current route while its original capture and accepted receipts retain their earlier routes. A replacement repository/PR at an old name/number cannot inherit draft content. The retained comparison creates no general private-fork source credentials. These checks are bounded observations, not an atomic native permission/ref lock.

## Comparison and coordinates

First Save requires the exact displayed revision, native IDs, target branch tip B, actual merge base M, head H and SHA-256 of the complete displayed diff. The server independently reads retained-head-bound native bytes and validates that capture. It retains its own byte count and encrypted original comparison; client source/parser output is never authoritative. A drifted capture is refused without choosing another comparison.

Later edits and reopen use that same retained M→H context even after native head/base movement. Current target access remains mandatory. Original M, branch tip B, head H and line/blame identities remain distinct. A missing current head is not proof that retained coordinates describe today's files.

The shared strict035 parser provides original file/hunk inventory indices and exact literal OLD/NEW side paths/positive line numbers. Context rows support an explicit side. Only one entry per exact side/coordinate and unique entry UUIDs are allowed. Malformed, overlapping, missing-side, binary/submodule/metadata-only and unsupported hunk coordinates are denied. The bounded SQL-only inventory can retain valid rename old/new coordinates; this does **not** qualify future native rename publication. CR/control, long scanner rows and oversized native-context hunks remain conservatively unavailable. Multiline, whole-file, suggestions, remapping and native replies/resolution are separate packets.

## Atomic local intent and uncertainty

Migration036 adds only Golf-owned tables: retained owner/native target generation slots, draft identities/current pointers, immutable operation/version receipts, and encrypted comparison/intent contents. Deferred version references prevent a committed draft without its matching current version. SQL guards prohibit identity replacement, generation reset, history mutation and deleted UUID resurrection. Ciphertext/key-label changes are restricted to the existing rotation path; content identity/binding stays immutable.

Each accepted Save/Delete increments both draft version and target generation exactly once in the owner-locked transaction. Target generation never resets after Delete or a new UUID. A delayed generation0 capture cannot create after save/delete/recreate. Get never creates a generation slot; never-existing discovery returns generation0, while a previously used empty target retains its positive generation. Versions/generations are explicit canonical signed64 decimal strings; missing values are not zero.

A globally owner-scoped operation UUID binds kind, exact typed ordered intent, text, target, draft, expected version and generation. Identical replay returns the original accepted receipt with independently current version/state; it adds no version. Changed input under the same operation UUID fails. Historical accepted version/generation does not imply current contents. Deleted responses omit summary, entries and comparison bytes, even when inspecting a historical Save receipt.

`ABORTED` represents a rolled-back CAS refusal. Known precommit capture/quota/CAS and final-handler input refusals additionally carry `Golf-Draft-Effect: none`. Changed accepted-intent conflicts preserve the original receipt and receive no such assertion. Missing receipt while another request can still run, browser abort, transport loss and SQL commit failure do not prove zero effect. After a local commit, failed native identity revalidation returns `UNAVAILABLE` without private contents or no-effect metadata; permission/session failure also withholds contents. Exact operation lookup after authority restoration can recover the durable receipt. No timer or automatic write retry manufactures success.

## Encryption, bounds and retention

The deliberate `review_content` AEAD domain protects original diff, paths, bodies, summaries and typed replay-verification input. Associated data binds record kind/ID, key label, managed owner, forge/native target, draft and version. Startup required-key checks, label bootstrap, usage, bounded rotation and retirement include active and historical SAVE/DELETE/comparison content. No private content enters logs, shared audits/events or browser storage. Latest-schema restore proof is still required; adding this encryption family does not qualify recovery.

The limits are20 entries;6000 UTF-8 bytes per summary/body;4096 per safe path;256KiB aggregate decoded working contents;512KiB/500 files/12,000 rows per original diff. Save transport is2MiB; Get/Delete retain16KiB; full draft responses are capped6MiB. Escaping and decompression do not bypass independent decoded/transport bounds.

Retention is100 Save versions per draft,1000 encrypted records/128MiB per owner,10,000 records/1GiB per instance. Creation consumes two records; edit/delete one. A transaction quota lock serializes the instance bound. Metadata-only Delete reserves500 records/8MiB per owner and5000 records/64MiB per instance so every active draft at the save ceiling can be tombstoned. Delete does not free history. No purge API is enabled; additional saves fail explicitly at the quota. A future purge must preserve nonreusable operation/tombstone identity and needs separate qualification.

## Evidence and remaining gates

All19 top-level private-draft tests/subcases pass against dedicated disposable PostgreSQL18.4 under `-race` in45.514s. Coverage includes current capture binding, literal side/inventory admission, concurrent CAS, exact typed order/text replay, lost acknowledgement lookup, delayed capture across delete/recreate, unchanged retained snapshots after pushes/rename, owner/admin/delegation/native identity denials, revocation during capture, owner-lock wait revoke/expiry, postcommit authority uncertainty, immutable/AAD guards, historic SAVE/DELETE encryption rotation/missing-key/retirement, actual escape-heavy transport bounds and version quotas. Five hundred creates reach1000 encrypted records; additional creation is refused; all500 tombstones succeed and use1500 total records. Provider test doubles assert zero native mutation requests and the actual SQL shared activity table remains empty.

Combined main035+036 draft/key/publication race coverage passes80.355s. The actual034→latest migration regression passes2.295s after seeding Golf-owned old-schema rows before constructing the latest runtime after the full upgrade; no product downgrade fallback is introduced. The earlier broader draft/key/diff/workspace/review/RPC race selection passes130.987s. All Go packages, Go vet, TypeScript, buf lint, generated Go/TypeScript comparison, SQLC drift and whitespace checks pass.

The source tests alone do not qualify native/provider, browser, Cloudflare, recovery or native inline writes. The subsequent bounded served/browser proof is recorded below; complete IR-2 acceptance still requires the remaining fault/restart/recovery and two-device qualification. Native once-only publication/nontransactional partial handling, PENDING lifecycle, visible-parent replies, per-comment resolve, richer coordinate modes and CLI/MCP write parity remain IR-3 onward. P0.8 protected merge and the full implementation plan remain open.


### Final bounded served qualification (2026-10-03)

Source `cf90c40a5fed6aa1605fba5e1764fe4e41352af1` (API/UI `44a9c78`, strict server delimiter `6a71470`, browser delimiter `cf90c40`) runs in actual Golf container image reference `sha256:af5d1116be903514b91374b2cc9deae2d98bc9743e3fc47465b5dc2b46403647`. `make qualify-pull-review-drafts-browser` passes against supported native1.27.3 with a spaced Unicode path and native empty terminal-TAB side-header delimiters. Both parsers preserve literal paths, source whitespace, raw bytes/digest and original coordinate indices; ambiguous/nonempty suffixes remain unavailable.

The actual served RPC/browser proof covers native M/B/H/diff capture, old/new single-line coordinates, save/reopen/edit CAS, exact status inspection after discarding a response body, replay/changed-intent refusal, retained historical capture, delete/recreate generation fencing, current owner/PAT/bearer/Origin/native-revoke denial, actual Add/Edit/Save/reopen and live browser native revocation. No shared draft activity or native review/comment is emitted. A metadata-only checkpoint before browser edits observes two draft rows, five versions and seven encrypted-content records without extracting private contents or ciphertext.

The same controlled runtime supplies fourteen actual PNG/text pairs: six Code-page branch/tag/snapshot cases at1280/1920/390px in both themes, four clean-context Files changed cases at1280/390px, and four private-draft cases at1280/390px. Native annotated tag object/peeled identities and observed total, exact selected-snapshot commit author/message and private permission checks are independently verified. Before/after Docker runtime identities match. Fixture native users/repositories are purged, their sessions/bearers revoked and managed Golf accounts disabled. Encrypted Golf draft/tombstone/account history intentionally remains retained.

The response-body discard does not qualify an actual byte-boundary transport or SQL acknowledgement fault. This run restarts no backend and does not establish complete two-device browser, Cloudflare, inference, workflow, native write or recovery behavior. Latest-schema036 recovery, P0.8 and IR-3 onward remain open. Final source browser checks add35 parser/private cases and79 shared commit/compare/PR cases; broader/source bounds remain documented above.
