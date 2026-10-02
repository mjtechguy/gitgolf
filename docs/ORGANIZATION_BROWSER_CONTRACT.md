# Organization and team browsing

This increment exposes the signed-in user's Gitea organization memberships, provider-visible teams, team members and assigned repositories through Golf's generated API, typed browser routes and read-only CLI. It does not create a second membership database, implement Golf role administration, or close local/OIDC identity and account-recovery requirements. Both infrastructure tracks use the same authorization path.

## API and navigation

`golf.v1.OrganizationService` provides `ListOrganizations`, `GetOrganization`, `ListTeams`, `GetTeam`, `ListTeamMembers` and `ListTeamRepositories`. Organization names are validated path components. Team IDs are canonical positive signed-64-bit decimal strings, preserved as strings by clients. Organization/team visibility and native permission levels are typed enums; unknown provider values fail visibly.

The workspace **Organizations** link opens `/organizations`. Organization details use `/organizations/:organization`; `?team=:id` selects a team. The typed router preserves team IDs, back/forward history, reload and direct navigation. Assigned repository links open the existing immutable source browser, which independently authorizes repository/code access.

All lists use the shared page/limit contract: page1/limit20 defaults, page10000/limit100 ceilings, and explicit `nextPage`. The final supported page fails visibly if the provider reports more results. Gitea can filter inaccessible team repositories *after* calculating pagination: an empty page may still have another page. Golf preserves that next-page indication and does not expose unfiltered provider totals. Counts in the UI describe loaded visible results, not total organization membership or assignments.

The CLI exposes `org list`, `org view ORGANIZATION`, `org teams ORGANIZATION`, `team view ORGANIZATION TEAM_ID`, `team members ORGANIZATION TEAM_ID` and `team repos ORGANIZATION TEAM_ID`. Collection commands accept explicit `--page`/`--limit`; IDs retain their decimal-string representation. Commands reuse per-user bootstrap and remove the temporary Golf session before emitting success JSON. They store no credentials and provide no managed OAuth login.

## Membership and identity

Every RPC requires the exact configured Origin before request decoding and an active opaque Golf session. The read path obtains the actual provider user and compares its immutable ID with the session's stored forge identity. Local expiry and revocation are checked again after provider calls, without holding database locks during network waits.

Organization detail and nested reads require an actual `204` from the provider's self-membership check. Public organization metadata, a public team, or site-administrator visibility is insufficient. Membership is checked before and after nested provider reads. General organization metadata must identify the requested organization; a team's returned immutable organization ID must match it. A valid team ID from another organization does not bypass this binding.

Native team visibility remains enforced through Gitea's per-user API: private teams are visible to their members/organization owners, limited teams to organization members, and public teams to signed-in users. Golf's organization browser additionally requires organization membership. The labels describe provider settings and are not grants to the Golf page.

No administrator token substitutes for an ordinary user. Golf does not read or write Gitea's database or canonical repository files. Provider membership and PostgreSQL session state cannot be verified atomically; revocation applies at subsequent authorization checks and does not cancel an already-authorized in-flight response. This increment adds no cross-request authorization cache.

## Scope and permission metadata

PATs need `read:user` and `read:organization` for organization browsing; opening repository source separately needs `read:repository`. The `/user/orgs` route checks both user and organization scopes. Missing scope is an explicit permission error, not an empty successful collection.

Configured browser OAuth now requests `read:organization` in addition to its existing user/repository/issue scopes. Existing grants lacking that scope remain denied for organization reads. Gitea can reuse an existing confidential-client grant without new consent; revoke Golf’s grant in Gitea Settings → Applications, then sign in through Golf and approve the new scopes. Refresh does not silently broaden consent; repository operations retain their existing scope behavior.

Team `permission`, `unitPermissions`, `includesAllRepositories` and visibility are native provider observations. They are not a calculated effective Golf role. Grants can combine across memberships; the legacy team permission can be `none` while unit permissions grant reads or writes. Gitea issue-read can permit reporting/commenting, and repository admin includes deletion. The [role qualification](GITEA_IDENTITY_ROLE_QUALIFICATION.md) records the mappings Golf must preserve or reject before implementing role mutations.

## Browser and acceptance boundaries

Private queries are keyed by user, organization and team, are abortable, and are removed after their view closes. Loading/refetch/error states hide prior private content; an unauthenticated response uses the existing global sign-out/query-removal path. Membership denial hides nested team/member/repository content. Provider descriptions and user names render as plain text. No session or organization metadata is stored in localStorage.

The runnable real-provider check is:

```sh
make cli
python3 scripts/organizations-smoke.py --cli bin/golf
```

It creates disposable ordinary users, private/public organizations, visible/hidden teams and assigned repositories through supported APIs. It checks pagination, public nonmember denial, cross-organization IDs, private-team visibility, native unit metadata, missing scopes and subsequent membership revocation. With `--cli`, it exercises all six CLI commands, pagination, hidden/foreign team denial, missing scope, membership revocation and temporary-session cleanup. It also drives the production-served browser through real sign-in, typed deep links/reload, repository navigation, dark/light/mobile presentation and private-data removal after provider membership deletion. Fixtures are purged afterward; screenshots live under ignored `.tmp/organization-smoke/`. The implementation ledger records the actual run outcomes separately from this contract.

Organization/team creation, invitation, membership/role changes, service identities, Golf local/OIDC identity, recovery, audit and protected collaboration remain required future work. Provider capabilities alone do not complete those tasks.
