# Golf portable core Helm chart

This chart installs the current Golf Go/React application, its Gitea backend and optional PostgreSQL. It has no Cloudflare or inference dependency. It does not install runners, agent services, object storage, background workers or other unimplemented roadmap features. P1.5 qualification is recorded in the repository's [implementation status](../../../docs/IMPLEMENTATION_STATUS.md); successful rendering alone is not Kubernetes qualification.

The chart requires Kubernetes 1.32 or later and an existing storage provisioner when bundled persistence is enabled. Local chart checks use Helm 4.2.1. Gitea is qualified at `1.27.3-rootless`; PostgreSQL is pinned to `18.4-alpine3.24`. Golf has no default image: supply an explicit built tag or digest. A digest replaces the tag, so set `image.tag: ""` when setting `image.digest`. Image overrides must retain the qualified build, runtime users and filesystem layout; a digest alone does not establish compatibility.

## Required configuration and Secrets

Set `image.repository`, exactly one of `image.tag` or `image.digest`, `publicURL`, `gitea.publicURL`, and `existingSecret`. Both public URLs are origins without paths, credentials, queries or fragments. Use distinct hostnames when the chart manages ingress. HTTPS is required outside explicit loopback development. Release names are limited to 45 characters so generated resource names remain valid.

The chart **never creates Secrets**, embeds credential values in manifests, reads them into Helm release values, or generates production credentials. Provision a Secret in the release namespace through your normal secret-management process. Do not pass secret values with `--set`, commit them in values files, or rely on Kubernetes Secret base64 encoding as encryption at rest.

| Secret key | Required when | Meaning |
| --- | --- | --- |
| `GOLF_ENCRYPTION_KEY` | Single-key/legacy configuration, or retained legacy ciphertext | Canonical padded base64 encoding of exactly 32 random bytes; registers the `legacy` label. Preserve material required by stored credentials/backups. |
| `GOLF_ENCRYPTION_KEYS` | JSON keyring configuration | JSON label-to-base64-key map, at most 16 total keys. Each value is exactly 32 random bytes; duplicate/rebound labels are rejected. |
| `GOLF_ACTIVE_ENCRYPTION_KEY` | JSON keyring configured | Write label present in that keyring and matching the activated database policy. |
| `DATABASE_URL` | Always | Complete PostgreSQL DSN for the `golf` role/database, with a URL-encoded password and explicit TLS mode. |
| `POSTGRES_PASSWORD` | Bundled PostgreSQL | PostgreSQL administrative password; never used by Golf or Gitea. |
| `GOLF_DB_PASSWORD` | Bundled PostgreSQL | Password used once to create the independent `golf` role. It must agree with `DATABASE_URL`. |
| `GITEA_DB_PASSWORD` | Bundled PostgreSQL or bundled Gitea | Independent Gitea database role password. |
| `GITEA_OAUTH_CLIENT_ID` | `oauth.enabled: true` | Existing confidential Gitea OAuth application ID. |
| `GITEA_OAUTH_CLIENT_SECRET` | `oauth.enabled: true` | That application's secret. |

For release `golf-dev`, the bundled DSN host is `golf-dev-golf-postgres:5432`, database and role `golf`. Gitea uses database/role `gitea`. The bundled initialization file is an exact copy of [the Compose initializer](../../postgres/init.sh); `check.py` rejects divergence. Initialization runs only on a fresh PostgreSQL volume. Updating a Secret does **not** alter existing database passwords. Coordinate real role/client changes with Secrets and restart affected workloads; key changes require the explicit drained activation and re-encryption procedure, not an ordinary rolling update.

Encryption Secret references are individually optional so legacy-only and full-keyring installations can use the same chart; **a valid encryption configuration is still mandatory at runtime**. Other required missing Secret entries prevent affected Pods starting. Helm cannot validate private key contents, stored material bindings or whether an external DSN matches the configured endpoints. Runtime configuration validation and `/readyz` remain authoritative.

All Golf replicas must share the same label/material mapping and database active policy. A fresh JSON-only keyring with a nonlegacy active label requires an operator activation before normal server startup. Drain all old application writers and in-flight OAuth exchanges before activation; the chart does not automate this maintenance boundary. Secret updates do not change running environments, and a database write fence cannot reverse an external refresh. Follow the [credential keyring contract](../../../docs/CREDENTIAL_KEYRING.md) for server-operator commands, bootstrap metadata writes, partial rotation and retirement checks. This packaging does not qualify Kubernetes key cutover or transparent rolling rotation.

## Disposable local installation

Use an explicitly selected local cluster and context; these commands do not change your current kubectl context. Create/import the Golf image using your cluster's normal image workflow first. The local profile below is for loopback port-forwarding only.

```sh
export KUBECONFIG=/absolute/path/to/dedicated-kubeconfig
export KUBE_CONTEXT=your-dedicated-local-context
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" create namespace golf-dev
```

For this disposable development namespace only, the following Python snippet creates a private temporary Secret manifest with fresh local credentials. It prints no credential values and refuses to overwrite an existing file. Production installations should obtain credentials through their established secret-management process.

```sh
python3 - <<'PY'
import base64, json, os, secrets
passwords = {key: secrets.token_urlsafe(32) for key in (
    "POSTGRES_PASSWORD", "GOLF_DB_PASSWORD", "GITEA_DB_PASSWORD")}
passwords["GOLF_ENCRYPTION_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
passwords["DATABASE_URL"] = (
    "postgresql://golf:" + passwords["GOLF_DB_PASSWORD"] +
    "@golf-dev-golf-postgres:5432/golf?sslmode=disable")
secret = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
          "metadata": {"name": "golf-existing", "namespace": "golf-dev"},
          "stringData": passwords}
fd = os.open("/tmp/golf-k8s-secret.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump(secret, output)
PY
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" apply -f /tmp/golf-k8s-secret.json
rm /tmp/golf-k8s-secret.json
```

Create `/tmp/golf-dev-values.yaml` with configuration references only, replacing the example image tag with the image you built/imported:

```yaml
image:
  repository: golf-local
  tag: your-built-commit
existingSecret: golf-existing
publicURL: http://localhost:8086
allowInsecureCookies: true
gitea:
  publicURL: http://localhost:3006
  sshPort: 2226
```

```sh
helm upgrade --install golf-dev ./deploy/helm/golf \
  --kubeconfig "$KUBECONFIG" --kube-context "$KUBE_CONTEXT" \
  --namespace golf-dev -f /tmp/golf-dev-values.yaml --wait --timeout 10m
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" -n golf-dev \
  port-forward service/golf-dev-golf 8086:8080
```

In another terminal, forward `service/golf-dev-golf-gitea` with `3006:3000 2226:2222` using the same kubeconfig/context/namespace. Open `http://localhost:8086` exactly: Golf's RPC Origin checks deliberately reject a different browser origin. Registration is disabled and installation is locked. Bootstrap a Gitea user through its supported administrative CLI, with privately supplied credentials, then use PAT sign-in. The repository's Kubernetes smoke harness demonstrates temporary-user provisioning and cleanup without exposing credentials.

For OAuth, first register a confidential Gitea application with the exact callback `http://localhost:8086/auth/gitea/callback`, add its ID and secret to the existing Secret, and set `oauth.enabled: true`. Production uses the corresponding HTTPS callback. The current flow requests `write:user`, `write:repository`, `read:issue` and `read:organization`; see the [OAuth decision](../../../docs/decisions/0003-gitea-oauth-and-session-refresh.md).

## Production and external dependencies

The bundled database is one persistent PostgreSQL instance, not an HA database or a managed backup system. Prefer an operator-managed/external database when that meets your reliability requirements. Provision separate `golf` and `gitea` roles/databases, assign least privilege, and use their distinct credentials. `DATABASE_URL` configures Golf; `gitea.database.*` configures internal Gitea independently. External databases must be reachable through explicit policy rules; use certificate-verified TLS with a trusted CA. Private CA injection is not packaged by this initial chart.

Example configuration for **internal Gitea with external PostgreSQL** (replace the illustrative private subnet with your database's actual route):

```yaml
image:
  repository: registry.example.com/golf
  tag: your-reviewed-commit
publicURL: https://golf.example.com
existingSecret: golf-production-existing
postgresql:
  enabled: false
gitea:
  publicURL: https://git.example.com
  database:
    host: postgres.internal.example.com:5432
    name: gitea
    user: gitea
    sslMode: verify-full
networkPolicy:
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/component: controller
  externalEgress:
    - to:
        - ipBlock:
            cidr: 10.20.30.0/24
      ports:
        - protocol: TCP
          port: 5432
ingress:
  enabled: true
  className: nginx
  tlsSecret: golf-existing-tls
```

The TLS Secret must already contain a certificate covering both public hostnames. Configure DNS and the actual ingress-controller/LB outside this chart. Chart ingress handles HTTP(S), including Git smart HTTP; it does not expose SSH through HTTP Ingress. SSH has an internal ClusterIP service port `2222`; arrange an explicit TCP endpoint separately and set `gitea.sshPort` to its public port before advertising SSH clone URLs. No DNS or TLS issuance is claimed.

For **external Gitea and external PostgreSQL**, additionally set:

```yaml
gitea:
  enabled: false
  publicURL: https://git.example.com
  externalURL: https://git.internal.example.com
  qualifiedVersion: "1.27.3"
postgresql:
  enabled: false
```

Provide the Golf DSN in the existing Secret and permit both actual destinations in `networkPolicy.externalEgress`. No Gitea StatefulSet/service/PVC, PostgreSQL StatefulSet/service/PVC, or database initializer is created. Golf still verifies the actual Gitea version at runtime; `qualifiedVersion` is an explicit supported-version constraint, not a mocked readiness signal.

A second Golf release can use the first release's canonical Gitea and database. Grant its labeled Golf Pods access through the canonical release's `networkPolicy.giteaIngressFrom` and `postgresIngressFrom`; set corresponding egress selectors in the second release. These fields accept standard Kubernetes NetworkPolicy peers/rules. Selectors without a namespace selector match only the current namespace. All Golf replicas for the same installation must agree on public origin, forge URL, database, encryption keyring/active policy and OAuth client. Do not point two independently writing Gitea installations at the same repository volumes.

## Persistence, updates and network boundaries

Gitea has exactly one canonical writer: one StatefulSet replica with separate data/config RWO claims. PostgreSQL has one replica and a claim mounted at the PostgreSQL 18 parent `/var/lib/postgresql`. Ordinary single-replica StatefulSet rolling updates terminate the old Pod before replacement; they may cause downtime. Scale only Golf with `replicaCount`.

**StatefulSet identity and ReadWriteOnce do not provide node-partition fencing.** RWO can allow multiple Pods on the same node. Never force-delete a stateful Pod or force-replace these resources while an old writer may still reach the storage. Establish external node/storage fencing first. This chart does not claim Gitea HA, safe forced failover, or protection from an operator manually scaling the Gitea StatefulSet. See [Kubernetes' force-deletion guidance](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/).

The three claim templates explicitly retain PVCs on deletion/scaling. Helm uninstall removes workloads but retains data. A reinstall with the same namespace/release name and compatible claims can reattach it; keep the original database passwords and encryption key. Retention is not backup: namespace deletion or explicit PVC deletion can still remove storage. Test backup/restore with your storage provider.

StatefulSet claim-template size/class edits generally cannot be applied as ordinary Helm upgrades. Expand existing PVCs only through a storage class that supports expansion and an operator-reviewed procedure, or migrate volumes. Do not use `helm --force` as a routine workaround. Helm rollback restores resource configuration, **not** Golf/Gitea/PostgreSQL schema changes or lost repository data. Check supported version transitions and backups before image/database upgrades.

Pods run without service-account tokens or Linux capabilities, under non-root users and read-only root filesystems, with explicit writable PVC/temporary mounts, resource bounds and probes. Network policies deny unlisted ingress and egress; their enforcement depends on an enforcing CNI. Empty `ingressFrom` denies public pod traffic while allowing the internal core connections. `kubectl port-forward` bypasses the normal ingress path and is not evidence that NetworkPolicy is enforced. The real smoke test also probes denied access from an unlabeled Pod. For external services, explicitly allow the actual resolved destinations; DNS permission alone does not grant endpoint access.

## Local checks

```sh
HELM=/path/to/helm python3 deploy/helm/golf/check.py
```

This runs strict lint, bundled/external/OAuth/ingress/multiple-Golf render checks, invalid-configuration tests, and initializer source-consistency checks without credentials, a Kubernetes context, or cluster mutations. The repository's isolated Kubernetes smoke script supplies the separate real installation, session/repository persistence and network-policy evidence. No repository CI is installed.
