# Golf implementation status

Updated: 2026-10-01. This ledger records evidence for the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md). A plan, compiled source and live provider qualification are different evidence levels. Git history identifies the implementation revision containing this ledger.

## Current delivery

The initial developer slice is implemented: a Go API and React application backed by separate Golf/Gitea PostgreSQL databases, per-user Gitea credentials, encrypted persistent sessions, authorized repository list/create, black/charcoal/light/system themes, live health checks and local Compose installation. Gitea owns Git and collaboration data; Golf does not write Gitea's database or repository files.

Marketing and docs have independent private repositories: [golf-website](https://github.com/mjtechguy/golf-website) (Astro) and [golf-docs](https://github.com/mjtechguy/golf-docs) (Docusaurus/MDX). Both have static production builds and manual Cloudflare configuration. No live Cloudflare site or product service has been deployed by this work. No repository CI workflows were added.

This is **not complete v1**. Kubernetes, OAuth/OIDC, organization roles, connections/import, reviews/protection/merge policy, pipeline execution, agents, Cloudflare resources, email/webhooks and protected deployments remain unimplemented. Gitea capabilities reachable outside Golf are not automatically Golf features.

The two infrastructure tracks remain distinct choices over shared product policy. The portable target runs completely in Docker or Kubernetes and can mix optional Cloudflare backends with other providers. The [competition milestone](COMPETITION_READINESS.md) applies only to the Cloudflare track and requires real Workers, Artifacts and concurrent agents. It is not yet ready.

## Verified local evidence

| Check | Observed outcome | Boundary |
| --- | --- | --- |
| `make check` | Go formatting/vet/tests and frontend typecheck pass | Database integration is explicitly skipped unless its isolated DSN is supplied. |
| `go test -race ./... -count=1` with isolated PostgreSQL | Pass: migration, encrypted sessions, identity persistence, per-user upstream credentials, create, logout and revocation | Real PostgreSQL 18.4; Gitea HTTP fixture for this test. Disposable DB removed afterward. |
| `npm --prefix web run build` | TypeScript and Vite production build pass | Browser bundle only; provider behavior checked separately. |
| `npm --prefix web test` | Four Playwright checks pass | Contract fixtures: token login/failure/no browser credential storage, filters/safe links/themes/mobile, private create errors/refresh/logout, expiry clears private content. |
| `docker compose up -d --build` | Go/React image builds; PostgreSQL/Gitea/Golf start; `/readyz` returns both dependencies ready | Local loopback development profile, not production/HA/Kubernetes. |
| Production-served browser check | Real sign-in and private repository creation render successfully, with no browser runtime errors; charcoal screenshot inspected | Real local Compose backend, ephemeral test user removed. |
| `python3 scripts/smoke.py --restart` | Pass: real Gitea sign-in/create/list, unauthenticated and other-user denial, origin rejection, Git push/ref readback, persistent session/repository after restart, Gitea outage reporting, token revocation and logout | Real pinned Gitea 1.27.3 and PostgreSQL 18.4; temporary test users/repos removed. |
| Website `check`, `build`, `check:links`, `deploy:check`, browser smoke | Pass: 22 static routes, links/fragments/metadata, local Workers routing/404/headers, env/canonical configuration, dark/light desktop/mobile, site search/catalog/explorers/navigation | 21 content pages plus 404, four guides, 38-entry integration catalog and glossary. Fixed port4325; no live provider deployment. |
| Docs `check`, `build`, `check:build`, Wrangler dry-run and browser/version drill | Pass: strict links, dark/light desktop/mobile navigation, disposable latest/next/older snapshots and selector, agent-readable version index, static deployment bundle and local Workers asset routes/404/headers; dependency audit zero findings | Only development docs are committed; disposable snapshots removed. Real release required before version publication. |

The real provider check established Gitea's minimum scope combination: browsing uses `read:user,read:repository`; repository creation uses `write:user,write:repository`. Both route scopes are required by Gitea 1.27.3. UI and setup instructions expose that distinction; an insufficient token correctly receives a denied operation.

The Git transport check uses `git push` and `git ls-remote` to compare the exact commit. A separate immediate branch-detail API probe returned a Gitea 500 during initial push processing; that route is not exposed by Golf's current UI. Qualify its readiness/error behavior before adding branch browsing. Do not count current repository listing as proof of every Gitea API path.

## Initial decisions and limits

See [ADR 0001](decisions/0001-initial-forge-and-vertical-slice.md). Narrow JSON endpoints are the initial vertical slice; planned Connect/generated contracts, sqlc and wider service interfaces remain future work. AES-GCM protects the stored upstream credential using the configured key, with authenticated session binding. Rotation, external secret stores and FIPS are not claimed. Initial authentication is a Gitea token exchange, not Golf OAuth or complete local-account lifecycle.

Local HTTP requires explicit loopback-only insecure-cookie configuration. Remote deployment requires HTTPS. Credentials stay server-side, cookies are HttpOnly/SameSite, state-changing requests require the exact configured Origin, and authenticated upstream redirects are refused. These controls and tests do not constitute a full security audit.

The Compose installation uses separate database roles, a non-root Golf runtime and persistent PostgreSQL/Gitea volumes. Backups, production TLS, rolling upgrades, replica fencing and a recovery runbook still need qualification. Gitea Actions is disabled; implementing Golf pipeline ingestion later does not authorize adding CI to this repository now.

## Task progress

| Plan task | State for this increment | Remaining work |
| --- | --- | --- |
| P0.1 | Initial layout, private repos, local checks and ledger implemented | Broader contract/version inventories grow with supported features. |
| P0.2 | Full dated [guide source register](TECHNOLOGY_GUIDE_REGISTER.md): 81 grouped prescriptions, all chapters and ADRs reviewed | Review/accept pending ADR dispositions and executable acceptance obligations; complete implementation conformance at the relevant milestones. |
| P0.8 | Shared Gitea decision and basic API integration verified | Protected-write/conditional-merge proof, full API ownership/license/recovery qualification. |
| P0.3 / P1.1 | Narrow auth/repository REST contract and real DB migration verified | Planned generated Connect clients/contracts and wider schema. |
| P1.2 / P1.8 | Per-user token session slice verified | OAuth/OIDC, org/team roles, service/Git credentials, MFA/recovery and account lifecycle. |
| P1.4 | Real-data repository UI and themes verified | Issue/review/pipeline/task/deployment surfaces as their backends exist. |
| P1.5 | Local Compose verified | Helm/Kubernetes install, production profiles and provider capability qualification. |
| P2.1 / P2.2 | List/create through scoped Gitea APIs verified | Full Git/collaboration surface and review flows. |
| W1 / W2 / W4 | Separate static site implementations and local builds/dry-runs | Actual public origins, deployment, full feature guides and release operations. |
| W3 / W5 | Version policy, source ownership and public-content rules documented | First real product release, generated-contract import and continuing maintenance. |

## Next work and release gates

1. Resolve the guide register’s pending ADRs and Gitea policy qualification, then extend useful identity/repository/collaboration behavior. Never enforce a Golf restriction solely in the UI while other Gitea writes bypass it.
2. For the **Cloudflare competition track**, pull forward the smallest real Worker/Artifacts task flow: scoped forks, two overlapping supported agents, cancellation, exact-commit test evidence, comparison and conflict-aware integration. Follow the [requirements/evidence matrix](COMPETITION_READINESS.md); a static website or provider logo is not proof.
3. For the **portable track**, package the same core for Kubernetes and qualify local/customer execution. Keep all required core behavior usable without Cloudflare or inference; optional backends can be selected individually.
4. Qualify Actions/GitLab engine subsets and five harness/auth combinations using actual positive/negative lifecycle checks. No adapter placeholders may report ready.
5. Add protected previews/CD, email/webhooks, observability and recovery as real independently verified behavior. Preserve exact source/output identity and deny unauthorized promotion.
6. Complete the two-track installation, migration, no-AI, security/retention, backup/restore, upgrade and load/cost gates before claiming v1, scale or superiority.

Provider credentials, domains, account entitlements, production resources and Kubernetes access are not assumed. Later work can proceed independently until a concrete provider proof needs those inputs; record unavailable capabilities accurately.
