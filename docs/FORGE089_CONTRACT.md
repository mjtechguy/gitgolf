# Everyday forge consumers089

This adds bounded consumers to deployed084 review authoring and076 web files.
Gitea1.27.3 supported APIs remain the only forge write/read boundary. No new
service, Docker capacity, repository CI or provider/model execution is required.

## One native batch commit and rename

`RepositoryFileBatchService` accepts 1–20 create/update/delete changes with a
256-KiB aggregate content ceiling. Rename is an update with a distinct original
`from_path`, original blob SHA, and positively absent destination. Source and
destination paths cannot overlap, repeat, replace another change's ancestor or
address Git metadata. Existing bounded file authority, native ordinary writer
branch projection and protection dispatch fences are reused. Protected, mirrored,
archived and empty repositories remain unavailable.

The supported native `POST /repos/{owner}/{repo}/contents` receives one ordered
batch. Independent original-head/blob/absent-destination checks precede dispatch.
Success requires an exact new one-parent commit whose parent equals the observed
original head and exact path/blob-byte/deletion/rename readback at its current
branch. These are observations, **not native expected-head CAS**. Independent
native web/API/SSH writes remain outside the Golf transaction.

Migration089 extends the existing immutable file journal with `batch_original`.
It retains complete repository/actor/access/head/path/blob identities and per-file
content hashes plus commit-message hash, without new file/message plaintext.
Caller UUIDs bind immutable originals; exact replay and inspection read the
original outcome and never resend. Lost responses, wrong commit parents, ignored
changes, partial effects, authority loss or drift retain `DISPATCH_UNKNOWN` and
block overlapping source/lifecycle work. The existing lifecycle permit checks the
persisted original, exact native route, full payload hashes and sole active
repository operation. A qualified file success appends one shared `source`
invalidation in the same SQL transition; refusal, unknown and replay append none.
This is repository live invalidation, not a claim of email or inbox fanout.

The requested TanStack editor stages explicit text changes, then previews the
single batch before commit. It supports plain UTF-8 files initially; binary
single-file upload retains its existing separate control. New tab originals
contain hashes/identities only. Account changes and denied current authority
clear volatile editors and withhold writes; unknown originals remain inspectable.

## Append saved inline comments to an own native pending review

Authoring kind8 (`APPEND_FROM_PRIVATE_DRAFT`) binds the exact existing own review,
review commit, complete current review snapshot, current pull revision and exact
saved encrypted Golf draft ID/version/generation. It requires current valid
head/base/diff coordinates, a bounded nonempty native summary, and at most100
resulting inline comments. The saved draft's original source/base/head/raw diff
must still match independently. Pending activity may advance the PR timestamp;
this permits a fresh revision observation of the **same** comparison, without
changing or rebasing the saved draft.

The same supported native review POST appends the exact saved comments while
preserving the independently observed native summary. Postflight verifies every
retained original child ID/body/author/coordinate/context, exact new child
multiplicity and comparison, unchanged header identity/commit, and exact resulting
native review. Golf draft content/version remains unchanged. Existing084 immutable
intent, session/Origin isolation, native privacy, domain exclusion, recipient-only
pending invalidation and original unknown/no-resend behavior apply.

Changed-head rebasing, ranged coordinates/multiline application suggestions,
apply-as-commit, complete external thread ancestry and protected approval
eligibility remain unavailable. Pinned native REST coordinates are single-line;
its batch file API does not establish the expected-head CAS needed for automatic
suggestion commits.

## Current discussion attachment inventory and bytes

`DiscussionAttachmentService` reads a current issue, pull-request discussion body,
or ordinary comment through exact repository/underlying issue/comment identities.
A native PR ID is not silently substituted for its underlying discussion issue
ID. Wrong association is refused. Native collection and exact metadata APIs
supply numeric ID/UUID/name/size/created identity; duplicate/malformed rows and
collections over100 refuse. Download-count increments are not content identity.

Downloads are mediated through the fixed native `/attachments/{verified UUID}`
route with the caller's existing native credential and no cookie. Provider URLs,
redirects, signed storage links and credentials never leave the server. Exact
association, metadata revision, native size and current read permission are
rechecked after waits. At most10 MiB is returned as bytes with SHA-256; the browser
checks target, metadata, size and digest before offering an octet-stream download.
Attachments are never automatically opened as active HTML/media.

Issue, PR discussion and ordinary-comment disclosures use current authorized
inventories and the shared DataTable. Their reads start when the user opens the
attachment disclosure. Native pending code-review comments remain outside the
ordinary-comment contract. Creation/replacement/deletion, wiki assets, streaming
large downloads and complete notification attachment fanout remain unimplemented.

## Supported history and notification limits

The existing exact-snapshot, literal-path commit history and Source Actions
`File history` control already provide the supported history alternative. Pinned
native REST has no blame endpoint; no fabricated per-line attribution is added.
Current own issue/PR native inbox and original mark-read remain unchanged. This
slice's source/live invalidation does not complete wider issue/PR email fanout,
all native notification types/preferences/unread counts or multichannel delivery.
Those remain separate acceptance criteria.

## Root integration and checks

Generate the canonical API plus `api/golf/v1/forge089.proto` normally. Register
`NewRepositoryFileBatchServiceHandler` and `NewDiscussionAttachmentServiceHandler`
with the existing browser interceptors and add their four procedures to the
managed browser boundary. Batch submission needs the existing384-KiB outer request
cap; downloads fit the existing16-MiB response cap. Do not add delegated bearer
write/read grants merely because handlers exist. Include `golf.file-batch.v1:` in
account-change tab-storage cleanup. No new credentials require recovery quarantine.

The source worktree uses a temporary exact root RPC registration/boundary patch
for production-handler qualification; root owns its final integration. Native
attempt5 passed in72.170s with every owned actor/repository/organization purged and
zero Docker resources. It covers retained summary/children append, native batch
create/rename/update/delete, exact replay/stale refusal, underlying-issue attachment
identity/bytes and wrong association. Attempts1–4 remain failed with owned cleanup;
1 exposed saved timestamp recapture,2–3 lacked qualifier Origin,4 supplied a PR ID
instead of its underlying discussion issue ID. None was relabeled as a pass.

Local runnable checks:

```sh
GOLF_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable \
 go test -race -p 1 ./internal/server \
 -run '^(TestFileBatch|TestDiscussionAttachment|TestReviewAppend|TestReviewAuthoring.*Postgres|TestFileMutation.*Postgres)' -count=1
npm --prefix web test -- --config playwright.forge089.config.ts
npm --prefix web run build
bin/tools/buf lint
GOLF_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable \
 python3 scripts/forge089-native-proof.py --stack-root ../golf-git --output .tmp/forge089-native-proof
```

The focused integrated PostgreSQL/race command passed in47.497s. The29 browser
cases passed in15.0s, including the existing084 and single-file regressions.
Mobile390 dark/light batch captures were inspected; typecheck/build and API lint
pass. Source tests additionally cover malformed/overlapping batches, immutable
hash-only metadata, lost/ignored/wrong-parent outcomes, unresolved exclusion,
current permission/stale/association refusal, redirect/size/byte boundaries and
late revocation. Actual native contributor batch, ordinary-comment attachments,
attachment revocation/restart, wider roles and served integrated UI still require
their own qualified evidence; a native owner batch does not verify every role.
