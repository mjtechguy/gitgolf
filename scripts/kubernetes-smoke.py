#!/usr/bin/env python3
"""Qualify Golf's Helm chart in an explicitly selected disposable local cluster.

Accepts only dedicated local k3d (`k3d-golf-*`) or kind (`kind-golf-*`)
contexts whose API server is on loopback; any other context, including a remote
or production one, is refused before anything beyond reading that context's
server address. Requires kubectl, Helm, Git, Python and a built Golf CLI. The
image must already be available to the cluster: `k3d image import`,
`kind load docker-image`, or a tag in a registry the nodes pull from (for
example a kind-connected `localhost:5001` registry). Storage uses the cluster's
default StorageClass (k3d `local-path`, kind `standard`) unless
--storage-class names one. --preflight performs only read-only checks. Creates a unique namespace, private
existing Secret and two Helm releases; checks real Git, authentication, source,
replicas, persistence, external dependencies and retained PVCs; then removes its
namespace. Never uses or changes the default kubeconfig/context, Compose, .env
or a pre-existing namespace. The caller owns cluster creation and deletion.

Examples: python3 scripts/kubernetes-smoke.py --kubeconfig /tmp/private/config \
  --context k3d-golf-smoke --image golf-local:revision --cli bin/golf
python3 scripts/kubernetes-smoke.py --kubeconfig ~/.kube/config --context kind-golf-ci \
  --image localhost:5001/golf:revision --cli bin/golf --preflight
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

sys.dont_write_bytecode = True
import smoke


def run(*args, input=None, env=None, cwd=smoke.ROOT, check=True):
    result = subprocess.run(args, input=input, env=env, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed (diagnostics withheld to protect credentials)')
    return result.stdout.strip() if check else result


def private_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        json.dump(value, output)


def wait_for(check, description, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(1)
    raise RuntimeError(description + ' did not become ready')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kubeconfig', required=True, type=Path)
    parser.add_argument('--context', required=True, help='explicit dedicated local k3d-golf-* or kind-golf-* context')
    parser.add_argument('--image', required=True, help='Golf image with an explicit tag, already imported or pullable by the cluster')
    parser.add_argument('--cli', required=True, type=Path)
    parser.add_argument('--storage-class', default='', help='StorageClass for bundled claims; empty uses the cluster default')
    parser.add_argument('--preflight', action='store_true',
                        help='only verify context, loopback API, nodes, storage class and free ports; create nothing')
    args = parser.parse_args()
    config, binary = args.kubeconfig.resolve(), args.cli.resolve()
    if not config.is_file() or not binary.is_file():
        parser.error('The explicit kubeconfig and CLI binary must already exist')
    # Both prefixes are what `k3d cluster create golf-...` and
    # `kind create cluster --name golf-...` produce. The loopback API check
    # below is a second, independent guard against non-local clusters.
    if not args.context.startswith(('k3d-golf-', 'kind-golf-')):
        parser.error('Only a dedicated local k3d-golf-* or kind-golf-* context is accepted')
    if ':' not in args.image.rsplit('/', 1)[-1] or '@' in args.image:
        parser.error('--image must include an explicit tag')
    for port in (8086, 8087, 8088, 3006):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                parser.error(f'Loopback test port {port} is already in use')
    namespace = 'golf-smoke-' + secrets.token_hex(4)
    release, external = 'proof', 'external'
    name, external_name = release + '-golf', external + '-golf'
    env = {**os.environ, 'KUBECONFIG': str(config)}
    kube_args = ['kubectl', '--kubeconfig', str(config), '--context', args.context]
    helm_args = ['helm', '--kubeconfig', str(config), '--kube-context', args.context, '--namespace', namespace]

    def kube(*command, input=None, scoped=True, check=True):
        return run(*kube_args, *(['--namespace', namespace] if scoped else []), *command,
                   input=input, env=env, check=check)

    def objects(kind, selector=None):
        return json.loads(kube('get', kind, *(['-l', selector] if selector else []), '-o', 'json'))['items']

    def ready_workloads(selected_release):
        selector = 'app.kubernetes.io/instance=' + selected_release
        workloads = objects('deployment,statefulset', selector)
        if not workloads:
            return False
        for workload in workloads:
            desired = workload['spec'].get('replicas', 1)
            status = workload.get('status', {})
            if status.get('observedGeneration', 0) < workload['metadata']['generation'] or status.get('readyReplicas', 0) != desired:
                return False
            if workload['kind'] == 'Deployment' and status.get('updatedReplicas', 0) != desired:
                return False
            if workload['kind'] == 'StatefulSet' and status.get('currentRevision') != status.get('updateRevision'):
                return False
        return True

    def forgejo_admin(*command):
        return kube('exec', name + '-forgejo-0', '--', 'forgejo', '--config', '/etc/gitea/app.ini', 'admin', 'user', *command)  # Helm's Forgejo config path (upstream name)

    forwards = []

    def forward(resource, local, remote):
        process = subprocess.Popen([*kube_args, '--namespace', namespace, 'port-forward', '--address', '127.0.0.1',
                                    resource, f'{local}:{remote}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        forwards.append(process)

        def listening():
            if process.poll() is not None:
                raise RuntimeError('Port forward failed (diagnostics withheld)')
            try:
                with socket.create_connection(('127.0.0.1', local), timeout=1):
                    return True
            except OSError:
                return False
        wait_for(listening, 'Loopback port forward', 30)
        return process

    def stop_forward(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def stop_forwards():
        for process in forwards:
            stop_forward(process)
        forwards.clear()

    def forward_core():
        forward('service/' + name, 8086, 8080)
        forward('service/' + name + '-forgejo', 3006, 3000)
        smoke.ready()

    # Read only the selected context's server; never serialize kubeconfig tokens.
    server = run(*kube_args, 'config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}', env=env)
    if urllib.parse.urlsplit(server).hostname not in ('localhost', '127.0.0.1', '::1', '0.0.0.0'):
        parser.error('The dedicated local cluster API must be on loopback')
    run(*kube_args, 'get', 'nodes', '-o', 'name', env=env)
    classes = json.loads(run(*kube_args, 'get', 'storageclass', '-o', 'json', env=env))['items']
    default_class = 'storageclass.kubernetes.io/is-default-class'
    if args.storage_class:
        if args.storage_class not in {item['metadata']['name'] for item in classes}:
            parser.error(f'StorageClass {args.storage_class} does not exist in the selected cluster')
    elif not any(item['metadata'].get('annotations', {}).get(default_class) == 'true' for item in classes):
        parser.error('The selected cluster has no default StorageClass; pass --storage-class')
    if args.preflight:
        print(f'PASS: preflight for {args.context}: loopback API, reachable nodes, storage class '
              f'{args.storage_class or "(cluster default)"} and free loopback ports; nothing was created', flush=True)
        return
    smoke.GOLF, smoke.FORGE = 'http://localhost:8086', 'http://localhost:3006'
    users, installed, created = [], [], False
    with tempfile.TemporaryDirectory(prefix='golf-kubernetes-smoke-', dir='/tmp') as directory:
        path = Path(directory)
        os.chmod(path, 0o700)
        try:
            kube('create', 'namespace', namespace, scoped=False)
            created = True
            print('STEP: installing isolated Kubernetes namespace ' + namespace, flush=True)
            data = {'POSTGRES_PASSWORD': secrets.token_hex(24), 'GOLF_DB_PASSWORD': secrets.token_hex(24),
                    'FORGEJO_DB_PASSWORD': secrets.token_hex(24), 'GOLF_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode()}
            data['DATABASE_URL'] = f'postgres://golf:{data["GOLF_DB_PASSWORD"]}@{name}-postgres:5432/golf?sslmode=disable'
            secret = path / 'secret.json'
            private_json(secret, {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'golf-existing', 'namespace': namespace},
                                  'type': 'Opaque', 'stringData': data})
            kube('apply', '-f', str(secret))
            repo, tag = args.image.rsplit(':', 1)
            peer = {'podSelector': {'matchLabels': {'app.kubernetes.io/instance': external, 'app.kubernetes.io/component': 'golf'}}}
            values = {'image': {'repository': repo, 'tag': tag, 'pullPolicy': 'IfNotPresent'},
                      'forge': {'kind': 'forgejo', 'instanceID': str(uuid.uuid4())},
                      'publicURL': smoke.GOLF, 'allowInsecureCookies': True, 'existingSecret': 'golf-existing', 'replicaCount': 2,
                      'forgejo': {'publicURL': smoke.FORGE + '/'},
                      'networkPolicy': {'enabled': True, 'forgejoIngressFrom': [peer], 'postgresIngressFrom': [peer]}}
            if args.storage_class:
                values['forgejo']['persistence'] = {'storageClass': args.storage_class}
                values['postgresql'] = {'persistence': {'storageClass': args.storage_class}}
            values_path = path / 'values.json'
            private_json(values_path, values)
            installed.append(release)
            run(*helm_args, 'install', release, str(smoke.ROOT / 'deploy/helm/golf'), '-f', str(values_path), env=env)
            wait_for(lambda: ready_workloads(release), 'Fresh chart installation')
            forward_core()
            assert len(objects('pdb')) == 1
            assert objects('pdb')[0]['spec']['maxUnavailable'] == 1
            assert objects('deployment', 'app.kubernetes.io/component=golf')[0]['spec']['template']['spec']['topologySpreadConstraints'][0]['whenUnsatisfiable'] == 'ScheduleAnyway'
            assert len(objects('statefulset', 'app.kubernetes.io/component=forgejo')) == 1
            assert objects('statefulset', 'app.kubernetes.io/component=forgejo')[0]['spec']['replicas'] == 1
            assert len(objects('pod', f'app.kubernetes.io/instance={release},app.kubernetes.io/component=golf')) == 2
            assert len(objects('networkpolicy')) >= 3
            pvcs = {item['metadata']['name']: item['metadata']['uid'] for item in objects('pvc')}
            assert len(pvcs) == 3 and all(item['status']['phase'] == 'Bound' for item in objects('pvc'))
            sql = "SELECT rolname,rolsuper,rolcreatedb,has_database_privilege(rolname,'golf','CONNECT'),has_database_privilege(rolname,'forgejo','CONNECT') FROM pg_roles WHERE rolname IN ('golf','forgejo') ORDER BY rolname"
            roles = kube('exec', name + '-postgres-0', '--', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', sql)
            assert roles.splitlines() == ['forgejo|f|f|f|t', 'golf|f|f|t|f']
            changed = {**values, 'forge': {**values['forge'], 'instanceID': str(uuid.uuid4())}}
            changed_path = path / 'changed-identity.json'
            private_json(changed_path, changed)
            rejected = run(*helm_args, 'upgrade', release, str(smoke.ROOT / 'deploy/helm/golf'), '-f', str(changed_path), '--dry-run=server', env=env, check=False)
            assert rejected.returncode and 'forge.instanceID cannot change' in rejected.stderr
            run(*helm_args, 'upgrade', release, str(smoke.ROOT / 'deploy/helm/golf'), '-f', str(values_path), '--dry-run=server', env=env)
            print('PASS: fresh two-replica Golf install, separate restricted database roles, one Forgejo writer and bound PVCs', flush=True)

            # Reuse the pinned Alpine image's native BusyBox tools, with no
            # credentials or application labels. Ready dependencies distinguish
            # policy denial from merely probing absent services.
            network_script = '\n'.join(
                f'if ! busybox nslookup {host}.{namespace}.svc.cluster.local. >/dev/null 2>&1; then echo DNS_FAILED_{port}; exit 43; fi\n'
                f'if busybox nc -z -w 3 {host}.{namespace}.svc.cluster.local. {port} >/dev/null 2>&1; then echo UNEXPECTED_CONNECTION_{port}; exit 42; fi\n'
                f'echo BLOCKED_{port}'
                for host, port in [(name, 8080), (name + '-forgejo', 3000), (name + '-postgres', 5432)])
            probe = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'denied-client', 'namespace': namespace},
                     'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                              'securityContext': {'runAsNonRoot': True, 'runAsUser': 65532, 'seccompProfile': {'type': 'RuntimeDefault'}},
                              'containers': [{'name': 'probe', 'image': 'postgres:18.4-alpine3.24',
                                              'command': ['/bin/sh', '-ec', network_script],
                                              'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                                                                  'capabilities': {'drop': ['ALL']}},
                                              'resources': {'requests': {'cpu': '10m', 'memory': '16Mi'},
                                                            'limits': {'cpu': '100m', 'memory': '32Mi'}}}]}}
            kube('apply', '-f', '-', input=json.dumps(probe))

            def network_finished():
                status = json.loads(kube('get', 'pod', 'denied-client', '-o', 'json')).get('status', {})
                phase = status.get('phase')
                if phase == 'Failed':
                    logs = kube('logs', 'denied-client').splitlines()
                    safe = [line for line in logs if any(line == prefix + str(port)
                            for prefix in ('DNS_FAILED_', 'UNEXPECTED_CONNECTION_', 'BLOCKED_') for port in (8080, 3000, 5432))]
                    raise AssertionError('Unlabeled network probe failed: ' + ', '.join(safe or ['container execution failure']))
                return phase == 'Succeeded'
            wait_for(network_finished, 'Default-deny network client')
            kube('delete', 'pod', 'denied-client', '--wait=false')
            print('PASS: live CNI policy denies an unlabeled client access to Golf, Forgejo and PostgreSQL', flush=True)

            credentials = {}
            for label in ('alice', 'bob'):
                username = 'golf-kube-' + label + '-' + secrets.token_hex(3)
                forgejo_admin('create', '--username', username, '--email', username + '@example.invalid',
                            '--random-password', '--random-password-length', '32', '--must-change-password=false')
                users.append(username)
                token = forgejo_admin('generate-access-token', '--username', username, '--token-name', 'kubernetes-proof',
                                    '--scopes', 'write:user,write:repository,read:issue', '--raw')
                enrollment = {'username': username, 'email': username + '@example.invalid',
                              'password': secrets.token_urlsafe(24), 'forge_token': token, 'is_instance_admin': label == 'alice'}
                kube('exec', '-i', 'deployment/' + name, '--', 'golf', 'local-account', 'create', input=json.dumps(enrollment))
                local_session = smoke.client()
                assert smoke.rpc(local_session, 'SessionService/LoginWithPassword', {'username': username, 'password': enrollment['password']})['user']['login'] == username
                smoke.rpc(local_session, 'SessionService/Logout')
                session = smoke.client()
                assert smoke.rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})['user']['login'] == username
                credentials[label] = (username, token, session)
            alice_name, alice_token, alice = credentials['alice']
            _, _, bob = credentials['bob']
            smoke.rpc(smoke.client(), 'RepositoryService/ListRepositories', expected=401)
            repository = smoke.rpc(alice, 'RepositoryService/CreateRepository',
                                   {'name': 'kubernetes-private', 'private': True, 'description': 'Disposable Kubernetes proof'})['repository']
            full_name = repository['fullName']
            reference = {'owner': alice_name, 'name': repository['name']}
            assert not any(item['fullName'] == full_name for item in smoke.rpc(bob, 'RepositoryService/ListRepositories').get('repositories', []))
            smoke.rpc(bob, 'RepositoryService/GetRepository', {'repository': reference}, expected=404)
            smoke.request(smoke.client(), 'GET', smoke.FORGE + '/api/v1/repos/' + full_name, expected=404)
            work = path / 'work'
            work.mkdir()
            run('git', 'init', '-b', 'main', cwd=work)
            nested_path, text = 'docs/naïve space/hello world.txt', 'Real Kubernetes Git source. Hello, 世界.\n'
            (work / nested_path).parent.mkdir(parents=True)
            (work / nested_path).write_text(text)
            run('git', 'add', '.', cwd=work)
            revision = smoke.commit(work, 'Qualify Kubernetes Git transport')
            askpass = path / 'askpass.py'
            askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n')
            askpass.chmod(0o700)
            git_env = {**os.environ, 'GIT_ASKPASS': str(askpass), 'GIT_TERMINAL_PROMPT': '0',
                       'GOLF_CHECK_USER': alice_name, 'GOLF_CHECK_TOKEN': alice_token}
            remote_url = smoke.FORGE + '/' + full_name + '.git'
            run('git', '-c', 'credential.helper=', 'push', remote_url, 'main', env=git_env, cwd=work)
            smoke.wait_for_push(alice_token, full_name)
            clone = path / 'clone'
            run('git', '-c', 'credential.helper=', 'clone', remote_url, str(clone), env=git_env)
            assert run('git', 'rev-parse', 'HEAD', cwd=clone) == revision and (clone / nested_path).read_text() == text
            result = smoke.content(alice, reference, 'main', nested_path)
            assert result['commitId'] == revision and result['file']['content'] == text
            smoke.rpc(bob, 'RepositoryService/GetContents', {'repository': reference, 'ref': revision, 'path': nested_path}, expected=404)
            smoke.rpc(smoke.client(), 'RepositoryService/GetContents', {'repository': reference, 'ref': revision, 'path': nested_path}, expected=401)
            smoke.cli_check(binary, alice_token, full_name, revision, nested_path, text)
            print('PASS: real Kubernetes Git push/clone, private immutable source, CLI and cross-user/anonymous denial', flush=True)

            extra_alice = smoke.client()
            smoke.rpc(extra_alice, 'SessionService/LoginWithForgeToken', {'token': alice_token})
            extra_id = next(row['id'] for row in smoke.rpc(extra_alice, 'SessionService/ListSessions')['sessions'] if row.get('current'))
            caller_id = next(row['id'] for row in smoke.rpc(alice, 'SessionService/ListSessions')['sessions'] if row.get('current'))
            bob_id = next(row['id'] for row in smoke.rpc(bob, 'SessionService/ListSessions')['sessions'] if row.get('current'))
            smoke.rpc(alice, 'SessionService/RevokeSession', {'sessionId': bob_id}, expected=404)

            # Address each actual API pod to prove shared session/key/database state,
            # rather than assuming a service port-forward balances requests.
            for index, pod in enumerate(objects('pod', f'app.kubernetes.io/instance={release},app.kubernetes.io/component=golf')):
                process = forward('pod/' + pod['metadata']['name'], 8088, 8080)
                try:
                    result = smoke.request(alice, 'POST', 'http://localhost:8088/rpc/golf.v1.SessionService/GetSession', {},
                                           {'Connect-Protocol-Version': '1'})
                    assert result['user']['login'] == alice_name
                    listed = smoke.request(alice, 'POST', 'http://localhost:8088/rpc/golf.v1.SessionService/ListSessions', {},
                                           {'Connect-Protocol-Version': '1'})['sessions']
                    assert {row['id'] for row in listed} == {caller_id, extra_id}
                    if index == 1:
                        revoked = smoke.request(alice, 'POST', 'http://localhost:8088/rpc/golf.v1.SessionService/RevokeSession',
                                                {'sessionId': extra_id}, {'Connect-Protocol-Version': '1'})
                        assert not revoked.get('currentSessionRevoked', False)
                finally:
                    stop_forward(process)
            smoke.rpc(extra_alice, 'SessionService/GetSession', expected=401)
            assert [row['id'] for row in smoke.rpc(alice, 'SessionService/ListSessions')['sessions']] == [caller_id]
            print('PASS: session listing and cross-replica revocation share one database and deny foreign-user IDs', flush=True)
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: smoke.rpc(alice, 'RepositoryService/GetContents',
                                                          {'repository': reference, 'ref': revision, 'path': nested_path}), range(6)))
            assert all(item['commitId'] == revision for item in results)
            print('PASS: both Golf replicas authorize the same persistent session and concurrent source reads', flush=True)

            old_pods = {item['metadata']['uid'] for item in objects('pod')}
            stop_forwards()
            print('STEP: replacing Golf, Forgejo and PostgreSQL pods while retaining their storage', flush=True)
            kube('rollout', 'restart', 'deployment/' + name, 'statefulset/' + name + '-forgejo', 'statefulset/' + name + '-postgres')
            wait_for(lambda: ready_workloads(release) and not old_pods.intersection(item['metadata']['uid'] for item in objects('pod')),
                     'Pod replacement')
            forward_core()
            assert {item['metadata']['name']: item['metadata']['uid'] for item in objects('pvc')} == pvcs
            assert smoke.rpc(alice, 'SessionService/GetSession')['user']['login'] == alice_name
            assert [row['id'] for row in smoke.rpc(alice, 'SessionService/ListSessions')['sessions']] == [caller_id]
            assert smoke.content(alice, reference, revision, nested_path)['file']['content'] == text
            assert run('git', '-c', 'credential.helper=', 'ls-remote', remote_url, 'refs/heads/main', env=git_env, cwd=work).split()[0] == revision
            print('PASS: encrypted session, exact Git commit and source survive all workload pod replacements', flush=True)

            external_values = {**values, 'replicaCount': 1, 'publicURL': 'http://localhost:8087',
                               'forgejo': {'enabled': False, 'publicURL': smoke.FORGE + '/',
                                         'externalURL': f'http://{name}-forgejo:3000', 'qualifiedVersion': '15.0.9'},
                               'postgresql': {'enabled': False},
                               'networkPolicy': {'enabled': True, 'externalEgress': [
                                   {'to': [{'podSelector': {'matchLabels': {'app.kubernetes.io/instance': release,
                                                                         'app.kubernetes.io/component': component}}}],
                                    'ports': [{'protocol': 'TCP', 'port': port}]}
                                   for component, port in [('forgejo', 3000), ('postgres', 5432)]]}}
            external_path = path / 'external-values.json'
            private_json(external_path, external_values)
            installed.append(external)
            run(*helm_args, 'install', external, str(smoke.ROOT / 'deploy/helm/golf'), '-f', str(external_path), env=env)
            wait_for(lambda: ready_workloads(external), 'External dependency profile')
            forward('service/' + external_name, 8087, 8080)
            smoke.GOLF = 'http://localhost:8087'
            smoke.ready()
            external_session = smoke.client()
            assert smoke.rpc(external_session, 'SessionService/LoginWithForgeToken', {'token': alice_token})['user']['login'] == alice_name
            assert smoke.content(external_session, reference, revision, nested_path)['file']['content'] == text
            assert not objects('statefulset', 'app.kubernetes.io/instance=' + external)
            assert len(objects('statefulset', 'app.kubernetes.io/component=forgejo')) == 1
            assert {item['metadata']['name']: item['metadata']['uid'] for item in objects('pvc')} == pvcs
            smoke.rpc(external_session, 'SessionService/Logout')
            smoke.GOLF = 'http://localhost:8086'
            smoke.rpc(alice, 'SessionService/Logout')
            smoke.rpc(bob, 'SessionService/Logout')
            print('PASS: external PostgreSQL/Forgejo profile uses canonical services with network policies enabled and no duplicate writer/PVCs', flush=True)

            for username in users[:]:
                forgejo_admin('delete', '--username', username, '--purge')
                users.remove(username)
            stop_forwards()
            for selected_release in installed[::-1]:
                run(*helm_args, 'uninstall', selected_release, '--wait', '--timeout', '45s', env=env)
                installed.remove(selected_release)
            assert {item['metadata']['name']: item['metadata']['uid'] for item in objects('pvc')} == pvcs
            print('PASS: Helm uninstall retains all three original PVCs before deliberate test-namespace cleanup', flush=True)
        finally:
            stop_forwards()
            failures = []
            for username in users:
                try:
                    forgejo_admin('delete', '--username', username, '--purge')
                except Exception:
                    # The namespace is still deleted below if a failed workload
                    # is unavailable. No resources exist outside this namespace.
                    pass
            for selected_release in installed[::-1]:
                result = run(*helm_args, 'uninstall', selected_release, '--ignore-not-found', '--timeout', '45s', env=env, check=False)
                if result.returncode:
                    failures.append('Helm cleanup failed for ' + selected_release)
            if created:
                result = kube('delete', 'namespace', namespace, '--wait=false', scoped=False, check=False)
                if result.returncode:
                    failures.append('Disposable namespace cleanup failed: ' + namespace)
                else:
                    wait_for(lambda: not json.loads(kube('get', 'namespaces', '--field-selector', 'metadata.name=' + namespace,
                                                        '-o', 'json', scoped=False))['items'], 'Namespace cleanup', 90)
                    print('Temporary Kubernetes namespace, credentials, test repositories and PVCs removed.', flush=True)
            if failures:
                raise RuntimeError('; '.join(failures))


if __name__ == '__main__':
    main()
