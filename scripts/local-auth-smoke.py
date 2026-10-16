#!/usr/bin/env python3
"""Qualify operator-enrolled Golf passwords against an isolated native core.

Requires a locally built current image. Ordinary provider APIs/CLI create only
disposable fixtures. Passwords/PATs enter the Golf operator through JSON stdin;
the normal Compose installation and its local administrator are never touched.
--browser also runs the separate real UI harness inside this disposable core.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
import smoke

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('observe_helpers', ROOT / 'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
STAGE = 'prerequisites'


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: ' + value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='already-built current Golf image')
    parser.add_argument('--browser', action='store_true', help='also run the native password UI proof')
    args = parser.parse_args()
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith(('GOLF_', 'FORGEJO_', 'OTEL_', 'POSTGRES_', 'COMPOSE_')) and key != 'DATABASE_URL'}
    forbidden = []

    def run(*arguments, payload=None, success=True, timeout=120):
        result = subprocess.run(arguments, input=None if payload is None else json.dumps(payload).encode(),
            capture_output=True, cwd=ROOT, env=environment, timeout=timeout)
        assert (result.returncode == 0) == success, 'Private subprocess failed; diagnostics withheld'
        assert len(result.stdout) <= 8 << 20 and len(result.stderr) <= 8 << 20
        return result.stdout.decode()

    image = json.loads(run('docker', 'image', 'inspect', args.image))[0]['Id']
    assert image.startswith('sha256:')
    print('Golf image: ' + image, flush=True)
    project = 'golf-api-proof-' + secrets.token_hex(5)
    golf_port, forge_port = helpers.free_ports(2)
    original_urls = smoke.GOLF, smoke.FORGE
    smoke.GOLF, smoke.FORGE = f'http://127.0.0.1:{golf_port}', f'http://127.0.0.1:{forge_port}'
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary).resolve(); directory.chmod(0o700)
        env_file, override = directory/'core.env', directory/'proof.yaml'
        values = {name: secrets.token_hex(24) for name in ['POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'FORGEJO_DB_PASSWORD']} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
            GOLF_PUBLIC_URL=smoke.GOLF, GOLF_ENCRYPTION_KEYS='', GOLF_ACTIVE_ENCRYPTION_KEY='',
            GOLF_FORGE_PUBLIC_URL='', GOLF_FORGE_OAUTH_CLIENT_ID='', GOLF_FORGE_OAUTH_CLIENT_SECRET='')
        forbidden.extend(value for key, value in values.items() if value and key not in ('GOLF_PUBLIC_URL', 'GOLF_FORGE_INSTANCE_ID'))
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
    ports: !override ["127.0.0.1:{forge_port}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file),
            '-f', str(ROOT/'compose.yaml'), '-f', str(override)]

        def command(*arguments, **kwargs):
            return run(*compose, *arguments, **kwargs)

        def admin(*arguments):
            return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini',  # Forgejo's upstream path
                'admin', 'user', *arguments).strip()

        def operator(action, payload, success=True):
            output = command('exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action,
                payload=payload, success=success)
            assert not any(value in output for value in forbidden), 'Credential appeared in operator output'
            result = json.loads(output)
            assert result['schema_version'] == 'golf.local-account.v1'
            assert result['state'] == ('complete' if success else 'failed')
            if success:
                assert set(result['result']) - {'email'} == {'id', 'username', 'user_id', 'is_instance_admin', 'disabled', 'credential_version', 'sessions_revoked'}
            return result

        def login(username, password, expected=200):
            session = smoke.client()
            result = smoke.rpc(session, 'SessionService/LoginWithPassword',
                {'username': username, 'password': password}, expected=expected)
            return session, result

        started = False
        try:
            stage('fresh canonical core and scoped native users')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            assert json.loads(run('docker', 'inspect', project+'-golf-1'))[0]['Image'] == image
            native_names = ['native-'+secrets.token_hex(5), 'native-admin-'+secrets.token_hex(5)]
            native_tokens = []
            for index, name in enumerate(native_names):
                arguments = ['create', '--username', name, '--email', name+'@example.invalid',
                    '--random-password', '--must-change-password=false']
                if index: arguments.append('--admin')
                admin(*arguments)
                token = admin('generate-access-token', '--username', name, '--token-name', project,
                    '--scopes', 'read:user' if index else 'write:user,write:repository,write:issue', '--raw')
                forbidden.append(token); native_tokens.append(token)
            native_owner = smoke.provider(native_tokens[0], 'GET', 'user')
            assert not native_owner['is_admin']
            assert smoke.provider(native_tokens[1], 'GET', 'user')['is_admin']
            local_names = ['golf-'+secrets.token_hex(5), 'golf-other-'+secrets.token_hex(5)]
            passwords = ['Golf-only — '+secrets.token_urlsafe(24) for _ in local_names]
            forbidden.extend(passwords)

            stage('explicit immutable mapping and independent Golf role')
            for index, name in enumerate(local_names):
                operator('create', {'username': name, 'email': name+'@example.invalid', 'password': passwords[index],
                    'forge_token': native_tokens[index], 'is_instance_admin': index == 0})
            options = smoke.rpc(smoke.client(), 'SessionService/GetAuthenticationOptions')
            assert options.get('localPasswordEnabled')
            operator('create', {'username': local_names[0], 'password': passwords[0],
                'forge_token': native_tokens[1], 'is_instance_admin': False}, success=False)
            owner, signed = login(local_names[0].upper()+'@EXAMPLE.INVALID', passwords[0])
            assert signed['user']['id'] == str(native_owner['id']) and signed['user']['login'] == native_names[0]
            assert signed['user'].get('isInstanceAdmin', False)
            separate_pat = smoke.client()
            pat_user = smoke.rpc(separate_pat, 'SessionService/LoginWithForgeToken', {'token': native_tokens[0]})['user']
            assert not pat_user.get('isInstanceAdmin', False)
            outsider, other = login(local_names[1], passwords[1])
            assert not other['user'].get('isInstanceAdmin', False)
            smoke.rpc(outsider, 'SessionService/Logout')
            operator('disable', {'username': local_names[1]})
            wrong = login(local_names[0], 'Different password '+secrets.token_hex(12), 401)[1]
            unknown = login('missing-'+secrets.token_hex(5), passwords[0], 401)[1]
            assert wrong == unknown
            smoke.rpc(smoke.client(), 'SessionService/LoginWithPassword', {'username': local_names[0],
                'password': passwords[0]}, expected=403, headers={'Origin': 'http://invalid.example'})
            basic = base64.b64encode((native_names[0]+':'+passwords[0]).encode()).decode()
            smoke.request(smoke.client(), 'GET', smoke.FORGE+'/api/v1/user',
                headers={'Authorization': 'Basic '+basic}, expected=401)

            stage('actual private repository creation and pinned source')
            request = {'name': 'local-auth-private', 'private': True, 'idempotencyKey': str(uuid.uuid4())}
            created = smoke.rpc(owner, 'RepositoryService/CreateRepository', request)
            assert created['creation']['state'] == 'REPOSITORY_CREATION_STATE_SUCCEEDED'
            repository = created['repository']; key = {'owner': native_names[0], 'name': repository['name']}
            source = 'Local Golf password, actual native repository.\n<script>plain source</script>\n'
            native_file = smoke.provider(native_tokens[0], 'POST', 'repos/'+repository['fullName']+'/contents/README.md',
                {'message': 'Local auth source fixture', 'content': base64.b64encode(source.encode()).decode()}, expected=201)
            smoke.wait_for_push(native_tokens[0], repository['fullName'])
            contents = smoke.content(owner, key, native_file['commit']['sha'], 'README.md')
            assert contents['commitId'] == native_file['commit']['sha'] and contents['file']['content'] == source
            observed = smoke.provider(native_tokens[0], 'GET', 'repos/'+repository['fullName'])
            assert str(observed['id']) == repository['id'] and observed['private']

            stage('local session, source-bound delegation, reset and disable')
            sessions = smoke.rpc(owner, 'SessionService/ListSessions')['sessions']
            current = next(session for session in sessions if session.get('current'))
            assert current['credentialKind'] == 'local'
            issued = smoke.rpc(owner, 'ApiCredentialService/CreateApiCredential', {'label': 'local auth proof'})
            forbidden.append(issued['token'])
            smoke.rpc(smoke.client(), 'SessionService/GetSession', headers={'Authorization': 'Bearer '+issued['token']})
            replacement = 'Reset Golf password — '+secrets.token_urlsafe(24); forbidden.append(replacement)
            operator('reset-password', {'username': local_names[0], 'password': replacement})
            smoke.rpc(owner, 'SessionService/GetSession', expected=401)
            smoke.rpc(smoke.client(), 'SessionService/GetSession', expected=401,
                headers={'Authorization': 'Bearer '+issued['token']})
            login(local_names[0], passwords[0], 401)
            owner, _ = login(local_names[0], replacement)
            operator('disable', {'username': local_names[0]})
            smoke.rpc(owner, 'SessionService/GetSession', expected=401)
            assert smoke.rpc(separate_pat, 'SessionService/GetSession')['user']['id'] == signed['user']['id']
            smoke.rpc(separate_pat, 'SessionService/Logout')
            login(local_names[0], replacement, 401)
            enabled_password = 'Reauthorized Golf password — '+secrets.token_urlsafe(24); forbidden.append(enabled_password)
            operator('reset-password', {'username': local_names[0], 'password': enabled_password})
            login(local_names[0], enabled_password, 401)
            operator('enable', {'username': local_names[0], 'password': enabled_password,
                'forge_token': native_tokens[1]}, success=False)
            login(local_names[0], enabled_password, 401)
            operator('enable', {'username': local_names[0], 'password': enabled_password, 'forge_token': native_tokens[0]})
            owner, after_enable = login(local_names[0], enabled_password)
            assert after_enable['user'] == signed['user']

            stage('credential inventory, independent session revocation and whole-core restart')
            status = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf', 'keys', 'status'))
            assert sum(row.get('local_accounts', 0) for row in status['result']['keys']) == 2
            second, _ = login(local_names[0], enabled_password)
            second_sessions = smoke.rpc(second, 'SessionService/ListSessions')['sessions']
            second_id = next(session['id'] for session in second_sessions if session.get('current'))
            smoke.rpc(owner, 'SessionService/RevokeSession', {'sessionId': second_id})
            smoke.rpc(second, 'SessionService/GetSession', expected=401)
            command('restart', timeout=180); smoke.ready()
            assert smoke.rpc(owner, 'SessionService/GetSession')['user'] == signed['user']
            assert smoke.rpc(owner, 'RepositoryService/GetRepository', {'repository': key})['repository']['id'] == repository['id']
            smoke.rpc(owner, 'SessionService/Logout')
            smoke.rpc(owner, 'SessionService/GetSession', expected=401)
            after_restart, _ = login(local_names[0], enabled_password)
            smoke.rpc(after_restart, 'SessionService/Logout')
            print('PASS: native local authentication, independent roles/passwords, scoped source/create, lifecycle, inventory and restart', flush=True)

            stage('drained persistent local-account key rotation and old-key retirement')
            command('stop', 'golf')
            next_key = base64.b64encode(secrets.token_bytes(32)).decode(); forbidden.append(next_key)
            values['GOLF_ENCRYPTION_KEYS'] = json.dumps({'legacy': values['GOLF_ENCRYPTION_KEY'], 'next': next_key})
            values['GOLF_ACTIVE_ENCRYPTION_KEY'] = 'next'
            env_file.write_text(''.join(key+'='+value+'\n' for key,value in values.items()))
            def keys(*arguments, state='complete'):
                output = command('run', '--rm', '--no-deps', '-T', 'golf', 'keys', *arguments)
                assert not any(value in output for value in forbidden)
                result = json.loads(output)
                assert result['schema_version'] == 'golf.keys.v1' and result['state'] == state
                return result['result']
            keys('activate')
            rotated = keys('rotate', '--batch-size', '100', '--max-batches', '10')
            assert rotated['complete'] and rotated['rotated_local_accounts'] == 2
            keys('retirement-check', '--key-id', 'legacy', state='eligible')
            values['GOLF_ENCRYPTION_KEY'] = ''
            values['GOLF_ENCRYPTION_KEYS'] = json.dumps({'next': next_key})
            env_file.write_text(''.join(key+'='+value+'\n' for key,value in values.items()))
            command('up', '-d', '--no-build', 'golf'); smoke.ready()
            rotated_session, _ = login(local_names[0], enabled_password)
            assert smoke.rpc(rotated_session, 'RepositoryService/GetRepository', {'repository': key})['repository']['id'] == repository['id']
            smoke.rpc(rotated_session, 'SessionService/Logout')
            print('PASS: active and disabled local-account credentials rotate; login works after removing the retired key', flush=True)

            stage('native account deletion denies the previously mapped local account')
            revoked, _ = login(local_names[0], enabled_password)
            admin('delete', '--username', native_names[0], '--purge')
            smoke.rpc(revoked, 'SessionService/GetSession', expected=401)
            login(local_names[0], enabled_password, 401)
            print('PASS: native identity removal does not relink or authorize a local password', flush=True)

            stage('durable bounded login throttling and explicit operator bucket reset')
            operator('reset-password', {'username': local_names[1], 'password': passwords[1]})
            for _ in range(10):
                login(local_names[1], passwords[1], 401)
            login(local_names[1], passwords[1], 429)
            command('restart', 'golf'); smoke.ready()
            login(local_names[1], passwords[1], 429)
            operator('reset-password', {'username': local_names[1], 'password': passwords[1]})
            login(local_names[1], passwords[1], 401)
            print('PASS: rate limit survives restart; operator reset clears only its bucket and does not enable the account', flush=True)

            if args.browser:
                stage('production-served native password browser workflow')
                target = directory/'target.json'
                helpers.private_write(target, json.dumps({'project': project, 'golf': smoke.GOLF, 'forge': smoke.FORGE,
                    'container': project+'-forgejo-1', 'golfContainer': project+'-golf-1', 'image': image}))
                output = run('node', 'web/tests/local-auth-live.mjs', '--target', str(target), timeout=240)
                assert not any(value in output for value in forbidden)
                for line in output.splitlines():
                    if line.startswith(('PASS:', 'Checking:')): print(line, flush=True)
        finally:
            smoke.GOLF, smoke.FORGE = original_urls
            if started:
                command('down', '--volumes', '--remove-orphans', '--timeout', '10')
            for resource, action in [('container', 'ls'), ('volume', 'ls'), ('network', 'ls')]:
                extra = ['-a'] if resource == 'container' else []
                assert not run('docker', resource, action, *extra, '-q', '--filter',
                    'label=com.docker.compose.project='+project).strip()
            print('PASS: isolated containers, volumes and network removed; normal installation untouched', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        locations = ','.join(str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)[-3:])
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+locations+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
