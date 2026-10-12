# 0007: PostgreSQL authority, independent database operators and optional Valkey

Status: accepted architecture; production environment qualification remains required.

The 2026-10-07 user decision targets fully Cloudflare-native managed SaaS. [ADR0008](0008-cloudflare-native-saas-ownership.md) records the selected destination and proposed native ownership/cutover. This ADR's PostgreSQL authority remains the current portable and migration-bridge contract; it is not a permanent requirement of the future native managed service.

Golf already relies on PostgreSQL transactions for sessions, actor-bound authorization, policy revisions, audit events, execution admission and durable queue state. Moving those controls into an optional cache would introduce another failure and consistency boundary. PostgreSQL stays authoritative on both infrastructure tracks. CloudNativePG owns database replication/failover in Kubernetes; Barman Cloud Plugin owns physical backup/WAL storage. They are platform releases independent of the Golf application chart.

Valkey can later accelerate hot read metadata, rate-limit counters and disposable coordination where failure behavior is defined. No active core consumer requires it today, so this profile does not install it or advertise a functional cache integration. Introducing it requires measured benefit, explicit namespace/tenant separation, TTL/eviction limits, TLS/auth, failure fallback and tests; durable policy, session revocation and jobs must still reconcile against PostgreSQL. This avoids turning a speed option into a portable-core prerequisite.

| Deployment | Authoritative database | Application objects / backups | Valkey |
| --- | --- | --- | --- |
| Local Docker Compose | Existing PostgreSQL service | Local objects or explicitly selected RustFS S3 adapter; backup qualification separate | Optional, no current core dependency |
| Self-host Kubernetes | This independent CNPG profile or operator-provided external PostgreSQL | RustFS upstream chart, or another qualified S3 endpoint; Barman physical backups use a separate prefix | Optional external accelerator after consumer implementation |
| Generic cloud | Managed/external PostgreSQL with verified TLS and independent backup ownership | Provider S3-compatible endpoint; credential and lifecycle policy explicit | Optional managed/self-host service |
| Cloudflare-focused | PostgreSQL remains authoritative; Hyperdrive is a separately qualified connection optimization | R2 for supported object consumers; R2 Barman WAL/base/restore qualification remains separate | Optional provider/external service, not necessary to use Cloudflare |

Cloudflare does not supply a drop-in PostgreSQL persistence service through Hyperdrive: it connects Workers to a database. D1, KV, Durable Objects and other Cloudflare features may support their planned, qualified responsibilities, but do not silently replace the native forge databases or portable PostgreSQL authorization contracts. The Cloudflare track may use external infrastructure for native Git/SSH, database and runner workloads. The portable track must operate without Cloudflare.

CNPG three-instance synchronous topology favors durability; it requires independent failure domains and sufficient standby capacity. The standalone RustFS fixture is a compatibility proof, not an HA storage design. Physical database restore does not restore Git repository files, object stores or Golf encryption/credential state by itself. Production recovery continues to require the whole-system drain, consistency, quarantine and credential checks in [RECOVERY.md](../RECOVERY.md).

The deployable companion profile and executable qualification gates are documented in [CNPG README](../../deploy/kubernetes/cnpg/README.md). Upstream APIs: [CNPG role management](https://cloudnative-pg.io/docs/1.30/declarative_role_management/), [Database management](https://cloudnative-pg.io/docs/1.30/declarative_database_management/), [Barman plugin](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), [RustFS Helm](https://docs.rustfs.com/en/installation/cloud-native), [Hyperdrive overview](https://developers.cloudflare.com/hyperdrive/).
