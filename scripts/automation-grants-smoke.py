#!/usr/bin/env python3
"""Qualify durable personal automation grants on a disposable native Compose core.

This exercises actual supported Forgejo APIs and Golf's grant contract. It does
not create a hook, dispatch a job, execute source, or qualify restore/CI engines.
Private credentials/configuration remain in memory or removed 0600 fixture files.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('grant_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
STAGE = 'initialization'
SERVICE = 'AutomationGrantService/'


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Already-built immutable Golf image')
    args = parser.parse_args()
    environment = {key: value for key, value in os.environ.items() if not key.startswith(
        ('GOLF_', 'FORGEJO_', 'POSTGRES_', 'OTEL_', 'COMPOSE_', 'RUSTFS_', 'AWS_', 'GIT_')) and key != 'DATABASE_URL'}
    private = []

    def run(*arguments, payload=None, timeout=120):
        result = subprocess.run(arguments, input=None if payload is None else json.dumps(payload).encode(),
            capture_output=True, cwd=ROOT, env=environment, timeout=timeout)
        assert result.returncode == 0, 'Private subprocess failed'
        assert len(result.stdout) <= 8 << 20 and len(result.stderr) <= 8 << 20
        output = result.stdout.decode()
        assert not any(value in output for value in private), 'Private subprocess disclosed a credential'
        return output

    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    print('Golf image: '+image, flush=True)
    project = 'golf-grants-proof-'+secrets.token_hex(5)
    golf_port, forge_port = helpers.free_ports(2)
    original = smoke.GOLF, smoke.FORGE
    smoke.GOLF, smoke.FORGE = f'http://127.0.0.1:{golf_port}', f'http://127.0.0.1:{forge_port}'
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        env_file, override = directory/'core.env', directory/'proof.yaml'
        values = {name: secrets.token_hex(24) for name in ['POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'FORGEJO_DB_PASSWORD']} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
            GOLF_PUBLIC_URL=smoke.GOLF, GOLF_ENCRYPTION_KEYS='', GOLF_ACTIVE_ENCRYPTION_KEY='',
            GOLF_FORGE_PUBLIC_URL='', GOLF_FORGE_OAUTH_CLIENT_ID='', GOLF_FORGE_OAUTH_CLIENT_SECRET='',
            GOLF_REPOSITORY_EVENT_CONNECTIONS='[]')
        private.extend(value for key, value in values.items() if value and key not in ('GOLF_PUBLIC_URL', 'GOLF_FORGE_INSTANCE_ID') and value != '[]')
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key, value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
      FORGEJO__actions__ENABLED: 'false'
    ports: !override ["127.0.0.1:{forge_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file),
            '-f', str(ROOT/'compose.yaml'), '-f', str(override)]

        def command(*arguments, **kwargs):
            return run(*compose, *arguments, **kwargs)

        def native_admin(*arguments):
            return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini',  # Forgejo's upstream path
                'admin', 'user', *arguments).strip()

        def sql(query):
            # Only Golf metadata, never native forge tables or repository files.
            return command('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf',
                '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query).strip()

        def rpc(session, method, payload=None, **kwargs):
            try:
                result = smoke.rpc(session, method, payload, **kwargs)
            except AssertionError as error:
                status = re.search(r': (\d{3}), expected (\d{3})$', str(error))
                if status and re.fullmatch(r'[A-Za-z]+/[A-Za-z]+', method):
                    print('RPC status mismatch: '+method+' actual='+status[1]+' expected='+status[2], flush=True)
                raise
            assert not any(value in json.dumps(result) for value in private)
            return result

        def login(token):
            session = smoke.client()
            rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            return session

        started = False
        try:
            stage('fresh canonical core and native private workflow source')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            assert run('docker', 'inspect', '--format', '{{.Image}}', project+'-golf-1').strip() == image
            assert set(command('config', '--services').split()) == {'golf', 'forgejo', 'postgres'}
            people = {}
            for role in ['owner', 'reader', 'outside']:
                name = role+'-'+secrets.token_hex(5)
                native_admin('create', '--username', name, '--email', name+'@example.invalid',
                    '--random-password', '--must-change-password=false')
                token = native_admin('generate-access-token', '--username', name, '--token-name', project,
                    '--scopes', 'write:user,write:repository', '--raw')
                private.append(token)
                people[role] = {'name': name, 'token': token, 'native': smoke.provider(token, 'GET', 'user'), 'session': login(token)}
            owner, reader, outside = [people[key] for key in ['owner', 'reader', 'outside']]
            result = rpc(owner['session'], 'RepositoryService/CreateRepository',
                {'name': 'grant-source', 'private': True, 'idempotencyKey': str(uuid.uuid4())})
            assert result['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            repository = result['repository']
            selection = {'owner': owner['name'], 'name': repository['name']}
            base = 'repos/'+repository['fullName']
            workflow_path = '.github/workflows/check.yml'
            workflow = 'on: push\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: echo fixture-not-executed\n'
            smoke.provider(owner['token'], 'POST', base+'/contents/'+workflow_path,
                {'content': base64.b64encode(workflow.encode()).decode(), 'message': 'Bounded fixture source'}, expected=201)
            smoke.wait_for_push(owner['token'], repository['fullName'])
            smoke.provider(owner['token'], 'PUT', base+'/collaborators/'+reader['name'], {'permission': 'read'}, expected=204)
            native_source = smoke.provider(owner['token'], 'GET', base+'/contents/'+workflow_path)
            expected_blob = native_source['sha']
            narrow = native_admin('generate-access-token', '--username', owner['name'], '--token-name', project+'-narrow',
                '--scopes', 'read:user', '--raw')
            private.append(narrow)
            session = owner['session']
            request = {'repository': selection, 'expectedRepositoryId': repository['id'],
                'expectedOwnerId': str(owner['native']['id']), 'nativeToken': owner['token'],
                'branches': ['main'], 'workflowPaths': [workflow_path],
                'expiresAt': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(), 'idempotencyKey': str(uuid.uuid4())}

            stage('authority, immutable binding and bounded intent denials')
            rpc(smoke.client(), SERVICE+'ListAutomationGrants', {'repository': selection}, expected=401)
            rpc(session, SERVICE+'CreateAutomationGrant', request, headers={'Origin': 'https://other.invalid'}, expected=403)
            rpc(reader['session'], SERVICE+'ListAutomationGrants', {'repository': selection}, expected=403)
            rpc(reader['session'], SERVICE+'CreateAutomationGrant', {**request, 'nativeToken': reader['token']}, expected=403)
            rpc(outside['session'], SERVICE+'ListAutomationGrants', {'repository': selection}, expected=404)
            rpc(session, SERVICE+'CreateAutomationGrant', {**request, 'nativeToken': outside['token']}, expected=403)
            rpc(session, SERVICE+'CreateAutomationGrant', {**request, 'nativeToken': narrow}, expected=403)
            for field in ['expectedRepositoryId', 'expectedOwnerId']:
                rpc(session, SERVICE+'CreateAutomationGrant', {**request, field: str(int(request[field])+100)}, expected=404)
            for change in [
                {'branches': ['main', 'main']}, {'branches': ['release/**']}, {'branches': []},
                {'workflowPaths': ['../../secret.yml']}, {'workflowPaths': []},
                {'expiresAt': (datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat()},
                {'expiresAt': (datetime.now(timezone.utc)+timedelta(days=31)).isoformat()},
                {'idempotencyKey': 'not-a-uuid'},
            ]:
                rpc(session, SERVICE+'CreateAutomationGrant', {**request, **change}, expected=400)
            bearer = smoke.rpc(session, 'ApiCredentialService/CreateApiCredential', {'label': 'grant boundary'})['token']
            private.append(bearer)
            for method, body in [('ListAutomationGrants', {'repository': selection}), ('CreateAutomationGrant', request),
                ('RevokeAutomationGrant', {'repository': selection, 'grantId': str(uuid.uuid4()), 'expectedRevision': '1'})]:
                rpc(smoke.client(), SERVICE+method, body, headers={'Authorization': 'Bearer '+bearer}, expected=403)
            assert sql('SELECT count(*) FROM golf_automation_grants') == '0'

            stage('durable creation, exact replay and encrypted credential projection')
            pinned_commit = smoke.provider(owner['token'], 'GET', base+'/commits?sha=main&limit=1')[0]['sha']
            for label, route in [
                ('repository ID lookup', 'repositories/'+repository['id']),
                ('pinned workflow metadata', base+'/contents-ext/'+workflow_path+'?ref='+pinned_commit+'&includes=lfs_metadata'),
            ]:
                try:
                    smoke.provider(owner['token'], 'GET', route)
                except AssertionError as error:
                    status = re.search(r': (\d{3}), expected (\d{3})$', str(error))
                    if status:
                        print('Native preflight '+label+' status='+status[1], flush=True)
                    raise
            grant = rpc(session, SERVICE+'CreateAutomationGrant', request)['grant']
            assert grant['repositoryId'] == repository['id'] and grant['ownerId'] == str(owner['native']['id'])
            assert grant['sponsorNativeUserId'] == str(owner['native']['id']) and grant['enabled']
            assert grant['revision'] == '1' and grant['revocationEpoch'] == '1' and grant['executionState'] == 'unavailable'
            assert grant['branches'] == ['main'] and grant['workflowPaths'] == [workflow_path]
            assert rpc(session, SERVICE+'CreateAutomationGrant', request)['grant'] == grant
            rpc(session, SERVICE+'CreateAutomationGrant', {**request, 'branches': ['other']}, expected=400, code='failed_precondition')
            inventory = rpc(session, SERVICE+'ListAutomationGrants', {'repository': selection})
            assert inventory['grants'] == [grant] and not inventory.get('nextAfterId')
            assert sql('SELECT count(*) FROM golf_automation_grants') == '1'
            assert sql('SELECT count(*) FROM golf_automation_grant_events') == '1'
            stored = json.loads(sql("SELECT row_to_json(c)::text FROM (SELECT grant_id::text,version,encode(encrypted_credential,'hex') AS ciphertext,encode(credential_binding,'hex') AS binding,credential_key_id FROM golf_automation_credentials) c"))
            assert stored['grant_id'] == grant['id'] and stored['version'] == 1 and len(stored['binding']) == 64
            assert owner['token'].encode() not in bytes.fromhex(stored['ciphertext']) and len(bytes.fromhex(stored['ciphertext'])) >= 28
            assert all(word not in json.dumps(inventory).lower() for word in ['ciphertext', 'credential_binding', 'native_token'])

            stage('logout independence, restart persistence and explicit revocation')
            rpc(session, 'SessionService/Logout')
            rpc(session, SERVICE+'ListAutomationGrants', {'repository': selection}, expected=401)
            command('restart', 'golf'); smoke.ready()
            session = login(owner['token'])
            assert rpc(session, SERVICE+'ListAutomationGrants', {'repository': selection})['grants'] == [grant]
            assert rpc(session, SERVICE+'CreateAutomationGrant', request)['grant'] == grant
            assert sql('SELECT count(*) FROM golf_workflow_runs') == '0'
            assert sql('SELECT count(*) FROM golf_repository_events') == '0'
            revoke = {'repository': selection, 'grantId': grant['id'], 'expectedRevision': '1'}
            rpc(session, SERVICE+'RevokeAutomationGrant', {**revoke, 'expectedRevision': '2'}, expected=400, code='failed_precondition')
            rpc(reader['session'], SERVICE+'RevokeAutomationGrant', revoke, expected=403)
            revoked = rpc(session, SERVICE+'RevokeAutomationGrant', revoke)['grant']
            assert not revoked.get('enabled', False) and revoked['revision'] == '2' and revoked['revocationEpoch'] == '2'
            assert rpc(session, SERVICE+'RevokeAutomationGrant', {**revoke, 'expectedRevision': '2'})['grant'] == revoked
            assert rpc(session, SERVICE+'CreateAutomationGrant', request)['grant'] == revoked
            rpc(session, SERVICE+'RevokeAutomationGrant', revoke, expected=400, code='failed_precondition')
            assert sql('SELECT count(*) FROM golf_automation_grant_events') == '2'
            events = json.loads(sql('SELECT json_agg(row_to_json(e) ORDER BY e.id)::text FROM golf_automation_grant_events e'))
            assert [event['action'] for event in events] == ['CREATED', 'REVOKED']
            assert all(event['actor_user_id'] and event['actor_session_id'] for event in events)
            assert smoke.provider(owner['token'], 'GET', base+'/contents/'+workflow_path)['sha'] == expected_blob
            logs = command('logs', '--no-color', 'golf')
            assert not any(value in logs for value in private)
            for active in [session, reader['session'], outside['session']]:
                rpc(active, 'SessionService/Logout')
            print('PASS: real personal PAT grant creation/read, exact replay/collision, immutable native binding, bounded input/authority denials, encrypted metadata-only persistence, logout independence/restart, explicit revoke/audit, source unchanged and no automatic runs', flush=True)
        finally:
            smoke.GOLF, smoke.FORGE = original
            if started:
                command('down', '--volumes', '--remove-orphans', timeout=120)
            for resource, action in [('container', 'ls'), ('volume', 'ls'), ('network', 'ls')]:
                extra = ['-a'] if resource == 'container' else []
                assert not run('docker', resource, action, *extra, '-q', '--filter',
                    'label=com.docker.compose.project='+project).strip()
            print('PASS: disposable containers/volumes/network and private configuration removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        lines = ','.join(str(item.lineno) for item in traceback.extract_tb(error.__traceback__) if item.filename == __file__)
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+lines+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
