#!/usr/bin/env python3
"""Qualify the optional monitoring overlay against a disposable native stack.

Requires an already-built current Golf image. Creates an isolated Compose
project, fresh databases/volumes and ordinary Gitea users, then removes all of
them. Never restarts the normal development stack. Output contains stages only;
raw logs, credentials, source and telemetry are inspected privately in memory.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
STAGE = 'initialization'
MAX_BYTES = 8 << 20


def stage(name):
    global STAGE
    STAGE = name
    print('CHECK: ' + name, flush=True)


def run(args, environment, timeout=60):
    result = subprocess.run(args, cwd=ROOT, env=environment, capture_output=True, timeout=timeout)
    if result.returncode != 0:
        # Docker startup errors describe public image/configuration failures.
        # Keep all raw command output private, including provider CLI errors.
        if 'up' in args and '--no-build' in args:
            lines = result.stderr.decode(errors='replace').splitlines()
            for line in lines:
                if 'Error response from daemon:' in line or 'Error ' in line:
                    print('Docker startup category: ' + ('missing image' if 'image' in line.lower() else 'container configuration'), flush=True)
        raise AssertionError('Command failed; private output withheld')
    assert len(result.stdout) <= MAX_BYTES and len(result.stderr) <= MAX_BYTES
    return result.stdout.decode()


def http(url, *, method='GET', payload=None, headers=None, opener=None, expected=200):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        response = (opener or urllib.request.build_opener()).open(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_BYTES + 1)
        assert len(raw) <= MAX_BYTES and response.status == expected
        return raw, response.headers


def until(check, timeout=60):
    deadline = time.monotonic() + timeout
    while True:
        try:
            result = check()
            if result:
                return result
        except (AssertionError, OSError, ValueError):
            pass
        assert time.monotonic() < deadline, 'Bounded readiness/evidence deadline exceeded'
        time.sleep(0.4)


def free_ports(count):
    sockets = []
    try:
        for _ in range(count):
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            sockets.append(listener)
        return [s.getsockname()[1] for s in sockets]
    finally:
        for listener in sockets:
            listener.close()


def private_write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='existing current Golf image tag or immutable ID')
    args = parser.parse_args()
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('GOLF_', 'GITEA_', 'OTEL_', 'POSTGRES_', 'COMPOSE_')) and key != 'DATABASE_URL'}
    inspect = json.loads(run(['docker', 'image', 'inspect', args.image], environment))[0]
    image = inspect['Id']
    assert image.startswith('sha256:')
    print('Golf image: ' + image, flush=True)
    suffix = secrets.token_hex(5)
    project = 'golf-observe-' + suffix
    golf_port, gitea_port, metrics_port, jaeger_port, prometheus_port, grafana_port = free_ports(6)
    smoke.GOLF = f'http://127.0.0.1:{golf_port}'
    smoke.GITEA = f'http://127.0.0.1:{gitea_port}'
    jaeger = f'http://127.0.0.1:{jaeger_port}'
    prometheus = f'http://127.0.0.1:{prometheus_port}'
    grafana = f'http://127.0.0.1:{grafana_port}'
    metrics = f'http://127.0.0.1:{metrics_port}/metrics'
    users, sessions, forbidden = [], [], []
    started = False
    with tempfile.TemporaryDirectory(prefix='golf-observe-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        spec = importlib.util.spec_from_file_location('monitoring_init', ROOT / 'deploy/observability/init.py')
        initializer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(initializer)
        secret_dir = directory / 'monitoring'
        metrics_token = initializer.initialize(secret_dir)
        grafana_password = (secret_dir / 'grafana-password').read_text()
        assert secret_dir.stat().st_mode & 0o777 == 0o700
        assert (secret_dir / 'monitoring.env').stat().st_mode & 0o777 == 0o600
        assert all((secret_dir / name).stat().st_mode & 0o777 == 0o444 for name in ('metrics-token', 'grafana-password'))
        original_env = (secret_dir / 'monitoring.env').read_bytes()
        try:
            initializer.initialize(secret_dir)
        except FileExistsError:
            pass
        else:
            raise AssertionError('Initializer must never replace existing secrets')
        assert (secret_dir / 'monitoring.env').read_bytes() == original_env
        forbidden.extend([metrics_token, grafana_password])
        values = {name: secrets.token_hex(24) for name in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF,
                      GOLF_ENCRYPTION_KEYS='', GOLF_ACTIVE_ENCRYPTION_KEY='', GITEA_PUBLIC_URL='',
                      GITEA_OAUTH_CLIENT_ID='', GITEA_OAUTH_CLIENT_SECRET='')
        forbidden.extend(value for value in values.values() if value and value != smoke.GOLF)
        env_file = directory / 'core.env'
        private_write(env_file, ''.join(key + '=' + value + '\n' for key, value in values.items()))
        override = directory / 'proof.yaml'
        private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080", "127.0.0.1:{metrics_port}:9090"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{gitea_port}:3000"]
  jaeger:
    ports: !override ["127.0.0.1:{jaeger_port}:16686"]
  prometheus:
    ports: !override ["127.0.0.1:{prometheus_port}:9090"]
  grafana:
    ports: !override ["127.0.0.1:{grafana_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file), '--env-file', str(secret_dir / 'monitoring.env'),
                   '-f', str(ROOT / 'compose.yaml'), '-f', str(ROOT / 'compose.observability.yaml'), '-f', str(override)]

        def command(*arguments, timeout=60):
            return run([*compose, *arguments], environment, timeout)

        def admin(*arguments):
            return command('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *arguments).strip()

        def rpc(session, procedure, payload=None, expected=200, extra=None):
            headers = {'Origin': smoke.GOLF, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', **(extra or {})}
            raw, response_headers = http(smoke.GOLF + '/rpc/golf.v1.' + procedure, method='POST',
                                        payload=payload or {}, headers=headers, opener=session, expected=expected)
            assert response_headers.get('Cache-Control') == 'no-store'
            return json.loads(raw), response_headers

        def query(expression):
            raw, _ = http(prometheus + '/api/v1/query?' + urllib.parse.urlencode({'query': expression}))
            result = json.loads(raw)
            assert result['status'] == 'success'
            return result['data']['result']

        def positive(expression):
            result = query(expression)
            return result if result and float(result[0]['value'][1]) > 0 else None

        def traces():
            now = datetime.now(timezone.utc)
            params = {'query.serviceName': 'golf', 'query.searchDepth': 200,
                      'query.startTimeMin': (now - timedelta(minutes=15)).isoformat(),
                      'query.startTimeMax': (now + timedelta(seconds=1)).isoformat()}
            raw, _ = http(jaeger + '/api/v3/traces?' + urllib.parse.urlencode(params))
            groups = {}
            for resource in json.loads(raw)['result'].get('resourceSpans', []):
                for scope in resource.get('scopeSpans', []):
                    for span in scope.get('spans', []):
                        trace_id = span['traceId']
                        groups.setdefault(trace_id, {'traceID': trace_id, 'spans': []})['spans'].append(span)
            return list(groups.values())

        try:
            stage('render and start isolated pinned monitoring / PostgreSQL / Gitea / Golf')
            rendered = json.loads(command('config', '--format', 'json'))
            assert set(rendered['services']) == {'golf', 'gitea', 'postgres', 'jaeger', 'prometheus', 'grafana'}
            assert not rendered['services']['postgres'].get('ports')
            for service in rendered['services'].values():
                assert all(binding['host_ip'] == '127.0.0.1' for binding in service.get('ports', []))
            assert all('@sha256:' in rendered['services'][name]['image'] for name in ('jaeger', 'prometheus', 'grafana'))
            started = True
            command('up', '-d', '--no-build', timeout=240)
            stage('native Golf readiness')
            until(lambda: http(smoke.GOLF + '/readyz'))
            stage('monitoring service readiness')
            until(lambda: http(jaeger + '/api/v3/services'))
            until(lambda: http(prometheus + '/-/ready'))
            until(lambda: http(grafana + '/api/health'))
            assert smoke.request(smoke.client(), 'GET', smoke.GITEA + '/api/v1/version')['version'] == '1.27.3'
            command('exec', '-T', 'prometheus', 'promtool', 'check', 'config', '/etc/prometheus/prometheus.yml')

            stage('private metrics listener, authenticated scrape and provisioned Grafana dashboard')
            http(metrics, expected=401)
            http(metrics, headers={'Authorization': 'Bearer incorrect'}, expected=401)
            http(metrics, method='POST', headers={'Authorization': 'Bearer ' + metrics_token}, expected=405)
            until(lambda: positive('up{job="golf"}'))
            authorization = 'Basic ' + base64.b64encode(('golf:' + grafana_password).encode()).decode()
            stage('authenticated Grafana provisioned dashboard and datasource catalogue')
            dashboard = json.loads(http(grafana + '/api/dashboards/uid/golf-local', headers={'Authorization': authorization})[0])
            assert dashboard['dashboard']['uid'] == 'golf-local' and len(dashboard['dashboard']['panels']) == 10
            sources = json.loads(http(grafana + '/api/datasources', headers={'Authorization': authorization})[0])
            assert {source['uid'] for source in sources} == {'golf-prometheus'}
            for source in sources:
                stage('Grafana datasource health: ' + source['uid'])
                health = json.loads(http(grafana + '/api/datasources/uid/' + source['uid'] + '/health', headers={'Authorization': authorization})[0])
                assert health['status'] == 'OK'
            response = json.loads(http(grafana + '/api/ds/query', method='POST', payload={
                'from': str(int((time.time() - 60) * 1000)), 'to': str(int(time.time() * 1000)),
                'queries': [{'refId': 'A', 'datasource': {'uid': 'golf-prometheus', 'type': 'prometheus'},
                             'expr': 'up{job="golf"}', 'instant': True, 'range': False, 'intervalMs': 5000, 'maxDataPoints': 100}]},
                headers={'Authorization': authorization, 'Content-Type': 'application/json'})[0])
            frames = response['results']['A']['frames']
            assert frames and frames[0]['data']['values'][1][-1] == 1
            http(grafana + '/api/dashboards/uid/golf-local', expected=401)

            stage('ordinary-user native repository/source reads, authentication and private denial')
            for role in ('owner', 'outsider'):
                name = 'observe-' + role + '-' + suffix
                admin('create', '--username', name, '--email', name + '@example.invalid', '--random-password',
                      '--random-password-length', '32', '--must-change-password=false')
                users.append(name)
                token = admin('generate-access-token', '--username', name, '--token-name', 'observation-proof',
                              '--scopes', 'write:user,write:repository,read:issue', '--raw')
                forbidden.extend([token, name])
                session = smoke.client()
                sessions.append(session)
                identity, _ = rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
                assert identity['user']['login'] == name
                for handler in session.handlers:
                    if hasattr(handler, 'cookiejar'):
                        forbidden.extend(cookie.value for cookie in handler.cookiejar)
                if role == 'owner':
                    owner, owner_token, owner_name = session, token, name
                else:
                    outsider = session
            secret_body = 'private-source-' + secrets.token_hex(20)
            secret_path = 'private-path-' + secrets.token_hex(8) + '.txt'
            secret_description = 'private-description-' + secrets.token_hex(12)
            operation = str(uuid.uuid4())
            forbidden.extend([secret_body, secret_path, secret_description, operation])
            repo, _ = rpc(owner, 'RepositoryService/CreateRepository', {'name': 'private-repository', 'description': secret_description,
                         'private': True, 'idempotencyKey': operation})
            repository = {'owner': owner_name, 'name': 'private-repository'}
            full_name = repo['repository']['fullName']
            file = smoke.provider(owner_token, 'POST', 'repos/' + full_name + '/contents/' + secret_path,
                                  {'content': base64.b64encode(secret_body.encode()).decode(), 'message': 'Private source fixture'}, expected=201)
            commit = file['commit']['sha']
            forbidden.extend([commit, full_name])
            smoke.wait_for_push(owner_token, full_name)
            attacker_trace = secrets.token_hex(16)
            attacker_request = 'external-request-' + secrets.token_hex(16)
            forbidden.extend([attacker_trace, attacker_request])
            content, headers = rpc(owner, 'RepositoryService/GetContents', {'repository': repository, 'ref': commit, 'path': secret_path}, extra={
                'Traceparent': '00-' + attacker_trace + '-' + secrets.token_hex(8) + '-01',
                'Baggage': 'private=' + secret_body, 'X-Request-ID': attacker_request})
            assert content['file']['content'] == secret_body and content['commitId'] == commit
            request_id = headers.get('X-Request-ID')
            assert request_id and request_id != attacker_request
            rpc(outsider, 'RepositoryService/GetRepository', {'repository': repository}, expected=404)
            rpc(smoke.client(), 'RepositoryService/GetContents', {'repository': repository, 'ref': commit}, expected=401)
            http(smoke.GOLF + '/api/unknown-' + secret_path, expected=404)

            stage('same-trace API / real Gitea client / PostgreSQL spans and correlated JSON logs')
            def matching_trace():
                for trace in traces():
                    for span in trace['spans']:
                        tags = {item['key']: next(iter(item['value'].values())) for item in span.get('attributes', [])}
                        if tags.get('golf.request_id') == request_id:
                            return trace, span
                return None
            selected, parent = until(matching_trace)
            assert parent['name'] == 'HTTP /rpc/golf.v1.RepositoryService/GetContents'
            kinds = {span['name'] for span in selected['spans']}
            assert {'gitea.request', 'postgres.query'} <= kinds
            for span in selected['spans']:
                if span['spanId'] != parent['spanId']:
                    assert span['parentSpanId'] == parent['spanId']
            logs = command('logs', '--no-color', '--no-log-prefix', 'golf')
            records = [json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            assert any(record.get('request_id') == request_id and record.get('trace_id') == selected['traceID']
                       and record.get('message') == 'http.request' for record in records)

            stage('native metric families, bounded labels and exported-data privacy canaries')
            for expression in ('golf_http_requests_total{status="200"}', 'golf_http_requests_total{status="401"}',
                               'golf_http_requests_total{status="404"}', 'golf_gitea_requests_total',
                               'golf_database_queries_total{outcome="success"}', 'golf_telemetry_trace_exports_total{outcome="success"}',
                               'golf_http_request_duration_seconds_count', 'golf_gitea_request_duration_seconds_count',
                               'golf_database_query_duration_seconds_count'):
                until(lambda expression=expression: positive('sum(' + expression + ')'))
            series = query('{__name__=~"golf_.*"}')
            assert series
            for item in series:
                assert set(item['metric']) <= {'__name__', 'job', 'instance', 'method', 'route', 'status', 'operation', 'outcome', 'le'}
            exported = json.dumps(traces()) + json.dumps(series) + logs + http(metrics, headers={'Authorization': 'Bearer ' + metrics_token})[0].decode()
            for value in forbidden:
                assert value not in exported, 'Private canary entered telemetry'
            for value in ('db.statement', 'db.query.text', 'golf_sessions', 'golf_oauth_attempts', 'INSERT INTO', 'SELECT token_hash', 'Authorization:', 'Set-Cookie:'):
                assert value not in exported, 'SQL/credential field entered telemetry'
            for trace in traces():
                for span in trace['spans']:
                    for tag in span.get('attributes', []):
                        assert tag['key'] not in {'url.full', 'url.path', 'http.url', 'db.statement', 'db.query.text', 'db.query.parameters', 'exception.message', 'exception.stacktrace'}

            stage('collector outage is visible while native application remains usable; recovery exports resume')
            before = float(query('sum(golf_telemetry_trace_exports_total{outcome="success"})')[0]['value'][1])
            command('stop', '-t', '5', 'jaeger')
            for _ in range(3):
                rpc(owner, 'SessionService/GetSession')
            until(lambda: positive('sum(golf_telemetry_trace_exports_total{outcome="error"})'))
            rpc(owner, 'RepositoryService/GetRepository', {'repository': repository})
            command('start', 'jaeger')
            until(lambda: http(jaeger + '/api/v3/services'))
            rpc(owner, 'SessionService/GetSession')
            until(lambda: float(query('sum(golf_telemetry_trace_exports_total{outcome="success"})')[0]['value'][1]) > before)
            assert 'trace export failed; batch may be lost' in command('logs', '--no-color', '--no-log-prefix', 'golf')
            print('PASS: isolated native traces, metrics auth/scrape, dashboard, privacy and collector outage/recovery', flush=True)
        finally:
            if started:
                print('CHECK: purge disposable identities and remove isolated containers / volumes / network', flush=True)
                cleanup_errors = []
                for session in sessions:
                    try:
                        rpc(session, 'SessionService/Logout')
                    except Exception:
                        cleanup_errors.append('session')
                for name in reversed(users):
                    try:
                        admin('delete', '--username', name, '--purge')
                    except Exception:
                        cleanup_errors.append('user')
                command('down', '--volumes', '--remove-orphans', '--timeout', '10', timeout=90)
                for resource, subcommand in [('container', 'ps'), ('volume', 'ls'), ('network', 'ls')]:
                    assert not run(['docker', resource, subcommand, '-q', '--filter', 'label=com.docker.compose.project=' + project], environment).strip()
                assert not cleanup_errors, 'Fixture API cleanup failed before disposable project removal'
                print('PASS: isolated project cleanup verified; normal stack unchanged', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        locations = ','.join(str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)[-3:])
        print('FAIL: ' + STAGE + ' (' + type(error).__name__ + ', lines ' + locations + '; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
