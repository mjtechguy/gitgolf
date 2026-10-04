#!/usr/bin/env python3
"""Prepared fresh-stack Docker runner-pool qualifier; never touches retained resources.

Requires exact cached core/runner/base images and a root-seeded fresh DinD.
No pulls/builds, native database writes, provider inference or notifications.
Both independent worker identities must execute actual jobs in the fresh daemon;
no protocol-only lease is called proof of Docker execution.
--self-check performs only pure receipt/artifact checks, not qualification.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
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
import threading
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
CONTROL = 'RunnerControlService/'
SERVICE = 'RunnerPoolService/'
WORKERS = ['worker-a','worker-b']
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
RECORD_LOCK = threading.Lock()
PROOF = {'status':'prepared_not_run', 'cleanup':'not_created', 'scope':'Actual local-Docker pool placement and capacity, not enrollment/autoscaling/Kubernetes/Cloudflare/hostile-tenant or full Runners readiness.', 'actualDockerWorkers':{}}


def record(**values):
    with RECORD_LOCK:
        PROOF.update(values)
        if OUTPUT is not None:
            target = OUTPUT/'manifest.json.tmp'
            target.write_text(json.dumps(PROOF,indent=2,sort_keys=True)+'\n'); target.chmod(0o600); target.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value; record(stage=value); print('CHECK: '+value,flush=True)


# Diagnostics expose only a closed operation vocabulary and numeric observations.
# Never persist argv, stdout/stderr, exception messages, env, inspect config or logs.
SERVICES = {'postgres','gitea','golf','runner-daemon','runner-image-init','runner','runner-second'}
COMPOSE_ACTIONS = {'up','exec','ps','stop','restart','down'}
PROCESS_LIMIT = 8 << 20
# Presence flags only, not extracted words: output and private values never escape.
DIAGNOSTIC_WORDS = frozenset(('image','reference','invalid','format','build','built','pull','policy','space','device','mount','namespace','network','container','conflict','creating','resource','permission','denied','manifest','platform','architecture','context','dockerfile','service','dependency','failed','missing','unavailable','daemon','command','specified','duplicate','shared','name','tag','digest','sha256','healthy','unhealthy','complete','exit','timeout','resolve','create','start','running','recreate','recreated','compose','read','only'))


def semantic_words(raw):
    observed = raw[:1 << 20].lower()
    return sorted(word for word in DIAGNOSTIC_WORDS if re.search(rb'(?<![a-z0-9_])'+word.encode()+rb'(?![a-z0-9_])',observed))


class PrivateSubprocessFailure(AssertionError):
    def __init__(self, observation):
        super().__init__('Private subprocess failed; bounded metadata recorded')
        self.observation = observation


def operation_category(argv):
    category = {'operation':'other'}
    if len(argv) >= 2 and argv[0:2] == ('docker','compose'):
        # Skip values of global Compose flags, including private env/override paths.
        index = 2
        while index < len(argv):
            if argv[index] in ('-p','--env-file','-f'): index += 2; continue
            break
        action = argv[index] if index < len(argv) else ''
        category['operation'] = 'compose_' + action if action in COMPOSE_ACTIONS else 'compose_other'
        if action in COMPOSE_ACTIONS:
            category['services'] = sorted(set(argv[index+1:]) & SERVICES)
    elif argv[:3] == ('docker','image','inspect'): category['operation'] = 'docker_image_inspect'
    elif argv[:2] == ('docker','inspect'): category['operation'] = 'docker_container_inspect'
    elif argv[:2] == ('docker','run'): category['operation'] = 'docker_reserve_check'
    elif argv[:2] == ('docker','ps'): category['operation'] = 'docker_project_containers'
    elif argv[:3] == ('docker','volume','ls'): category['operation'] = 'docker_project_volumes'
    elif argv[:3] == ('docker','network','ls'): category['operation'] = 'docker_project_networks'
    elif argv[:3] == ('git','rev-parse','HEAD'): category['operation'] = 'git_working_revision'
    elif len(argv) == 2 and argv[0] == 'node' and Path(argv[1]).name == 'runner-pools-browser.mjs': category['operation'] = 'pool_browser'
    return category


def process_reason(stdout, stderr, timed_out=False):
    if timed_out: return 'process_timeout'
    if len(stdout) > PROCESS_LIMIT or len(stderr) > PROCESS_LIMIT: return 'process_output_bound'
    text = stdout[:1 << 20].lower() + b'\n' + stderr[:1 << 20].lower()
    # Classifications are hints, never evidence that a specific service was healthy.
    for code, fragments in (
        ('compose_invalid_reference',(b'invalid reference format',b'invalid image reference',b'invalid reference:',b'repository name must be lowercase')),
        ('compose_shared_image_plan',(b'used by multiple services',b'multiple services use the same image',b'cannot be used with image',b'must be built')),
        ('compose_build_plan_failed',(b'failed to solve',b'failed to read dockerfile',b'unable to prepare context',b'build context')),
        ('compose_pull_refused',(b'pull access denied',b'requested access to the resource is denied',b'pull policy is set to never')),
        ('compose_no_disk_space',(b'no space left on device',)),
        ('compose_platform_mismatch',(b'no matching manifest',b'exec format error',)),
        ('compose_name_conflict',(b'container name',b'already in use by container')),
        ('compose_dependency_failed',(b'dependency failed to start',b'didn\'t complete successfully',b'did not complete successfully')),
        ('compose_service_unhealthy',(b'is unhealthy',b'container is unhealthy')),
        ('compose_network_namespace_missing',(b'cannot join network',b'network namespace',b'no such container')),
        ('compose_no_command',(b'no command specified',b'no command has been specified')),
        ('compose_missing_image',(b'no such image',b'image not found')),
        ('compose_port_unavailable',(b'port is already allocated',b'address already in use')),
        ('compose_invalid_config',(b'validating ',b'unsupported config option',b'invalid compose project')),
        ('compose_mount_failure',(b'error while mounting',b'invalid mount config')),
        ('daemon_unavailable',(b'cannot connect to the docker daemon',b'error during connect')),
        ('compose_service_start_failed',(b'failed to create task',b'failed to start container',b'oci runtime create failed')),
    ):
        if any(fragment in text for fragment in fragments): return code
    return 'unclassified_subprocess_failure'


def safe_callsites(frames):
    # Unknown/helper paths can themselves carry private material: include only this file.
    return [{'file':'runner-pools-smoke.py','line':f.lineno} for f in frames if Path(f.filename).name == 'runner-pools-smoke.py'][-8:]


def process_observation(argv, return_code, stdout=b'', stderr=b'', timed_out=False):
    return {**operation_category(tuple(argv)), 'returnCode':return_code,
            'stdoutBytes':len(stdout or b''), 'stderrBytes':len(stderr or b''),
            'reason':process_reason(stdout or b'',stderr or b'',timed_out),
            'semanticWords':{'stdout':semantic_words(stdout or b''),'stderr':semantic_words(stderr or b'')},
            'callSites':safe_callsites(traceback.extract_stack()[:-1])}


def safe_service_states(raw):
    assert len(raw) <= 1 << 20
    text = raw.decode()
    try: rows = json.loads(text)
    except json.JSONDecodeError: rows = [json.loads(line) for line in text.splitlines() if line]
    if isinstance(rows,dict): rows = [rows]
    assert isinstance(rows,list) and len(rows) <= 32
    observed = []
    for row in rows:
        assert isinstance(row,dict)
        service = row.get('Service')
        if service not in SERVICES: continue
        state = row.get('State')
        health = row.get('Health','')
        exit_code = row.get('ExitCode')
        value = {'service':service,'state':state if state in {'created','restarting','running','removing','paused','exited','dead'} else 'unreported'}
        value['health'] = health if health in {'','healthy','unhealthy','starting'} else 'unreported'
        if isinstance(exit_code,int) and not isinstance(exit_code,bool) and 0 <= exit_code <= 255: value['exitCode'] = exit_code
        observed.append(value)
    return sorted(observed,key=lambda row:row['service'])


def original_failure_metadata(error, procedure):
    frames = traceback.extract_tb(error.__traceback__)
    observation = {'type':type(error).__name__,'stage':STAGE,'line':frames[-1].lineno,'callSites':safe_callsites(frames)}
    if isinstance(error,PrivateSubprocessFailure): observation['subprocess'] = error.observation
    # Caller already restricted these fields to fixed RPC names/statuses/no-store.
    if procedure is not None: observation['lastProcedure'] = dict(procedure)
    return observation


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
        if response.status!=expected or not observed['noStore']:
            record(boundaryFailure={**observed,'expectedStatus':expected})
            raise AssertionError('RPC boundary mismatch; fixed metadata recorded')
        if expected!=200:
            expected_code=code or {400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',409:'aborted',429:'resource_exhausted',503:'unavailable'}[expected]
            assert result['code']==expected_code
        return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl): return None


def validate_pool(row):
    assert str(uuid.UUID(row['id']))==row['id'] and uuid.UUID(row['id']).version==4 and positive(row['version'])
    assert row['runtime']=='local-docker' and row['state'] in ('RUNNER_POOL_STATE_ACTIVE','RUNNER_POOL_STATE_DRAINING')
    assert 1<=row['maxParallelAttempts']<=100 and len(row.get('workerIds',[]))<=100 and len(set(row.get('workerIds',[])))==len(row.get('workerIds',[]))
    assert all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',w) for w in row.get('workerIds',[]))
    if 'activeAttemptCount' in row:assert re.fullmatch(r'0|[1-9][0-9]{0,18}',row['activeAttemptCount']) and int(row['activeAttemptCount'])<=9223372036854775807
    assert not set(row)-{'id','name','version','runtime','state','maxParallelAttempts','workerIds','repositoryAssignmentEnabled','createdAt','updatedAt','activeAttemptCount'}

def validate_placement(row,target):
    assert row['repository']==target['repository'] and row['repositoryId']==target['repositoryId'] and row['ownerId']==target['ownerId'] and row['accessRevision']==target['expectedRevision']
    assert re.fullmatch(r'0|[1-9][0-9]{0,18}',row['version']) and int(row['version'])<=9223372036854775807
    if row.get('legacyUnbound'):assert not row.get('poolId') and not row.get('poolVersion')
    else:assert str(uuid.UUID(row['poolId']))==row['poolId'] and positive(row['poolVersion'])

def self_check():
    pool={'id':'12345678-1234-4234-8234-123456789001','name':'Owned pool','version':'1','runtime':'local-docker','state':'RUNNER_POOL_STATE_ACTIVE','maxParallelAttempts':1,'workerIds':WORKERS,'repositoryAssignmentEnabled':True,'activeAttemptCount':'0'}
    validate_pool(pool)
    for wrong in ({**pool,'version':'01'},{**pool,'activeAttemptCount':'9223372036854775808'},{**pool,'maxParallelAttempts':0},{**pool,'workerIds':['worker-a','worker-a']},{**pool,'runtime':'unqualified'}):
        try:validate_pool(wrong)
        except AssertionError:pass
        else:raise AssertionError('Malformed pool receipt accepted')
    target={'repository':{'owner':'owner','name':'repo'},'repositoryId':'17','ownerId':'9','expectedRevision':'a'*64};row={**target,'accessRevision':target['expectedRevision'],'version':'1','poolId':pool['id'],'poolVersion':'1'};row.pop('expectedRevision');validate_placement(row,target)
    try:validate_placement({**row,'repositoryId':'18'},target)
    except AssertionError:pass
    else:raise AssertionError('Wrong immutable placement accepted')
    try:safe_manifest({'value':'private'},['private'])
    except AssertionError:pass
    else:raise AssertionError('Private metadata accepted')
    private = 'owned-private-password-and-token'
    argv = ('docker','compose','-p',private,'--env-file','/'+private,'-f','/'+private,'up','-d','--no-build','--pull','never','runner','runner-second')
    observed = process_observation(argv,1,private.encode(),('dependency failed to start: '+private).encode())
    assert observed['operation']=='compose_up' and observed['services']==['runner','runner-second']
    assert observed['returnCode']==1 and observed['stdoutBytes']==len(private) and observed['reason']=='compose_dependency_failed'
    safe_manifest(observed,[private])
    assert process_reason(b'',('unrecognized '+private).encode())=='unclassified_subprocess_failure'
    assert process_reason(b'',b'no command specified')=='compose_no_command'
    assert process_reason(b'',b'no such image')=='compose_missing_image'
    assert process_reason(b'',b'OCI runtime create failed')=='compose_service_start_failed'
    assert process_reason(b'Invalid reference format: private',b'')=='compose_invalid_reference'
    assert process_reason(b'',b'Failed to read Dockerfile: private')=='compose_build_plan_failed'
    assert process_reason(b'',b'No space left on device')=='compose_no_disk_space'
    assert process_reason(b'',b'no matching manifest for private')=='compose_platform_mismatch'
    assert semantic_words((private+' IMAGE reference invalid format unknown-sensitive-output').encode())==['format','image','invalid','reference']
    assert semantic_words(b'invalidity permission_secret networked containerize')==[]
    assert semantic_words(b'x'*(1 << 20)+b' image')==[]
    assert observed['semanticWords']=={'stdout':[],'stderr':['dependency','failed','start']}
    flagged=process_observation(argv,1,(private+' image').encode(),('invalid reference format '+private+' private-extra-token').encode())
    assert flagged['semanticWords']=={'stdout':['image'],'stderr':['format','invalid','reference']}
    safe_manifest(flagged,[private,'private-extra-token','unknown-sensitive-output'])
    assert process_reason(b'',b'',True)=='process_timeout'
    assert process_reason(b'x'*(PROCESS_LIMIT+1),b'')=='process_output_bound'
    assert operation_category(('docker','compose','-p',private,'exec','-T','golf','golf','local-account','create',private))=={'operation':'compose_exec','services':['golf']}
    assert operation_category(('node','/'+private+'/runner-pools-browser.mjs'))=={'operation':'pool_browser'}
    assert operation_category(('unknown',private))=={'operation':'other'}
    states=safe_service_states(json.dumps([
        {'Service':'runner','State':'exited','Health':'','ExitCode':2,'Name':private,'Command':private,'Labels':{private:private}},
        {'Service':'runner-second','State':private,'Health':private,'ExitCode':True},
        {'Service':private,'State':'running','ExitCode':0},
    ]).encode())
    assert states==[{'service':'runner','state':'exited','health':'','exitCode':2},{'service':'runner-second','state':'unreported','health':'unreported'}]
    safe_manifest(states,[private])
    assert safe_service_states(b'{"Service":"runner","State":"running"}\n{"Service":"golf","State":"running"}\n')[0]['service']=='golf'
    calls=safe_callsites([traceback.FrameSummary('/'+private+'/runner-pools-smoke.py',123,'private'),traceback.FrameSummary('/'+private+'/unknown.py',456,'private')])
    assert calls==[{'file':'runner-pools-smoke.py','line':123}];safe_manifest(calls,[private])
    procedure={'procedure':'WorkflowRunService/DispatchWorkflow','status':200,'noStore':True}
    try: raise PrivateSubprocessFailure(observed)
    except PrivateSubprocessFailure as error:
        original=original_failure_metadata(error,procedure)
    # Later teardown observations must not alias or overwrite the saved original RPC.
    procedure['procedure']='SessionService/Logout'
    assert original['lastProcedure']['procedure']=='WorkflowRunService/DispatchWorkflow' and original['subprocess']==observed
    assert procedure['procedure']!=original['lastProcedure']['procedure'];safe_manifest(original,[private])
    proto=(ROOT/'api/golf/v1/golf.proto').read_text();assert 'service RunnerPoolService' in proto and 'RUNNER_POOL_STATE_DRAINING = 2;' in proto and 'WorkflowRunnerPlacement runner_placement = 31;' in proto
    text=Path(__file__).read_text();assert 'runner-second' in text and 'io.golf.runner.attempt' in text and '--pull=never' in text and b'sleep 16' in SLOW_SOURCE
    overlay_source=text.rsplit("helpers.private_write(override,f'''services:",1)[1].split("''')",1)[0]
    assert re.search(r'  runner:\n(?:    #.*\n)?    build: !reset null\n    image: \{worker\}\n    pull_policy: never',overlay_source) and overlay_source.count('build: !reset null')==1
    print('PASS: pure pool/placement receipts and private subprocess diagnostic guards; actual Docker/native/browser qualification unrun.')


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
        try:
            result=subprocess.run(argv,cwd=stack,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise PrivateSubprocessFailure(process_observation(argv,None,error.stdout,error.stderr,True)) from None
        except OSError as error:
            observation=process_observation(argv,None);observation['reason']='process_launch_failed'
            if isinstance(error.errno,int): observation['errno']=error.errno
            raise PrivateSubprocessFailure(observation) from None
        if result.returncode!=0 or len(result.stdout)>PROCESS_LIMIT or len(result.stderr)>PROCESS_LIMIT:
            raise PrivateSubprocessFailure(process_observation(argv,result.returncode,result.stdout,result.stderr))
        return result.stdout.decode().strip()
    stage('exact cached images and fresh-stack reserve')
    core_row=json.loads(run('docker','image','inspect',args.image))[0]; core=core_row['Id']; worker=json.loads(run('docker','image','inspect',args.runner_image))[0]['Id']
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',core) and re.fullmatch(r'sha256:[a-f0-9]{64}',worker)
    for cached in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless',DIND): run('docker','image','inspect',cached)
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core,'-Pk','/')
    assert int(space.splitlines()[-1].split()[3])>=2*1024*1024
    revision=(core_row.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    record(fixtureConfiguration={'runnerBuildReset':True,'buildResetFailureHypothesis':'unconfirmed'},coreImage=core,runnerImage=worker,servedSourceRevision=revision if re.fullmatch(r'[a-f0-9]{40}',revision or '') else None,workingTreeHead=run('git','rev-parse','HEAD'))
    if args.ui: assert (stack/'web/node_modules/playwright/index.mjs').is_file()
    project='golf-pools-'+secrets.token_hex(5); ports=helpers.free_ports(2); previous=smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA=f'http://127.0.0.1:{ports[0]}',f'http://127.0.0.1:{ports[1]}'
    workers=WORKERS[:]
    keys={name:base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=') for name in workers}
    actors={}; forbidden=list(keys.values()); started=False; original_failure=None; cleanup=[]; passed=False; daemon=None
    with tempfile.TemporaryDirectory(prefix=project+'-') as temp:
        directory=Path(temp);directory.chmod(0o700)
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=keys['worker-a'],GOLF_RUNNER_KEYS=json.dumps(keys),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_PUSH_CI_ENABLED='false')
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
    # Cached-image-only fixture: inherited production build plan is not used.
    build: !reset null
    image: {worker}
    pull_policy: never
    environment:
      GOLF_RUNNER_ID: worker-a
      GOLF_RUNNER_KEY: {keys['worker-a']}
  runner-second:
    image: {worker}
    pull_policy: never
    network_mode: service:golf
    environment:
      GOLF_RUNNER_URL: http://127.0.0.1:8080
      GOLF_RUNNER_ID: worker-b
      GOLF_RUNNER_KEY: {keys['worker-b']}
      GOLF_RUNNER_APPROVED_IMAGES: '{json.dumps([IMAGE])}'
      DOCKER_HOST: tcp://runner-daemon:2376
      DOCKER_TLS_VERIFY: '1'
      DOCKER_CERT_PATH: /certs/client
    volumes: [runner-client-certs:/certs/client:ro]
    read_only: true
    tmpfs: [/tmp:size=33554432,mode=1777]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    depends_on:
      golf:
        condition: service_started
      runner-image-init:
        condition: service_completed_successfully
  runner-image-init:
    entrypoint: [/bin/true]
    command: []
    pull_policy: never
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(stack/'compose.ci.yaml'),'-f',str(override)]
        def command(*argv,**kw):
            try: return run(*compose,*argv,**kw)
            except PrivateSubprocessFailure as error:
                if argv and argv[0]=='up':
                    # Diagnostic read is bounded and cannot replace the original failure.
                    try:
                        result=subprocess.run([*compose,'ps','-a','--format','json'],cwd=stack,env=environment,capture_output=True,timeout=10)
                        if result.returncode==0: error.observation['serviceStates']=safe_service_states(result.stdout)
                        else: error.observation['serviceStateInspection']='failed'
                    except Exception: error.observation['serviceStateInspection']='unavailable'
                raise
        def admin(*argv): return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv)
        def rpc(actor,procedure,payload=None,**kw):return checked_rpc(actor['session'],procedure,payload,**kw)
        def controls(actor):return inventory(rpc(actor,CONTROL+'GetInstanceRunners'),workers)
        def state(actor,worker_id):return next(row for row in controls(actor) if row['workerId']==worker_id)
        def change(actor,worker_id,next_state):
            old=state(actor,worker_id); request={'workerId':worker_id,'expectedVersion':old['version'],'state':'RUNNER_CONTROL_STATE_'+next_state,'currentPassword':actor['password']}
            return receipt(rpc(actor,CONTROL+'UpdateRunnerControl',request),request),request
        def dispatch(path=PATH, repo=None, source=None, operation=None, **kw):
            value=rpc(actors['owner'],'WorkflowRunService/DispatchWorkflow',{'repository':repo or repository,'ref':source or head,'workflowPath':path,'idempotencyKey':operation or str(uuid.uuid4())},**kw)
            if kw.get('expected',200)!=200:return value
            row=value['run']; assert positive(row['repositoryId']) and positive(row['ownerId']) and row['commitId']==(source or head) and row['workflowPath']==path and str(uuid.UUID(row['id']))==row['id']
            assert row['runnerPlacement'];return row
        def observed(item):return rpc(actors['owner'],'WorkflowRunService/GetWorkflowRun',{'runId':item['id']})['run']
        def wait_state(item,wanted,timeout=100):
            def check():
                row=observed(item)
                if row['state']!=wanted:return None
                if wanted=='WORKFLOW_RUN_STATE_RUNNING' and not any(s.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for s in row.get('progress',{}).get('steps',[])):return None
                return row
            return helpers.until(check,timeout=timeout)
        def pools(actor= None):
            body=rpc(actor or actors['owner'],SERVICE+'ListRunnerPools');assert sorted(body['enrolledWorkerIds'])==sorted(workers)
            rows=body.get('pools',[]);assert len(rows)<=20 and len({row['id'] for row in rows})==len(rows)
            for row in rows:validate_pool(row)
            return rows
        def save_pool(old=None, **overrides):
            intent={'id':old['id'] if old else str(uuid.uuid4()),'expectedVersion':old['version'] if old else '0','name':old['name'] if old else 'Owned capacity-one pool','runtime':'local-docker','state':old['state'] if old else 'RUNNER_POOL_STATE_ACTIVE','maxParallelAttempts':1,'workerIds':workers[:],'repositoryAssignmentEnabled':True,'currentPassword':actors['owner']['password'],**overrides}
            row=rpc(actors['owner'],SERVICE+'SaveRunnerPool',intent)['pool'];validate_pool(row)
            assert row['id']==intent['id'] and row['version']==str(int(intent['expectedVersion'])+1) and all(row.get(field,False)==intent[field] for field in ('name','runtime','state','maxParallelAttempts','workerIds','repositoryAssignmentEnabled'))
            return row,intent
        def access(actor,repo):return rpc(actor,'RepositoryAccessService/GetRepositoryAccess',{'repository':repo})['access']
        def placement(actor,repo):
            a=access(actor,repo);target={'repository':repo,'repositoryId':a['repositoryId'],'ownerId':a['ownerId'],'expectedRevision':a['revision']}
            body=rpc(actor,SERVICE+'GetRepositoryRunnerPlacement',target);validate_placement(body['placement'],target);return body,target
        def place(pool_value=None, repo=None):
            repo=repo or repository;before,target=placement(actors['owner'],repo)
            intent={**target,'expectedPlacementVersion':before['placement']['version'],'poolId':pool_value['id'] if pool_value else '', 'expectedPoolVersion':pool_value['version'] if pool_value else '', 'currentPassword':actors['owner']['password']}
            row=rpc(actors['owner'],SERVICE+'SetRepositoryRunnerPlacement',intent)['placement'];validate_placement(row,target)
            assert row['version']==str(int(intent['expectedPlacementVersion'])+1) and row.get('poolId','')==intent['poolId'] and row.get('poolVersion','')==intent['expectedPoolVersion'] and row.get('legacyUnbound',False)==(pool_value is None)
            return row,intent
        def assert_binding(row,pool_value,placed):
            binding=row['runnerPlacement'];assert binding=={'poolId':pool_value['id'],'poolVersion':pool_value['version'],'placementVersion':placed['version']}
        def cancel(item):
            current=observed(item);rpc(actors['owner'],'WorkflowRunService/CancelWorkflowRun',{'runId':current['id'],'expectedVersion':current['version']})
        def runtime():
            value=json.loads(run('docker','inspect',command('ps','-q','golf')))[0]
            assert value['Image']==core
            return {'image':value['Image'],'composeConfigHash':value['Config']['Labels']['com.docker.compose.config-hash'],'nativeVersion':smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/version')['version']}
        def containers(attempt, expected_worker=None):
            assert re.fullmatch(r'[a-f0-9]{32}',attempt)
            ids=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true','--filter','label=io.golf.runner.attempt='+attempt).split()
            for identifier in ids:
                assert re.fullmatch(r'[a-f0-9]{12,64}',identifier)
                row=json.loads(command('exec','-T','runner-daemon','docker','inspect',identifier))[0]; labels=row['Config']['Labels']
                assert labels['io.golf.runner.attempt']==attempt and labels['io.golf.runner.worker'] in workers and labels['io.golf.runner.managed']=='true'
                if expected_worker:assert labels['io.golf.runner.worker']==expected_worker
                assert row['Image']==next(image['imageId'] for image in seeded_images if image['reference']==IMAGE) and row['HostConfig']['NetworkMode']=='none' and row['Config']['User']=='1000:1000'
                assert all(not secret or all(secret not in value for value in row['Config'].get('Env',[])) for secret in forbidden)
            return ids
        def cleared(attempt):
            if containers(attempt):return False
            return not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true','--filter','label=io.golf.runner.attempt='+attempt)
        try:
            stage('fresh base and dedicated daemon; no runner process yet')
            started=True;record(project=project,cleanup='pending')
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','runner-daemon');smoke.ready()
            command('up','-d','--no-build','--pull','never','runner-image-init')
            baseline=runtime();assert baseline['nativeVersion']=='1.27.3';record(runtimeBefore=baseline)
            daemon=command('ps','-q','runner-daemon');assert re.fullmatch(r'[a-f0-9]{12,64}',daemon)
            helpers.private_write(OUTPUT/'seed-pending.json',json.dumps({'schema':'golf.runner-pools.seed.v1','project':project,'containerId':daemon,'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_timeout,'helperNeverPullsOrBuilds':True},indent=2)+'\n')
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
            helpers.private_write(OUTPUT/'seed-ready.json',json.dumps({'schema':'golf.runner-pools.seed.v1','containerId':daemon,'verifiedImages':seeded_images},indent=2)+'\n')
            stage('supported native identities and managed local admin/reader sessions')
            buckets=set();roles=['owner','reader','nativeadmin']+(['dark1440','dark390','light1440','light390'] if args.ui else [])
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
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'runner-pools','private':True,'auto_init':True},201)
            repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            for actor in actors.values():
                if actor is not owner:smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actor['name'],{'permission':'admin' if actor['email'] in [actors[k]['email'] for k in ('dark1440','dark390','light1440','light390') if k in actors] else 'read'},204)
            for path,source in ((PATH,SLOW_SOURCE),(FAST,FAST_SOURCE)):smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(source).decode(),'message':'Owned bounded runner-control source'},201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch(r'[a-f0-9]{40}',head)
            selection={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id']),'workflowPath':PATH}
            for scope in ('INSTANCE','REPOSITORY'):
                query={'scope':'EXECUTION_SCOPE_'+scope,**({'repository':repository} if scope=='REPOSITORY' else {})};p=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',query)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{**query,'scopeId':p['scopeId'],'expectedRevision':p.get('revision','0'),'expectedAuthorityRevision':p['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('capacity pool, exact placement and browser-only role/Origin/password/CAS boundaries')
            pool,pool_intent=save_pool();placed,placement_intent=place(pool)
            for role in ('reader','nativeadmin'):
                rpc(actors[role],SERVICE+'ListRunnerPools',expected=403)
                rpc(actors[role],SERVICE+'SaveRunnerPool',{**pool_intent,'expectedVersion':pool['version'],'currentPassword':actors[role]['password']},expected=403)
                rpc(actors[role],SERVICE+'GetRepositoryRunnerPlacement',{k:v for k,v in placement_intent.items() if k in ('repository','repositoryId','ownerId','expectedRevision')},expected=403)
                rpc(actors[role],SERVICE+'SetRepositoryRunnerPlacement',{**placement_intent,'expectedPlacementVersion':placed['version'],'currentPassword':actors[role]['password']},expected=403)
            rpc(owner,SERVICE+'SaveRunnerPool',pool_intent,expected=409,code='aborted')
            rpc(owner,SERVICE+'SetRepositoryRunnerPlacement',placement_intent,expected=409,code='aborted')
            rpc(owner,SERVICE+'SaveRunnerPool',{**pool_intent,'expectedVersion':pool['version'],'currentPassword':'wrong owned password'},expected=403)
            rpc(owner,SERVICE+'SetRepositoryRunnerPlacement',{**placement_intent,'expectedPlacementVersion':placed['version'],'currentPassword':'wrong owned password'},expected=403)
            credential=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Runner pools read refusal','lifetimeSeconds':600});forbidden.append(credential['token'])
            for method in ('ListRunnerPools','SaveRunnerPool','GetRepositoryRunnerPlacement','SetRepositoryRunnerPlacement'):
                rpc(owner,SERVICE+method,{},expected=403,headers={'Origin':'https://wrong.golf.invalid'})
                checked_rpc(smoke.client(),SERVICE+method,{},expected=403,headers={'Authorization':'Bearer '+credential['token']})
            rpc(owner,'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']})
            logout_session=smoke.client();checked_rpc(logout_session,'SessionService/LoginWithPassword',{'username':owner['email'],'password':owner['password']});checked_rpc(logout_session,'SessionService/Logout')
            for method in ('ListRunnerPools','SaveRunnerPool','GetRepositoryRunnerPlacement','SetRepositoryRunnerPlacement'):checked_rpc(logout_session,SERVICE+method,{},expected=401)
            stage('two actual enrolled Docker workers race capacity-one dispatch')
            operations=[str(uuid.uuid4()),str(uuid.uuid4())]
            with ThreadPoolExecutor(max_workers=2) as parallel:batch=list(parallel.map(lambda operation:dispatch(operation=operation),operations))
            assert batch[0]['id']!=batch[1]['id']
            for item in batch:assert_binding(item,pool,placed)
            command('up','-d','--no-build','--pull','never','runner','runner-second',timeout=180)
            def first_started():
                for item in batch:
                    value=observed(item)
                    if value['state']=='WORKFLOW_RUN_STATE_RUNNING' and any(step.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for step in value.get('progress',{}).get('steps',[])):return value
                return None
            running=helpers.until(first_started,timeout=100);first=next(item for item in batch if item['id']==running['id']);second=next(item for item in batch if item['id']!=running['id']);first_key=operations[batch.index(first)]
            assert running['runnerId'] in workers and containers(running['attemptId'],running['runnerId'])
            claiming=running['runnerId'];other=next(w for w in workers if w!=claiming)
            change(owner,claiming,'DRAINING')
            samples=[]
            for _ in range(5):
                current=observed(first);pending=observed(second);current_pool=pools()[0]
                assert current['state']=='WORKFLOW_RUN_STATE_RUNNING' and pending['state']=='WORKFLOW_RUN_STATE_QUEUED' and not pending.get('attemptId') and current_pool['activeAttemptCount']=='1'
                assert_binding(current,pool,placed);assert_binding(pending,pool,placed)
                ids=command('exec','-T','runner-daemon','docker','ps','-q','--filter','label=io.golf.runner.managed=true').split()
                for identifier in ids:
                    labels=json.loads(command('exec','-T','runner-daemon','docker','inspect',identifier))[0]['Config']['Labels'];assert labels['io.golf.runner.attempt']==running['attemptId'] and labels['io.golf.runner.worker']==claiming
                samples.append({'first':current['state'],'second':pending['state'],'activeAttemptCount':current_pool['activeAttemptCount']});time.sleep(1)
            completed=wait_state(first,'WORKFLOW_RUN_STATE_SUCCEEDED');assert cleared(completed['attemptId'])
            second_done=wait_state(second,'WORKFLOW_RUN_STATE_SUCCEEDED');assert second_done['runnerId']==other and cleared(second_done['attemptId']);assert_binding(second_done,pool,placed)
            assert datetime.fromisoformat(completed['finishedAt'].replace('Z','+00:00'))<=datetime.fromisoformat(second_done['startedAt'].replace('Z','+00:00'))
            for run_value,marker in ((completed,'owned runner finished'),(second_done,'owned runner finished')):
                body=rpc(owner,'WorkflowRunService/GetWorkflowRunLogs',{'runId':run_value['id']});assert marker in ''.join(row['text'] for row in body.get('logs',[]))
            change(owner,claiming,'ACTIVE');command('stop','runner','runner-second')
            stage('unbound work never claims a pooled worker')
            unbound_native=smoke.provider(owner['token'],'POST','user/repos',{'name':'unbound-pool-proof','private':True,'auto_init':True},201);unbound_repo={'owner':owner['name'],'name':unbound_native['name']};unbound_base='repos/'+unbound_native['full_name'];smoke.wait_for_push(owner['token'],unbound_native['full_name'])
            smoke.provider(owner['token'],'POST',unbound_base+'/contents/'+FAST,{'content':base64.b64encode(FAST_SOURCE).decode(),'message':'Owned unbound workflow'},201)
            unbound_head=smoke.provider(owner['token'],'GET',unbound_base+'/branches/'+unbound_native['default_branch'])['commit']['id']
            p=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',{'scope':'EXECUTION_SCOPE_REPOSITORY','repository':unbound_repo})['policy'];rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{'scope':'EXECUTION_SCOPE_REPOSITORY','repository':unbound_repo,'scopeId':p['scopeId'],'expectedRevision':p.get('revision','0'),'expectedAuthorityRevision':p['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            unbound=dispatch(FAST,unbound_repo,unbound_head);assert unbound['runnerPlacement'].get('legacyUnbound') is True and not unbound['runnerPlacement'].get('poolId')
            command('up','-d','--no-build','--pull','never','runner','runner-second')
            for _ in range(6):
                current=observed(unbound);assert current['state']=='WORKFLOW_RUN_STATE_QUEUED' and not current.get('runnerId') and not current.get('attemptId');time.sleep(1)
            cancel(unbound);command('stop','runner','runner-second')
            stage('edited/draining pool rejects old queued pin and fresh drained dispatch')
            stale=dispatch(FAST);assert_binding(stale,pool,placed)
            old_pool=pool;pool,_=save_pool(pool,state='RUNNER_POOL_STATE_DRAINING')
            dispatch(FAST,expected=400,code='failed_precondition')
            command('up','-d','--no-build','--pull','never','runner','runner-second')
            refused=wait_state(stale,'WORKFLOW_RUN_STATE_CANCELLED');assert not refused.get('runnerId') and not refused.get('attemptId');assert_binding(refused,old_pool,placed)
            command('stop','runner','runner-second');pool,_=save_pool(pool,state='RUNNER_POOL_STATE_ACTIVE');placed,_=place(pool)
            stage('changed placement refuses old queued pin without automatic reassignment')
            stale_placement=dispatch(FAST);old_placement=placed;placed,_=place(pool)
            command('up','-d','--no-build','--pull','never','runner','runner-second');refused_placement=wait_state(stale_placement,'WORKFLOW_RUN_STATE_CANCELLED');assert not refused_placement.get('attemptId');assert_binding(refused_placement,pool,old_placement)
            fresh=dispatch(FAST);fresh_done=wait_state(fresh,'WORKFLOW_RUN_STATE_SUCCEEDED');assert_binding(fresh_done,pool,placed);assert cleared(fresh_done['attemptId'])
            stage('restart retains completed binding; original intent replay never executes again')
            completed_receipts=[observed(r) for r in (first,second,fresh)]
            command('stop','runner','runner-second');command('restart','golf');smoke.ready();command('up','-d','--no-build','--pull','never','runner','runner-second')
            replay=dispatch(operation=first_key);assert replay['id']==first['id'] and replay['attemptId']==completed['attemptId'] and replay['state']=='WORKFLOW_RUN_STATE_SUCCEEDED';assert replay['runnerPlacement']==first['runnerPlacement']
            for r,before in zip((first,second,fresh),completed_receipts):
                after=observed(r);assert (after['state'],after['attemptId'],after['runnerId'],after['runnerPlacement'])==(before['state'],before['attemptId'],before['runnerId'],before['runnerPlacement'])
            assert not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true') and not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true')
            record(actualDockerWorkers={'workerIds':workers,'separateEnrolledKeysAndProcesses':True,'sharedOwnedDaemon':True,'capacity':1,'capacitySamples':samples,'capacityProofLimit':'Five bounded observations plus exact sequential attempt timing and server receipts; not load-scale qualification','bothIdentitiesExecuted':True,'firstWorker':claiming,'secondWorker':other,'unboundNeverClaimed':True,'stalePoolPinCancelledWithoutAttempt':True,'drainingFreshAdmissionRefused':True,'stalePlacementCancelledWithoutAttempt':True,'freshRepinnedDispatchExecuted':True,'completedAcrossRestartNoReplay':True,'runs':[{'runId':r['id'],'attemptId':r.get('attemptId'),'runnerId':r.get('runnerId'),'state':r['state'],'runnerPlacement':r['runnerPlacement']} for r in (completed,second_done,fresh_done)]})
            if args.ui:
                stage('twelve actual pool inventory/edit/placement captures; exact canonical routes')
                browser_dir=OUTPUT/'browser';browser_dir.mkdir(mode=0o700)
                fixtures={key:{'email':actors[key]['email'],'password':actors[key]['password']} for key in ('dark1440','dark390','light1440','light390')}
                run('node',str(Path(__file__).with_name('runner-pools-browser.mjs')),payload={'stackRoot':str(stack),'golf':smoke.GOLF,'screenshots':str(browser_dir),'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id']),'poolId':pool['id'],'workers':workers,'fixtures':fixtures,'runtime':baseline},timeout=300)
                browser_manifest=json.loads((browser_dir/'manifest.json').read_text());assert browser_manifest['passed'] and browser_manifest['complete'] and len(browser_manifest['captures'])==12
                record(browser={'passed':True,'captures':12,'manifestSha256':hashlib.sha256((browser_dir/'manifest.json').read_bytes()).hexdigest()})
            # Remove current native access; same managed account cannot retain repository facts.
            smoke.provider(owner['token'],'DELETE',base+'/collaborators/'+actors['reader']['name'],expected=204);rpc(actors['reader'],SERVICE+'GetRepositoryRunnerPlacement',{k:v for k,v in placement_intent.items() if k in ('repository','repositoryId','ownerId','expectedRevision')},expected=404)
            assert runtime()==baseline;record(runtimeAfter=runtime());passed=True
        except Exception as error:
            original_failure=error;record(originalFailure=original_failure_metadata(error,PROOF.get('lastProcedure')))
        finally:
            # Stop the actual consumer first; check cleanup separately from cancellation.
            if started:
                try:command('stop','-t','35','runner','runner-second');helpers.until(lambda:not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true') and not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true'),timeout=45)
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
    print('PASS: actual bounded two-worker Docker pool placement/capacity, served UI if requested, owned cleanup; full Runners remains Partial.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__);frame=next((f for f in reversed(frames) if f.filename==__file__),frames[-1])
        try:
            if 'originalFailure' not in PROOF: record(originalFailure=original_failure_metadata(error,PROOF.get('lastProcedure')))
            record(status='failed',failureType=type(error).__name__,failedStage=PROOF['originalFailure']['stage'],failureLine=PROOF['originalFailure']['line'])
        except Exception:pass
        print('Runner pool qualifier failed at '+STAGE+': '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
