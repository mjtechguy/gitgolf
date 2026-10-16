# Native human pull-request review qualification

Qualified on 2026-10-03 in an earlier native qualification on a since-retired backend, with Golf image `sha256:3a54e7c9af7577811f6839f49be4a805cccc911bd2762ae48804d4b173eb74ef` running; it has not been repeated on Forgejo 15.0.9. The observed results below are from that backend; the linked pinned source is Forgejo 15.0.9, which inherits this code but has not been re-qualified. This is supported native API characterization for implementing Golf human reviews. It does not qualify a Golf review mutation, UI, protected approval, merge authority, or latest-schema recovery.

Run locally while deployment is stable:

```sh
python3 scripts/pull-review-native-probe.py
```

The [probe](../scripts/pull-review-native-probe.py) creates five disposable ordinary actors and one private repository. Native administrator CLI use is limited to creating/removing those accounts and generating their tokens. Repository, collaborator, content, PR, review and fixture merge operations use supported native APIs under ordinary actor credentials. One unprotected fixture PR is merged solely to observe review behavior after merge. It runs no workflow or inference and does not touch retained repositories or remote organizations. Credentials remain in memory; failures omit provider payloads. All fixtures are purged in `finally`.

## Native request and receipts

`POST /api/v1/repos/{owner}/{repo}/pulls/{number}/reviews` returns HTTP200 with a review. Submit a selected full `commit_id`, exact `body`, and one of `COMMENT`, `APPROVED`, or `REQUEST_CHANGES`. Inline comments use `{path, body, old_position, new_position}`; these positions are old/new **file line numbers**, not unified-diff row offsets. A positive old position selects the old side. The [pinned structs](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/structs/pull_review.go) define the wire contract.

The [pinned handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/pull_review.go) and [service](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/pull/review.go) are essential context: an omitted commit uses the retained current head; an explicit commit is not an expected-head compare-and-swap. Submitting an existing pending review through `/reviews/{id}` instead selects the current head. The adapter must not silently use that endpoint for an exact frozen snapshot.

Every successful probe write independently rereads `/reviews/{id}` using a read-scoped token and compares ID, state, body, commit and comment count. It validates positive IDs, exact actor ID/login and parseable submitted/updated timestamps. Native fields also include `stale`, `official` and `dismissed`; they are provider observations, not Golf protected-policy proof. [Pinned conversion](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/convert/pull_review.go).

## Observed acceptance matrix

| Case | Actual native result |
| --- | --- |
| Author submits body-bearing COMMENT |200 with exact receipt/readback|
| Author approves or requests changes on own PR |422|
| Non-author empty APPROVED |200; empty body preserved|
| COMMENT or REQUEST_CHANGES with whitespace-only body and no inline comments |422|
| Writer approves / requests changes |200, `official=true` without a protected rule|
| Reader approves |200, `official=false`; read permission is sufficient for the native review route|
| Reader requests changes |200; accepted under read permission|
| New writer decision after an earlier approval |Earlier approval independently rereads `official=false`|
| Outsider on private repository |404|
| Read-only repository token used for review POST |403|
| Draft PR receives approval / change request |200|
| Closed or merged PR receives body-bearing COMMENT |200|
| Closed or merged PR receives approval / change request |422|
| PR head advances, then review supplies original full SHA |Both events retain that SHA; APPROVED reports `stale=true`, COMMENT reports `stale=false`|
| COMMENT supplies nonexistent `ffffffffffffffffffffffffffffffffffffffff` commit |200; native receipt stores it unchanged|
| Unknown event with body |200, becomes PENDING|
| Same COMMENT body/commit submitted twice |Two distinct native review IDs|

The branch-advance case proves acceptance of an explicitly older snapshot; it does not simulate every in-flight head or permission race. Golf must validate the selected repository/PR/commit itself. COMMENT's native `stale=false` does not establish current-head freshness. Reader approvals must not be displayed as trusted merge authorization.

## Pending drafts, hidden pagination and side effects

The probe creates a pending review with two real inline drafts: new-side line1 and old-side line1. Their independent comment receipts report `(position, original_position)` as `(1,0)` and `(0,1)`, respectively, with exact path, reviewer ID and review ID. A later body-only COMMENT POST, with **no `comments` field**, submits those drafts too: it reuses the pending review ID and returns `comments_count=2`. The [pinned model](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/models/issues/review.go) reuses the actor's current pending review. Omitting comments cannot guarantee a body-only mutation.

A subsequent real pagination test puts another actor's hidden pending review before the caller's pending review. With `limit=1`, the caller receives an empty visible page **before** a later page containing their own pending review. `X-Total-Count` includes hidden drafts. Iterate all bounded pages implied by validated native total/page span, including empty visible pages; stopping on `len(rows)==0` would miss a submission hazard. The converter filters another user's pending reviews after native pagination.

For an initial Golf body-only submission, reject an observed current-actor pending review before dispatch. Validate zero native comment count in both write receipt and independent readback. A concurrently created pending draft can still be absorbed between preflight and native POST; a nonzero count must not produce a clean body-only success. Retain a typed uncertain outcome, avoid automatic replay, and expose the native review evidence for reconciliation. Preflight is not an atomic fence. More complete inline-review workflows remain required.

## Evidence and limits

The final run exited0 and printed eight PASS groups plus fixture purge. Local ignored transcript: `.tmp/pull-review-native-probe.log`. Supported retained-head reads settle each new PR before writes. An initial run failed in the combined draft/closed/merged stage; its fixtures were purged and that failure was not precisely attributed. The helper now waits for each supported retained ref instead of assuming hook completion or replaying failed review writes. The complete extended run passes with that explicit observation boundary.

This qualification does not demonstrate automatic native cancellation after Golf session revocation, a lock against concurrent pending drafts/head changes, exactly-once dispatch across an unknown transport outcome, protection eligibility under changing rules, inline thread reply/resolution/dismissal, browser rendering, API delegation, or recovery of Golf mutation records. Those require separate runnable Golf proofs. [Protected merge design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md) remains proposed and P0.8 remains unresolved.
