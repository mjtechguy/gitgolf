# Organization repository team access

This packet implements a bounded browser/API association editor. Source and disposable PostgreSQL/browser evidence must be recorded independently from actual supported-native and deployed qualification. It does not complete the full Access requirement: invitation acceptance/revocation/expiry, custom roles, broader organization delegation, and the remaining acceptance matrix stay open.

## Authority and identity

`RepositoryTeamAccessService` exposes `ListRepositoryTeamAccess`, `AttachRepositoryTeam` and `DetachRepositoryTeam`. All three require the managed browser boundary, current native caller/session authority and same-origin requests. They are absent from the API-credential read allowlist; no CLI/MCP delegation is added.

Every request carries repository routing key, canonical positive decimal repository/organization owner IDs, and the current `RepositoryAccess.revision`. Team mutations also carry canonical immutable team ID and the row's revision. The organization owner ID is the actual native repository owner, not the caller or a Golf global-admin UUID.

Reads require current repository access and positively verified organization membership. A hidden organization or failed native lookup is refused, never interpreted as a personal repository or empty inventory. Management requires **both actual native organization ownership and native repository administrator permission**, and refuses archived/mirror repositories. A Golf/global/site-admin role, an ordinary organization admin team or the native optional repository-admin team-access policy does not substitute for this owner proof. This initial policy is deliberately narrower than some native administration paths.

Native identity, repository access revision, organization membership/ownership, repository admin status and browser session validity are checked around provider operations. Loss after an accepted native write withholds success even when the association effect persisted. These checks are observation fences, not an atomic native lock or attribution guarantee.

## Native collections and configuration

Pinned native `repo.ListTeams` reads the complete `GetRepoTeams` collection and converts it without organization objects. It has no `ListOptions`, page parameter, total-count or Link pagination. Golf uses this supported unpaged collection to observe repository association, refuses null/duplicate/malformed rows, a Link header, and more than 500 associations. It never assumes the first page of a paged collection is complete. The generic native response byte cap still applies.

Selectable teams come from the **paged, visibility-filtered organization team inventory**, with native page-size clamp and canonical total/span/next-page validation, at most 20 teams per Golf request. Each returned team receives an exact supported `/teams/ID` read to independently bind team ID to the current organization ID/name and confirm configuration. Loaded-page search/sort and selection are labeled accordingly; the UI does not promise all organization teams are loaded or visible.

New native decoding requires explicit boolean `includes_all_repositories` and a non-null `units_map`. Missing/null/ill-typed inheritance and unit permissions are refused; they never become `false` or an empty permission set. Known native permission/unit/visibility vocabularies, positive IDs and bounded text are validated. Existing legacy organization read projections are unchanged.

`OrganizationTeam.permission` and `unit_permissions` are **global team observations**, not an effective caller role or a permission edit for this repository. Owner teams (native owner permission, Owners name or owner unit permission) and teams including every repository cannot be attached/detached here. Their organization configuration remains read-only in this panel.

## Wire and mutation receipts

List request fields: `repository(1)`, `repository_id(2)`, `owner_id(3)`, `expected_revision(4)`, `page(5)`. Response echoes `repository_id(1)`, `owner_id(2)`, `access_revision(3)`, current `can_manage(4)`, `teams(5)`, `page(6)`.

Each `RepositoryTeamAccess` row has `team(1)`, `attached(2)`, `is_owner_team(3)`, `can_attach(4)`, `can_detach(5)`, `revision(6)`. Its SHA-256 revision binds exact repository/organization IDs, repository access epoch, observed supported team fields and selected association state. The supported fields are name, description, global permission, unit permissions, visibility and includes-all-repositories policy; member rosters, repository-creation policy and other native fields are not part of this projection. It is a stale-preview fence; native routes provide no atomic compare-and-swap.

Attach/detach requests contain the same target fields 1–4 plus `team_id(5)` and `expected_team_revision(6)`. Responses echo target identity/access revision and return the independently observed selected row. Attaching an already-associated team or detaching an absent association with a stale preview is refused before dispatch, rather than fabricated as a successful write.

A mutation performs exactly one native `PUT` or `DELETE /teams/ID/repos/OWNER/REPO`, requires HTTP 204, then independently verifies the selected association and unchanged supported team fields. No team-global permissions, membership, inherited-all policy, owner team or alternate administrator credential is changed. Other teams' concurrent associations are independent and are not asserted unchanged.

A provider error/lost acknowledgement, wrong status, mismatched readback/configuration or late authority/session loss gives no positive receipt. There is no native write retry, durable mutation journal, idempotency replay or automatic reconciliation. An independent refresh observes current association state and permits a **separate explicit action**; it does not establish attribution for an uncertain write. Reload reads current inventory only and never resends an operation.

## Browser behavior and remaining proof

The panel uses existing global layout, shared DataTable, loaded-page labels and TanStack Form. Current values precede a requested Attach editor; selection includes existing eligible loaded teams only. Global/unit permissions are read-only. Detach uses a confirmation dialog with Cancel focus, Escape handling and focus restoration.

Native-ID/target/row/eligibility/permission/visibility/revision/pagination receipts are validated before displaying editable data. Private rows/editor/receipt details are hidden during refresh and cleared on current denial, sign-out/account/target transitions. Aborted/late results cannot restore private data. Mutations are once-only and uncertainty blocks ordinary edits until independent inspection; no browser body persistence or shared repository activity is introduced.

Still required before deployed/native qualification: actual pinned owner/admin/member/outsider/global-admin matrix, real native association attach/detach/readback and inheritance/owner protections, changed target/configuration, permission/session loss, controlled lost acknowledgement, actual Add/edit/confirm/reload in both themes/viewport sizes and complete owned cleanup. Source tests or mock browser cases cannot substitute for this proof. No broader Access Ready, wiki workspace, native CAS, invitations or custom-role completion claim follows from this slice.

## Source qualification

Disposable PostgreSQL 18.4 race suite `TestRepositoryTeamAccess*` passes in 19.328 seconds, including field-presence/revision validation, owner/admin/member/hidden-organization/protected-team gates, wrong/changed identities, malformed collection/count/span/cap handling, one-write lost or mismatched acknowledgements, independent readback/configuration drift, late ownership loss and session expiry after an accepted native effect. The initial 128 MiB PGDATA tmpfs filled during repeated schema migrations (38.691 seconds); it was removed and is not a passing proof. The successful rerun used an owned 512 MiB tmpfs with a 768 MiB memory/swap ceiling and bounded WAL, then removed the container. No retained database or actual native fixture was used.

The initial 19-case browser run passed in 22.7 seconds but the isolated dependency symlink blocked font assets; it is not claimed as final visual qualification. With an explicit temporary dependency-only Vite filesystem allowlist and loaded Archivo assertion, 19 cases pass in 22.6 seconds. The final affected run covers 54 cases (21 team access, 16 existing collaborator access, 17 deploy keys) in 45.1 seconds. It includes dark/light 390/1440 layouts, exact receipts/global-permission preservation, explicit editor/confirmation keyboard behavior, unknown-outcome inspection without replay, honest paging and malformed data, current management/denial clearing, late private reads/writes after logout, and independent access refresh/reload without operation resend. A final 21-case team-access follow-up passes in 25.8 seconds after disabling mutation-cache retention on unmount. These are mock browser source checks, not actual native or deployed evidence.

Final generation, TypeScript, server vet, whitespace checks and the production web build pass; the build completes in 224 ms. The focused pure validation/boundary suite passes in 0.381 seconds. Temporary server/client registration, Access-panel integration, dependency symlink and Playwright/Vite configurations are excluded from the packet; integration must register the service as managed-browser-only, export its shared client and mount the panel for organization-owned repositories. No native fixture, retained runtime, deployment, inference or repository CI was used.

Temporary API/router/Access-component integration used only for isolated checks is excluded from this packet. Integration still requires the shared API client, protected service registration and Access panel import. The contract above describes the resulting source behavior, not an already deployed feature. Current native/deployed qualification and full Access remain open.

## Primary native sources

- [Pinned repository-team whole collection and repository routes](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/teams.go), `ListTeams` lines 37–54.
- [Pinned TeamRepos GET/PUT/DELETE and native owner/admin checks](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/org/team.go), lines 508–761. The team-repositories collection can trim invisible repositories; its 404 is not used to infer absence here.
- [Pinned route guards](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/api.go), repository teams lines 1203–1208 and team-repository routes lines 1660–1685.
- [Native repository-admin/team-access setting and site-admin alternative](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/models/organization/org.go), `CanChangeRepoTeamAccess` lines 88–94. Golf's initial editor requires actual organization ownership.
