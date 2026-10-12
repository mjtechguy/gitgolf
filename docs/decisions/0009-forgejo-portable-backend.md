# Forgejo as the portable backend

Status: accepted product direction, 2026-10-11; foundation implemented and locally
qualified. Retained migration/cutover remains blocked; see [current setup and
limits](../FORGEJO_SETUP.md).

The user selected a transition away from Gitea. Forgejo becomes the target forge
for new local/Docker/Kubernetes installations and the origin-backed bridge.
This supersedes the Gitea-default choice in [ADR 0001](0001-initial-forge-and-vertical-slice.md)
for future implementation. It does not change an existing installation today.

Golf retains its shared interface, generated API, supported-protocol integration,
current authority checks and execution coordinator. The Cloudflare-native target
in [ADR 0008](0008-cloudflare-native-saas-ownership.md) remains Artifacts/D1/Workers.
CFCR remains a separate registry. No server, database or runner replacement is
implied on the native Cloudflare path.

Current source pins Gitea 1.27.3. Forgejo's documented transparent upgrade path
ends at Gitea 1.22, so existing data requires fresh-target transfer and explicit
identity/fidelity qualification. An image swap over the existing database is
excluded. [Upstream upgrade guide](https://forgejo.org/docs/latest/admin/upgrade/).

Qualify the reviewed Forgejo 15.0 LTS patch/image first. Keep Gitea only for
transition, historical recovery and rollback; do not create a permanent parallel
provider feature roadmap. Missing supported operations block the affected release
or migration rather than weakening Golf contracts. Historical evidence remains
attributed to the server on which it was collected.

The [execution plan](../FORGEJO_MIGRATION_PLAN.md) defines inventories, API/config
work, workflow discovery, data/credential mappings, packaging, recovery, measured
cutover and retirement gates. No live migration is authorized merely by accepting
this direction; implementation and qualification must produce the concrete
cutover artifacts first.
