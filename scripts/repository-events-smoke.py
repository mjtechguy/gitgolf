#!/usr/bin/env python3
"""Qualify native push intake on a fresh disposable Compose core.

Gitea1.27.3 has no REST delivery-list/redelivery API. An in-memory HMAC-checked
recorder forwards actual native push bytes to Golf, then this fixture replays
those captured transport bytes. The two kinds of evidence are kept distinct.
No native database access, protected publication or automatic CI is exercised.
"""
import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('event_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
STAGE = 'initialization'
LIMIT = 1 << 20
NATIVE_HEADERS = ['Content-Type', 'X-Gitea-Delivery', 'X-Gitea-Event',
    'X-Gitea-Event-Type', 'X-Gitea-Signature', 'X-Gitea-Hook-Installation-Target-Type']


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    environment = {key: value for key, value in os.environ.items() if not key.startswith(
        ('GOLF_', 'GITEA_', 'POSTGRES_', 'OTEL_', 'COMPOSE_', 'RUSTFS_', 'AWS_', 'GIT_')) and key != 'DATABASE_URL'}
    private = []

    def run(*arguments, payload=None, env=None, cwd=ROOT, timeout=120):
        result = subprocess.run(arguments, input=payload, capture_output=True, cwd=cwd,
            env=env or environment, timeout=timeout)
        assert result.returncode == 0, 'Private subprocess failed'
        assert len(result.stdout) <= 8 << 20 and len(result.stderr) <= 8 << 20
        return result.stdout.decode()

    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    print('Golf image: '+image, flush=True)
    project = 'golf-events-proof-'+secrets.token_hex(5)
    golf_port, forge_port = helpers.free_ports(2)
    original = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{golf_port}', f'http://127.0.0.1:{forge_port}'
    signing_secret, connection = secrets.token_hex(32), str(uuid.uuid4())
    private.append(signing_secret)
    path = '/hooks/gitea/'+connection
    captured, capture_lock = [], threading.Lock()
    recorder_counts = {'received': 0, 'bad_request': 0, 'bad_signature': 0, 'forward_error': 0}

    def deliver(body, headers, expected=None, selected_path=path):
        request = urllib.request.Request(smoke.GOLF+selected_path, data=body, headers=headers, method='POST')
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw, status = response.read(4097), response.status
            assert len(raw) <= 4096 and response.headers.get('Cache-Control') == 'no-store'
            assert not any(value.encode() in raw for value in private)
            if expected is not None and status != expected:
                print('Intake status mismatch: actual='+str(status)+' expected='+str(expected), flush=True)
                raise AssertionError('Unexpected intake status')
            return status, raw

    class Recorder(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            self.connection.settimeout(15)
            with capture_lock:
                recorder_counts['received'] += 1
            try:
                length = int(self.headers.get('Content-Length', '-1'))
                if self.path != path or not 0 < length <= LIMIT:
                    with capture_lock:
                        recorder_counts['bad_request'] += 1
                    self.send_error(400)
                    return
                body = self.rfile.read(length)
                if len(body) != length:
                    self.send_error(400)
                    return
                signature = hmac.new(signing_secret.encode(), body, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(self.headers.get('X-Gitea-Signature', ''), signature):
                    with capture_lock:
                        recorder_counts['bad_signature'] += 1
                    self.send_error(401)
                    return
                headers = {name: self.headers.get(name, '') for name in NATIVE_HEADERS}
                status, raw = deliver(body, headers)
                with capture_lock:
                    if len(captured) >= 32:
                        raise AssertionError('Recorder capacity exceeded')
                    captured.append((body, headers, status))
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception:
                with capture_lock:
                    recorder_counts['forward_error'] += 1
                self.send_error(503)

    recorder = ThreadingHTTPServer(('0.0.0.0', 0), Recorder)
    recorder.daemon_threads = False
    listener = threading.Thread(target=recorder.serve_forever, daemon=True)
    listener.start()
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        env_file, override = directory/'core.env', directory/'proof.yaml'
        values = {name: secrets.token_hex(24) for name in ['POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
            GOLF_PUBLIC_URL=smoke.GOLF, GOLF_ENCRYPTION_KEYS='', GOLF_ACTIVE_ENCRYPTION_KEY='',
            GITEA_PUBLIC_URL='', GITEA_OAUTH_CLIENT_ID='', GITEA_OAUTH_CLIENT_SECRET='',
            GOLF_REPOSITORY_EVENT_CONNECTIONS='[]')
        private.extend(value for key, value in values.items() if value and key != 'GOLF_PUBLIC_URL' and value != '[]')

        def write_environment():
            text = ''.join(key+"='"+value+"'\n" for key, value in values.items())
            if env_file.exists():
                env_file.write_text(text)
            else:
                helpers.private_write(env_file, text)

        write_environment()
        # Docker Desktop supplies its own host bridge; replacing that DNS name
        # with the Linux bridge gateway routes callbacks away from this listener.
        host_mapping = '' if sys.platform == 'darwin' else '    extra_hosts: ["host.docker.internal:host-gateway"]\n'
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__security__ALLOWED_HOST_LIST: host.docker.internal
      GITEA__actions__ENABLED: 'false'
{host_mapping}    ports: !override ["127.0.0.1:{forge_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file),
            '-f', str(ROOT/'compose.yaml'), '-f', str(override)]

        def command(*arguments, **kwargs):
            return run(*compose, *arguments, **kwargs)

        def admin(*arguments):
            return command('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                'admin', 'user', *arguments).strip()

        def sql(query):
            return command('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf',
                '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query).strip()

        def wait_native(commit):
            deadline = time.monotonic()+60
            while time.monotonic() < deadline:
                with capture_lock:
                    matches = [entry for entry in captured if json.loads(entry[0]).get('after') == commit]
                if matches:
                    assert len(matches) == 1, 'Unexpected native duplicate delivery'
                    assert matches[0][2] == 202, 'Native delivery was not accepted'
                    return matches[0]
                time.sleep(0.25)
            logs = command('logs', '--no-color', '--tail', '100', 'gitea').lower()
            categories = {name: text in logs for name, text in {
                'host_denied': 'webhook can only call allowed', 'dns_failure': 'no such host',
                'timeout': 'timeout', 'connection_refused': 'connection refused',
                'delivery_error': 'unable to deliver', 'delivery_preparation_error': 'cannot create http request',
            }.items()}
            with capture_lock:
                print('Native callback diagnostics: '+json.dumps({'recorder': recorder_counts, 'categories': categories}, sort_keys=True), flush=True)
            raise AssertionError('Native delivery deadline exceeded')

        started = False
        try:
            stage('fresh canonical core, default deny and native repository setup')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
            assert run('docker', 'inspect', '--format', '{{.Image}}', project+'-golf-1').strip() == image
            assert set(json.loads(command('config', '--format', 'json'))['services']) == {'golf', 'gitea', 'postgres'}
            deliver(b'{}', {'Content-Type': 'application/json'}, 404)
            name = 'push-'+secrets.token_hex(5)
            admin('create', '--username', name, '--email', name+'@example.invalid',
                '--random-password', '--must-change-password=false')
            token = admin('generate-access-token', '--username', name, '--token-name', project,
                '--scopes', 'write:user,write:repository', '--raw')
            private.append(token)
            native = smoke.provider(token, 'GET', 'user')
            session = smoke.client()
            smoke.rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
            creation = smoke.rpc(session, 'RepositoryService/CreateRepository',
                {'name': 'event-source', 'private': True, 'idempotencyKey': str(uuid.uuid4())})
            assert creation['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            created = creation['repository']
            full_name = created['fullName']
            settings = [{'id': connection, 'repositoryId': created['id'], 'ownerId': str(native['id']),
                'repository': full_name, 'secret': signing_secret}]
            values['GOLF_REPOSITORY_EVENT_CONNECTIONS'] = json.dumps(settings, separators=(',', ':'))
            write_environment()
            command('up', '-d', '--no-deps', 'golf')
            smoke.ready()
            assert sql('SELECT count(*) FROM golf_repository_event_connections') == '1'
            hook_route = 'repos/'+full_name+'/hooks'
            hook = smoke.provider(token, 'POST', hook_route, {'type': 'gitea', 'active': True,
                'events': ['push'], 'branch_filter': '*', 'config': {'url': 'http://host.docker.internal:'+str(recorder.server_port)+path,
                    'content_type': 'json', 'http_method': 'POST', 'secret': signing_secret}}, expected=201)
            observed_hook = smoke.provider(token, 'GET', hook_route+'/'+str(hook['id']))
            assert observed_hook['active'] and observed_hook['events'] == ['push'] and observed_hook['type'] == 'gitea'

            stage('actual native Git push and unchanged signed-body forwarding')
            work, hooks = directory/'git', directory/'no-hooks'
            work.mkdir(); hooks.mkdir()
            auth = base64.b64encode((name+':'+token).encode()).decode()
            git_environment = {**environment, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '1',
                'GIT_CONFIG_KEY_0': 'http.'+smoke.GITEA+'/.extraHeader', 'GIT_CONFIG_VALUE_0': 'Authorization: Basic '+auth}

            def git(*arguments):
                return run('git', '-c', 'credential.helper=', '-c', 'core.hooksPath='+str(hooks),
                    '-c', 'commit.gpgsign=false', '-c', 'http.followRedirects=false', *arguments,
                    cwd=work, env=git_environment).strip()

            git('init', '--template=', '-b', 'main')
            git('config', 'user.name', 'Golf event fixture')
            git('config', 'user.email', 'private-fixture@example.invalid')
            marker = 'Private event fixture '+secrets.token_hex(8)
            private.extend([marker, 'private-fixture@example.invalid'])
            (work/'README.md').write_text(marker+'\n')
            git('add', 'README.md'); git('commit', '-m', marker)
            first_sha = git('rev-parse', 'HEAD')
            remote = smoke.GITEA+'/'+full_name+'.git'
            git('push', remote, 'HEAD:refs/heads/main')
            first_body, first_headers, _ = wait_native(first_sha)
            first = json.loads(first_body)
            assert first['repository']['id'] == int(created['id']) and first['repository']['owner']['id'] == native['id']
            assert first['ref'] == 'refs/heads/main' and first['before'] == '0'*40
            assert first_headers['X-Gitea-Event-Type'] == 'push' and first_headers['X-Gitea-Hook-Installation-Target-Type'] == 'repository'
            assert sql('SELECT count(*) FROM golf_repository_events') == '1'
            (work/'README.md').write_text(marker+'\nsecond push\n')
            git('add', 'README.md'); git('commit', '-m', 'Second bounded push')
            second_sha = git('rev-parse', 'HEAD')
            git('push', remote, 'HEAD:refs/heads/main')
            second_body, _, _ = wait_native(second_sha)
            assert json.loads(second_body)['before'] == first_sha
            assert sql('SELECT count(*) FROM golf_repository_events') == '2'

            stage('captured transport replay after restart, payload conflict and signature/binding failures')
            command('restart', 'golf'); smoke.ready()
            deliver(first_body, first_headers, 204)
            assert sql('SELECT count(*) FROM golf_repository_events') == '2'
            changed = dict(first)
            changed['after'] = second_sha
            changed_body = json.dumps(changed).encode()
            changed_headers = {**first_headers, 'X-Gitea-Signature': hmac.new(signing_secret.encode(), changed_body, hashlib.sha256).hexdigest()}
            deliver(changed_body, changed_headers, 409)
            deliver(first_body, {**first_headers, 'X-Gitea-Signature': '0'*64}, 401)
            for bad_payload in [
                {**first, 'repository': {**first['repository'], 'id': int(created['id'])+1}},
                {**first, 'repository': {**first['repository'], 'owner': {**first['repository']['owner'], 'id': native['id']+1}}},
            ]:
                body = json.dumps(bad_payload).encode()
                headers = {**first_headers, 'X-Gitea-Delivery': str(uuid.uuid4()),
                    'X-Gitea-Signature': hmac.new(signing_secret.encode(), body, hashlib.sha256).hexdigest()}
                deliver(body, headers, 400)
            deliver(first_body, first_headers, 404, '/hooks/gitea/'+str(uuid.uuid4()))
            assert sql('SELECT count(*) FROM golf_repository_events') == '2'

            stage('receipt privacy, no automatic runs, retained history after connection removal')
            ledger = sql("SELECT json_agg(row_to_json(e))::text FROM golf_repository_events e")
            assert not any(value in ledger for value in private)
            rows = json.loads(ledger)
            assert len(rows) == 2 and all(row['state'] == 'RECORDED' and row['execution_state'] == 'UNAVAILABLE' for row in rows)
            assert rows[0]['payload_sha256'] == hashlib.sha256(first_body).hexdigest()
            assert rows[0]['payload_bytes'] == len(first_body)
            assert sql('SELECT count(*) FROM golf_workflow_runs') == '0'
            logs = command('logs', '--no-color', 'golf')
            assert not any(value in logs for value in private)
            smoke.provider(token, 'DELETE', hook_route+'/'+str(hook['id']), expected=204)
            values['GOLF_REPOSITORY_EVENT_CONNECTIONS'] = '[]'
            write_environment(); command('up', '-d', '--no-deps', 'golf'); smoke.ready()
            deliver(first_body, first_headers, 404)
            assert sql('SELECT count(*) FROM golf_repository_events') == '2'
            smoke.rpc(session, 'SessionService/Logout')
            print('PASS: two actual native pushes, immutable repository/owner binding, exact private-memory transport replay204 after restart, signed payload conflict409, signature/binding denials, projected privacy, no automatic run and removed-connection default deny', flush=True)
        finally:
            smoke.GOLF, smoke.GITEA = original
            try:
                if started:
                    command('down', '--volumes', '--remove-orphans', timeout=120)
                for resource, action in [('container', 'ls'), ('volume', 'ls'), ('network', 'ls')]:
                    extra = ['-a'] if resource == 'container' else []
                    assert not run('docker', resource, action, *extra, '-q', '--filter',
                        'label=com.docker.compose.project='+project).strip()
            finally:
                recorder.shutdown(); recorder.server_close(); listener.join(timeout=20)
                assert not listener.is_alive()
                with capture_lock:
                    captured.clear()
            print('PASS: isolated containers/volumes/network, recorder and private temporary Git/configuration removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        lines = ','.join(str(item.lineno) for item in traceback.extract_tb(error.__traceback__) if item.filename == __file__)
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+lines+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
