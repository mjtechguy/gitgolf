# Published review dismissal and restoration

Portable082 adds administration of one exact published approval or change-request review through supported native APIs. It does not enable protected merge or make native approval a trusted merge predicate. Earlier `COMMENT`, `REQUEST_REVIEW` and all native `PENDING` lifecycle paths remain outside this contract.

## Authority and selection

The selected repository/PR/review IDs, reviewed commit, current PR revision and complete observed review revision are retained in an immutable original intent. Golf checks the exact visible published review header before and after current authority reads. The native `dismissed` and `stale` fields must be present, with valid author identity, reviewed commit, dates and bounded body/count metadata.

The initial authority slice is a current ordinary repository owner or direct administrator, on an active pull-request unit and an open unmerged PR. Global native administrator status, code writer access and PR authorship alone do not supply this authority. Inherited team administration remains outside this initial consumer. This deliberately reuses Golf's current explicit repository administration contract.

Native dismissal accepts a `priors` option that can broaden the effect. Golf always sends `priors=false` and independently reads back the selected review. Restoring a review requires the reviewed commit to equal the observed PR head and the native stale flag to be false; an older approval never becomes restorable because its native stale flag has not caught up. Dismissed/older reviews can be requested again through the existing072 requested-review controls. Re-request selects the exact current individual identity and permissions and keeps its separate original journal; it is not restoration of an old approval.

These are repeated supported API observations, not an atomic native conditional update or a complete write-ingress fence. Current-head restoration alone does not establish eligible reviewer membership, required checks, candidate/base identity or protected publication authority.

## Durable original and effects

A dismissal reason is requested explicitly through TanStack Form and capped at1000 UTF-8 bytes. The initial reason is volatile; PostgreSQL and tab metadata retain only its SHA256 and selection. Original inspection does not echo its plaintext. Restoration sends no reason and cannot rewrite dismissal commentary.

The082 operation journal and append-only phase events participate in repository lifecycle exclusion. One original operation reserves before dispatch; exact-key replay never sends the native mutation again. Changed intent, foreign targets, stale revisions, absent authority and hidden/unsupported states refuse. A lost response, unexpected receipt or SQL uncertainty retains `DISPATCH_UNKNOWN`, blocking replacement keys and overlapping Golf writes. A rejected preflight permits an explicitly new selection/key. Native inspection does not adopt an external effect or fabricate a no-effect receipt.

A success binds native200, exact review ID/commit/author/decision/body, the requested dismissal marker and independent current readback. The response describes the retained effect, not a claim that the review can never change afterward. Administration requires an explicit inspection; the editor and confirmation open only on request. Older, stale or dismissed approvals have explicit freshness text in the review list. The re-request link leads to the shared requested-review inventory; it does not silently request another review.

## Qualification

Source checks: `GOLF_TEST_DATABASE_URL=... go test -race ./internal/server -run '^TestReviewLifecycle' -count=1`. Tests cover dismissal/restoration, immutable originals/replay, reason-free retention, changed intent, lost response/new-key exclusion, pending denial and stale restoration refusal.

Browser cases: `web/tests/pull-review-lifecycle.spec.ts`, plus existing reviewer and inline-read regressions. Actual supported-native proof: `scripts/pull-review-interactions-native-proof.py --lifecycle --stack-root PATH --output NEW_DIRECTORY`. It uses an isolated host PostgreSQL schema and owned temporary users/org/repository, checks selected review and prior approval separately, ordinary-writer refusal, replay, stale-head restoration refusal and existing072 re-request, and purges its fixtures. It starts no Docker job/service, changes no resource allocation and runs no workflow, model or Cloudflare operation.

Actual served UI, the full team/role matrix, published comment edits/deletes, native pending authoring, latest082 coordinated recovery and complete P0.8 protected publication remain separate acceptance requirements. Neither all GitHub review parity nor an entire plan phase becomes complete from this bounded consumer.
