#!/usr/bin/env python3
"""Qualify own-profile public edits against a fresh disposable Compose core."""
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

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('profile_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
STAGE = 'initialization'

def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_','GITEA_','POSTGRES_','OTEL_','COMPOSE_')) and key!='DATABASE_URL'}
    private = []
    def run(*arguments, payload=None, timeout=120):
        result = subprocess.run(arguments, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, cwd=ROOT, env=environment, timeout=timeout)
        assert result.returncode==0, 'Private subprocess failed'
        text = result.stdout.decode()
        assert not any(x in text for x in private)
        return text
    image = json.loads(run('docker','image','inspect',args.image))[0]['Id']
    print('Golf image: '+image, flush=True)
    project = 'golf-profile-proof-'+secrets.token_hex(5)
    golf_port,forge_port = helpers.free_ports(2)
    original = smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA = f'http://127.0.0.1:{golf_port}',f'http://127.0.0.1:{forge_port}'
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700)
        env_file,override=directory/'core.env',directory/'proof.yaml'
        values={name:secrets.token_hex(24) for name in ['POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_ENCRYPTION_KEYS='',GOLF_ACTIVE_ENCRYPTION_KEY='',GITEA_PUBLIC_URL='',GITEA_OAUTH_CLIENT_ID='',GITEA_OAUTH_CLIENT_SECRET='')
        private.extend(x for key,x in values.items() if x and key!='GOLF_PUBLIC_URL')
        helpers.private_write(env_file,''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{forge_port}:3000"]
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(override)]
        def command(*arguments,**kwargs):return run(*compose,*arguments,**kwargs)
        def admin(*arguments):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments).strip()
        started=False
        try:
            stage('fresh core and scoped disposable native accounts')
            started=True;command('up','-d','--no-build','--wait','--wait-timeout','120',timeout=180);smoke.ready()
            assert smoke.provider('','GET','version')['version']=='1.27.3'
            actors=[]
            for role,scope in [('writer','write:user'),('reader','read:user')]:
                native=project+'-'+role
                admin('create','--username',native,'--email',native+'@example.invalid','--random-password','--must-change-password=false')
                token=admin('generate-access-token','--username',native,'--token-name',project,'--scopes',scope,'--raw');private.append(token)
                user=smoke.provider(token,'GET','user')
                local=project+'-local-'+role;password='Golf-only '+secrets.token_urlsafe(24);private.append(password)
                enrolled=json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account','create',payload={'username':local,'email':local+'@example.invalid','password':password,'forge_token':token,'is_instance_admin':False}))
                assert enrolled['state']=='complete'
                session=smoke.client();signed=smoke.rpc(session,'SessionService/LoginWithPassword',{'username':local+'@example.invalid','password':password})
                assert signed['user']['id']==str(user['id'])
                actors.append((session,token,user,local,password))
            owner,token,user,local,password=actors[0]
            read=lambda:smoke.rpc(owner,'ProfileService/GetProfile')['profile']
            before=read();assert before['userId']==str(user['id']) and before['login']==user['login'] and before['canEdit']
            payload=lambda p,**changes:{'userId':p['userId'],'expectedRevision':p['revision'],**changes}
            stage('native four-field write:user PATCH and verified local readback')
            changed=smoke.rpc(owner,'ProfileService/UpdateProfile',payload(before,fullName='Golf Developer',bio='Builds tools\nwith Golf',location='London',website='https://example.invalid/golf'))['profile']
            assert changed['fullName']=='Golf Developer' and changed['bio']=='Builds tools\nwith Golf' and changed['location']=='London' and changed['website']=='https://example.invalid/golf'
            native=smoke.provider(token,'GET','user/settings')
            assert native['full_name']==changed['fullName'] and native['description']==changed['bio'] and native['location']==changed['location'] and native['website']==changed['website']
            assert read()['revision']==changed['revision']
            assert smoke.rpc(owner,'SessionService/GetSession')['user']['fullName']=='Golf Developer'
            smoke.rpc(owner,'ProfileService/UpdateProfile',payload(before,fullName='Stale'),expected=400,code='failed_precondition')
            smoke.rpc(owner,'ProfileService/UpdateProfile',{**payload(changed,fullName='Foreign'),'userId':str(actors[1][2]['id'])},expected=403)
            smoke.rpc(owner,'ProfileService/UpdateProfile',payload(changed,website='javascript:alert(1)'),expected=400)
            smoke.rpc(owner,'ProfileService/UpdateProfile',payload(changed,fullName='é'*51),expected=400)
            smoke.rpc(owner,'ProfileService/UpdateProfile',payload(changed,fullName='Wrong origin'),headers={'Origin':'https://other.invalid'},expected=403)
            readonly=actors[1][0];reader=smoke.rpc(readonly,'ProfileService/GetProfile')['profile']
            smoke.rpc(readonly,'ProfileService/UpdateProfile',payload(reader,fullName='No native grant'),expected=403)
            final=smoke.rpc(owner,'ProfileService/UpdateProfile',payload(changed,fullName='',bio='',location='',website=''))['profile']
            assert all(final.get(field,'')=='' for field in ['fullName','bio','location','website'])
            stage('restart durability and independent email/password identity')
            command('restart','golf');smoke.ready()
            assert read()['revision']==final['revision']
            fresh=smoke.client();assert smoke.rpc(fresh,'SessionService/LoginWithPassword',{'username':local+'@example.invalid','password':password})['user']['id']==str(user['id'])
            credential=smoke.rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Profile boundary'})['token'];private.append(credential)
            for method in ['GetProfile','UpdateProfile']:
                smoke.rpc(smoke.client(),'ProfileService/'+method,{},headers={'Authorization':'Bearer '+credential},expected=403)
            smoke.rpc(owner,'SessionService/Logout')
            smoke.rpc(owner,'ProfileService/UpdateProfile',payload(final,fullName='Revoked'),expected=401)
            assert smoke.provider(token,'GET','user/settings')['full_name']==''
            for session,*_ in actors[1:]:smoke.rpc(session,'SessionService/Logout')
            smoke.rpc(fresh,'SessionService/Logout')
            print('PASS: supported own four-field profile PATCH/clear/native readback, immutable ID and stale revision, native read-only denial, Origin/bearer/revoked-session, restart and independent local email/password',flush=True)
        finally:
            smoke.GOLF,smoke.GITEA=original
            if started:command('down','--volumes','--remove-orphans',timeout=120)
            for resource,action in [('container','ls'),('volume','ls'),('network','ls')]:
                extra=['-a'] if resource=='container' else []
                assert not run('docker',resource,action,*extra,'-q','--filter','label=com.docker.compose.project='+project).strip()
            print('PASS: isolated project containers/volumes/network removed',flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:
        import traceback
        lines=','.join(str(x.lineno) for x in traceback.extract_tb(error.__traceback__)[-3:])
        print('FAIL: '+STAGE+' ('+type(error).__name__+', lines '+lines+'; private diagnostics withheld)',file=sys.stderr)
        raise SystemExit(1)
