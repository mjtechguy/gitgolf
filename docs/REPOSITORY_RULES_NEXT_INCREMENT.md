# PR merge observations: source implementation packet

This packet implements the read-only observation workspace proposed in
[the unprotected merge packet](UNPROTECTED_MERGE_IMPLEMENTATION_PACKET.md).
A PR's **Inspect merge observations** action reads current native facts for its
exact retained comparison. It adds no executable merge permit, publication
reservation, native write, migration, background grant or automatic initial-page
request. Repository Rules remains Partial under
[the settings acceptance criteria](REPOSITORY_SETTINGS_IMPLEMENTATION.md).

## Current native contract

The supported Gitea 1.27.3 branch API returns `protected` and
`user_can_merge`. Native conversion observes the first applicable native branch
protection and caller branch-policy result; an unprotected branch reports the
caller's native write flag. These are independent observations, not a lease over
policy, reviews, source or target. See pinned primary source
[GetBranch](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/branch.go)
and [ToBranch](https://github.com/go-gitea/gitea/blob/v1.27.3/services/convert/convert.go).
The supported repository response supplies native merge/update strategy flags and
defaults. Golf requires their presence and validates their supported values.

## Bounded read

Browser-only `PullMergeObservationService.GetPullRequestMergeObservation`
accepts the complete `PullRequestSelection` and original full pull revision.
Current managed session and exact Origin are required; API bearers have no read
grant. The request binds immutable target/native PR IDs, number, selected full H
and B. It reuses retained-comparison/current-session fences, independently checks
ordinary target read/write authority, and independently authorizes the live source
repository. Native site-administrator aggregate privilege alone is insufficient
under the reused Git ordinary-authority guard.

Within a 15-second bound, two complete observations must match. Branch metadata
is compared with the exact `refs/heads/NAME` namespace, including slash names.
Missing native flags are errors. Full PR revision and ordinary target authority
are checked again after source waits. Source ordinary authority is checked on
both sides of its ref read. Returned native identities/ref OIDs/configuration
must match; drift refuses the observation. There is no claim that these reads
are atomic or establish a minimum provider state duration.

The result includes the original comparison, current target owner ID, current
native target protection and caller merge flag, ordinary target-writer flag,
validated native strategies, timestamp and fingerprint. A live source key/ID/ref
is emitted only under its own current authority. Source state explicitly says
current, changed, unavailable, or retained-only. Unknown target protection is
separate from an observed unprotected target. Native forbidden/not-found optional
reads never turn into false/default policy flags. The fingerprint identifies this
observation and cannot authorize another operation.

## UI and privacy

The existing PR workspace renders the shared-layout panel without an initial
read. Explicit activation and refresh display **Merge unavailable** throughout.
Receipts are checked against the exact selected PR/revision/H/B before display.
Refresh hides prior observations; a changed comparison or navigation cancels and
requires a new explicit activation. Failed target authority removes parent PR
private content; unauthenticated reads use the existing session/private-cache
cleanup. Late old requests cannot clear a newer selected comparison. Private
source denial returns no live source repository identity. No private content is
written to browser storage. No merge action or allow-new-publication affordance
is introduced.

## Validation and remaining qualification

Source checks and mocked-browser results are reported with the frozen commit;
Postgres-backed tests are authored for the root's serialized runner and were not
executed by this packet's author. No native fixture, Docker resource, deployment
or live browser authorization was performed. The focused tests cover exact
namespace/ref disagreement, omitted native flags, metadata tampering, target
replacement, source/private-authority changes, logout after a held read, explicit
activation, selection/navigation races and both-theme mobile/desktop overflow.

A subsequent actual qualification must exercise supported native branch flags,
private forks, current ordinary readers/writers/site-admin counterexamples,
rename/replacement and source/base/protection drift; then capture the served
activation/refresh/denial flows. The read remains useful without that proof being
misrepresented as protected publication.

Full Rules readiness still requires applicable policy/review/CODEOWNERS and
trusted-check eligibility, exact B/H/candidate binding, stable authority/policy
resources, and durable once-only publication/uncertainty handling across all
supported writers. The bounded operator-global hook composition proof is a
candidate native configuration seam, not a complete integrated P0.8 publisher.
The native merge endpoint has no qualified atomic “must still be unprotected”
admission contract. Consequently this packet deliberately has no merge POST.

Frozen source-check evidence: all-server race tests passed in 6.355 seconds with
no Postgres DSN; focused race tests passed in 1.548 seconds. TypeScript, Go vet,
Buf lint and whitespace checks passed. The final 75-case browser run passed in
1.1 minutes (29 new observation cases and 46 existing PR cases), with actual
local fonts. The prior affected run passed 153 of 154 cases, including all 79
review creation/comment cases; its sole obsolete unavailable-copy assertion was
preserved by restoring the existing truthful phrase and rerunning the affected
PR suite. The earlier isolated new-suite attempt had one wrong sign-in-role
selector and font-serving warnings; those failed artifacts remain in the ignored
worktree logs and are not represented as passes.
