#!/usr/bin/env python3
"""Prepared fresh-stack Docker runner-control qualifier; never touches retained resources.

Requires exact cached core/runner/base images and a root-seeded fresh DinD.
No pulls/builds, native database writes, provider inference or notifications.
Protocol-only lease calls and genuine Docker execution are separately labeled.
--self-check performs only pure receipt/artifact checks, not qualification.
"""
import argparse
import base64
import hashlib
import importlib.util
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

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
DIND = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
SERVICE = 'RunnerControlService/'
PATH = '.github/workflows/slow.yml'
FAST = '.github/workflows/fast.yml'
SLOW_SOURCE = b'''name: Owned runner control qualification
on: workflow_dispatch
jobs:
  proof:
    runs-on: linux
    steps:
      - name: Owned bounded continuation
        run: |
          test "$(id -u)" = 1000
          test -f README.md
          printf 'owned runner started\\n'
          sleep 16
          printf 'owned draining continuation\\n'
          sleep 16
          printf 'owned runner finished\\n'
'''
FAST_SOURCE = b'''on: workflow_dispatch
jobs:
  proof:
    runs-on: linux
    steps:
      - run: printf 'owned resumed runner\\n'
'''
STAGE, OUTPUT = 'arguments', None
PROOF = {'status':'prepared_not_run', 'cleanup':'not_created', 'scope':'Bounded enrolled Docker worker controls; no pools/autoscaling/enrollment/Kubernetes/Cloudflare/hostile-tenant or full Runners readiness.', 'protocolOnly':{}, 'actualDockerWorker':{}}


def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        target = OUTPUT/'manifest.json.tmp'
        target.write_text(json.dumps(PROOF,indent=2,sort_keys=True)+'\n'); target.chmod(0o600); target.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value; record(stage=value); print('CHECK: '+value,flush=True)


def positive(value):
    return isinstance(value,str) and bool(re.fullmatch(r'[1-9][0-9]{0,18}',value)) and int(value)<=9223372036854775807


def inventory(value, expected):
    rows=value.get('runners',[])
    assert len(rows)==len(expected) and {r['workerId'] for r in rows}==set(expected)
    for row in rows:
        assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',row['workerId'])
        assert row['state'] in ('RUNNER_CONTROL_STATE_ACTIVE','RUNNER_CONTROL_STATE_DRAINING','RUNNER_CONTROL_STATE_REVOKED')
        assert re.fullmatch(r'0|[1-9][0-9]{0,18}',row['version']) and int(row['version'])<=9223372036854775807
        assert not row.get('recentConnection') or row.get('lastSeen')
        assert not (row['state']=='RUNNER_CONTROL_STATE_REVOKED' and row.get('hasActiveAttempt'))
        assert not set(row)-{'workerId','state','version','lastSeen','recentConnection','hasActiveAttempt'}
    return rows


def receipt(value, intent):
    row=value['runner']; inventory({'runners':[row]},[intent['workerId']])
    assert row['workerId']==intent['workerId'] and row['state']==intent['state'] and row['version']==str(int(intent['expectedVersion'])+1)
    return row


def safe_manifest(value, forbidden):
    raw=json.dumps(value,indent=2,sort_keys=True)+'\n'
    assert all(not item or item not in raw for item in forbidden), 'Private material entered metadata artifact'
    return raw


def checked_rpc(session, procedure, payload=None, expected=200, code=None, headers=None):
    assert re.fullmatch(r'[A-Za-z]+Service/[A-Za-z]+',procedure)
    req=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure,data=json.dumps(payload or {}).encode(),method='POST',headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
    try: response=session.open(req,timeout=15)
    except urllib.error.HTTPError as error: response=error
    with response:
        raw=response.read((1<<20)+1); assert len(raw)<=1<<20
        result=json.loads(raw) if raw else None
        observed={'procedure':procedure,'status':response.status,'noStore':response.headers.get('Cache-Control')=='no-store'}
        if isinstance(result,dict) and re.fullmatch(r'[a-z_]{1,64}',result.get('code','')): observed['code']=result['code']
        record(lastProcedure=observed)
        assert response.status==expected and observed['noStore'], 'RPC boundary mismatch; fixed metadata recorded'
        if expected!=200:
            expected_code=code or {400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',409:'aborted',429:'resource_exhausted',503:'unavailable'}[expected]
            assert result['code']==expected_code
        return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl): return None


def self_check():
    row={'workerId':'owned','state':'RUNNER_CONTROL_STATE_DRAINING','version':'1'}
    intent={'workerId':'owned','state':row['state'],'expectedVersion':'0'}
    receipt({'runner':row},intent)
    for wrong in ({**row,'version':'0'},{**row,'state':'RUNNER_CONTROL_STATE_ACTIVE'},{**row,'workerId':'different'}):
        try: receipt({'runner':wrong},intent)
        except AssertionError: pass
        else: raise AssertionError('Wrong control receipt accepted')
    for wrong in ('01','-1','9223372036854775808'):
        try: inventory({'runners':[{**row,'version':wrong}]},['owned'])
        except AssertionError: pass
        else: raise AssertionError('Unbounded version accepted')
    assert positive('9223372036854775807') and not positive('9223372036854775808')
    try: safe_manifest({'value':'private'},['private'])
    except AssertionError: pass
    else: raise AssertionError('Private metadata accepted')
    assert b'sleep 16' in SLOW_SOURCE and 'io.golf.runner.attempt' in Path(__file__).read_text()
    print('PASS: pure runner-control receipts and metadata guards; no Docker/native/browser/runtime operations.')


def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true'); parser.add_argument('--image'); parser.add_argument('--runner-image')
    parser.add_argument('--stack-root',type=Path,default=ROOT); parser.add_argument('--output',type=Path)
    parser.add_argument('--ui',action='store_true'); parser.add_argument('--seed-timeout',type=int,default=300)
    args=parser.parse_args()
    if args.self_check: self_check(); return
    if not args.image or not args.runner_image or not args.output: parser.error('--image, --runner-image and --output are required')
    assert 1<=args.seed_timeout<=600
    OUTPUT=args.output.resolve(); OUTPUT.mkdir(mode=0o700,exist_ok=False); OUTPUT.chmod(0o700)
    stack=args.stack_root.resolve(); record(status='running')
    spec=importlib.util.spec_from_file_location('runner_control_helpers',stack/'scripts/observability-smoke.py')
    helpers=importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    def run(*argv,payload=None,timeout=180):
        result=subprocess.run(argv,cwd=stack,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact cached images and fresh-stack reserve')
    core_row=json.loads(run('docker','image','inspect',args.image))[0]; core=core_row['Id']; worker=json.loads(run('docker','image','inspect',args.runner_image))[0]['Id']
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',core) and re.fullmatch(r'sha256:[a-f0-9]{64}',worker)
    for cached in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless',DIND): run('docker','image','inspect',cached)
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core,'-Pk','/')
    assert int(space.splitlines()[-1].split()[3])>=2*1024*1024
    revision=(core_row.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    record(coreImage=core,runnerImage=worker,servedSourceRevision=revision if re.fullmatch(r'[a-f0-9]{40}',revision or '') else None,workingTreeHead=run('git','rev-parse','HEAD'))
    if args.ui: assert (stack/'web/node_modules/playwright/index.mjs').is_file()
    project='golf-runners-'+secrets.token_hex(5); ports=helpers.free_ports(2); previous=smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA=f'http://127.0.0.1:{ports[0]}',f'http://127.0.0.1:{ports[1]}'
    workers=['local-docker','protocol-worker']+(['ui-dark-1440','ui-dark-390','ui-light-1440','ui-light-390'] if args.ui else [])
    keys={name:base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=') for name in workers}
    actors={}; forbidden=list(keys.values()); started=False; original_failure=None; cleanup=[]; passed=False; daemon=None
    with tempfile.TemporaryDirectory(prefix=project+'-') as temp:
        directory=Path(temp);directory.chmod(0o700)
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=keys['local-docker'],GOLF_RUNNER_KEYS=json.dumps(keys),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_PUSH_CI_ENABLED='false')
        forbidden.extend(v for k,v in values.items() if k.endswith(('PASSWORD','ENCRYPTION_KEY')))
        env_file=directory/'core.env'; override=directory/'proof.yaml'
        helpers.private_write(env_file,''.join(k+"='"+v+"'\n" for k,v in values.items()))
        helpers.private_write(override,f'''services:
  golf:
    image: {core}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  runner:
    image: {worker}
    pull_policy: never
  runner-image-init:
    entrypoint: [/bin/true]
    command: []
    pull_policy: never
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(stack/'compose.ci.yaml'),'-f',str(override)]
        def command(*argv,**kw): return run(*compose,*argv,**kw)
        def admin(*argv): return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv)
        def rpc(actor,procedure,payload=None,**kw):return checked_rpc(actor['session'],procedure,payload,**kw)
        def controls(actor):return inventory(rpc(actor,SERVICE+'GetInstanceRunners'),workers)
        def state(actor,worker_id):return next(row for row in controls(actor) if row['workerId']==worker_id)
        def change(actor,worker_id,next_state):
            old=state(actor,worker_id); request={'workerId':worker_id,'expectedVersion':old['version'],'state':'RUNNER_CONTROL_STATE_'+next_state,'currentPassword':actor['password']}
            return receipt(rpc(actor,SERVICE+'UpdateRunnerControl',request),request),request
        def dispatch(path=PATH):
            value=rpc(actors['owner'],'WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':path,'idempotencyKey':str(uuid.uuid4())})['run']
            assert value['repositoryId']==str(native['id']) and value['ownerId']==str(native['owner']['id']) and value['commitId']==head and value['workflowPath']==path and str(uuid.UUID(value['id']))==value['id']
            return value
        def observed(item):return rpc(actors['owner'],'WorkflowRunService/GetWorkflowRun',{'runId':item['id']})['run']
        def wait_state(item,state,timeout=100):
            def check():
                row=observed(item)
                if row['state']!=state:return None
                if state=='WORKFLOW_RUN_STATE_RUNNING' and not any(s.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for s in row.get('progress',{}).get('steps',[])):return None
                return row
            return helpers.until(check,timeout=timeout)
        def machine(method,path,capability='',body=None,expected=204):
            headers={'Authorization':'Bearer '+keys['protocol-worker'],'Golf-Runner-ID':'protocol-worker'}
            if capability:headers['Golf-Attempt-Token']=capability
            req=urllib.request.Request(smoke.GOLF+path,method=method,data=None if body is None else json.dumps(body).encode(),headers=headers)
            try:response=urllib.request.build_opener(NoRedirect).open(req,timeout=15)
            except urllib.error.HTTPError as error:response=error
            with response:
                raw=response.read((17<<20)+1);assert len(raw)<=17<<20 and response.status==expected
                return raw
        def lease(item):
            value=json.loads(machine('POST','/internal/ci/poll',body={},expected=200))
            assert value['runId']==item['id'] and re.fullmatch(r'[a-f0-9]{32}',value['attemptId']) and re.fullmatch(r'[A-Za-z0-9_-]{43}',value['attemptToken'])
            forbidden.append(value['attemptToken']); return value
        def runtime():
            value=json.loads(run('docker','inspect',command('ps','-q','golf')))[0]
            assert value['Image']==core
            return {'image':value['Image'],'composeConfigHash':value['Config']['Labels']['com.docker.compose.config-hash'],'nativeVersion':smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/version')['version']}
        def containers(attempt):
            assert re.fullmatch(r'[a-f0-9]{32}',attempt)
            ids=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true','--filter','label=io.golf.runner.attempt='+attempt).split()
            for identifier in ids:
                assert re.fullmatch(r'[a-f0-9]{12,64}',identifier)
                row=json.loads(command('exec','-T','runner-daemon','docker','inspect',identifier))[0]; labels=row['Config']['Labels']
                assert labels['io.golf.runner.attempt']==attempt and labels['io.golf.runner.worker']=='local-docker' and labels['io.golf.runner.managed']=='true'
            return ids
        def cleared(attempt):
            if containers(attempt):return False
            return not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true','--filter','label=io.golf.runner.attempt='+attempt)
        def lease_metadata(item):
            identifier=str(uuid.UUID(item['id']))
            query="SELECT json_build_object('leaseExpiresAt',extract(epoch from lease_expires_at),'logSequence',log_sequence,'state',state) FROM golf_workflow_runs WHERE id='"+identifier+"'::uuid"
            return json.loads(command('exec','-T','postgres','psql','-U','postgres','-d','golf','-X','-At','-v','ON_ERROR_STOP=1','-c',query))
        try:
            stage('fresh base and dedicated daemon; no runner process yet')
            started=True;record(project=project,cleanup='pending')
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','runner-daemon');smoke.ready()
            command('up','-d','--no-build','--pull','never','runner-image-init')
            baseline=runtime();assert baseline['nativeVersion']=='1.27.3';record(runtimeBefore=baseline)
            daemon=command('ps','-q','runner-daemon');assert re.fullmatch(r'[a-f0-9]{12,64}',daemon)
            helpers.private_write(OUTPUT/'seed-pending.json',json.dumps({'schema':'golf.runner-controls.seed.v1','project':project,'containerId':daemon,'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_timeout,'helperNeverPullsOrBuilds':True},indent=2)+'\n')
            print('PREREQUISITE: root seed fresh owned daemon '+daemon+' with exact pinned Alpine and DinD; helper never pulls/builds.',flush=True)
            def seeded():
                rows=[]
                for image in (IMAGE,DIND):
                    result=subprocess.run([*compose,'exec','-T','runner-daemon','docker','image','inspect',image],cwd=stack,env=environment,capture_output=True,timeout=10)
                    if result.returncode:return None
                    values=json.loads(result.stdout);assert len(values)==1 and values[0]['Os']=='linux' and re.fullmatch(r'sha256:[a-f0-9]{64}',values[0]['Id'])
                    rows.append({'reference':image,'imageId':values[0]['Id']})
                return rows
            seeded_images=helpers.until(seeded,timeout=args.seed_timeout);record(seededImages=seeded_images)
            helpers.private_write(OUTPUT/'seed-ready.json',json.dumps({'schema':'golf.runner-controls.seed.v1','containerId':daemon,'verifiedImages':seeded_images},indent=2)+'\n')
            stage('supported native identities and managed local admin/reader sessions')
            buckets=set();roles=['owner','protocol','worker','reader','nativeadmin']+(['dark1440','dark390','light1440','light390'] if args.ui else [])
            for role in roles:
                for _ in range(256):
                    name='rn-'+role+'-'+secrets.token_hex(4);bucket=int.from_bytes(hashlib.sha256(name.encode()).digest()[:2],'big')%1024+1
                    if bucket not in buckets:buckets.add(bucket);break
                else:raise AssertionError('Distinct owned password buckets exhausted')
                actor={'name':name,'email':name+'@example.invalid','password':secrets.token_urlsafe(32),'session':smoke.client()};actors[role]=actor;forbidden.append(actor['password'])
                native_options=['create','--username',name,'--email',actor['email'],'--random-password','--must-change-password=false']
                if role=='nativeadmin':native_options+=['--admin=true']
                admin(*native_options);actor['nativeCreated']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw');forbidden.append(actor['token'])
                actor['nativeId']=str(smoke.provider(actor['token'],'GET','user')['id'])
                command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role not in ('reader','nativeadmin')});actor['enrolled']=True
                signed=rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert signed.get('isInstanceAdmin',False)==(role not in ('reader','nativeadmin'));actor['loggedIn']=True
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'runner-controls','private':True,'auto_init':True},201)
            repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            for actor in actors.values():
                if actor is not owner:smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actor['name'],{'permission':'read'},204)
            for path,source in ((PATH,SLOW_SOURCE),(FAST,FAST_SOURCE)):smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(source).decode(),'message':'Owned bounded runner-control source'},201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch(r'[a-f0-9]{40}',head)
            selection={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id']),'workflowPath':PATH}
            for scope in ('INSTANCE','REPOSITORY'):
                query={'scope':'EXECUTION_SCOPE_'+scope,**({'repository':repository} if scope=='REPOSITORY' else {})};p=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',query)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{**query,'scopeId':p['scopeId'],'expectedRevision':p.get('revision','0'),'expectedAuthorityRevision':p['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('current scoped metadata, step-up, exact target and browser-only boundaries')
            for role in ('reader','nativeadmin'):
                rpc(actors[role],SERVICE+'GetInstanceRunners',expected=403)
                rpc(actors[role],SERVICE+'UpdateRunnerControl',{'workerId':'protocol-worker','expectedVersion':'0','state':'RUNNER_CONTROL_STATE_DRAINING','currentPassword':actors[role]['password']},expected=403)
            repo_view=rpc(actors['reader'],SERVICE+'GetRepositoryRunners',selection);assert repo_view['repository']==repository and repo_view['repositoryId']==selection['repositoryId'] and repo_view['ownerId']==selection['ownerId'] and repo_view['workflowPath']==PATH and repo_view.get('manualAllowed') is True and not repo_view.get('pushAllowed',False);inventory(repo_view,workers)
            rpc(owner,SERVICE+'GetRepositoryRunners',{**selection,'repositoryId':'9223372036854775807'},expected=503)
            rpc(owner,SERVICE+'GetRepositoryRunners',{**selection,'ownerId':'9223372036854775807'},expected=503)
            credential=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Runner control read refusal','lifetimeSeconds':600});forbidden.append(credential['token'])
            for method in ('GetInstanceRunners','UpdateRunnerControl','GetRepositoryRunners'):
                rpc(owner,SERVICE+method,{},expected=403,headers={'Origin':'https://wrong.golf.invalid'})
                checked_rpc(smoke.client(),SERVICE+method,{},expected=403,headers={'Authorization':'Bearer '+credential['token']})
            rpc(owner,'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']})
            pat=smoke.client();checked_rpc(pat,'SessionService/LoginWithGiteaToken',{'token':owner['token']});checked_rpc(pat,SERVICE+'GetInstanceRunners',expected=403);checked_rpc(pat,SERVICE+'GetRepositoryRunners',selection,expected=403);checked_rpc(pat,'SessionService/Logout')
            pactor=actors['protocol'];old=state(pactor,'protocol-worker');wrong={'workerId':'protocol-worker','expectedVersion':old['version'],'state':'RUNNER_CONTROL_STATE_DRAINING','currentPassword':'wrong owned password'};rpc(pactor,SERVICE+'UpdateRunnerControl',wrong,expected=403)
            stage('protocol-only leased attempt drain/revoke fences; not executed Docker work')
            first=dispatch();leased=lease(first);prefix='/internal/ci/attempt/'+leased['attemptId'];cap=leased['attemptToken']
            change(pactor,'protocol-worker','DRAINING');second=dispatch(FAST)
            archive=machine('GET',prefix+'/source',cap,expected=200);assert hashlib.sha256(archive).hexdigest()==observed(first)['sourceSha256']
            machine('POST',prefix+'/heartbeat',cap,{},204);machine('POST',prefix+'/logs',cap,{'sequence':1,'text':'owned protocol-only frame\n'},204);machine('POST','/internal/ci/poll',body={});assert observed(second)['state']=='WORKFLOW_RUN_STATE_QUEUED'
            machine('POST',prefix+'/finish',cap,{'exitCode':0},204);assert observed(first)['state']=='WORKFLOW_RUN_STATE_SUCCEEDED'
            change(pactor,'protocol-worker','ACTIVE');leased=lease(second);prefix='/internal/ci/attempt/'+leased['attemptId'];cap=leased['attemptToken'];revoked,intent=change(pactor,'protocol-worker','REVOKED')
            assert observed(second)['state']=='WORKFLOW_RUN_STATE_CANCELLED'
            for action,method,body in (('source','GET',None),('heartbeat','POST',{}),('logs','POST',{'sequence':1,'text':'must not accept\n'}),('finish','POST',{'exitCode':0})):
                machine(method,prefix+'/'+action,cap,body,403)
            machine('POST','/internal/ci/poll',body={});rpc(pactor,SERVICE+'UpdateRunnerControl',intent,expected=409,code='aborted')
            rpc(pactor,SERVICE+'UpdateRunnerControl',{**intent,'expectedVersion':revoked['version'],'state':'RUNNER_CONTROL_STATE_ACTIVE'},expected=400)
            command('restart','golf');smoke.ready();assert state(pactor,'protocol-worker')['state']=='RUNNER_CONTROL_STATE_REVOKED';machine('POST','/internal/ci/poll',body={})
            record(protocolOnly={'separateWorker':True,'realServerLease':True,'sourceHashVerified':True,'drainingSourceHeartbeatLogFinishAccepted':True,'queuedBlocked':True,'revokedFourAttemptActionsDenied':True,'terminalAcrossRestart':True,'jobActuallyExecuted':False})
            stage('real Docker slow job drains while continuing heartbeat/log/finish')
            actual=dispatch();waiting=dispatch(FAST);command('up','-d','--no-build','--pull','never','runner',timeout=180)
            running=wait_state(actual,'WORKFLOW_RUN_STATE_RUNNING');attempt=running['attemptId'];assert containers(attempt)
            before=lease_metadata(actual);change(actors['worker'],'local-docker','DRAINING');time.sleep(12);after=lease_metadata(actual)
            assert after['leaseExpiresAt']>before['leaseExpiresAt'] and observed(waiting)['state']=='WORKFLOW_RUN_STATE_QUEUED'
            finished=wait_state(actual,'WORKFLOW_RUN_STATE_SUCCEEDED');assert cleared(attempt)
            text=''.join(row['text'] for row in rpc(owner,'WorkflowRunService/GetWorkflowRunLogs',{'runId':actual['id']}).get('logs',[]));assert 'owned draining continuation' in text and 'owned runner finished' in text
            assert observed(waiting)['state']=='WORKFLOW_RUN_STATE_QUEUED';change(actors['worker'],'local-docker','ACTIVE');resumed=wait_state(waiting,'WORKFLOW_RUN_STATE_SUCCEEDED');assert cleared(resumed['attemptId'])
            stage('real Docker active revocation cancels and independently removes owned resources')
            active=dispatch();running=wait_state(active,'WORKFLOW_RUN_STATE_RUNNING');attempt=running['attemptId'];assert containers(attempt)
            revoked_actual,_=change(actors['worker'],'local-docker','REVOKED');assert observed(active)['state']=='WORKFLOW_RUN_STATE_CANCELLED';helpers.until(lambda:cleared(attempt),timeout=45)
            command('stop','runner');command('restart','golf');smoke.ready();command('up','-d','--no-build','--pull','never','runner',timeout=180)
            queued=dispatch(FAST);time.sleep(12);assert observed(queued)['state']=='WORKFLOW_RUN_STATE_QUEUED' and state(actors['worker'],'local-docker')['state']=='RUNNER_CONTROL_STATE_REVOKED'
            assert not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true')
            assert not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true')
            record(actualDockerWorker={'slowAttemptRanInOwnedDaemon':True,'heartbeatsExtendedWhileDraining':True,'postDrainLogAndSuccessfulFinish':True,'secondQueuedUntilResume':True,'revokeCancelledActive':True,'attemptContainersAndVolumesRemoved':True,'oldConfiguredIdentityBlockedAcrossCoreAndWorkerRestart':True,'runs':[{'runId':r['id'],'attemptId':r.get('attemptId'),'state':r['state']} for r in (finished,resumed,observed(active),observed(queued))]})
            if args.ui:
                stage('twelve actual settings/confirmation captures; exact route and workflow selection')
                browser_dir=OUTPUT/'browser';browser_dir.mkdir(mode=0o700)
                fixtures={key:{'email':actors[key]['email'],'password':actors[key]['password'],'workerId':'ui-'+('dark' if key.startswith('dark') else 'light')+'-'+('1440' if key.endswith('1440') else '390')} for key in ('dark1440','dark390','light1440','light390')}
                run('node',str(Path(__file__).with_name('runner-controls-browser.mjs')),payload={'stackRoot':str(stack),'golf':smoke.GOLF,'screenshots':str(browser_dir),'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id']),'workflowPath':PATH,'workers':workers,'fixtures':fixtures,'runtime':baseline},timeout=300)
                browser_manifest=json.loads((browser_dir/'manifest.json').read_text());assert browser_manifest['passed'] and browser_manifest['complete'] and len(browser_manifest['captures'])==12
                record(browser={'passed':True,'captures':12,'manifestSha256':hashlib.sha256((browser_dir/'manifest.json').read_bytes()).hexdigest()})
            # Remove current native access; same managed account cannot retain repository facts.
            smoke.provider(owner['token'],'DELETE',base+'/collaborators/'+actors['reader']['name'],expected=204);rpc(actors['reader'],SERVICE+'GetRepositoryRunners',selection,expected=404)
            assert runtime()==baseline;record(runtimeAfter=runtime());passed=True
        except Exception as error:
            original_failure=error;frame=traceback.extract_tb(error.__traceback__)[-1];record(originalFailure={'type':type(error).__name__,'stage':STAGE,'line':frame.lineno})
        finally:
            # Stop the actual consumer first; check cleanup separately from cancellation.
            if started:
                try:command('stop','-t','35','runner');helpers.until(lambda:not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true') and not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true'),timeout=45)
                except Exception:cleanup.append('owned-attempt-cleanup')
            for actor in actors.values():
                if actor.get('loggedIn'):
                    try:rpc(actor,'SessionService/RevokeOtherSessions');rpc(actor,'SessionService/Logout')
                    except Exception:cleanup.append('managed-session')
                if actor.get('enrolled'):
                    try:command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                    except Exception:cleanup.append('managed-account')
            for role,actor in reversed(list(actors.items())):
                if actor.get('nativeCreated'):
                    try:
                        if role=='nativeadmin':
                            cleanup_token=admin('generate-access-token','--username',actor['name'],'--token-name',project+'-cleanup','--scopes','write:admin','--raw');forbidden.append(cleanup_token)
                            value=smoke.provider(cleanup_token,'PATCH','admin/users/'+actor['name'],{'active':False});assert str(value['id'])==actor['nativeId'] and value['active'] is False
                        admin('delete','--username',actor['name'],'--purge')
                    except Exception:cleanup.append('native-actor')
            if started:
                try:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not run('docker',*argv,'--filter','label=com.docker.compose.project='+project)
                except Exception:cleanup.append('fresh-compose-resources')
            smoke.GOLF,smoke.GITEA=previous;record(status='passed' if passed and not cleanup else 'failed',complete=passed and not cleanup,cleanup='failed' if cleanup else 'passed',cleanupFailures=cleanup)
            (OUTPUT/'manifest.json').write_text(safe_manifest(PROOF,forbidden));(OUTPUT/'manifest.json').chmod(0o600)
        if original_failure is not None:raise original_failure
        assert passed and not cleanup
    print('PASS: actual bounded runner controls, separately labeled protocol and Docker execution, served UI if requested, owned cleanup; full Runners remains Partial.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__);frame=next((f for f in reversed(frames) if f.filename==__file__),frames[-1])
        try:record(status='failed',failureType=type(error).__name__,failedStage=PROOF.get('originalFailure',{}).get('stage',STAGE),failureLine=frame.lineno)
        except Exception:pass
        print('Runner qualifier failed at '+STAGE+': '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
