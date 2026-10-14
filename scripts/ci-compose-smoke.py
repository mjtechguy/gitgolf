#!/usr/bin/env python3
"""Real disposable Compose shell-CI proof; never modifies the retained installation.

Requires locally built Golf/runner images. It exercises both workflow formats,
policy denial/revocation, durable queues across restart and runner cleanup.
--objects additionally provisions private RustFS storage and qualifies persisted
S3 source bindings without retaining source archives in PostgreSQL.
--ui-screenshots additionally captures the actual successful Actions inventory,
run and selected-step workspace in both themes at desktop/mobile widths,
including a real inventory link click and selected-run reload.
No hosted-engine, artifact/cache/secret or trusted-merge compatibility is claimed.
"""
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
import time
import uuid

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('observe_helpers', ROOT/'scripts/observability-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'
STAGE = 'prerequisites'

def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--runner-image', required=True)
    parser.add_argument('--objects', action='store_true', help='qualify private RustFS-backed CI sources using the storage overlay')
    parser.add_argument('--ui-screenshots', type=Path, help='owner-only output directory for optional actual Actions browser proof (requires local Playwright)')
    args = parser.parse_args()
    forge = 'forgejo'
    workflow_dir = '.forgejo/workflows'
    def action_path(name): return workflow_dir + "/" + name

    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_','GITEA_','FORGEJO_','POSTGRES_','COMPOSE_','OTEL_','RUSTFS_','AWS_')) and key!='DATABASE_URL'}
    def run(*command, payload=None, timeout=180):
        result = subprocess.run(command, input=None if payload is None else json.dumps(payload).encode(), cwd=ROOT, env=environment, capture_output=True, timeout=timeout)
        assert result.returncode == 0, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode()
    core_image = json.loads(run('docker','image','inspect',args.image))[0]
    core = core_image['Id']
    worker = json.loads(run('docker','image','inspect',args.runner_image))[0]['Id']
    print('Golf image: '+core, flush=True)
    print('Runner image: '+worker, flush=True)
    screenshots = None
    if args.ui_screenshots:
        screenshots = args.ui_screenshots.resolve()
        assert not screenshots.exists() or not any(screenshots.iterdir()), 'Browser output must be a new or empty directory'
        screenshots.mkdir(parents=True, exist_ok=True); screenshots.chmod(0o700)
        assert (ROOT/'web/node_modules/playwright/index.mjs').is_file(), 'Local Playwright is required for optional browser proof'
        # The already resolved local Golf image sees the Docker VM filesystem. Never pull
        # or prune: leave 1 GiB reserve plus 1 GiB startup headroom before Compose.
        space = run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core,'-Pk','/')
        assert int(space.strip().splitlines()[-1].split()[3]) >= 2*1024*1024, 'Insufficient Docker VM free-space reserve'
        print('PASS: Docker VM has at least 2 GiB available before fresh-stack startup.', flush=True)
    project = 'golf-ci-proof-'+secrets.token_hex(5)
    golf_port, native_port = helpers.free_ports(2)
    previous = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{golf_port}', f'http://127.0.0.1:{native_port}'
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values = {name:secrets.token_hex(24) for name in ['POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD']}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF,
            GOLF_RUNNER_KEY=key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]))
        values['GOLF_FORGE_INSTANCE_ID'] = str(uuid.uuid4())
        if args.objects:
            values.update(RUSTFS_ACCESS_KEY='golf-proof-'+secrets.token_hex(12), RUSTFS_SECRET_KEY=secrets.token_hex(32))
        env_file, override = directory/'core.env',directory/'proof.yaml'
        helpers.private_write(env_file, ''.join(name+"='"+value+"'\n" for name,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {core}
    pull_policy: never
    ports: !override ["127.0.0.1:{golf_port}:8080"]
  {forge}:
    environment:
      {forge.upper()}__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{native_port}:3000"]
  runner:
    image: {worker}
    pull_policy: never
''')
        compose = ['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(ROOT/'deploy/compose/compose.ci.yaml')]
        if args.objects:
            compose += ['-f',str(ROOT/'deploy/compose/compose.storage.yaml')]
        compose += ['-f',str(override)]
        def command(*arguments, **kwargs): return run(*compose,*arguments,**kwargs)
        def runtime():
            identifier=command('ps','-q','golf').strip()
            assert identifier and '\n' not in identifier, 'Expected exactly one proof Golf container'
            observed=json.loads(run('docker','inspect',identifier))[0]
            return {'containerImageReference':observed['Image'], 'resolvedLocalImageId':core,
                    'composeConfigHash':observed['Config']['Labels']['com.docker.compose.config-hash'],
                    'suppliedImageReference':args.image}
        def admin(*arguments): return command('exec','-T',forge,forge,'--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*arguments).strip()
        def rpc(method,body=None,expected=200,code=None): return smoke.rpc(session,method,body,expected=expected,code=code)
        def wait_run(identifier,state=None):
            deadline=time.monotonic()+90
            while time.monotonic()<deadline:
                item=rpc('WorkflowRunService/GetWorkflowRun',{'runId':identifier})['run']
                if state and item['state']==state and (state!='WORKFLOW_RUN_STATE_RUNNING' or any(step.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for step in item.get('progress',{}).get('steps',[]))): return item
                if not state and item['state'] not in ['WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING']: return item
                time.sleep(.5)
            raise AssertionError('Run did not reach expected state')
        def policy(scope,repository=None):
            request={'scope':'EXECUTION_SCOPE_'+scope}
            if repository:request['repository']=repository
            return rpc('ExecutionPolicyService/GetExecutionPolicy',request)['policy']
        def update(scope,old,enabled,repository=None,manual=None,push=False):
            request={'scope':'EXECUTION_SCOPE_'+scope,'scopeId':old['scopeId'],'expectedRevision':old.get('revision','0'),'expectedAuthorityRevision':old['authorityRevision'],
                'mode':'EXECUTION_MODE_ALL' if enabled else 'EXECUTION_MODE_DISABLED','manualDispatchEnabled':enabled if manual is None else manual,'pushAllowed':push,'allowAllWorkflows':enabled}
            if repository:request['repository']=repository
            return rpc('ExecutionPolicyService/UpdateExecutionPolicy',request)['policy']
        def observe_policy(manual,push):
            response=rpc('WorkflowService/InspectWorkflows',{'repository':repository,'repositoryId':str(native['id'])})
            assert response['repositoryId']==str(native['id']), 'Inspection native identity mismatch'
            revision=response.get('policyRevision','')
            assert len(revision)==64 and all(c in '0123456789abcdef' for c in revision), 'Policy observation revision missing'
            configurations=response.get('configurations',[])
            assert len(configurations)==len(files), 'Unexpected workflow observation count'
            assert {item.get('path') for item in configurations}==set(files), 'Inspection source path set mismatch'
            assert all(item.get('manualPolicyAllowed') is manual and item.get('pushPolicyAllowed') is push for item in configurations), 'Independent policy observations mismatch'
            return revision
        def dispatch(file,key=None):return rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'workflowPath':file,'idempotencyKey':key or str(uuid.uuid4())})['run']
        def object_source(identifier):
            assert str(uuid.UUID(identifier)) == identifier, 'Invalid source run identity'
            query = ("SELECT json_build_object('storage',source_storage,'key',source_key,'sha',source_sha256,"
                     "'fingerprint',source_fingerprint,'archiveAbsent',source_archive IS NULL,"
                     "'profileAbsent',source_profile_id IS NULL AND source_profile_version IS NULL) "
                     "FROM golf_workflow_runs WHERE id='"+identifier+"'::uuid")
            record = json.loads(command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',query))
            assert record['storage'] == 'env_s3' and record['archiveAbsent'] and record['profileAbsent'], 'Source was not exclusively bound to operator S3 storage'
            assert len(record['sha']) == 64 and all(c in '0123456789abcdef' for c in record['sha'])
            assert record['key'] == 'ci-sources/'+record['sha']+'.tar'
            assert len(record['fingerprint']) == 64 and all(c in '0123456789abcdef' for c in record['fingerprint'])
            return record
        def storage_ready():
            command('exec','-T','rustfs','curl','--fail','--silent','--output','/dev/null','http://localhost:9000/health',timeout=10)
            return True
        started=False
        try:
            stage('fresh portable core and enrolled worker configuration; policies default deny')
            started=True
            command('up','-d','--no-build','--wait','--wait-timeout','120','postgres',forge,'golf')
            smoke.ready()
            if args.objects:
                stage('private RustFS health and explicit bucket provisioning')
                helpers.until(storage_ready,timeout=45)
                provisioned = command('exec','-T','golf','golf','objectstore','initialize')
                assert 'verification passed' in provisioned, 'Object bucket write/read initialization did not complete'
            name='ci-'+secrets.token_hex(5)
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
            token=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:organization,write:repository,write:issue','--raw')
            password='Golf pipeline proof '+secrets.token_urlsafe(24)
            command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':name+'@example.invalid','password':password,'forge_token':token,'is_instance_admin':True})
            session=smoke.client()
            rpc('SessionService/LoginWithPassword',{'username':name+'@example.invalid','password':password})
            native=smoke.provider(token,'POST','user/repos',{'name':'pipeline-proof','private':True,'auto_init':True},expected=201)
            repository={'owner':name,'name':'pipeline-proof'}
            base='repos/'+name+'/pipeline-proof'
            files={
              action_path('actions.yml'): 'name: Actions proof\non:\n  workflow_dispatch: {}\n  push: {}\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - name: Read source\n        run: |\n          test "$(id -u)" = 1000\n          test -f README.md\n          export STEP_PRIVATE=first\n          printf "actions proof\\n"\n      - name: Verify workspace\n        run: |\n          test -z "${STEP_PRIVATE:-}"\n          test -f README.md\n          printf "second step proof\\n"\n',
              '.gitlab-ci.yml': (ROOT/'docs/compatibility/fixtures/gitlab-shell.yml').read_text(),
              action_path('failure.yml'): 'on: workflow_dispatch\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - run: exit 7\n      - run: printf "must not execute\\n"\n',
              action_path('slow.yml'): 'on: workflow_dispatch\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - run: sleep 60\n',
              action_path('logs.yml'): 'on: workflow_dispatch\njobs:\n  proof:\n    runs-on: linux\n    steps:\n      - run: |\n          i=0\n          while [ "$i" -lt 24 ]; do\n            printf "%8192s\\n" "bounded log page"\n            i=$((i + 1))\n          done\n          printf "GOLF_LOG_FINAL\\n"\n',
            }
            for file,content in files.items():smoke.provider(token,'POST',base+'/contents/'+file,{'content':base64.b64encode(content.encode()).decode(),'message':'Add controlled pipeline fixture'},expected=201)
            rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'workflowPath':action_path('actions.yml'),'idempotencyKey':str(uuid.uuid4())},expected=403)
            stage('known default deny and independent manual/push ceilings on actual inspection')
            default_revision=observe_policy(False,False)
            instance=update('INSTANCE',policy('INSTANCE'),True,push=True)
            repo_policy=update('REPOSITORY',policy('REPOSITORY',repository),True,repository,push=True)
            both_revision=observe_policy(True,True)
            assert both_revision!=default_revision
            repo_policy=update('REPOSITORY',repo_policy,True,repository,manual=False,push=True)
            push_revision=observe_policy(False,True)
            assert push_revision!=both_revision
            rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'workflowPath':action_path('actions.yml'),'idempotencyKey':str(uuid.uuid4())},expected=403)
            repo_policy=update('REPOSITORY',repo_policy,True,repository,push=False)
            manual_revision=observe_policy(True,False)
            assert manual_revision!=push_revision
            stage('durable exact-commit queues survive core restart; idempotency retains original run')
            intent=str(uuid.uuid4());actions=dispatch(action_path('actions.yml'),intent)
            assert actions['state']=='WORKFLOW_RUN_STATE_QUEUED'
            if args.objects:
                original_source = object_source(actions['id'])
                stage('queued S3 source binding survives RustFS and Golf restart with no database archive copy')
                command('restart','rustfs')
                helpers.until(storage_ready,timeout=45)
            command('restart','golf');smoke.ready()
            if args.objects:
                assert object_source(actions['id']) == original_source, 'Restart changed the source storage binding'
            assert dispatch(action_path('actions.yml'),intent)['id']==actions['id']
            stage('dedicated TLS Docker daemon executes Actions and GitLab source snapshots')
            command('up','-d','--no-build','runner',timeout=240)
            action_result=wait_run(actions['id'])
            if action_result['state']!='WORKFLOW_RUN_STATE_SUCCEEDED':
                print('Actions terminal state: '+action_result['state']+'; reason: '+action_result.get('reason',''),flush=True)
                print(command('logs','--no-log-prefix','runner'),flush=True)
            assert action_result['state']=='WORKFLOW_RUN_STATE_SUCCEEDED'
            logs=rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':actions['id']})
            assert 'actions proof' in ''.join(row['text'] for row in logs.get('logs',[]))
            progress=action_result['progress'];assert progress['eventsRecorded'] and progress['jobId']=='proof' and len(progress['steps'])==2
            assert all(step['state']=='WORKFLOW_STEP_STATE_SUCCEEDED' and step.get('startedAt') and step.get('finishedAt') for step in progress['steps'])
            first=rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':actions['id'],'stepIndex':0})
            second=rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':actions['id'],'stepIndex':1})
            first_text=''.join(row['text'] for row in first.get('logs',[]));second_text=''.join(row['text'] for row in second.get('logs',[]))
            assert 'actions proof' in first_text and 'second step proof' not in first_text
            assert 'second step proof' in second_text and 'actions proof' not in second_text
            print('PASS: real independent Actions step events, names, timing and isolated log ranges.',flush=True)
            stage('unified Actions inventory and typed detail retain actual execution receipts')
            selection={'repository':repository,'repositoryId':str(native['id'])}
            typed={'kind':'ACTION_RUN_KIND_WORKFLOW','id':actions['id']}
            detail=rpc('ActionRunService/GetActionRun',{**selection,'ref':typed})
            summary=detail['summary'];workflow=detail['workflow']
            assert detail['repositoryId']==selection['repositoryId'] and summary['ref']==typed
            assert summary['state']=='succeeded' and summary['repositoryId']==selection['repositoryId'] and summary['ownerId']==action_result['ownerId']
            for field in ['commitId','workflowPath','workflowBlobId','sourceSha256']:
                assert summary[field]==workflow[field]==action_result[field], 'Unified execution receipt mismatch'
            attempt=workflow.get('attemptId','')
            assert len(attempt)==32 and all(c in '0123456789abcdef' for c in attempt) and summary.get('attemptId')==attempt==action_result.get('attemptId'), 'Actual attempt receipt missing'
            assert workflow['progress']==action_result['progress'], 'Unified detail changed actual step progress'
            page=rpc('ActionRunService/ListActionRuns',{**selection,'limit':2})
            assert page['repositoryId']==selection['repositoryId'] and any(item['ref']==typed for item in page.get('runs',[])), 'Actual workflow absent from unified history'
            rpc('ActionRunService/GetActionRun',{**selection,'ref':{'kind':'ACTION_RUN_KIND_CODING_TASK','id':actions['id']}},expected=404)
            rpc('ActionRunService/ListActionRuns',{**selection,'repositoryId':str(int(native['id'])+1)},expected=404)
            print('PASS: real typed workflow inventory/detail, attempt/source/progress receipts and wrong-kind/repository denial.',flush=True)
            if screenshots:
                stage('actual managed Actions inventory, run and selected-step browser proof; no browser effects')
                before=runtime()
                revision=(core_image.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
                if not isinstance(revision,str) or len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision):revision=None
                output=run('node',str(ROOT/'scripts/ci-ui-browser.mjs'),payload={
                    'golf':smoke.GOLF,'screenshots':str(screenshots),'actor':{'name':name,'email':name+'@example.invalid','password':password},
                    'repository':repository,'repositoryId':str(native['id']),'run':action_result,
                    'runtime':before,'workingTreeHead':run('git','rev-parse','HEAD').strip(),
                    'servedSourceCommit':revision,'servedSourceProvenance':'OCI revision label if present; working-tree HEAD is not served-source evidence'},timeout=240)
                print(output.strip(),flush=True)
                after=runtime(); assert after==before, 'Proof container provenance changed during browser captures'
                manifest_path=screenshots/'manifest.json'
                manifest=json.loads(manifest_path.read_text())
                assert manifest.get('complete') and manifest.get('passed') and len(manifest.get('results',[]))==12
                manifest['runtimeAfter']=after;manifest['runtimeStable']=True
                updated_manifest=screenshots/'manifest.runtime.json'
                helpers.private_write(updated_manifest,json.dumps(manifest,indent=2)+'\n')
                os.replace(updated_manifest,manifest_path)
            gitlab=dispatch('.gitlab-ci.yml');assert wait_run(gitlab['id'])['state']=='WORKFLOW_RUN_STATE_SUCCEEDED'
            assert 'gitlab proof' in ''.join(row['text'] for row in rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':gitlab['id']}).get('logs',[]))
            gitlab_result=rpc('WorkflowRunService/GetWorkflowRun',{'runId':gitlab['id']})['run'];assert len(gitlab_result['progress']['steps'])==1 and gitlab_result['progress']['steps'][0]['state']=='WORKFLOW_STEP_STATE_SUCCEEDED'
            failure=dispatch(action_path('failure.yml'));failed=wait_run(failure['id']);assert failed['state']=='WORKFLOW_RUN_STATE_FAILED' and failed['exitCode']==7
            assert 'must not execute' not in ''.join(row['text'] for row in rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':failure['id']}).get('logs',[]))
            assert [step['state'] for step in failed['progress']['steps']]==['WORKFLOW_STEP_STATE_FAILED','WORKFLOW_STEP_STATE_SKIPPED']
            stage('actual worker output continues through every bounded log page')
            paged_run=dispatch(action_path('logs.yml'));assert wait_run(paged_run['id'])['state']=='WORKFLOW_RUN_STATE_SUCCEEDED'
            after=0;chunks=[];pages=0
            while True:
                page=rpc('WorkflowRunService/GetWorkflowRunLogs',{'runId':paged_run['id'],'afterSequence':str(after)})
                entries=page.get('logs',[]);assert len(entries)<=16, 'Log page exceeds its bound'
                assert not page.get('truncated'), 'Controlled output unexpectedly truncated'
                for entry in entries:
                    sequence=int(entry['sequence']);assert sequence==after+1, 'Log continuation duplicated or skipped output'
                    after=sequence;chunks.append(entry['text'])
                pages+=1
                if not page.get('hasMore'):break
                assert entries and pages<100, 'Log continuation failed to advance'
            assert pages>1 and 'GOLF_LOG_FINAL' in ''.join(chunks), 'Final output was inaccessible beyond the first page'
            print('PASS: real ordered log continuation across '+str(pages)+' pages / '+str(after)+' chunks.',flush=True)
            stage('running cancellation and policy revocation fence worker results')
            slow=dispatch(action_path('slow.yml'));running=wait_run(slow['id'],'WORKFLOW_RUN_STATE_RUNNING')
            cancelled=rpc('WorkflowRunService/CancelWorkflowRun',{'runId':slow['id'],'expectedVersion':running['version']})['run'];assert cancelled['state']=='WORKFLOW_RUN_STATE_CANCELLED'
            cancelled_detail=rpc('WorkflowRunService/GetWorkflowRun',{'runId':slow['id']})['run'];assert cancelled_detail['progress']['steps'][0]['state']=='WORKFLOW_STEP_STATE_INTERRUPTED'
            time.sleep(11)
            revoked=dispatch(action_path('slow.yml'));wait_run(revoked['id'],'WORKFLOW_RUN_STATE_RUNNING')
            repo_policy=update('REPOSITORY',repo_policy,False,repository)
            assert wait_run(revoked['id'])['state']=='WORKFLOW_RUN_STATE_CANCELLED'
            rpc('WorkflowRunService/DispatchWorkflow',{'repository':repository,'workflowPath':'.gitlab-ci.yml','idempotencyKey':str(uuid.uuid4())},expected=403)
            stage('unified keyset history pages every actual run once and binds filters')
            cursor='';seen=[]
            while True:
                page=rpc('ActionRunService/ListActionRuns',{**selection,'limit':2,'cursor':cursor})
                assert page['repositoryId']==selection['repositoryId'] and len(page.get('runs',[]))<=2
                for item in page.get('runs',[]):
                    assert item['ref']['kind']=='ACTION_RUN_KIND_WORKFLOW'
                    assert item['ref']['id'] not in seen, 'Unified continuation duplicated an actual run'
                    seen.append(item['ref']['id'])
                next_cursor=page.get('nextCursor','')
                if not next_cursor:break
                assert page.get('runs') and next_cursor!=cursor and len(seen)<=20, 'Unified continuation did not advance'
                rpc('ActionRunService/ListActionRuns',{**selection,'limit':2,'cursor':next_cursor,'kindFilter':'ACTION_RUN_KIND_REVIEW'},expected=400)
                cursor=next_cursor
            assert set(seen)=={item['id'] for item in [actions,gitlab,failure,paged_run,slow,revoked]}, 'Unified history skipped or invented a run'
            filtered=rpc('ActionRunService/ListActionRuns',{**selection,'kindFilter':'ACTION_RUN_KIND_WORKFLOW','workflowPath':action_path('actions.yml')})
            assert [item['ref'] for item in filtered.get('runs',[])]==[typed], 'Server workflow filter differs'
            assert not rpc('ActionRunService/ListActionRuns',{**selection,'kindFilter':'ACTION_RUN_KIND_REVIEW'}).get('runs'), 'Invented a review without execution'
            print('PASS: real bounded unified-history continuation without duplicates/skips and cursor-bound server filters.',flush=True)
            if args.objects:
                stage('all actual Actions and GitLab jobs retain verified S3 locators and no PostgreSQL source bytes')
                for item in [actions,gitlab,failure,paged_run,slow,revoked]:
                    object_source(item['id'])
                assert object_source(actions['id']) == original_source
                query = "SELECT count(*) FROM golf_workflow_runs WHERE source_storage<>'env_s3' OR source_archive IS NOT NULL"
                assert command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',query).strip() == '0'
            stage('no attempt containers or source volumes retained after terminal runs')
            time.sleep(2)
            command('stop','runner')
            assert not command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.managed=true').strip()
            assert not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.managed=true').strip()
            print('PASS: real Compose Actions/GitLab shell jobs, persistence, denial, failures, cancellation and cleanup.',flush=True)
            if args.objects:
                print('PASS: private RustFS source upload/read, durable env_s3 bindings, restart persistence and NULL PostgreSQL source archives.',flush=True)
        except Exception:
            if started:
                try:
                    print('Image preparation: '+command('logs','--no-log-prefix','runner-image-init'),flush=True)
                    print('Worker states: '+command('logs','--no-log-prefix','runner'),flush=True)
                except Exception:pass
            raise
        finally:
            smoke.GOLF,smoke.GITEA=previous
            if started:
                command('down','--volumes','--remove-orphans',timeout=180)
                for arguments in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project).strip()
                print('Disposable CI project cleaned up.',flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
