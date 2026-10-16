#!/usr/bin/env python3
"""Prepared disposable archive lifecycle native qualification (not proof until run).

--image selects an already-built local Golf image for a fresh base Compose stack.
No retained stack, CI overlay, runner, inference, provider credentials or policy
changes are used. Native/API actors and managed Golf accounts are disposable;
all project resources are removed on exit. --output must be a new owner-only
evidence directory; --ui adds 12 real browser captures. --self-check performs
no operations. This qualifies the bounded Golf-only archive gate, not transfer, deletion,
external ingress fencing, crash repair or full Danger readiness.
"""
import argparse
import base64
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
import traceback

sys.dont_write_bytecode = True
import smoke
import uuid
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryLifecycleService/'
STAGE = 'arguments'
OUTPUT = None
NATIVE_SOURCES = ['https://codeberg.org/forgejo/forgejo/raw/tag/v15.0.9/'+path for path in ('routers/api/v1/repo/repo.go', 'services/convert/repository.go', 'models/repo/repo_unit.go', 'modules/structs/repo.go')]
PROOF = {'status':'not_started', 'nativeSources':NATIVE_SOURCES, 'scope':'Bounded archive/unarchive and Golf-only admission gate; no transfer/deletion, external Git/native scheduling atomic fence, stranded-operation repair, recovery or full Danger readiness', 'nativeAckFaultInjection':'not_qualified_by_this_helper', 'cleanup':'not_started', 'captures':[]}


def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        temporary = OUTPUT/'manifest.json.tmp'
        with temporary.open('w', encoding='utf-8') as stream:
            temporary.chmod(0o600)
            json.dump(PROOF, stream, indent=2, sort_keys=True); stream.write('\n')
        temporary.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value
    record(stage=value)
    print('CHECK: '+value, flush=True)


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
        if response.headers.get('Golf-Lifecycle-Effect')=='none':metadata['effect']='none'
        result=None
        if len(raw)<=1<<20:
            try:result=json.loads(raw) if raw else None
            except (ValueError,UnicodeError):pass
        if isinstance(result,dict) and isinstance(result.get('code'),str) and re.fullmatch(r'[a-z_]{1,64}',result['code']):metadata['code']=result['code']
        observations=PROOF.get('procedureObservations',[])
        assert len(observations)<256
        observations.append(metadata);record(lastProcedure=metadata,procedureObservations=observations)
        assert len(raw)<=1<<20 and response.status==expected and metadata['noStore'],'RPC status/protocol mismatch; safe procedure metadata recorded'
        if expected!=200:
            codes={400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',429:'resource_exhausted',503:'unavailable'}
            assert isinstance(result,dict) and result.get('code')==(code or codes[expected]) and result.get('message'),'RPC error code mismatch; safe procedure metadata recorded'
        return result


def native_shape(row):
    assert type(row['id']) is int and row['id'] > 0 and type(row['owner']['id']) is int and row['owner']['id'] > 0
    for key in ('archived','mirror','has_actions','has_issues','has_wiki','has_pull_requests'):
        assert type(row[key]) is bool, 'Required native flag missing or unknown'
    assert isinstance(row['topics'], list) and isinstance(row['website'], str) and isinstance(row['description'], str)
    return row


def preservation(row):
    native_shape(row)
    return {key:row.get(key) for key in ('id','full_name','owner','description','website','default_branch','topics','private','mirror','has_actions','has_issues','has_wiki','has_pull_requests','internal_tracker','external_tracker','external_wiki') if key != 'owner'} | {'ownerId':row['owner']['id']}


def lifecycle_receipt(value, native, managed):
    native_shape(native)
    assert value['repository'] == {'owner':native['owner']['login'],'name':native['name']}
    assert value['repositoryId'] == str(native['id']) and value['ownerId'] == str(native['owner']['id'])
    assert re.fullmatch(r'[a-f0-9]{64}', value['revision'])
    assert value.get('archived',False) is native['archived'] and value.get('mirror',False) is native['mirror']
    assert value.get('canManage',False) is managed and value.get('stepUpAvailable',False)
    if managed:
        assert value['activeWorkCount'] == '0' and not value.get('unresolved',False)
        if native['has_actions']:
            assert value['blockedReason']=='native_actions_unqualified' and not value.get('archiveAvailable',False) and not value.get('unarchiveAvailable',False)
        else:
            assert not value.get('blockedReason','')
            assert value.get('archiveAvailable',False) is (not native['archived']) and value.get('unarchiveAvailable',False) is native['archived']
    else:
        assert value['blockedReason']=='owner_required' and not value.get('activeWorkCount','')
        assert not value.get('archiveAvailable',False) and not value.get('unarchiveAvailable',False)
    return value


def operation_receipt(operation, intent, actor, phase):
    for wire in ('repository','repositoryId','ownerId','expectedRevision','idempotencyKey'):
        assert operation[wire] == intent[wire]
    assert operation['actorId'] == actor['id'] and operation.get('fromArchived',False) is (not intent['archived'])
    assert operation.get('toArchived',False) is intent['archived'] and operation['phase'] == phase
    assert operation.get('failureCode','') == ('preflight_refused' if phase=='REJECTED' else '')
    for field in ('createdAt','updatedAt'):
        assert isinstance(operation[field], str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+Z',operation[field])
    return operation


def self_check():
    import uuid
    source=(ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('GetRepositoryLifecycle','ChangeRepositoryArchiveState','GetRepositoryLifecycleOperation'):
        assert 'rpc '+method+'(' in source
    for message, fields in {'GetRepositoryLifecycleRequest':[('string','repository_id',2)], 'ChangeRepositoryArchiveStateRequest':[('optional bool','archived',5),('string','current_password',7),('string','idempotency_key',8)], 'RepositoryLifecycleOperation':[('string','actor_id',5),('string','phase',9)]}.items():
        body=re.search(r'message '+message+r'\s*\{([^}]+)\}',source).group(1)
        for kind,name,tag in fields:assert re.search(re.escape(kind)+r'\s+'+name+r'\s*=\s*'+str(tag)+r'\s*;',body)
    native={'id':7,'owner':{'id':9,'login':'owner'},'name':'repo','archived':False,'mirror':False,'has_actions':False,'has_issues':True,'has_wiki':True,'has_pull_requests':True,'topics':[],'website':'','description':''}
    valid={'repository':{'owner':'owner','name':'repo'},'repositoryId':'7','ownerId':'9','revision':'a'*64,'canManage':True,'stepUpAvailable':True,'activeWorkCount':'0','archiveAvailable':True}
    lifecycle_receipt(valid,native,True)
    for mutate in (lambda r:r.pop('has_actions'),lambda r:r.update(has_actions=None),lambda r:r.update(has_actions=0)):
        broken=json.loads(json.dumps(native));mutate(broken)
        try:native_shape(broken)
        except (AssertionError,KeyError,TypeError):pass
        else:raise AssertionError('Unknown native Actions flag accepted')
    intent={'repository':valid['repository'],'repositoryId':'7','ownerId':'9','expectedRevision':'a'*64,'idempotencyKey':str(uuid.uuid4()),'archived':True}
    op={**{key:intent[key] for key in ('repository','repositoryId','ownerId','expectedRevision','idempotencyKey')},'actorId':'11','toArchived':True,'phase':'SUCCEEDED','createdAt':'2026-10-04T12:00:00Z','updatedAt':'2026-10-04T12:00:01Z'}
    operation_receipt(op,intent,{'id':'11'},'SUCCEEDED')
    for field,bad in [('repositoryId','8'),('actorId','12'),('expectedRevision','b'*64),('phase','DISPATCH_UNKNOWN'),('toArchived',False)]:
        broken={**op,field:bad}
        try:operation_receipt(broken,intent,{'id':'11'},'SUCCEEDED')
        except AssertionError:pass
        else:raise AssertionError('Wrong lifecycle receipt accepted')
    # Keep real password step-up attempts below the unchanged ten-attempt account window.
    assert 1+1+1+1+1+2 < 10  # owner login, wrong password, stale refusal, archive/unarchive, org round trip
    assert 1+4+2 < 10  # each UI owner: login, two round trips, optional lost-browser-ack round trip
    assert len('golf-lifecycle-'+'a'*10+'-nativeadmin')<=40
    global OUTPUT,PROOF
    prior=OUTPUT,PROOF
    try:
        with tempfile.TemporaryDirectory(prefix='golf-lifecycle-pure-') as temporary:
            OUTPUT=Path(temporary);OUTPUT.chmod(0o700);PROOF={};record(status='failed',failedStage='first predicate',failedProcedure={'procedure':'RepositoryLifecycleService/GetRepositoryLifecycle','status':404,'code':'not_found'},cleanup='passed')
            row=json.loads((OUTPUT/'manifest.json').read_text());assert row['failedStage']=='first predicate' and row['failedProcedure']['code']=='not_found'
            assert OUTPUT.stat().st_mode&0o777==0o700 and (OUTPUT/'manifest.json').stat().st_mode&0o777==0o600
    finally:OUTPUT,PROOF=prior
    print('PASS: pure lifecycle wire, flag-presence, receipt counterexample and owner-only evidence checks; no Docker/HTTP/native/runtime operations executed')


def main():
    global OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--image', help='Explicit already-built Golf image; resolved once, never built/pulled')
    parser.add_argument('--output', type=Path, help='New evidence directory, created mode 0700; safe manifests/captures only')
    parser.add_argument('--ui', action='store_true', help='Include actual browser confirmation/archive/inspection/reload proof and 12 captures')
    args = parser.parse_args()
    if args.self_check:
        self_check(); return
    if not args.image or not args.output:
        parser.error('--image and --output are required for a fresh isolated qualification')
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700); args.output.chmod(0o700); OUTPUT = args.output.resolve(strict=True)
    record(status='running', browser='pending' if args.ui else 'not_requested')
    if args.ui:
        stage('local browser dependency, no installation')
        assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    spec = importlib.util.spec_from_file_location('lifecycle_helpers', ROOT/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_', 'FORGEJO_', 'POSTGRES_', 'COMPOSE_', 'OTEL_', 'AWS_', 'RUSTFS_')) and key != 'DATABASE_URL'}
    def run(*arguments, payload=None, timeout=180):
        result = subprocess.run(arguments, cwd=ROOT, env=environment, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact local image and pinned base dependencies')
    inspected = json.loads(run('docker', 'image', 'inspect', args.image))[0]
    image, revision = inspected['Id'], inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image) and re.fullmatch(r'[0-9a-f]{40}', revision or ''), 'Require explicitly revision-labeled product image'
    # Fail before creating anything rather than pulling or consuming retained disk.
    for name in ('postgres:18.4-alpine3.24', 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'):
        run('docker', 'image', 'inspect', name)
    space = run('docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/df', image, '-Pk', '/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB free Docker VM space before fresh stack'
    project = 'golf-lifecycle-'+secrets.token_hex(5)
    ports = helpers.free_ports(2); previous = smoke.GOLF, smoke.FORGE
    smoke.GOLF, smoke.FORGE = 'http://127.0.0.1:'+str(ports[0]), 'http://127.0.0.1:'+str(ports[1])
    actors, enrolled, bearers, repositories, organizations, started, passed = {}, [], [], {}, {}, False, False
    record(project=project, selectedImage=image, sourceRevision=revision, cleanup='not_created')
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {key:secrets.token_hex(24) for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'FORGEJO_DB_PASSWORD')} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF, GOLF_PUSH_CI_ENABLED='false')
        env_file, override = directory/'core.env', directory/'proof.yaml'
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file), '-f', str(ROOT/'compose.yaml'), '-f', str(override)]
        def command(*arguments, **kwargs): return run(*compose, *arguments, **kwargs)
        def admin(*arguments): return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *arguments)  # Forgejo's upstream path
        def operator(action, payload):
            result = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
            assert result['state'] == 'complete'; return result['result']
        def runtime():
            container = command('ps', '-q', 'golf'); assert re.fullmatch(r'[0-9a-f]{12,64}', container)
            observed = json.loads(run('docker', 'inspect', '--format', '{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}', container))
            assert observed['image'] == image and observed['reference'] == image and observed['revision'] == revision
            observed['nativeVersion'] = smoke.request(smoke.client(), 'GET', smoke.FORGE+'/api/v1/version')['version']; assert observed['nativeVersion'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            return observed
        def call(actor, method, payload, **kwargs): return checked_rpc(actor['session'], SERVICE+method, payload, **kwargs)
        def metadata(query):
            value=command('exec','-T','postgres','psql','-U','postgres','-d','golf','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',query)
            assert re.fullmatch(r'(0|[1-9][0-9]*)',value);return int(value)
        try:
            stage('fresh base stack, CI and agents unconfigured')
            record(cleanup='pending'); started = True; command('up', '-d', '--no-build', '--pull', 'never', timeout=180); smoke.ready(); before_runtime = runtime()
            record(runtime=before_runtime)
            print('Runtime provenance: '+json.dumps(before_runtime, sort_keys=True), flush=True)
            import uuid
            stage('disposable native roles and managed password sessions')
            account_buckets=set()
            for role in ('owner','reader','directadmin','outsider','golfadmin','nativeadmin') + (('uidark','uilight') if args.ui else ()):
                for _ in range(256):
                    name=project+'-'+role+'-'+secrets.token_hex(1)
                    bucket=int.from_bytes(hashlib.sha256(name.encode()).digest()[:2],'big')%1024+1
                    if bucket not in account_buckets:account_buckets.add(bucket);break
                else:raise RuntimeError('No distinct owned password-rate bucket available')
                actor={'name':name,'created':False,'session':smoke.client(),'loggedIn':False};actors[role]=actor
                options=['create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false']
                if role=='nativeadmin':options+=['--admin=true']
                admin(*options);actor['created']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:organization,write:repository,write:issue','--raw')
                user=smoke.provider(actor['token'],'GET','user');assert type(user['is_admin']) is bool and user['is_admin'] is (role=='nativeadmin')
                actor.update(id=str(user['id']),email=name+'@golf.invalid',password='Lifecycle fixture '+secrets.token_urlsafe(24));enrolled.append(actor)
                operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='golfadmin'})
                signed=checked_rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user']
                assert signed['id']==actor['id'] and signed.get('isInstanceAdmin',False) is (role=='golfadmin');actor['loggedIn']=True
            owner,reader,directadmin,outsider,golfadmin,nativeadmin=(actors[role] for role in ('owner','reader','directadmin','outsider','golfadmin','nativeadmin'))
            native=smoke.provider(owner['token'],'POST','user/repos',{'name':'lifecycle','private':True,'auto_init':True},201)
            repositories[native['full_name']]=(native['id'],native['owner']['id']);smoke.wait_for_push(owner['token'],native['full_name'])
            repository={'owner':owner['name'],'name':'lifecycle'};path='repos/'+native['full_name'];repo_id=str(native['id'])
            for actor,permission in ((reader,'read'),(directadmin,'admin'),(golfadmin,'read')):
                smoke.provider(owner['token'],'PUT',path+'/collaborators/'+actor['name'],{'permission':permission},204)
            def native_read():return native_shape(smoke.provider(owner['token'],'GET',path))
            def read(actor=owner,managed=True):
                value=call(actor,'GetRepositoryLifecycle',{'repository':repository,'repositoryId':repo_id})['lifecycle'];return lifecycle_receipt(value,native_read(),managed)
            def target(value,archived):return {'repository':value['repository'],'repositoryId':value['repositoryId'],'ownerId':value['ownerId'],'expectedRevision':value['revision'],'archived':archived,'confirmationName':value['repository']['owner']+'/'+value['repository']['name'],'currentPassword':owner['password'],'idempotencyKey':str(uuid.uuid4())}
            def inspect(intent,actor=owner):
                payload={key:intent[key] for key in ('repository','repositoryId','ownerId','idempotencyKey')}
                return call(actor,'GetRepositoryLifecycleOperation',payload)['operation']
            def count_source(identifier=repo_id):return metadata('SELECT count(*) FROM golf_repository_activity WHERE repository_id='+identifier+" AND topic='source' AND recipient_user_id=0")
            def change(intent,phase='SUCCEEDED'):
                before=native_read();result=call(owner,'ChangeRepositoryArchiveState',intent);operation_receipt(result['operation'],intent,owner,phase)
                assert inspect(intent)==result['operation'];after=native_read();assert preservation(before)==preservation(after)
                assert after['archived'] is (intent['archived'] if phase=='SUCCEEDED' else before['archived'])
                if phase=='SUCCEEDED':lifecycle_receipt(result['lifecycle'],after,True)
                else:assert 'lifecycle' not in result
                return result
            stage('default native has_actions false is required, not inferred from instance configuration')
            initial=read();assert native_read()['has_actions'] is False and initial['archiveAvailable']
            head=smoke.provider(owner['token'],'GET',path+'/branches/'+native_read()['default_branch'])['commit']['id'];assert re.fullmatch(r'[a-f0-9]{40}',head)
            source_request={'repository':repository,'repositoryId':repo_id,'ref':head,'path':'README.md'}
            source=checked_rpc(owner['session'],'RepositoryService/GetContents',source_request);assert source['repositoryId']==repo_id and source['commitId']==head and source['path']=='README.md'
            stage('personal owner required; direct admin, native/site admin and Golf admin do not bypass')
            for actor in (reader,directadmin,golfadmin,nativeadmin):
                observation=read(actor,False);payload=target(observation,True);payload['currentPassword']=actor['password']
                call(actor,'ChangeRepositoryArchiveState',payload,expected=403)
            assert smoke.provider(directadmin['token'],'GET',path)['permissions']['admin'] is True
            call(outsider,'GetRepositoryLifecycle',{'repository':repository,'repositoryId':repo_id},expected=404)
            call(owner,'GetRepositoryLifecycle',{'repository':repository,'repositoryId':'9223372036854775807'},expected=400,code='failed_precondition')
            before_activity=count_source();before_records=metadata('SELECT count(*) FROM golf_repository_lifecycle_operations WHERE repository_id='+repo_id)
            stage('wrong identity/confirmation/password refuses before reservation')
            valid=target(initial,True)
            for field in ('repositoryId','ownerId'):
                call(owner,'ChangeRepositoryArchiveState',{**valid,field:'9223372036854775807'},expected=400,code='failed_precondition')
            call(owner,'ChangeRepositoryArchiveState',{**valid,'confirmationName':'wrong/name'},expected=400)
            call(owner,'ChangeRepositoryArchiveState',{**valid,'currentPassword':'incorrect fixture password'},expected=403)
            assert PROOF['lastProcedure'].get('effect')=='none'
            assert metadata('SELECT count(*) FROM golf_repository_lifecycle_operations WHERE repository_id='+repo_id)==before_records and count_source()==before_activity
            stage('stale external metadata produces durable refusal and status-only replay')
            smoke.provider(owner['token'],'PATCH',path,{'description':'External revision change'})
            refusal=change(valid,'REJECTED');assert count_source()==before_activity
            assert call(owner,'ChangeRepositoryArchiveState',{**valid,'currentPassword':''})['operation']==refusal['operation']
            assert inspect(valid)==refusal['operation'] and count_source()==before_activity
            current=read();assert current['revision']!=initial['revision'];archive=target(current,True)
            stage('archive supported PATCH plus independent GET and exact durable receipt')
            archived=change(archive);assert count_source()==before_activity+1 and read()['archived']
            assert call(owner,'ChangeRepositoryArchiveState',{**archive,'currentPassword':''})['operation']==archived['operation'];assert count_source()==before_activity+1
            call(owner,'ChangeRepositoryArchiveState',{**archive,'archived':False},expected=400,code='failed_precondition')
            for actor in (reader,directadmin,golfadmin,nativeadmin):call(actor,'GetRepositoryLifecycleOperation',{key:archive[key] for key in ('repository','repositoryId','ownerId','idempotencyKey')},expected=403)
            stage('archive preserves exact source reads and refuses managed issue admission without a native effect')
            assert checked_rpc(owner['session'],'RepositoryService/GetContents',source_request)==source
            settings=checked_rpc(owner['session'],'RepositorySettingsService/GetRepositorySettings',{'repository':repository,'repositoryId':repo_id})['settings']
            checked_rpc(owner['session'],'RepositorySettingsService/UpdateRepositorySettings',{'repository':repository,'repositoryId':repo_id,'ownerId':settings['ownerId'],'expectedRevision':settings['revision'],'description':'Must not edit archive'},expected=403)
            issue_count=len(smoke.provider(owner['token'],'GET',path+'/issues?state=all&limit=100'))
            blocked_key=str(uuid.uuid4());mutations=metadata('SELECT count(*) FROM golf_issue_mutations WHERE repository_id='+repo_id)
            checked_rpc(owner['session'],'RepositoryService/CreateIssue',{'repository':repository,'repositoryId':repo_id,'title':'Must not admit archived work','body':'Fixture only','idempotencyKey':blocked_key},expected=503)
            assert len(smoke.provider(owner['token'],'GET',path+'/issues?state=all&limit=100'))==issue_count and metadata('SELECT count(*) FROM golf_issue_mutations WHERE repository_id='+repo_id)==mutations
            assert metadata('SELECT CASE WHEN golf_repository_lifecycle_blocked(forge_url,repository_id) THEN 1 ELSE 0 END FROM golf_repository_lifecycle_operations WHERE repository_id='+repo_id+' ORDER BY id DESC LIMIT 1')==1
            assert read()['activeWorkCount']=='0';record(archivedIssueAdmission={'status':503,'code':'unavailable','nativeIssueDelta':0,'acceptedMutationDelta':0},sourceReadPreserved=True)
            stage('unarchive uses a separate intent and independently clears the Golf latch')
            unarchive=target(read(),False);unarchived=change(unarchive);assert count_source()==before_activity+2 and not native_read()['archived']
            assert call(owner,'ChangeRepositoryArchiveState',{**unarchive,'currentPassword':''})['operation']==unarchived['operation']
            assert metadata('SELECT CASE WHEN golf_repository_lifecycle_blocked(forge_url,repository_id) THEN 1 ELSE 0 END FROM golf_repository_lifecycle_operations WHERE repository_id='+repo_id+' ORDER BY id DESC LIMIT 1')==0
            assert checked_rpc(owner['session'],'RepositoryService/GetContents',source_request)==source
            stage('organization owner is independent of a repository admin team')
            organization=project+'-org';org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},201);organizations[organization]=org['id']
            org_repo=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos',{'name':'lifecycle','private':True,'auto_init':True},201);repositories[org_repo['full_name']]=(org_repo['id'],org_repo['owner']['id']);smoke.wait_for_push(owner['token'],org_repo['full_name'])
            team=smoke.provider(owner['token'],'POST','orgs/'+organization+'/teams',{'name':'Administrators','permission':'admin','visibility':'limited','units_map':{'repo.code':'admin','repo.issues':'admin'},'includes_all_repositories':False},201)
            smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+directadmin['name'],expected=204)
            smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+org_repo['full_name'],expected=204)
            org_key={'owner':organization,'name':'lifecycle'};org_id=str(org_repo['id'])
            org_native=native_shape(smoke.provider(owner['token'],'GET','repos/'+org_repo['full_name']));assert org_native['has_actions'] is False
            org_owner=call(owner,'GetRepositoryLifecycle',{'repository':org_key,'repositoryId':org_id})['lifecycle'];lifecycle_receipt(org_owner,org_native,True)
            org_admin=call(directadmin,'GetRepositoryLifecycle',{'repository':org_key,'repositoryId':org_id})['lifecycle'];lifecycle_receipt(org_admin,org_native,False)
            assert smoke.provider(directadmin['token'],'GET','repos/'+org_repo['full_name'])['permissions']['admin'] is True
            denied=target(org_admin,True);denied['currentPassword']=directadmin['password'];call(directadmin,'ChangeRepositoryArchiveState',denied,expected=403)
            org_before=count_source(org_id)
            for decision in (True,False):
                snapshot=call(owner,'GetRepositoryLifecycle',{'repository':org_key,'repositoryId':org_id})['lifecycle'];intent=target(snapshot,decision)
                result=call(owner,'ChangeRepositoryArchiveState',intent);operation_receipt(result['operation'],intent,owner,'SUCCEEDED')
                org_after=native_shape(smoke.provider(owner['token'],'GET','repos/'+org_repo['full_name']));lifecycle_receipt(result['lifecycle'],org_after,True);assert org_after['archived'] is decision
                assert inspect(intent)==result['operation']
            assert count_source(org_id)==org_before+2;record(ownerScopeMatrix='passed',organizationOwnerArchiveRoundTrip='passed')
            if args.ui:
                stage('actual requested archive dialog/history/reload and status-only lost browser acknowledgement')
                browser_fixtures={}
                for theme in ('dark','light'):
                    ui_actor=actors['ui'+theme]
                    ui_repo=smoke.provider(ui_actor['token'],'POST','user/repos',{'name':'lifecycle-ui','private':True,'auto_init':True},201);repositories[ui_repo['full_name']]=(ui_repo['id'],ui_repo['owner']['id']);smoke.wait_for_push(ui_actor['token'],ui_repo['full_name'])
                    assert native_shape(smoke.provider(ui_actor['token'],'GET','repos/'+ui_repo['full_name']))['has_actions'] is False
                    browser_fixtures[theme]={'repository':ui_repo['full_name'],'repositoryId':str(ui_repo['id']),'ownerId':str(ui_repo['owner']['id']),'actorId':ui_actor['id'],'email':ui_actor['email'],'password':ui_actor['password'],'ownerToken':ui_actor['token']}
                browser_config={'stackRoot':str(ROOT),'golf':smoke.GOLF,'forge':smoke.FORGE,'fixtures':browser_fixtures,'screenshots':str(OUTPUT),'runtime':before_runtime}
                browser_before=sum(count_source(row['repositoryId']) for row in browser_fixtures.values())
                result=subprocess.run(['node',str(ROOT/'scripts/repository-lifecycle-browser.mjs')],cwd=ROOT,env=environment,input=json.dumps(browser_config).encode(),capture_output=True,timeout=360)
                assert len(result.stdout)<=65536 and len(result.stderr)<=65536
                record(browserProcessReturnCode=result.returncode,browserManifestWritten=(OUTPUT/'browser-manifest.json').is_file())
                proof=json.loads((OUTPUT/'browser-manifest.json').read_text());record(browser=proof['status'],captures=proof['captures'],browserProcedureStatusCounts=proof.get('procedureStatusCounts',{}),browserRequestCounts=proof.get('requestCounts',{}),browserFailedStage=proof.get('failedStage'))
                assert result.returncode==0 and proof['status']=='browser_checks_passed_parent_native_cleanup_pending' and len(proof['captures'])==12 and proof['runtime']==before_runtime,'Browser proof failed; safe staged manifest available'
                assert proof['requestCounts']['ChangeRepositoryArchiveState']==10 and sum(count_source(row['repositoryId']) for row in browser_fixtures.values())==browser_before+10
                for row in browser_fixtures.values():assert native_shape(smoke.provider(row['ownerToken'],'GET','repos/'+row['repository']))['archived'] is False
                print(result.stdout.decode().strip(),flush=True)
                record(lostBrowserAcknowledgement='accepted response withheld from browser; status inspection/reload made no repeat mutation; native PATCH lost acknowledgement remains separately unqualified',browserFixtureScope='Two disposable personal owners, one per theme; unchanged local-login/step-up limiter retained')
            stage('Origin/bearer/current session boundaries do not grant operation access')
            credential=checked_rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Lifecycle qualifier'});bearers.append((owner,credential['credential']['id']))
            current=read();payload=target(current,True)
            requests=[('GetRepositoryLifecycle',{'repository':repository,'repositoryId':repo_id}),('ChangeRepositoryArchiveState',payload),('GetRepositoryLifecycleOperation',{key:unarchive[key] for key in ('repository','repositoryId','ownerId','idempotencyKey')})]
            for method,body in requests:
                call(owner,method,body,headers={'Origin':'https://other.invalid'},expected=403)
                checked_rpc(smoke.client(),SERVICE+method,body,headers={'Authorization':'Bearer '+credential['token']},expected=403)
            checked_rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']});bearers.clear()
            checked_rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False
            for method,body in requests:call(owner,method,body,expected=401)
            assert not native_read()['archived'] and runtime()==before_runtime
            record(nativeChecks='passed',runtimeUnchanged=True);passed=True
        except Exception as original:
            frames=traceback.extract_tb(original.__traceback__)
            record(originalFailureType=type(original).__name__,originalFailureLine=frames[-1].lineno,originalFailureStage=STAGE)
            raise
        finally:
            if not passed:record(failedStage=STAGE,failedProcedure=PROOF.get('lastProcedure'))
            print('CHECK: owned fixture cleanup',flush=True);failures=[]
            for actor,identifier in bearers:
                try:checked_rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try:checked_rpc(actor['session'],'SessionService/RevokeOtherSessions');checked_rpc(actor['session'],'SessionService/Logout')
                    except Exception:failures.append('session')
            for actor in reversed(enrolled):
                try:assert operator('disable',{'username':actor['name']})['disabled']
                except Exception:failures.append('managed disable')
            import urllib.request,urllib.error
            class NoCleanupRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,request,fp,code,msg,headers,newurl):return None
            cleanup_client=urllib.request.build_opener(NoCleanupRedirect)
            def remove(route,role,identifier,owner_identifier=None):
                def request(method):
                    req=urllib.request.Request(smoke.FORGE+'/api/v1/'+route,method=method,headers={'Authorization':'token '+cleanup_token})
                    try:response=cleanup_client.open(req,timeout=15)
                    except urllib.error.HTTPError as error:response=error
                    with response:
                        observed=PROOF.get('cleanupObservations',[]);observed.append({'role':role,'method':method,'status':response.status});record(cleanupObservations=observed)
                        raw=response.read((1<<20)+1);assert len(raw)<=1<<20;return response.status,json.loads(raw) if raw else None
                status,row=request('GET')
                if status==404:return
                assert status==200 and row['id']==identifier
                if owner_identifier is not None:assert row['owner']['id']==owner_identifier
                assert request('DELETE')[0]==204 and request('GET')[0]==404
            for name,(identifier,owner_identifier) in reversed(list(repositories.items())):
                cleanup_token=next((actor['token'] for actor in actors.values() if actor['id']==str(owner_identifier)),owner['token'])
                try:remove('repos/'+name,'repository',identifier,owner_identifier)
                except Exception:failures.append('native repository')
            for name,identifier in reversed(list(organizations.items())):
                cleanup_token=owner['token']
                try:remove('orgs/'+name,'organization',identifier)
                except Exception:failures.append('native organization')
            for actor in reversed(list(actors.values())):
                if actor['created']:
                    try:
                        if actor is actors.get('nativeadmin'):
                            # Supported native cleanup: an active last site
                            # administrator cannot be purged. Disable only this
                            # owned actor through its scoped admin API first.
                            cleanup_admin=admin('generate-access-token','--username',actor['name'],'--token-name',project+'-cleanup','--scopes','write:admin','--raw')
                            row=smoke.provider(cleanup_admin,'PATCH','admin/users/'+actor['name'],{'active':False})
                            assert str(row['id'])==actor['id'] and row['login']==actor['name'] and row['active'] is False
                        admin('delete','--username',actor['name'],'--purge')
                    except Exception:failures.append('native purge')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
            except Exception:failures.append('fresh project resources')
            finally:smoke.GOLF,smoke.FORGE=previous;record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed:record(failedStage='owned fixture cleanup')
            assert not failures,'Owned fixture cleanup incomplete (fresh project removed)'
            print('Cleanup: exact owned repositories/orgs deleted, native actors purged, managed sessions/bearers revoked/accounts disabled, fresh project resources removed.',flush=True)
    assert passed;record(status='qualified',browser='qualified' if args.ui else 'not_requested')
    print('PASS: bounded native archive/unarchive, owner/step-up/identity boundaries, durable inspect/replay, source preservation and Golf-only admission fences on unchanged fresh runtime; full Danger remains Partial')


if __name__=='__main__':
    try:main()
    except Exception as failure:
        frames=traceback.extract_tb(failure.__traceback__);frame=next((item for item in reversed(frames) if item.filename==__file__),frames[-1])
        try:record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureType=type(failure).__name__,failureLine=frame.lineno)
        except Exception:pass
        print('Lifecycle qualifier failed at '+PROOF.get('failedStage',STAGE)+': '+type(failure).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
