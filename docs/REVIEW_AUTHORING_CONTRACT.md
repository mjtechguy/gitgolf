# Native review authoring (084)

This adds `PullReviewAuthoringService` alongside the existing private Golf draft,
public batch review, reply/resolution and dismissal contracts. It does not enable
protected merge or establish an atomic native expected-head compare-and-swap.

## Supported workflows

- Read only the caller's complete native pending review, or an exact visible
  published review and its bounded complete inline collection.
- Create a summary draft; transfer an exact encrypted saved Golf draft version
  into a native pending inline review; update its summary; publish it as COMMENT,
  APPROVED or REQUEST_CHANGES; discard it. Transfer retains the separate Golf
  draft. Decisions other than COMMENT refuse self-review.
- Edit/delete a selected inline comment using native issue-comment API writes.
  Independent receipt verification uses the visible review collection because
  the native issue-comment GET returns 204 for code comments.
- Display reply parents only from successful Golf reply receipts with both IDs,
  author and exact native review/path/side visible. External ancestry is unknown.

Native PENDING requires a nonempty summary: pinned1.27.3 returned HTTP422 for
empty pending headers, including inline batches. Golf withholds that shape before
dispatch. Empty APPROVED submission is supported; COMMENT and REQUEST_CHANGES
require a summary. PR authors may prepare pending comments and submit COMMENT;
approval/change-request self-review remains refused.

Draft submit requires the current header head and every retained native inline
hunk to match the current bounded comparison. A header rebound by a native client
cannot alone authorize publishing old inline contexts. Rename/deleted coordinates
remain outside the existing qualified inline writer.

## Intent, isolation and uncertainty

Each caller-owned UUID has immutable repository/PR/review/comment identities,
original pull and complete review revisions, decision and body SHA-256 (or exact
saved encrypted draft version/generation). The 084 journal never stores new body
plaintext. Requests retain volatile body only for first dispatch. RESERVED and
DISPATCH_UNKNOWN fence overlapping Golf mutations through the existing exclusive
repository lifecycle locks. Originals/events cannot be rewritten or deleted.

Replay reads the original outcome, including after discard/delete. It does not
require deleted native objects to exist. It requires the same caller and current
repository read authority. It never resends, adopts an independently found review,
rebinds a version or reconciles an unknown effect. Unexpected provider status,
receipt/collection mismatch, concurrent source change, visibility loss, partial
batch or lost response remains DISPATCH_UNKNOWN.

Native pending-to-published conversion changes review/comment presentation URLs.
Both comment observations independently validate their exact repository/PR/ID
URL binding. Publication permits that presentation change while preserving all
other retained child fields, authors, bodies, coordinates and multiplicity. The
issue-comment PATCH receipt can have an unloaded poster; authority and canonical
author are proved through independent complete native review collections.

Qualified outcomes append the existing durable `pulls` invalidation once in the
same Golf transaction as SUCCEEDED. Pending operations and pending inline edits
are recipient-only; publication and published edits are shared. Unknown, refusal
and replay do not signal unverified or duplicated activity. The authoring query
uses the existing repository/pull live namespace and refuses stale UI proposals.

Native submit selects the current head itself. Golf performs repeated before/after
observations and exact receipt checks; these are not an every-ingress fence. Native
web/API/SSH writers remain outside an atomic Golf transaction. Suggestion apply,
protected approvals/merge queues and complete external thread ancestry are not
qualified by this contract.

## Root integration hooks

Register `NewPullReviewAuthoringServiceHandler` with the same browser-cookie
interceptors as review request service. Authoring RPCs are not delegated bearer
writes. The server also enforces exact Origin and current managed session.

Before any own lifecycle permit, block foreign unresolved rows in
`golf_pull_review_authoring_operations`. Accept the own permit only through
`reviewAuthoringPermitKey` / `reviewAuthoringPermit` and
`validateReviewAuthoringPermit(ctx, tx, permit, repo, key, method, path, input)`.
The validator checks the exact native route/method/payload, unchanged persisted
fingerprint and DISPATCH_UNKNOWN phase, every predecessor lifecycle blocker,
foreign authoring rows and standard merges. Apply root083 protection dispatch
fence before reservation/dispatch too. Include the authoring prefix
`golf.review-authoring.v1:` in account-change tab-storage cleanup.

Migration084 wraps whichever active/blocked predecessor functions are installed;
no native schema/files are changed. Generate protobuf/Connect/web output normally.

## Qualification

At source `17c2874e130a4bbedec572b24eaf1afd893e02cb`, actual production
HTTP handlers against pinned native 1.27.3 passed in 59.902s. The disposable launcher
created ordinary owned actors, one private organization/repository and native
review changes through supported APIs, then purged every owned fixture and logged
out temporary Golf sessions. No runtime restart, new Docker resources, workflow
execution, model usage or provider deployment was involved.

The native proof covers pending create/update/submit/discard; exact encrypted
saved inline transfer with the Golf draft preserved; pending and published inline
edit/delete; COMMENT, APPROVED (including empty summary) and REQUEST_CHANGES;
PR author pending inline COMMENT; terminal original replay after deletion;
withheld empty PENDING; and native owner's hidden-pending denial.

Local command:

```sh
GOLF_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable \
python3 scripts/pull-review-authoring-native-proof.py \
  --stack-root ../golf-git --output .tmp/review084-native-proof
```

Host PostgreSQL/race review suites passed in 33.270s: lifecycle, inline edit/delete,
privacy, stale/body/repository/self-review refusals, unknown no-resend and domain
exclusion, immutable originals/events, terminal replay, qualified reply ancestry,
and recipient-only versus shared activity without duplicate replay signals.
The 70 serialized browser tests passed in 1.1 minutes. Browser qualification
includes requested native draft/inline editors, explicit
confirmation, exact saved-version transfer, unknown reload/inspection, account
switch clearing, unsupported empty-draft withholding and empty approval, suggestion
copy, and dark/light 390px controls. Fixture HTML cleanup must not cause Vite HMR
reloads in other concurrent fixture pages; run serialized or disable HMR for this
isolated browser qualifier.

Remaining acceptance criteria: native pending append/rebase and multi-line/ranged
suggestions; automatic suggestion commits with native expected-head CAS; complete
external ancestry/thread resolution; protected approval eligibility, merge queues
and every-ingress fences. Those are not verified by this slice. Full GitHub/Gitea
parity and P0.8 remain open.
