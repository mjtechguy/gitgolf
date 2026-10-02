# Local profile qualification — 2026-10-02

`python3 deploy/kubernetes/cnpg/smoke.py` completed successfully at 18:34 UTC against a newly created, isolated three-node k3d cluster. It did not select a retained context. The prior exploratory fixture and the clean scripted fixture were both deleted; their private kubeconfigs, TLS keys and credentials were removed. No runtime credentials are retained in this repository.

Tested platform: k3d 5.9.0 / k3s 1.35.5; CloudNativePG 1.30.1; Barman Cloud Plugin 0.15.1; cert-manager 1.21.2; PostgreSQL 18.6 standard operand with the default chart digest; upstream RustFS 1.0.0 chart at commit `d47f54bfb2f39f48bd1adda334bd27e151fe85b8`, standalone HTTPS server. The script checks downloaded operator manifest SHA256s and the upstream RustFS Git commit. The fixture used local-path CSI volumes on one Docker host.

The executable proof passed:

- Native Cluster, Database, ObjectStore, ScheduledBackup and Backup resources accepted by installed CRDs/operators.
- Three source PostgreSQL instances ready, with a synchronous standby reported by PostgreSQL.
- Separate `golf` and `gitea` databases with matching owners; both application roles non-superuser and unable to create databases or roles.
- Password-authenticated `verify-full` TLS client connections using the CNPG CA; each application role denied access to the other application database.
- RustFS HTTPS bucket creation with certificate verification.
- Barman physical base backup completed into RustFS.
- Post-backup WAL segment archived; RustFS inventory contains base backup and WAL objects.
- Fresh three-instance recovery into a different archive namespace contains both database fixtures, including writes made after the base backup.
- Disposable cluster and temporary credential cleanup.

`python3 deploy/kubernetes/cnpg/check.py`, valid-values `helm lint`, and Python syntax checks also passed. Offline checks include narrow role/replication/resource contracts, missing or conflicting secrets, unconfigured storage, unsafe endpoint/prefix, invalid retention, misspelled/type-invalid settings and same-name recovery refusal.

This is a **PostgreSQL/Barman/RustFS compatibility and recovery proof**, not complete Golf runtime or production HA qualification. It does not prove native Gitea client CA integration, cross-host/zone failover, distributed RustFS erasure-code behavior, retention expiry, production RPO/RTO, R2 Barman compatibility, application load or whole-Golf recovery. Those gates remain explicit in the [README](README.md) and [recovery contract](../../../docs/RECOVERY.md).
