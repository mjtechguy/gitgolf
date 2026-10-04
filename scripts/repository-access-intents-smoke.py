#!/usr/bin/env python3
"""Prepared fresh048 Access qualification. Root executes, not source evidence.

Requires an exact cached revision-labelled --image and NEW --output. No builds,
pulls, retained policy changes, CI, inference, external destination or SQL writes.
An owned adapter inside the fresh Compose network forwards unchanged native
requests; one exact collaborator PUT loses its response only AFTER a real native204.
Requires --proxy-binary (precompiled Linux ARM64); only nonce-authenticated control
is published on loopback. No host bridge is used for native forwarding. --ui adds12 actual
inventory/requested-role/original-receipt captures. --self-check is pure.
"""
import argparse
import base64
import datetime
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
sys.dont_write_bytecode=True
import smoke
import native_qualification_proxy as native_proxy
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('access48_invitation_helpers',ROOT/'scripts/repository-invitations-smoke.py')
inv=importlib.util.module_from_spec(spec);spec.loader.exec_module(inv)
common=inv.common
PROOF={'status':'not_started','cleanup':'not_started','captures':[], 'nativeSources':['https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/collaborators.go','https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/repository/collaboration.go'], 'scope':'Requested direct read/write/admin acknowledgements and retained original access/invitation generations; no native atomic CAS, exclusive stored-role proof, recovery or full Access readiness'}
common.PROOF=PROOF
record,stage,checked_rpc=common.record,common.stage,common.checked_rpc
SERVICE='RepositoryInvitationService/'
ACCESS='RepositoryAccessService/'
positive,revision,key=inv.positive,inv.revision,inv.key
BINDINGS=inv.BINDINGS
invitation,operation=inv.invitation,inv.operation
RANK={'none':0,'read':1,'write':2,'admin':3,'owner':4}

def checked_rpc(session, procedure, payload=None, expected=200, headers=None, code=None):
    """One dispatch; persist only procedure/status/code, never bodies or messages."""
    import urllib.error
    import urllib.request
    assert re.fullmatch(r'[A-Za-z]+Service/[A-Za-z]+',procedure)
    request=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure, data=json.dumps({} if payload is None else payload).encode(), method='POST', headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
    try:response=session.open(request,timeout=15)
    except urllib.error.HTTPError as error:response=error
    except (urllib.error.URLError,OSError) as error:
        record(lastProcedure={'procedure':procedure,'status':None,'transportFailure':type(error).__name__})
        raise RuntimeError('RPC transport unavailable; safe metadata recorded') from None
    with response:
        raw=response.read((1<<20)+1)
        metadata={'procedure':procedure,'status':response.status,'noStore':response.headers.get('Cache-Control')=='no-store'}
        if response.headers.get('Golf-Access-Effect')=='none':metadata['effect']='none'
        result=None
        if len(raw)<=1<<20:
            try:result=json.loads(raw) if raw else None
            except (ValueError,UnicodeError):pass
        if isinstance(result,dict) and isinstance(result.get('code'),str) and re.fullmatch(r'[a-z_]{1,64}',result['code']):metadata['code']=result['code']
        observations=PROOF.get('procedureObservations',[])
        assert len(observations)<1024
        observations.append(metadata);record(lastProcedure=metadata,procedureObservations=observations)
        assert len(raw)<=1<<20 and response.status==expected and metadata['noStore'],'RPC status/protocol mismatch; safe procedure metadata recorded'
        if expected!=200:
            codes={400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',429:'resource_exhausted',503:'unavailable'}
            assert isinstance(result,dict) and result.get('code')==(code or codes[expected]) and result.get('message'),'RPC error code mismatch; safe procedure metadata recorded'
        return result


def file_sha256(path, bound):
    assert path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= bound, 'Owned bounded source/binary required'
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def proxy_binary_receipt(path):
    path = path.absolute()
    assert path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o111, 'Owned executable proxy binary required'
    digest = file_sha256(path, 64 << 20)
    with path.open('rb') as file:
        header = file.read(64)
    assert len(header) == 64 and header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == 183, 'Compiled Linux ARM64 proxy required; no build occurs here'
    return path, digest


def proxy_state(proxy, label):
    # Control failure must not overwrite the original native/RPC predicate.
    try:
        value = proxy.snapshot()
        failures = [row for row in value['observations'] if row.get('failure') and not row.get('callerCancelled')]
        record(**{label: value}, forwardRequestCount=value['forwardRequestCount'], forwardObservations=value['observations'], proxyFailures=value['failures'], forwardFailure=failures[-1] if failures else None)
        return value
    except Exception as error:
        record(**{label+'Unavailable': True, label+'FailureType': type(error).__name__})
        return None


def verify_proxy_runtime(run, command, proxy, binary, binary_sha, image, source):
    identifier = command('ps', '-q', native_proxy.SERVICE_NAME)
    assert re.fullmatch(r'[a-f0-9]{12,64}', identifier), 'Exact owned proxy container required'
    value = json.loads(run('docker', 'inspect', '--format', '{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"entrypoint":{{json .Config.Entrypoint}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}}}', identifier))
    destination = '/usr/local/bin/native-qualification-proxy'
    assert value['image'] == image and value['reference'] == image and value['revision'] == source and value['readOnly'] is True, 'Proxy cached-image receipt mismatch'
    assert value['composeProject'] == proxy.project and value['composeService'] == native_proxy.SERVICE_NAME and value['entrypoint'] == [destination], 'Proxy exact process/project mismatch'
    mounts = value['mounts']
    assert isinstance(mounts, list) and len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Source'] == str(binary) and mounts[0]['Destination'] == destination and mounts[0]['RW'] is False, 'Proxy read-only exact binary mount mismatch'
    published = {name: bindings for name, bindings in value['ports'].items() if bindings}
    assert published == {'8082/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(proxy.port)}]}, 'Only loopback control may be published; forwarding stays internal'
    checksum = command('exec', '-T', native_proxy.SERVICE_NAME, '/bin/busybox', 'sha256sum', destination)
    assert checksum.split() == [binary_sha, destination] and file_sha256(binary, 64 << 20) == binary_sha, 'Mounted/source binary hash mismatch'
    receipt = {'image': image, 'sourceRevision': source, 'binarySha256': binary_sha,
               'adapterGoSha256': file_sha256(ROOT/'scripts/native-qualification-proxy.go', 1 << 20),
               'adapterModuleSha256': file_sha256(Path(native_proxy.__file__), 1 << 20),
               'helperSha256': file_sha256(Path(__file__), 1 << 20),
               'readOnlyBinaryMount': True, 'controlLoopbackOnly': True, 'forwardInternalOnly': True,
               'nativeDestination': native_proxy.NATIVE_DESTINATION}
    record(proxyRuntime=receipt)
    return receipt


def checked_startup_proxy(value, project):
    value = native_proxy.checked_snapshot(value, project)
    assert value['lost'] == 0 and value['armed'] is None and value['counts'] == [], 'Startup baseline must have no mutation dispatch or loss arm'
    failures = [row for row in value['observations'] if row.get('failure') and not row.get('callerCancelled')]
    assert len(failures) == value['failures'], 'All startup failures must remain accounted in the bounded observation window'
    assert all(row['method'] == 'GET' and row['failure'] in {'preheaders_timeout','preheaders_cancelled','preheaders_disconnected','preheaders_transport'} and 'status' not in row and 'bytes' not in row for row in failures), 'Only pre-header startup reads may be distinguished from qualification failures'
    assert any(row['method'] == 'GET' and row.get('status') == 200 and not row.get('failure') for row in value['observations']), 'Positive native read readiness observation required'
    return value


def checked_proxy_progress(value, baseline, project):
    checked_startup_proxy(baseline, project)
    value = native_proxy.checked_snapshot(value, project)
    assert value['failures'] == baseline['failures'] and value['forwardRequestCount'] >= baseline['forwardRequestCount'] and value['callerCancelled'] >= baseline['callerCancelled'], 'Post-readiness transport failure or reset is not startup noise'
    return value


def startup_proxy_source_check():
    project = 'golf-rules49-0123456789'
    baseline = {'project':project,'nativeDestination':native_proxy.NATIVE_DESTINATION,'counts':[],
                'observations':[{'method':'GET','category':'authority','status':200,'elapsedMs':1}],
                'forwardRequestCount':1,'lost':0,'failures':0,'callerCancelled':0,'armed':None}
    checked_startup_proxy(baseline, project)
    cancelled = {**baseline,'forwardRequestCount':2,'callerCancelled':1,'observations':[*baseline['observations'], {'method':'GET','category':'authority','elapsedMs':1,'failure':'preheaders_cancelled','callerCancelled':True}]}
    checked_proxy_progress(cancelled, baseline, project)
    startup = {**baseline,'forwardRequestCount':3,'failures':2,'observations':[
        {'method':'GET','category':'authority','elapsedMs':1,'failure':'preheaders_disconnected'},
        {'method':'GET','category':'authority','elapsedMs':2,'failure':'preheaders_transport'}, *baseline['observations']]}
    checked_startup_proxy(startup, project)
    checked_proxy_progress({**startup,'forwardRequestCount':4,'lost':1}, startup, project)
    for bad in ({**startup,'failures':3}, {**baseline,'lost':1}, {**baseline,'armed':{'method':'POST','path':'/api/v1/repos/'+project+'-owner/rules/branch_protections','status':201,'ruleName':'unknown/*'}},
                {**baseline,'counts':[{'method':'PATCH','path':'/api/v1/repos/'+project+'-owner/rules','count':1}]},
                {**startup,'observations':[{**startup['observations'][0],'failure':'response_transport'},*startup['observations'][1:]]},
                {**startup,'observations':[{**startup['observations'][0],'method':'POST'},*startup['observations'][1:]]}):
        try:checked_startup_proxy(bad,project)
        except AssertionError:pass
        else:raise AssertionError('Unaccounted/private/mutation startup failure accepted')
    for first in (baseline,startup):
        for bad in ({**first,'failures':first['failures']+1}, {**first,'forwardRequestCount':0}):
            try:checked_proxy_progress(bad,first,project)
            except AssertionError:pass
            else:raise AssertionError('Post-readiness failure/reset suppressed')


def proxy_source_check():
    native_proxy.self_check()
    startup_proxy_source_check()
    with tempfile.TemporaryDirectory(prefix='golf-proxy-pure-') as temporary:
        binary = Path(temporary)/'proxy'
        header = bytearray(64); header[:6] = b'\x7fELF\x02\x01'; header[18:20] = (183).to_bytes(2, 'little')
        binary.write_bytes(header); binary.chmod(0o700)
        selected, digest = proxy_binary_receipt(binary)
        proxy = native_proxy.NativeProxy(39001, 'golf-rules49-0123456789')
        service = proxy.compose_service('sha256:'+'a'*64, selected)
        assert service['image'] == 'sha256:'+'a'*64 and service['pull_policy'] == 'never'
        assert service['ports'] == ['127.0.0.1:39001:8082'] and service['expose'] == ['8081']
        assert service['environment']['NATIVE_QUALIFICATION_NONCE'] == '${NATIVE_QUALIFICATION_NONCE:?}' and proxy._nonce not in json.dumps(service)
        assert service['volumes'] == [str(selected)+':/usr/local/bin/native-qualification-proxy:ro'] and len(digest) == 64
        # Pure inspector response validation; no Docker/native method is called.
        destination = '/usr/local/bin/native-qualification-proxy'
        image = 'sha256:'+'a'*64; revision = 'b'*40
        observed = {'image':image,'reference':image,'revision':revision,'readOnly':True,
                    'composeProject':proxy.project,'composeService':native_proxy.SERVICE_NAME,'entrypoint':[destination],
                    'mounts':[{'Type':'bind','Source':str(selected),'Destination':destination,'RW':False}],
                    'ports':{'8082/tcp':[{'HostIp':'127.0.0.1','HostPort':str(proxy.port)}]}}
        def command(*arguments):
            if arguments == ('ps','-q',native_proxy.SERVICE_NAME):return 'c'*64
            assert arguments == ('exec','-T',native_proxy.SERVICE_NAME,'/bin/busybox','sha256sum',destination)
            return digest+'  '+destination
        def run(*arguments):
            assert arguments[:2] == ('docker','inspect') and arguments[-1] == 'c'*64
            return json.dumps(observed)
        prior = dict(PROOF)
        try:
            receipt = verify_proxy_runtime(run,command,proxy,selected,digest,image,revision)
            assert receipt['binarySha256'] == digest and receipt['sourceRevision'] == revision and proxy._nonce not in json.dumps(receipt)
            for field, value in (('image','sha256:'+'d'*64),('reference','mutable-tag'),('readOnly',False),('composeProject','foreign'),
                                 ('mounts',[{'Type':'bind','Source':str(selected),'Destination':destination,'RW':True}]),
                                 ('ports',{'8081/tcp':[{'HostIp':'0.0.0.0','HostPort':'8081'}]})):
                previous = observed[field]; observed[field] = value
                try: verify_proxy_runtime(run,command,proxy,selected,digest,image,revision)
                except AssertionError:pass
                else:raise AssertionError('Foreign/unbounded proxy runtime binding accepted')
                finally:observed[field] = previous
            try:verify_proxy_runtime(run,command,proxy,selected,'e'*64,image,revision)
            except AssertionError:pass
            else:raise AssertionError('Unmatched mounted binary hash accepted')
        finally:PROOF.clear();PROOF.update(prior)
        header[18:20] = (62).to_bytes(2, 'little'); binary.write_bytes(header)
        try: proxy_binary_receipt(binary)
        except AssertionError: pass
        else: raise AssertionError('Foreign architecture proxy accepted')
    launcher = Path(__file__).read_text()
    assert '--proxy-binary' in launcher and 'http://'+'host.docker.internal:' not in launcher and 'Threading'+'HTTPServer' not in launcher
    assert 'http://native-qualification-proxy:8081' in launcher and "proxy.close()" in launcher and "proxy.ready()" in launcher


def access_operation(row,original,actor,phase):
    assert row['idempotencyKey']==original['idempotencyKey'] and row['repository']==original['repository']
    for field in ('repositoryId','ownerId'):assert row[field]==original[field] and positive(row[field])
    assert row['recipientId']==original['userId'] and row['recipientLogin']==original['userLogin'] and row['actorId']==actor['id']
    assert row.get('requestedPermission','')==original.get('permission','') and row.get('remove',False)==('permission' not in original)
    assert positive(row['generation']) and row['phase']==phase and row.get('failureCode','')==('preflight_refused' if phase=='REJECTED' else '')
    assert datetime.datetime.fromisoformat(row['updatedAt'].replace('Z','+00:00'))>=datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00'))
    if phase=='SUCCEEDED':
        assert row.get('observedDirectMembership',False)==('permission' in original)
        assert row['observedEffectivePermission'] in RANK
        if 'permission' in original:assert RANK[row['observedEffectivePermission']]>=RANK[original['permission']]
    else:assert not row.get('observedEffectivePermission','') and not row.get('observedDirectMembership',False)
    return row

def checked_owner_refusals(receipts):
    expected={'set','remove','invitation-preview','invitation-create'}
    assert isinstance(receipts,list) and len(receipts)==4
    assert {r['action'] for r in receipts}==expected
    for r in receipts:
        assert set(r)=={'action','nativeOwner','nativeMutations','generationBefore','generationAfter'}
        assert r['nativeOwner'] is True and type(r['nativeMutations']) is int and r['nativeMutations']==0
        assert re.fullmatch(r'0|[1-9][0-9]*',r['generationBefore'])
        assert r['generationAfter']==r['generationBefore']
    return receipts

def checked_invitation_matrix(receipts):
    expected={(scope,issuer,permission)
              for scope in ('personal','organization')
              for issuer in ('owner','member-direct-admin')
              for permission in ('read','write','admin')}
    assert isinstance(receipts,list) and len(receipts)==12,'Require all twelve actual invitation role cases'
    observed=[]
    for receipt in receipts:
        assert set(receipt)=={'scope','issuer','requestedPermission','phase'} and receipt['phase']=='SUCCEEDED'
        observed.append((receipt['scope'],receipt['issuer'],receipt['requestedPermission']))
    assert len(set(observed))==12 and set(observed)==expected,'Require exact invitation scope/issuer/role matrix'
    return receipts

def self_check():
    source=(ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('SetRepositoryCollaborator','RemoveRepositoryCollaborator','GetRepositoryAccessOperation'):assert 'rpc '+method+'(' in source
    for message,field,tag in [('SetRepositoryCollaboratorRequest','idempotency_key',9),('RemoveRepositoryCollaboratorRequest','idempotency_key',8),('RepositoryCollaborator','generation',5)]:
        body=re.search(r'message '+message+r'\s*\{([^}]+)\}',source).group(1);assert re.search(r'string\s+'+field+r'\s*=\s*'+str(tag)+r'\s*;',body)
    actor={'id':'5'};original={'repository':{'owner':'owner','name':'fixture'},'repositoryId':'7','ownerId':'9','userId':'11','userLogin':'recipient','permission':'read','idempotencyKey':key()}
    row={'repository':original['repository'],'repositoryId':'7','ownerId':'9','recipientId':'11','recipientLogin':'recipient','actorId':'5','requestedPermission':'read','idempotencyKey':original['idempotencyKey'],'generation':'2','phase':'SUCCEEDED','observedDirectMembership':True,'observedEffectivePermission':'admin','createdAt':'2026-10-04T12:00:00Z','updatedAt':'2026-10-04T12:00:01Z'}
    access_operation(row,original,actor,'SUCCEEDED')
    for field,value in [('repositoryId','8'),('ownerId','10'),('recipientId','12'),('actorId','6'),('recipientLogin','other'),('requestedPermission','write'),('generation','0'),('observedDirectMembership',False),('observedEffectivePermission','none')]:
        try:access_operation({**row,field:value},original,actor,'SUCCEEDED')
        except (AssertionError,ValueError):pass
        else:raise AssertionError('Foreign or weak original receipt accepted')
    removal={k:v for k,v in original.items() if k!='permission'}
    access_operation({**row,'requestedPermission':'','remove':True,'observedDirectMembership':False},removal,actor,'SUCCEEDED')
    try:access_operation({**row,'phase':'DISPATCH_UNKNOWN'},original,actor,'DISPATCH_UNKNOWN')
    except AssertionError:pass
    else:raise AssertionError('Unknown adopted fresh observation')
    matrix=[{'scope':scope,'issuer':issuer,'requestedPermission':permission,'phase':'SUCCEEDED'}
            for scope in ('personal','organization')
            for issuer in ('owner','member-direct-admin')
            for permission in ('read','write','admin')]
    assert checked_invitation_matrix(matrix) is matrix
    historical_eight=[r for r in matrix if r['issuer']=='owner' or r['requestedPermission']=='admin']
    assert len(historical_eight)==8
    for invalid in (historical_eight,matrix[:-1],matrix+[matrix[0]],matrix[:-1]+[matrix[0]],
                    [{**r,'phase':'DISPATCH_UNKNOWN'} if i==0 else r for i,r in enumerate(matrix)],
                    [{**r,'issuer':'team-only-admin'} if i==0 else r for i,r in enumerate(matrix)],
                    [{**r,'privateBody':'forbidden'} if i==0 else r for i,r in enumerate(matrix)]):
        try:checked_invitation_matrix(invalid)
        except AssertionError:pass
        else:raise AssertionError('Incomplete, duplicate or unconfirmed invitation role matrix accepted')
    refused=[{'action':action,'nativeOwner':True,'nativeMutations':0,'generationBefore':'0','generationAfter':'0'}
             for action in ('set','remove','invitation-preview','invitation-create')]
    assert checked_owner_refusals(refused) is refused
    for invalid in (refused[:-1],refused[:-1]+[refused[0]],
                    [{**r,'nativeOwner':False} if i==0 else r for i,r in enumerate(refused)],
                    [{**r,'nativeMutations':1} if i==0 else r for i,r in enumerate(refused)],
                    [{**r,'generationAfter':'1'} if i==0 else r for i,r in enumerate(refused)]):
        try:checked_owner_refusals(invalid)
        except AssertionError:pass
        else:raise AssertionError('Missing ownership proof or effectful protected-owner refusal accepted')
    proxy_source_check()
    print('PASS: pure048 wire, exact actor/target/intent/phase receipts, inherited permission, exact twelve-case invitation matrix and unknown non-adoption; no runtime resources')

def main():
    global ROOT
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--self-check',action='store_true');parser.add_argument('--image');parser.add_argument('--proxy-binary',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--ui',action='store_true');parser.add_argument('--stack-root',type=Path,default=ROOT);args=parser.parse_args()
    if args.self_check:self_check();return
    ROOT=args.stack_root.resolve()
    if not args.image or not args.output or not args.proxy_binary:parser.error('--image, --proxy-binary and a new --output are required')
    binary,binary_sha=proxy_binary_receipt(args.proxy_binary)
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700);args.output.chmod(0o700);common.OUTPUT=args.output.resolve();record(status='running',browser='pending' if args.ui else 'not_requested')
    if args.ui:assert (ROOT/'web/node_modules/playwright/index.mjs').is_file(),'Require existing local browser dependency; no installation'
    spec=importlib.util.spec_from_file_location('invitation_stack_helpers',ROOT/'scripts/observability-smoke.py');helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    def run(*arguments,payload=None,timeout=180):
        result=subprocess.run(arguments,cwd=ROOT,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Private subprocess failure; output withheld'
        return result.stdout.decode().strip()
    stage('exact prebuilt product image and cached pinned base dependencies')
    selected=json.loads(run('docker','image','inspect',args.image))[0];image=selected['Id'];source=selected['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}',image) and re.fullmatch(r'[0-9a-f]{40}',source or '')
    for name in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless'):run('docker','image','inspect',name)
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',image,'-Pk','/')
    assert int(space.splitlines()[-1].split()[3])>=2*1024*1024,'Require 2 GiB free VM disk before fresh fixture'
    project='golf-access48-'+secrets.token_hex(5);ports=helpers.free_ports(3);previous=smoke.GOLF,smoke.GITEA;smoke.GOLF,smoke.GITEA='http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1]);actors={};repositories={};organizations={};bearers=[];started=False;passed=False
    record(project=project,selectedImage=image,sourceRevision=source,cleanup='not_created',proxy='owned_inside_compose_fixed_native_destination')
    with native_proxy.NativeProxy(ports[2],project) as proxy, tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700);values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')};values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        env_file,override=directory/'core.env',directory/'proof.yaml';helpers.private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()));helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
    environment:
      GITEA_URL: http://native-qualification-proxy:8081
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        environment.update(proxy.environment())
        proxy_override=directory/'proxy.json'
        helpers.private_write(proxy_override,json.dumps({'services':{native_proxy.SERVICE_NAME:proxy.compose_service(image,binary),'golf':{'depends_on':{native_proxy.SERVICE_NAME:{'condition':'service_started'}}}}}))
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(override),'-f',str(proxy_override)]
        def command(*arguments,**kwargs):return run(*compose,*arguments,**kwargs)
        def admin(*arguments):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        def operator(action,payload):
            result=json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account',action,payload=payload));assert result['state']=='complete';return result['result']
        def login(actor):
            actor['session']=smoke.client();u=checked_rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert u['id']==actor['id'];actor['loggedIn']=True
        def runtime():
            container=command('ps','-q','golf');assert re.fullmatch(r'[0-9a-f]{12,64}',container);r=json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',container));assert r['image']==image and r['reference']==image and r['revision']==source;r['nativeVersion']=smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/version')['version'];assert r['nativeVersion']=='1.27.3';return r
        def call(actor,method,payload=None,**kwargs):return checked_rpc(actor['session'],SERVICE+method,payload,**kwargs)
        def create_repo(owner,name,organization=None):
            native=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos' if organization else 'user/repos',{'name':name,'private':True,'auto_init':True},201);r={'key':{'owner':native['owner']['login'],'name':native['name']},'name':native['full_name'],'id':str(native['id']),'ownerId':str(native['owner']['id']),'owner':owner};repositories[r['name']]=r;smoke.wait_for_push(owner['token'],r['name']);return r
        def member(repository,recipient,wanted):
            smoke.provider(repository['owner']['token'],'GET','repos/'+repository['name']+'/collaborators/'+recipient['name'],expected=204 if wanted else 404)
            if wanted:
                r=smoke.provider(repository['owner']['token'],'GET','repos/'+repository['name']+'/collaborators/'+recipient['name']+'/permission');assert str(r['user']['id'])==recipient['id'];return r['permission']
        def target(repository,actor):
            a=checked_rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository['key']})['access'];assert a['repositoryId']==repository['id'] and a['ownerId']==repository['ownerId'] and revision(a['revision']);record(authorityObservation={'canManage':a.get('canManage',False),'permission':a['currentPermission'],'organizationOwned':a.get('organizationOwned',False)});return {'repository':repository['key'],'repositoryId':a['repositoryId'],'ownerId':a['ownerId'],'expectedRevision':a['revision']}
        def create(repository,issuer,recipient,permission="read",seconds=3600):
            t=target(repository,issuer);before=member(repository,recipient,False);preview=call(issuer,'PreviewRepositoryInvitationRecipient',{**t,'username':recipient['name']});assert preview['repositoryId']==repository['id'] and preview['ownerId']==repository['ownerId'] and preview['accessRevision']==t['expectedRevision'];u=preview['recipient'];assert u['user']['id']==recipient['id'] and u['user']['login']==recipient['name'] and revision(u['revision']);payload={**t,'recipientId':recipient['id'],'recipientUsername':recipient['name'],'recipientRevision':u['revision'],'permission':permission,'expiresAt':datetime.datetime.fromtimestamp(time.time()+seconds,datetime.timezone.utc).isoformat().replace('+00:00','Z'),'persistentConsent':True,'idempotencyKey':key()};r=invitation(call(issuer,'CreateRepositoryInvitation',payload)['invitation'],recipient,repository);assert r['state']=='PENDING' and r['revision']=='1';member(repository,recipient,False);return r,payload
        def respond(recipient,row,decision='REPOSITORY_INVITATION_DECISION_ACCEPT',**kwargs):
            original={'invitationId':row['id'],'expectedRevision':row['revision'],'decision':decision,'idempotencyKey':key()};return call(recipient,'RespondRepositoryInvitation',original,**kwargs),original
        def inspect_invitation(recipient,original,phase):return operation(call(recipient,'GetRepositoryInvitationOperation',{'invitationId':original['invitationId'],'idempotencyKey':original['idempotencyKey']})['operation'],original,phase)
        def own(recipient,identifier,hidden=False):
            r=call(recipient,'ListOwnRepositoryInvitations',{'page':{'page':1,'limit':20}});assert r.get('page',{}).get('nextPage',0)==0;rows=r.get('invitations',[]);assert len(rows)<=20 and len({x['id'] for x in rows})==len(rows);return invitation(next(x for x in rows if x['id']==identifier),recipient,hidden=hidden)
        def resolve(repository,actor,recipient):
            t=target(repository,actor);c=checked_rpc(actor['session'],ACCESS+'ResolveRepositoryCollaborator',{**t,'userLogin':recipient['name']})['collaborator'];assert c['user']['id']==recipient['id'] and c['user']['login']==recipient['name'] and revision(c['revision']);assert not c.get('actualOrganizationOwner',False) or c['permission']=='owner';return t,c
        def intent(repository,actor,recipient,permission=None):
            t,c=resolve(repository,actor,recipient);p={**t,'userLogin':recipient['name'],'userId':recipient['id'],'expectedCollaboratorRevision':c['revision'],'idempotencyKey':key()}
            if permission:p['permission']=permission
            return p,c
        def inspect_access(actor,p,phase):
            response=checked_rpc(actor['session'],ACCESS+'GetRepositoryAccessOperation',{k:v for k,v in p.items() if k in {'repository','repositoryId','ownerId','expectedRevision','userId','idempotencyKey'}});assert not response.get('collaborator');return access_operation(response['operation'],p,actor,phase)
        def mutate(repository,actor,recipient,p,phase='SUCCEEDED'):
            before=proxy.count(repository,recipient);method='SetRepositoryCollaborator' if 'permission' in p else 'RemoveRepositoryCollaborator';response=checked_rpc(actor['session'],ACCESS+method,p);op=access_operation(response['operation'],p,actor,phase);assert proxy.count(repository,recipient)==before+1
            assert inspect_access(actor,p,phase)==op
            replay=checked_rpc(actor['session'],ACCESS+method,p);assert replay['operation']==op and not replay.get('collaborator') and proxy.count(repository,recipient)==before+1
            return op,response.get('collaborator')
        def grant_cycle(repository,actor,recipient,roles):
            generations=[]
            for permission in roles:
                record(accessCheck={'scope':'organization' if repository['key']['owner']!=repository['owner']['name'] else 'personal','actor':actor['role'],'requestedPermission':permission,'action':'set'})
                p,c=intent(repository,actor,recipient,permission);record(targetObservation={'permission':c['permission'],'isDirect':c.get('isDirect',False),'isOwner':c['user']['id']==repository['ownerId'],'isCaller':c['user']['id']==actor['id']});op,current=mutate(repository,actor,recipient,p);generations.append(int(op['generation']));assert current['generation']==op['generation'] and current['isDirect'] and RANK[member(repository,recipient,True)]>=RANK[permission]
                if permission=='read' and actor is repository['owner'] and repository['key']['owner']==actor['name']:
                    a=checked_rpc(recipient['session'],ACCESS+'GetRepositoryAccess',{'repository':repository['key']})['access'];assert not a.get('canManage',False)
                    checked_rpc(recipient['session'],ACCESS+'SetRepositoryCollaborator',{**p,'idempotencyKey':key()},expected=403)
                # The acknowledged204 proves the requested role, not the inaccessible stored direct mode.
                checked_rpc(actor['session'],ACCESS+'SetRepositoryCollaborator',{**p,'permission':'write' if permission!='write' else 'read'},expected=400,code='failed_precondition')
                remove,_=intent(repository,actor,recipient);removed,current=mutate(repository,actor,recipient,remove);generations.append(int(removed['generation']));assert not current.get('isDirect',False);member(repository,recipient,False)
            assert generations==sorted(set(generations));return generations
        try:
            stage('fresh cached048 core and owned internal-network forwarding prerequisite');started=True;record(cleanup='pending');command('up','-d','--no-build','--pull','never',timeout=180)
            try:proxy.ready();verify_proxy_runtime(run,command,proxy,binary,binary_sha,image,source);smoke.ready()
            except RuntimeError:
                # Public closed dependency states only; no logs/env/token/body dump.
                diagnostic={}
                for label,url in (('golf',smoke.GOLF+'/readyz'),('native',smoke.GITEA+'/api/v1/version')):
                    try:
                        try:response=urllib.request.urlopen(url,timeout=5)
                        except urllib.error.HTTPError as e:response=e
                        with response:
                            raw=response.read(4097);diagnostic[label+'Status']=response.status
                            if len(raw)<=4096:
                                value=json.loads(raw)
                                if label=='golf' and set(value.get('checks',{}))=={'database','gitea'} and all(v in {'ready','unavailable','unsupported_version'} for v in value['checks'].values()):diagnostic['checks']=value['checks']
                                if label=='native':diagnostic['nativeVersionMatches']=value.get('version')=='1.27.3'
                    except Exception:diagnostic[label+'TransportUnavailable']=True
                container=command('ps','-aq','golf')
                if re.fullmatch(r'[a-f0-9]{12,64}',container):
                    state=json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"state":{{json .State.Status}},"exit":{{json .State.ExitCode}}}',container))
                    assert state['image']==image;diagnostic['coreState']=state['state'];diagnostic['coreExit']=state['exit']
                    logged=subprocess.run(['docker','logs','--tail','40',container],cwd=ROOT,env=environment,capture_output=True,timeout=10)
                    text=(logged.stdout+logged.stderr).decode(errors='replace')
                    diagnostic['fatalCategories']=[name for name,pattern in [('exec_format','exec format'),('migration','migrat|goose|SQLSTATE'),('encryption','encrypt|cipher|keyring'),('permission','permission denied'),('configuration','config|invalid|unsupported'),('database','database|postgres|connect'),('listen','bind|address|listen')] if re.search(pattern,text,re.I)]
                    codes=re.findall(r'SQLSTATE ([A-Z0-9]{5})',text);diagnostic['sqlStates']=sorted(set(codes))
                    for line in text.splitlines():
                        try:event=json.loads(line)
                        except ValueError:continue
                        message=event.get('message','')
                        if message in {'Golf stopped','telemetry shutdown failed'}:
                            diagnostic['stoppedMessage']=message
                            # Persist only an exact source literal or fixed formatting
                            # template, never the runtime error's interpolated values.
                            runtime_error=event.get('error','');closed=set();templates=set()
                            for tree in ('cmd/golf','internal/server','internal/telemetry'):
                                for source_file in (ROOT/tree).rglob('*.go'):
                                    if source_file.name.endswith('_test.go'):continue
                                    for kind,literal in re.findall(r'(errors\.New|fmt\.Errorf)\((\"(?:[^\"\\]|\\.)*\")',source_file.read_text()):
                                        try:text_value=json.loads(literal)
                                        except ValueError:continue
                                        if kind=='errors.New':closed.add(text_value)
                                        elif '%' in text_value:templates.add(text_value)
                            if runtime_error in closed:diagnostic['closedSourceError']=runtime_error
                            else:
                                matching=[v for v in templates if len(v.split('%',1)[0])>=12 and runtime_error.startswith(v.split('%',1)[0])]
                                diagnostic['closedSourceErrorTemplate']=sorted(matching)[0] if matching else 'unmatched_private_error_withheld'
                    observation=subprocess.run(['docker','exec',container,'/bin/wget','-q','-T','3','-O','-','http://native-qualification-proxy:8081/api/v1/version'],cwd=ROOT,env=environment,capture_output=True,timeout=10)
                    diagnostic['containerProxyReadExit']=observation.returncode
                    try:diagnostic['containerProxyVersionMatches']=len(observation.stdout)<=4096 and json.loads(observation.stdout).get('version')=='1.27.3'
                    except Exception:diagnostic['containerProxyVersionMatches']=False
                record(startupObservation=diagnostic);proxy_state(proxy,'startupProxyState')
                raise
            proxy_baseline=checked_startup_proxy(proxy.snapshot(),project);record(preQualificationProxyState=proxy_baseline,proxyStartupFailureCount=proxy_baseline['failures'],proxyFailureScope='Verified pre-header GET startup failures only; confirmed caller-aborted GETs counted separately; every other post-readiness failure remains disqualifying')
            before=runtime();proxy_before=verify_proxy_runtime(run,command,proxy,binary,binary_sha,image,source);record(runtime=before)
            stage('ordinary actors and managed local sessions; no native site administrator bypass')
            for role in ('owner','recipient','directadmin','outsider','golfadmin','teamadmin'):
                actor={'role':role,'name':project+'-'+role,'created':False,'loggedIn':False};actors[role]=actor;admin('create','--username',actor['name'],'--email',actor['name']+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True;actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw');u=smoke.provider(actor['token'],'GET','user');assert not u['is_admin'];actor.update(id=str(u['id']),email=actor['name']+'@golf.invalid',password='Access48 fixture '+secrets.token_urlsafe(24));operator('create',{'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='golfadmin'});login(actor)
            owner,recipient,direct,outsider,golfadmin,teamadmin=(actors[x] for x in ('owner','recipient','directadmin','outsider','golfadmin','teamadmin'))
            personal=create_repo(owner,'personal');smoke.provider(owner['token'],'PUT','repos/'+personal['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204)
            stage('personal owner read/write/admin and direct-admin explicit changes/removal')
            grant_cycle(personal,owner,recipient,('read','write','admin'));grant_cycle(personal,direct,recipient,('admin',))
            p,_=intent(personal,owner,recipient,'read');receipt,_=mutate(personal,owner,recipient,p);query={k:v for k,v in p.items() if k in {'repository','repositoryId','ownerId','expectedRevision','userId','idempotencyKey'}};checked_rpc(direct['session'],ACCESS+'GetRepositoryAccessOperation',query,expected=404);removed,_=intent(personal,owner,recipient);mutate(personal,owner,recipient,removed)
            organization=project+'-org';org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},201);organizations[organization]={'id':org['id'],'owner':owner};orgrepo=create_repo(owner,'organization',organization)
            for actor,permission in ((direct,'read'),(teamadmin,'admin'),(recipient,'admin')):
                team=smoke.provider(owner['token'],'POST','orgs/'+organization+'/teams',{'name':actor['role'],'permission':permission,'visibility':'limited','units_map':{'repo.code':permission},'includes_all_repositories':False},201);smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+actor['name'],expected=204);smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+orgrepo['name'],expected=204)
            smoke.provider(owner['token'],'PUT','repos/'+orgrepo['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204)
            stage('organization owner/member-direct admin roles below inherited admin; removal preserves team access')
            grant_cycle(orgrepo,owner,recipient,('read','write','admin'));grant_cycle(orgrepo,direct,recipient,('read',));assert member(orgrepo,recipient,False) is None
            effective=smoke.provider(owner['token'],'GET','repos/'+orgrepo['name']+'/collaborators/'+recipient['name']+'/permission');assert str(effective['user']['id'])==recipient['id'] and effective['permission']=='owner'
            stage('actual organization-owner recipient protected from different member direct-admin edits and invitations')
            ownership_route='users/'+owner['name']+'/orgs/'+organization+'/permissions'
            assert smoke.provider(owner['token'],'GET',ownership_route)['is_owner'] is True
            protected_target,protected_before=resolve(orgrepo,direct,owner)
            assert protected_before.get('actualOrganizationOwner') is True and protected_before['permission']=='owner'
            protected_count=proxy.count(orgrepo,owner)
            protected_invitations=call(direct,'ListRepositoryInvitations',{**protected_target,'page':{'page':1,'limit':20}})
            assert protected_invitations.get('page',{}).get('nextPage',0)==0
            protected_receipts=[]
            for action in ('set','remove','invitation-preview','invitation-create'):
                if action in ('set','remove'):
                    payload={**protected_target,'userLogin':owner['name'],'userId':owner['id'],
                             'expectedCollaboratorRevision':protected_before['revision'],'idempotencyKey':key()}
                    if action=='set':payload['permission']='read'
                    checked_rpc(direct['session'],ACCESS+('SetRepositoryCollaborator' if action=='set' else 'RemoveRepositoryCollaborator'),payload,expected=403)
                elif action=='invitation-preview':
                    call(direct,'PreviewRepositoryInvitationRecipient',{**protected_target,'username':owner['name']},expected=400,code='failed_precondition')
                else:
                    payload={**protected_target,'recipientId':owner['id'],'recipientUsername':owner['name'],
                             'recipientRevision':protected_before['revision'],'permission':'read',
                             'expiresAt':datetime.datetime.fromtimestamp(time.time()+3600,datetime.timezone.utc).isoformat().replace('+00:00','Z'),
                             'persistentConsent':True,'idempotencyKey':key()}
                    call(direct,'CreateRepositoryInvitation',payload,expected=400,code='failed_precondition')
                _,protected_after=resolve(orgrepo,direct,owner)
                assert protected_after==protected_before
                assert smoke.provider(owner['token'],'GET',ownership_route)['is_owner'] is True
                assert member(orgrepo,owner,protected_before.get('isDirect',False))==('owner' if protected_before.get('isDirect',False) else None)
                protected_receipts.append({'action':action,'nativeOwner':True,
                    'nativeMutations':proxy.count(orgrepo,owner)-protected_count,
                    'generationBefore':protected_before['generation'],'generationAfter':protected_after['generation']})
            assert call(direct,'ListRepositoryInvitations',{**protected_target,'page':{'page':1,'limit':20}})==protected_invitations
            record(organizationOwnerRefusals=checked_owner_refusals(protected_receipts))
            stage('existing-account invitations explicitly request each role; same-key status/replay sends no duplicate')
            invitation_receipts=[]
            for repository,issuer in ((personal,owner),(orgrepo,owner),(personal,direct),(orgrepo,direct)):
                for permission in ('read','write','admin'):
                    row,created=create(repository,issuer,recipient,permission);count=proxy.count(repository,recipient);result,original=respond(recipient,row);op=operation(result['operation'],original,'SUCCEEDED');assert result['invitation']['state']=='ACCEPTED' and result['invitation']['permission']==permission and proxy.count(repository,recipient)==count+1 and RANK[member(repository,recipient,True)]>=RANK[permission];assert inspect_invitation(recipient,original,'SUCCEEDED')==op and call(recipient,'RespondRepositoryInvitation',original)['operation']==op and proxy.count(repository,recipient)==count+1;invitation_receipts.append({'scope':'organization' if repository is orgrepo else 'personal','issuer':'owner' if issuer is owner else 'member-direct-admin','requestedPermission':permission,'phase':'SUCCEEDED'})
                    p,_=intent(repository,issuer,recipient);mutate(repository,issuer,recipient,p);member(repository,recipient,False)
            record(requestedInvitations=checked_invitation_matrix(invitation_receipts),requestedInvitationCount=12)
            stage('shared retained generation rejects original direct preview and pending invitation after masked add/remove ABA')
            pending,_=create(orgrepo,owner,recipient,'write');old,c=intent(orgrepo,owner,recipient,'read');assert not c.get('isDirect',False) and c['permission']=='owner' and c.get('actualOrganizationOwner') is False;grant_cycle(orgrepo,direct,recipient,('read',));_,now=resolve(orgrepo,owner,recipient);assert now['permission']==c['permission'] and not now.get('isDirect',False) and now['revision']!=c['revision'];count=proxy.count(orgrepo,recipient)
            checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',old,expected=400,code='failed_precondition');assert proxy.count(orgrepo,recipient)==count
            result,original=respond(recipient,pending);operation(result['operation'],original,'REJECTED');assert inspect_invitation(recipient,original,'REJECTED')==result['operation'] and proxy.count(orgrepo,recipient)==count;member(orgrepo,recipient,False)
            stage('role-loss, wrong immutable IDs, owner/self, Origin and bearer boundaries do not mutate')
            p,_=intent(personal,direct,recipient,'read');smoke.provider(owner['token'],'DELETE','repos/'+personal['name']+'/collaborators/'+direct['name'],expected=204);checked_rpc(direct['session'],ACCESS+'SetRepositoryCollaborator',p,expected=404);member(personal,recipient,False);smoke.provider(owner['token'],'PUT','repos/'+personal['name']+'/collaborators/'+direct['name'],{'permission':'admin'},204)
            p,_=intent(personal,owner,recipient,'read');count=proxy.count(personal,recipient)
            for change in ({'repositoryId':'9223372036854775807'},{'ownerId':'9223372036854775807'},{'userId':outsider['id']},{'expectedRevision':'0'*64},{'expectedCollaboratorRevision':'0'*64}):checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',{**p,**change,'idempotencyKey':key()},expected=400,code='failed_precondition')
            for actor in (golfadmin,outsider):checked_rpc(actor['session'],ACCESS+'SetRepositoryCollaborator',{**p,'idempotencyKey':key()},expected=404)
            for actor,locked in ((owner,owner),(direct,direct)):
                t,c=resolve(personal,actor,locked);checked_rpc(actor['session'],ACCESS+'SetRepositoryCollaborator',{**t,'userLogin':locked['name'],'userId':locked['id'],'expectedCollaboratorRevision':c['revision'],'permission':'read','idempotencyKey':key()},expected=403)
            t=target(orgrepo,teamadmin);checked_rpc(teamadmin['session'],ACCESS+'ResolveRepositoryCollaborator',{**t,'userLogin':recipient['name']},expected=403)
            bearer=checked_rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Access48 boundary qualifier'});bearers.append((owner,bearer['credential']['id']))
            inspect_body={k:v for k,v in p.items() if k in {'repository','repositoryId','ownerId','expectedRevision','userId','idempotencyKey'}}
            for method,body in (('SetRepositoryCollaborator',p),('RemoveRepositoryCollaborator',{k:v for k,v in p.items() if k!='permission'}),('GetRepositoryAccessOperation',inspect_body)):
                checked_rpc(owner['session'],ACCESS+method,body,headers={'Origin':'https://other.invalid'},expected=403);checked_rpc(smoke.client(),ACCESS+method,body,headers={'Authorization':'Bearer '+bearer['token']},expected=403)
            checked_rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':bearer['credential']['id']});bearers.clear();assert proxy.count(personal,recipient)==count
            stage('native repository rename/replacement cannot dispatch an original immutable intent')
            r=create_repo(owner,'original');p,_=intent(r,owner,recipient,'read');old_name=r['name'];renamed=smoke.provider(owner['token'],'PATCH','repos/'+old_name,{'name':'renamed'});assert str(renamed['id'])==r['id'];del repositories[old_name];r['name']=renamed['full_name'];r['key']={'owner':renamed['owner']['login'],'name':renamed['name']};repositories[r['name']]=r;replacement=create_repo(owner,'original');assert replacement['id']!=r['id'];checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',p,expected=400,code='failed_precondition');member(r,recipient,False);member(replacement,recipient,False)
            stage('real native204 response loss remains UNKNOWN; original replay/status/restart cannot resend or clear slot')
            uncertain=create_repo(owner,'uncertain');pending,_=create(uncertain,owner,recipient,'read');p,_=intent(uncertain,owner,recipient,'write');proxy.arm('/api/v1/repos/'+uncertain['name']+'/collaborators/'+recipient['name']);op,_=mutate(uncertain,owner,recipient,p,'DISPATCH_UNKNOWN');assert proxy.lost==1 and member(uncertain,recipient,True)=='write';count=proxy.count(uncertain,recipient)
            fresh,_=intent(uncertain,owner,recipient,'admin');checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',fresh,expected=400,code='failed_precondition');respond(recipient,pending,expected=400,code='failed_precondition');assert proxy.count(uncertain,recipient)==count
            observed=checked_rpc(owner['session'],'RepositoryLifecycleService/GetRepositoryLifecycle',{'repository':uncertain['key'],'repositoryId':uncertain['id']})['lifecycle'];assert observed['repositoryId']==uncertain['id'] and observed['ownerId']==uncertain['ownerId'] and observed['blockedReason']=='active_work' and int(observed['activeWorkCount'])>=1 and not observed.get('archiveAvailable',False)
            lifecycle={'repository':uncertain['key'],'repositoryId':uncertain['id'],'ownerId':uncertain['ownerId'],'expectedRevision':observed['revision'],'archived':True,'confirmationName':uncertain['name'],'currentPassword':owner['password'],'idempotencyKey':key()}
            refused=checked_rpc(owner['session'],'RepositoryLifecycleService/ChangeRepositoryArchiveState',lifecycle);assert refused['operation']['phase']=='REJECTED' and refused['operation']['failureCode']=='preflight_refused';assert not smoke.provider(owner['token'],'GET','repos/'+uncertain['name'])['archived']
            command('restart','golf',timeout=90);smoke.ready();assert runtime()==before and inspect_access(owner,p,'DISPATCH_UNKNOWN')==op
            replay=checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',p);assert replay['operation']==op and not replay.get('collaborator') and proxy.count(uncertain,recipient)==count;checked_rpc(owner['session'],ACCESS+'SetRepositoryCollaborator',fresh,expected=400,code='failed_precondition');assert proxy.count(uncertain,recipient)==count
            record(native204ResponseLoss={'observed204':True,'closedBeforeGolfReceipt':True,'phase':'DISPATCH_UNKNOWN','dispatchCount':count,'restartStatusOnly':True,'freshDirectAndInvitationBlocked':True,'archiveBlocked':True,'noResend':True},sharedGenerationABA='qualified')
            if args.ui:
                stage('actual requested-role forms and original successful receipt inspection;12 captures')
                ui_repo=create_repo(owner,'browser');config={'stackRoot':str(ROOT),'golf':smoke.GOLF,'gitea':smoke.GITEA,'repository':ui_repo['name'],'repositoryId':ui_repo['id'],'ownerId':ui_repo['ownerId'],'issuerEmail':owner['email'],'issuerPassword':owner['password'],'recipientId':recipient['id'],'recipientUsername':recipient['name'],'ownerToken':owner['token'],'screenshots':str(common.OUTPUT),'runtime':before};result=subprocess.run(['node',str(Path(__file__).with_name('repository-access-intents-browser.mjs'))],cwd=ROOT,env=environment,input=json.dumps(config).encode(),capture_output=True,timeout=360);assert len(result.stdout)<=65536 and len(result.stderr)<=65536;path=common.OUTPUT/'browser-manifest.json';assert path.is_file(),'Browser safe staged manifest missing';b=json.loads(path.read_text());record(browser=b['status'],captures=b.get('captures',[]),browserFailedStage=b.get('failedStage'));assert result.returncode==0 and b['status']=='browser_checks_passed_parent_native_cleanup_pending' and len(b['captures'])==12 and b['runtime']==before,'Browser predicate failed; safe manifest retained';print(result.stdout.decode().strip(),flush=True)
            assert runtime()==before and verify_proxy_runtime(run,command,proxy,binary,binary_sha,image,source)==proxy_before and checked_proxy_progress(proxy.snapshot(),proxy_baseline,project) and proxy.armed is None;record(nativeChecks='passed',runtimeUnchanged=True,proxyMutationCount=sum(proxy.counts.values()));passed=True
        finally:
            if not passed:
                proxy_state(proxy,'failedProxyState');initial=sys.exc_info()[1];frames=traceback.extract_tb(initial.__traceback__) if initial else [];record(failedStage=common.STAGE,failedProcedure=PROOF.get('lastProcedure'),originalFailureType=type(initial).__name__ if initial else 'Unfinished',originalFailureLine=frames[-1].lineno if frames else None)
            print('CHECK: exact owned fixture cleanup',flush=True);failures=[]
            for actor,identifier in bearers:
                try:checked_rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor.get('loggedIn'):
                    try:checked_rpc(actor['session'],'SessionService/RevokeOtherSessions');checked_rpc(actor['session'],'SessionService/Logout');actor['loggedIn']=False
                    except Exception:failures.append('session')
                if actor.get('created'):
                    try:assert operator('disable',{'username':actor['name']})['disabled']
                    except Exception:failures.append('managed disable')
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args):return None
            cleanup=urllib.request.build_opener(NoRedirect)
            def remove(route,actor,identifier,owner_id=None,role='repository'):
                def request(method):
                    req=urllib.request.Request(smoke.GITEA+'/api/v1/'+route,method=method,headers={'Authorization':'token '+actor['token']})
                    try:response=cleanup.open(req,timeout=15)
                    except urllib.error.HTTPError as e:response=e
                    with response:
                        observations=PROOF.get('cleanupObservations',[]);observations.append({'role':role,'method':method,'status':response.status});record(cleanupObservations=observations);raw=response.read((1<<20)+1);assert len(raw)<=1<<20;return response.status,json.loads(raw) if raw else None
                status,row=request('GET')
                if status==404:return
                assert status==200 and str(row['id'])==identifier
                if owner_id:assert str(row['owner']['id'])==owner_id
                assert request('DELETE')[0]==204 and request('GET')[0]==404
            for r in reversed(list(repositories.values())):
                try:remove('repos/'+r['name'],r['owner'],r['id'],r['ownerId'])
                except Exception:failures.append('native repository')
            for name,org in reversed(list(organizations.items())):
                try:remove('orgs/'+name,org['owner'],str(org['id']),role='organization')
                except Exception:failures.append('native organization')
            for actor in reversed(list(actors.values())):
                if actor.get('created'):
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:failures.append('native purge')
            # Close while the owned network/control port still exists.
            try:
                proxy.close();record(finalProxyState=proxy.snapshot(),proxyCleanup='passed')
            except Exception as error:
                proxy_state(proxy,'cleanupProxyState');record(proxyCleanup='failed',proxyCleanupFailureType=type(error).__name__);failures.append('owned proxy control')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
            except Exception:failures.append('fresh project resources')
            finally:smoke.GOLF,smoke.GITEA=previous;record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed:record(failedStage='owned fixture cleanup')
            assert not failures,'Owned fixture cleanup failed; initial failing predicate remains preserved'
    assert passed;record(status='qualified',browser='qualified' if args.ui else 'not_requested');print('PASS: actual supported-native requested access roles, retained generations, original-operation replay and real native204 response loss; full Access remains Partial')


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__);frame=next((v for v in reversed(frames) if v.filename==__file__),frames[-1]);record(status='failed',failedStage=PROOF.get('failedStage',common.STAGE),failureType=type(error).__name__,failureLine=frame.lineno);print('Access048 qualifier failed at '+PROOF.get('failedStage',common.STAGE)+': '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
