#!/usr/bin/env python3
"""Prepared schema053 local-Docker qualification, never a retained-stack test.

Root invokes this helper with cached immutable images and seeds only its fresh
daemon. --self-check is pure: no sockets, Docker, native APIs or subprocesses.
The first packet covers lower ceilings, two workers, old-worker refusal,
whole-attempt timeout and cleanup. Unexercised acceptance groups remain explicit.
"""
import argparse
import base64
from datetime import datetime
import hashlib
import importlib.util
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
import traceback
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import smoke

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

pool_helpers = load('resource_pool_helpers', ROOT/'scripts/runner-pools-smoke.py')
helpers = load('resource_stack_helpers', ROOT/'scripts/observability-smoke.py')
IMAGE, DIND = pool_helpers.IMAGE, pool_helpers.DIND
CONTROL, POOLS = 'RunnerControlService/', 'RunnerPoolService/'
WORKERS = ['worker-a', 'worker-b', 'worker-legacy']
PROFILE = 'golf.local-docker.restrict.v1'
PATH = '.github/workflows/resources.yml'
TIMEOUT_PATH = '.github/workflows/timeout.yml'
DEFAULT = {'cpuMillis':1000, 'memoryBytes':'268435456', 'pids':64, 'timeoutSeconds':900}
INSTANCE = {**DEFAULT, 'timeoutSeconds':60}
POOL = {'cpuMillis':500, 'memoryBytes':'134217728', 'pids':32, 'timeoutSeconds':45}
REPOSITORY = {'cpuMillis':250, 'memoryBytes':'100663296', 'pids':24, 'timeoutSeconds':30}
TIMEOUT = {**REPOSITORY, 'timeoutSeconds':3}
STAGE, OUTPUT = 'arguments', None
PROOF = {'status':'prepared_not_run', 'cleanup':'not_created', 'scope':'Bounded053 local-Docker shell jobs only; full Runners stays Partial.', 'remaining':['actual default-max execution (startup defaults are read only)', 'CPU saturation, OOM and PID-exhaustion stress', 'actual maintained act-engine graph limits', 'active/queued policy tightening and private-byte fences', 'instant hardware quiescence (not provided)', 'resource settings browser captures', 'larger profiles, aggregate capacity, hostile tenant, Kubernetes, Cloudflare and recovery qualification']}

class Interrupted(RuntimeError): pass
def interrupt(_signum, _frame): raise Interrupted()

def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        temporary=OUTPUT/'manifest.json.tmp'
        with temporary.open('w') as stream:
            temporary.chmod(0o600); json.dump(PROOF,stream,indent=2,sort_keys=True);stream.write('\n')
        temporary.replace(OUTPUT/'manifest.json')

def stage(value):
    global STAGE
    STAGE=value;record(stage=value);print('CHECK: '+value,flush=True)

def require(value, category):
    if not value: record(validationFailure=category);raise AssertionError(category)

def decimal(value, positive=False):
    return isinstance(value,str) and bool(re.fullmatch(r'[1-9][0-9]{0,18}' if positive else r'0|[1-9][0-9]{0,18}',value)) and int(value)<=9223372036854775807

def limits(value):
    require(isinstance(value,dict) and set(value)==set(DEFAULT),'limits_fields')
    require(type(value['cpuMillis']) is int and 100<=value['cpuMillis']<=1000,'cpu_bounds')
    require(decimal(value['memoryBytes'],True) and 67108864<=int(value['memoryBytes'])<=268435456,'memory_bounds')
    require(type(value['pids']) is int and 16<=value['pids']<=64,'pid_bounds')
    require(type(value['timeoutSeconds']) is int and 1<=value['timeoutSeconds']<=900,'timeout_bounds')
    return value

def minimum(*values):
    for value in values:limits(value)
    return {field:str(min(int(value[field]) for value in values)) if field=='memoryBytes' else min(value[field] for value in values) for field in DEFAULT}

def binding(value, policy, pool, placement):
    require(isinstance(value,dict) and value=={'profile':PROFILE,'limits':minimum(policy['limits'],pool['jobLimits'],placement['jobLimits']),'instanceVersion':policy['version'],'poolId':pool['id'],'poolVersion':pool['version'],'placementVersion':placement['version'],'bound':True},'exact_resource_binding')
    return value

def docker_receipt(row, expected, attempt, worker, image_id):
    limits(expected);config=row.get('Config',{});host=row.get('HostConfig',{});labels=config.get('Labels',{})
    require(row.get('State',{}).get('Running') is True and row.get('Image')==image_id,'running_exact_job_image')
    require(labels.get('io.golf.runner.managed')=='true' and labels.get('io.golf.runner.attempt')==attempt and labels.get('io.golf.runner.worker')==worker,'exact_job_labels')
    require(config.get('User')=='1000:1000' and host.get('NetworkMode')=='none','job_identity_network')
    require(host.get('Memory')==int(expected['memoryBytes']) and host.get('MemorySwap')==int(expected['memoryBytes']) and host.get('NanoCpus')==expected['cpuMillis']*1000000 and host.get('PidsLimit')==expected['pids'],'docker_resource_limits')
    require(host.get('Privileged') is False and host.get('ReadonlyRootfs') is True and not host.get('Binds') and not host.get('CapAdd') and not host.get('Devices') and set(host.get('CapDrop',[]))=={'ALL'},'job_sandbox')
    require(any(value in ('no-new-privileges','no-new-privileges:true') for value in host.get('SecurityOpt',[])),'job_no_new_privileges')
    return {'runningExactImage':True,'exactAttemptWorker':True,'nonrootNetworkNone':True,'readOnlyCapDropNoHostBinds':True,'cpuMillis':expected['cpuMillis'],'memoryBytes':expected['memoryBytes'],'memorySwapBytes':expected['memoryBytes'],'pids':expected['pids']}

def cgroup_receipt(raw, expected):
    require(isinstance(raw,str) and len(raw)<=256,'cgroup_output_bound')
    rows=raw.strip().splitlines();require(len(rows)==4,'cgroup_v2_shape')
    cpu=rows[0].split();require(len(cpu)==2 and all(re.fullmatch(r'[1-9][0-9]{0,9}',value) for value in cpu),'cgroup_cpu_shape')
    quota,period=map(int,cpu);require(period<=1000000 and quota*1000==expected['cpuMillis']*period,'cgroup_cpu_limit')
    require(rows[1:]==[expected['memoryBytes'],'0',str(expected['pids'])],'cgroup_memory_swap_pid_limits')
    return {'version':2,'cpuQuota':quota,'cpuPeriod':period,'memoryMax':rows[1],'memorySwapMax':rows[2],'pidsMax':rows[3]}

def log_receipt(body, run, after):
    require(body.get('runId')==run['id'] and body.get('attemptId')==run['attemptId'] and body.get('repositoryId')==run['repositoryId'] and body.get('sourceCommitId')==run['commitId'] and not body.get('jobInstanceId') and not body.get('stepId'),'exact_log_receipt')
    require(not body.get('truncated') and body.get('outputState')!='WORKFLOW_OUTPUT_STATE_WITHHELD','complete_log_output')
    rows=body.get('logs',[]);require(isinstance(rows,list) and len(rows)<=16,'log_page_bound')
    for row in rows:
        require(isinstance(row,dict) and decimal(row.get('sequence'),True) and int(row['sequence'])>after and isinstance(row.get('text'),str),'ordered_log_shape');after=int(row['sequence'])
    require(not body.get('hasMore') or bool(rows),'nonempty_next_log_page')
    return ''.join(row['text'] for row in rows),after

def source(expected):
    # Source is owned and nonsecret. These checks precede reading fixture README;
    # independent external inspection is after start, not an atomic transfer proof.
    return ('''name: Owned resource limits
on: workflow_dispatch
jobs:
  proof:
    runs-on: linux
    steps:
      - name: Bounded controller observation
        run: |
          test "$(id -u)" = 1000
          read quota period < /sys/fs/cgroup/cpu.max
          test "$((quota * 1000))" = "$((%d * period))"
          test "$(cat /sys/fs/cgroup/memory.max)" = %s
          test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
          test "$(cat /sys/fs/cgroup/pids.max)" = %d
          printf 'owned resource controllers verified\\n'
          test -f README.md
          sleep 12
          printf 'owned bounded resource job completed\\n'
''' % (expected['cpuMillis'],expected['memoryBytes'],expected['pids'])).encode()

TIMEOUT_SOURCE=b'''on: workflow_dispatch
jobs:
  proof:
    runs-on: linux
    steps:
      - run: |
          printf 'owned timeout started\\n'
          sleep 10
          printf 'owned timeout must not complete\\n'
'''

def failure(error):
    frames=traceback.extract_tb(error.__traceback__)
    value={'type':type(error).__name__,'stage':STAGE,'callSites':[{'file':Path(__file__).name,'line':frame.lineno} for frame in frames if Path(frame.filename).name==Path(__file__).name][-8:]}
    if isinstance(error,pool_helpers.PrivateSubprocessFailure):value['subprocess']=error.observation
    if PROOF.get('lastProcedure'):value['lastProcedure']=dict(PROOF['lastProcedure'])
    return value

def wait(check, timeout=90):
    deadline=time.monotonic()+timeout
    while True:
        result=check()
        if result:return result
        require(time.monotonic()<deadline,'bounded_evidence_timeout');time.sleep(.4)

def self_check():
    require(minimum(INSTANCE,POOL,REPOSITORY)==REPOSITORY,'minimum_proof')
    policy={'limits':INSTANCE,'version':'1'};pool={'id':'12345678-1234-4234-8234-123456789001','version':'1','jobLimits':POOL};placement={'version':'1','jobLimits':REPOSITORY}
    accepted=binding({'profile':PROFILE,'limits':REPOSITORY,'instanceVersion':'1','poolId':pool['id'],'poolVersion':'1','placementVersion':'1','bound':True},policy,pool,placement)
    sentinel='private-sentinel-resource-proof-987'
    row={'Image':'sha256:'+'a'*64,'State':{'Running':True},'Config':{'User':'1000:1000','Env':['PRIVATE='+sentinel],'Labels':{'io.golf.runner.managed':'true','io.golf.runner.attempt':'b'*32,'io.golf.runner.worker':'worker-a'}},'HostConfig':{'Memory':100663296,'MemorySwap':100663296,'NanoCpus':250000000,'PidsLimit':24,'NetworkMode':'none','Privileged':False,'ReadonlyRootfs':True,'Binds':None,'CapAdd':None,'Devices':None,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']}}
    receipt=docker_receipt(row,REPOSITORY,'b'*32,'worker-a',row['Image'])
    cg=cgroup_receipt('25000 100000\n100663296\n0\n24\n',REPOSITORY)
    for mutate in (lambda r:r['HostConfig'].update(MemorySwap=201326592),lambda r:r['HostConfig'].update(NanoCpus=1000000000),lambda r:r['Config']['Labels'].update({'io.golf.runner.attempt':'c'*32}),lambda r:r['HostConfig'].update(Binds=['/'+sentinel])):
        changed=json.loads(json.dumps(row));mutate(changed)
        try:docker_receipt(changed,REPOSITORY,'b'*32,'worker-a',row['Image'])
        except AssertionError:pass
        else:raise AssertionError('Wrong receipt accepted')
    for raw in ('max 100000\n100663296\n0\n24','25000 100000\n100663296\n1\n24','25000 100000\n100663296\n0\n64',sentinel):
        try:cgroup_receipt(raw,REPOSITORY)
        except AssertionError:pass
        else:raise AssertionError('Wrong cgroup accepted')
    run={'id':'12345678-1234-4234-8234-123456789001','attemptId':'b'*32,'repositoryId':'9007199254740993','commitId':'a'*40}
    logs={'runId':run['id'],'attemptId':run['attemptId'],'repositoryId':run['repositoryId'],'sourceCommitId':run['commitId'],'logs':[{'sequence':'1','text':'owned marker'}]}
    require(log_receipt(logs,run,0)==('owned marker',1),'positive_log_binding')
    for key,value in (('repositoryId','9007199254740992'),('attemptId','c'*32),('sourceCommitId','c'*40),('jobInstanceId','c'*32),('outputState','WORKFLOW_OUTPUT_STATE_WITHHELD')):
        try:log_receipt({**logs,key:value},run,0)
        except AssertionError:pass
        else:raise AssertionError('Wrong log provenance accepted')
    for field,value in (('memoryBytes','0100663296'),('memoryBytes','9223372036854775808'),('cpuMillis',True),('pids',15),('timeoutSeconds',0)):
        try:limits({**REPOSITORY,field:value})
        except AssertionError:pass
        else:raise AssertionError('Wrong limit accepted')
    pool_helpers.safe_manifest({'binding':accepted,'docker':receipt,'cgroup':cg,'diagnostic':pool_helpers.process_observation(('docker','compose','up'),1,b'',sentinel.encode())},[sentinel])
    text=Path(__file__).read_text();require('build: !reset null' in text and '--pull=never' in text and 'before source transfer' not in source(REPOSITORY).decode(),'fixture_source_guards')
    require('job_resources = 32;' in (ROOT/'api/golf/v1/golf.proto').read_text() or 'job_resources=32;' in (ROOT/'api/golf/v1/golf.proto').read_text(),'wire_source_guard')
    PROOF.pop('validationFailure',None)
    print('PASS: pure053 limits/binding/Docker/cgroup/private diagnostic checks; actual runtime unrun.')

def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true')
    for name in ('image','runner-image','old-runner-image','expected-source','expected-runner-sha256','expected-engine-sha256'):parser.add_argument('--'+name)
    parser.add_argument('--stack-root',type=Path,default=ROOT);parser.add_argument('--output',type=Path);parser.add_argument('--seed-timeout',type=int,default=300)
    args=parser.parse_args()
    if args.self_check:self_check();return
    for name in ('image','runner_image','old_runner_image'):require(bool(re.fullmatch(r'sha256:[a-f0-9]{64}',getattr(args,name) or '')),'exact_cached_image_required')
    require(bool(re.fullmatch(r'[a-f0-9]{40}',args.expected_source or '')),'full_source_required')
    for value in (args.expected_runner_sha256,args.expected_engine_sha256):require(bool(re.fullmatch(r'[a-f0-9]{64}',value or '')),'exact_binary_hash_required')
    require(args.output is not None and 1<=args.seed_timeout<=600,'arguments')
    OUTPUT=args.output.resolve();OUTPUT.mkdir(mode=0o700,exist_ok=False);OUTPUT.chmod(0o700)
    stack=args.stack_root.resolve();record(status='running',expectedSource=args.expected_source)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_','DOCKER_')) and k!='DATABASE_URL'}
    def run(*argv,payload=None,timeout=180):
        try:result=subprocess.run(argv,cwd=stack,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        except subprocess.TimeoutExpired as error:raise pool_helpers.PrivateSubprocessFailure(pool_helpers.process_observation(argv,None,error.stdout,error.stderr,True)) from None
        except OSError as error:
            value=pool_helpers.process_observation(argv,None);value['reason']='process_launch_failed';value['errno']=error.errno
            raise pool_helpers.PrivateSubprocessFailure(value) from None
        if result.returncode or len(result.stdout)>pool_helpers.PROCESS_LIMIT or len(result.stderr)>pool_helpers.PROCESS_LIMIT:raise pool_helpers.PrivateSubprocessFailure(pool_helpers.process_observation(argv,result.returncode,result.stdout,result.stderr))
        return result.stdout.decode().strip()
    def ephemeral(image, entrypoint, *argv):
        name='golf-resource-preflight-'+secrets.token_hex(8);original_error=None;result=None
        try:result=run('docker','run','--name',name,'--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=67108864','--memory-swap=67108864','--cpus=1','--pids-limit=16','--entrypoint',entrypoint,image,*argv,timeout=30)
        except Exception as error:original_error=error;record(originalFailure=failure(error))
        finally:
            # Exact owned name only; Docker client timeout must not leave even a
            # public hash/df container behind. Original failure remains primary.
            clear=False
            try:
                subprocess.run(['docker','rm','-f',name],cwd=stack,env=environment,capture_output=True,timeout=15)
                observed=subprocess.run(['docker','ps','-aq','--filter','name=^'+name+'$'],cwd=stack,env=environment,capture_output=True,timeout=15)
                clear=observed.returncode==0 and not observed.stdout.strip()
            except (OSError,subprocess.TimeoutExpired):pass
            record(preflightCleanup='passed' if clear else 'failed')
            if not clear and original_error is None:raise AssertionError('Owned preflight cleanup failed')
        if original_error is not None:raise original_error
        return result
    stage('exact source, public binaries, cached dependencies and reserve')
    image_rows={key:json.loads(run('docker','image','inspect',reference))[0] for key,reference in (('core',args.image),('runner',args.runner_image),('legacy',args.old_runner_image),('native','gitea/gitea:1.27.3-rootless'),('postgres','postgres:18.4-alpine3.24'),('daemon',DIND))}
    for key in ('core','runner'):require((image_rows[key]['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.expected_source,'image_source_binding')
    require(all(row.get('Os')=='linux' and row.get('Architecture')==image_rows['core'].get('Architecture') for row in image_rows.values()),'same_linux_image_architecture')
    require(image_rows['core']['Id']==args.image and image_rows['runner']['Id']==args.runner_image and image_rows['legacy']['Id']==args.old_runner_image and args.runner_image!=args.old_runner_image,'exact_image_identity')
    public_hashes={}
    for key,binary,expected in (('core','golf-actions-engine',args.expected_engine_sha256),('runner','golf-actions-engine',args.expected_engine_sha256),('runner','golf-runner',args.expected_runner_sha256)):
        raw=ephemeral(image_rows[key]['Id'],'/usr/bin/sha256sum','/usr/local/bin/'+binary)
        require(raw.split()==[expected,'/usr/local/bin/'+binary],'public_binary_source_binding');public_hashes[key+'/'+binary]=expected
    space=ephemeral(args.image,'/bin/df','-Pk','/')
    require(int(space.splitlines()[-1].split()[3])>=2*1024*1024,'disk_reserve_below_2gib')
    record(images={key:{'image':value['Id'],'source':(value['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') if re.fullmatch(r'[a-f0-9]{40}',(value['Config'].get('Labels') or {}).get('org.opencontainers.image.revision','')) else None} for key,value in image_rows.items()},publicBinarySha256=public_hashes,workingTreeHead=run('git','rev-parse','HEAD'))
    project='golf-limits-'+secrets.token_hex(5);ports=helpers.free_ports(3);previous=smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA=f'http://127.0.0.1:{ports[0]}',f'http://127.0.0.1:{ports[1]}'
    keys={name:base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=') for name in WORKERS}
    actors={};forbidden=list(keys.values());started=False;original=None;cleanup=[];passed=False;daemon=None
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700);tls=directory/'tls';tls.mkdir(mode=0o700)
        helpers.private_write(tls/'ca.conf','[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        run('openssl','req','-config',str(tls/'ca.conf'),'-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=Golf disposable resource CA','-keyout',str(tls/'ca.key'),'-out',str(tls/'ca.crt'),timeout=20)
        run('openssl','req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=127.0.0.1','-keyout',str(tls/'server.key'),'-out',str(tls/'server.csr'),timeout=20)
        helpers.private_write(tls/'extensions','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('openssl','x509','-req','-in',str(tls/'server.csr'),'-CA',str(tls/'ca.crt'),'-CAkey',str(tls/'ca.key'),'-CAcreateserial','-days','1','-extfile',str(tls/'extensions'),'-out',str(tls/'server.crt'),timeout=20)
        for file in ('ca.crt','server.crt','server.key'):(tls/file).chmod(0o444)
        context=ssl.create_default_context(cafile=str(tls/'ca.crt'));context.minimum_version=ssl.TLSVersion.TLSv1_3
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=keys['worker-a'],GOLF_RUNNER_KEYS=json.dumps(keys),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_PUSH_CI_ENABLED='false')
        forbidden.extend(value for key,value in values.items() if key.endswith(('PASSWORD','ENCRYPTION_KEY')))
        env_file=directory/'core.env';override=directory/'proof.yaml'
        helpers.private_write(env_file,''.join(key+"='"+value+"'\n" for key,value in values.items()))
        worker_services=''
        for service,worker,image in (('runner-second','worker-b',args.runner_image),('runner-legacy','worker-legacy',args.old_runner_image)):
            worker_services+=f'''  {service}:
    image: {image}
    pull_policy: never
    network_mode: service:golf
    environment:
      GOLF_RUNNER_URL: https://127.0.0.1:8443
      GOLF_RUNNER_TLS_CA_FILE: /run/golf/internal-tls/ca.crt
      GOLF_RUNNER_ID: {worker}
      GOLF_RUNNER_KEY: {keys[worker]}
      GOLF_RUNNER_APPROVED_IMAGES: '{json.dumps([IMAGE])}'
      DOCKER_HOST: tcp://runner-daemon:2376
      DOCKER_TLS_VERIFY: '1'
      DOCKER_CERT_PATH: /certs/client
    volumes: [runner-client-certs:/certs/client:ro, "{tls/'ca.crt'}:/run/golf/internal-tls/ca.crt:ro"]
    read_only: true
    tmpfs: ["/tmp:size=33554432,mode=1777"]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    depends_on:
      golf:
        condition: service_started
      runner-image-init:
        condition: service_completed_successfully
'''
        helpers.private_write(override,f'''services:
  postgres:
    image: {image_rows['postgres']['Id']}
    pull_policy: never
  golf:
    image: {args.image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443"]
    environment:
      GOLF_INTERNAL_TLS_LISTEN_ADDR: :8443
      GOLF_INTERNAL_TLS_CERT_FILE: /run/golf/internal-tls/server.crt
      GOLF_INTERNAL_TLS_KEY_FILE: /run/golf/internal-tls/server.key
    volumes: ["{tls/'server.crt'}:/run/golf/internal-tls/server.crt:ro", "{tls/'server.key'}:/run/golf/internal-tls/server.key:ro"]
  gitea:
    image: {image_rows['native']['Id']}
    pull_policy: never
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__actions__ENABLED: 'false'
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  runner-daemon:
    image: {image_rows['daemon']['Id']}
    pull_policy: never
  runner:
    build: !reset null
    image: {args.runner_image}
    pull_policy: never
    environment:
      GOLF_RUNNER_URL: https://127.0.0.1:8443
      GOLF_RUNNER_TLS_CA_FILE: /run/golf/internal-tls/ca.crt
      GOLF_RUNNER_ID: worker-a
      GOLF_RUNNER_KEY: {keys['worker-a']}
    volumes: ["{tls/'ca.crt'}:/run/golf/internal-tls/ca.crt:ro"]
{worker_services}  runner-image-init:
    entrypoint: [/bin/true]
    command: []
    pull_policy: never
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(stack/'compose.ci.yaml'),'-f',str(override)]
        def command(*argv,**kw):return run(*compose,*argv,**kw)
        def admin(*argv):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv)
        pool_helpers.record=record
        def rpc(actor,method,payload=None,**kw):return pool_helpers.checked_rpc(actor['session'],method,payload,**kw)
        def observation(item):return rpc(actors['owner'],'WorkflowRunService/GetWorkflowRun',{'runId':item['id']})['run']
        def run_logs(item):
            text='';after=0
            for _ in range(8):
                body=rpc(actors['owner'],'WorkflowRunService/GetWorkflowRunLogs',{'runId':item['id'],'afterSequence':str(after)})
                chunk,after=log_receipt(body,item,after);text+=chunk;require(len(text.encode())<=65536,'log_aggregate_bound')
                if not body.get('hasMore'):return text
            raise AssertionError('Log pagination exceeded owned fixture bound')
        def dispatch(path=PATH,operation=None):
            item=rpc(actors['owner'],'WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':path,'idempotencyKey':operation or str(uuid.uuid4())})['run']
            require(item['repositoryId']==str(native['id']) and item['ownerId']==str(native['owner']['id']) and item['commitId']==head and item['workflowPath']==path,'dispatch_target_receipt');binding(item['jobResources'],policy,pool,placement);return item
        def place(actor,requested):
            access=rpc(actor,'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
            target={'repository':repository,'repositoryId':access['repositoryId'],'ownerId':access['ownerId'],'expectedRevision':access['revision']}
            before=rpc(actor,POOLS+'GetRepositoryRunnerPlacement',target)['placement']
            intent={**target,'expectedPlacementVersion':before['version'],'poolId':pool['id'],'expectedPoolVersion':pool['version'],'jobLimits':requested,'currentPassword':actor['password']}
            after=rpc(actor,POOLS+'SetRepositoryRunnerPlacement',intent)['placement'];require(after['repositoryId']==target['repositoryId'] and after['ownerId']==target['ownerId'] and after['poolId']==pool['id'] and after['poolVersion']==pool['version'] and after['version']==str(int(before['version'])+1) and after['jobLimits']==requested and after['effectiveJobLimits']==minimum(policy['limits'],pool['jobLimits'],requested),'placement_limits_receipt');return after
        def daemon_command(*argv):return command('exec','-T','runner-daemon','docker',*argv)
        def cleaned(attempt=None):
            filters=['--filter','label=io.golf.runner.managed=true']
            if attempt:filters+=['--filter','label=io.golf.runner.attempt='+attempt]
            return not daemon_command('ps','-aq',*filters) and not daemon_command('volume','ls','-q',*filters)
        def runtime():
            row=json.loads(run('docker','inspect',command('ps','-q','golf')))[0];require(row['Image']==args.image,'unchanged_core_image')
            return {'image':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash'],'nativeVersion':smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/version')['version']}
        try:
            stage('fresh TLS core/native/database and root-seeded owned daemon')
            started=True;record(project=project,cleanup='pending')
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','runner-daemon');smoke.ready();command('up','-d','--no-build','--pull','never','runner-image-init')
            before=runtime();require(before['nativeVersion']=='1.27.3','pinned_native');record(runtimeBefore=before)
            with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as connection:
                with context.wrap_socket(connection,server_hostname='127.0.0.1') as verified:require(verified.version()=='TLSv1.3','tls13_verified')
            for bad_context,hostname in ((ssl.create_default_context(),'127.0.0.1'),(context,'wrong.golf.invalid')):
                try:
                    with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as connection:
                        with bad_context.wrap_socket(connection,server_hostname=hostname):pass
                except ssl.SSLCertVerificationError:pass
                else:raise AssertionError('TLS certificate refusal missing')
            record(tls={'trustedCA':True,'hostnameVerified':True,'tls13':True,'untrustedCAAndWrongNameRefused':True})
            daemon=command('ps','-q','runner-daemon');require(bool(re.fullmatch(r'[a-f0-9]{12,64}',daemon)),'owned_daemon_id')
            helpers.private_write(OUTPUT/'seed-pending.json',json.dumps({'schema':'golf.runner-resources.seed.v1','project':project,'containerId':daemon,'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_timeout,'helperNeverPullsOrBuilds':True},indent=2)+'\n')
            print('PREREQUISITE: root seed fresh owned daemon '+daemon+' with exact pinned Alpine and DinD; helper never pulls/builds.',flush=True)
            def seeded():
                rows=[]
                for reference in (IMAGE,DIND):
                    process=subprocess.run([*compose,'exec','-T','runner-daemon','docker','image','inspect',reference],cwd=stack,env=environment,capture_output=True,timeout=10)
                    if process.returncode:return None
                    require(len(process.stdout)<=1<<20,'seed_inspect_bound');row=json.loads(process.stdout)[0]
                    require(row['Os']=='linux' and bool(re.fullmatch(r'sha256:[a-f0-9]{64}',row['Id'])),'seed_exact_image');rows.append({'reference':reference,'imageId':row['Id']})
                return rows
            seeded_images=wait(seeded,args.seed_timeout);record(seededImages=seeded_images);helpers.private_write(OUTPUT/'seed-ready.json',json.dumps({'schema':'golf.runner-resources.seed.v1','containerId':daemon,'verifiedImages':seeded_images},indent=2)+'\n');job_image=seeded_images[0]['imageId']
            stage('owned native identities, managed administrators, repository and exact source')
            buckets=set()
            for role in ('owner','control','reader'):
                for _ in range(256):
                    name='rl-'+role+'-'+secrets.token_hex(4);bucket=int.from_bytes(hashlib.sha256(name.encode()).digest()[:2],'big')%1024+1
                    if bucket not in buckets:buckets.add(bucket);break
                else:raise AssertionError('Owned password bucket exhausted')
                actor={'name':name,'email':name+'@example.invalid','password':secrets.token_urlsafe(32),'session':smoke.client()};actors[role]=actor;forbidden.append(actor['password'])
                admin('create','--username',name,'--email',actor['email'],'--random-password','--must-change-password=false');actor['nativeCreated']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository,write:issue','--raw');forbidden.append(actor['token'])
                command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role!='reader'});actor['enrolled']=True
                signed=rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];require(signed.get('isInstanceAdmin',False)==(role!='reader'),'managed_role');actor['loggedIn']=True
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'resource-limits','private':True,'auto_init':True},201);repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            for role,permission in (('control','admin'),('reader','read')):smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors[role]['name'],{'permission':permission},204)
            for path,content in ((PATH,source(REPOSITORY)),(TIMEOUT_PATH,TIMEOUT_SOURCE)):smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(content).decode(),'message':'Owned resource qualification source'},201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];require(bool(re.fullmatch(r'[a-f0-9]{40}',head)),'exact_head')
            for scope in ('INSTANCE','REPOSITORY'):
                query={'scope':'EXECUTION_SCOPE_'+scope,**({'repository':repository} if scope=='REPOSITORY' else {})};value=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',query)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{**query,'scopeId':value['scopeId'],'expectedRevision':value.get('revision','0'),'expectedAuthorityRevision':value['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('instance, pool and repository ceilings with current admin/CAS fences')
            current=rpc(owner,CONTROL+'GetInstanceRunnerLimits')['policy'];require(current['limits']==DEFAULT and current['version']=='0','startup_explicit_default')
            policy=rpc(owner,CONTROL+'SetInstanceRunnerLimits',{'expectedVersion':current['version'],'limits':INSTANCE,'currentPassword':owner['password']})['policy'];require(policy['limits']==INSTANCE and policy['version']=='1','instance_limits_receipt')
            for method in ('GetInstanceRunnerLimits','SetInstanceRunnerLimits'):rpc(actors['reader'],CONTROL+method,{'expectedVersion':'1','limits':INSTANCE,'currentPassword':actors['reader']['password']},expected=403)
            rpc(owner,CONTROL+'SetInstanceRunnerLimits',{'expectedVersion':'0','limits':INSTANCE,'currentPassword':owner['password']},expected=409,code='aborted')
            for method in ('GetInstanceRunnerLimits','SetInstanceRunnerLimits'):rpc(owner,CONTROL+method,{},expected=403,headers={'Origin':'https://wrong.golf.invalid'})
            delegated=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Owned resource-control refusal','lifetimeSeconds':600});forbidden.append(delegated['token'])
            for method in ('GetInstanceRunnerLimits','SetInstanceRunnerLimits'):pool_helpers.checked_rpc(smoke.client(),CONTROL+method,{},expected=403,headers={'Authorization':'Bearer '+delegated['token']})
            rpc(owner,'ApiCredentialService/RevokeApiCredential',{'credentialId':delegated['credential']['id']})
            pool=rpc(actors['control'],POOLS+'SaveRunnerPool',{'id':str(uuid.uuid4()),'expectedVersion':'0','name':'Owned lower limits pool','runtime':'local-docker','state':'RUNNER_POOL_STATE_ACTIVE','maxParallelAttempts':2,'workerIds':WORKERS,'repositoryAssignmentEnabled':True,'jobLimits':POOL,'currentPassword':actors['control']['password']})['pool'];require(pool['jobLimits']==POOL and pool['effectiveJobLimits']==minimum(INSTANCE,POOL) and pool['version']=='1','pool_limits_receipt')
            placement=place(owner,REPOSITORY);record(ceilings={'startup':DEFAULT,'instance':policy,'pool':{'id':pool['id'],'version':pool['version'],'configured':pool['jobLimits'],'effective':pool['effectiveJobLimits']},'repository':{'version':placement['version'],'configured':placement['jobLimits'],'effective':placement['effectiveJobLimits']}},independentlyCalculatedMinimum=minimum(INSTANCE,POOL,REPOSITORY))
            stage('old022 worker remains alive but cannot claim resource-bound work')
            first_operation=str(uuid.uuid4());first=dispatch(operation=first_operation)
            command('up','-d','--no-build','--pull','never','runner-legacy')
            samples=[]
            for _ in range(12):
                value=observation(first);require(value['state']=='WORKFLOW_RUN_STATE_QUEUED' and not value.get('attemptId') and not value.get('runnerId') and cleaned(),'legacy_no_assignment')
                legacy=json.loads(run('docker','inspect',command('ps','-q','runner-legacy')))[0];require(legacy['Image']==args.old_runner_image and legacy['State']['Running'],'live_legacy_process')
                samples.append({'state':value['state'],'noAttempt':True,'noJobContainersOrVolumes':True});time.sleep(1)
            command('stop','-t','15','runner-legacy');record(oldWorker={'image':args.old_runner_image,'aliveWithoutAssignment':True,'seconds':12,'samples':samples,'scope':'Actual old-image poller cannot acquire one resource-bound queued job; not a fabricated protocol lease.'})
            stage('two upgraded workers execute exact lower-limit Docker jobs')
            second=dispatch();command('up','-d','--no-build','--pull','never','runner','runner-second');receipts=[];running=[]
            def both_running():
                rows=[observation(item) for item in (first,second)]
                if not all(row['state']=='WORKFLOW_RUN_STATE_RUNNING' for row in rows):return None
                if not all(any(step.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for step in row.get('progress',{}).get('steps',[])) for row in rows):return None
                require({row['runnerId'] for row in rows}=={'worker-a','worker-b'},'two_independent_workers');return rows
            running=wait(both_running)
            for value in running:
                binding(value['jobResources'],policy,pool,placement)
                ids=daemon_command('ps','-q','--no-trunc','--filter','label=io.golf.runner.managed=true','--filter','label=io.golf.runner.attempt='+value['attemptId']).split();require(len(ids)==1 and bool(re.fullmatch(r'[a-f0-9]{64}',ids[0])),'one_running_inner_job')
                inspected=json.loads(daemon_command('inspect',ids[0]))[0];require(inspected.get('Id')==ids[0],'exact_inspected_container_id');require(all(not secret or all(secret not in entry for entry in inspected['Config'].get('Env',[])) for secret in forbidden),'no_control_credentials_in_job_env')
                docker=docker_receipt(inspected,REPOSITORY,value['attemptId'],value['runnerId'],job_image)
                controllers=daemon_command('exec','--user','1000:1000',ids[0],'/bin/sh','-c','cat /sys/fs/cgroup/cpu.max; cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.swap.max; cat /sys/fs/cgroup/pids.max')
                receipts.append({'workerId':value['runnerId'],'runId':value['id'],'attemptId':value['attemptId'],'docker':docker,'cgroup':cgroup_receipt(controllers,REPOSITORY),'externalInspectionTiming':'Running inner job; production pre-copy inspect separately source-backed, not atomically observed by this helper.'})
            completed=[]
            for value in running:
                result=wait(lambda:value_if_state(observation(value),'WORKFLOW_RUN_STATE_SUCCEEDED'));require(result['attemptId']==value['attemptId'] and result['runnerId']==value['runnerId'],'completion_original_attempt');binding(result['jobResources'],policy,pool,placement);wait(lambda:cleaned(result['attemptId']),45)
                text=run_logs(result);require('owned resource controllers verified' in text and 'owned bounded resource job completed' in text,'actual_completion_markers');require(all(secret not in text for secret in forbidden),'no_control_secret_logs');completed.append(result)
            record(actualJobs={'receipts':receipts,'bothWorkersCompleted':True,'fixedControllerAndCompletionMarkers':True,'noRawLogOrEnvArtifact':True,'attemptContainersAndVolumesRemoved':True})
            stage('whole-attempt timeout uses immutable lower budget and removes resources')
            command('stop','-t','15','runner','runner-second');placement=place(actors['control'],TIMEOUT);timeout_run=dispatch(TIMEOUT_PATH);start=time.monotonic();command('up','-d','--no-build','--pull','never','runner','runner-second')
            timed=wait(lambda:value_if_state(observation(timeout_run),'WORKFLOW_RUN_STATE_TIMED_OUT'),60);binding(timed['jobResources'],policy,pool,placement);wait(lambda:cleaned(timed['attemptId']),45)
            elapsed=time.monotonic()-start;duration=(datetime.fromisoformat(timed['finishedAt'].replace('Z','+00:00'))-datetime.fromisoformat(timed['startedAt'].replace('Z','+00:00'))).total_seconds();require(0<duration<=30,'bounded_timeout_completion')
            text=run_logs(timed);require('owned timeout must not complete' not in text and all(secret not in text for secret in forbidden),'timeout_no_completion_marker')
            record(timeout={'runId':timed['id'],'attemptId':timed['attemptId'],'state':timed['state'],'admittedBudgetSeconds':3,'startedToFinishedSeconds':duration,'observedElapsedSeconds':round(elapsed,3),'lateCompletionMarkerAbsent':True,'attemptContainersAndVolumesRemoved':True,'scope':'Whole-attempt wall budget plus bounded completion/cleanup; not instantaneous hardware stop.'})
            stage('restart keeps original completed and timed-out snapshots without replay')
            historical=[observation(item) for item in (*completed,timed)];command('stop','-t','15','runner','runner-second');command('restart','golf');smoke.ready();command('up','-d','--no-build','--pull','never','runner','runner-second')
            for before_value in historical:
                after=observation(before_value);require(all(after.get(field)==before_value.get(field) for field in ('state','attemptId','runnerId','jobResources','commitId','workflowPath')),'restart_original_snapshot')
            # Known operation lookup precedes new admission: only its original
            # historical receipt can return, even after placement changes.
            replay_request={'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':first_operation}
            replay=rpc(owner,'WorkflowRunService/DispatchWorkflow',replay_request)
            require(replay['run']['id']==first['id'] and replay['run']['attemptId']==completed[0]['attemptId'] and replay['run']['jobResources']==first['jobResources'],'original_replay_receipt')
            for _ in range(5):require(cleaned(),'restart_no_new_execution');time.sleep(1)
            require(runtime()==before,'unchanged_runtime');record(runtimeAfter=runtime(),restart={'originalSnapshotsRetained':True,'originalIntentNoReplacementAttempt':True,'idleSeconds':5});passed=True
        except Exception as error:original=error;record(originalFailure=failure(error))
        finally:
            if started:
                try:command('stop','-t','35','runner','runner-second','runner-legacy');wait(lambda:cleaned(),45)
                except Exception:cleanup.append('owned-attempt-resources')
            for actor in actors.values():
                if actor.get('loggedIn'):
                    try:rpc(actor,'SessionService/RevokeOtherSessions');rpc(actor,'SessionService/Logout')
                    except Exception:cleanup.append('managed-session')
                if actor.get('enrolled'):
                    try:command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                    except Exception:cleanup.append('managed-account')
            for actor in reversed(list(actors.values())):
                if actor.get('nativeCreated'):
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:cleanup.append('native-actor')
            if started:
                try:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):require(not run('docker',*argv,'--filter','label=com.docker.compose.project='+project),'owned_compose_cleanup')
                except Exception:cleanup.append('fresh-compose-resources')
            smoke.GOLF,smoke.GITEA=previous;record(status='passed' if passed and not cleanup else 'failed',complete=passed and not cleanup,cleanup='failed' if cleanup else 'passed',cleanupFailures=cleanup)
            raw=pool_helpers.safe_manifest(PROOF,forbidden);(OUTPUT/'manifest.json').write_text(raw);(OUTPUT/'manifest.json').chmod(0o600)
        if original is not None:raise original
        require(passed and not cleanup,'qualification_and_cleanup')
    print('PASS: bounded053 actual shell limits, old-worker refusal, timeout/restart and owned cleanup; remaining groups explicitly unqualified.')

def value_if_state(row, state):
    require(row['state'] not in ('WORKFLOW_RUN_STATE_LOST','WORKFLOW_RUN_STATE_CANCELLED','WORKFLOW_RUN_STATE_FAILED','WORKFLOW_RUN_STATE_TIMED_OUT') or row['state']==state,'unexpected_terminal_run')
    return row if row['state']==state else None

if __name__=='__main__':
    signal.signal(signal.SIGINT,interrupt);signal.signal(signal.SIGTERM,interrupt)
    try:main()
    except Exception as error:
        try:
            if 'originalFailure' not in PROOF:record(originalFailure=failure(error))
            record(status='failed',failureType=type(error).__name__,failedStage=PROOF['originalFailure']['stage'])
        except Exception:pass
        print('Runner resource qualifier failed at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
