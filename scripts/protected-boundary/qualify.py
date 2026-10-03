#!/usr/bin/env python3
"""Private disposable native topology. Never operates on the primary Golf stack.

Uses native CLI/API/Git only. Credentials stay in stdin/environment/private temp
files. Bootstrap operator access is explicit; it is not ordinary client ingress.
"""
import argparse
import base64
import configparser
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GITEA_IMAGE = 'gitea/gitea:1.27.3-rootless'
PYTHON_IMAGE = 'python:3.12-alpine'
POSTGRES_IMAGE = 'postgres:18.4-alpine3.24'


def command(*args, input=None, env=None, cwd=ROOT, success=True, timeout=90):
    result = subprocess.run(args, input=input, env=env, cwd=cwd, capture_output=True,
                            text=True, timeout=timeout)
    if (result.returncode == 0) != success:
        raise AssertionError(f'{args[0]} exited {result.returncode}; private output withheld')
    return result.stdout.strip()


def check(label):
    print('PASS: ' + label, flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def request(base, path, token, method='GET', body=None, headers=None, expected=200):
    outgoing = {'Authorization': 'token ' + token} | (headers or {})
    req = urllib.request.Request(base + path, method=method, data=body, headers=outgoing)
    try:
        response = urllib.request.build_opener(NoRedirect()).open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read((8 << 20) + 1)
        assert len(raw) <= 8 << 20
        assert response.status == expected, f'{method} classified request: {response.status}, expected {expected}'
        return raw


def raw_denial(port, token, target, extra='', method='GET', host=None):
    """Preserve exact invalid request framing instead of urllib normalizing it."""
    host = host or 'localhost:' + str(port)
    wire = (method + ' ' + target + ' HTTP/1.1\r\nHost: ' + host + '\r\nAuthorization: token ' + token +
            '\r\n' + extra + 'Connection: close\r\n\r\n').encode('ascii')
    with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
        connection.sendall(wire)
        status = connection.makefile('rb').readline(128)
        assert status.startswith(b'HTTP/1.1 403 '), 'Raw noncanonical request gained admission'


def native_call(private_network, route, token='', method='GET', payload=None, expected=200):
    # An operator-only transient client, removed on exit. No host/native ports or
    # provider credential arguments. Ordinary probe containers never join here.
    script = '''import json,sys,urllib.request,urllib.error
value=json.load(sys.stdin)
headers={'Authorization':'token '+value['token'],'Content-Type':'application/json'}
request=urllib.request.Request('http://provider:3000'+value['route'],method=value['method'],
 data=None if value['payload'] is None else json.dumps(value['payload']).encode(),headers=headers)
try: response=urllib.request.urlopen(request,timeout=10)
except urllib.error.HTTPError as error: response=error
with response:
 raw=response.read((2<<20)+1)
 assert len(raw)<=2<<20
 assert response.status==value['expected'], 'native bootstrap response status'
 print(raw.decode())
'''
    result = command('docker', 'run', '--rm', '-i', '--network', private_network,
                     PYTHON_IMAGE, 'python', '-c', script,
                     input=json.dumps(dict(route=route, token=token, method=method,
                                          payload=payload, expected=expected)))
    return json.loads(result) if result else None


def git_environment(owner, token):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'GOLF_'))}
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                'GIT_CONFIG_COUNT': '3', 'GIT_CONFIG_KEY_0': 'http.extraHeader',
                'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode((owner + ':' + token).encode()).decode(),
                'GIT_CONFIG_KEY_1': 'credential.helper', 'GIT_CONFIG_VALUE_1': '',
                'GIT_CONFIG_KEY_2': 'http.followRedirects', 'GIT_CONFIG_VALUE_2': 'false',
                'GIT_TERMINAL_PROMPT': '0'})
    return env


def qualify(port):
    project = 'golf-boundary-proof-' + secrets.token_hex(5)
    with tempfile.TemporaryDirectory(prefix=project + '-') as temporary:
        directory = Path(temporary)
        environment = directory / 'runtime.env'
        with os.fdopen(os.open(environment, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
            for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD'):
                output.write(key + '=' + secrets.token_urlsafe(32) + '\n')
        host = 'localhost:' + str(port)
        base = 'http://' + host
        owner = 'boundary-owner'
        intent = {'host': host, 'owner': owner, 'repository': 'source', 'branch': 'feature',
                  'old': '', 'new': '', 'owner_id': 0, 'repository_id': 0}
        intent_path = directory / 'intent.json'
        intent_path.write_text(json.dumps(intent))
        spec = {'services': {
            'postgres': {'image': POSTGRES_IMAGE, 'networks': ['private'],
                'environment': {key: '${' + key + '}' for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD')},
                'volumes': ['postgres-data:/var/lib/postgresql', str(ROOT / 'deploy/postgres/init.sh') + ':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s', 'timeout': '3s', 'retries': 45}},
            'provider': {'image': GITEA_IMAGE, 'networks': ['private'],
                'environment': {
                    'GITEA__database__DB_TYPE': 'postgres', 'GITEA__database__HOST': 'postgres:5432',
                    'GITEA__database__NAME': 'gitea', 'GITEA__database__USER': 'gitea', 'GITEA__database__PASSWD': '${GITEA_DB_PASSWORD}',
                    'GITEA__server__ROOT_URL': base + '/', 'GITEA__server__PUBLIC_URL_DETECTION': 'never',
                    'GITEA__server__DISABLE_SSH': 'true', 'GITEA__server__START_SSH_SERVER': 'false',
                    'GITEA__server__LFS_START_SERVER': 'false', 'GITEA__security__INSTALL_LOCK': 'true',
                    'GITEA__security__DISABLE_GIT_HOOKS': 'true', 'GITEA__service__DISABLE_REGISTRATION': 'true',
                    'GITEA__actions__ENABLED': 'false', 'GITEA__mirror__ENABLED': 'false', 'GITEA__mirror__DISABLE_NEW_PULL': 'true',
                    'GITEA__mirror__DISABLE_NEW_PUSH': 'true', 'GITEA__cron_0x2E_mirror_sync__ENABLED': 'false',
                    'GITEA__repository__ENABLE_PUSH_CREATE_USER': 'false', 'GITEA__repository__ENABLE_PUSH_CREATE_ORG': 'false'},
                'volumes': ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'],
                'depends_on': {'postgres': {'condition': 'service_healthy'}}},
            'broker': {'image': PYTHON_IMAGE, 'networks': ['private', 'client'],
                'command': ['python', '/fixture/classifier.py'],
                'ports': ['127.0.0.1:' + str(port) + ':8080'],
                'volumes': [str(HERE / 'classifier.py') + ':/fixture/classifier.py:ro',
                            str(intent_path) + ':/fixture/intent.json:ro'],
                'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true']}},
            'networks': {'private': {'internal': True}, 'client': {}},
            'volumes': {'postgres-data': {}, 'gitea-data': {}, 'gitea-config': {}}}
        compose_path = directory / 'compose.json'
        compose_path.write_text(json.dumps(spec))
        compose = ['docker', 'compose', '-p', project, '--env-file', str(environment), '-f', str(compose_path)]
        def admin(*args):
            return command(*compose, 'exec', '-T', 'provider', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *args)
        private = project + '_private'
        client = project + '_client'
        try:
            command(*compose, 'up', '-d', 'provider')
            deadline = time.monotonic() + 90
            while True:
                try:
                    if native_call(private, '/api/v1/version')['version'] == '1.27.3':
                        break
                except (AssertionError, ValueError):
                    pass
                assert time.monotonic() < deadline, 'Disposable native startup timed out'
                time.sleep(0.5)
            for image in (GITEA_IMAGE, POSTGRES_IMAGE, PYTHON_IMAGE):
                receipt = json.loads(command('docker', 'image', 'inspect', image))[0]
                print('IMAGE: ' + image + ' ' + receipt['Id'] + ' ' + ','.join(receipt.get('RepoDigests', [])), flush=True)
            print('TOOLCHAIN: ' + command('git', '--version'), flush=True)
            configuration = configparser.ConfigParser(interpolation=None)
            try:
                # Gitea's INI has root keys before its first named section.
                configuration.read_string('[DEFAULT]\n' + command(*compose, 'exec', '-T', 'provider', 'cat', '/etc/gitea/app.ini'))
            except configparser.Error:
                raise AssertionError('Private fixture configuration could not be parsed') from None
            for section, key, enabled in (('server', 'DISABLE_SSH', True),
                    ('server', 'START_SSH_SERVER', False), ('server', 'LFS_START_SERVER', False),
                    ('actions', 'ENABLED', False), ('mirror', 'ENABLED', False),
                    ('security', 'DISABLE_GIT_HOOKS', True), ('service', 'DISABLE_REGISTRATION', True),
                    ('repository', 'ENABLE_PUSH_CREATE_USER', False), ('repository', 'ENABLE_PUSH_CREATE_ORG', False)):
                assert configuration.getboolean(section, key) == enabled, 'Fixture native configuration drift'
            check('fresh native configuration selects explicit disabled SSH/LFS/Actions/mirrors/custom hooks/create-on-push; no secrets logged')
            admin('create', '--username', owner, '--email', owner + '@example.invalid',
                  '--random-password', '--random-password-length', '32', '--must-change-password=false')
            token = admin('generate-access-token', '--username', owner, '--token-name', 'disposable-proof',
                          '--scopes', 'write:user,write:repository', '--raw')
            assert token and '\n' not in token
            actor = native_call(private, '/api/v1/user', token)
            assert not actor['is_admin']
            repository = native_call(private, '/api/v1/user/repos', token, 'POST',
                {'name': 'source', 'private': True, 'auto_init': True, 'default_branch': 'main'}, 201)
            deadline = time.monotonic() + 30
            while native_call(private, '/api/v1/repos/' + owner + '/source', token)['empty']:
                assert time.monotonic() < deadline
                time.sleep(0.2)
            native_call(private, '/api/v1/repos/' + owner + '/source/branches', token, 'POST',
                        {'new_branch_name': 'feature', 'old_branch_name': 'main'}, 201)
            branch = native_call(private, '/api/v1/repos/' + owner + '/source/branches/feature', token)
            intent.update(owner_id=actor['id'], repository_id=repository['id'], old=branch['commit']['id'])
            intent_path.write_text(json.dumps(intent))
            command(*compose, 'up', '-d', 'broker')
            deadline = time.monotonic() + 30
            while True:
                try:
                    version = json.loads(request(base, '/api/v1/version', token))
                    assert version['version'] == '1.27.3'
                    break
                except (OSError, AssertionError):
                    pass
                assert time.monotonic() < deadline, 'Classifier startup timed out'
                time.sleep(0.2)
            check('fresh private pinned native provider and classified loopback ingress ready')
            env = git_environment(owner, token)
            remote = base + '/' + owner + '/source.git'
            work = directory / 'work'
            command('git', 'clone', '--quiet', remote, str(work), env=env)
            for key, value in (('user.name', 'Golf boundary proof'), ('user.email', 'boundary@example.invalid'), ('commit.gpgsign', 'false')):
                command('git', 'config', key, value, env=env, cwd=work)
            command('git', 'checkout', '--quiet', 'feature', env=env, cwd=work)
            (work / 'boundary.txt').write_text('Supported one-branch native Git transport proof.\n')
            command('git', 'add', '--', 'boundary.txt', env=env, cwd=work)
            command('git', 'commit', '--quiet', '-m', 'Declared disposable boundary candidate', env=env, cwd=work)
            intent['new'] = command('git', 'rev-parse', 'HEAD', env=env, cwd=work)
            command('git', 'merge-base', '--is-ancestor', intent['old'], intent['new'], env=env, cwd=work)
            intent_path.write_text(json.dumps(intent))
            check('ordinary non-admin native credentials admit clone/upload and exact identity metadata reads')
            api_root = '/api/v1/repos/' + owner + '/source'
            negatives = [('/api/internal/serv/command', 'GET'), (api_root + '/pulls/1', 'GET'),
                (api_root + '/contents/forbidden.txt', 'POST'), (api_root + '/branch_protections', 'POST'),
                (api_root + '/mirror-sync', 'POST'), ('/' + owner + '/source/_edit/main/README.md', 'POST'),
                ('/' + owner + '/source/pulls/1/merge', 'POST'), ('/user/login', 'GET'),
                ('/login/oauth/authorize', 'GET'), ('/admin', 'GET'), ('/unknown', 'GET'),
                ('/api/v1/%76ersion', 'GET'), ('/api/v1/version?x=1', 'GET'),
                ('/api/v1/version', 'PATCH')]
            for target, method in negatives:
                request(base, target, token, method=method, body=b'{}' if method == 'POST' else None, expected=403)
            for header in ('X-HTTP-Method-Override', 'X-Original-URL', 'Sudo', 'Forwarded'):
                request(base, '/api/v1/version', token, headers={header: 'x'}, expected=403)
            request(base, '/api/v1/version', token, headers={'Host': 'alternate.invalid'}, expected=403)
            request(base, '/api/v1/version', '', expected=403)
            request(base, '/api/v1/version', 'f' * 40, expected=403)
            for target in ('//api/v1/version', '/api/v1/../v1/version', '/api/v1/%76ersion',
                           '/api/v1/version?service=x&service=y', 'http://provider:3000/api/v1/version'):
                raw_denial(port, token, target)
            for extra in ('Host: localhost:' + str(port) + '\r\n', 'Content-Length: 0\r\nContent-Length: 0\r\n',
                          'Transfer-Encoding: chunked\r\n', 'Content-Length: 2097153\r\n',
                          'Content-Length: -1\r\n'):
                raw_denial(port, token, '/api/v1/version', extra)
            command('git', 'push', '--quiet', remote, 'HEAD:refs/heads/main', env=env, cwd=work, success=False)
            command('git', 'push', '--quiet', remote, 'HEAD:refs/heads/feature', 'HEAD:refs/tags/v1', env=env, cwd=work, success=False)
            command('git', 'push', '--quiet', remote, ':refs/heads/feature', env=env, cwd=work, success=False)
            assert native_call(private, api_root + '/branches/feature', token)['commit']['id'] == intent['old']
            check('API/web/internal/unknown/encoded/method-override/alternate-host and unsupported Git receives denied without ref change')
            provider_id = command(*compose, 'ps', '-q', 'provider')
            provider = json.loads(command('docker', 'inspect', provider_id))[0]
            assert not any(provider['HostConfig']['PortBindings'].values())
            assert set(provider['NetworkSettings']['Networks']) == {private}
            provider_ip = provider['NetworkSettings']['Networks'][private]['IPAddress']
            probe = '''import json,socket,sys
value=json.load(sys.stdin)
for host in ('provider',value['ip']):
 for port in (3000,2222,22,3001):
  try:
   connection=socket.create_connection((host,port),timeout=2)
  except OSError: continue
  connection.close(); raise AssertionError('direct provider bypass reachable')
print('isolated')
'''
            assert command('docker', 'run', '--rm', '-i', '--network', client, PYTHON_IMAGE,
                'python', '-c', probe, input=json.dumps({'ip': provider_ip})) == 'isolated'
            # A private operator probe distinguishes disabled SSH from bridge denial.
            probe_ssh = "import socket\nfor port in (22,2222):\n s=socket.socket(); s.settimeout(2); assert s.connect_ex(('provider',port)) != 0; s.close()\nprint('disabled')"
            assert command('docker', 'run', '--rm', '--network', private, PYTHON_IMAGE,
                'python', '-c', probe_ssh) == 'disabled'
            check('ordinary client bridge cannot reach native HTTP/internal or SSH by DNS/IP; provider has no published ports and SSH listener is off')
            command('git', 'push', '--quiet', '--force-with-lease=refs/heads/feature:' + intent['old'],
                    remote, intent['new'] + ':refs/heads/feature', env=env, cwd=work)
            assert native_call(private, api_root + '/branches/feature', token)['commit']['id'] == intent['new']
            assert native_call(private, api_root + '/branches/main', token)['commit']['id'] == intent['old']
            check('single declared fast-forward branch HTTP receive published exact C with explicit old-object lease; main unchanged')
            command('git', 'fetch', '--quiet', remote, 'feature', env=env, cwd=work)
            assert command('git', 'rev-parse', 'FETCH_HEAD', env=env, cwd=work) == intent['new']
            check('mediated supported Git upload independently reads back published candidate')
            native_call(private, api_root, token, 'DELETE', expected=204)
            admin('delete', '--username', owner, '--purge')
            check('native supported API/CLI purged disposable repository and ordinary actor')
            print('LIMIT: no durable reservation, accepted-write recovery/expiry fence, OAuth/password/MFA, admitted SSH, complete Git forms or full managed topology qualification', flush=True)
        finally:
            # Classifier emits fixed reason labels only, never native messages,
            # credentials or request payloads. Retain this safe debugging corpus.
            try:
                logs = command(*compose, 'logs', '--no-log-prefix', 'broker')
            except (AssertionError, OSError, subprocess.TimeoutExpired):
                logs = ''
            for line in logs.splitlines():
                if line.startswith('DENIED: '):
                    print(line, flush=True)
            command(*compose, 'down', '--volumes', '--remove-orphans')
            for kind in ('container', 'volume', 'network'):
                assert not command('docker', kind, 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--quiet')
            check('fixture containers, volumes and networks removed; primary stack untouched')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3026)
    args = parser.parse_args()
    assert 1024 <= args.port <= 65535
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', args.port))
    qualify(args.port)
