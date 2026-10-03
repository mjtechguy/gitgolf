# Native inline-write snapshot and partial-state qualification

Qualified on 2026-10-03 against supported Gitea 1.27.3 APIs. This is native characterization for the next human inline-write increment, not qualification of a Golf writer, durable draft lifecycle, exact snapshot publication, atomic batch or protected merge. Existing [inline reads](PULL_REVIEW_COMMENTS_READ_CONTRACT.md), [native comment fields](PULL_REVIEW_COMMENTS_NATIVE_QUALIFICATION.md) and [overall human reviews](PULL_REVIEW_MUTATION_CONTRACT.md) retain their separate bounds and evidence.

Run while deployment and other native fixtures are stopped:

```sh
python3 scripts/pull-inline-write-native-probe.py
```

The [probe](../scripts/pull-inline-write-native-probe.py) creates five ordinary actors and one private repository. Administrator CLI use is limited to account/token setup and removal. Collaborator, contents, branch, PR, review, reply and resolution operations use supported REST APIs. No native database/repository/ref writes, merge, imported workflows, inference, remote push or Golf sessions occur. Final run exited 0; all fixture users/repository were purged. Ignored transcript: `.tmp/pull-inline-write-native-probe.log`. Fixtures move serially and wait for independently read PR/ref metadata; no provider byte-boundary race or target-side write fence is established.

## Actual snapshot graph

The fixture creates a common file commit **M**, branches the source, then changes the base to **B** and source to **H1** independently. The same first line differs on both branches. Supported PR GET observes `merge_base=M`, `base.sha=B`, and `head.sha=H1`; retained `refs/pull/N/head` independently resolves to H1. Consequently **M differs from B**. Subsequent source updates H2/H3 are likewise observed before the next request.

The native PR `merge_base` field is available through the supported API. [Pinned PR schema](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/structs/pull.go). Golf must not treat its current base-branch-tip field as the merge base of a displayed three-dot diff. An authoring packet needs separately observed native repository/PR IDs and exact displayed merge-base/head identities, with independently validated side/file coordinates. This probe uses a same-repository source; base-only access to private forks and source-access authoring constraints remain separate acceptance work.

## Actual observations

| Operation | Independent native outcome |
| --- | --- |
| Create COMMENT at current H1, new/old line 1 | Header commit H1. New-side stored hunk includes M's removed line and H1's replacement; old-side context includes M's removed line and excludes B's changed line. The native cut can stop before the replacement on the old side. |
| Move to H2, then create COMMENT explicitly naming H1 | Header remains H1. New-side child blame commit is H1, while its stored hunk contains H2's replacement, not H1's. Old-side child commit is H2; its removed context is from M. Both child `original_commit_id` values are empty. |
| Create own PENDING at H1 while current head is H2, then append at supplied H2 | Same review ID is reused and its header changes to H2. New child at line 2 is blamed against the prior pending H1, producing M, even though H2 changed that line. Its stored hunk includes H2's replacement. Earlier child commit/hunk remain unchanged. |
| Move to H3, then POST `/reviews/ID` with APPROVED/body | Same pending review becomes APPROVED, records H3 and reports native `stale=false`. Existing child bodies, positions, commits and hunks remain unchanged from their earlier observations. |
| Own PENDING, then create COMMENT with explicit H1 and empty `comments` | Existing pending review is consumed, with its prior inline child retained and header H1. This differs from `/reviews/ID`, which supplies the current retained head. |
| Two-comment batch: first valid, second path contains NUL | Native POST returns 500. Own readback finds a new PENDING review at the selected head with the first comment still present. Foreign comments GET remains404. The probe explicitly deletes this partial draft before continuing. |
| Closed PR, inline REQUEST_CHANGES batch | Native POST returns 422 at submission. A new own PENDING review and its first inline comment already exist. The probe deletes that draft before reopening through the supported PATCH, which returns 201. |
| Hidden own PENDING parent known to another actor | Other reader, PR author and ordinary owner cannot GET its comments (404). A reader knowing the parent ID can reply (201); the PR author knowing the ID can resolve the parent (204), despite still receiving404 on its review comments. Reader resolution is 403 and private-outsider reply is 404. The new same-line reply remains unmarked. |

Bodies/path/coordinates/review IDs and child metadata are independently read after each operation; the pending-submit test compares all retained body/path/side/commit/original-commit/hunk fields by exact child ID. Native map traversal order is not used as an identity receipt. Native COMMENT `stale` or successful APPROVED `stale=false` does not establish that the user reviewed the current displayed diff or that every child belongs to the named header snapshot.

## Pinned source explanation

The [create handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/pull_review.go) passes supplied `commit_id` into comment creation, creates children one at a time, then calls SubmitReview. There is no encompassing transaction around that entire handler; the partial-write cases above demonstrate concrete consequences rather than assuming every failure rolls back.

The [comment service](https://github.com/go-gitea/gitea/blob/v1.27.3/services/pull/review.go) can use an existing pending review's commit for new-line blame. Stored patch generation separately obtains the current retained PR head and compares it with `pr.MergeBase`. A same-location comment can reuse earlier child context. Unchanged-line fallback uses line/blame metadata. These source paths explain the observed mixed origins; they do not establish immutable context for every file format, rename, fallback or imported comment.

The `/reviews/ID` submit handler reads the current retained head before calling SubmitReview. Its [options](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/structs/pull_review.go) contain event/body, without a selected-commit predicate. The [model submission](https://github.com/go-gitea/gitea/blob/v1.27.3/models/issues/review.go) updates an existing pending review's commit/state/body. A serially unchanged preflight does not fence later changes; this probe does not pause a request between reading the head and writing its effect.

Reply/resolution visibility is a separate condition from native repository role. The runtime known-ID cases prove that those native write routes alone do not enforce a foreign pending review's read visibility. No method for discovering an otherwise hidden parent ID is established here. Resolution remains per comment, not resolution of a reconstructed entire thread/location.

## Next Golf write acceptance

1. Freeze exact displayed native repository/PR IDs, merge-base/head, literal path, old/new side and valid displayed single-hunk line. Review header commit, child blame commit and native retained context must remain distinct. Never present a native current-head hunk as exact selected-head context without independent binding.
2. Keep client-side private draft selection separate from native PENDING state. Repeated create can absorb existing drafts and rebind their headers. Preflight all bounded native pages for existing own pending; observation alone cannot lock concurrent native drafts. Do not adopt unrelated drafts or change a draft's reviewed snapshot implicitly.
3. Reserve exact ordered batch inputs durably before one dispatch. A native500 or422 after dispatch can leave pending children and therefore is not proof of zero effect. Retain partial/unknown evidence, block blind retries and conflicting replacement keys, and independently compare the full intended review/children before acknowledging success. Unknown/error inspection must not publish or absorb partial state.
4. Authorize the parent review's current visibility independently before reply, edit/delete or resolve/reopen. Require the exact parent/review/PR/repository binding and the appropriate write role; knowing an ID is insufficient. A single marked row does not establish complete-thread policy satisfaction.
5. Qualify in-flight head/base/pending changes, lost responses, partial transport, cancellation/revocation, private-fork authority, path/side/line boundaries, non-text/renamed/deleted files and coordinated recovery before broader claims. Exact provider write fencing and protected merge remain under P0.8. Native draft submission cannot be treated as expected-head CAS.

This serial characterization supports the next implementation design, without completing human inline drafts/threads/suggestions, trusted approval or the full GitHub parity goal. No new migration or recovery qualification is introduced. Earlier probe attempts cleaned their fixtures after incorrect harness assumptions: old-side snippets need not contain replacement text, and PR PATCH returns 201 rather than 200. The final probe checks the actual narrower native contract; neither product nor native behavior was changed.
