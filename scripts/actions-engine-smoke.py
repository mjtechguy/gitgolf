#!/usr/bin/env python3
"""Fresh Compose proof of the opt-in pinned Actions graph (requires built images).

Uses supported native APIs/operator CLI and product password-authenticated RPCs.
Runs the unchanged controlled production/local-composite and mixed-matrix fixtures.
No retained-stack policy changes, inference, remote repository writes or broad
Actions/GitLab parity claim. Credentials/output stay private; stdout is stages.
Owner-only manifest contains receipts/metadata, never credentials or raw logs.
Source checking this launcher is not actual runtime qualification.
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
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('actions_observe_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
CATALOG = 'golf.workflow.act.v0.2.89.linux.v1'
ENGINE = '4f411281417e88660bea1c1a1749aa71ae0bd60f'
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
STATE = 'WORKFLOW_STEP_STATE_'
STAGE = 'arguments'


# Only closed operational codes are retained from trusted worker output.
WORKER_STAGES = {'input_validation','worker_residue_check','daemon_image_validation','job_image_validation','owner_generation','volume_creation','daemon_creation','daemon_receipt_validation','daemon_start','daemon_readiness','image_transfer','helper_transfer','helper_local_hash','helper_remote_hash','helper_process_start','helper_input','helper_frames','durable_frame_ack','helper_ack_write','helper_completion','container_cleanup','volume_cleanup','unknown','coordinator_preparation'}
def worker_failure_stages(text):
    return sorted({line.removeprefix('Golf Actions lifecycle failure: stage=') for line in text.splitlines() if line.startswith('Golf Actions lifecycle failure: stage=') and line.removeprefix('Golf Actions lifecycle failure: stage=') in WORKER_STAGES})


def stage(label):
    global STAGE
    STAGE = label
    print('CHECK: '+label, flush=True)


def instance(job, matrix):
    raw = json.dumps(matrix, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256((job+'\0'+raw).encode()).hexdigest()[:32]


def expectations(mixed=False):
    if mixed:
        return {
            instance('cells', {'cell':'a'}): ('cells', {'cell':'a'}, [], 'FAILED', {'cell':'FAILED','ownfailure':'SUCCEEDED','ownsuccess':'SKIPPED'}),
            instance('cells', {'cell':'b'}): ('cells', {'cell':'b'}, [], 'SUCCEEDED', {'cell':'SUCCEEDED','ownfailure':'SKIPPED','ownsuccess':'SUCCEEDED'}),
            instance('aftermath', {}): ('aftermath', {}, ['cells'], 'SUCCEEDED', {'dependency':'SUCCEEDED'}),
            instance('skipped', {}): ('skipped', {}, ['cells'], 'SKIPPED', {'0':'SKIPPED'}),
        }
    return {
        instance('build', {}): ('build', {}, [], 'SUCCEEDED', {'emit':'SUCCEEDED'}),
        instance('test', {'cell':'a'}): ('test', {'cell':'a'}, ['build'], 'SUCCEEDED', {'tamper':'SUCCEEDED','local':'SUCCEEDED','conditional':'SKIPPED'}),
        instance('test', {'cell':'c'}): ('test', {'cell':'c'}, ['build'], 'SUCCEEDED', {'tamper':'SUCCEEDED','local':'SUCCEEDED','conditional':'SKIPPED'}),
        instance('lint', {}): ('lint', {}, ['build'], 'SUCCEEDED', {'lint':'SUCCEEDED'}),
        instance('package', {}): ('package', {}, ['test','lint'], 'SUCCEEDED', {'package':'SUCCEEDED'}),
    }


def stamp(value):
    assert isinstance(value, str) and value, 'Missing genuine observation timestamp'
    return datetime.fromisoformat(value.replace('Z','+00:00'))


def check_run(run, native, head, workflow, blob, mixed=False):
    assert str(uuid.UUID(run['id']))==run['id'], 'Invalid run identity'
    assert run['repositoryId']==str(native['id']) and run['ownerId']==str(native['owner']['id']), 'Native target receipt differs'
    assert run['commitId']==head and run['workflowPath']==workflow and run['workflowBlobId']==blob, 'Frozen source receipt differs'
    assert run['engineCatalog']==CATALOG and run['engineCommit']==ENGINE, 'Pinned engine differs'
    assert re.fullmatch('[a-f0-9]{32}',run['attemptId']) and re.fullmatch('[a-f0-9]{64}',run['sourceSha256']), 'Missing actual attempt/archive receipt'
    assert run['state']=='WORKFLOW_RUN_STATE_'+('FAILED' if mixed else 'SUCCEEDED'), 'Unexpected actual engine outcome'
    assert run['origin']=='WORKFLOW_RUN_ORIGIN_MANUAL' and run['runnerId']=='local-docker', 'Unexpected dispatch/worker receipt'
    assert 'exitCode' not in run and 'progress' not in run, 'Engine invented legacy shell exit/progress'
    assert stamp(run['startedAt'])<=stamp(run['finishedAt']) and not run.get('logsTruncated',False)
    expected=expectations(mixed)
    jobs=run.get('jobs',[])
    assert len(jobs)==len(expected) and {j['instanceId'] for j in jobs}==set(expected), 'Incomplete/duplicate/unadmitted instance inventory'
    by_id={j['instanceId']:j for j in jobs}
    for item in jobs:
        job,matrix,needs,outcome,steps=expected[item['instanceId']]
        actual={row['name']:json.loads(row['valueJson']) for row in item.get('matrix',[])}
        assert len(actual)==len(item.get('matrix',[])) and actual==matrix and item['jobId']==job
        assert item.get('needs',[])==needs and item['state']==STATE+outcome and item['eventsRecorded'] is True
        assert item['imageDigest']==IMAGE, 'Actual admitted job image differs'
        assert {s['id'] for s in item['steps']}==set(steps) and len(item['steps'])==len(steps)
        if outcome=='SKIPPED':
            assert 'startedAt' not in item
        else:
            assert stamp(item['startedAt'])<=stamp(item['finishedAt'])
            for dependency in needs:
                for other in by_id.values():
                    if other['jobId']==dependency:
                        assert stamp(other['finishedAt'])<=stamp(item['startedAt']), 'Dependent job started before complete predecessor inventory'
        stamp(item['finishedAt'])
        for step in item['steps']:
            assert step['state']==STATE+steps[step['id']]
            if steps[step['id']]=='SKIPPED':
                assert 'startedAt' not in step, 'Skipped source step pretends it ran'
            else:
                assert stamp(step['startedAt'])<=stamp(step['finishedAt'])
    return jobs


def read_logs(rpc, run, job=None, step=None):
    after=0; rows=[]
    for _ in range(64):
        request={'runId':run['id'],'afterSequence':str(after)}
        if job:request.update(jobInstanceId=job,stepId=step)
        page=rpc('WorkflowRunService/GetWorkflowRunLogs',request)
        for key in ('runId','attemptId','repositoryId','sourceCommitId'):
            original={'runId':'id','sourceCommitId':'commitId'}.get(key,key)
            assert page[key]==run[original], 'Scoped log target/snapshot receipt differs'
        assert page.get('jobInstanceId','')==(job or '') and page.get('stepId','')==(step or '')
        assert not page.get('truncated',False)
        values=page.get('logs',[])
        assert len(values)<=16
        for value in values:
            sequence=int(value['sequence'])
            assert sequence>after and (bool(job) or sequence==after+1), 'Log continuation duplicated/skipped unsliced output'
            after=sequence;rows.append(value)
        if not page.get('hasMore',False):return ''.join(row['text'] for row in rows)
        assert values, 'Log cursor did not advance'
    raise AssertionError('Bounded log pagination exhausted')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True,help='already-built local exact Golf image/reference')
    parser.add_argument('--runner-image',required=True,help='already-built local exact runner image/reference')
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    parser.add_argument('--output-dir',type=Path,required=True,help='new owner-only metadata artifact directory')
    parser.add_argument('--ui-screenshots',type=Path,help='optional new actual browser artifact directory; requires graph-capable ci-ui-browser.mjs and local Playwright')
    args=parser.parse_args()
    stack=args.stack_root.resolve(); output=args.output_dir.resolve()
    assert not output.exists(), 'Output must be a new directory'
    output.mkdir(parents=True,mode=0o700);output.chmod(0o700)
    for path in ('compose.yaml','compose.ci.yaml','compose.actions-engine.yaml'):
        assert (stack/path).is_file(), 'Missing frozen Actions stack source'
    screenshots=None
    if args.ui_screenshots:
        screenshots=args.ui_screenshots.resolve()
        assert not screenshots.exists(), 'Browser output must be a new directory'
        screenshots.mkdir(parents=True,mode=0o700);screenshots.chmod(0o700)
        assert (stack/'scripts/ci-ui-browser.mjs').is_file() and (stack/'web/node_modules/playwright/index.mjs').is_file(), 'Local graph browser helper/Playwright missing'
    fixture=ROOT/'engines/act/testdata'
    files={'.github/workflows/graph.yml':(fixture/'production-graph.yml').read_bytes(),
           '.github/workflows/mixed.yml':(fixture/'mixed-matrix.yml').read_bytes(),
           'actions/owned/action.yml':(fixture/'actions/owned/action.yml').read_bytes()}
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    def run(*args,payload=None,timeout=180):
        result=subprocess.run(args,input=None if payload is None else json.dumps(payload).encode(),cwd=stack,env=environment,capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20, 'Bounded subprocess failed; output withheld'
        return result.stdout.decode()
    core_record=json.loads(run('docker','image','inspect',args.image))[0]
    core=core_record['Id']; worker=json.loads(run('docker','image','inspect',args.runner_image))[0]['Id']
    assert re.fullmatch('sha256:[a-f0-9]{64}',core) and re.fullmatch('sha256:[a-f0-9]{64}',worker)
    stage('exact local images and fresh-stack disk reserve')
    space=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core,'-Pk','/')
    assert int(space.strip().splitlines()[-1].split()[3])>=2*1024*1024, 'Less than 2 GiB Docker VM startup reserve'
    project='golf-act-proof-'+secrets.token_hex(5)
    ports=helpers.free_ports(2)
    old_urls=smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA=f'http://127.0.0.1:{ports[0]}',f'http://127.0.0.1:{ports[1]}'
    manifest={'complete':False,'passed':False,'catalog':CATALOG,'engineCommit':ENGINE,'golfImageId':core,'runnerImageId':worker,
              'workingTreeHead':run('git','rev-parse','HEAD').strip(),'servedSourceCommit':None,
              'sourceProvenance':'OCI revision label only; working-tree HEAD is not served-source evidence', 'fixtureSha256':{p:hashlib.sha256(b).hexdigest() for p,b in files.items()},'runs':[],
              'limits':'Manual graph/mixed-matrix; browser only when optional helper actually passes. No automatic push, cancellation, kill/recovery, full catalog or VM isolation proof.'}
    revision=(core_record.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    if isinstance(revision,str) and re.fullmatch('[a-f0-9]{40}',revision):manifest['servedSourceCommit']=revision
    actor=None; session=None; started=False; native_created=False; enrolled=False; cleanup=[]
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700)
        key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,
                      GOLF_RUNNER_KEY=key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),
                      GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]))
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
''')
        compose=['docker','compose','-p',project,'--env-file',str(env_file)]
        for file in ('compose.yaml','compose.ci.yaml','compose.actions-engine.yaml'):compose+=['-f',str(stack/file)]
        compose+=['-f',str(override)]
        def command(*args,**kw):return run(*compose,*args,**kw)
        def admin(*args):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*args).strip()
        def rpc(method,body=None,**kw):return smoke.rpc(session,method,body,**kw)
        def runtime():
            identifier=command('ps','-q','golf').strip(); observed=json.loads(run('docker','inspect',identifier))[0]
            assert observed['Image']==core, 'Actual served local image differs'
            return {'containerImageReference':observed['Image'],'resolvedLocalImageId':core,'suppliedImageReference':args.image,'composeConfigHash':observed['Config']['Labels']['com.docker.compose.config-hash']}
        try:
            stage('fresh core defaults deny; supported managed/native fixture')
            started=True;command('up','-d','--no-build','--wait','--wait-timeout','120','postgres','gitea','golf');smoke.ready()
            baseline=runtime();manifest['runtimeBefore']=baseline
            actor='act-'+secrets.token_hex(5)
            admin('create','--username',actor,'--email',actor+'@example.invalid','--random-password','--must-change-password=false');native_created=True
            token=admin('generate-access-token','--username',actor,'--token-name',project,'--scopes','write:user,write:organization,write:repository,write:issue','--raw')
            password='Golf engine fixture '+secrets.token_urlsafe(24)
            command('exec','-T','golf','golf','local-account','create',payload={'username':actor,'email':actor+'@example.invalid','password':password,'forge_token':token,'is_instance_admin':True});enrolled=True
            session=smoke.client();rpc('SessionService/LoginWithPassword',{'username':actor+'@example.invalid','password':password})
            native=smoke.provider(token,'POST','user/repos',{'name':'engine-proof','private':True,'auto_init':True},expected=201)
            repository={'owner':actor,'name':'engine-proof'};base='repos/'+actor+'/engine-proof'
            for path,body in files.items():smoke.provider(token,'POST',base+'/contents/'+path,{'content':base64.b64encode(body).decode(),'message':'Controlled Actions engine fixture'},expected=201)
            branch=smoke.provider(token,'GET',base+'/branches/'+native['default_branch']);head=branch['commit']['id']
            assert re.fullmatch('[a-f0-9]{40}',head)
            inspection=rpc('WorkflowService/InspectWorkflows',{'repository':repository,'repositoryId':str(native['id']),'ref':head})
            assert inspection['repositoryId']==str(native['id']) and inspection['commitId']==head and inspection['executionCatalog']==CATALOG and inspection['executionEngineCommit']==ENGINE
            configurations={row['path']:row for row in inspection['configurations']}
            assert set(configurations)=={p for p in files if p.startswith('.github/')}
            for config in configurations.values():
                assert config['state']=='WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET' and config.get('manualPolicyAllowed') is False and config.get('pushPolicyAllowed') is False
            rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':'.github/workflows/graph.yml','idempotencyKey':str(uuid.uuid4())},expected=403)
            for scope in ('INSTANCE','REPOSITORY'):
                target={'scope':'EXECUTION_SCOPE_'+scope}
                if scope=='REPOSITORY':target['repository']=repository
                old=rpc('ExecutionPolicyService/GetExecutionPolicy',target)['policy']
                rpc('ExecutionPolicyService/UpdateExecutionPolicy',{**target,'scopeId':old['scopeId'],'expectedRevision':old.get('revision','0'),'expectedAuthorityRevision':old['authorityRevision'],
                    'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('pinned child-daemon initialization and actual production graph')
            command('up','-d','--no-build','runner',timeout=300)
            for mixed,path in ((False,'.github/workflows/graph.yml'),(True,'.github/workflows/mixed.yml')):
                stage('actual mixed-matrix per-instance outcomes' if mixed else 'actual immutable composite/outputs/DAG graph')
                intent=str(uuid.uuid4());queued=rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':path,'idempotencyKey':intent})['run']
                deadline=time.monotonic()+300
                while time.monotonic()<deadline:
                    observed=rpc('WorkflowRunService/GetWorkflowRun',{'runId':queued['id']})['run']
                    if observed['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING'):break
                    time.sleep(.25)
                else:raise AssertionError('Bounded actual run deadline exhausted')
                blob=hashlib.sha1(b'blob '+str(len(files[path])).encode()+b'\0'+files[path]).hexdigest()
                receipt={key:observed[key] for key in ('id','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256','attemptId','state','engineCatalog','engineCommit','startedAt','finishedAt','jobs') if key in observed}
                receipt['verified']=False;manifest['runs'].append(receipt)
                jobs=check_run(observed,native,head,path,blob,mixed)
                # Read-only Golf evidence: hash retained bytes inside PostgreSQL;
                # no source/ciphertext is extracted and no live database writes.
                query=("SELECT json_build_object('repositoryId',repository_id::text,'commitId',commit_id,'blobId',blob_id,"
                       "'storage',source_storage,'sourceSha256',source_sha256,'archiveSha256',encode(sha256(source_archive),'hex'),"
                       "'archiveSize',octet_length(source_archive),'graphEvents',(SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=r.id)) "
                       "FROM golf_workflow_runs r WHERE id='"+observed['id']+"'::uuid")
                stored=json.loads(command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',query))
                assert stored['storage']=='postgres' and stored['repositoryId']==str(native['id']) and stored['commitId']==head and stored['blobId']==blob
                assert stored['sourceSha256']==stored['archiveSha256']==observed['sourceSha256'] and 0<stored['archiveSize']<=16<<20
                assert stored['graphEvents']==(20 if mixed else 27), 'Incomplete/extra durable native graph receipts'
                receipt['storedSource']=stored

                replay=rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':path,'idempotencyKey':intent})['run']
                assert replay['id']==observed['id'] and replay['attemptId']==observed['attemptId'], 'Explicit same-key replay changed effect identity'
                all_logs=read_logs(rpc,observed)
                for job in jobs:
                    for step in job['steps']:
                        text=read_logs(rpc,observed,job['instanceId'],step['id'])
                        if step['state']==STATE+'SKIPPED':assert not text, 'Skipped step produced scoped source logs'
                        if not mixed and step['id']=='tamper':assert 'Protected composite remained immutable' in text and 'UNSAFE' not in text
                        if not mixed and step['id']=='local':assert 'Actual local composite output received' in text
                        if mixed and job['jobId']=='cells' and json.loads(job['matrix'][0]['valueJson'])=='b' and step['id']=='cell':assert 'successful-own-cell' in text and 'own-cell-failure-handler' not in text
                        if mixed and step['id']=='ownfailure' and step['state']==STATE+'SUCCEEDED':assert 'own-cell-failure-handler' in text and 'successful-own-cell' not in text
                assert all_logs and 'UNSAFE' not in all_logs
                rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id'],'jobInstanceId':'f'*32,'stepId':'forged'},expected=400)
                receipt['verified']=True
                if screenshots and not mixed:
                    stage('actual production-graph inventory/run/local-step browser receipts')
                    selected=instance('test',{'cell':'a'})
                    browser=run('node',str(stack/'scripts/ci-ui-browser.mjs'),payload={
                        'golf':smoke.GOLF,'screenshots':str(screenshots),'actor':{'name':actor,'email':actor+'@example.invalid','password':password},
                        'repository':repository,'repositoryId':str(native['id']),'run':observed,
                        'runtime':baseline,'workingTreeHead':manifest['workingTreeHead'],'servedSourceCommit':manifest['servedSourceCommit'],
                        'servedSourceProvenance':manifest['sourceProvenance'],
                        'graphSelection':{'jobInstanceId':selected,'stepId':'local','logMarker':'Actual local composite output received','otherLogMarker':'Protected composite remained immutable'}},timeout=240)
                    assert len(browser)<4096 and browser.strip().splitlines()[-1].startswith('PASS: twelve actual Actions screenshots,'), 'Bounded actual browser helper failed'
                    assert runtime()==baseline, 'Served image/config changed during actual browser proof'
                    capture_manifest=json.loads((screenshots/'manifest.json').read_text())
                    assert capture_manifest.get('complete') and capture_manifest.get('passed') and len(capture_manifest.get('results',[]))==12
                    capture_manifest['runtimeAfter']=runtime();capture_manifest['runtimeStable']=True
                    helpers.private_write(screenshots/'manifest.json',json.dumps(capture_manifest,indent=2)+'\n')
                    manifest['browser']={'passed':True,'captures':12,'graphSelection':selected+'/local','runtimeStable':True}
                helpers.until(lambda:not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true').strip(),timeout=30)
                assert not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true').strip(), 'Owned data volume retained'
            assert runtime()==baseline, 'Served image/config changed during proof'
            manifest['runtimeAfter']=runtime();manifest['passed']=True
            print('PASS: actual manual five-instance graph and four-instance mixed matrix, exact source/attempt/graph/scoped-log receipts.',flush=True)
        finally:
            if started:
                try:manifest['workerFailureStages']=worker_failure_stages(command('logs','--no-log-prefix','--tail','100','runner'))
                except Exception:manifest['workerDiagnosticsUnavailable']=True
            if session is not None:
                try:rpc('SessionService/RevokeOtherSessions');rpc('SessionService/Logout')
                except Exception:cleanup.append('managed session cleanup')
            if enrolled:
                try:command('exec','-T','golf','golf','local-account','disable',payload={'username':actor})
                except Exception:cleanup.append('managed account disable')
            if native_created:
                try:admin('delete','--username',actor,'--purge')
                except Exception:cleanup.append('native actor purge')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for args in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):
                        assert not run('docker',*args,'--filter','label=com.docker.compose.project='+project).strip(), 'Fresh owned Compose resource retained'
            except Exception:
                cleanup.append('fresh Compose resource teardown')
            finally:
                smoke.GOLF,smoke.GITEA=old_urls
                manifest['lastCheck']=STAGE;manifest['cleanupPassed']=not cleanup;manifest['complete']=manifest['passed'] and not cleanup
                helpers.private_write(output/'manifest.json',json.dumps(manifest,indent=2)+'\n')
            assert not cleanup, 'Fixture cleanup failed; private details withheld'
            print('Cleanup: managed accounts disabled/sessions revoked, native fixture purged, fresh Compose project/volumes removed.',flush=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
