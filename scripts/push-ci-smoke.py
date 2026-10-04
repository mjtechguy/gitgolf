#!/usr/bin/env python3
"""Real disposable native Git push to grant-authorized isolated Docker shell CI.

Native signed callbacks are HMAC-checked and forwarded unchanged by an in-memory
recorder; captured-byte replay is not a native redelivery API claim. No retained
installation, host trust, native database or repository files are changed.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
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
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
NATIVE_HEADERS = ['Content-Type', 'X-Gitea-Delivery', 'X-Gitea-Event',
    'X-Gitea-Event-Type', 'X-Gitea-Signature', 'X-Gitea-Hook-Installation-Target-Type']


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--runner-image', required=True)
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
    worker = json.loads(run('docker', 'image', 'inspect', args.runner_image))[0]['Id']
    print('Golf image: '+image, flush=True)
    print('Runner image: '+worker, flush=True)
    project = 'golf-push-ci-proof-'+secrets.token_hex(5)
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
            GOLF_REPOSITORY_EVENT_CONNECTIONS='[]', GOLF_PUSH_CI_ENABLED='false',
            GOLF_RUNNER_KEY=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('='),
            GOLF_RUNNER_IMAGES=json.dumps({'linux': IMAGE}), GOLF_RUNNER_JOB_IMAGE=IMAGE,
            GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),
            RUSTFS_ACCESS_KEY='golf-proof-'+secrets.token_hex(12), RUSTFS_SECRET_KEY=secrets.token_hex(32))
        values['GOLF_RUNNER_KEYS'] = json.dumps({'local-docker': values['GOLF_RUNNER_KEY']})
        private.extend(value for key, value in values.items() if value and (key.endswith(('_PASSWORD', '_KEY', '_KEYS', '_SECRET_KEY')) or key == 'GITEA_OAUTH_CLIENT_SECRET'))

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
    environment:
      GOLF_PUSH_CI_ENABLED: ${{GOLF_PUSH_CI_ENABLED}}
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__security__ALLOWED_HOST_LIST: host.docker.internal
      GITEA__actions__ENABLED: 'false'
{host_mapping}    ports: !override ["127.0.0.1:{forge_port}:3000"]
  runner:
    image: {worker}
    pull_policy: never
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file),
            '-f', str(ROOT/'compose.yaml'), '-f', str(ROOT/'compose.ci.yaml'),
            '-f', str(ROOT/'compose.storage.yaml'), '-f', str(override)]

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

        def rpc(method, body=None, **kwargs):
            return smoke.rpc(session, method, body, **kwargs)

        def policy(scope, enabled):
            request = {'scope': 'EXECUTION_SCOPE_'+scope}
            if scope == 'REPOSITORY': request['repository'] = selection
            old = rpc('ExecutionPolicyService/GetExecutionPolicy', request)['policy']
            return rpc('ExecutionPolicyService/UpdateExecutionPolicy', {**request,
                'scopeId': old['scopeId'], 'expectedRevision': old.get('revision', '0'),
                'expectedAuthorityRevision': old['authorityRevision'],
                'mode': 'EXECUTION_MODE_ALL' if enabled else 'EXECUTION_MODE_DISABLED',
                'manualDispatchEnabled': False, 'pushAllowed': enabled, 'allowAllWorkflows': enabled})['policy']

        def runs():
            return rpc('WorkflowRunService/ListWorkflowRuns', {'repository': selection}).get('runs', [])

        def wait_run(commit, state):
            deadline = time.monotonic()+120
            while time.monotonic() < deadline:
                matching = [item for item in runs() if item['commitId'] == commit]
                assert len(matching) <= 1, 'Duplicate automatic execution'
                if matching and matching[0]['state'] == state: return matching[0]
                if matching and matching[0]['state'] in ['WORKFLOW_RUN_STATE_FAILED', 'WORKFLOW_RUN_STATE_LOST', 'WORKFLOW_RUN_STATE_TIMED_OUT']:
                    raise AssertionError('Unexpected terminal execution state')
                time.sleep(.5)
            raise AssertionError('Automatic execution deadline exceeded')

        started = False
        try:
            stage('fresh portable core and private RustFS; automatic execution initially disabled')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'postgres', 'gitea', 'golf', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
            command('exec', '-T', 'golf', 'golf', 'objectstore', 'initialize')
            name = 'push-'+secrets.token_hex(5)
            admin('create', '--username', name, '--email', name+'@example.invalid',
                '--random-password', '--must-change-password=false')
            token = admin('generate-access-token', '--username', name, '--token-name', project,
                '--scopes', 'write:user,write:repository', '--raw')
            private.append(token)
            native = smoke.provider(token, 'GET', 'user')
            password = secrets.token_urlsafe(32); private.append(password)
            command('exec', '-T', 'golf', 'golf', 'local-account', 'create', payload=json.dumps({
                'username': name, 'email': name+'@example.invalid', 'password': password,
                'forge_token': token, 'is_instance_admin': True}).encode())
            session = smoke.client()
            rpc('SessionService/LoginWithPassword', {'username': name+'@example.invalid', 'password': password})
            creation = rpc('RepositoryService/CreateRepository',
                {'name': 'push-source', 'private': True, 'idempotencyKey': str(uuid.uuid4())})
            assert creation['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            created = creation['repository']; full_name = created['fullName']
            selection = {'owner': name, 'name': created['name']}
            base = 'repos/'+full_name
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
            git('config', 'user.name', 'Golf pipeline fixture')
            git('config', 'user.email', 'private-fixture@example.invalid')
            marker = secrets.token_hex(16); private.append(marker)
            (work/'README.md').write_text(marker+'\n')
            workflow_path = '.github/workflows/check.yml'
            workflow_file = work/workflow_path; workflow_file.parent.mkdir(parents=True)
            workflow = ('on: push\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: |\n'
                '          test "$(id -u)" = 1000\n'
                '          test "$(cat README.md)" = '+marker+'\n'
                '          test -f .github/workflows/check.yml\n'
                '          test "$(cat extra.txt)" = "Exact pushed archive fixture"\n'
                '          printf "native push proof complete\\n"\n')
            workflow_file.write_text(workflow)
            git('add', '.'); git('commit', '-m', 'Initial bounded source')
            remote = smoke.GITEA+'/'+full_name+'.git'
            git('push', remote, 'HEAD:refs/heads/main')
            smoke.wait_for_push(token, full_name)
            assert not runs()
            policy('INSTANCE', True); policy('REPOSITORY', True)
            inspection = rpc('WorkflowService/InspectWorkflows', {'repository': selection, 'repositoryId': created['id']})
            assert inspection['repositoryId'] == created['id'] and len(inspection.get('policyRevision', '')) == 64
            configurations = inspection.get('configurations', [])
            assert len(configurations) == 1 and configurations[0]['path'] == workflow_path
            assert configurations[0].get('manualPolicyAllowed') is False and configurations[0].get('pushPolicyAllowed') is True
            grant = rpc('AutomationGrantService/CreateAutomationGrant', {'repository': selection,
                'expectedRepositoryId': created['id'], 'expectedOwnerId': str(native['id']),
                'nativeToken': token, 'branches': ['main'], 'workflowPaths': [workflow_path],
                'expiresAt': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(),
                'idempotencyKey': str(uuid.uuid4())})['grant']
            values['GOLF_REPOSITORY_EVENT_CONNECTIONS'] = json.dumps([{'id': connection,
                'repositoryId': created['id'], 'ownerId': str(native['id']), 'repository': full_name,
                'secret': signing_secret}], separators=(',', ':'))
            write_environment(); command('up', '-d', '--no-deps', 'golf'); smoke.ready()
            hook_route = base+'/hooks'
            hook = smoke.provider(token, 'POST', hook_route, {'type': 'gitea', 'active': True,
                'events': ['push'], 'branch_filter': '*', 'config': {'url': 'http://host.docker.internal:'+str(recorder.server_port)+path,
                'content_type': 'json', 'http_method': 'POST', 'secret': signing_secret}}, expected=201)
            assert smoke.provider(token, 'GET', hook_route+'/'+str(hook['id']))['active']

            stage('disabled intake stays historical after explicit enable and fresh delivery-ID replay')
            (work/'disabled.txt').write_text('Disabled intake fixture\n')
            git('add', '.'); git('commit', '-m', 'Intake-only signed push')
            historical_sha = git('rev-parse', 'HEAD'); git('push', remote, 'HEAD:refs/heads/main')
            historical_body, historical_headers, _ = wait_native(historical_sha)
            assert not runs()
            assert sql('SELECT count(*) FROM golf_repository_event_payloads WHERE NOT push_admission_requested') == '1'
            values['GOLF_PUSH_CI_ENABLED'] = 'true'
            write_environment(); command('up', '-d', '--no-deps', 'golf'); smoke.ready()
            assert rpc('AutomationGrantService/ListAutomationGrants', {'repository': selection})['grants'][0]['executionState'] == 'requires_push_admission'
            deliver(historical_body, {**historical_headers, 'X-Gitea-Delivery': str(uuid.uuid4())}, 204)
            time.sleep(3)
            assert not runs() and sql('SELECT count(*) FROM golf_push_materializations') == '0'

            stage('browser logout does not revoke independently delegated native push authority')
            rpc('SessionService/Logout')
            time.sleep(7)  # Whole-second native timestamps plus the 5-second clock-skew margin.
            (work/'extra.txt').write_text('Exact pushed archive fixture\n')
            git('add', '.'); git('commit', '-m', 'Actual unattended push')
            first_sha, blob_sha = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD:'+workflow_path)
            git('push', remote, 'HEAD:refs/heads/main')
            first_body, first_headers, _ = wait_native(first_sha)
            session = smoke.client()
            rpc('SessionService/LoginWithPassword', {'username': name+'@example.invalid', 'password': password})
            queued = wait_run(first_sha, 'WORKFLOW_RUN_STATE_QUEUED')
            assert queued['workflowBlobId'] == blob_sha
            assert queued['origin'] == 'WORKFLOW_RUN_ORIGIN_PUSH'
            assert queued['eventRef'] == 'refs/heads/main' and queued['automationGrantId'] == grant['id']
            assert int(queued['repositoryEventId']) > 0
            assert queued['workflowPath'] == workflow_path
            binding = json.loads(sql("SELECT row_to_json(r)::text FROM (SELECT origin,session_hash IS NULL AS no_session,automation_grant_id::text,repository_event_id,event_ref,source_storage,source_archive IS NULL AS no_archive FROM golf_workflow_runs WHERE id='"+str(uuid.UUID(queued['id']))+"') r"))
            assert binding['origin'] == 'push' and binding['no_session']
            assert binding['automation_grant_id'] == grant['id'] and binding['event_ref'] == 'refs/heads/main'
            assert binding['source_storage'] == 'env_s3' and binding['no_archive']
            assert sql("SELECT count(*) FROM golf_push_materializations WHERE run_id='"+str(uuid.UUID(queued['id']))+"' AND native_activity_id>0") == '1'
            command('restart', 'golf'); smoke.ready()
            deliver(first_body, first_headers, 204)
            assert wait_run(first_sha, 'WORKFLOW_RUN_STATE_QUEUED')['id'] == queued['id']

            stage('real Docker execution uses exact commit/blob/private object source exactly once')
            command('up', '-d', '--no-build', 'runner', timeout=240)
            completed = wait_run(first_sha, 'WORKFLOW_RUN_STATE_SUCCEEDED')
            assert completed['id'] == queued['id'] and completed['sourceSha256'] == queued['sourceSha256']
            logs = rpc('WorkflowRunService/GetWorkflowRunLogs', {'runId': completed['id']})
            assert 'native push proof complete' in ''.join(item['text'] for item in logs.get('logs', []))
            command('restart', 'golf'); smoke.ready()
            # A worker sharing Golf's network namespace must rejoin after restart.
            command('restart', 'runner')
            deliver(first_body, first_headers, 204)
            deliver(first_body, {**first_headers, 'X-Gitea-Delivery': str(uuid.uuid4())}, 204)
            assert sql('SELECT count(*) FROM golf_repository_events') == '2'
            time.sleep(3)
            assert len(runs()) == 1 and runs()[0]['id'] == queued['id']
            assert sql('SELECT count(*) FROM golf_workflow_runs') == '1'

            stage('running grant revocation fences results and rejects subsequent pushes')
            workflow_file.write_text(workflow.replace('          test "$(id -u)" = 1000\n', '          sleep 60\n          test "$(id -u)" = 1000\n'))
            git('add', '.'); git('commit', '-m', 'Controlled revocation fixture')
            second_sha = git('rev-parse', 'HEAD'); git('push', remote, 'HEAD:refs/heads/main')
            wait_native(second_sha)
            running = wait_run(second_sha, 'WORKFLOW_RUN_STATE_RUNNING')
            rpc('AutomationGrantService/RevokeAutomationGrant', {'repository': selection,
                'grantId': grant['id'], 'expectedRevision': grant['revision']})
            wait_run(second_sha, 'WORKFLOW_RUN_STATE_CANCELLED')
            (work/'extra.txt').write_text('Revoked authority fixture\n')
            git('add', '.'); git('commit', '-m', 'Denied subsequent push')
            third_sha = git('rev-parse', 'HEAD'); git('push', remote, 'HEAD:refs/heads/main')
            wait_native(third_sha)
            time.sleep(12)
            assert len(runs()) == 2 and all(item['commitId'] != third_sha for item in runs())
            assert sql('SELECT count(*) FROM golf_workflow_runs') == '2'
            assert sql('SELECT count(*) FROM golf_repository_events') == '4'
            def executor_clean():
                containers = command('exec', '-T', 'runner-daemon', 'docker', 'ps', '-aq', '--filter', 'label=io.golf.runner.managed=true').strip()
                volumes = command('exec', '-T', 'runner-daemon', 'docker', 'volume', 'ls', '-q', '--filter', 'label=io.golf.runner.managed=true').strip()
                return not containers and not volumes
            helpers.until(executor_clean, timeout=60)
            command('stop', 'runner')
            assert executor_clean()
            assert not any(value in command('logs', '--no-color', 'golf') for value in private)
            rpc('SessionService/Logout')
            print('PASS: real signed native pushes, disabled-intake non-revival, independent grant/logout, push-only policies, exact commit/blob/private RustFS source, restart/replay deduplication, actual Docker execution, running revoke, subsequent push denial and executor cleanup', flush=True)
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
