#!/usr/bin/env python3
"""Qualify browser-admin local-account disable against an isolated native core.

Requires a locally built current image. Ordinary provider APIs/CLI create only
disposable fixtures. Passwords/PATs enter the Golf operator through JSON stdin;
the normal Compose installation and its local administrator are never touched.
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
import urllib.error
import urllib.request

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
            stage('fresh canonical disposable core and independent local roles')
            started = True
            command('up', '-d', '--no-build', '--wait', '--wait-timeout', '120', timeout=180)
            smoke.ready()
            assert smoke.provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            assert json.loads(run('docker', 'inspect', project+'-golf-1'))[0]['Image'] == image
            native_names = ['disable-'+secrets.token_hex(5) for _ in range(3)]
            tokens = []
            for name in native_names:
                admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
                tokens.append(admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw'))
            forbidden.extend(tokens)
            names = ['local-'+secrets.token_hex(5) for _ in native_names]
            passwords = ['Golf disable proof '+secrets.token_urlsafe(24) for _ in names]
            forbidden.extend(passwords)
            for index in range(3):
                operator('create',{'username':names[index],'email':names[index]+'@example.invalid','password':passwords[index],
                    'forge_token':tokens[index],'is_instance_admin':index!=1})
            actor,_=login(names[0],passwords[0])
            target,_=login(names[1],passwords[1]);second_target,_=login(names[1],passwords[1])
            target_delegate=smoke.rpc(target,'ApiCredentialService/CreateApiCredential',{'label':'Dependent target credential'})['token']
            forbidden.append(target_delegate)
            pat=smoke.client();smoke.rpc(pat,'SessionService/LoginWithForgeToken',{'token':tokens[1]})
            pat_actor=smoke.client();smoke.rpc(pat_actor,'SessionService/LoginWithForgeToken',{'token':tokens[0]})
            accounts=smoke.rpc(actor,'InstanceAdminService/ListLocalAccounts')['accounts']
            target_account=next(row for row in accounts if row['username']==names[1])
            actor_account=next(row for row in accounts if row['username']==names[0])
            other_admin=next(row for row in accounts if row['username']==names[2])
            request={'accountId':target_account['id'],'expectedCredentialVersion':target_account['credentialVersion'],
                     'passwordConfirmation':passwords[0]}
            actor_session=next(row for row in smoke.rpc(actor,'SessionService/ListSessions')['sessions'] if row.get('current'))
            stage('step-up password, explicit admin role, bearer and protected administrator denial')
            smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',{**request,'passwordConfirmation':'Incorrect '+secrets.token_hex(12)},expected=403)
            smoke.rpc(target,'InstanceAdminService/DisableLocalAccount',request,expected=403)
            smoke.rpc(pat_actor,'InstanceAdminService/DisableLocalAccount',request,expected=403)
            for protected in [actor_account,other_admin]:
                smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',{**request,'accountId':protected['id'],'expectedCredentialVersion':protected['credentialVersion']},expected=403)
            delegated=smoke.rpc(actor,'ApiCredentialService/CreateApiCredential',{'label':'No admin authority'})['token'];forbidden.append(delegated)
            smoke.rpc(smoke.client(),'InstanceAdminService/DisableLocalAccount',request,headers={'Authorization':'Bearer '+delegated},expected=403)
            smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',request,headers={'Origin':'https://other.invalid'},expected=403)
            smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',{**request,'expectedCredentialVersion':'9223372036854775807'},expected=400,code='failed_precondition')
            smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',{**request,'accountId':'9223372036854775807'},expected=404)
            stage('atomic disable, source-session dependent credential revoke and local-only scope')
            disabled=smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',request)
            assert disabled['account']['disabled'] and int(disabled['account']['credentialVersion'])==int(target_account['credentialVersion'])+1
            assert int(disabled['sessionsRevoked'])==2 and disabled['operationId']
            smoke.rpc(actor,'InstanceAdminService/DisableLocalAccount',request,expected=400,code='failed_precondition')
            for session in [target,second_target]:smoke.rpc(session,'SessionService/GetSession',expected=401)
            smoke.rpc(smoke.client(),'SessionService/GetSession',headers={'Authorization':'Bearer '+target_delegate},expected=401)
            login(names[1],passwords[1],401)
            assert smoke.rpc(pat,'SessionService/GetSession')['user']['login']==native_names[1]
            assert smoke.provider(tokens[1],'GET','user')['login']==native_names[1]
            def sql(query):
                return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-Atc',query).strip()
            events=json.loads(sql("SELECT coalesce(json_agg(e),'[]') FROM (SELECT action,operation_id,credential_version,sessions_revoked,actor_user_id,actor_session_id FROM golf_local_account_events WHERE action='ADMIN_DISABLED' ORDER BY id) e;"))
            assert len(events)==1
            event=events[0]
            assert event['operation_id']==disabled['operationId'] and event['credential_version']==int(disabled['account']['credentialVersion'])
            assert event['sessions_revoked']==2 and event['actor_user_id']==int(actor_account['golfUserId']) and event['actor_session_id']==int(actor_session['id'])
            stage('restart persistence and retained actor evidence')
            command('restart','golf');smoke.ready()
            accounts=smoke.rpc(actor,'InstanceAdminService/ListLocalAccounts')['accounts']
            persisted=next(row for row in accounts if row['id']==target_account['id'])
            assert persisted['disabled'] and persisted['credentialVersion']==disabled['account']['credentialVersion']
            login(names[1],passwords[1],401)
            assert sql("SELECT count(*) FROM golf_local_account_events WHERE action='ADMIN_DISABLED';")=='1'
            stage('shared durable step-up and login throttle')
            rate_limited=False
            for _ in range(12):
                req=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.InstanceAdminService/DisableLocalAccount',
                    data=json.dumps({**request,'passwordConfirmation':'Invalid '+secrets.token_hex(12)}).encode(),
                    headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1'})
                try:response=actor.open(req,timeout=15)
                except urllib.error.HTTPError as error:response=error
                with response:
                    status=response.status
                    result=json.loads(response.read())
                if status==429:
                    assert result['code']=='resource_exhausted'
                    rate_limited=True;break
                assert status==403 and result['code']=='permission_denied'
            assert rate_limited
            login(names[0],passwords[0],429)
            command('restart','golf');smoke.ready();login(names[0],passwords[0],429)
            print('PASS: actual disposable-core admin password step-up, ordinary target CAS/disable, atomic actor audit, session/delegation revocation, administrator/PAT/bearer/Origin denial, restart and shared durable throttle; native account and independent PAT remain authorized',flush=True)
        finally:
            smoke.GOLF,smoke.FORGE=original_urls
            if started:command('down','--volumes','--remove-orphans','--timeout','10')
            for resource,action in [('container','ls'),('volume','ls'),('network','ls')]:
                extra=['-a'] if resource=='container' else []
                assert not run('docker',resource,action,*extra,'--filter','label=com.docker.compose.project='+project,'-q').strip(),'Disposable core cleanup incomplete'


if __name__=='__main__':
    try:main()
    except Exception:
        print('FAIL at '+STAGE+': private fixture diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
