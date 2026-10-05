#!/usr/bin/env python3
"""Prepared bounded actual two-job maintained Actions proof; root operator runs it.

One input-free first -> second DAG, immutable source/attempt and private scoped
logs, fresh job workspace, original replay/restart and exact-owned cleanup.
Requires cached images/binary hashes and explicit root seeding of fresh DinD.
--self-check performs pure counterexample checks only. No new scheduler support,
full Actions, failure/skip, cancellation, secrets, remote actions or UI claim.
"""
import argparse
import ast
import base64
import copy
import hashlib
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
import traceback
import uuid

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
def load(name, file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
act=load('two_job_actions_helpers','actions-engine-smoke.py')
notifications=load('two_job_foreign_helpers','workflow-notifications-smoke.py')
helpers=act.helpers
CATALOG, ENGINE, IMAGE=act.CATALOG,act.ENGINE,act.IMAGE
DIND='docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
NATIVE, PG='gitea/gitea:1.27.3-rootless','postgres:18.4-alpine3.24'
PATH='.github/workflows/two-job.yml'
PROJECT_PREFIX='golf-rules49-'
MARKERS={'first':'FIRST_JOB_SOURCE_COMPLETE','second':'SECOND_JOB_FRESH_WORKSPACE'}
STEPS={'first':['source','write'],'second':['fresh']}
STAGE='arguments'
REPORT_FAILURE=None

def stage(value):
    global STAGE
    STAGE=value;print('CHECK: '+value,flush=True)

def safe_json(value,forbidden):
    text=json.dumps(value,indent=2)
    assert len(text)<=1048576 and all(not item or item not in text for item in forbidden)
    return text

def source_files(stack):
    source=(stack/'engines/act/testdata/two-job-needs.yml').read_bytes()
    assert 0<len(source)<65536 and all(marker.encode() in source for marker in MARKERS.values())
    assert b'golf-first-job-only' in source and PATH.encode() in source
    return {PATH:source}

def check_run(run,native,head,blob):
    assert str(uuid.UUID(run['id']))==run['id']
    assert run['repositoryId']==str(native['id']) and run['ownerId']==str(native['owner']['id'])
    assert run['commitId']==head and run['workflowPath']==PATH and run['workflowBlobId']==blob
    assert run['engineCatalog']==CATALOG and run['engineCommit']==ENGINE
    assert re.fullmatch('[a-f0-9]{32}',run['attemptId']) and re.fullmatch('[a-f0-9]{64}',run['sourceSha256'])
    assert run['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and run['origin']=='WORKFLOW_RUN_ORIGIN_MANUAL' and run['runnerId']=='local-docker'
    assert 'exitCode' not in run and 'progress' not in run and not run.get('logsTruncated',False)
    assert act.stamp(run['startedAt'])<=act.stamp(run['finishedAt'])
    jobs=run.get('jobs',[])
    assert len(jobs)==2 and {job['instanceId'] for job in jobs}=={act.instance(name,{}) for name in STEPS}
    by_name={job['jobId']:job for job in jobs};assert set(by_name)==set(STEPS)
    for name,job in by_name.items():
        assert job['instanceId']==act.instance(name,{}) and not job.get('matrix',[])
        assert job.get('needs',[])==(['first'] if name=='second' else [])
        assert job['state']==act.STATE+'SUCCEEDED' and job['eventsRecorded'] is True and job['imageDigest']==IMAGE
        assert act.stamp(run['startedAt'])<=act.stamp(job['startedAt'])<=act.stamp(job['finishedAt'])<=act.stamp(run['finishedAt'])
        steps=job.get('steps',[]);assert len(steps)==len(STEPS[name]) and [step['id'] for step in steps]==STEPS[name]
        previous=job['startedAt']
        for step in steps:
            assert act.stamp(previous)<=act.stamp(step['startedAt'])
            previous=step['finishedAt']
            assert step['state']==act.STATE+'SUCCEEDED'
            assert act.stamp(job['startedAt'])<=act.stamp(step['startedAt'])<=act.stamp(step['finishedAt'])<=act.stamp(job['finishedAt'])
    assert act.stamp(by_name['first']['finishedAt'])<=act.stamp(by_name['second']['startedAt'])
    return jobs

def check_logs(rpc,run,jobs):
    evidence=[];all_logs=act.read_logs(rpc,run,evidence=evidence)
    assert all(marker in all_logs for marker in MARKERS.values())
    for job in sorted(jobs,key=lambda value:value['jobId']):
        name=job['jobId'];other='second' if name=='first' else 'first'
        text=act.read_logs(rpc,run,job['instanceId'],'',evidence=evidence)
        assert MARKERS[name] in text and MARKERS[other] not in text
        for step in job['steps']:
            text=act.read_logs(rpc,run,job['instanceId'],step['id'],evidence=evidence)
            assert MARKERS[other] not in text
            if step['id'] in ('write','fresh'):assert MARKERS[name] in text
    return evidence

def self_check():
    native={'id':12,'owner':{'id':13}};head='a'*40;blob='b'*40
    run={'id':str(uuid.uuid4()),'repositoryId':'12','ownerId':'13','commitId':head,'workflowPath':PATH,'workflowBlobId':blob,'sourceSha256':'c'*64,'attemptId':'d'*32,'state':'WORKFLOW_RUN_STATE_SUCCEEDED','origin':'WORKFLOW_RUN_ORIGIN_MANUAL','runnerId':'local-docker','engineCatalog':CATALOG,'engineCommit':ENGINE,'startedAt':'2026-10-04T00:00:00Z','finishedAt':'2026-10-04T00:00:09Z','jobs':[]}
    for index,(name,steps) in enumerate(STEPS.items()):
        start='2026-10-04T00:00:0'+str(index*4+1)+'Z';end='2026-10-04T00:00:0'+str(index*4+4)+'Z'
        run['jobs'].append({'jobId':name,'instanceId':act.instance(name,{}),'needs':['first'] if index else [],'state':act.STATE+'SUCCEEDED','eventsRecorded':True,'imageDigest':IMAGE,'startedAt':start,'finishedAt':end,'steps':[{'id':step,'state':act.STATE+'SUCCEEDED','startedAt':start if i==0 else end,'finishedAt':end} for i,step in enumerate(steps)]})
    check_run(run,native,head,blob)
    for changed in ('commit','identity','dependency','timestamp','steps','image','events','duplicate','truncated'):
        value=copy.deepcopy(run)
        if changed=='commit':value['commitId']='0'*40
        elif changed=='identity':value['repositoryId']='999'
        elif changed=='dependency':value['jobs'][1]['needs']=[]
        elif changed=='timestamp':value['jobs'][1]['startedAt']=value['jobs'][0]['startedAt']
        elif changed=='steps':value['jobs'][0]['steps'][0]['id']='invented'
        elif changed=='image':value['jobs'][0]['imageDigest']='unqualified'
        elif changed=='events':value['jobs'][0]['eventsRecorded']=False
        elif changed=='duplicate':value['jobs'][1]=copy.deepcopy(value['jobs'][0])
        else:value['logsTruncated']=True
        try:check_run(value,native,head,blob)
        except AssertionError:pass
        else:raise AssertionError('Unqualified graph accepted')
    def fixture_rpc(method,request,wrong=False):
        assert method=='WorkflowRunService/GetWorkflowRunLogs'
        job=request.get('jobInstanceId','');step=request.get('stepId','')
        name=next((v['jobId'] for v in run['jobs'] if v['instanceId']==job),None)
        text='\n'.join(MARKERS.values()) if not name else ('' if step=='source' else MARKERS[name])
        if wrong and name:text+='\n'+MARKERS['second' if name=='first' else 'first']
        return {'runId':run['id'],'attemptId':run['attemptId'],'repositoryId':run['repositoryId'],'sourceCommitId':head,'jobInstanceId':job,'stepId':step,'logs':[{'sequence':'1','text':text}] if text else []}
    check_logs(fixture_rpc,run,run['jobs'])
    for field in ('runId','attemptId','repositoryId','sourceCommitId','jobInstanceId','stepId','truncated'):
        def bad_receipt(method,request):
            row=fixture_rpc(method,request);row[field]=True if field=='truncated' else 'unbound';return row
        try:check_logs(bad_receipt,run,run['jobs'])
        except AssertionError:pass
        else:raise AssertionError('Unbound scoped log receipt accepted')
    try:check_logs(lambda method,request:fixture_rpc(method,request,True),run,run['jobs'])
    except AssertionError:pass
    else:raise AssertionError('Cross-job output accepted')
    try:safe_json({'private':'PRIVATE_SENTINEL'},['PRIVATE_SENTINEL'])
    except AssertionError:pass
    else:raise AssertionError('Private value accepted')
    # Static check prevents accidental callable shadowing in the runtime path.
    for node in ast.walk(ast.parse(Path(__file__).read_text())):
        for target in getattr(node,'targets',[]):
            assert not any(isinstance(v,ast.Name) and v.id in {'execute','command'} for v in ast.walk(target))
    print('PASS: pure two-job scope/order/scoped-log/privacy counterexamples; no resources.')

def main():
    global REPORT_FAILURE
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('image','runner-image','source-revision','expected-core-sha256','expected-runner-sha256','expected-engine-sha256'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seed-wait-seconds',type=int,default=300)

    args=parser.parse_args();stack=args.stack_root.resolve();output=args.output.resolve()
    assert 1<=args.seed_wait_seconds<=600 and not output.exists()
    assert re.fullmatch('[a-f0-9]{40}',args.source_revision)
    for digest in (args.expected_core_sha256,args.expected_runner_sha256,args.expected_engine_sha256):assert re.fullmatch('[a-f0-9]{64}',digest)
    files=source_files(stack)  # Refuse absent prepared fixture before resource operations.
    output.mkdir(parents=True,mode=0o700);output.chmod(0o700)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    forbidden=[];manifest={'complete':False,'passed':False,'proofKind':'maintained-actions-two-job-needs','sourceRevision':args.source_revision,'fixtureSha256':{path:hashlib.sha256(data).hexdigest() for path,data in files.items()},'limitations':['One input-free two-job manual maintained Actions run; no matrix, output, secrets, remote actions, failure/skip or cancellation qualification.','Current native before/after read authority is not an atomic native CAS.']}
    def redact(text):
        for value in forbidden:
            if value:text=text.replace(value,'[redacted]')
        return text
    def execute(*argv,payload=None,timeout=180,expected=0):
        result=subprocess.run(argv,input=None if payload is None else json.dumps(payload).encode(),cwd=stack,env=environment,capture_output=True,timeout=timeout)
        if result.returncode!=expected and not (output/'private-command-failure.json').exists():
            # Owner-only diagnostics survive exact-owned teardown. These bytes
            # can contain private CLI output; never include them in the manifest.
            assert len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20
            helpers.private_write(output/'private-command-failure.json',json.dumps({'stage':STAGE,'exitCode':result.returncode,'stdout':redact(result.stdout.decode(errors='replace')),'stderr':redact(result.stderr.decode(errors='replace'))}))
        assert result.returncode==expected and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Bounded subprocess failure; private output withheld'
        return result.stdout.decode().strip()
    def record(**items):
        manifest.update(items);path=output/'manifest.json.tmp';helpers.private_write(path,safe_json(manifest,forbidden));path.replace(output/'manifest.json')
    def failure(error):
        if 'originalFailure' not in manifest:
            record(originalFailure={'type':type(error).__name__,'stage':STAGE,'frames':[{'file':Path(v.filename).name if Path(v.filename).name in {Path(__file__).name,'actions-engine-smoke.py','workflow-notifications-smoke.py','observability-smoke.py','smoke.py'} else 'dependency','line':v.lineno} for v in traceback.extract_tb(error.__traceback__)[-6:]]})
    REPORT_FAILURE=failure
    record(stage=STAGE)
    def snapshot():
        ids=execute('docker','ps','-aq','--no-trunc').splitlines();assert len(ids)<=500
        if not ids:return {}
        template='{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}}},"RestartCount":{{json .RestartCount}}}'
        return notifications.filtered_foreign([json.loads(line) for line in execute('docker','inspect','--format',template,*ids).splitlines()])
    stage('cached immutable images/binaries and two-GiB reserve')
    images={}
    for role,ref in [('golf',args.image),('runner',args.runner_image),('native',NATIVE),('postgres',PG),('daemon',DIND)]:
        row=json.loads(execute('docker','image','inspect',ref))[0];assert re.fullmatch('sha256:[a-f0-9]{64}',row['Id']);images[role]=row['Id']
        if role in ('golf','runner'):assert ref==row['Id'] and (row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.source_revision
    binaries={}
    for role,binary,digest in [('golf','golf',args.expected_core_sha256),('runner','golf-runner',args.expected_runner_sha256),('golf','golf-actions-engine',args.expected_engine_sha256),('runner','golf-actions-engine',args.expected_engine_sha256)]:
        raw=execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/usr/bin/sha256sum',images[role],'/usr/local/bin/'+binary)
        assert raw.split()==[digest,'/usr/local/bin/'+binary];binaries[role+'/'+binary]=digest
    assert int(execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/').splitlines()[-1].split()[3])>=2*1024*1024
    before=snapshot();helpers.private_write(output/'foreign-before.json',json.dumps(before,indent=2))
    project=PROJECT_PREFIX+secrets.token_hex(5);ports=helpers.free_ports(3)
    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
    previous=smoke.GOLF,smoke.GITEA;smoke.GOLF=f'http://127.0.0.1:{ports[0]}';smoke.GITEA=f'http://127.0.0.1:{ports[1]}';secure=f'https://127.0.0.1:{ports[2]}'
    record(images=images,binarySha256=binaries,project=project,helperRevision=execute('git','rev-parse','HEAD'))
    actors={};started=False;passed=False;cleanup=[];bootstrap_created=False
    with tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700)
        ca,cert,key=directory/'ca.crt',directory/'server.crt',directory/'server.key'
        helpers.private_write(directory/'ca.conf','[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf two-job fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        helpers.private_write(directory/'extensions','basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(directory/'ca.conf'),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(directory/'server.csr'))
        execute('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(cert))
        for file in (ca,cert,key):file.chmod(0o444)
        worker_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        forbidden.extend(values[k] for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD','GOLF_ENCRYPTION_KEY','GOLF_RUNNER_KEY'))
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        overlay={'services':{'golf':{'image':images['golf'],'pull_policy':'never','mem_limit':'384m','environment':{'GITEA_URL':'http://gitea:3000','GOLF_ACTIONS_ENGINE_CATALOG':act.CATALOG}},'gitea':{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{'GITEA__server__ROOT_URL':smoke.GITEA+'/','GITEA__server__DISABLE_SSH':'true','GITEA__server__START_SSH_SERVER':'false','GITEA__actions__ENABLED':'false'}},'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m','command':['postgres','-c','max_wal_size=64MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s']},'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m'},'runner-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},'runner-actions-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'}}}
        helpers.private_write(directory/'services.json',json.dumps(overlay))
        helpers.private_write(directory/'ports.yaml',f'''services:
  golf:
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443"]
  gitea:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  postgres:
    volumes: !override ["{stack/'deploy/postgres/init.sh'}:/docker-entrypoint-initdb.d/01-golf.sh:ro"]
    tmpfs: ["/var/lib/postgresql:size=1073741824,mode=0700,uid=70,gid=70"]
''')
        compose=['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(directory/'proof.env')]
        for file in ('compose.yaml','compose.ci.yaml','compose.actions-engine.yaml','compose.runner-tls.yaml'):compose+=['-f',str(stack/file)]
        compose+=['-f',str(directory/'services.json'),'-f',str(directory/'ports.yaml')]
        def command(*argv,**kw):return execute(*compose,*argv,**kw)
        def admin(*argv):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv)
        def rpc(role,method,body=None,**kw):return smoke.rpc(actors[role]['session'],method,body,**kw)
        def metadata(sql):return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',sql)
        def runtime():
            result={}
            for role in ('golf','runner'):
                cid=command('ps','-q',role);assert cid
                row=json.loads(execute('docker','inspect',cid))[0];assert row['Image']==images[role] and row['Config']['Labels']['com.docker.compose.project']==project
                result[role]={'containerId':row['Id'],'image':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return result
        try:
            stage('fresh cached stack and verified TLS1.3 before any native actors')
            started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','runner-daemon');smoke.ready()
            context=ssl.create_default_context(cafile=str(ca));context.minimum_version=ssl.TLSVersion.TLSv1_3
            with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw:
                with context.wrap_socket(raw,server_hostname='127.0.0.1') as secured:assert secured.version()=='TLSv1.3'
            for ctx,name in ((context,'wrong.golf.invalid'),(ssl.create_default_context(),'127.0.0.1')):
                try:
                    with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw:ctx.wrap_socket(raw,server_hostname=name)
                except ssl.SSLCertVerificationError:pass
                else:raise AssertionError('Untrusted TLS endpoint accepted')
            old_tls=ssl.create_default_context(cafile=str(ca));old_tls.maximum_version=ssl.TLSVersion.TLSv1_2
            try:
                with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw:old_tls.wrap_socket(raw,server_hostname='127.0.0.1')
            except ssl.SSLError:pass
            else:raise AssertionError('TLS1.2 accepted')
            record(tls={'version':'TLSv1.3','serverAuthenticationOnly':True,'wrongHostnameDenied':True,'untrustedCADenied':True,'tls12Denied':True})
            daemon=command('ps','-q','runner-daemon');daemon_row=json.loads(execute('docker','inspect',daemon))[0]
            assert daemon_row['Image']==images['daemon'] and daemon_row['Config']['Labels']['com.docker.compose.project']==project
            seed={'schema':'golf.workflow-artifacts.seed.v1','project':project,'containerId':daemon_row['Id'],'containerImage':images['daemon'],'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_wait_seconds,'helperNeverPullsOrBuilds':True}
            helpers.private_write(output/'seed-pending.json',json.dumps(seed,indent=2));os.replace(output/'seed-pending.json',output/'seed.json')
            print('PREREQUISITE: operator-seed only owned fresh daemon '+daemon_row['Id']+' with exact approved Alpine/DinD images.',flush=True)
            def seeded():
                receipts=[]
                for ref in (IMAGE,DIND):
                    try:row=json.loads(command('exec','-T','runner-daemon','docker','image','inspect',ref))[0]
                    except AssertionError:return None
                    canonical=ref.split('@')[0].rsplit(':',1)[0]+'@'+ref.split('@')[1]
                    assert row['Os']=='linux' and re.fullmatch('sha256:[a-f0-9]{64}',row['Id']) and canonical in (row.get('RepoDigests') or [])
                    receipts.append({'reference':ref,'id':row['Id'],'registryDigest':canonical})
                return receipts
            record(seedReceipt=helpers.until(seeded,args.seed_wait_seconds))
            bootstrap=project+'-bootstrap';admin('create','--username',bootstrap,'--email',bootstrap+'@example.invalid','--random-password','--must-change-password=false','--admin');bootstrap_created=True
            assert smoke.provider('','GET','version')['version']=='1.27.3'
            for role in ('owner',):
                actor={'name':project+'-'+role,'session':smoke.client(),'created':False,'enrolled':False};actors[role]=actor
                actor.update(email=actor['name']+'@example.invalid',password=secrets.token_urlsafe(32));forbidden.append(actor['password'])
                admin('create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
                identity=smoke.provider(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is False;actor['id']=str(identity['id'])
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'}));assert result['state']=='complete';actor['enrolled']=True
                rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'two-job-actions','private':True,'auto_init':True},expected=201)
            repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            for path,data in files.items():smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(data).decode(),'message':'Controlled two-job Actions fixture'},expected=201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            blob=hashlib.sha1(b'blob '+str(len(files[PATH])).encode()+b'\0'+files[PATH]).hexdigest();target={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id'])}
            for scope in ('INSTANCE','REPOSITORY'):
                selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                policy=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy.get('revision','0'),'expectedAuthorityRevision':policy['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})

            stage('maintained two-job declaration and one exact admission')
            inspection=rpc('owner','WorkflowService/InspectWorkflows',{'repository':repository,'ref':head,'repositoryId':target['repositoryId']})
            assert inspection['repositoryId']==target['repositoryId'] and inspection['commitId']==head and inspection['executionCatalog']==CATALOG and inspection['executionEngineCommit']==ENGINE
            configurations=inspection.get('configurations',[]);assert len(configurations)==1 and configurations[0]['path']==PATH and configurations[0]['blobId']==blob and configurations[0]['format']=='WORKFLOW_FORMAT_GITHUB_ACTIONS' and configurations[0]['state']=='WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET' and configurations[0].get('manualPolicyAllowed') is True
            operation=str(uuid.uuid4());dispatch={'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':operation}
            run=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run']
            assert run['engineCatalog']==CATALOG and run['state']=='WORKFLOW_RUN_STATE_QUEUED' and run['commitId']==head and run['workflowBlobId']==blob and run['repositoryId']==target['repositoryId'] and run['ownerId']==target['ownerId']
            stage('actual TLS Docker maintained two-job producer')
            command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init');command('up','-d','--no-build','--pull','never','runner')
            initial=runtime();record(runtimeBefore=initial)
            def terminal():
                current=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']
                return current if current['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None
            observed=helpers.until(terminal,timeout=240)
            record(terminalRun={k:observed[k] for k in ('id','attemptId','state','engineCatalog','jobs','failureCode') if k in observed})
            if observed['state']!='WORKFLOW_RUN_STATE_SUCCEEDED':
                helpers.private_write(output/'private-runner-failure.log',redact(command('logs','--no-color','--tail','80','runner')))
                helpers.private_write(output/'private-run-output.json',redact(json.dumps(rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id']}))))
            assert observed['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and observed['engineCatalog']==CATALOG and not observed.get('inputContract') and not observed.get('executionBindingId')
            assert all(observed[k]==run[k] for k in ('id','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256')) and re.fullmatch('[a-f0-9]{32}',observed['attemptId'])
            jobs=check_run(observed,native,head,blob)
            log_evidence=check_logs(lambda method,payload:rpc('owner',method,payload),observed,jobs)
            def removed():
                containers=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
                volumes=command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
                return not containers and not volumes
            assert helpers.until(removed,timeout=45)
            stored=json.loads(metadata("SELECT jsonb_build_object('storage',source_storage,'sourceSha256',source_sha256,'archiveSha256',encode(sha256(source_archive),'hex'),'archiveSize',octet_length(source_archive),'graphEvents',(SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=r.id AND attempt_id=r.attempt_id)) FROM golf_workflow_runs r WHERE id='"+str(uuid.UUID(run['id']))+"'::uuid"))
            assert stored['storage']=='postgres' and stored['sourceSha256']==stored['archiveSha256']==observed['sourceSha256'] and 0<stored['archiveSize']<=16<<20 and stored['graphEvents']==11
            rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':run['id'],'jobInstanceId':'f'*32,'stepId':'forged'},expected=400)
            rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':run['id'],'jobInstanceId':act.instance('first',{}),'stepId':'fresh'},expected=400)
            record(run={k:observed[k] for k in ('id','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256','attemptId','state','engineCatalog','engineCommit','startedAt','finishedAt','jobs')},storedSource=stored,logReadbacks=log_evidence,dependencyOrderVerified=True,freshWorkspaceMarkerVerified=True,actualDockerCleanup={'attemptContainersAbsent':True,'attemptVolumesAbsent':True})
            stage('restart original immutable graph without replacement execution')
            command('restart','golf');smoke.ready()
            reread=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run'];check_run(reread,native,head,blob)
            for field in ('id','attemptId','state','jobs','sourceSha256','engineCatalog','engineCommit'):assert reread[field]==observed[field]
            assert check_logs(lambda method,payload:rpc('owner',method,payload),reread,reread['jobs'])==log_evidence
            original=rpc('owner','WorkflowRunService/GetWorkflowDispatch',target|{'commitId':head,'workflowPath':PATH,'idempotencyKey':operation})
            assert original['repository']==repository and original['repositoryId']==target['repositoryId'] and original['ownerId']==target['ownerId'] and original['nativeActorId']==owner['id'] and original['idempotencyKey']==operation
            assert all(original['run'][field]==observed[field] for field in ('id','attemptId','state','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256','engineCatalog')) and original['run'].get('canCancel',False) is False
            replay=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run'];assert replay['id']==observed['id'] and replay['attemptId']==observed['attemptId'] and replay['state']==observed['state']
            assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==1 and helpers.until(removed,timeout=30)
            assert runtime()==initial
            record(restart={'originalRunAndAttemptUnchanged':True,'originalDispatchNoReplay':True,'runCount':1},runtimeAfter=runtime())
            passed=True
        except Exception as error:
            if started:
                try:helpers.private_write(output/'private-postgres-failure.log',redact(command('logs','--no-color','--tail','100','postgres')))
                except Exception:pass
            failure(error);raise
        finally:
            if started:
                try:command('stop','runner')
                except Exception:cleanup.append('worker-stop')
                for actor in actors.values():
                    if actor.get('enrolled'):
                        try:smoke.rpc(actor['session'],'SessionService/RevokeOtherSessions');smoke.rpc(actor['session'],'SessionService/Logout')
                        except Exception:cleanup.append('session-cleanup')
                        try:command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                        except Exception:cleanup.append('account-disable')
                    if actor.get('created'):
                        try:admin('delete','--username',actor['name'],'--purge')
                        except Exception:cleanup.append('native-actor-purge')
                try:
                    command('down','--volumes','--remove-orphans')
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
                except Exception:cleanup.append('owned-resources')
            try:
                after=snapshot();helpers.private_write(output/'foreign-after.json',json.dumps(after,indent=2));difference=notifications.foreign_diff(before,after);record(foreignComparison=difference,foreignIdentityUnchanged=difference['identityUnchanged']);assert difference['identityUnchanged']
            except Exception:cleanup.append('foreign-identity')
            smoke.GOLF,smoke.GITEA=previous
            record(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,bootstrap={'unmanagedTokenlessAdministrator':bootstrap_created,'disposedWithOwnedNativeVolume':started and 'owned-resources' not in cleanup},lastStage=STAGE)
            if 'originalFailure' not in manifest:assert not cleanup
    assert passed
    print('PASS: bounded actual maintained two-job needs/fresh-workspace/scoped-log proof; broader acceptance remains open.')


if __name__=='__main__':
    try:
        if '--self-check' in sys.argv:self_check()
        else:main()
    except Exception as error:
        if REPORT_FAILURE is not None:
            try:REPORT_FAILURE(error)
            except Exception:pass
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
