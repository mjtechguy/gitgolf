# Repository invitations: bounded source contract

This packet implements Golf-managed invitations to existing native accounts, with an explicit recipient inbox and a durable grant journal. It does not complete the full Access section. It is source qualified against substituted native HTTP boundaries and disposable PostgreSQL; served native/browser qualification, combined schema 044 recovery and deployment remain pending.

## Native boundary and scope

Pinned Gitea 1.27.3 `PUT /repos/{owner}/{repo}/collaborators/{username}` immediately adds or changes a collaborator and returns 204. It does not create a native pending invitation or recipient acceptance object. Golf therefore stores private pending metadata and invokes that supported API only after the intended native account accepts.

Primary pinned sources: [collaborator handlers](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/collaborators.go), [collaboration service](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/repository/collaboration.go), and [organization permissions](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/org/org.go). Native calls use the existing forge client and shared lifecycle write hook. No application code writes native SQL or repository files.

The issuer must use a current managed Golf password account. Creation requires explicit, logout-persistent delegation to that account's **existing encrypted credential**, pinned by immutable local-account ID and credential version. No credential is copied into an invitation, operation or new encryption family. Logout alone does not cancel that consent; disabling the issuer or changing its credential version expires pending invitations. Already granted native access is separate and is not removed by invitation expiry or revocation.

Both personal and organization repository targets are supported. Issuance and revocation require exact current repository/owner IDs, a current access observation, native repository-admin permission and positive individual authority. Personal ownership/direct collaborator admin use the existing Access proof. An organization issuer must be a current member and independently verified organization owner or direct collaborator admin. Native site administration, Golf instance administration and effective team-admin permission alone do not delegate grants. Hidden organizations remain unknown/denied. Acceptance does not create organization membership, a team assignment or a custom role.

Recipients are existing exact native user IDs, not email claims. The recipient's own managed browser session must resolve to that native identity. Replaced usernames, changed role observations, archived/mirror repositories and stale routing/identity observations refuse the grant. Native usernames and routes are observed before and after effects; the native API has no atomic compare-and-swap, rename fence or exclusive attribution guarantee.

## API and presentation

`RepositoryInvitationService` is browser only. All seven procedures require the configured Origin, a managed session cookie and no Authorization/delegated bearer header:

| Procedure | Binding and result |
| --- | --- |
| `PreviewRepositoryInvitationRecipient` | Current repository key, repository ID, owner ID, access revision and an existing username → exact native user, recipient revision and observed effective permission. |
| `CreateRepositoryInvitation` | Same target plus previewed recipient ID/login/revision, read/write/admin, expiry between one minute and seven days, explicit persistent consent and an original UUID key → pending invitation. No grant occurs. |
| `ListRepositoryInvitations` | Same exact target, page ≤ 20 → private admin inventory, target/access echoes, `canManage` and independent `localIssuerAvailable`. A verified reader receives no invitation rows or private invitation metadata. These booleans are current observations, not broader capability readiness. |
| `ListOwnRepositoryInvitations` | Own native identity, page ≤ 20 → recipient inbox. If current issuer authority is unavailable, only the caller's invitation ID, state, revision and timestamps remain; repository/account names and target IDs are withheld. |
| `RespondRepositoryInvitation` | Own invitation ID, exact original revision, ACCEPT/REJECT and original UUID operation key → invitation and bound durable operation. |
| `RevokeRepositoryInvitation` | Current admin target/access observation plus pending invitation ID/revision → SQL-only revocation. This does not remove an accepted native grant. |
| `GetRepositoryInvitationOperation` | Own recipient, invitation ID and original key → status only, after current issuer/session/target checks. A missing or withheld receipt does not authorize a replacement request. |

Read inventories use limit-plus-one paging and explicitly label loaded rows. Search and sort apply to loaded pages; no loaded-page count masquerades as a total. The repository panel opens the TanStack editor only through **Invite account**, previews the exact existing account and shows explicit delegation before creation. The account inbox uses shared DataTable primitives; accept/decline confirmations have Cancel as initial focus. No settings editor is crammed into a modal. No invitation email is sent by this packet.

## Grant state, locking and uncertainty

Invitation states are `PENDING`, `GRANTING`, `ACCEPTED`, `REJECTED`, `REVOKED` and `EXPIRED`. Immutable identity/consent/expiry fields cannot be rewritten; legal state changes increment the canonical revision. Existing local-account disable/version changes expire pending rows. Listing also observes wall-clock expiry. Expired metadata still occupying a live-target slot must be inspected/expired before a separate creation; this packet does not promise a background expiration worker.

Recipient operations bind the original invitation revision, actor, decision and complete request fingerprint. Phases are `RESERVED`, `DISPATCH_UNKNOWN`, `SUCCEEDED` and `REJECTED`. Exact-key replay is status only; changed-key input cannot reuse a receipt. Known preflight refusal can produce durable `REJECTED/preflight_refused`. Malformed input, stale invitation revision, unavailable authority or storage failures are not invented success/no-effect receipts.

Sorted managed-user locks precede the caller session, issuer credential, invitation and shared repository gate. Session validity is checked after lock waits and before commit. Before native PUT, `GRANTING` plus `DISPATCH_UNKNOWN` is committed. Only the original invocation can make the one PUT; a retry, status read, reload or new operation key never resumes an unresolved grant. A crash after that commit but before native HTTP may leave an unresolved operation without an effect; conservative inspection is intentional. Unresolved operations contribute to the existing lifecycle active-work aggregate and block archive. The shared exclusion remains Golf-only; native/raw Git/external ingress enforcement remains P0.8 work.

A confirmed acceptance requires native 204, independent exact recipient/direct-membership/effective-permission readback, current issuer/recipient authority and a committed terminal SQL outcome. This is evidence of the requested observable grant, not exclusive write attribution or proof of the native stored direct permission in the presence of additive team roles. Lost acknowledgements, native errors, readback mismatch, late denial and SQL failure after dispatch preserve unknown outcomes. There is no automatic repair/replay of those effects.

An accepted success appends exactly one metadata-only scoped `source` invalidation. Pending metadata, revocation, rejection, unknown operations and exact-key inspection/replay emit no shared activity revealing private invitation existence or recipient decisions. Journal tables retain append-only events and reject identity rewrite/deletion. Downgrade requires an explicitly empty invitation journal; do not erase live history to satisfy it.

The inbox keeps only origin/user/invitation-scoped operation identity in sessionStorage: UUID key, invitation ID/revision, target IDs, recipient ID and decision. No text, names, email or credentials are stored. Reload performs GET inspection only. Unknown/reserved/missing receipts cannot create a new key. Only an exactly bound terminal preflight refusal offers an explicit **Review invitation again**. Signout, account changes and current authority loss hide/remove private observations, abort in-flight reads and fence late callbacks. Refresh retains an original intent under a hidden/inert boundary without granting retry authority.

## Root integration seams

The isolated packet intentionally leaves existing root-owned files unchanged in its commit:

1. Register `NewRepositoryInvitationServiceHandler(s, options...)` in `internal/server/rpc.go`; add all seven procedure constants to the managed-browser pre-decode boundary. Do not add them to the bearer read allowlist.
2. Export `repositoryInvitationClient = createClient(RepositoryInvitationService, transport)` from the existing shared `web/src/api.ts` transport.
3. Mount `RepositoryInvitations` in the Access page with `{ userId, owner, name, access, signingOut, revalidating }`. Retain a previous verified exact access observation through refresh, as with the team panel, so uncertainty survives; hide/inert while revalidating. Unmount and remove private data on actual denial or native identity/account change.
4. Mount `RepositoryInvitationInbox` in a real account inbox page with `{ userId, signingOut }`; the source browser proof temporarily mounts it at account settings. Final full-page route/account navigation is root-owned. Do not expose native admin credential enrollment to recipients.
5. Existing Access/team browser fixtures need an additive exact-target `ListRepositoryInvitations` response (verified reader, no rows is sufficient where invitations are not under test). Do not swallow a production NotFound to accommodate old fixtures.
6. Regenerate combined 042/043/044 models/descriptors and run the central lifecycle/key-family checks. Migration 044 wraps the previous `golf_repository_lifecycle_active` function, preserving its existing work contributions rather than replacing them with a stale copy.

## Source evidence and remaining acceptance

Disposable PostgreSQL 18.4 `-race TestRepositoryInvitation` passes **31.340s** after the new fixture's repository ID was corrected; the preceding failed identity fixture run remains recorded. Tests cover logout-persistent consent, exact once-only accept, reject/revoke, wall-clock and local-version expiry, concurrent fresh keys, current authority/target denial, immutable journals, lost acknowledgement, status-only replay, lifecycle active count, lock-wait/session-revocation no admission and Origin/bearer refusal. Six pure HTTP organization authority cases pass **0.393s**, including direct/member versus indirect/global/hidden organization distinctions. Whole Go checks pass with optional PG suites skipped when their environment is absent; these do not replace the recorded real-PG run.

The final affected browser run passes **57 cases in 46.3s**: 17 new invitation cases plus 12 existing Access and 28 organization-team cases. It covers explicit consent/preview, once-only acceptance, decline/revoke confirmations, unknown/missing/wrong receipt inspection, immediate mutation-denial privacy, refresh clearing, account switching, dark/light and 1440/390 layouts. Existing specs used temporary additive read-only invitation fixtures; temporary mounts/client wiring, Vite worktree font allowance and the isolated Playwright configuration are excluded from the packet. TypeScript, production build, whole Go, vet, buf lint and whitespace checks pass. The final canonical metadata-type guard has a further **17/17 invitation cases passing in 17.3s**. This is not served/native qualification.

Still required: fresh supported-native owner/direct-admin/organization/recipient qualification and cleanup; permanent inbox routing and integrated fixture checks; qualified unknown-effect investigation/recovery; latest schema 044 restore; public/self-service native account provisioning and verified-mail invitations; OAuth/service issuers with deliberate delegation; organization membership invitations; complete custom/team role management, audit/retention exports and accessibility/performance qualification at larger scales. Full Access and the full repository-settings completion condition remain open.

## Root integrated surfaces

Root integration registers all seven managed-browser-only methods and uses the existing shared typed transport. Repository Access contains the invitation inventory under its same validated native target and refresh boundary. The recipient inbox is a full page at `/account/invitations`, with account navigation and breadcrumbs. The closed issuer-authority error retains fixed403 guidance, including when wrapped, without exposing private detail. Integrated source fixtures for collaborators, teams and deploy keys explicitly return an empty read-only invitation inventory; they do not suppress production errors. All93 affected browser cases pass in1.2m, and current pre-decode HTTP/Origin/bearer boundaries are checked separately. Quota/post-readback refinements, actual native/browser qualification and latest schema recovery remain separate required gates.
