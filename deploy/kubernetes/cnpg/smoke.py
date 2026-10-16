#!/usr/bin/env python3
"""Isolated CNPG/Barman/RustFS proof. Never targets an existing kube context."""
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ARTIFACTS = [
    ('cert-manager.yaml', 'https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml', 'e03b668ec8675214af6b0a671699d088f2601fa3878e0dbe1b41d3feafd1879f'),
    ('cnpg.yaml', 'https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml', '37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb'),
    ('barman.yaml', 'https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml', '8f377ff4a7d0d3f74fc64b0f7ac4f449fc38ca9e83a40107cca2f9315a9bd920'),
]
NS = 'golf-proof'


def run(args, stdin=None):
    r = subprocess.run([str(x) for x in args], input=stdin, text=True, capture_output=True)
    if r.returncode:
        # Commands can operate on private manifests. Never dump stdin or Secrets.
        raise RuntimeError(f'{args[0]} command failed ({r.returncode})')
    return r.stdout


def wait(check, label, seconds=360):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            print('PASS:', label, flush=True)
            return
        time.sleep(2)
    raise RuntimeError('Timed out: ' + label)


class Fixture:
    def __init__(self, path, name):
        self.path, self.name = path, name
        self.k = ['kubectl', '--kubeconfig', str(path / 'config'), '--context', 'k3d-' + name]
        self.access, self.secret = 'golfproof' + secrets.token_hex(8), secrets.token_urlsafe(32)

    def apply(self, obj):
        return run(self.k + ['apply', '--server-side', '-n', NS, '-f', '-'], json.dumps(obj))

    def get(self, kind, name):
        return json.loads(run(self.k + ['get', kind, name, '-n', NS, '-o', 'json']))

    def secret_obj(self, name, data, kind='Opaque'):
        self.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name, 'namespace': NS}, 'type': kind, 'stringData': data})

    def prepare(self):
        for filename, url, digest in ARTIFACTS:
            data = urllib.request.urlopen(url).read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError('Pinned operator artifact changed: ' + filename)
            file = self.path / filename
            file.write_bytes(data)
            run(self.k + ['apply', '--server-side', '-f', file])
            namespace, deployment = ('cert-manager', 'cert-manager-webhook') if filename.startswith('cert') else ('cnpg-system', 'cnpg-controller-manager' if filename == 'cnpg.yaml' else 'barman-cloud')
            wait(lambda: json.loads(run(self.k + ['get', 'deployment', deployment, '-n', namespace, '-o', 'json'])).get('status', {}).get('availableReplicas', 0) == 1, filename + ' operator ready')
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': NS}})
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', self.path / 'tls.key', '-out', self.path / 'tls.crt', '-days', '2', '-subj', '/CN=rustfs-svc.golf-proof.svc', '-addext', 'subjectAltName=DNS:rustfs-svc.golf-proof.svc,DNS:rustfs-svc,DNS:localhost'])
        self.secret_obj('rustfs-auth', {'RUSTFS_ACCESS_KEY': self.access, 'RUSTFS_SECRET_KEY': self.secret})
        self.secret_obj('backup-auth', {'ACCESS_KEY_ID': self.access, 'ACCESS_SECRET_KEY': self.secret, 'REGION': 'us-east-1'})
        self.secret_obj('rustfs-tls', {'rustfs_cert.pem': (self.path / 'tls.crt').read_text(), 'rustfs_key.pem': (self.path / 'tls.key').read_text(), 'ca.crt': (self.path / 'tls.crt').read_text()})
        for role in ['golf', 'forgejo']:
            self.secret_obj(role + '-auth', {'username': role, 'password': secrets.token_urlsafe(32)}, 'kubernetes.io/basic-auth')
        run(['git', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', '1.0.0', 'https://github.com/rustfs/rustfs.git', self.path / 'rustfs'])
        assert run(['git', '-C', self.path / 'rustfs', 'rev-parse', 'HEAD']).strip() == 'd47f54bfb2f39f48bd1adda334bd27e151fe85b8'
        rendered = run(['helm', 'template', 'rustfs', self.path / 'rustfs/helm/rustfs', '--namespace', NS, '--skip-tests', '-f', HERE / 'rustfs-values.example.yaml'])
        rendered = run(['python3', HERE / 'rustfs-tls-probes.py'], rendered)
        run(self.k + ['apply', '--server-side', '-n', NS, '-f', '-'], rendered)
        wait(lambda: self.get('deployment', 'rustfs').get('status', {}).get('availableReplicas', 0) == 1, 'RustFS native TLS ready')
        run(['python3', '-m', 'venv', self.path / 'venv'])
        run([self.path / 'venv/bin/pip', '-q', 'install', 'boto3==1.43.107'])
        self.bucket_operation('create')

    def bucket_operation(self, operation):
        # Reserve a dynamic local port; port-forward binds loopback only.
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        forward = subprocess.Popen(self.k + ['port-forward', '-n', NS, 'service/rustfs-svc', f'{port}:9000', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(2)
            helper = """import sys,json,boto3
from botocore.config import Config
c=json.load(sys.stdin)
s=boto3.client('s3',endpoint_url=c['endpoint'],aws_access_key_id=c['access'],aws_secret_access_key=c['secret'],region_name='us-east-1',verify=c['ca'],config=Config(s3={'addressing_style':'path'}))
if c['operation']=='create':s.create_bucket(Bucket='golf-cnpg-proof')
else:
 keys=[x['Key'] for p in s.get_paginator('list_objects_v2').paginate(Bucket='golf-cnpg-proof') for x in p.get('Contents',[])]
 assert any('/base/' in k for k in keys) and any('/wals/' in k for k in keys)
 print('PASS: RustFS contains physical base backup and archived WAL')
"""
            result = run([self.path / 'venv/bin/python', '-c', helper], json.dumps({'endpoint': f'https://localhost:{port}', 'access': self.access, 'secret': self.secret, 'ca': str(self.path / 'tls.crt'), 'operation': operation}))
            if result:
                print(result.strip(), flush=True)
        finally:
            forward.terminate()
            forward.wait(timeout=10)

    def render_cluster(self, restore=False):
        options = ['storage.storageClass=local-path', 'storage.size=2Gi', 'golfAuthSecret=golf-auth', 'forgejoAuthSecret=forgejo-auth', 'backup.existingSecret=backup-auth', 'backup.endpointURL=https://rustfs-svc.golf-proof.svc:9000', 'backup.endpointCASecret=rustfs-tls', 'resources.requests.cpu=100m', 'resources.requests.memory=256Mi']
        if restore:
            options += ['clusterName=golf-restored', 'backup.objectStoreName=golf-restored-backups', 'backup.destinationPath=s3://golf-cnpg-proof/restored/', 'recovery.enabled=true', 'recovery.sourceObjectStore=golf-backups', 'recovery.sourceServerName=golf-db']
        else:
            options += ['backup.destinationPath=s3://golf-cnpg-proof/source/']
        manifest = run(['helm', 'template', 'golf-db', HERE, '--namespace', NS, '--set', ','.join(options)])
        run(self.k + ['apply', '--server-side', '-n', NS, '-f', '-'], manifest)

    def sql(self, cluster, database, sql):
        primary = self.get('cluster', cluster)['status']['currentPrimary']
        return run(self.k + ['exec', '-n', NS, primary, '-c', 'postgres', '--', 'psql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]).strip()

    def ready(self, name):
        wait(lambda: self.get('cluster', name).get('status', {}).get('readyInstances') == 3, name + ' three native instances ready', 600)
        wait(lambda: self.get('database', name + '-forgejo').get('status', {}).get('applied', False), name + ' native Forgejo database applied')

    def qualify_clients(self):
        for role, other in [('golf', 'forgejo'), ('forgejo', 'golf')]:
            command = f"psql 'host=golf-db-rw.golf-proof.svc dbname={role} user={role} sslmode=verify-full sslrootcert=/trust/ca.crt' -At -v ON_ERROR_STOP=1 -c 'SELECT current_user' && if psql 'host=golf-db-rw.golf-proof.svc dbname={other} user={role} sslmode=verify-full sslrootcert=/trust/ca.crt' -At -c 'SELECT 1'; then exit 1; fi"
            self.apply({'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 'client-' + role}, 'spec': {'backoffLimit': 0, 'template': {'spec': {'restartPolicy': 'Never', 'containers': [{'name': 'client', 'image': 'ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie@sha256:f89a40f4d74aa6e0900917eaf6299b125a6382eb02fd4ee5d46f55bcbf7e5726', 'command': ['/bin/sh', '-ec', command], 'env': [{'name': 'PGPASSWORD', 'valueFrom': {'secretKeyRef': {'name': role + '-auth', 'key': 'password'}}}], 'volumeMounts': [{'name': 'ca', 'mountPath': '/trust', 'readOnly': True}]}], 'volumes': [{'name': 'ca', 'secret': {'secretName': 'golf-db-ca'}}]}}}})
            wait(lambda: self.get('job', 'client-' + role).get('status', {}).get('succeeded', 0) == 1, role + ' verify-full TLS login and cross-database refusal')

    def qualify(self):
        self.ready('golf-db')
        self.qualify_clients()
        assert self.sql('golf-db', 'postgres', "SELECT rolname||':'||rolsuper||':'||rolcreatedb||':'||rolcreaterole FROM pg_roles WHERE rolname IN ('golf','forgejo') ORDER BY rolname") == 'forgejo:false:false:false\ngolf:false:false:false'
        for db in ['golf', 'forgejo']:
            assert self.sql('golf-db', 'postgres', f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='{db}'") == db
            self.sql('golf-db', db, "CREATE TABLE golf_platform_probe(value text PRIMARY KEY); INSERT INTO golf_platform_probe VALUES ('before-backup')")
        assert int(self.sql('golf-db', 'postgres', "SELECT count(*) FROM pg_stat_replication WHERE sync_state IN ('sync','quorum')")) >= 1
        print('PASS: distinct native database owners, narrow roles and synchronous standby', flush=True)
        self.apply({'apiVersion': 'postgresql.cnpg.io/v1', 'kind': 'Backup', 'metadata': {'name': 'golf-proof-base'}, 'spec': {'cluster': {'name': 'golf-db'}, 'method': 'plugin', 'pluginConfiguration': {'name': 'barman-cloud.cloudnative-pg.io'}}})
        wait(lambda: self.get('backup', 'golf-proof-base').get('status', {}).get('phase') == 'completed', 'Barman physical base backup against RustFS', 600)
        for db in ['golf', 'forgejo']:
            self.sql('golf-db', db, "INSERT INTO golf_platform_probe VALUES ('after-backup')")
        segment = self.sql('golf-db', 'postgres', 'SELECT pg_walfile_name(pg_current_wal_lsn())')
        assert len(segment) == 24 and all(c in '0123456789ABCDEF' for c in segment)
        self.sql('golf-db', 'postgres', 'SELECT pg_switch_wal()')
        wait(lambda: self.sql('golf-db', 'postgres', f"SELECT last_archived_wal >= '{segment}' FROM pg_stat_archiver") == 't', 'Barman post-backup WAL archive against RustFS')
        self.bucket_operation('inspect')
        self.render_cluster(restore=True)
        self.ready('golf-restored')
        for db in ['golf', 'forgejo']:
            assert self.sql('golf-restored', db, 'SELECT value FROM golf_platform_probe ORDER BY value') == 'after-backup\nbefore-backup'
        print('PASS: fresh CNPG restore contains both databases plus changes after base backup', flush=True)


def main():
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    for tool in ['docker', 'k3d', 'kubectl', 'helm', 'openssl', 'git']:
        if not shutil.which(tool):
            raise RuntimeError('Required tool unavailable: ' + tool)
    name = 'golf-cnpg-' + secrets.token_hex(6)
    if any(x['name'] == name for x in json.loads(run(['k3d', 'cluster', 'list', '-o', 'json']))):
        raise RuntimeError('Disposable cluster name collision; no resources changed')
    with tempfile.TemporaryDirectory(prefix='golf-cnpg-proof-') as directory:
        path = Path(directory)
        path.chmod(0o700)
        created = False
        try:
            # Mark ownership before create so a partial creation still gets cleaned.
            created = True
            run(['k3d', 'cluster', 'create', name, '--servers', '1', '--agents', '2', '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--wait'])
            (path / 'config').write_text(run(['k3d', 'kubeconfig', 'get', name]))
            (path / 'config').chmod(0o600)
            f = Fixture(path, name)
            f.prepare()
            f.render_cluster()
            f.qualify()
        finally:
            if created:
                run(['k3d', 'cluster', 'delete', name])
                print('PASS: disposable cluster cleanup', flush=True)


if __name__ == '__main__':
    main()
