#!/usr/bin/env python3
"""Prepared real READ smart-HTTP qualification; source-only until root invokes it.

Requires cached exact product/native/PostgreSQL images and a separately compiled
Linux native helper. Never builds/pulls, changes retained policy, enrolls WRITE,
runs a provider or executes repository workflows. All credentials enter private
stdin or 0700 temporary files, never Git URLs or persistent credential helpers.
--self-check performs no Docker, HTTP, native, listener or Git operations.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
PINNED_IMAGE = 'sha256:c7fcc575e5ad3aeba33d7b1248627015e50d33d46a8c4f78acc7e8cd6e03c55a'
PINNED_SOURCE = 'f231fa22e00c78979bec1f98fb05fde8b71b48b4'
SERVICE = 'GitTransportService/'
STAGE = 'arguments'
PROOF = {'status':'not_started','cleanup':'not_created','scope':'Opt-in managed READ Git only. No WRITE enrollment, receive outcome, SSH/LFS, in-flight byte-boundary revocation or P0.8 qualification.'}
OUTPUT = None
class FixtureInterrupted(RuntimeError):pass
def interrupt(signum,frame):raise FixtureInterrupted()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None

def require(value, category):
    if not value:
        record(validationFailureCategory=category)
        raise AssertionError(category)

def record(**values):
    PROOF.update(values)
    if OUTPUT:
        temporary = OUTPUT/'manifest.json.tmp'
        with temporary.open('w', encoding='utf-8') as stream:
            temporary.chmod(0o600); json.dump(PROOF,stream,indent=2,sort_keys=True);stream.write('\n')
        temporary.replace(OUTPUT/'manifest.json')

def stage(value):
    global STAGE
    STAGE=value;record(stage=value);print('CHECK: '+value,flush=True)

def private_write(path, data, mode=0o600):
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
    with os.fdopen(fd,'wb') as stream:stream.write(data if isinstance(data,bytes) else data.encode())
    path.chmod(mode)

def pkt(value):
    return f'{len(value)+4:04x}'.encode()+value

def source_tree(native, raw):
    require(native.get('truncated') is False and type(native.get('page')) is int and native['page']==1, 'native_tree_incomplete')
    entries=native.get('tree');require(isinstance(entries,list) and 1<=len(entries)<=3,'native_tree_bounds')
    require(type(native.get('total_count')) is int and native['total_count']==len(entries),'native_tree_incomplete')
    observed=[]
    for item in raw.split(b'\0'):
        if not item:continue
        metadata,path=item.split(b'\t',1);mode,kind,sha=metadata.decode().split(' ')
        observed.append((path.decode(),mode,kind,sha))
    expected=[]
    for item in entries:
        require(isinstance(item,dict) and item.get('path') in ['README.md','proof.txt'] and item.get('type')=='blob' and item.get('mode')=='100644' and re.fullmatch(r'[a-f0-9]{40}',item.get('sha','')),'native_tree_shape')
        expected.append((item['path'],item['mode'],item['type'],item['sha']))
    require(len(set(x[0] for x in expected))==len(expected) and sorted(expected)==sorted(observed),'native_tree_git_correspondence')
    return expected

def credential_shape(row,target):
    require(isinstance(row,dict) and all(re.fullmatch(r'[1-9][0-9]{0,18}',row.get(k,'')) for k in ['id','sourceSessionId']),'credential_identity')
    require(row.get('repositoryId')==target['repositoryId'] and row.get('ownerId')==target['ownerId'] and row.get('mode')=='GIT_CREDENTIAL_MODE_READ' and row.get('sourceSessionActive') is True,'credential_receipt')
    require(row.get('createdAt') and row.get('expiresAt') and not row.get('revokedAt'),'credential_time')

def self_check():
    for suffix in ['',b'0000']:
        payload=pkt(b'want '+b'a'*40+b'\n')+b'0000'+pkt(b'done\n')+(suffix if isinstance(suffix,bytes) else suffix.encode())
        require(payload[:4]==b'0032' and b'a'*40 in payload,'packet_independent_length')
    row={'truncated':False,'page':1,'total_count':1,'tree':[{'path':'README.md','mode':'100644','type':'blob','sha':'b'*40}]}
    raw=b'100644 blob '+b'b'*40+b'\tREADME.md\0';source_tree(row,raw)
    for broken in [dict(row,truncated=True),dict(row,page=2),dict(row,page=None),dict(row,total_count=2),dict(row,total_count=None),dict(row,tree=[dict(row['tree'][0],sha='c'*40)]),dict(row,total_count=2,tree=row['tree']*2)]:
        try:source_tree(broken,raw)
        except AssertionError:pass
        else:raise AssertionError('bad_native_inventory_accepted')
    target={'repositoryId':'91','ownerId':'42'}
    c={'id':'1','sourceSessionId':'9','repositoryId':'91','ownerId':'42','mode':'GIT_CREDENTIAL_MODE_READ','sourceSessionActive':True,'createdAt':'2026-10-04T12:00:00Z','expiresAt':'2026-10-04T13:00:00Z'};credential_shape(c,target)
    try:credential_shape(dict(c,sourceSessionActive=False),target)
    except AssertionError:pass
    else:raise AssertionError('dead_source_session_accepted')
    global OUTPUT,PROOF
    prior_output,prior_proof=OUTPUT,PROOF
    try:
        with tempfile.TemporaryDirectory(prefix='golf-gitread-pure-') as temporary:
            OUTPUT=Path(temporary);OUTPUT.chmod(0o700);PROOF={};record(status='failed',failedStage='original',cleanup='passed');require(json.loads((OUTPUT/'manifest.json').read_text())['failedStage']=='original','failure_preservation');require((OUTPUT/'manifest.json').stat().st_mode&0o777==0o600,'manifest_permissions')
    finally:OUTPUT,PROOF=prior_output,prior_proof
    print('PASS: pure protocol/tree/credential/manifest counterexamples; no runtime operations')

def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true')
    parser.add_argument('--stack-root',type=Path,default=ROOT,help='Immutable stack/CLI source root; no code edits')
    parser.add_argument('--image',help='Cached frozen product image (must resolve to the documented exact image)')
    parser.add_argument('--source-revision',help='Explicit full Git revision for a newer root-built immutable image; default is the documented051 proof')
    parser.add_argument('--native-helper',type=Path,help='Root-precompiled Linux helper mounted read-only; launcher never builds it')
    parser.add_argument('--output',type=Path,help='New owner-only evidence directory')
    args=parser.parse_args()
    if args.self_check:self_check();return
    if not args.image or not args.output or not args.native_helper:parser.error('--image, --native-helper and --output are required')
    expected_source=args.source_revision or PINNED_SOURCE
    expected_image=args.image if args.source_revision else PINNED_IMAGE
    require(re.fullmatch(r'[a-f0-9]{40}',expected_source) and re.fullmatch(r'sha256:[a-f0-9]{64}',expected_image),'immutable_image_source_arguments')
    stack=args.stack_root.resolve(strict=True);helper=args.native_helper.resolve(strict=True)
    require(helper.is_file() and 0<helper.stat().st_size<16<<20 and os.access(helper,os.X_OK),'helper_binary_missing')
    helper_bytes=helper.read_bytes();require(helper_bytes[:4]==b'\x7fELF','helper_not_linux_elf');helper_sha=hashlib.sha256(helper_bytes).hexdigest()
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700);args.output.chmod(0o700);OUTPUT=args.output.resolve(strict=True)
    record(status='running',helperSha256=helper_sha,helperSourceSha256=hashlib.sha256((ROOT/'scripts/managed-git-native/main.go').read_bytes()).hexdigest(),expectedSource=expected_source,launcherSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_','GIT_')) and k not in ['DATABASE_URL','SSH_AUTH_SOCK','SSH_ASKPASS'] and k.lower() not in ['http_proxy','https_proxy','all_proxy','no_proxy']}
    def run(*command,payload=None,raw=None,timeout=180,expected=0,cwd=stack,env=None):
        require(not(payload is not None and raw is not None),'ambiguous_stdin')
        result=subprocess.run(command,input=json.dumps(payload).encode() if payload is not None else raw,cwd=cwd,env=environment if env is None else env,capture_output=True,timeout=timeout)
        require(result.returncode==expected and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'private_subprocess_failed')
        return result.stdout
    stage('cached exact source and base images; reserve')
    core=json.loads(run('docker','image','inspect',args.image))[0]
    require(helper_bytes[5]==1 and int.from_bytes(helper_bytes[18:20],'little')==({'amd64':62,'arm64':183}.get(core.get('Architecture'))),'helper_architecture')
    require(core['Id']==expected_image and core['Config'].get('Labels',{}).get('org.opencontainers.image.revision')==expected_source,'image_source_binding')
    native=json.loads(run('docker','image','inspect','gitea/gitea:1.27.3-rootless'))[0]
    database=json.loads(run('docker','image','inspect','postgres:18.4-alpine3.24'))[0]
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core['Id'],'-Pk','/').decode()
    require(int(space.strip().splitlines()[-1].split()[3])>=2*1024*1024,'disk_reserve_below_2gib')
    project='golf-gitread-'+secrets.token_hex(5)
    def free_port():
        with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
    browser_port,tls_port=free_port(),free_port();require(browser_port!=tls_port,'port_collision')
    browser=f'http://127.0.0.1:{browser_port}';git_origin=f'https://127.0.0.1:{tls_port}'
    actors={};started=False;passed=False;bearers=[];git_credentials=[]
    record(project=project,productImage=core['Id'],sourceRevision=expected_source,nativeImage=native['Id'],postgresImage=database['Id'],ports={'browser':browser_port,'gitTls':tls_port})
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700)
        # Parent directory is0700. Bind only individual readonly certificate/key
        # files;0444 inside the container allows its existing unprivileged user.
        tls=directory/'tls';tls.mkdir(mode=0o700)
        private_write(tls/'ca.conf','[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        run('openssl','req','-config',str(tls/'ca.conf'),'-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=Golf disposable READ CA','-keyout',str(tls/'ca.key'),'-out',str(tls/'ca.crt'),timeout=20)
        run('openssl','req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=127.0.0.1','-keyout',str(tls/'server.key'),'-out',str(tls/'server.csr'),timeout=20)
        private_write(tls/'extensions','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('openssl','x509','-req','-in',str(tls/'server.csr'),'-CA',str(tls/'ca.crt'),'-CAkey',str(tls/'ca.key'),'-CAcreateserial','-days','1','-extfile',str(tls/'extensions'),'-out',str(tls/'server.crt'),timeout=20)
        for path in (tls/'server.key',tls/'server.crt',tls/'ca.crt'):path.chmod(0o444)
        context=ssl.create_default_context(cafile=str(tls/'ca.crt'));context.minimum_version=ssl.TLSVersion.TLSv1_3
        env_file,overlay=directory/'core.env',directory/'proof.yaml'
        values={k:secrets.token_hex(24) for k in ['POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=browser,GOLF_PUSH_CI_ENABLED='false')
        private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()))
        private_write(overlay,f'''services:
  postgres:
    image: {database['Id']}
    pull_policy: never
  gitea:
    image: {native['Id']}
    pull_policy: never
    ports: !reset []
    environment:
      GITEA__server__ROOT_URL: http://gitea:3000/
      GITEA__server__DISABLE_SSH: 'true'
      GITEA__server__START_SSH_SERVER: 'false'
      GITEA__actions__ENABLED: 'false'
      GITEA__repository__DEFAULT_BRANCH: main
  golf:
    image: {core['Id']}
    pull_policy: never
    environment:
      GOLF_MANAGED_HTTP_GIT: 'true'
      GOLF_MANAGED_HTTP_GIT_PUBLIC_URL: {git_origin}
      GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK: 'false'
      GOLF_MANAGED_HTTP_GIT_INCARNATION: ''
      GOLF_INTERNAL_TLS_LISTEN_ADDR: ':8443'
      GOLF_INTERNAL_TLS_CERT_FILE: /run/golf/read-proof/server.crt
      GOLF_INTERNAL_TLS_KEY_FILE: /run/golf/read-proof/server.key
    volumes:
      - {tls/'server.crt'}:/run/golf/read-proof/server.crt:ro
      - {tls/'server.key'}:/run/golf/read-proof/server.key:ro
      - {helper}:/run/golf/read-proof/native-helper:ro
    ports: !override ['127.0.0.1:{browser_port}:8080','127.0.0.1:{tls_port}:8443']
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(overlay)]
        def command(*args,**kwargs):return run(*compose,*args,**kwargs)
        def admin(*args):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*args).decode().strip()
        def operator(action,payload):
            result=json.loads(command('exec','-T','golf','golf','local-account',action,payload=payload));require(result.get('state')=='complete','operator_receipt');return result['result']
        def native_call(token,method,path,body=None,expected=200):
            payload={'project':project,'token':token,'method':method,'path':'/api/v1/'+path}
            if body is not None:payload['body']=body
            result=json.loads(command('exec','-T','golf','/run/golf/read-proof/native-helper',payload=payload,timeout=20));record(lastNativeCall={'method':method,'path':path,'expectedStatus':expected,'actualStatus':result.get('status')});require(result.get('status')==expected,'native_status');return result.get('body')
        def opener():return urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def call(actor,procedure,body=None,expected=200,code=None,headers=None):
            req=urllib.request.Request(browser+'/rpc/golf.v1.'+procedure,data=json.dumps(body or {}).encode(),method='POST',headers={'Origin':browser,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
            try:response=actor['session'].open(req,timeout=20)
            except urllib.error.HTTPError as e:response=e
            with response:
                raw=response.read(2<<20);value=json.loads(raw) if raw else {};record(lastRpcCall={'procedure':procedure,'expectedStatus':expected,'actualStatus':response.status,'cacheNoStore':response.headers.get('Cache-Control')=='no-store','code':value.get('code') if value.get('code') in ['internal','unauthenticated','permission_denied','not_found','invalid_argument','failed_precondition','resource_exhausted','unavailable','unimplemented'] else None});require(response.status==expected and response.headers.get('Cache-Control')=='no-store','rpc_status_or_cache')
            if code:require(value.get('code')==code,'rpc_code')
            return value
        def ready():
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                try:
                    with opener().open(browser+'/readyz',timeout=3) as r:
                        if r.status==200:return
                except (OSError,urllib.error.URLError):pass
                time.sleep(.5)
            raise AssertionError('readiness_timeout')
        def runtime():
            container=command('ps','-q','golf').decode().strip();require(re.fullmatch('[a-f0-9]{12,64}',container),'container_identity')
            value=json.loads(run('docker','inspect',container))[0]
            return {'containerId':container,'imageReference':value['Image'],'configuredImage':value['Config']['Image'],'composeConfigHash':value['Config']['Labels']['com.docker.compose.config-hash']}
        def topology():
            container=command('ps','-q','gitea').decode().strip();row=json.loads(run('docker','inspect',container))[0]
            require(not row['HostConfig'].get('PortBindings'),'native_public_ports_present')
            native_env=dict(v.split('=',1) for v in row['Config']['Env'] if '=' in v)
            require(native_env.get('GITEA__server__DISABLE_SSH')=='true' and native_env.get('GITEA__server__START_SSH_SERVER')=='false' and native_env.get('GITEA__actions__ENABLED')=='false','native_topology_configuration')
            return {'nativePublicBindingsAbsent':True,'nativeSSHDisabled':True,'nativeActionsDisabled':True,'nativeContainerId':container,'nativeImageReference':row['Image']}
        def git_http(secret,route,expected=200,payload=None,method='GET',headers=None,insecure=False):
            auth=base64.b64encode(('golf:'+secret).encode()).decode()
            url=(browser if insecure else git_origin)+route
            req=urllib.request.Request(url,data=payload,method=method,headers={'Authorization':'Basic '+auth,**(headers or {})})
            try:response=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=context)).open(req,timeout=25)
            except urllib.error.HTTPError as e:response=e
            with response:
                body=response.read((2<<20)+1);require(response.status==expected and len(body)<=2<<20,'git_http_status_or_bound');require(response.headers.get('Cache-Control')=='no-store','git_http_cache');return body
        askpass=directory/'askpass.py';credential_file=directory/'git-credential'
        private_write(askpass,'#!/usr/bin/env python3\nimport pathlib,sys\nprint("golf" if "Username" in sys.argv[1] else pathlib.Path(__file__).with_name("git-credential").read_text())\n',0o700)
        def git(work,secret,*arguments,denied=False):
            credential_file.write_text(secret);credential_file.chmod(0o600)
            env={**environment,'GIT_ASKPASS':str(askpass),'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_SSL_CAINFO':str(tls/'ca.crt')}
            result=subprocess.run(['git','-c','credential.helper=','-c','http.sslVerify=true',*arguments],cwd=work,env=env,capture_output=True,timeout=35)
            require((result.returncode!=0 if denied else result.returncode==0) and len(result.stdout)<=2<<20 and len(result.stderr)<=2<<20,'actual_git_result')
            require(secret.encode() not in result.stdout+result.stderr,'git_credential_echo')
            return result.stdout
        try:
            stage('fresh private-native stack and actual direct TLS')
            started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf');ready()
            initial_runtime=runtime();require(initial_runtime['imageReference']==core['Id'] and initial_runtime['configuredImage']==core['Id'],'runtime_image_binding');require(native_call('','GET','version')['version']=='1.27.3','native_version')
            with context.wrap_socket(socket.create_connection(('127.0.0.1',tls_port),timeout=5),server_hostname='127.0.0.1') as connection:require(connection.version()=='TLSv1.3','actual_tls_version')
            # Wrong endpoint name remains refused, never an insecure TLS override.
            try:
                with context.wrap_socket(socket.create_connection(('127.0.0.1',tls_port),timeout=5),server_hostname='wrong.invalid'):pass
            except ssl.SSLCertVerificationError:pass
            else:raise AssertionError('tls_hostname_not_enforced')
            record(runtime=initial_runtime,topology=topology(),tls={'protocol':'TLSv1.3','ownCaVerified':True,'ipSAN':'127.0.0.1','wrongHostnameRefused':True,'serverAuthenticationOnly':True})
            stage('supported ordinary actors and own managed sessions')
            # A disposable unmanaged bootstrap administrator prevents the native
            # last-admin safeguard from blocking supported test-actor cleanup.
            # It has no token or Golf enrollment; fresh volume teardown removes it.
            admin('create','--username',project+'-bootstrap','--email',project+'-bootstrap@example.invalid','--random-password','--must-change-password=false','--admin=true')
            record(unmanagedBootstrap='owned fresh fixture only; removed with fresh native volume')
            for role in ['owner','reader','outside','admin']:
                actor={'name':project+'-'+role,'created':False,'enrolled':False,'loggedIn':False,'session':opener()};actors[role]=actor
                admin('create','--username',actor['name'],'--email',actor['name']+'@example.invalid','--random-password','--must-change-password=false','--admin='+('true' if role=='admin' else 'false'));actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository,write:organization,write:issue','--raw')
                user=native_call(actor['token'],'GET','user');require(user['login']==actor['name'] and user['is_admin'] is (role=='admin'),'native_actor_identity');actor['id']=str(user['id']);actor['email']=actor['name']+'@golf.invalid';actor['password']='READ fixture '+secrets.token_urlsafe(24)
                operator('create',{'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='outside'});actor['enrolled']=True
                login=call(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];require(login['id']==actor['id'] and login['login']==actor['name'],'managed_actor_binding');actor['loggedIn']=True
            owner,reader,outside,native_admin=[actors[r] for r in ['owner','reader','outside','admin']]
            stage('private source fixture and ordinary reader permission')
            repo=native_call(owner['token'],'POST','user/repos',{'name':'proof','private':True,'auto_init':True},201);require(repo['full_name']==owner['name']+'/proof' and repo['owner']['id']==int(owner['id']),'native_repo_identity');base='repos/'+repo['full_name']
            native_call(owner['token'],'POST',base+'/contents/proof.txt',{'content':base64.b64encode(b'Private owned READ source fixture\n').decode(),'message':'Add owned READ fixture'},201)
            native_call(owner['token'],'PUT',base+'/collaborators/'+reader['name'],{'permission':'read'},204)
            target={'repository':{'owner':owner['name'],'name':'proof'},'repositoryId':str(repo['id']),'ownerId':owner['id']}
            info=call(owner,SERVICE+'GetGitTransport',target);clone_url=git_origin+'/git/'+repo['full_name']+'.git'
            require(info['repositoryId']==target['repositoryId'] and info['ownerId']==target['ownerId'] and info['cloneUrl']==clone_url and info['enabled'] and info['readCredentialAvailable'] and not info.get('writeCredentialAvailable',False),'transport_receipt')
            visible=call(owner,'RepositoryService/GetRepository',{'repository':target['repository']})['repository'];require(visible['cloneUrl']==clone_url and not visible.get('sshUrl'),'clone_url_switch')
            require(call(reader,'RepositoryAccessService/GetRepositoryAccess',{'repository':target['repository']})['access']['currentPermission']=='read','ordinary_reader_not_admin')
            def create_cap(actor,label='Owned READ'):
                value=call(actor,SERVICE+'CreateGitCredential',{**target,'label':label,'mode':'GIT_CREDENTIAL_MODE_READ','lifetimeSeconds':3600});credential_shape(value['credential'],target);require(re.fullmatch(r'golf_git_[A-Za-z0-9_-]{43}',value['secret']),'git_token_shape');git_credentials.append((actor,value['credential']['id']));return value
            owner_cap,reader_cap=create_cap(owner),create_cap(reader)
            path='/git/'+repo['full_name']+'.git';advertisement=path+'/info/refs?service=git-upload-pack'
            stage('host Git clone fetch ls-remote and independent native tree correspondence')
            clone=directory/'clone';git(directory,owner_cap['secret'],'clone',clone_url,str(clone));head=git(clone,owner_cap['secret'],'rev-parse','HEAD').decode().strip()
            branch=native_call(owner['token'],'GET',base+'/branches/main');require(branch['commit']['id']==head and re.fullmatch(r'[a-f0-9]{40}',head),'native_head_git_identity')
            tree=native_call(owner['token'],'GET',base+'/git/trees/'+head+'?page=1&per_page=100');entries=source_tree(tree,git(clone,owner_cap['secret'],'ls-tree','-z','HEAD'));require(tree['sha']==head,'native_root_commit_inventory_receipt')
            require(git(clone,owner_cap['secret'],'config','--get','remote.origin.url').decode().strip()==clone_url,'clone_no_secret_url');reader_clone=directory/'reader-clone';git(directory,reader_cap['secret'],'clone',clone_url,str(reader_clone));require(git(reader_clone,reader_cap['secret'],'rev-parse','HEAD').decode().strip()==head,'reader_clone_snapshot');git(reader_clone,reader_cap['secret'],'fetch','origin');remote=git(clone,reader_cap['secret'],'ls-remote','origin','refs/heads/main').decode().strip();require(remote==head+'\trefs/heads/main','reader_git_ref_identity')
            # Git itself independently computes the object hashes of all fixture files.
            for entry in entries:require(git(clone,owner_cap['secret'],'hash-object',entry[0]).decode().strip()==entry[3],'git_blob_hash')
            record(source={'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'headCommitId':head,'rootTreeId':git(clone,owner_cap['secret'],'rev-parse','HEAD^{tree}').decode().strip(),'entryCount':len(entries),'nativeRootReceiptKind':'commit-resolved inventory; native sha is commit, not treeOID'},ownerReaderGit='passed')
            stage('scope Origin bearer plaintext and unqualified WRITE denials')
            owner_inventory=call(owner,SERVICE+'ListGitCredentials',target);reader_inventory=call(reader,SERVICE+'ListGitCredentials',target)
            require({r['id'] for r in owner_inventory.get('credentials',[])}=={owner_cap['credential']['id']} and {r['id'] for r in reader_inventory.get('credentials',[])}=={reader_cap['credential']['id']},'own_credential_inventory')
            call(owner,SERVICE+'RevokeGitCredential',{**target,'credentialId':reader_cap['credential']['id']},404,'not_found')
            call(owner,SERVICE+'CreateGitCredential',{**target,'label':'Denied WRITE','mode':'GIT_CREDENTIAL_MODE_WRITE'},400,'failed_precondition')
            for actor in [outside,native_admin]:call(actor,SERVICE+'CreateGitCredential',{**target,'label':'Denied READ','mode':'GIT_CREDENTIAL_MODE_READ'},404,'not_found')
            call(owner,SERVICE+'GetGitTransport',{**target,'repositoryId':'9223372036854775807'},404,'not_found')
            call(owner,SERVICE+'GetGitTransport',target,403,'permission_denied',{'Origin':'https://other.invalid'})
            delegated=call(owner,'ApiCredentialService/CreateApiCredential',{'label':'READ fixture API'});bearers.append((owner,delegated['credential']['id']))
            anon={'session':opener()}
            for method,extra in [('GetGitTransport',{}),('ListGitCredentials',{}),('CreateGitCredential',{'label':'Denied','mode':'GIT_CREDENTIAL_MODE_READ'}),('RevokeGitCredential',{'credentialId':owner_cap['credential']['id']}),('GetGitReceiveOutcome',{'operationId':'10000000-0000-4000-8000-000000000001'})]:call(anon,SERVICE+method,{**target,**extra},403,'permission_denied',{'Authorization':'Bearer '+delegated['token']})
            git_http(owner_cap['secret'],advertisement,401,insecure=True)
            for headers in [{'Origin':browser},{'Cookie':'fixture=owned'}]:git_http(owner_cap['secret'],advertisement,401,headers=headers)
            git_http(owner_cap['secret'],advertisement+'&unknown=1',400)
            git_http(owner_cap['secret'],path+'/info/refs?service=git-receive-pack',401)
            git_http(owner_cap['secret'],path+'/git-receive-pack',401,payload=b'0000',method='POST')
            other=native_call(owner['token'],'POST','user/repos',{'name':'other','private':True,'auto_init':True},201)
            git_http(owner_cap['secret'],'/git/'+other['full_name']+'.git/info/refs?service=git-upload-pack',404)
            require(native_call(owner['token'],'GET',base+'/branches/main')['commit']['id']==head,'native_head_changed_by_denied_write')
            record(boundaries='passed',ownCredentialInventory='passed',writeQualified=False)
            stage('explicit credential revocation fences new upload requests and restart')
            revoked=call(owner,SERVICE+'RevokeGitCredential',{**target,'credentialId':owner_cap['credential']['id']});require(revoked['revoked'] and revoked['credentialId']==owner_cap['credential']['id'],'revocation_receipt');git_http(owner_cap['secret'],advertisement,401)
            command('restart','golf');ready();require(runtime()==initial_runtime,'restart_runtime_identity');git_http(owner_cap['secret'],advertisement,401);git(clone,reader_cap['secret'],'fetch','origin')
            stage('parent logout persists and cannot refresh an old Git capability')
            call(reader,'SessionService/Logout');reader['loggedIn']=False;git_http(reader_cap['secret'],advertisement,401)
            command('restart','golf');ready();git_http(reader_cap['secret'],advertisement,401)
            call(reader,'SessionService/LoginWithPassword',{'username':reader['email'],'password':reader['password']});reader['loggedIn']=True;git_http(reader_cap['secret'],advertisement,401)
            current_reader=create_cap(reader,'Fresh reader READ');git(clone,current_reader['secret'],'fetch','origin')
            stage('native access loss between advertisement and upload denies private pack bytes')
            git_http(current_reader['secret'],advertisement)
            native_call(owner['token'],'DELETE',base+'/collaborators/'+reader['name'],expected=204)
            upload=pkt(b'want '+head.encode()+b'\n')+b'0000'+pkt(b'done\n')
            denied=git_http(current_reader['secret'],path+'/git-upload-pack',404,payload=upload,method='POST',headers={'Content-Type':'application/x-git-upload-pack-request'})
            require(b'PACK' not in denied and head.encode() not in denied and b'Private owned READ' not in denied,'private_bytes_after_late_access_loss')
            git(clone,current_reader['secret'],'fetch','origin',denied=True)
            command('restart','golf');ready();git_http(current_reader['secret'],advertisement,404)
            native_call(owner['token'],'PUT',base+'/collaborators/'+reader['name'],{'permission':'read'},204)
            git(clone,current_reader['secret'],'fetch','origin')
            record(revocationRestart='passed',parentLogoutRestart='passed',accessLossAfterAdvertisement='passed',inFlightRevocation='not_qualified')
            stage('native rename and replacement cannot reuse original capability target')
            fresh_owner=create_cap(owner,'Replacement boundary READ')
            renamed=native_call(owner['token'],'PATCH',base,{'name':'proof-renamed'});require(renamed['id']==repo['id'],'rename_identity')
            replacement=native_call(owner['token'],'POST','user/repos',{'name':'proof','private':True,'auto_init':True},201);require(replacement['id']!=repo['id'],'replacement_identity')
            git_http(fresh_owner['secret'],advertisement,404);call(owner,SERVICE+'GetGitTransport',target,404,'not_found')
            native_call(owner['token'],'DELETE',base,expected=204);native_call(owner['token'],'PATCH','repos/'+renamed['full_name'],{'name':'proof'})
            git(clone,fresh_owner['secret'],'ls-remote','origin','refs/heads/main')
            require(runtime()==initial_runtime and topology()==PROOF['topology'],'final_runtime_topology')
            record(renameReplacement='passed',runtimeUnchanged=True);passed=True
        except Exception as original:
            record(failedStage=STAGE,originalFailureClass=type(original).__name__,originalValidationFailureCategory=PROOF.get('validationFailureCategory'),originalLastRpcCall=PROOF.get('lastRpcCall'),originalLastNativeCall=PROOF.get('lastNativeCall'))
            if isinstance(original,ssl.SSLCertVerificationError):record(tlsVerificationCode=original.verify_code)
            raise
        finally:
            if not passed:record(failedStage=STAGE)
            failures=[]
            for actor,identifier in reversed(bearers):
                try:call(actor,'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('own_api_credential')
            # Account disable is the final parent fence even when a failed stage
            # removed native read authority and prevents individual cap revocation.
            for actor in actors.values():
                if actor['loggedIn']:
                    try:call(actor,'SessionService/RevokeOtherSessions');call(actor,'SessionService/Logout');actor['loggedIn']=False
                    except Exception:failures.append('managed_session')
            if 'owner' in actors and actors['owner'].get('token'):
                for fixture_name in ['proof','proof-renamed','other']:
                    try:
                        token=actors['owner']['token'];path='repos/'+actors['owner']['name']+'/'+fixture_name
                        result=json.loads(command('exec','-T','golf','/run/golf/read-proof/native-helper',payload={'project':project,'token':token,'method':'DELETE','path':'/api/v1/'+path},timeout=20))
                        require(result.get('status') in (204,404),'cleanup_native_repository')
                    except Exception:failures.append('native_repository_delete')
            for actor in reversed(list(actors.values())):
                if actor['enrolled']:
                    try:require(operator('disable',{'username':actor['name']}).get('disabled') is True,'managed_disable')
                    except Exception:failures.append('managed_account_disable')
                if actor['created']:
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:failures.append('native_actor_purge');record(nativePurgeFailedRoles=[r for r,a in actors.items() if a is actor])
            if started:
                try:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for args in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:require(not run('docker',*args,'--filter','label=com.docker.compose.project='+project).strip(),'owned_resource_remaining')
                except Exception:failures.append('owned_compose_resources')
            record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=sorted(set(failures)),retainedGolfMetadata='none after fresh volumes removed; before teardown disabled accounts and immutable capability metadata remain')
            if failures:
                if passed:record(failedStage='owned fixture cleanup')
                raise AssertionError('owned_cleanup_failed')
    record(status='passed',stage='complete')
    print('PASS: actual fresh managed READ Git/TLS/authority/restart proof; WRITE and P0.8 remain unqualified',flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:
        record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureClass=type(error).__name__)
        print('FAIL: managed READ qualification at '+PROOF.get('failedStage',STAGE)+'; private diagnostics withheld',file=sys.stderr)
        sys.exit(1)
