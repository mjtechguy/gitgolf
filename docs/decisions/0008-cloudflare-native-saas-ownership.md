# 0008 Cloudflare native SaaS ownership and migration

Status: product destination and first-release defaults selected by the user on 2026-10-07; native storage/coordination design proposed, pending qualification. This does not enable native tenants or move live authority.

## Destination

The managed SaaS targets fully Cloudflare-native hosting. The existing Gitea/Go/PostgreSQL core is the migration bridge, and remains the independent portable implementation. This refines ADR0001/ADR0007 for the future managed destination; their current database and forge ownership continues until an explicit qualified cutover.

Selected defaults: organization/workspace tenancy with personal workspaces; Golf-managed application resources first, customer accounts next; private previews restricted to current repository readers; Artifacts canonical Git first for eligible repositories; repositories, permissions, issues, PRs, reviews, checks, agents and previews as the first native collaboration milestone; automatic eligible PR previews within an operator-approved resource policy and budget. Production approvals remain separate.

## Proposed ownership

| Responsibility | Proposed native owner | Qualification boundary |
| --- | --- | --- |
| Workspace identity, membership, repository policy and durable collaboration | Partitioned D1 records under Golf APIs. | Current-authority reads, versioned updates, SQL transactions and tenant isolation; no drop-in PostgreSQL migration claim. |
| Repository/task Git | Artifacts, with Golf controlling canonical write ingress. | Expected source/base/ref semantics, token fencing, protection, history/blob admission and export/recovery. |
| Run/session/environment coordination and live fan-out | Scoped Durable Objects. | One owner per lease/transition; cancellation, expiry and replay cannot advance stale attempts. |
| Provisioning and deployment steps | Workflows for a recorded authorized Golf intent. | Provider readback and durable stage reconciliation; orchestration does not grant permission. |
| Background delivery | Queues carrying recorded work/event IDs. | At-least-once deduplication, durable intake/ACK, bounded consumers and backpressure. |
| Immutable binary outputs and evidence | Private R2 with digest and account/resource locator. | Verified bytes, retained authorization, isolation, retention and recovery. |
| Public/read projections and retrieval | KV/AI Search/Vectorize as derived stores. | Current source permissions before disclosure; no lease or approval authority. |

Start with an explicit workspace partition, not one global metadata database. Repository/project partitions may own heavier records independently when capacity or workload requires them. Define the cross-partition operation contract before splitting an authoritative transaction. D1's current 10 GB limit and serial query execution apply per database. Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Do not treat a DO lock and D1 transaction as one atomic operation. The final native authority design must specify who serializes membership/policy revocation against repository effects, which fresh authority observations are required, how fencing survives restart, and how uncertain provider effects are inspected. Workspace-wide revocation racing a repository-local publication is a required qualification case. Until that boundary is proven, native protected publication is unavailable.

Every native write carries immutable workspace/repository/actor/operation identity and the exact expected revisions. Workers cannot accept client-supplied provider account IDs or credentials as an authority grant. Provider tokens are broker-held; canonical Artifacts write tokens are not delivered to unrestricted agents or Git clients. Task-fork credentials remain separately scoped and expiring.

## Preview admission

Authenticated PR events are evidence to resolve under current automation authority. Freeze source/configuration, account/namespace, environment policy, output digest and approved resource plan. Changes outside the approved resource/budget envelope require a new reviewed plan. Latest eligible source selection fences earlier deployments and PR link writes. Revocation, cancellation or exhausted reservations withholds later effects; original operation inspection and owned cleanup remain possible.

On 2026-10-08 the user selected `previews.mjtechguy.com` with separate per-preview hostnames and Golf-backed short-lived reviewer grants. Cloudflare Access is the outer authentication gate; Golf retains current repository-reader authorization. Integrate Golf identity using the native Access OIDC contract, keeping the preview-scoped grant separate from Access identity tokens and machine credentials. The existing portable grant/session checks are reusable, but do not qualify this Cloudflare path.

Access configuration and cached read permissions cannot replace the current repository-reader policy. Qualify reviewer identity mapping, revocation and every provider/custom hostname before declaring a link ready. Machine tests use distinct short-lived preview scopes. The initial operator-only qualification Worker is not this product authorization layer.

## Migration

1. Qualify a disposable workspace and complete native collaboration loop against the shared domain/API contract.
2. Preflight every repository's complete history/blob limits and the tenant's required features. Keep ineligible tenants on the bridge with a visible reason.
3. Export supported canonical Git and collaboration/identity mappings through supported source interfaces. Define attachment/LFS, review/check and credential handling independently.
4. Drain writers, freeze the original owner, transfer and verify exact identities/history/content, then activate one new writer. Connected GitHub/GitLab repositories retain their own canonical owner until separately migrated.
5. Quarantine restored credentials, approvals, leases and pending intents. Ambiguous effects require inspection, not automatic replay.
6. Qualify export, recovery and the rollback boundary before admitting production tenants. A rollback after native writes needs a new verified transfer rather than reopening stale origin writers.

Artifacts is a Git service, not an implementation of issues, PRs or permissions. Its present limits are 1 GB per repository and 32 MB per blob. Larger canonical repositories remain on the bridge until a Cloudflare-native path qualifies. Container disk snapshots or an unqualified R2 filesystem do not establish safe canonical Git persistence. Sources: [Artifacts](https://developers.cloudflare.com/artifacts/), [limits](https://developers.cloudflare.com/artifacts/platform/limits/), [Containers storage](https://developers.cloudflare.com/containers/faq/).

## Current implementation boundary

Encrypted/versioned product Cloudflare profiles and the operator D1/R2 allocation consumer are implemented. Bounded native Worker/R2/Artifacts agent-fork proofs and one protected static preview pass within their documented scopes; they do not establish canonical Git migration or native forge authority. The [foundation contract](../CLOUDFLARE_FOUNDATION_CONTRACT.md) and [status ledger](../IMPLEMENTATION_STATUS.md) distinguish product consumers from fixture/provider proofs.

The separate [Cloudflare bridge setup](../CLOUDFLARE_SETUP.md) serves the existing UI from Workers and retains Go/Gitea/PostgreSQL authority behind protected origin connectivity. It is source/local-runtime qualified, not live deployed. The selected public name is now `gitgolf.mjtechguy.com`; preview naming is unchanged. Canonical Artifacts Git, D1 collaboration and native authorization remain required before this destination can replace the bridge. The user's explicit Git-in-Artifacts clarification reinforces this boundary.
