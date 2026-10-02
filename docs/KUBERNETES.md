# Kubernetes installation

The Helm chart packages the current Golf API/web application, qualified Gitea 1.27.3 and PostgreSQL 18.4. Cloudflare and AI credentials are not required. It does not install runners, agents, a queue, object storage or deployment controllers: those product features are not implemented yet.

Use an explicit kubeconfig and context for every command. Never point the qualification harness at a production cluster. The chart requires an explicitly versioned Golf image built from this repository; there is no published release image yet.

See the [chart README](../deploy/helm/golf/README.md) for concrete Secret/values and install commands. The chart's strict schema rejects unknown settings instead of silently accepting misspelled options.

## Credentials and durable state

Create an operator-managed Secret in the installation namespace before installing. Set `existingSecret` to its name. Always provide `DATABASE_URL` (the complete, URL-encoded Golf PostgreSQL connection string) and `GOLF_ENCRYPTION_KEY` (base64 encoding of 32 random bytes). The chart does not generate, embed or print credentials.

Bundled PostgreSQL additionally requires `POSTGRES_PASSWORD`, `GOLF_DB_PASSWORD` and `GITEA_DB_PASSWORD`. Its initialization script is identical to the Compose script: separate databases and roles, with cross-database connection privileges revoked. Initialization runs only against an empty data volume. Editing Secret passwords does **not** rotate PostgreSQL roles. With internal Gitea and external PostgreSQL, `GITEA_DB_PASSWORD` remains required.

Optional browser OAuth requires a registered confidential Gitea application, its exact Golf callback, and `GITEA_OAUTH_CLIENT_ID`/`GITEA_OAUTH_CLIENT_SECRET` in the Secret. Configure the public Gitea origin separately from its internal API endpoint. See [the authentication instructions](../README.md#optional-browser-oauth).

Preserve the encryption key, both databases and both Gitea data/configuration volumes together. PVCs are retained on ordinary release removal; deleting the namespace or backing storage is destructive. Restoring retained claims after deleting a release is an operator procedure, not an automated backup system. Take verified backups before upgrading. Environment credentials and OAuth changes may persist in Gitea's generated configuration; disabling Golf OAuth does not revoke upstream consent.

## Endpoint and writer boundaries

Remote public origins require HTTPS and secure cookies. Loopback HTTP is a deliberate development-only option. A Kubernetes Service DNS name is an internal API address, not the browser's public origin. Origin matching remains exact, including ports.

Golf replicas can share their database and encryption key. Gitea and bundled PostgreSQL each have one StatefulSet replica. Gitea is the sole canonical Git writer; Golf never edits its repository files or database. Ordinary ordered pod replacement is supported. A single replica and ReadWriteOnce storage are **not** node-partition fencing. Do not force-delete a writer pod on an unreachable node and start another against the same storage without verified storage fencing. Multi-node failover, production HA and unattended recovery are not qualified.

Ingress and NetworkPolicy options use native Kubernetes resources. Operators supply an ingress controller, TLS certificates, DNS, a suitable storage class and a CNI that enforces NetworkPolicy. External dependency policies must allow their actual addresses and ports. Rendering a policy or ingress does not prove that a particular controller/CNI implements it. No DNS or certificates are provisioned by this chart.

## External dependencies

Set `postgresql.enabled=false` to use operator-managed PostgreSQL. Supply the Golf DSN in the Secret; when retaining internal Gitea, also configure its database endpoint, name, user and TLS mode. The operator must provision the separate Gitea database/role and cross-database restrictions. This does not convert the bundled single-instance database into HA.

Set `gitea.enabled=false` and provide `gitea.externalURL` to use an existing qualified Gitea 1.27.3 instance. No internal Gitea StatefulSet or PVC is installed. Keep one canonical forge and use a stable internal endpoint: Golf links identities to that configured endpoint plus the immutable upstream user ID. Changing it deliberately creates a different identity namespace. Gitea readiness/version checks still gate Golf capabilities; an external URL is not evidence of compatibility.

## Qualification

Run `python3 deploy/helm/golf/check.py` for Helm lint, valid/invalid configuration checks and Compose initialization-script drift checks. Run the real Kubernetes smoke against a dedicated disposable cluster using its explicit kubeconfig/context and imported Golf image. The harness creates its own namespace, temporary credentials and private repositories; diagnostics omit credentials. It does not change the default kubectl context or the running Compose installation.

The [evidence ledger](IMPLEMENTATION_STATUS.md) records the successful fresh-install/restart/Git/authorization/replica/policy/external-profile/uninstall checks on arm64 k3s 1.35.5 with local-path storage. Public ingress/TLS, SSH exposure, Kubernetes OAuth and other storage/architecture/failover profiles remain unqualified. A render check alone is insufficient to call Kubernetes supported.

For a dedicated local k3d cluster (choose unused API/test ports), the qualification sequence is:

```sh
umask 077
mkdir -p .tmp/kubernetes
k3d cluster create golf-smoke --image rancher/k3s:v1.35.5-k3s1 \
  --api-port 127.0.0.1:6556 --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false --k3s-arg '--disable=traefik@server:0'
k3d kubeconfig get golf-smoke > .tmp/kubernetes/kubeconfig
docker build -t golf-local:qualification .
k3d image import golf-local:qualification -c golf-smoke
make cli helm-check
python3 scripts/kubernetes-smoke.py \
  --kubeconfig .tmp/kubernetes/kubeconfig --context k3d-golf-smoke \
  --image golf-local:qualification --cli bin/golf
k3d cluster delete golf-smoke
```

The harness reserves loopback ports 8086, 8087, 8088 and 3006, and refuses an already occupied port. Delete only the dedicated cluster you created. Its Kubernetes credentials remain private; remove the temporary kubeconfig after cleanup. The single-node k3d/local-path-storage result does not qualify other storage classes, architectures or node-failure recovery.

Primary references: [Helm charts](https://helm.sh/docs/topics/charts/), [Kubernetes StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/), and [k3d context isolation flags](https://k3d.io/stable/usage/commands/k3d_cluster_create/).
