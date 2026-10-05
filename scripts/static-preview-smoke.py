#!/usr/bin/env python3
"""Actual disposable protected-static-preview qualification; root runs resources.

Cached exact images only; private CA, direct TLS and separate wildcard origins.
Reuses the actual GitLab artifact fixture, native proxy and owned cleanup helpers.
Credentials stay in RAM/stdin/private temporary files. Never touches retained data,
native SQL/repository files, host DNS/trust or remote providers. Failed receipts
remain failed. Run twice (default PostgreSQL and --rustfs) for both storage paths.
--self-check is pure: no Docker, browser, network or database operations.
"""
import argparse
import base64
import datetime
import hashlib
import http.client
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
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
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import smoke
import native_qualification_proxy as native_proxy


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


artifact = load('preview_artifact_fixture', 'workflow-artifacts-smoke.py')
helpers, rules, notifications = artifact.helpers, artifact.rules, artifact.notifications
SERVICE = 'RepositoryDeploymentService/'
ENV = 'RepositoryEnvironmentService/'
CONTRACT = 'golf.repository.local-static.v1'
STAGE = 'arguments'
REPORT_FAILURE = None


def uuid4():
    return str(uuid.uuid4())


def deployment_receipt(value, request, prepared, environment, actor):
    assert value['contract'] == CONTRACT and value['id'] == request['deploymentId']
    assert value['actorId'] == actor['id'] and value['target'] == request['target']
    assert value['artifact'] == prepared['artifact'] and value['policy'] == environment['policy']
    for name in ('manifestSha256', 'environmentId', 'environmentVersion', 'source', 'staticRoot', 'targetFingerprint'):
        assert value[name] == request[name]
    assert value['environmentName'] == environment['name']
    assert value['state'] in {'REQUESTED', 'READY', 'REVOKED', 'EXPIRED'}
    assert re.fullmatch(r'[1-9][0-9]*', value['version'])
    assert value.get('openPath', '') in {'', '/api/deployments/'+value['id']+'/open'}
    return value


def parse_launch(data, origin):
    assert len(data) <= 8192
    text = data.decode()
    action = re.search(r'<form method="post" action="([^"]+)">', text).group(1)
    grant = re.search(r'name="grant" value="([A-Za-z0-9_-]{43})"', text).group(1)
    assert action == origin+'/__golf/auth'
    assert len(base64.urlsafe_b64decode(grant+'=')) == 32
    return grant


def browser_session_cookie(cookie, origin):
    assert cookie.name == '__Host-golf_session' and cookie.secure and not cookie.domain_specified and cookie.path == '/'
    assert cookie.has_nonstandard_attr('HttpOnly') and cookie.get_nonstandard_attr('SameSite') == 'Lax'
    return {'name':cookie.name,'value':cookie.value,'url':origin,'secure':cookie.secure,
            'httpOnly':cookie.has_nonstandard_attr('HttpOnly'),'sameSite':cookie.get_nonstandard_attr('SameSite')}


def self_check():
    request = dict(deploymentId=uuid4(), target={'repositoryId':'12'}, manifestSha256='a'*64,
                   environmentId=uuid4(), environmentVersion='1', source={'kind':'REPOSITORY_SOURCE_REF_KIND_COMMIT','name':'b'*40},
                   staticRoot='dist', targetFingerprint='c'*64)
    prepared = {'artifact':{'archiveSha256':'d'*64}}
    env = {'name':'Owned', 'policy':{'maxConcurrency':1}}
    value = dict(contract=CONTRACT, id=request['deploymentId'], actorId='14', target=request['target'],
                 artifact=prepared['artifact'], policy=env['policy'], environmentName=env['name'],
                 state='REQUESTED', version='1', **{k:request[k] for k in ('manifestSha256','environmentId','environmentVersion','source','staticRoot','targetFingerprint')})
    deployment_receipt(value, request, prepared, env, {'id':'14'})
    for field in ('targetFingerprint', 'environmentVersion', 'actorId', 'manifestSha256'):
        try: deployment_receipt(value|{field:'wrong'}, request, prepared, env, {'id':'14'})
        except AssertionError: pass
        else: raise AssertionError('Foreign deployment receipt admitted')
    origin = 'https://'+request['deploymentId']+'.preview.localhost:12345'
    data = ('<form method="post" action="'+origin+'/__golf/auth"><input name="grant" value="'+'a'*43+'"></form>').encode()
    assert parse_launch(data, origin) == 'a'*43
    for wrong in ('https://outside.invalid', origin+'/other'):
        try: parse_launch(data, wrong)
        except AssertionError: pass
        else: raise AssertionError('Foreign launch destination admitted')
    assert artifact.source_files()[artifact.PATH] and artifact.EXPECTED['dist/index.html']
    cookie = http.cookiejar.Cookie(0, '__Host-golf_session', 'a'*43, None, False, 'localhost.local', False, False,
                                  '/', True, True, None, True, None, None, {'HttpOnly':None,'SameSite':'Lax'}, False)
    observed = browser_session_cookie(cookie, 'https://localhost:12345')
    assert observed['secure'] and observed['httpOnly'] and observed['sameSite'] == 'Lax'
    for changes in ({'secure':False}, {'domain_specified':True}, {'path':'/other'}, {'_rest':{'SameSite':'Lax'}}, {'_rest':{'HttpOnly':None,'SameSite':'Strict'}}):
        prior = {field:getattr(cookie,field) for field in changes}
        for field,value in changes.items(): setattr(cookie,field,value)
        try: browser_session_cookie(cookie, 'https://localhost:12345')
        except AssertionError: pass
        else: raise AssertionError('Unobserved or weakened canonical cookie admitted')
        finally:
            for field,value in prior.items(): setattr(cookie,field,value)
    print('PASS: pure original deployment/launch/cookie/owned artifact guards; no resources.')


class PreviewConnection(http.client.HTTPSConnection):
    """Loopback connection with actual configured hostname verification/SNI."""
    def connect(self):
        raw = socket.create_connection(('127.0.0.1', self.port), timeout=self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def main():
    global STAGE, REPORT_FAILURE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    for name in ('image','runner-image','source-revision','expected-core-sha256','expected-runner-sha256','expected-engine-sha256'):
        parser.add_argument('--'+name)
    parser.add_argument('--proxy-binary', type=Path)
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--seed-wait-seconds', type=int, default=300)
    parser.add_argument('--rustfs', action='store_true')
    args = parser.parse_args()
    if args.self_check: self_check(); return
    for name in ('image','runner_image','source_revision','expected_core_sha256','expected_runner_sha256','expected_engine_sha256','proxy_binary','output'):
        if getattr(args,name) is None: parser.error('--'+name.replace('_','-')+' required')
    assert re.fullmatch('[a-f0-9]{40}', args.source_revision) and 1 <= args.seed_wait_seconds <= 600
    for digest in (args.expected_core_sha256,args.expected_runner_sha256,args.expected_engine_sha256):
        assert re.fullmatch('[a-f0-9]{64}', digest)
    stack, output = args.stack_root.resolve(), args.output.resolve()
    assert not output.exists() and (stack/'web/node_modules/playwright/index.mjs').is_file()
    assert 'rpc PrepareStaticDeployment(' in (stack/'api/golf/v1/golf.proto').read_text()
    output.mkdir(mode=0o700, parents=True); output.chmod(0o700)
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_','GIT_')) and k!='DATABASE_URL' and k.lower() not in ('http_proxy','https_proxy','all_proxy','no_proxy')}
    forbidden, actors, cleanup = [], {}, []
    manifest = {'passed':False,'complete':False,'proofKind':'actual-static-preview067','sourceRevision':args.source_revision,
                'storageMode':'saved-rustfs-profile' if args.rustfs else 'postgres', 'checks':{},
                'limitations':['Bounded ordinary static shell GitLab artifact only; no application server, custom DNS, Cloudflare/Kubernetes or latest-schema recovery.',
                               'Browser trusts only this disposable leaf SPKI; Python independently verifies its private CA chain/name and TLS1.3. No global trust/DNS edits.',
                               'Native before/after read observations are not an atomic external-native fence; outage denial is not an in-flight revocation proof.']}
    def record(**values):
        manifest.update(values)
        raw = artifact.safe_json(manifest, forbidden)
        path = output/'manifest.json.tmp'; helpers.private_write(path, raw); path.replace(output/'manifest.json')
    def failure(error):
        if 'originalFailure' not in manifest:
            record(originalFailure={'stage':STAGE,'type':type(error).__name__,'frames':[{'file':Path(frame.filename).name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__)[-5:]]})
    REPORT_FAILURE=failure
    def check(name, **facts):
        manifest['checks'][name] = facts or {'passed':True}; record()
    def stage(name):
        global STAGE
        STAGE = name; record(stage=name); print('CHECK: '+name, flush=True)
    def execute(*argv, payload=None, timeout=180, expected_failure=False):
        result = subprocess.run(argv, input=None if payload is None else json.dumps(payload).encode(), cwd=stack, env=environment, capture_output=True, timeout=timeout)
        assert len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20
        if result.returncode and not expected_failure and not (output/'private-command-failure.json').exists():
            raw = json.dumps({'stage':STAGE,'exitCode':result.returncode,'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace')})
            for secret in forbidden:
                if secret: raw = raw.replace(secret,'[redacted]')
            helpers.private_write(output/'private-command-failure.json', raw)
        assert result.returncode==0, 'Bounded private command failure; output withheld'
        return result.stdout.decode().strip()
    def snapshot():
        ids = execute('docker','ps','-aq','--no-trunc').splitlines(); assert len(ids)<=500
        if not ids: return {}
        template = '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}}},"RestartCount":{{json .RestartCount}}}'
        return notifications.filtered_foreign([json.loads(line) for line in execute('docker','inspect','--format',template,*ids).splitlines()])
    stage('cached immutable component, producer, proxy and dependencies')
    images = {}
    dependencies = [('golf',args.image),('runner',args.runner_image),('native',artifact.NATIVE),('postgres',artifact.PG),('daemon',artifact.DIND)]
    if args.rustfs: dependencies.append(('rustfs',artifact.RUSTFS))
    for role, ref in dependencies:
        row = json.loads(execute('docker','image','inspect',ref))[0]
        assert re.fullmatch('sha256:[a-f0-9]{64}',row['Id']); images[role]=row['Id']
        if role in ('golf','runner'):
            assert ref==row['Id'] and (row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.source_revision
    binaries = {}
    for role, name, sha in [('golf','golf',args.expected_core_sha256),('runner','golf-runner',args.expected_runner_sha256),('golf','golf-actions-engine',args.expected_engine_sha256),('runner','golf-actions-engine',args.expected_engine_sha256)]:
        result = execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/usr/bin/sha256sum',images[role],'/usr/local/bin/'+name)
        assert result.split()==[sha,'/usr/local/bin/'+name]; binaries[role+'/'+name]=sha
    assert int(execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/').splitlines()[-1].split()[3])>=2*1024*1024
    binary, binary_sha = rules.proxy_binary_receipt(args.proxy_binary)
    before = snapshot(); helpers.private_write(output/'foreign-before.json',json.dumps(before,indent=2))
    project = artifact.PROJECT_PREFIX+secrets.token_hex(5)
    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):
        assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
    ports = helpers.free_ports(6 if args.rustfs else 5)
    previous = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'https://localhost:{ports[2]}', f'http://127.0.0.1:{ports[1]}'
    preview_base = f'https://preview.localhost:{ports[4]}'
    started, passed, proxy_ready, bootstrap_created = False, False, False, False
    record(project=project,images=images,binarySha256=binaries,helperRevision=execute('git','rev-parse','HEAD'),proxyBinarySha256=binary_sha)
    with native_proxy.NativeProxy(ports[3],project) as proxy, tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700); environment.update(proxy.environment())
        ca, cert, key = directory/'ca.crt', directory/'server.crt', directory/'server.key'
        helpers.private_write(directory/'ca.conf','[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf static preview fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        helpers.private_write(directory/'extensions','basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=DNS:localhost,IP:127.0.0.1,DNS:*.preview.localhost\nextendedKeyUsage=serverAuth\n')
        execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(directory/'ca.conf'),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',str(key),'-out',str(directory/'server.csr'))
        execute('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(cert))
        # Three native openssl processes avoid shell pipes and preserve binary DER.
        public = execute('openssl','x509','-in',str(cert),'-pubkey','-noout')
        helpers.private_write(directory/'public.pem',public+'\n')
        execute('openssl','pkey','-pubin','-in',str(directory/'public.pem'),'-outform','DER','-out',str(directory/'public.der'))
        spki = base64.b64encode(hashlib.sha256((directory/'public.der').read_bytes()).digest()).decode()
        for file in (ca,cert,key): file.chmod(0o444)
        context = ssl.create_default_context(cafile=str(ca)); context.minimum_version=ssl.TLSVersion.TLSv1_3
        worker_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values = {k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,
                      GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':artifact.IMAGE}),
                      GOLF_RUNNER_JOB_IMAGE=artifact.IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([artifact.IMAGE]),
                      GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),
                      GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        if args.rustfs: values.update(RUSTFS_ACCESS_KEY=secrets.token_hex(24),RUSTFS_SECRET_KEY=secrets.token_hex(32))
        forbidden.extend(values[k] for k in values if any(term in k for term in ('PASSWORD','ENCRYPTION','KEY')))
        forbidden.append(environment['NATIVE_QUALIFICATION_NONCE'])
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        overlay = {'services':{
            'golf':{'image':images['golf'],'pull_policy':'never','mem_limit':'384m','environment':{
                'GITEA_URL':'http://native-qualification-proxy:8081','GOLF_ALLOW_INSECURE_COOKIES':'false','GOLF_ACTIONS_ENGINE_CATALOG':artifact.act.CATALOG,
                'GOLF_PREVIEW_TLS_LISTEN_ADDR':':8444','GOLF_PREVIEW_TLS_CERT_FILE':'/run/golf/internal-tls/server.crt','GOLF_PREVIEW_TLS_KEY_FILE':'/run/golf/internal-tls/server.key','GOLF_PREVIEW_BASE_URL':preview_base},
                'depends_on':{native_proxy.SERVICE_NAME:{'condition':'service_started'}}},
            'gitea':{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{
                'GITEA__server__ROOT_URL':smoke.GITEA+'/','GITEA__server__DISABLE_SSH':'true','GITEA__server__START_SSH_SERVER':'false','GITEA__actions__ENABLED':'false'}},
            'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m','command':['postgres','-c','max_wal_size=64MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s']},
            'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m'},
            'runner-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},'runner-actions-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},
            native_proxy.SERVICE_NAME:proxy.compose_service(images['golf'],binary)}}
        if args.rustfs: overlay['services']['rustfs']={'image':images['rustfs'],'pull_policy':'never','mem_limit':'512m','ports':['127.0.0.1:'+str(ports[5])+':9000']}
        helpers.private_write(directory/'services.json',json.dumps(overlay))
        helpers.private_write(directory/'ports.yaml',f'''services:
  golf:
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443", "127.0.0.1:{ports[4]}:8444"]
  gitea:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  postgres:
    volumes: !override ["{stack/'deploy/postgres/init.sh'}:/docker-entrypoint-initdb.d/01-golf.sh:ro"]
    tmpfs: ["/var/lib/postgresql:size=1073741824,mode=0700,uid=70,gid=70"]
''')
        compose = ['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(directory/'proof.env')]
        for file in ('compose.yaml','compose.ci.yaml','compose.actions-engine.yaml','compose.runner-tls.yaml'):
            compose += ['-f',str(stack/file)]
        if args.rustfs: compose += ['-f',str(stack/'compose.storage.yaml')]
        compose += ['-f',str(directory/'services.json'),'-f',str(directory/'ports.yaml')]
        def command(*argv,**kw): return execute(*compose,*argv,**kw)
        def admin(*argv): return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv)
        def operator(action, payload):
            value=json.loads(command('exec','-T','golf','golf','local-account',action,payload=payload)); assert value['state']=='complete'; return value
        def client(): return urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def rpc(role, method, body=None, expected=200, code=None):
            return smoke.rpc(actors[role]['session'],method,body,expected=expected,code=code)
        def metadata(sql): return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',sql)
        def runtime():
            rows={}
            for role in ('golf','runner'):
                cid=command('ps','-q',role); assert cid
                row=json.loads(execute('docker','inspect',cid))[0]
                assert row['Image']==images[role] and row['Config']['Labels']['com.docker.compose.project']==project
                assert row['Config']['Labels']['org.opencontainers.image.revision']==args.source_revision and row['State']['Running']
                rows[role]={'containerId':row['Id'],'image':row['Image'],'configHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return rows
        def target(role='owner'):
            a=rpc(role,'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
            assert a['repositoryId']==str(native['id']) and a['ownerId']==owner['id'] and re.fullmatch('[a-f0-9]{64}',a['revision'])
            return dict(repository=repository,repositoryId=a['repositoryId'],ownerId=a['ownerId'],accessRevision=a['revision'])
        def selected(d, role='owner'): return {'target':target(role),'deploymentId':d['id']}
        def get(d, role='owner'): return rpc(role,SERVICE+'GetRepositoryDeployment',selected(d,role))['deployment']
        def save_environment(name, policy, prior=None):
            body={'target':target(),'environmentId':prior['id'] if prior else uuid4(),'expectedVersion':prior['version'] if prior else '0','operationId':uuid4(),
                  'name':name,'policy':policy,'currentPassword':owner['password']}
            value=rpc('owner',ENV+'SaveRepositoryEnvironment',body)['environment']
            assert value['id']==body['environmentId'] and value['version']==str(int(body['expectedVersion'])+1)
            assert value['capability']=='REPOSITORY_ENVIRONMENT_CAPABILITY_CONFIGURATION_ONLY' and not value.get('deploymentAvailable',False)
            return value
        def create(env):
            p=rpc('owner',SERVICE+'PrepareStaticDeployment',{'target':target(),'runId':observed['id']})
            assert p['available'] and p['artifact']==a and p['roots']==[{'path':'dist','entryPath':'dist/index.html'}]
            body=dict(target=target(),deploymentId=uuid4(),runId=a['runId'],attemptId=a['attemptId'],commitId=a['commitId'],archiveSha256=a['archiveSha256'],
                      manifestSha256=p['manifestSha256'],environmentId=env['id'],environmentVersion=env['version'],source={'kind':'REPOSITORY_SOURCE_REF_KIND_COMMIT','name':head},staticRoot='dist',targetFingerprint=p['targetFingerprint'],currentPassword=owner['password'])
            d=rpc('owner',SERVICE+'CreateRepositoryDeployment',body)['deployment']; deployment_receipt(d,body,p,env,owner)
            assert d['state']=='REQUESTED' and d['version']=='1'; return d,body,p
        def approve(d):
            body=selected(d,'reviewer')|{'operationId':uuid4(),'approve':True}
            result=rpc('reviewer',SERVICE+'ReviewRepositoryDeployment',body)['deployment']
            assert result['approvals'][0]['actorId']==actors['reviewer']['id'] and result['approvals'][0]['approved']
            assert rpc('reviewer',SERVICE+'ReviewRepositoryDeployment',body)['deployment']==result
            rpc('reviewer',SERVICE+'ReviewRepositoryDeployment',body|{'approve':False},400,'failed_precondition')
            return result
        def activate(d):
            value=rpc('owner',SERVICE+'ActivateRepositoryDeployment',selected(d))['deployment']; assert value['state']=='READY' and value['canOpen']; return value
        def revoke(d):
            value=rpc('owner',SERVICE+'RevokeRepositoryDeployment',selected(d))['deployment']; assert value['state']=='REVOKED' and not value.get('canOpen',False); return value
        def origin(d): return 'https://'+d['id']+'.preview.localhost:'+str(ports[4])
        def preview(d, path='/', cookie='', method='GET', body=None, extra=None, expected=200, host=None):
            hostname=host or d['id']+'.preview.localhost'
            conn=PreviewConnection(hostname,ports[4],context=context,timeout=20)
            try:
                conn.request(method,path,body=body,headers={'Cookie':cookie}|(extra or {}))
                response=conn.getresponse(); raw=response.read((10<<20)+1); headers=dict(response.getheaders())
                assert response.status==expected and len(raw)<=10<<20
                assert headers.get('Cache-Control')=='no-store' and headers.get('X-Content-Type-Options')=='nosniff'
                if expected!=200 and expected!=303: assert all(value not in raw for value in artifact.EXPECTED.values())
                return raw,headers
            finally: conn.close()
        def open_preview(d, role='reader', expected=200, extra=None):
            request=urllib.request.Request(smoke.GOLF+'/api/deployments/'+d['id']+'/open',data=b'',method='POST',headers={'Origin':smoke.GOLF}|(extra or {}))
            try: response=actors[role]['session'].open(request,timeout=20)
            except urllib.error.HTTPError as error: response=error
            with response:
                raw=response.read(8193); assert response.status==expected and len(raw)<=8192 and response.headers['Cache-Control']=='no-store'
                if expected!=200: assert b'name="grant"' not in raw; return None
                grant=parse_launch(raw,origin(d)); forbidden.append(grant)
                form=urllib.parse.urlencode({'grant':grant}).encode()
                _,headers=preview(d,'/__golf/auth',method='POST',body=form,extra={'Origin':smoke.GOLF,'Content-Type':'application/x-www-form-urlencoded'},expected=303)
                assert headers['Location']=='/'
                cookie=headers['Set-Cookie']; assert cookie.startswith('__Host-golf_preview=') and all(v in cookie for v in ('HttpOnly','Secure','Path=/','SameSite=Lax')) and 'Domain=' not in cookie
                token=cookie.split(';',1)[0]; forbidden.append(token.partition('=')[2])
                preview(d,'/__golf/auth',method='POST',body=form,extra={'Origin':smoke.GOLF,'Content-Type':'application/x-www-form-urlencoded'},expected=404)
                return token
        def login(role):
            actor=actors[role]; actor['session']=client(); rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
        def profile(prefix, prior=None):
            config=dict(label='Owned '+prefix,kind='OBJECT_STORAGE',backend='S3',endpoint='http://rustfs:9000',region='us-east-1',bucket='golf-ci',prefix=prefix,pathStyle=True,allowInsecure=True)
            if prior: config['id']=prior['id']
            body=dict(connection=config,expectedVersion=prior['version'] if prior else '0',passwordConfirmation=actors['golfadmin']['password'])
            if prior: body['retainCredential']=True
            else: body['credential']={'accessKeyId':values['RUSTFS_ACCESS_KEY'],'secretAccessKey':values['RUSTFS_SECRET_KEY']}
            connection=rpc('golfadmin','InfrastructureConnectionService/SaveInfrastructureConnection',body)['connection']
            tested=rpc('golfadmin','InfrastructureConnectionService/TestInfrastructureConnection',{'id':connection['id'],'expectedVersion':connection['version'],'passwordConfirmation':actors['golfadmin']['password']})
            assert tested['accessible']
            inventory=rpc('golfadmin','InfrastructureConnectionService/ListInfrastructureConnections')
            result=rpc('golfadmin','InfrastructureConnectionService/ActivateInfrastructureConnection',dict(id=connection['id'],expectedVersion=connection['version'],expectedActiveRevision=inventory.get('activeRevision','0'),passwordConfirmation=actors['golfadmin']['password']))
            assert result['connection']['id']==connection['id']; return connection
        try:
            stage('fresh stack and private CA/name/TLS1.3 proofs')
            started=True; command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf',native_proxy.SERVICE_NAME,'runner-daemon')
            proxy.ready(); proxy_ready=True
            helpers.until(lambda:smoke.request(client(),'GET',smoke.GOLF+'/readyz'),45)
            for port,name in ((ports[2],'localhost'),(ports[4],'00000000-0000-4000-8000-000000000000.preview.localhost')):
                with socket.create_connection(('127.0.0.1',port),timeout=10) as raw:
                    with context.wrap_socket(raw,server_hostname=name) as secured: assert secured.version()=='TLSv1.3'
                for ctx,wrong in ((context,'wrong.invalid'),(ssl.create_default_context(),name)):
                    try:
                        with socket.create_connection(('127.0.0.1',port),timeout=10) as raw: ctx.wrap_socket(raw,server_hostname=wrong)
                    except ssl.SSLCertVerificationError: pass
                    else: raise AssertionError('Untrusted/mismatched direct TLS accepted')
                old=ssl.create_default_context(cafile=str(ca)); old.maximum_version=ssl.TLSVersion.TLSv1_2
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=10) as raw: old.wrap_socket(raw,server_hostname=name)
                except ssl.SSLError: pass
                else: raise AssertionError('TLS1.2 accepted')
            check('tls',privateCA=True,nameChecked=True,tls13=True,tls12Denied=True,wrongNameDenied=True,untrustedCADenied=True)
            record(proxyRuntime=rules.verify_proxy_runtime(execute,command,proxy,binary,binary_sha,images['golf'],args.source_revision))
            if args.rustfs: command('exec','-T','golf','golf','objectstore','initialize')
            daemon=command('ps','-q','runner-daemon'); daemon_row=json.loads(execute('docker','inspect',daemon))[0]
            assert daemon_row['Image']==images['daemon'] and daemon_row['Config']['Labels']['com.docker.compose.project']==project
            helpers.private_write(output/'seed.json',json.dumps({'schema':'golf.workflow-artifacts.seed.v1','project':project,'containerId':daemon_row['Id'],'containerImage':images['daemon'],'jobImage':artifact.IMAGE,'daemonImage':artifact.DIND,'expiresAfterSeconds':args.seed_wait_seconds,'helperNeverPullsOrBuilds':True},indent=2))
            print('PREREQUISITE: operator-seed only owned fresh daemon '+daemon_row['Id']+' with exact approved Alpine/DinD images.',flush=True)
            def seeded():
                rows=[]
                for ref in (artifact.IMAGE,artifact.DIND):
                    try: row=json.loads(command('exec','-T','runner-daemon','docker','image','inspect',ref,expected_failure=True))[0]
                    except AssertionError: return None
                    canonical=ref.split('@')[0].rsplit(':',1)[0]+'@'+ref.split('@')[1]
                    assert row['Os']=='linux' and canonical in row.get('RepoDigests',[]); rows.append({'reference':ref,'id':row['Id'],'registryDigest':canonical})
                return rows
            record(seedReceipt=helpers.until(seeded,args.seed_wait_seconds))
            stage('independent native actors and managed secure sessions')
            # Gitea promotes its first user. Keep that independent bootstrap out
            # of the ordinary deployer's role, as the shared native recipes do.
            admin('create','--username',project+'-bootstrap','--email',project+'-bootstrap@example.invalid','--random-password','--must-change-password=false','--admin')
            bootstrap_created=True
            for role in ('owner','reviewer','reader','outsider','golfadmin'):
                actor=dict(name=project+'-'+role,email=project+'-'+role+'@example.invalid',password=secrets.token_urlsafe(32),created=False,enrolled=False)
                actors[role]=actor; forbidden.append(actor['password'])
                argv=['create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false']
                if role=='golfadmin': argv.append('--admin')
                admin(*argv); actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository','--raw'); forbidden.append(actor['token'])
                identity=smoke.provider(actor['token'],'GET','user'); actor['id']=str(identity['id']); assert identity['is_admin']==(role=='golfadmin')
                operator('create',dict(username=actor['name'],email=actor['email'],password=actor['password'],forge_token=actor['token'],is_instance_admin=role=='golfadmin')); actor['enrolled']=True; login(role)
                cookies=[c for h in actor['session'].handlers if isinstance(h,urllib.request.HTTPCookieProcessor) for c in h.cookiejar]
                assert len(cookies)==1
                browser_session_cookie(cookies[0],smoke.GOLF)
                forbidden.append(cookies[0].value)
            owner=actors['owner']; native=smoke.provider(owner['token'],'POST','user/repos',{'name':'static-preview','private':True,'auto_init':True,'default_branch':'main'},expected=201)
            repository={'owner':owner['name'],'name':native['name']}; base='repos/'+native['full_name']; smoke.wait_for_push(owner['token'],native['full_name'])
            for role in ('reviewer','reader'): smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors[role]['name'],{'permission':'read'},expected=204)
            for path,data in artifact.source_files().items(): smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(data).decode(),'message':'Controlled static preview artifact'},expected=201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/main')['commit']['id']; assert re.fullmatch('[a-f0-9]{40}',head)
            if args.rustfs: initial_profile=profile('original')
            for scope in ('INSTANCE','REPOSITORY'):
                role='golfadmin' if scope=='INSTANCE' else 'owner'; selection={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                p=rpc(role,'ExecutionPolicyService/GetExecutionPolicy',selection)['policy']
                rpc(role,'ExecutionPolicyService/UpdateExecutionPolicy',selection|dict(scopeId=p['scopeId'],expectedRevision=p.get('revision','0'),expectedAuthorityRevision=p['authorityRevision'],mode='EXECUTION_MODE_ALL',manualDispatchEnabled=True,pushAllowed=False,allowAllWorkflows=True))
            stage('actual qualified GitLab shell artifact producer')
            inspected=rpc('owner','WorkflowService/InspectWorkflows',{'repository':repository,'ref':head})
            assert inspected['commitId']==head and inspected['repositoryId']==str(native['id'])
            dispatch={'repository':repository,'ref':head,'workflowPath':artifact.PATH,'idempotencyKey':uuid4()}
            admitted=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run']
            assert admitted['engineCatalog']==artifact.CATALOG
            record(admittedRun={k:admitted[k] for k in ('id','state','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256','engineCatalog')})
            command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init','runner')
            runtime_before=runtime(); record(runtimeBefore=runtime_before)
            runner_env=json.loads(execute('docker','inspect',runtime_before['runner']['containerId']))[0]['Config']['Env']
            assert not any(v.startswith(('GOLF_OBJECT_','RUSTFS_','AWS_')) for v in runner_env)
            def terminal():
                value=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':admitted['id']})['run']
                return value if value['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None
            observed=helpers.until(terminal,240)
            record(terminalRun={k:observed[k] for k in ('id','attemptId','state','failureCode','engineCatalog') if k in observed})
            if observed['state']!='WORKFLOW_RUN_STATE_SUCCEEDED':
                diagnostics={'run':observed,'logs':rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id']})}
                raw=json.dumps(diagnostics); assert len(raw)<=1<<20
                for secret in forbidden:
                    if secret: raw=raw.replace(secret,'[redacted]')
                helpers.private_write(output/'private-producer-failure.json',raw)
            assert observed['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and observed['engineCatalog']==artifact.CATALOG and not observed.get('inputContract') and not observed.get('executionBindingId')
            assert observed['commitId']==head and all(observed[k]==admitted[k] for k in ('id','repositoryId','ownerId','workflowBlobId','sourceSha256'))
            a=artifact.artifact_receipt(rpc('owner','WorkflowArtifactService/GetWorkflowArtifact',{'runId':observed['id']})['artifact'],observed)
            archive=urllib.request.Request(smoke.GOLF+a['downloadPath'],headers={'Origin':smoke.GOLF})
            with owner['session'].open(archive,timeout=20) as response: payload=response.read((10<<20)+1)
            artifact.archive_receipt(payload,a)
            def storage():
                return json.loads(metadata("SELECT jsonb_build_object('storage',a.storage,'profileId',a.object_profile_id,'profileVersion',a.object_profile_version,'fingerprint',a.object_fingerprint,'key',a.object_key,'archiveSha256',a.archive_sha256,'sourceStorage',r.source_storage,'sourceProfileId',r.source_profile_id,'sourceProfileVersion',r.source_profile_version,'sourceFingerprint',r.source_fingerprint) FROM golf_workflow_artifacts a JOIN golf_workflow_runs r ON r.id=a.run_id WHERE a.run_id='"+str(uuid.UUID(observed['id']))+"'::uuid"))
            original_storage=storage(); assert original_storage['archiveSha256']==a['archiveSha256']
            if args.rustfs:
                assert original_storage['storage']==original_storage['sourceStorage']=='profile_s3'
                assert original_storage['profileId']==original_storage['sourceProfileId']==initial_profile['id'] and str(original_storage['profileVersion'])==str(original_storage['sourceProfileVersion'])==initial_profile['version']
                assert original_storage['fingerprint']==original_storage['sourceFingerprint']==''
                key_path='original/ci-artifacts/'+observed['id']+'/'+observed['attemptId']+'/'+a['archiveSha256']+'.tar'
                assert original_storage['key']==key_path.removeprefix('original/')
                assert re.fullmatch(r'original/ci-artifacts/[a-f0-9-]{36}/[a-f0-9]{32}/[a-f0-9]{64}\.tar',key_path)
                config='url = "http://127.0.0.1:'+str(ports[5])+'/golf-ci/'+key_path+'"\nuser = "'+values['RUSTFS_ACCESS_KEY']+':'+values['RUSTFS_SECRET_KEY']+'"\n'
                independent=directory/'original-artifact.tar'; independent.touch(mode=0o600)
                result=subprocess.run(['curl','--disable','--silent','--show-error','--request','GET','--aws-sigv4','aws:amz:us-east-1:s3','--noproxy','*','--proto','=http','--max-time','30','--retry','0','--max-filesize',str(10<<20),'--output',str(independent),'--write-out','%{http_code}','--config','-'],input=config.encode(),cwd=stack,env=environment,capture_output=True,timeout=35)
                assert result.returncode==0 and result.stdout==b'200' and len(result.stderr)<=65536 and independent.stat().st_size<=10<<20
                assert independent.read_bytes()==payload; independent.unlink()
            else: assert original_storage['storage']==original_storage['sourceStorage']=='postgres' and original_storage['profileId'] is None
            if not args.rustfs:
                assert metadata("SELECT encode(sha256(archive),'hex') FROM golf_workflow_artifacts WHERE run_id='"+str(uuid.UUID(observed['id']))+"'::uuid")==a['archiveSha256']
            record(artifact=a,source={'commitId':head,'workflowPath':artifact.PATH,'workflowBlobId':observed['workflowBlobId'],'sourceSha256':observed['sourceSha256']},originalStorage=original_storage)
            check('producedArtifact',realDocker=True,qualifiedShellGitLab=True,exactArchive=True,independentOriginalBytes=True,workerObjectCredentialsAbsent=True)
            stage('original Create, independent review, wait and capacity')
            policy=dict(allowAllSources=True,reviewers=[{'id':actors['reviewer']['id'],'login':actors['reviewer']['name']}],requiredApprovals=1,preventSelfApproval=True,protectedPreviews=True,waitSeconds=8,maxConcurrency=1,previewTtlSeconds=1800)
            env=save_environment('Preview qualification',policy)
            first,request,prepared=create(env)
            rpc('owner',SERVICE+'ActivateRepositoryDeployment',selected(first),400,'failed_precondition')
            rpc('owner',SERVICE+'ReviewRepositoryDeployment',selected(first)|dict(operationId=uuid4(),approve=True),403)
            # Instance/global native admin can inspect via native policy but is not the configured reviewer or issuer.
            rpc('golfadmin',SERVICE+'ReviewRepositoryDeployment',selected(first,'golfadmin')|dict(operationId=uuid4(),approve=True),403)
            approved=approve(first)
            rpc('owner',SERVICE+'ActivateRepositoryDeployment',selected(first),400,'failed_precondition')
            assert rpc('owner',SERVICE+'CreateRepositoryDeployment',request)['deployment']['id']==first['id']
            rpc('owner',SERVICE+'CreateRepositoryDeployment',request|{'staticRoot':''},400,'failed_precondition')
            eligible=datetime.datetime.fromisoformat(approved['eligibleAt'].replace('Z','+00:00')).timestamp()
            helpers.until(lambda:time.time()>=eligible,15)
            first=activate(first)
            second,second_request,_=create(env); approve(second)
            eligible=datetime.datetime.fromisoformat(second['eligibleAt'].replace('Z','+00:00')).timestamp(); helpers.until(lambda:time.time()>=eligible,15)
            rpc('owner',SERVICE+'ActivateRepositoryDeployment',selected(second),400,'failed_precondition')
            cookie=open_preview(first)
            assert preview(first,cookie=cookie)[0]==artifact.EXPECTED['dist/index.html']
            assert preview(first,'/report.txt',cookie=cookie)[0]==artifact.EXPECTED['dist/report.txt']
            assert first['artifact']==a and first['artifactStorage']==original_storage['storage']
            check('gates',independentReviewer=True,selfDenied=True,adminBypassDenied=True,waitDenied=True,capacityDenied=True,originalReplay=True,changedInputDenied=True)
            stage('isolated host, credential, URL and current file denial')
            preview(first,expected=404); open_preview(first,'outsider',404)
            open_preview(first,expected=404,extra={'Origin':'https://outside.invalid'})
            open_preview(first,expected=404,extra={'Authorization':'Bearer '+owner['token']})
            for path in ('/rpc/golf.v1.SessionService/GetSession','/missing','/%2e%2e/report.txt','//report.txt'):
                preview(first,path,cookie=cookie,expected=404)
            assert preview(first,'/report.txt?cache=1',cookie=cookie)[0]==artifact.EXPECTED['dist/report.txt']
            preview(second,cookie=cookie,expected=404)
            preview(first,cookie=cookie,extra={'Authorization':'Bearer '+owner['token']},expected=404)
            golf_cookie=next(c for h in owner['session'].handlers if isinstance(h,urllib.request.HTTPCookieProcessor) for c in h.cookiejar)
            preview(first,cookie=cookie+'; '+golf_cookie.name+'='+golf_cookie.value,expected=404)
            preview(first,cookie=cookie,host='00000000-0000-4000-8000-000000000000.preview.localhost',expected=404)
            check('isolatedAccess',singleUseLaunch=True,cookieSecureHttpOnlyHostOnly=True,wrongDeploymentCookieDenied=True,golfCookieDenied=True,bearerDenied=True,wrongOriginDenied=True,unknownPathDenied=True)
            stage('served browser UI, protected form open and origin isolation')
            def browser_cookies(role):
                return [browser_session_cookie(c,smoke.GOLF) for h in actors[role]['session'].handlers if isinstance(h,urllib.request.HTTPCookieProcessor) for c in h.cookiejar]
            execute('node',str(ROOT/'scripts/static-preview-browser.mjs'),payload=dict(golf=smoke.GOLF,previewBase=preview_base,spki=spki,sourceRevision=args.source_revision,repository=repository,deployment=first,secondDeploymentId=second['id'],expectedFiles={k.removeprefix('dist/'):v.decode() for k,v in artifact.EXPECTED.items()},cookies=browser_cookies('owner'),readerCookies=browser_cookies('reader'),forbidden=forbidden,stackRoot=str(stack),output=str(output/'browser')),timeout=180)
            browser=json.loads((output/'browser/manifest.json').read_text()); assert browser['passed'] and browser['complete'] and len(browser['captures'])==4
            record(browser={'manifest':'browser/manifest.json','captures':4,'actualProtectedOpen':True})
            stage('restart and original inspection without redispatch')
            command('restart','golf'); helpers.until(lambda:smoke.request(client(),'GET',smoke.GOLF+'/readyz'),45)
            current=get(first); deployment_receipt(current,request,prepared,env,owner)
            assert current['state']=='READY' and current['canOpen'] and preview(first,cookie=cookie)[0]==artifact.EXPECTED['dist/index.html']
            assert rpc('owner',SERVICE+'CreateRepositoryDeployment',request)['deployment']['id']==first['id'] and storage()==original_storage
            check('restart',sameOriginal=True,noRedispatch=True,sameProtectedFile=True)
            if args.rustfs:
                stage('active profile/version switch preserves original artifact address')
                changed=profile('new-active',initial_profile)
                assert changed['id']==initial_profile['id'] and int(changed['version'])==int(initial_profile['version'])+1
                assert get(first)['artifactProfileVersion']==initial_profile['version'] and storage()==original_storage
                assert preview(first,cookie=cookie)[0]==artifact.EXPECTED['dist/index.html']
                command('stop','rustfs'); preview(first,cookie=cookie,expected=404)
                command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','90','rustfs')
                assert preview(first,cookie=cookie)[0]==artifact.EXPECTED['dist/index.html'] and storage()==original_storage
                check('originalProfile',sameAddress=True,originalVersion=True,activeVersionSwitch=True,unavailableNoFallback=True)
            stage('current reader authority, logout and native provider outage')
            smoke.provider(owner['token'],'DELETE',base+'/collaborators/'+actors['reader']['name'],expected=204)
            preview(first,cookie=cookie,expected=404); open_preview(first,expected=404)
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors['reader']['name'],{'permission':'read'},expected=204)
            fresh=open_preview(first); assert preview(first,cookie=fresh)[0]==artifact.EXPECTED['dist/index.html']
            rpc('reader','SessionService/Logout'); preview(first,cookie=fresh,expected=404); login('reader')
            owner_view=open_preview(first,'owner'); command('stop','gitea'); preview(first,cookie=owner_view,expected=404)
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','90','gitea')
            helpers.until(lambda:smoke.provider(owner['token'],'GET','version'),45)
            check('currentRead',roleRevocationDenied=True,parentLogoutDenied=True,providerOutageNoPrivateBytes=True)
            stage('configured certificate identity drift withholds original target')
            original_cert,original_key=cert.read_bytes(),key.read_bytes()
            execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',str(directory/'changed.key'),'-out',str(directory/'changed.csr'))
            execute('openssl','x509','-req','-days','1','-in',str(directory/'changed.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(directory/'changed.crt'))
            command('stop','runner')
            try:
                # These are owned temporary certificate bind files, not trust
                # stores. Preserve their inodes so existing Docker binds see
                # the explicit operator change on the next listener restart.
                for file,content in ((cert,(directory/'changed.crt').read_bytes()),(key,(directory/'changed.key').read_bytes())):
                    file.chmod(0o600); file.write_bytes(content); file.chmod(0o444)
                command('restart','golf'); helpers.until(lambda:smoke.request(client(),'GET',smoke.GOLF+'/readyz'),45)
                assert not get(first).get('canOpen',False); preview(first,cookie=owner_view,expected=404); open_preview(first,expected=404)
            finally:
                for file,content in ((cert,original_cert),(key,original_key)):
                    file.chmod(0o600); file.write_bytes(content); file.chmod(0o444)
                command('restart','golf'); helpers.until(lambda:smoke.request(client(),'GET',smoke.GOLF+'/readyz'),45)
                command('up','-d','--no-build','--pull','never','runner')
            assert get(first)['canOpen'] and preview(first,cookie=owner_view)[0]==artifact.EXPECTED['dist/index.html']
            check('operatorTargetDrift',samePrivateCA=True,newCertificatePublicKeyDenied=True,originalCertificateRestored=True,originalReceiptPreserved=True)
            stage('expiry bookkeeping and fresh rollback request')
            expiry_env=save_environment('Short expiry qualification',policy|{'previewTtlSeconds':60})
            expiring,_,_=create(expiry_env); approve(expiring)
            eligible=datetime.datetime.fromisoformat(expiring['eligibleAt'].replace('Z','+00:00')).timestamp(); helpers.until(lambda:time.time()>=eligible,15)
            expiring=activate(expiring); expiry_cookie=open_preview(expiring,'owner')
            assert preview(expiring,cookie=expiry_cookie)[0]==artifact.EXPECTED['dist/index.html']
            deadline=datetime.datetime.fromisoformat(expiring['expiresAt'].replace('Z','+00:00')).timestamp()
            helpers.until(lambda:time.time()>deadline,75)
            assert get(expiring)['state']=='EXPIRED'; preview(expiring,cookie=expiry_cookie,expected=404)
            assert metadata("SELECT count(*) FROM golf_preview_credentials WHERE deployment_id='"+str(uuid.UUID(expiring['id']))+"'::uuid")=='0'
            assert metadata("SELECT count(*) FROM golf_deployment_events WHERE deployment_id='"+str(uuid.UUID(expiring['id']))+"'::uuid AND state='EXPIRED'")=='1'
            assert get(expiring)['state']=='EXPIRED'
            revoke(first); preview(first,cookie=owner_view,expected=404)
            # The pending original cannot resurrect prior approvals; explicitly revoke it before the rollback.
            revoke(second)
            rollback,rollback_request,rollback_prepared=create(env); assert rollback['id']!=first['id'] and not rollback.get('approvals')
            approve(rollback); eligible=datetime.datetime.fromisoformat(rollback['eligibleAt'].replace('Z','+00:00')).timestamp(); helpers.until(lambda:time.time()>=eligible,15)
            rollback=activate(rollback); assert origin(rollback)!=origin(first) and origin(rollback)!=origin(expiring) and rollback['artifact']==first['artifact']==expiring['artifact']
            rollback_cookie=open_preview(rollback); assert preview(rollback,cookie=rollback_cookie)[0]==artifact.EXPECTED['dist/index.html']
            check('expiryRollback',actualClockExpiry=True,expiryTtlSeconds=60,accessRecordsRemoved=True,oneExpiryEvent=True,newRequestHostname=True,freshApprovals=True,sameEarlierArtifact=True)
            stage('reviewer role/session, credential version, issuer and policy invalidation')
            smoke.provider(owner['token'],'DELETE',base+'/collaborators/'+actors['reviewer']['name'],expected=204)
            preview(rollback,cookie=rollback_cookie,expected=404); assert not get(rollback).get('canOpen',False)
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors['reviewer']['name'],{'permission':'read'},expected=204)
            assert preview(rollback,cookie=rollback_cookie)[0]==artifact.EXPECTED['dist/index.html']
            rpc('reviewer','SessionService/Logout'); preview(rollback,cookie=rollback_cookie,expected=404); login('reviewer'); revoke(rollback)
            def fresh_ready():
                d,_,_=create(env); approve(d); eligible=datetime.datetime.fromisoformat(d['eligibleAt'].replace('Z','+00:00')).timestamp(); helpers.until(lambda:time.time()>=eligible,15); return activate(d)
            credential_case=fresh_ready(); cv_cookie=open_preview(credential_case)
            operator('reset-password',{'username':actors['reviewer']['name'],'password':actors['reviewer']['password']})
            preview(credential_case,cookie=cv_cookie,expected=404); login('reviewer'); revoke(credential_case)
            issuer_case=fresh_ready(); issuer_cookie=open_preview(issuer_case)
            rpc('owner','SessionService/Logout'); preview(issuer_case,cookie=issuer_cookie,expected=404); login('owner'); revoke(issuer_case)
            decline_case=fresh_ready(); decline_cookie=open_preview(decline_case)
            declined=rpc('reviewer',SERVICE+'ReviewRepositoryDeployment',selected(decline_case,'reviewer')|{'operationId':uuid4(),'approve':False})['deployment']
            assert declined['state']=='REVOKED'; preview(decline_case,cookie=decline_cookie,expected=404)
            policy_case=fresh_ready(); policy_cookie=open_preview(policy_case)
            env=save_environment('Updated policy',policy,env)
            preview(policy_case,cookie=policy_cookie,expected=404); assert not get(policy_case).get('canOpen',False); revoke(policy_case)
            revocation_case=fresh_ready(); revoked_cookie=open_preview(revocation_case); revoke(revocation_case)
            preview(revocation_case,cookie=revoked_cookie,expected=404)
            assert metadata("SELECT count(*) FROM golf_preview_credentials WHERE deployment_id='"+str(uuid.UUID(revocation_case['id']))+"'::uuid")=='0'
            deletion_case=fresh_ready(); deletion_cookie=open_preview(deletion_case)
            deleted=rpc('owner',ENV+'DeleteRepositoryEnvironment',dict(target=target(),environmentId=env['id'],expectedVersion=env['version'],operationId=uuid4(),currentPassword=owner['password']))['environment']
            assert deleted['deleted']; preview(deletion_case,cookie=deletion_cookie,expected=404); revoke(deletion_case)
            check('invalidations',reviewerNativeRole=True,reviewerParentLogout=True,reviewerCredentialVersion=True,issuerLogout=True,explicitReviewerDecline=True,environmentVersion=True,environmentDeletion=True,explicitRevoke=True,revokedAccessRecordsRemoved=True)
            record(deployments={'original':first['id'],'capacity':second['id'],'expiry':expiring['id'],'rollback':rollback['id'],'credentialVersion':credential_case['id'],'issuer':issuer_case['id'],'decline':decline_case['id'],'policy':policy_case['id'],'revoke':revocation_case['id'],'environmentDelete':deletion_case['id']})
            runtime_after=runtime(); assert runtime_after==runtime_before; record(runtimeAfter=runtime_after)
            passed=True
        except Exception as error:
            failure(error); raise
        finally:
            if started:
                try: command('stop','runner')
                except Exception: cleanup.append('worker-stop')
                for actor in actors.values():
                    if actor.get('enrolled'):
                        try: smoke.rpc(actor['session'],'SessionService/Logout')
                        except Exception: cleanup.append('owned-session-logout')
                        try: operator('disable',{'username':actor['name']})
                        except Exception: cleanup.append('owned-account-disable')
                    if actor.get('created'):
                        try: admin('delete','--username',actor['name'],'--purge')
                        except Exception: cleanup.append('owned-native-purge')
                if proxy_ready:
                    try: proxy.close()
                    except Exception: cleanup.append('owned-proxy-stop')
                try:
                    command('down','--volumes','--remove-orphans')
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):
                        assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
                except Exception: cleanup.append('owned-stack')
            try:
                after=snapshot(); helpers.private_write(output/'foreign-after.json',json.dumps(after,indent=2))
                diff=notifications.foreign_diff(before,after); record(foreignComparison=diff); assert diff['identityUnchanged']
            except Exception: cleanup.append('foreign-identity')
            smoke.GOLF,smoke.GITEA=previous
            record(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,lastStage=STAGE,bootstrap={'independentNativeOnly':bootstrap_created,'disposedWithOwnedVolume':started and 'owned-stack' not in cleanup})
            if not manifest.get('originalFailure'): assert not cleanup
    assert passed
    print('PASS: actual bounded protected static preview; full environment/CD acceptance remains open.')


if __name__=='__main__':
    try: main()
    except Exception as error:
        if REPORT_FAILURE is not None:
            try: REPORT_FAILURE(error)
            except Exception: pass
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
