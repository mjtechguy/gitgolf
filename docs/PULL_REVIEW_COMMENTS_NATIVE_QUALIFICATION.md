# Native inline review comments qualification

Qualified on 2026-10-03 in an earlier native qualification on a since-retired backend; it has not been repeated on Forgejo 15.0.9. Forgejo inherits the relevant code, but the observations below are not Forgejo results. This document characterizes native behavior for Golf's generated review-comment reads and later inline authoring. It does not qualify a Golf read endpoint, review-comment UI, journaled inline publication, complete threads or protected merge authority. The [overall review contract](PULL_REVIEW_MUTATION_CONTRACT.md) and [earlier native review qualification](PULL_REVIEW_NATIVE_QUALIFICATION.md) remain separate.

Run while primary deployment and other native qualification are stopped:

```sh
python3 scripts/pull-review-comments-native-probe.py
```

The [probe](../scripts/pull-review-comments-native-probe.py) asserts the supported native version, creates five ordinary disposable actors and one private repository, and uses supported collaborator/content/branch/PR/review/reply/resolve APIs. Administrator CLI use is limited to account/token setup and account removal. No native database/repository/ref writes, merge, workflows, inference or remote organization writes occur. Credentials remain in memory; failures withhold private payloads. Final native run exited 0 and all fixture users/repositories were purged. Local ignored transcript: `.tmp/pull-review-comments-native-probe.log`.

## Endpoint shape and ordering

`GET /api/v1/repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments` returns one complete native JSON array. It has no native paging or count/Link response headers. The actual fixture creates 53 comments and observes the same 53 IDs with no query, `limit=1&page=1`, `limit=1&page=2` and `limit=100&page=9999`, despite the instance's API maximum 50. Treat query pagination as ignored. This differs from the parent review list's clamped, hidden-row pagination.

The upstream [handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/pull_review.go) checks the review's PR identity and current pending-review visibility. The [converter](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/convert/pull_review.go) flattens native maps; their iteration is not a presentation-order guarantee. Golf should bound the entire response before exposing it and sort deterministically, for example by creation time/ID. A Golf 100-comment cap is a Golf policy, not a native page or limit; exceeding it must produce an honest bound error rather than a false complete list.

## Exact observed wire fields

The fixture checks the following 15-field set, types, author/review IDs, URLs, timestamps and side values. [Upstream structs](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/structs/pull_review.go).

| Native field | Meaning / observed value |
| --- | --- |
| `id` |Positive signed64-bit native comment ID|
| `body` |Raw Markdown text; 8KiB and empty inline bodies both accepted/preserved|
| `user` |Native author object; normal fixture actor ID/login|
| `resolver` |Null when unmarked; resolver user object when marked, including deleted-user ghost ID -1|
| `pull_request_review_id` |Owning native review ID, shared by original comments and replies|
| `created_at`, `updated_at` |RFC3339 native timestamps|
| `path` |Literal repository file path; Unicode/glob-like path preserved|
| `commit_id` |Native line-blame/comment commit, not necessarily the review's selected head|
| `original_commit_id` |Native stored old reference; empty in all API-created fixture comments|
| `diff_hunk` |Native retained context text; some fixture values begin `@@`; may be empty|
| `position` |Unsigned64-bit **new-side file line**, zero for an old-side comment|
| `original_position` |Unsigned64-bit **old-side file line**, zero for a new-side comment|
| `html_url` |Native PR URL plus `#issuecomment-ID`; own pending comment uses `/files#issuecomment-ID`|
| `pull_request_url` |Exact native PR URL|

`original_position` is the old side, **not** an earlier location of a moved new-side comment. These are file line numbers, not unified-diff row offsets. A request containing both positive side inputs selects old-side precedence in the native handler; it does not represent a multiline range. The response has neither parent-comment ID nor explicit `outdated`, current relocated line, range, or resolved boolean.

A new-side comment on an unchanged line independently returns the baseline line-blame commit, while its owning review records the later selected head. Do not require child `commit_id == review.commit_id`, overwrite the child value with the head, or infer a complete immutable diff from that value. Valid observed API-created child IDs are full SHA strings; legacy/imported absent or original-reference variants require separate qualification rather than invented values. The fixture does not establish native maximum body, comment-count or response-byte limits. Choose explicit Golf bounds independently.

## Publication, replies and permissions

Initial inline publication uses `POST /pulls/{number}/reviews` with selected `commit_id`, event/summary and `comments:[{path,body,old_position,new_position}]`. The fixture observes new-side 1, old-side 1, unchanged new-side 2 and an unchanged Unicode path. Independent comment reads exactly match those bodies/locations and the returned review count.

`POST /pulls/{number}/comments/{comment_id}/replies` with `{body}` returns 201. A read-role fixture actor can reply using a write-repository-scoped token. The result retains the parent review/path/side line, with the replying actor and its own new comment ID. Reading the review then returns five comments instead of four; parent `comments_count` includes replies. Wrong PR, private outsider, read-only token and empty reply body are respectively refused 404/404/403/422. The reply receipt has no parent ID; grouping comments by review/path/side/line is a presentation location, not an exact reconstructed reply graph.

Another ordinary owner, PR author or reader receives 404 for the review author's PENDING comments. The author can read their own pending array. However, a reader **who knows a pending parent comment ID** can receive 201 from the reply endpoint and append a reply to that hidden pending review, while subsequent GET still returns 404. The actual fixture proves this distinction. Golf must separately authorize visibility of the owning parent review before any reply; native reply admission alone does not establish pending-draft privacy. This qualification does not show how an actor might discover an otherwise hidden ID.

## Resolution and deleted actors

Resolution uses `POST /pulls/comments/{comment_id}/resolve` or `/unresolve` and returns 204. The actual reader is refused 403; the PR author resolves the parent and a writer reopens it. Independent reads show the marked parent's resolver, while its same-line reply remains null. The upstream [model](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/models/issues/review.go) updates the addressed comment rather than every inferred thread row. Do not promote one marked location to “entire thread resolved.”

After marking the parent and purging that disposable resolver account, the native read keeps a **nonnull ghost resolver object with ID -1**. Golf's optional known-user mapping may drop ghost identity, but must retain a separate per-comment resolved observation derived from raw resolver presence. Otherwise an actually marked comment falsely becomes unresolved. This is current native metadata, not proof that a required protected conversation policy is satisfied.

## Retained context and snapshot navigation

The fixture advances the PR head, renames the reviewed file using the supported content API, then deletes it. All original comments remain readable by the same IDs, with original body/path/old/new lines/blame commit/empty original commit/hunk preserved byte-for-byte. The endpoint does not relocate them or expose native invalidation/outdated state. [Upstream comment loading](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/models/issues/comment_code.go) includes a specific review's retained comments.

An old-side line with empty `original_commit_id` has no established original base object in this receipt. Do not link it to today's PR base or to the reviewed head's deleted/changed line. Show the retained old/new-side context and add snapshot navigation only when the corresponding exact base/head selection is independently known. A current PR-head observation can label an earlier review snapshot; it cannot turn the old location into a current line.

## Golf adapter and later write requirements

For the initial read, bind native repository/PR/review IDs and the caller-selected reviewed commit. Validate the whole bounded array: unique positive IDs, exact owning review/PR URL, safe literal paths, one valid positive side, raw text/hunk byte ceilings, timestamps, supported commit representations and optional native user/ghost metadata. Preserve an independent `resolved` observation before dropping unavailable resolver identity. Recheck current caller/repository/PR/review observations and count around the read; those observations do not lock comment body/resolution edits that leave the count unchanged. Do not claim atomic threads or missing native fields.

For later batched human inline writes, freeze exact per-comment literal path/side/line/body against the selected diff; preflight existing own pending drafts; reserve one durable intent before native dispatch. Independently compare review and full comment receipts before acknowledging the intended batch. The native handler creates code comments before calling SubmitReview rather than wrapping the entire request in one transaction. Failed later work may leave partial pending state; the probe does not induce every such failure. Never blindly repost or consume an unknown/preexisting draft. Native context/blame can differ from the selected review head, and pre/post reads are not a head/session/pending-write fence. The [protected design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md), full inline lifecycle and schema 034 recovery remain unresolved separate gates.

Initial probe attempts failed because the harness assumed resolver propagation to every same-line row. The final assertion checks actual per-comment marking instead, verifies ghost presence and preserves unchanged context through rename/deletion. Product/native behavior was not altered to satisfy the harness. Golf generated read/UI qualification, lost/partial inline-write responses, exact thread ancestry, native invalidation exposure and broader batch/scale/fork/cancellation/recovery cases remain required.
