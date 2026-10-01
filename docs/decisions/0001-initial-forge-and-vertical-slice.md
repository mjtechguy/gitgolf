# Initial forge and executable slice

Status: accepted implementation baseline, 2026-10-01.

Golf initially uses Gitea as a separately operated internal forge on both infrastructure tracks. Golf owns its interface and developer automation/delivery experience. Gitea owns repository and collaboration data. Its supported API is the integration boundary; direct database or repository mutations are excluded. A separate Golf-native forge is deferred.

The first executable slice provides user-scoped Gitea token sign-in, repository listing/creation, a dark/light interface, persistent PostgreSQL sessions and a local Compose deployment. It verifies the basic user-to-Gitea authorization flow before adding broader integrations. It does not complete the plan's local/OIDC/OAuth identity, organization policy, Connect API or CI/agent requirements.

## Narrow initial departures

The browser uses a small same-origin REST surface for this slice. The planned generated Connect API remains a later implementation task; these initial endpoints are not a stable public API. Preserve the tested authentication and authorization behavior when introducing the versioned API.

Tokens held by the server are encrypted using AES-256-GCM with an operator-supplied random 32-byte key. The key is configured outside the database, sessions use opaque cookies, and the original token never returns to browser storage. This is a narrowly documented departure from the guide's age default. It does not establish a FIPS distribution or implement the roadmap's full key rotation/envelope-key system. Key backup, secrecy and stable reuse across restarts are necessary for this slice.

Gitea token sign-in is a bootstrap integration, not a claim of completed OAuth login or enterprise identity. Each user supplies their own appropriately scoped Gitea token. The upstream token's permissions remain an upper bound. Session security is enforced locally; upstream revocation must prevent further repository access.

No repository CI workflows are added. Build, unit, integration and browser checks run locally. Golf's future pipeline execution product remains in scope.

## Acceptance

Run the real PostgreSQL/Gitea/Go/React stack. Verify unauthenticated access fails; user-scoped repository list/create succeeds; a second user cannot see a private repository; sign-out and upstream token revocation prevent further access; sessions survive a normal application restart; dark/light selection works; provider outage is visible; and no source file contains a credential.

Record exact checks and any unavailable scenarios in the implementation ledger. Do not mark whole roadmap tasks complete from this slice alone.
