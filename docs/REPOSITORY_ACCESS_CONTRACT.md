# Personal repository access administration

Golf exposes collaborator management for positively identified personal repositories on both infrastructure tracks through the initial forge's supported APIs. Cloudflare services are optional for this slice. Organization repository grants remain governed by native organization teams and their separate owner-authorized membership UI; this slice does not mutate organization collaborator rights, owner teams, global administration, custom roles, repository ownership, visibility, or branch protection.

## Native authority and account binding

Every request uses the caller's current encrypted browser-session credential. Golf verifies the local session and immutable native caller ID before and after provider operations. Bearer credentials cannot invoke this browser administration service; same-origin checks and no-store responses apply.

The repository route must resolve to the exact expected immutable repository and owner IDs. The actual personal owner can manage access. Another account requires a current explicit collaborator membership and native effective `admin` permission, together with the repository's native admin permission. A native site administrator may report effective `owner` on another person's repository; that observation is **not** a Golf ownership grant or an override. There is no alternate privileged token.

Native user search with the immutable owner UID positively proves an individual owner. Gitea 1.27.3 restricts this search to individual users. An empty search result requires a successfully bound organization lookup to classify the owner as an organization. A hidden organization's lookup can return 404 even to a direct repository administrator; Golf fails closed rather than assuming that 404 means a personal owner. A positively identified organization is displayed as read-only in this slice.

The account preview resolves an existing native username, then binds its immutable user ID. The actual owner and the acting account cannot be added, changed, or removed through collaborator mutations. A target with exceptional effective `owner` permission is also read-only because this API cannot qualify a direct grant independently of that authority. Native account eligibility and token scope continue to apply.

## What the permission observation means

The inventory paginates explicit native collaborators and rechecks each immutable user identity. Each entry has a separate `isDirect` membership observation and a native effective permission (`none`, `read`, `write`, `admin`, or `owner`). Effective permission is not claimed to be the direct stored grant. Public repository readability can remain `read` after a direct collaborator is removed; removal succeeds only when explicit membership is absent. Owner and native site administrator behavior must not be inferred from the permission string alone.

Only `read`, `write`, and `admin` are writable. Users explicitly resolve and review an account before applying its grant, and confirmation is required for removal in the UI. The immutable target ID and preview revision accompany the mutation. Duplicate/no-op writes and absent-member removals require a fresh review rather than being silently dispatched.

## Freshness, response loss, and native races

Repository and target revisions hash observed native identity and access state. Golf rechecks both, current native management authority, and the live local session immediately before a single native PUT or DELETE. A successful native 204 receipt is followed by immutable identity, membership, permission, repository, and caller-authority readback. There are no automatic write retries. A failure after dispatch can mean the operation applied; the client must refresh and inspect current state before a new explicit action.

These revisions are best-effort stale-preview fences, **not atomic compare-and-swap or security locks**. Native username-addressed collaborator routes do not atomically bind an immutable ID, expected prior grant, repository owner, or caller role at dispatch. External account rename/reuse, repository transfer, permission changes, local revocation, and grants from other native writers can race the final check or readback. Golf does not claim exclusive writer ownership, transactional native role enforcement, exactly-once grants, or that effective permissions identify direct grant metadata. Atomic adapter primitives or an exclusive, qualified mutation authority remain future work.

## Evidence

- `go test ./internal/server -run TestRepositoryAccess -count=1`: validation, positive owner classification, hidden organization fail-closed, native global-admin bypass denial and browser boundary tests. Database cases require `GOLF_TEST_DATABASE_URL` and use disposable migrated schemas; they cover grants, immutable target/repository mismatches, stale previews, owner locks, public readability after removal, applied PUT with lost receipt and no retry, native authority revocation, and local-session revocation before dispatch.
- `python3 scripts/repository-access-smoke.py`: actual local Compose disposable users, private/public repositories and private organization; checks supported native API receipts, readback, owner/direct-admin versus reader/global-admin behavior, self/owner locks, revocation, pagination, hidden organization classification, Origin/bearer/logout denial and cleanup. Run against an image containing this slice before marking it qualified.
- Native contract sources: [Gitea 1.27.3 individual user search](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/user/user.go) and [collaborator routes](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/collaborators.go). Source review and live disposable API fixtures establish this narrowed native contract; broader organization/enterprise policy parity remains planned.

## Configured native page span follow-up (2026-10-03)

Total-based PR/review/comment/collaborator pagination now observes the supported native API settings around each read and requests the smaller of the caller limit and `max_response_items`. Current native settings clamp100 to50. Completion arithmetic uses this actual configured span; visible empty filtered pages retain continuation. Invalid/missing or observed changed settings fail the read. This observes settings rather than locking configuration or detecting ABA changes. The [human review contract](PULL_REVIEW_MUTATION_CONTRACT.md) records the shared fix, real-PG regression evidence and its additional bounded pending-draft scan. That separately generated API/editor now publishes initial overall human reviews; inline drafts/threads/suggestions and protected publication remain open. Historical read-only scope statements above refer to their original increment.
