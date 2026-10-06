# Published review interactions and team routing

The portable077 increment extends existing review capabilities through supported native APIs. It does not enable protected publication or complete the P0.8 admission boundary. Native web/API/SSH remain independent ingress, and observations are not native atomic compare-and-swap.

## Requested reviewers

`PullReviewRequestService` retains its072 immutable request journal and user contract. `reviewer_team=true` binds the same original reviewer ID/name fields to an exact organization team; changing identity kind changes the original fingerprint. User-only historical originals remain valid. Inventory revisions include requested teams when present. Team requests use the native `team_reviewers` payload, independently verified organization identity, current repository association and a non-none pull-request unit. A code-only team cannot become a pull reviewer through Golf.

The requested picker lists existing visible attached teams and individual repository candidates. Exact team GET/configuration comparison supplements the native whole association collection. Collections over200 refuse rather than truncate; names outside the existing repository-component vocabulary are unsupported. Team discovery can require broader native access than individual reviewer requests and reports unavailable choices honestly. Native CODEOWNERS automation can race these observations; stale original intents receive retained refusal rather than silently rebinding.

## Published inline interactions

`GetPullReviewCommentState`, `SubmitPullReviewCommentInteraction` and original-operation inspection bind repository/PR/review/comment IDs, reviewed commit, current PR revision and the exact observed parent comment revision. Native parent-review visibility is checked through the entire bounded comments consumer before any known-ID write. Both own and foreign PENDING reviews are excluded from this increment even though native known-ID reply/resolution routes can accept them.

An open current PR author or exact ordinary pull-unit writer can resolve, reopen or reply. A global native administrator does not substitute for ordinary repository authority. Reader-only reply permission is not exposed in this initial slice. Resolution is a per-comment marker, not complete-thread or conversation-policy satisfaction. Published edits/deletes, dismissal, native draft adoption/submission/discard, multiline suggestions and protected eligibility remain separate work.

Replies are capped at1000 UTF-8 bytes, and refuse when the bounded review collection has100 comments. The initial body remains volatile. The durable original and browser metadata retain its SHA256 and selection only; neither stores the plaintext body. A success requires one native201 reply receipt, independently visible child ID, exact actor/review/path/side/body hash and a retained reply ID. External native ancestry is not invented. The existing read grouping remains by native review, not an asserted complete thread tree.

The077 journal and append-only phase events share repository lifecycle exclusion with existing writes. Every intent is retained before dispatch; exact-key replay inspects the original without another native POST. Changed intent, missing authority and foreign targets refuse. Lost responses, mismatched effects or storage uncertainty retain `DISPATCH_UNKNOWN`, blocking replacement keys and overlapping Golf mutations. Inspection never retries or adopts an external comment. Browser controls open editors only on explicit request, use TanStack Form and global styles, and keep body content out of tab storage.

## CODEOWNERS observations

`GetPullCodeOwners` binds the current selected PR comparison and reads a hash-verified blob at the selected base commit. First-file precedence is `CODEOWNERS`, `docs/CODEOWNERS`, `.gitea/CODEOWNERS`. The native format uses Go regular expressions, optional negative rules and `@user`/`@org/team` owners; it is different from GitHub glob syntax. [Native format documentation](https://docs.gitea.com/usage/repository/code-owners/).

The bounded parser handles documented space/hash/backslash escaping. Files over16 KiB, more than200 rules or malformed owners/patterns are unavailable/unsupported. Unsupported rules withhold routing matches entirely. Complete observed diff paths include both old/new names where available and are capped at200 files. Suggestions do not prove current membership, eligible approval, trusted checks or merge readiness; no automatic Golf dispatch follows a suggestion.

## Qualification and remaining acceptance

Run source PostgreSQL/race checks with `GOLF_TEST_DATABASE_URL` and `go test -race ./internal/server -run '^(TestReviewRequest|TestReviewComment|TestCodeOwnerNative)' -count=1`. Browser cases live in `pull-review-requests.spec.ts`, `pull-review-comment-interactions.spec.ts`, `pull-codeowners.spec.ts` and the existing inline-read suite.

`scripts/pull-review-interactions-native-proof.py --stack-root PATH --output NEW_DIRECTORY` uses retained native Gitea plus an isolated host PostgreSQL schema and owned temporary users/org/repository. It starts no Docker service/job, changes no resources, runs no workflow/model and purges its fixtures. Its actual production HTTP receipts remain distinct from controlled browser/source evidence. Latest077 coordinated restore, full team-role matrix, actual served browser checks, wider review lifecycle and the complete protected write boundary remain required; passing this increment does not mark an entire phase or full GitHub/Gitea parity complete.
