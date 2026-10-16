#!/usr/bin/env python3
"""Qualify local-account administration and own credential changes on a fresh core.

Native users are disposable fixtures created through Forgejo's operator CLI.
Golf enrollment binds those existing identities; it never provisions native
users. Login emails here are unverified aliases, not proof of mailbox ownership.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import smoke
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lifecycle_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
STAGE = 'initialization'


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    environment = {key: value for key, value in os.environ.items() if not key.startswith(
        ('GOLF_', 'FORGEJO_', 'POSTGRES_', 'OTEL_', 'COMPOSE_', 'RUSTFS_', 'AWS_')) and key != 'DATABASE_URL'}
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
    project = 'golf-lifecycle-proof-'+secrets.token_hex(5)
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
            GOLF_FORGE_PUBLIC_URL='', GOLF_FORGE_OAUTH_CLIENT_ID='', GOLF_FORGE_OAUTH_CLIENT_SECRET='')
        private.extend(value for key, value in values.items() if value and key not in ('GOLF_PUBLIC_URL', 'GOLF_FORGE_INSTANCE_ID'))
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key, value in values.items()))
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

        def native_admin(*arguments):
            return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini',  # Forgejo's upstream path
                'admin', 'user', *arguments).strip()

        def operator(action, payload):
            result = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf',
                'local-account', action, payload=payload))
            assert result['state'] == 'complete'
            return result['result']

        def sql(query):
            # Read only Golf metadata/checksums. Never reads native tables or
            # prints private ciphertext, passwords, tokens or database URLs.
            return command('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf',
                '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query).strip()

        def login(name, password, expected=200):
            session = smoke.client()
            result = smoke.rpc(session, 'SessionService/LoginWithPassword',
                {'username': name, 'password': password}, expected=expected)
            return session, result

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

        def bearer(session, label):
            result = rpc(session, 'ApiCredentialService/CreateApiCredential', {'label': label})
            private.append(result['token'])
            return result['token']

        def source_denied(sessions, token):
            for session in sessions:
                rpc(session, 'SessionService/GetSession', expected=401)
            rpc(smoke.client(), 'SessionService/GetSession', headers={'Authorization': 'Bearer '+token}, expected=401)

        started = False
        try:
            stage('fresh native core and immutable fixture identities')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            assert run('docker', 'inspect', '--format', '{{.Image}}', project+'-golf-1').strip() == image
            identities = {}
            for role in ['admin', 'second', 'managed', 'self']:
                name = role+'-'+secrets.token_hex(5)
                native_admin('create', '--username', name, '--email', name+'@example.invalid',
                    '--random-password', '--must-change-password=false')
                token = native_admin('generate-access-token', '--username', name, '--token-name', project,
                    '--scopes', 'read:user', '--raw')
                private.append(token)
                native = smoke.provider(token, 'GET', 'user')
                identities[role] = {'native': native, 'token': token, 'name': 'local-'+name,
                    'email': 'local-'+name+'@example.invalid', 'password': 'Golf-only '+secrets.token_urlsafe(24)}
                private.append(identities[role]['password'])
            for role in ['admin', 'second']:
                item = identities[role]
                item['account'] = operator('create', {'username': item['name'], 'email': item['email'],
                    'password': item['password'], 'forge_token': item['token'], 'is_instance_admin': True})
                item['session'], result = login(item['email'], item['password'])
                assert result['user']['isInstanceAdmin'] and not item['native']['is_admin']
            actor, second, managed, own = [identities[key] for key in ['admin', 'second', 'managed', 'self']]
            admin, other_admin = actor['session'], second['session']
            pat = smoke.client()
            rpc(pat, 'SessionService/LoginWithForgeToken', {'token': actor['token']})
            delegated = bearer(admin, 'admin read boundary')

            def enrollment(item, confirmation=None):
                return {'username': item['name'], 'email': item['email'], 'password': item['password'],
                    'forgeToken': item['token'], 'expectedNativeUserId': str(item['native']['id']),
                    'passwordConfirmation': confirmation or actor['password']}

            def change(item, confirmation=None):
                return {'accountId': item['account']['id'],
                    'expectedCredentialVersion': item['account']['credentialVersion'],
                    'password': item['replacement'], 'passwordConfirmation': confirmation or actor['password']}

            stage('password-confirmed ordinary enrollment and authority denials')
            rpc(admin, 'InstanceAdminService/EnrollRegularLocalAccount',
                {**enrollment(managed), 'passwordConfirmation': 'Wrong administrator password!'}, expected=403)
            rpc(admin, 'InstanceAdminService/EnrollRegularLocalAccount',
                {**enrollment(managed), 'expectedNativeUserId': str(own['native']['id'])}, expected=400)
            rpc(admin, 'InstanceAdminService/EnrollRegularLocalAccount', enrollment(managed),
                headers={'Origin': 'https://other.invalid'}, expected=403)
            for session, headers in [(pat, {}), (smoke.client(), {'Authorization': 'Bearer '+delegated})]:
                rpc(session, 'InstanceAdminService/EnrollRegularLocalAccount', enrollment(managed), headers=headers, expected=403)
            for item in [managed, own]:
                # Connect ignores unknown JSON fields. A forged role field
                # must still create only an ordinary Golf account.
                result = rpc(admin, 'InstanceAdminService/EnrollRegularLocalAccount',
                    {**enrollment(item), 'isInstanceAdmin': True})
                item['account'] = result['account']
                assert not item['account'].get('isInstanceAdmin', False) and not item['account'].get('disabled', False)
                assert item['account']['nativeUserId'] == str(item['native']['id'])
                assert item['account']['credentialVersion'] == '1' and result.get('sessionsRevoked', '0') == '0'
                assert result['operationId']
            first, _ = login(managed['email'], managed['password'])
            second_session, _ = login(managed['name'], managed['password'])
            read_token = bearer(first, 'reset dependent source')
            for method in ['EnrollRegularLocalAccount', 'ResetRegularLocalPassword', 'EnableRegularLocalAccount']:
                rpc(first, 'InstanceAdminService/'+method, {}, expected=403)
                rpc(pat, 'InstanceAdminService/'+method, {}, expected=403)
                rpc(smoke.client(), 'InstanceAdminService/'+method, {}, headers={'Authorization': 'Bearer '+delegated}, expected=403)
            protected = {'accountId': actor['account']['id'], 'expectedCredentialVersion': '1',
                'password': 'Unused replacement password', 'passwordConfirmation': second['password'], 'forgeToken': actor['token']}
            for method in ['ResetRegularLocalPassword', 'EnableRegularLocalAccount']:
                payload = dict(protected)
                if method == 'ResetRegularLocalPassword':
                    del payload['forgeToken']
                rpc(other_admin, 'InstanceAdminService/'+method, payload, expected=403)
            rpc(other_admin, 'InstanceAdminService/EnrollRegularLocalAccount',
                enrollment(actor, second['password']), expected=403)
            # New immutable enrollment cannot replace an existing ordinary map.
            rpc(other_admin, 'InstanceAdminService/EnrollRegularLocalAccount',
                enrollment(managed, second['password']), expected=400, code='failed_precondition')
            stored = sql("SELECT json_build_object('hash',password_hash,'cipher',encode(encrypted_forge_token,'hex'),'binding',encode(credential_binding,'hex'),'key',credential_key_id)::text FROM golf_local_accounts WHERE id="+managed['account']['id'])
            encrypted = json.loads(stored)
            assert encrypted['hash'].startswith('$argon2id$') and len(encrypted['binding']) == 64
            assert managed['token'].encode().hex() not in encrypted['cipher']

            stage('version-fenced reset revokes local sessions and delegated credentials')
            managed['replacement'] = 'Reset Golf password '+secrets.token_urlsafe(24)
            private.append(managed['replacement'])
            rpc(other_admin, 'InstanceAdminService/ResetRegularLocalPassword',
                {**change(managed, second['password']), 'expectedCredentialVersion': '2'}, expected=400, code='failed_precondition')
            result = rpc(admin, 'InstanceAdminService/ResetRegularLocalPassword', change(managed))
            assert result['sessionsRevoked'] == '2' and result['account']['credentialVersion'] == '2'
            assert not result['account'].get('disabled', False)
            managed['account'] = result['account']
            source_denied([first, second_session], read_token)
            login(managed['name'], managed['password'], 401)
            fresh, _ = login(managed['name'], managed['replacement'])
            assert smoke.provider(managed['token'], 'GET', 'user')['id'] == managed['native']['id']
            rpc(pat, 'SessionService/GetSession')

            stage('disabled state and fresh immutable credential requirement for enable')
            disabled = rpc(admin, 'InstanceAdminService/DisableLocalAccount', {
                'accountId': managed['account']['id'], 'expectedCredentialVersion': '2', 'passwordConfirmation': actor['password']})
            assert disabled['account']['disabled'] and disabled['sessionsRevoked'] == '1'
            managed['account'] = disabled['account']
            rpc(fresh, 'SessionService/GetSession', expected=401)
            # Resetting a disabled password never revives the account.
            reset_disabled = rpc(other_admin, 'InstanceAdminService/ResetRegularLocalPassword', change(managed, second['password']))
            assert reset_disabled['account']['disabled'] and reset_disabled['account']['credentialVersion'] == '4'
            managed['account'] = reset_disabled['account']
            rpc(admin, 'InstanceAdminService/EnableRegularLocalAccount',
                {**change(managed), 'forgeToken': own['token']}, expected=400)
            replacement_token = native_admin('generate-access-token', '--username', managed['native']['login'],
                '--token-name', project+'-enable', '--scopes', 'read:user', '--raw')
            private.append(replacement_token)
            enabled = rpc(admin, 'InstanceAdminService/EnableRegularLocalAccount',
                {**change(managed), 'forgeToken': replacement_token})
            assert not enabled['account'].get('disabled', False) and enabled['account']['credentialVersion'] == '5'
            assert enabled['account']['nativeUserId'] == str(managed['native']['id'])
            assert not enabled['account'].get('isInstanceAdmin', False)
            managed['account'] = enabled['account']
            fresh, _ = login(managed['name'], managed['replacement'])
            assert sql('SELECT encode(credential_binding,\'hex\') FROM golf_local_accounts WHERE id='+managed['account']['id']) == encrypted['binding']
            assert sql('SELECT encode(encrypted_forge_token,\'hex\') FROM golf_local_accounts WHERE id='+managed['account']['id']) != encrypted['cipher']

            stage('own password change clears all bound sessions without native mutation')
            owner, _ = login(own['email'], own['password'])
            owner_second, _ = login(own['name'], own['password'])
            own_bearer = bearer(owner, 'own password source')
            security = rpc(owner, 'AccountSecurityService/GetAccountSecurity')['security']
            assert security['canManage'] and security['userId'] == str(own['native']['id'])
            pat_security = rpc(pat, 'AccountSecurityService/GetAccountSecurity')['security']
            assert not pat_security.get('canManage', False) and not pat_security.get('loginEmail', '')

            def own_payload(snapshot, confirmation):
                return {'accountId': snapshot['accountId'], 'userId': snapshot['userId'],
                    'expectedCredentialVersion': snapshot['credentialVersion'], 'passwordConfirmation': confirmation}

            own['replacement'] = 'Self new password '+secrets.token_urlsafe(24)
            private.append(own['replacement'])
            request = {**own_payload(security, own['password']), 'newPassword': own['replacement']}
            rpc(owner, 'AccountSecurityService/ChangeOwnPassword', {**request, 'expectedCredentialVersion': '2'}, expected=400, code='failed_precondition')
            rpc(owner, 'AccountSecurityService/ChangeOwnPassword', {**request, 'userId': str(managed['native']['id'])}, expected=403)
            rpc(pat, 'AccountSecurityService/ChangeOwnPassword', request, expected=403)
            rpc(smoke.client(), 'AccountSecurityService/ChangeOwnPassword', request, headers={'Authorization': 'Bearer '+own_bearer}, expected=403)
            changed = rpc(owner, 'AccountSecurityService/ChangeOwnPassword', request)
            assert changed['requiresLogin'] and changed['sessionsRevoked'] == '2' and changed['credentialVersion'] == '2'
            source_denied([owner, owner_second], own_bearer)
            login(own['name'], own['password'], 401)
            owner, _ = login(own['email'], own['replacement'])

            stage('unique unverified login alias changes atomically and requires fresh sign-in')
            security = rpc(owner, 'AccountSecurityService/GetAccountSecurity')['security']
            own_bearer = bearer(owner, 'own alias source')
            request = own_payload(security, own['replacement'])
            rpc(owner, 'AccountSecurityService/ChangeOwnLoginEmail', {**request, 'loginEmail': actor['email']}, expected=400)
            unchanged = rpc(owner, 'AccountSecurityService/GetAccountSecurity')['security']
            assert unchanged['credentialVersion'] == '2' and unchanged['loginEmail'] == own['email']
            assert rpc(smoke.client(), 'SessionService/GetSession', headers={'Authorization': 'Bearer '+own_bearer})['user']['id'] == str(own['native']['id'])
            new_email = 'new-'+secrets.token_hex(6)+'@example.invalid'
            changed = rpc(owner, 'AccountSecurityService/ChangeOwnLoginEmail', {**request, 'loginEmail': new_email.upper()})
            assert changed['requiresLogin'] and changed['sessionsRevoked'] == '1' and changed['credentialVersion'] == '3'
            source_denied([owner], own_bearer)
            login(own['email'], own['replacement'], 401)
            alias_session, _ = login(new_email, own['replacement'])
            fallback_session, _ = login(own['name'], own['replacement'])
            assert rpc(alias_session, 'AccountSecurityService/GetAccountSecurity')['security']['loginEmail'] == new_email

            stage('restart durability, exact actor audit and unchanged native profiles/tokens')
            command('restart', 'golf')
            smoke.ready()
            assert rpc(alias_session, 'AccountSecurityService/GetAccountSecurity')['security']['credentialVersion'] == '3'
            assert rpc(fresh, 'SessionService/GetSession')['user']['id'] == str(managed['native']['id'])
            for item in identities.values():
                native = smoke.provider(item['token'], 'GET', 'user')
                for field in ['id', 'login', 'email', 'is_admin']:
                    assert native[field] == item['native'][field]
            audit = json.loads(sql("SELECT COALESCE(json_agg(json_build_object('action',action,'account',account_id::text,'actorUser',actor_user_id::text,'actorSession',actor_session_id::text,'version',credential_version,'revoked',sessions_revoked,'operation',operation_id)), '[]'::json) FROM golf_local_account_events WHERE action LIKE 'ADMIN_%' OR action LIKE 'SELF_%'"))
            counts = {}
            for event in audit:
                counts[event['action']] = counts.get(event['action'], 0)+1
                assert event['actorUser'] and event['actorSession'] and len(event['operation']) == 32
                if event['action'].startswith('SELF_'):
                    assert event['account'] == own['account']['id'] and event['actorUser'] == own['account']['golfUserId']
                else:
                    assert event['actorUser'] in [actor['account']['user_id'], second['account']['user_id']]
            assert counts == {'ADMIN_CREATED': 2, 'ADMIN_PASSWORD_RESET': 2, 'ADMIN_DISABLED': 1,
                'ADMIN_ENABLED': 1, 'SELF_PASSWORD_CHANGED': 1, 'SELF_EMAIL_CHANGED': 1}
            for session in [admin, other_admin, pat, fresh, alias_session, fallback_session]:
                rpc(session, 'SessionService/Logout')
            print('PASS: native admin enrollment/reset/enable, immutable target/source binding, authority and CAS denials, own password/email changes, session/delegation revocation, encrypted credentials, atomic duplicate-alias rollback, actor audit and restart', flush=True)
        finally:
            smoke.GOLF, smoke.FORGE = original
            if started:
                command('down', '--volumes', '--remove-orphans', timeout=120)
            for resource, action in [('container', 'ls'), ('volume', 'ls'), ('network', 'ls')]:
                extra = ['-a'] if resource == 'container' else []
                assert not run('docker', resource, action, *extra, '-q', '--filter',
                    'label=com.docker.compose.project='+project).strip()
            print('PASS: isolated project containers/volumes/network removed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        lines = ','.join(str(item.lineno) for item in traceback.extract_tb(error.__traceback__) if item.filename == __file__)
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+lines+'; private diagnostics withheld)', file=sys.stderr)
        raise SystemExit(1)
