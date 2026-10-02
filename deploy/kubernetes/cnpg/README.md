# PostgreSQL platform profile

This **separate Helm release** provisions CloudNativePG application databases and Barman Cloud Plugin resources. The platform owner owns operators, CRDs, storage, object-store lifecycle, secrets, CA rotation and restore decisions. Do not make the Golf application release own or uninstall this database release. There are no embedded credentials or generated Secrets.

Qualified version baseline: CloudNativePG 1.30.1, Barman Cloud Plugin 0.15.1, cert-manager 1.21.2 and PostgreSQL 18.6 standard operand pinned by registry digest. Check operator support before upgrading Kubernetes. [Supported releases](https://cloudnative-pg.io/docs/1.30/supported_releases/), [Barman plugin prerequisites](https://cloudnative-pg.io/plugin-barman-cloud/docs/intro/).

## Install prerequisites

Install cert-manager first, wait for its webhook, then install CNPG and the plugin in separately reviewed platform releases. For the upstream manifest installation, use server-side apply: CNPG's large CRDs exceed client-side annotation limits. Wait for CRDs to be established and operator deployments available before installing this chart. Pin downloaded artifact digests in your platform GitOps repository.

```sh
kubectl apply --server-side -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
kubectl rollout status -n cert-manager deployment/cert-manager-webhook
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl rollout status -n cnpg-system deployment/cnpg-controller-manager
kubectl apply --server-side -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml
kubectl rollout status -n cnpg-system deployment/barman-cloud
```

Supply same-namespace existing basic-auth Secrets: `golf-auth` (`username=golf`, `password`) and `gitea-auth` (`username=gitea`, `password`). Supply `backup-auth` containing `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY`, `REGION`; use a dedicated bucket prefix with restricted backup credentials. Provision these through your secret manager; never put secret values in Helm values, shell arguments or Git. Choose an explicit CSI storage class, volume capacity and resource budget.

```yaml
# Example operator-reviewed values; these are names, not credentials.
clusterName: golf-db
storage: {storageClass: YOUR_CSI_CLASS, size: 50Gi}
golfAuthSecret: golf-auth
giteaAuthSecret: gitea-auth
backup:
  destinationPath: s3://YOUR_BUCKET/golf/production/postgres/
  endpointURL: https://rustfs-svc.YOUR_NAMESPACE.svc:9000
  existingSecret: backup-auth
  endpointCASecret: rustfs-tls
  endpointCAKey: ca.crt
```

```sh
helm upgrade --install golf-db deploy/kubernetes/cnpg --namespace YOUR_NAMESPACE -f YOUR_PRIVATE_VALUES
python3 deploy/kubernetes/cnpg/check.py
```

The native Cluster initializes `golf` owned by `golf`; the supported managed-role and Database resources create `gitea` owned by a distinct non-superuser role. Both roles are barred from cross-database network connections. Three instances use required host anti-affinity and one synchronous acknowledgement with required durability. Loss of every eligible synchronous standby can block writes: this deliberately favors durability over silent asynchronous fallback. Three pods on one physical host, local-path volumes or one storage failure domain do **not** provide production HA. [Role management](https://cloudnative-pg.io/docs/1.30/declarative_role_management/), [Database management](https://cloudnative-pg.io/docs/1.30/declarative_database_management/), [Failover and synchronous replication](https://cloudnative-pg.io/docs/1.30/failover/).

## Connect Golf and the native forge

The writer Service is `golf-db-rw.YOUR_NAMESPACE.svc`; CNPG creates `golf-db-ca` with key `ca.crt` in that namespace. Mount that CA read-only into both application clients, require `verify-full`, and use the Service DNS name. Configure Golf's supported `PGSSLROOTCERT` file path. Gitea 1.27 exposes `database.SSL_MODE`, but **no** `database.SSL_CA` setting; use a qualified driver/root-trust arrangement rather than inventing an environment variable. The application chart owns client mounts and restart/CA-rotation qualification. Basic-auth Secrets must match the native role passwords. Native Gitea access remains through supported application APIs.

Restrict PostgreSQL ingress to application clients, operator/instance management and replication; restrict backup egress to your object store and required DNS. Network-policy selectors, workload identities, ingress TLS, certificate renewal, placement across zones, alerts and capacity testing belong to the platform's deployment review. This chart does not claim those controls are supplied by rendering resources.

## RustFS and S3-compatible storage

Use the **upstream RustFS chart as a separate release**, from `rustfs/rustfs` tag `1.0.0`, directory `helm/rustfs`. `rustfs-values.example.yaml` is a standalone development/qualification profile with existing Secrets and native HTTPS. It deliberately provides no RustFS HA claim. Clone/pin that release outside Golf and install with the example after changing its explicit CSI class:

```sh
git clone --depth 1 --branch 1.0.0 https://github.com/rustfs/rustfs.git YOUR_PLATFORM_CHECKOUT
helm template rustfs YOUR_PLATFORM_CHECKOUT/helm/rustfs --namespace YOUR_NAMESPACE --skip-tests -f deploy/kubernetes/cnpg/rustfs-values.example.yaml | python3 deploy/kubernetes/cnpg/rustfs-tls-probes.py | kubectl apply --server-side -n YOUR_NAMESPACE -f -
```

`rustfs-auth` contains `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY`. `rustfs-tls` contains `rustfs_cert.pem`, `rustfs_key.pem`, `ca.crt`; the certificate SAN must include the RustFS Service DNS used by clients. The upstream chart mounts that Secret via `extraVolumes`/`extraVolumeMounts` and `RUSTFS_TLS_PATH`; probes use HTTPS. The upstream 1.0.0 chart hardcodes HTTP for server TLS without mTLS; the small fail-closed renderer changes exactly those two probe schemes. Render and review its output before GitOps apply (Helm 4 post-renderers require plugins). For production RustFS, review the upstream multi-node/multi-drive deployment on independent hosts and disks, capacity, erasure-code quorum, TLS between peers, repair, rolling upgrades and failure drills. Do not convert the standalone fixture by changing its topology on existing volumes; provision and qualify a separate production storage deployment. Provision the bucket before CNPG archives start. Keep Golf application objects and PostgreSQL backup prefixes separate; credential rotation and lifecycle rules must not delete WAL needed by retained backups. [RustFS Helm installation](https://docs.rustfs.com/en/installation/cloud-native), [RustFS native TLS](https://docs.rustfs.com/en/integration/tls-configured).

Generic S3/RustFS uses the explicit endpoint and provider region. AWS S3 can omit `endpointURL` and use its region. R2 uses its account S3 endpoint and region `auto`, but Barman base backup, WAL archival, retention and restore against **R2 remain a separate qualification gate**. A successful Golf S3 object round trip does not prove PostgreSQL recovery semantics. No unsupported path-style toggle is invented in this profile.

## Backup and fresh restore

The plugin archives WAL continuously and schedules a base backup daily. Retention is attached to the ObjectStore, as required by the current plugin API; the deprecated in-tree `barmanObjectStore` is not used. Observe Backup phase, last successful archive, archive failures, retention and backup age. [Usage](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), [Retention](https://cloudnative-pg.io/plugin-barman-cloud/docs/retention/).

Restore into a **fresh, quarantined** cluster name. Keep the original source ObjectStore and server namespace, and give the target a different destination prefix/ObjectStore. Set `recovery.enabled`, `sourceObjectStore`, `sourceServerName`, optional `targetTime`. Never point a recovery target's WAL writer at the source archive namespace. Read both databases and compare known fixtures before any cutover. A recovery retains source roles/passwords; reauthorize credentials deliberately under quarantine, do not assume an initdb secret rewrites restored passwords.

A physical database restore is **not a complete Golf disaster recovery**. Native Git repositories, LFS/attachments, application objects, encryption keys, snapshot consistency, writer drain, session/credential quarantine and the existing Golf recovery contract must be coordinated. See [Golf recovery](../../../docs/RECOVERY.md). The profile does not replace that workflow.

## Qualification gates

The [qualification record](QUALIFICATION.md) records the completed local proof and remaining production gates. `check.py` provides executable offline rendering/invalid-configuration checks. `smoke.py` is the isolated live profile proof: it creates its own three-node k3d cluster, never switches the current kubeconfig, installs pinned platform components and RustFS TLS, verifies role/database isolation, WAL/base backup and fresh restore, and deletes the disposable cluster in `finally`. Requires Docker, k3d, kubectl, Helm, openssl and Python; downloads pinned upstream components and a private temporary boto3 environment. It must not be run against a retained cluster.

```sh
python3 deploy/kubernetes/cnpg/smoke.py
```

Production rollout still requires your CSI durability, failure domains, operator upgrades, client TLS/CA rotation, retention/deletion, real restore timing/RPO/RTO, connection pools, network policy and whole-Golf recovery qualification. Standalone RustFS and local-path fixture evidence cannot satisfy those production gates.
