# Protected Git087: exact-head review consumer and native enforcement regression

Source increment, 2026-10-06. **P0.8 and protected publication remain unavailable.**
This packet improves the existing merge explanation and repeats the supported
native enforcement matrix on owned fixtures. It does not introduce a publisher,
enroll a managed WRITE profile, alter retained native ingress or accept ADR0004.

## Implemented consumer

The existing browser-session `PullMergeObservationService` request now includes
`ProtectedReviewObservation` when the independently observed target is protected.
The selection still binds immutable repository/PR IDs, exact selected H/B and the
full PR revision. Existing current target/source authority, before/after snapshot
comparison and final authority checks remain in the original service.

The consumer reads every native review page within a 200-review ceiling, using the
supported native page-size setting, stable `X-Total-Count`, exact PR URL, unique
review IDs and explicit `official`, `stale`, and `dismissed` metadata. Missing
metadata, changed totals, duplicates or incomplete pages fail the read; denied
native review access reports `native_reviews_unavailable`, never an empty success.
No review body or provider credential is included. IDs remain decimal strings.

The response counts native official APPROVED/REQUEST_CHANGES decisions at selected
H. It independently excludes a different reviewed commit even if the provider's
asynchronous stale flag remains false. Dismissed/stale/unofficial/author reviews,
nondecisions and older decisions from the same reviewer are excluded. A newer
dismissed or changed-head decision does not revive an older approval. This is an
observation of provider metadata, **not current reviewer-grant eligibility**:
rule allowlists, team/unit grants, CODEOWNERS and complete conversation rules still
need their final protected-policy evaluator and mutation boundary.

The existing UI labels the counts as observations, displays another-head
exclusions, validates the exact H/count/IDs/reason metadata and keeps protected
merge unavailable. Native official flags do not establish current eligibility;
native success context names do not establish a trusted check producer. The
existing ordinary merge/squash authority is unchanged. This read-only change needs
no SQL migration, mutation journal or new service registration.

## Runnable evidence

Source checks passed:

```sh
bin/tools/buf lint
npm --prefix web run check
GOLF_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable' \
  go test -race -p 1 ./internal/server \
  -run 'TestProtectedReview|TestPullMergeObservation|TestProtectionDispatch|TestManagedGit' -count=1
```

The PostgreSQL/race selection passed in20.293s with isolated schemas. It covers
existing managed WRITE refusal/no bypass, original unknown receive outcomes and
restart, credential/session revocation, observation authority drift, and the new
exact-head/metadata/pagination cases. The earlier run's protected fixture lacked
the newly required settings/review inventory; the fixture was extended before the
passing run. The native-only test is skipped in this source selection and has its
separate real-provider pass below.

The existing merge-observation Playwright suite plus five new cases passed all40
tests in50.4s on an isolated4187 developer server. The new cases verify old-head
exclusion display, permanent protected publication refusal and malformed
head/count/reason/duplicate-ID rejection. Shared dependency symlinks caused Vite
font allowlist warnings, so this run qualifies behavioral and layout checks, not
a new served-image/font/screenshot receipt. No generated files from the isolated
worktree are required in this packet's integration commit; regenerate the merged
protobuf normally before building the integrated source.

Actual native qualification uses the retained local Gitea and existing corpus:

```sh
python3 scripts/protected087-native-proof.py \
  --stack-root /Users/mj/mjcode/billiondollarsolo/golf-git \
  --output /Users/mj/mjcode/billiondollarsolo/golf-git/.tmp/protected087-native-attempt2
```

The [attempt2 manifest](../.tmp/protected087-native-attempt2/manifest.json),
[native matrix](../.tmp/protected087-native-attempt2/native.log) and
[production consumer check](../.tmp/protected087-native-attempt2/review-native.log)
pass against native1.27.3. Production source digests are recorded alongside the
baseline revision; this is qualification of that bounded source, not a deployed
087 runtime. Randomly named ordinary actors, their private organization/repository
and short-lived SSH keys are created through supported CLI/API operations, then
purged and native absence checked. SSH uses temporary0700 storage, pinned
controlled-loopback host keys, strict checking, no SSH-agent/session reuse and
separate positive read plus negative push checks. There are zero new Docker
resources, jobs or model calls; no retained account/configuration is changed.

[Attempt1](../.tmp/protected087-native-attempt1/manifest.json) remains failed:
macOS `ssh-keyscan` using the default localhost address selection exited-13.
Its owned fixtures were purged. Attempt2 uses the existing Git-access qualifier's
bounded IPv4 scan; the failed receipt is preserved.

| Actual native control | Outcome and exact limit |
| --- | --- |
| Strict push-disabled/admin-override-blocked target | Owner/developer HTTP receive, SSH receive and contents API writes are denied; positive SSH reads succeed and target remains exact. This does not enumerate every native mutation route. |
| Required approval and status | Missing review, then missing context success, deny ordinary merge. Settled stale/dismissed approval denies merge. |
| Exact head | Obsolete `head_commit_id` denies with409 and preserves the base. |
| Exact-head Golf consumer | After actual H1 approval and H2 push, production supported-page reads retain the original review identity and report zero H2 approvals. |
| Rapid stale review | **2/3** rapid H2 merges accepted with reviews still on H1. This finite sample reproduces the safety blocker; it is not a guarantee that every trial races. |
| Check producer | Ordinary code writer supplies the accepted required success context. That assertion is not executed Golf CI evidence. |
| Changed base | Native outdated-branch rule denies; disabling that setting permits an expected-head merge against the advanced base. There is no caller expected-B predicate. |
| Scheduled merge | A request initially naming H1 later integrates approved H2. It is evolving native intent, not exact tested candidate publication. |
| Scoped merger | Exclusive ordinary merge account succeeds; other actors' immediate/scheduled merges and merger policy edits/direct pushes deny under the tested settings. Owner can still change settings. |
| Explicit Git lease | Stale B rejects; matching B publishes exact C. Source can advance independently, so this does not condition H/review/policy/authority. |

The pinned [merge API handler](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/pull.go),
[merge service](https://github.com/go-gitea/gitea/blob/v1.27.3/services/pull/merge.go)
and [protected-branches documentation](https://docs.gitea.com/1.27/usage/access-control/protected-branches/)
were rechecked. Native1.27.3 retains the expected-head-only synchronous signature,
PR-scoped lock and provider-lifetime merge context. Client cancellation therefore
does not establish that an accepted native write cannot later take effect.

## Enforcement decision and next implementation

Retain the enforced native settings consumers for their documented native
behavior. **Do not enable managed WRITE or protected Golf merge from this
regression.** The current managed WRITE prerequisites require an already enrolled
fresh-private-native incarnation, no native Actions/mirrors/protection inventory,
and original uncertainty fencing. The retained provider has independent native
HTTP/SSH access; fixture rule success does not establish process/queue quiescence
or create a valid `golf_git_transport_profiles` enrollment. A schema insert or
operator checkbox cannot supply that proof.

Continue the [existing supported managed-boundary design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md),
not another preflight wrapper around native merge. The next concrete acceptance
is a fresh, stopped target whose operator-configured HTTP/SSH/API boundary denies
every alternative writer, with original in-flight writes conservatively drained
or quarantined. Reuse the existing durable reservations and qualified
operator-global/reference-hook experiment only after their complete admission,
delegate, interrupted-publication and recovery contract passes. Retrofitting that
configuration into the retained installation is a separate coordinated migration.

Then bind current H/B, exact precomputed C, policy, eligible reviewer grants,
trusted finalized run/attempt/producer evidence and publisher authority throughout
the effective update; publish C through supported Git with explicit B and native
PR finalization. Existing workflow runs are bound to source selections/archive
execution; a native status and advisory reviewer publication are not a trusted
candidate-C producer. Candidate preparation/verification must precede any required
check policy based on those records. Immediate revocation/expiry during an accepted
native update, private-fork source mutation, uncertain old writers and every
required merge mode remain explicit gates. If the complete boundary cannot meet
those semantics through supported primitives, an upstream-supported conditional
publication extension is required. P0.8 is not complete on either track.
