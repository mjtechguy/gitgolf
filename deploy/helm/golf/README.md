# Golf portable core Helm chart

This chart installs the current Golf Go/React application, its Forgejo backend and optional PostgreSQL. It has no Cloudflare or inference dependency. It does not install runners, agent services, object storage or general execution services. An optional webhook-processing worker is available for qualified connected-provider use. P1.5 qualification is recorded in the repository's [implementation status](../../../docs/IMPLEMENTATION_STATUS.md); successful rendering alone is not Kubernetes qualification.

The chart requires Kubernetes 1.32 or later and an existing storage provisioner when bundled persistence is enabled. Local chart checks use Helm 4.2.1. Forgejo is qualified at `15.0.9-rootless`; PostgreSQL is pinned to `18.4-alpine3.24`. Golf has no default image: supply an explicit built tag or digest. A digest replaces the tag, so set `image.tag: ""` when setting `image.digest`. Image overrides must retain the qualified build, runtime users and filesystem layout; a digest alone does not establish compatibility.

## Required configuration and Secrets

Set `image.repository`, exactly one of `image.tag` or `image.digest`, `publicURL`, `forgejo.publicURL`, `forge.instanceID`, and `existingSecret`. Both public URLs are origins without paths, credentials, queries or fragments. Use distinct hostnames when the chart manages ingress. HTTPS is required outside explicit loopback development. Release names are limited to 45 characters so generated resource names remain valid.

The chart **never creates Secrets**, embeds credential values in manifests, reads them into Helm release values, or generates production credentials. Provision a Secret in the release namespace through your normal secret-management process. Do not pass secret values with `--set`, commit them in values files, or rely on Kubernetes Secret base64 encoding as encryption at rest.

| Secret key | Required when | Meaning |
| --- | --- | --- |
| `GOLF_ENCRYPTION_KEY` | Single-key/legacy configuration, or retained legacy ciphertext | Canonical padded base64 encoding of exactly 32 random bytes; registers the `legacy` label. Preserve material required by stored credentials/backups. |
| `GOLF_ENCRYPTION_KEYS` | JSON keyring configuration | JSON label-to-base64-key map, at most 16 total keys. Each value is exactly 32 random bytes; duplicate/rebound labels are rejected. |
| `GOLF_ACTIVE_ENCRYPTION_KEY` | JSON keyring configured | Write label present in that keyring and matching the activated database policy. |
| `DATABASE_URL` | Always | Complete PostgreSQL DSN for the `golf` role/database, with a URL-encoded password and explicit TLS mode. |
| `POSTGRES_PASSWORD` | Bundled PostgreSQL | PostgreSQL administrative password; never used by Golf or Forgejo. |
| `GOLF_DB_PASSWORD` | Bundled PostgreSQL | Password used once to create the independent `golf` role. It must agree with `DATABASE_URL`. |
| `FORGEJO_DB_PASSWORD` | Bundled PostgreSQL or bundled Forgejo | Independent Forgejo database role password. |
| `GOLF_FORGE_OAUTH_CLIENT_ID` | `oauth.enabled: true` | Existing confidential Forgejo OAuth application ID. |
| `GOLF_FORGE_OAUTH_CLIENT_SECRET` | `oauth.enabled: true` | That application's secret. |

For release `golf-dev`, the bundled DSN host is `golf-dev-golf-postgres:5432`, database and role `golf`. Forgejo uses database/role `forgejo`. The bundled initialization file is an exact copy of [the Compose initializer](../../postgres/forgejo-init.sh); `check.py` rejects divergence. Initialization runs only on a fresh PostgreSQL volume. Updating a Secret does **not** alter existing database passwords. Coordinate real role/client changes with Secrets and restart affected workloads; key changes require the explicit drained activation and re-encryption procedure, not an ordinary rolling update.

Encryption Secret references are individually optional so legacy-only and full-keyring installations can use the same chart; **a valid encryption configuration is still mandatory at runtime**. Other required missing Secret entries prevent affected Pods starting. Helm cannot validate private key contents, stored material bindings or whether an external DSN matches the configured endpoints. Runtime configuration validation and `/readyz` remain authoritative.

All Golf replicas must share the same label/material mapping and database active policy. A fresh JSON-only keyring with a nonlegacy active label requires an operator activation before normal server startup. Drain all old application writers and in-flight OAuth exchanges before activation; the chart does not automate this maintenance boundary. Secret updates do not change running environments, and a database write fence cannot reverse an external refresh. Follow the [credential keyring contract](../../../docs/CREDENTIAL_KEYRING.md) for server-operator commands, bootstrap metadata writes, partial rotation and retirement checks. This packaging does not qualify Kubernetes key cutover or transparent rolling rotation.

## Disposable local installation

The [Kubernetes installation guide](../../../docs/KUBERNETES.md) (published at https://docs.gitgolf.app/docs/kubernetes/) is the authoritative step-by-step procedure; this section is a condensed version of it. Use an explicitly selected local cluster and context; these commands do not change your current kubectl context. Build the image with `docker build -f deploy/docker/Dockerfile` and make it available to the cluster first (`k3d image import`, `kind load docker-image`, or a registry the nodes pull from). The local profile below is for loopback port-forwarding only.

```sh
export KUBECONFIG=/absolute/path/to/dedicated-kubeconfig
export KUBE_CONTEXT=your-dedicated-local-context
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" create namespace golf-dev
umask 077
mkdir -p .tmp/kubernetes
chmod 700 .tmp/kubernetes
```

For this disposable development namespace only, the following Python snippet writes a private Secret manifest with fresh local credentials into the ignored `.tmp/kubernetes` directory. It prints no credential values and refuses to overwrite an existing file. Production installations should obtain credentials through their established secret-management process.

```sh
python3 - <<'PY'
import base64, json, os, secrets
passwords = {key: secrets.token_urlsafe(32) for key in (
    "POSTGRES_PASSWORD", "GOLF_DB_PASSWORD", "FORGEJO_DB_PASSWORD")}
passwords["GOLF_ENCRYPTION_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
passwords["DATABASE_URL"] = (
    "postgresql://golf:" + passwords["GOLF_DB_PASSWORD"] +
    "@golf-dev-golf-postgres:5432/golf?sslmode=disable")
secret = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
          "metadata": {"name": "golf-existing", "namespace": "golf-dev"},
          "stringData": passwords}
fd = os.open(".tmp/kubernetes/secret.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump(secret, output)
PY
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" apply -f .tmp/kubernetes/secret.json
```

Store the Secret material securely; do not regenerate it for retained volumes. Create `.tmp/kubernetes/values.yaml` with configuration references only. Replace the image tag with the image you built/imported, and replace the example `forge.instanceID` with a unique lowercase UUID v4 generated once for this installation:

```yaml
image:
  repository: golf-local
  tag: your-built-commit
existingSecret: golf-existing
publicURL: http://localhost:8086
allowInsecureCookies: true
forge:
  instanceID: ba09ae45-092f-4b4d-9e17-c6b848e5d95c
forgejo:
  publicURL: http://localhost:3006
  sshPort: 2226
```

```sh
helm upgrade --install golf-dev ./deploy/helm/golf \
  --kubeconfig "$KUBECONFIG" --kube-context "$KUBE_CONTEXT" \
  --namespace golf-dev -f .tmp/kubernetes/values.yaml --wait --timeout 10m
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" -n golf-dev \
  port-forward service/golf-dev-golf 8086:8080
```

In another terminal, forward `service/golf-dev-golf-forgejo` with `3006:3000 2226:2222` using the same kubeconfig/context/namespace. Open `http://localhost:8086` exactly: Golf's RPC Origin checks deliberately reject a different browser origin. Check `curl --fail http://localhost:8086/readyz`. Registration is disabled and installation is locked. Create a Forgejo user with `forgejo admin user create`, then enroll a mapped Golf account with `golf local-account create` (stdin JSON from a private `.tmp/kubernetes/account.json`) and sign in to Golf with that account's own password. Follow the [account-enrollment commands](../../../docs/KUBERNETES.md#6-enroll-your-first-golf-account). The post-install NOTES print these commands with your release's actual names.

On October 14, 2026 the chart passed one-node Kubernetes runtime proofs: the k3d disposable smoke, and a kind install that covered install, account enrollment, password sign-in, repository push, an idempotent upgrade, restart persistence and enforced NetworkPolicy. Multi-node failover, public ingress/TLS, private-CA rotation and other CNI/storage profiles remain unqualified.

For OAuth, first register a confidential Forgejo application with the exact callback `http://localhost:8086/auth/forgejo/callback`, add its ID and secret to the existing Secret, and set `oauth.enabled: true`. Production uses the corresponding HTTPS callback. The current flow requests `write:user`, `write:repository`, `read:issue` and `read:organization`; see the [OAuth decision](../../../docs/decisions/0003-forge-oauth-and-session-refresh.md).

## Production and external dependencies

The bundled database is one persistent PostgreSQL instance, not an HA database or a managed backup system. Prefer an operator-managed/external database when that meets your reliability requirements. Provision separate `golf` and `forgejo` roles/databases, assign least privilege, and use their distinct credentials. `DATABASE_URL` configures Golf; `forgejo.database.*` configures internal Forgejo independently. External databases must be reachable through explicit policy rules; use certificate-verified TLS with a trusted CA. Private CA injection is supported for external PostgreSQL: `postgresql.existingCASecret` names an existing Secret whose `ca.crt` key is mounted read-only at `/etc/golf/postgres/ca.crt` in Golf, Forgejo and the optional webhook worker, with `SSL_CERT_DIR=/etc/ssl/certs:/etc/golf/postgres`. Set Golf’s DSN to `sslmode=verify-full&sslrootcert=/etc/golf/postgres/ca.crt`. The chart refuses this setting with bundled PostgreSQL.

Example configuration for **internal Forgejo with external PostgreSQL** (replace the illustrative private subnet with your database's actual route):

```yaml
image:
  repository: registry.example.com/golf
  tag: your-reviewed-commit
publicURL: https://golf.example.com
existingSecret: golf-production-existing
forge:
  instanceID: ba09ae45-092f-4b4d-9e17-c6b848e5d95c
postgresql:
  enabled: false
forgejo:
  publicURL: https://git.example.com
  database:
    host: postgres.internal.example.com:5432
    name: forgejo
    user: forgejo
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

The TLS Secret must already contain a certificate covering both public hostnames. Configure DNS and the actual ingress-controller/LB outside this chart. Chart ingress handles HTTP(S), including Git smart HTTP; it does not expose SSH through HTTP Ingress. SSH has an internal ClusterIP service port `2222`; arrange an explicit TCP endpoint separately and set `forgejo.sshPort` to its public port before advertising SSH clone URLs. No DNS or TLS issuance is claimed.

For **external Forgejo and external PostgreSQL**, additionally set:

```yaml
forgejo:
  enabled: false
  publicURL: https://git.example.com
  externalURL: https://git.internal.example.com
  qualifiedVersion: "15.0.9"
postgresql:
  enabled: false
```

Provide the Golf DSN in the existing Secret and permit both actual destinations in `networkPolicy.externalEgress`. No Forgejo StatefulSet/service/PVC, PostgreSQL StatefulSet/service/PVC, or database initializer is created. Golf still verifies the actual Forgejo version at runtime; `qualifiedVersion` is an explicit supported-version constraint, not a mocked readiness signal.

A second Golf release can use the first release's canonical Forgejo and database. Grant its labeled Golf Pods access through the canonical release's `networkPolicy.forgejoIngressFrom` and `postgresIngressFrom`; set corresponding egress selectors in the second release. These fields accept standard Kubernetes NetworkPolicy peers/rules. Selectors without a namespace selector match only the current namespace. All Golf replicas for the same installation must agree on public origin, forge URL, database, encryption keyring/active policy and OAuth client. Do not point two independently writing Forgejo installations at the same repository volumes.

## Persistence, updates and network boundaries

Forgejo has exactly one canonical writer: one StatefulSet replica with separate data/config RWO claims. PostgreSQL has one replica and a claim mounted at the PostgreSQL 18 parent `/var/lib/postgresql`. Ordinary single-replica StatefulSet rolling updates terminate the old Pod before replacement; they may cause downtime. Scale only Golf with `replicaCount`.

**StatefulSet identity and ReadWriteOnce do not provide node-partition fencing.** RWO can allow multiple Pods on the same node. Never force-delete a stateful Pod or force-replace these resources while an old writer may still reach the storage. Establish external node/storage fencing first. This chart does not claim Forgejo HA, safe forced failover, or protection from an operator manually scaling the Forgejo StatefulSet. See [Kubernetes' force-deletion guidance](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/).

The three claim templates explicitly retain PVCs on deletion/scaling. Helm uninstall removes workloads but retains data. A reinstall with the same namespace/release name and compatible claims can reattach it; keep the original database passwords and encryption key. Retention is not backup: namespace deletion or explicit PVC deletion can still remove storage. Test backup/restore with your storage provider.

StatefulSet claim-template size/class edits generally cannot be applied as ordinary Helm upgrades. Expand existing PVCs only through a storage class that supports expansion and an operator-reviewed procedure, or migrate volumes. Do not use `helm --force` as a routine workaround. Helm rollback restores resource configuration, **not** Golf/Forgejo/PostgreSQL schema changes or lost repository data. Check supported version transitions and backups before image/database upgrades.

Pods run without service-account tokens or Linux capabilities, under non-root users and read-only root filesystems, with explicit writable PVC/temporary mounts, resource bounds and probes. Network policies deny unlisted ingress and egress; their enforcement depends on an enforcing CNI. Empty `ingressFrom` denies public pod traffic while allowing the internal core connections. `kubectl port-forward` bypasses the normal ingress path and is not evidence that NetworkPolicy is enforced. The real smoke test also probes denied access from an unlabeled Pod. For external services, explicitly allow the actual resolved destinations; DNS permission alone does not grant endpoint access.

## Local checks

```sh
HELM=/path/to/helm python3 deploy/helm/golf/check.py
```

This runs strict lint, bundled/external/OAuth/ingress/multiple-Golf render checks, invalid-configuration tests, and initializer source-consistency checks without credentials, a Kubernetes context, or cluster mutations. The repository's isolated Kubernetes smoke script supplies the separate real installation, session/repository persistence and network-policy evidence. No repository CI is installed.

## Optional observability

Enable `observability.metrics.enabled` only after adding `GOLF_METRICS_TOKEN` to the precreated Secret. It must contain 32–256 printable ASCII bytes without spaces. The chart exposes a separate ClusterIP port 9090; `observability.metrics.ingressFrom` grants only the named scraper peers when NetworkPolicy is enabled. Empty peers deny scraping. Authenticate with a single bearer header and never add this port to public ingress.

For an external OTLP/HTTP collector set `observability.tracing.endpoint`, `sampleRatio` (0–1), and `insecure` only for explicit plaintext HTTP. Add collector-specific `networkPolicy.externalEgress`. No collector/operator CRDs are required or installed. See [telemetry configuration](../../../docs/OBSERVABILITY.md). Chart rendering is verified separately from live cluster scraping/export.

## Optional outbound webhook worker

Set `webhooks.enabled=true` to launch the separate durable delivery consumer. It uses the selected Golf image and precreated database/keyring Secret, without a control socket, native repository mounts or service-account token. Repository administrators separately create named destinations and authorize background delivery; enabling this workload does not create subscriptions or authorize a destination.

With NetworkPolicy enabled, set `webhooks.httpsEgress` to explicit egress rules for approved receiver addresses on TCP443. An empty list grants no destination traffic. The worker receives DNS and bundled native/PostgreSQL connectivity; external native/database routes use the existing `networkPolicy.externalEgress` rules. The application additionally resolves and pins approved destination addresses, blocks private/metadata networks by default, and refuses redirects. If an operator deliberately authorizes a controlled private receiver, provide the same optional `GOLF_WEBHOOK_EGRESS_POLICY` Secret key to the application and worker and matching narrow network rules. A tenant cannot bypass that policy with a settings checkbox.

Configured/enabled subscriptions are distinct from delivery receipts. Test queues a real attempt; an absent or network-denied worker does not report successful delivery. Observed2xx means receiver acceptance, not downstream completion. Rendering this optional profile does not establish live Kubernetes delivery or latest-schema recovery qualification; see [the outbound contract](../../../docs/OUTBOUND_WEBHOOK_DELIVERY_CONTRACT.md) and implementation ledger.

## October 14 chart hardening

Chart 0.2.0 fences the existing Forgejo UUID and bound API endpoint during upgrades, adds soft hostname spread and a multi-replica Golf-only PodDisruptionBudget, retains a five-second API endpoint drain within the existing graceful shutdown budget, and supports explicit DNS peers (`networkPolicy.dnsPeers`) and read-only external PostgreSQL CA Secrets (`postgresql.existingCASecret`). The API Deployment uses `minReadySeconds: 5`, `progressDeadlineSeconds: 600` and a five-second `preStop` sleep. The PodDisruptionBudget (`maxUnavailable: 1`) renders only when `disruptionBudget.enabled` and `replicaCount >= 2`, so a single replica never blocks node drains. Post-install NOTES print the release's port-forward, readiness, enrollment and uninstall commands. The render fixture and runtime smoke now use Forgejo consistently. Existing non-root, read-only filesystem, seccomp, capability-drop, retained PVC, probe and default-deny controls remain in place.

The [complete Golf Kubernetes installation guide](../../../docs/KUBERNETES.md) explains each component, values, private credential setup, image distribution, storage, networking/TLS, enrollment, external trust, upgrades and recovery limits. It is the step-by-step guide; this file is the chart reference. A PDB is not whole-stack HA or writer fencing.
