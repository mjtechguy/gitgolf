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

Source/isolated host PostgreSQL tests currently exercise native draft
create/update/submit/discard and comment edit/delete, terminal replay after target
deletion, withheld plaintext, lost response no-resend, overlapping unknown refusal,
stale revision, hidden pending, self-approval, body and repository rebinding.
Native and browser qualification are pending until their source-bound receipts
are recorded. Full GitHub/Gitea parity and P0.8 remain open.
