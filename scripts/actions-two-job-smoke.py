#!/usr/bin/env python3
"""Prepared bounded actual two-job maintained Actions proof; root operator runs it.

One input-free first -> second DAG, immutable source/attempt and private scoped
logs, fresh job workspace, original replay/restart and exact-owned cleanup.
Requires cached images/binary hashes and operator-approved seeding of fresh DinD.
Optional .forgejo location and signed push proof use the same admission/worker.
--self-check performs pure counterexample checks only. No new scheduler support,
full Actions, failure/skip, cancellation, secrets, remote actions or UI claim.
"""
import argparse
import ast
import base64
import copy
from datetime import datetime, timedelta, timezone
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
PG='postgres:18.4-alpine3.24'
PATH='.github/workflows/two-job.yml'
WITH_PUSH=False
WITH_GIT=False
WITH_ORDINARY=False
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
    if WITH_ORDINARY:return {PATH:(stack/"docs/compatibility/fixtures/requests-lint.yml").read_bytes()}
    source=(stack/'engines/act/testdata/two-job-needs.yml').read_bytes()
    source=source.replace(b'.github/workflows/two-job.yml', PATH.encode())
    if WITH_PUSH:
        source=source.replace(b'on: workflow_dispatch', b'on: [workflow_dispatch, push]')
    assert 0<len(source)<65536 and all(marker.encode() in source for marker in MARKERS.values())
    assert b'golf-first-job-only' in source and PATH.encode() in source
    if WITH_GIT:
        source=source.replace(('test -f '+PATH).encode(), ('test -f '+PATH+' && test \"$(git rev-parse HEAD)\" = \"$GITHUB_SHA\" && test -x bin/executable.sh && test \"$(git ls-files -s bin/executable.sh | head -c 6)\" = 100755 && git rev-parse HEAD && git rev-parse HEAD^{tree} && git rev-parse HEAD:'+PATH).encode())
        return {PATH:source, 'bin/executable.sh': b'#!/bin/sh\necho owned executable fixture\n'}
    return {PATH:source}

def check_run(run,native,head,blob,origin='MANUAL'):
    assert str(uuid.UUID(run['id']))==run['id']
    assert run['repositoryId']==str(native['id']) and run['ownerId']==str(native['owner']['id'])
    assert run['commitId']==head and run['workflowPath']==PATH and run['workflowBlobId']==blob
    assert run['engineCatalog']==CATALOG and run['engineCommit']==ENGINE
    assert re.fullmatch('[a-f0-9]{32}',run['attemptId']) and re.fullmatch('[a-f0-9]{64}',run['sourceSha256'])
    assert run['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and run['origin']=='WORKFLOW_RUN_ORIGIN_'+origin and run['runnerId']=='local-docker'
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
    global REPORT_FAILURE, PATH, WITH_PUSH, WITH_GIT, WITH_ORDINARY, IMAGE, CATALOG
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('image','runner-image','source-revision','expected-core-sha256','expected-runner-sha256','expected-engine-sha256'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--forge-kind', choices=('forgejo',), default='forgejo')
    parser.add_argument('--forgejo-spec', type=Path, help='Frozen API from forgejo-qualify.py; must match the inventoried digest')
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seed-wait-seconds',type=int,default=300)
    parser.add_argument('--workflow-directory', choices=('.github/workflows', '.forgejo/workflows'), default='.github/workflows')
    parser.add_argument('--with-push', action='store_true', help='Also qualify an independently granted actual native push run of the owned fixture')
    parser.add_argument('--git-image-proof', type=Path, help='Passed actual Git engine/image receipt; enables historical Git qualification using a fresh private local registry')
    parser.add_argument('--worker-death', action='store_true', help='With Git qualification, kill the enrolled worker during a running step and qualify explicit fenced recovery')
    parser.add_argument('--ordinary-actions-bundles',type=Path,help='Qualify the unchanged Requests push fixture using these public immutable action bytes')
    parser.add_argument('--ci-job-image',help='Explicit cached Ubuntu24/Node24 job image for ordinary Actions qualification')
    parser.add_argument('--seed-approved-images', action='store_true', help='Acquire only the two digest-pinned operator images in the fresh owned daemon before source execution')

    args=parser.parse_args();stack=args.stack_root.resolve();output=args.output.resolve()
    forge = args.forge_kind
    native_image = 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'
    native_version = '15.0.9+gitea-1.22.0'
    compose_file = 'compose.yaml'
    init_file = 'deploy/postgres/forgejo-init.sh'
    config_file = '/var/lib/gitea/custom/conf/app.ini'
    workflow_dirs = '.forgejo/workflows,.github/workflows'
    if not args.forgejo_spec: parser.error('--forgejo-spec is required')
    spec_path = args.forgejo_spec
    assert hashlib.sha256(spec_path.read_bytes()).hexdigest() == json.loads((stack/'docs/compatibility/forgejo-inventory.json').read_text())['targetSHA256'], 'Forgejo API baseline differs from the inventoried snapshot'
    official_spec = json.loads(spec_path.read_bytes())
    PATH=args.workflow_directory+'/two-job.yml';WITH_PUSH=args.with_push;WITH_GIT=args.git_image_proof is not None
    WITH_ORDINARY=args.ordinary_actions_bundles is not None
    if WITH_ORDINARY:
        assert args.git_image_proof and args.ci_job_image and args.seed_approved_images and args.workflow_directory==".github/workflows" and not args.worker_death
        CATALOG="golf.workflow.act.v0.2.89.linux.remote-node24.v1"
        PATH=".github/workflows/lint.yml"
    assert not args.worker_death or WITH_GIT
    git_proof=None
    if WITH_GIT:
        git_proof=json.loads(args.git_image_proof.read_text())
        assert git_proof['passed'] and git_proof['cleanupComplete'] and git_proof['jobDiskQuota']
        assert len(git_proof['cases']) in (4,6) and re.fullmatch('sha256:[a-f0-9]{64}',git_proof['registryManifestSHA256'])
        IMAGE='git-image-registry:5000/golf/git-job@'+git_proof['registryManifestSHA256']
    assert 1<=args.seed_wait_seconds<=600 and not output.exists()
    assert re.fullmatch('[a-f0-9]{40}',args.source_revision)
    for digest in (args.expected_core_sha256,args.expected_runner_sha256,args.expected_engine_sha256):assert re.fullmatch('[a-f0-9]{64}',digest)
    files=source_files(stack)  # Refuse absent prepared fixture before resource operations.
    output.mkdir(parents=True,mode=0o700);output.chmod(0o700)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','FORGEJO_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    forbidden=[];manifest={'complete':False,'passed':False,'proofKind':'maintained-actions-two-job-needs','sourceRevision':args.source_revision,'sourceDirty':bool(subprocess.check_output(['git','status','--porcelain'],cwd=stack,env=environment).strip()),'sourceFiles':{path:hashlib.sha256((stack/path).read_bytes()).hexdigest() for path in ('internal/workflowpath/path.go','internal/server/workflows.go','internal/server/workflow_runs.go','internal/server/server.go','internal/server/repository_events.go','internal/server/execution_policy.go','scripts/actions-two-job-smoke.py',compose_file,init_file,'deploy/compose/compose.actions-engine.yaml','cmd/golf-runner/main.go','cmd/golf-runner/git_execution.go','internal/server/runner_transport.go','internal/runner/actions_git_source.go','engines/act/execute.go','engines/act/git_source.go','engines/act/job_disk.go','engines/act/upstream_source_manifest.json')},'workflowPath':PATH,'withPush':WITH_PUSH,'fixtureSha256':{path:hashlib.sha256(data).hexdigest() for path,data in files.items()},'limitations':['Owned input-free two-job maintained Actions fixture only; no matrix, outputs, secrets, remote actions, failure/skip or cancellation qualification.','Current native before/after read authority is not an atomic native CAS.']}
    if WITH_ORDINARY:
        for path in ('internal/runner/action_bundles.go','internal/runner/dependency_access.go','internal/runner/dependency_firewall.go','internal/runner/job_git.go','internal/runner/masked_output.go','internal/runner/git_source_envelope.go','cmd/golf-runner/job_git.go','internal/server/job_git_capability.go','internal/server/runner_git_source.go','internal/server/actions_engine.go','internal/server/push_materializer.go','internal/server/database/migrations/202610070092_remote_actions.sql','engines/act/remote_actions.go','engines/act/job_git.go','engines/act/native_executor.go','deploy/docker/actions/Dockerfile','scripts/compatibility/requests-proof.py','deploy/compose/compose.actions-remote.yaml'):
            manifest['sourceFiles'][path]=hashlib.sha256((stack/path).read_bytes()).hexdigest()
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
            helpers.private_write(output/'private-failure-message.txt',redact(str(error))[:8192])
            record(originalFailure={'type':type(error).__name__,'stage':STAGE,'frames':[{'file':Path(v.filename).name if Path(v.filename).name in {Path(__file__).name,'actions-engine-smoke.py','workflow-notifications-smoke.py','observability-smoke.py','smoke.py'} else 'dependency','line':v.lineno} for v in traceback.extract_tb(error.__traceback__)[-6:]]})
    REPORT_FAILURE=failure
    record(stage=STAGE,forgeKind=forge,nativeWebhookDialect='gitea',nativeSpecSHA256=hashlib.sha256(spec_path.read_bytes()).hexdigest())
    def snapshot():
        ids=execute('docker','ps','-aq','--no-trunc').splitlines();assert len(ids)<=500
        if not ids:return {}
        template='{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}}},"RestartCount":{{json .RestartCount}}}'
        return notifications.filtered_foreign([json.loads(line) for line in execute('docker','inspect','--format',template,*ids).splitlines()])
    stage('cached immutable images/binaries and two-GiB reserve')
    images={};platforms={}
    for role,ref in [('golf',args.image),('runner',args.runner_image),('native',native_image),('postgres',PG),('daemon',DIND)]:
        row=json.loads(execute('docker','image','inspect',ref))[0];assert re.fullmatch('sha256:[a-f0-9]{64}',row['Id']);images[role]=row['Id']
        assert row['Os']=='linux' and row['Architecture'] in ('amd64','arm64')
        platforms[role]=row['Os']+'/'+row['Architecture']
        if role in ('golf','runner'):assert ref==row['Id'] and (row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.source_revision
    binaries={}
    for role,binary,digest in [('golf','golf',args.expected_core_sha256),('runner','golf-runner',args.expected_runner_sha256),('golf','golf-actions-engine',args.expected_engine_sha256),('runner','golf-actions-engine',args.expected_engine_sha256)]:
        raw=execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/usr/bin/sha256sum',images[role],'/usr/local/bin/'+binary)
        assert raw.split()==[digest,'/usr/local/bin/'+binary];binaries[role+'/'+binary]=digest
    assert int(execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/').splitlines()[-1].split()[3])>=2*1024*1024
    before=snapshot();helpers.private_write(output/'foreign-before.json',json.dumps(before,indent=2))
    project=PROJECT_PREFIX+secrets.token_hex(5);ports=helpers.free_ports(4 if WITH_GIT else 3)
    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
    previous=smoke.GOLF,smoke.GITEA;smoke.GOLF=f'http://127.0.0.1:{ports[0]}';smoke.GITEA=f'http://127.0.0.1:{ports[1]}';secure=f'https://127.0.0.1:{ports[2]}'
    assert len(set(platforms.values()))==1
    record(images=images,platforms=platforms,binarySha256=binaries,project=project,helperRevision=execute('git','rev-parse','HEAD'))
    actors={};started=False;passed=False;cleanup=[];bootstrap_created=False;git_tag=None;ci_tag=None
    original_client,original_request=smoke.client,smoke.request
    with tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700)
        ca,cert,key=directory/'ca.crt',directory/'server.crt',directory/'server.key'
        helpers.private_write(directory/'ca.conf','[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf two-job fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        helpers.private_write(directory/'extensions','basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n')
        execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(directory/'ca.conf'),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(directory/'server.csr'))
        execute('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(cert))
        for file in (ca,cert,key):file.chmod(0o444)
        worker_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        values['GOLF_FORGE_INSTANCE_ID'] = str(uuid.uuid4())
        if WITH_GIT:values['GOLF_RUNNER_GIT_PREPARATION_IMAGE']=IMAGE
        forbidden.extend(values[k] for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD','GOLF_ENCRYPTION_KEY','GOLF_RUNNER_KEY'))
        if WITH_ORDINARY:
            import urllib.request,http.cookiejar
            public='https://127.0.0.1:8443'
            values['GOLF_PUBLIC_URL']=public
            values['GOLF_RUNNER_TLS_URL']='https://localhost:8443'
            smoke.GOLF=secure
            trusted=ssl.create_default_context(cafile=str(ca));trusted.minimum_version=ssl.TLSVersion.TLSv1_3
            smoke.client=lambda:urllib.request.build_opener(urllib.request.HTTPSHandler(context=trusted),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            def request(opener,method,url,payload=None,headers=None,expected=200):return original_request(opener,method,url,payload,headers={'Origin':public,**(headers or {})},expected=expected)
            smoke.request=request
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        overlay={'services':{'golf':{'image':images['golf'],'pull_policy':'never','mem_limit':'384m','environment':{'GOLF_FORGE_URL':'http://'+forge+':3000','GOLF_ACTIONS_ENGINE_CATALOG':act.CATALOG}},forge:{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{forge.upper()+'__server__ROOT_URL':smoke.GITEA+'/',forge.upper()+'__server__DISABLE_SSH':'true',forge.upper()+'__server__START_SSH_SERVER':'false',forge.upper()+'__actions__ENABLED':'false',forge.upper()+'__log__MODE':'console'}},'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m','command':['postgres','-c','max_wal_size=64MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s']},'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m'},'runner-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},'runner-actions-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'}}}
        if WITH_GIT:
            source_row=json.loads(execute('docker','image','inspect',git_proof['originalSourceImage']['Id']))[0]
            assert source_row['Id']==git_proof['originalSourceImage']['Id'] and source_row['Os']+'/'+source_row['Architecture']==platforms['runner'] and not source_row['Config'].get('Volumes')
            registry_row=json.loads(execute('docker','image','inspect','registry:2'))[0]
            assert re.fullmatch('sha256:[a-f0-9]{64}',registry_row['Id'])
            overlay['services']['git-image-registry']={'image':registry_row['Id'],'pull_policy':'never','ports':[f'127.0.0.1:{ports[3]}:5000'],'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'mem_limit':'128m','tmpfs':['/var/lib/registry:size=134217728,mode=0700','/tmp:size=16777216,mode=1777']}
            overlay['services']['runner-daemon']['command']=['--insecure-registry=git-image-registry:5000']
        if WITH_ORDINARY:
            ci_row=json.loads(execute('docker','image','inspect',args.ci_job_image))[0]
            overlay['services']['git-image-registry'].update(mem_limit='512m',tmpfs=['/var/lib/registry:size=536870912,mode=0700','/tmp:size=16777216,mode=1777'])
            assert ci_row['Os']+'/'+ci_row['Architecture']==platforms['runner'] and not ci_row['Config'].get('Volumes') and ci_row['Size']<512<<20
            ci_image='git-image-registry:5000/golf/ci-job@'+ci_row['Id']
            values['GOLF_RUNNER_IMAGES']=json.dumps({'linux':IMAGE,'ubuntu-24.04':ci_image})
            values['GOLF_RUNNER_APPROVED_IMAGES']=json.dumps([IMAGE,ci_image])
            for role in ('golf','runner'):
                overlay['services'][role].setdefault('volumes',[]).append(str(args.ordinary_actions_bundles.resolve())+':/run/golf/actions/bundles.json:ro')
                overlay['services'][role].setdefault('environment',{}).update({'GOLF_ACTIONS_ENGINE_CATALOG':CATALOG,'GOLF_ACTIONS_REMOTE_BUNDLES':'/run/golf/actions/bundles.json'} if role=='golf' else {'GOLF_RUNNER_JOB_GIT':'1','GOLF_RUNNER_ACTIONS_REMOTE_BUNDLES':'/run/golf/actions/bundles.json','GOLF_RUNNER_ACTIONS_EGRESS_NETWORK':'bridge'})
            args.ordinary_actions_bundles.chmod(0o444)
            (directory/'proof.env').unlink()
            helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        helpers.private_write(directory/'services.json',json.dumps(overlay))
        helpers.private_write(directory/'ports.yaml',f'''services:
  golf:
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443"]
  {forge}:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  postgres:
    volumes: !override ["{stack/init_file}:/docker-entrypoint-initdb.d/01-golf.sh:ro"]
    tmpfs: ["/var/lib/postgresql:size=1073741824,mode=0700,uid=70,gid=70"]
''')
        compose=['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(directory/'proof.env')]
        for file in (compose_file,'deploy/compose/compose.ci.yaml','deploy/compose/compose.actions-engine.yaml','deploy/compose/compose.runner-tls.yaml'):compose+=['-f',str(stack/file)]
        compose+=['-f',str(directory/'services.json'),'-f',str(directory/'ports.yaml')]
        def command(*argv,**kw):return execute(*compose,*argv,**kw)
        def admin(*argv):return command('exec','-T',forge,forge,'--config',config_file,'admin','user',*argv)
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
            started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres',forge,'golf','runner-daemon');smoke.ready()
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
            if WITH_GIT:
                command('up','-d','--no-build','--pull','never','git-image-registry')
                git_tag=f'127.0.0.1:{ports[3]}/golf/git-job:{project}'
                execute('docker','image','tag',source_row['Id'],git_tag)
                execute('docker','image','push',git_tag)
                record(gitImage={'sourceId':source_row['Id'],'registryManifest':git_proof['registryManifestSHA256'],'configuration':git_proof['registryConfigSHA256'],'reference':IMAGE,'acquisition':'owned local registry; jobs retain network=none'})
            if WITH_ORDINARY:
                ci_tag=f'127.0.0.1:{ports[3]}/golf/ci-job:{project}'
                execute('docker','image','tag',ci_row['Id'],ci_tag)
                execute('docker','image','push',ci_tag,timeout=180)
                record(ciImage={'sourceId':ci_row['Id'],'reference':ci_image,'size':ci_row['Size'],'ubuntu':'24.04','node':'24.19.0','pythonToolcache':'3.14.8','pythonArchiveSHA256':'fa74abc70a55c10f6631967784878704eef81bbde9b8ec27469534f6ba997cb3','operatorAcquisition':True})
                core_ip=json.loads(execute('docker','inspect',command('ps','-q','golf')))[0]['NetworkSettings']['Networks']
                assert len(core_ip)==1
                overlay['services']['runner']['environment']['GOLF_RUNNER_ACTIONS_EGRESS_HOST']=next(iter(core_ip.values()))['IPAddress']
                (directory/'services.json').write_text(json.dumps(overlay))
            if args.seed_approved_images:
                for reference in ((IMAGE,DIND,ci_image) if WITH_ORDINARY else (IMAGE,DIND)):
                    command('exec','-T','runner-daemon','docker','pull',reference,timeout=180)
            def seeded():
                receipts=[]
                for ref in ((IMAGE,DIND,ci_image) if WITH_ORDINARY else (IMAGE,DIND)):
                    try:row=json.loads(command('exec','-T','runner-daemon','docker','image','inspect',ref))[0]
                    except AssertionError:return None
                    canonical=ref.split('@')[0]
                    if ':' in canonical.rsplit('/',1)[-1]:canonical=canonical.rsplit(':',1)[0]
                    canonical+='@'+ref.split('@')[1]
                    assert row['Os']=='linux' and re.fullmatch('sha256:[a-f0-9]{64}',row['Id']) and canonical in (row.get('RepoDigests') or [])
                    receipts.append({'reference':ref,'id':row['Id'],'registryDigest':canonical})
                return receipts
            record(seedReceipt=helpers.until(seeded,args.seed_wait_seconds))
            bootstrap=project+'-bootstrap';admin('create','--username',bootstrap,'--email',bootstrap+'@example.invalid','--random-password','--must-change-password=false','--admin');bootstrap_created=True
            assert smoke.provider('','GET','version')['version']==native_version
            native_spec=smoke.request(smoke.client(),'GET',smoke.GITEA+'/swagger.v1.json')
            for field in ('paths','definitions','securityDefinitions'):
                assert native_spec.get(field)==official_spec.get(field), 'Installed API specification differs from the pinned planning baseline'
            record(installedSpec={'version':native_version,'canonicalSha256':hashlib.sha256(json.dumps(native_spec,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'pathsDefinitionsSecurityMatch':True,'instance':'fresh owned qualification '+forge+'; not the retained installation','nativeActionsEnabled':False,'workflowDirs':workflow_dirs})
            schema=int(metadata('SELECT max(version_id) FROM goose_db_version WHERE is_applied'))
            assert schema==max(int(path.name.split('_')[0]) for path in (stack/'internal/server/database/migrations').glob('*.sql'))
            with smoke.client().open(smoke.GOLF+'/',timeout=15) as response:
                served=response.read((64<<10)+1);assert response.status==200 and 0<len(served)<=64<<10
            assert hashlib.sha256(served).digest()==hashlib.sha256((stack/'web/dist/index.html').read_bytes()).digest()
            record(schema=schema,servedFrontendIndexSha256=hashlib.sha256(served).hexdigest())
            for role in ('owner',):
                actor={'name':project+'-'+role,'session':smoke.client(),'created':False,'enrolled':False};actors[role]=actor
                actor.update(email=actor['name']+'@example.invalid',password=secrets.token_urlsafe(32));forbidden.append(actor['password'])
                admin('create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
                identity=smoke.provider(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is False;actor['id']=str(identity['id'])
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'}));assert result['state']=='complete';actor['enrolled']=True
                rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
            if WITH_ORDINARY:
                ordinary=load('ordinary_actions_qualification','compatibility/requests-proof.py')
                ordinary.qualify(stack=stack,output=output,directory=directory,actors=actors,command=command,execute=execute,metadata=metadata,rpc=rpc,record=record,stage=stage,environment=environment,values=values,ci_image=ci_image,forbidden=forbidden)
            else:
                owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'two-job-actions','private':True,'auto_init':True},expected=201)
                repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
                for path,data in files.items():smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(data).decode(),'message':'Controlled two-job Actions fixture'},expected=201)
                if args.workflow_directory in ('.forgejo/workflows',):
                    smoke.provider(owner['token'],'POST',base+'/contents/.github/workflows/suppressed.yml',{'content':base64.b64encode(files[PATH]).decode(),'message':'Controlled suppressed directory fixture'},expected=201)
                if WITH_GIT:
                    stage('native executable mode through supported Git push')
                    clone=directory/'owned-source'
                    git_env=environment|{'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Basic '+base64.b64encode(('x-access-token:'+owner['token']).encode()).decode()}
                    for name in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'):git_env.pop(name,None)
                    def native_git(*argv):
                        result=subprocess.run(['git','-c','core.hooksPath=/dev/null',*argv],env=git_env,capture_output=True,timeout=30)
                        assert result.returncode==0 and len(result.stdout)<=1<<20 and len(result.stderr)<=1<<20,'Owned native Git failed; output withheld'
                        return result.stdout.decode().strip()
                    native_git('clone','--quiet',smoke.GITEA+'/'+native['full_name']+'.git',str(clone))
                    native_git('-C',str(clone),'add','--chmod=+x','bin/executable.sh')
                    native_git('-C',str(clone),'-c','user.name=Owned fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Owned executable mode')
                    native_git('-C',str(clone),'push','--quiet','origin','HEAD')
                head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
                blob=hashlib.sha1(b'blob '+str(len(files[PATH])).encode()+b'\0'+files[PATH]).hexdigest();target={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id'])}
                for scope in ('INSTANCE','REPOSITORY'):
                    selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                    policy=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                    rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy.get('revision','0'),'expectedAuthorityRevision':policy['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})

                stage('maintained two-job declaration and one exact admission')
                inspection=rpc('owner','WorkflowService/InspectWorkflows',{'repository':repository,'ref':head,'repositoryId':target['repositoryId']})
                assert inspection['repositoryId']==target['repositoryId'] and inspection['commitId']==head and inspection['catalogVersion']=='golf.workflow.inspect.v3' and inspection['executionCatalog']==CATALOG and inspection['executionEngineCommit']==ENGINE
                configurations=inspection.get('configurations',[]);assert len(configurations)==1 and configurations[0]['path']==PATH and configurations[0]['blobId']==blob and configurations[0]['format']=='WORKFLOW_FORMAT_GITHUB_ACTIONS' and configurations[0]['state']=='WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET' and configurations[0].get('manualPolicyAllowed') is True
                if args.workflow_directory in ('.forgejo/workflows',):
                    rpc('owner','WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':'.github/workflows/suppressed.yml','idempotencyKey':str(uuid.uuid4())},expected=400,code='failed_precondition')
                    assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==0
                    record(suppressedDirectoryRefusedWithoutAdmission=True)
                operation=str(uuid.uuid4());dispatch={'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':operation}
                run=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run']
                assert run['engineCatalog']==CATALOG and run['state']=='WORKFLOW_RUN_STATE_QUEUED' and run['commitId']==head and run['workflowBlobId']==blob and run['repositoryId']==target['repositoryId'] and run['ownerId']==target['ownerId']
                if WITH_GIT:
                    advanced=smoke.provider(owner['token'],'POST',base+'/contents/advanced-after-admission.txt',{'content':base64.b64encode(b'new branch tip; absent from admitted source\n').decode(),'message':'Advance branch after historical admission'},expected=201)['commit']['sha']
                    assert re.fullmatch('[a-f0-9]{40}',advanced) and advanced!=head
                    record(historicalSource={'admittedCommit':head,'advancedBranchCommit':advanced,'branchAdvancedBeforeWorker':True})
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
                if WITH_GIT:
                    full_logs=rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id']})
                    output_text=''.join(v['text'] for v in full_logs.get('logs',[]))
                    # Gitea's REST commit.tree.sha aliases the commit. Independent
                    # native Git readback must verify the actual tree object.
                    native_git('-C',str(clone),'fetch','--quiet','origin',head)
                    assert native_git('-C',str(clone),'rev-parse','FETCH_HEAD')==head
                    native_tree=native_git('-C',str(clone),'rev-parse',head+'^{tree}')
                    assert re.fullmatch('[a-f0-9]{40}',native_tree) and native_tree!=head
                    assert native_git('-C',str(clone),'rev-parse',head+':'+PATH)==blob
                    assert native_git('-C',str(clone),'ls-tree',head,'bin/executable.sh').startswith('100755 blob ')
                    for job_id,step_id in (('first','source'),('second','fresh')):
                        scoped=rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id'],'jobInstanceId':act.instance(job_id,{}),'stepId':step_id})
                        text=''.join(v['text'] for v in scoped.get('logs',[]))
                        assert all(value in text for value in (head,native_tree,blob)) and advanced not in text
                    assert advanced not in output_text
                    record(historicalGitReadback={'commit':head,'tree':native_tree,'workflowBlob':blob,'executableMode':'100755','twoIndependentJobs':True,'advancedCommitExcluded':True,'independentNativeGitFetch':True})
                stage('restart original immutable graph without replacement execution')
                command('restart','golf');smoke.ready()
                # The worker shares Golf's network namespace. Rebind it after
                # core restart before claiming it can accept another assignment.
                command('restart','runner')
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
                if WITH_PUSH:
                    stage('explicit native push policies, sponsor grant and signed webhook')
                    for scope in ('INSTANCE','REPOSITORY'):
                        selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                        policy=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                        rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy['revision'],'expectedAuthorityRevision':policy['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':True,'allowAllWorkflows':False,'workflowPaths':[PATH]})
                    grant=rpc('owner','AutomationGrantService/CreateAutomationGrant',{'repository':repository,'expectedRepositoryId':target['repositoryId'],'expectedOwnerId':target['ownerId'],'nativeToken':owner['token'],'branches':[native['default_branch']],'workflowPaths':[PATH],'expiresAt':(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(),'idempotencyKey':str(uuid.uuid4())})['grant']
                    connection,signing_secret=str(uuid.uuid4()),secrets.token_urlsafe(32)
                    forbidden.append(signing_secret)
                    values['GOLF_PUSH_CI_ENABLED']='true'
                    values['GOLF_REPOSITORY_EVENT_CONNECTIONS']=json.dumps([{'id':connection,'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'repository':native['full_name'],'secret':signing_secret}],separators=(',',':'))
                    (directory/'proof.env').write_text(''.join(k+"='"+v+"'\n" for k,v in values.items()))
                    # The worker shares Golf's network namespace. Drain it before
                    # replacing that container; recreate it against the new owner.
                    command('stop','runner')
                    command('up','-d','--no-build','--pull','never','--no-deps','golf');smoke.ready()
                    command('up','-d','--no-build','--pull','never','--no-deps','--force-recreate','runner')
                    smoke.provider(owner['token'],'POST',base+'/hooks',{'type':'gitea','active':True,'events':['push'],'branch_filter':'*','config':{'url':'http://golf:8080/hooks/forgejo/'+connection,'content_type':'json','http_method':'POST','secret':signing_secret}},expected=201)
                    # The existing native-activity proof admits only events clearly
                    # newer than the grant (whole-second provider clocks + skew).
                    import time
                    time.sleep(7)
                    pushed=smoke.provider(owner['token'],'POST',base+'/contents/push-proof.txt',{'content':base64.b64encode(b'Owned authorized native push\n').decode(),'message':'Owned authorized native push'},expected=201)
                    pushed_head=pushed['commit']['sha']
                    def pushed_run():
                        page=rpc('owner','WorkflowRunService/ListWorkflowRuns',{'repository':repository,'page':{'limit':20,'page':1}})
                        matching=[item for item in page.get('runs',[]) if item['commitId']==pushed_head and item.get('origin')=='WORKFLOW_RUN_ORIGIN_PUSH']
                        assert len(matching)<=1, 'Duplicate automatic run'
                        return matching[0] if matching else None
                    automatic=helpers.until(pushed_run,timeout=90)
                    def push_terminal():
                        current=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':automatic['id']})['run']
                        return current if current['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None
                    automatic=helpers.until(push_terminal,timeout=240)
                    push_jobs=check_run(automatic,native,pushed_head,blob,origin='PUSH')
                    assert automatic['eventRef']=='refs/heads/'+native['default_branch'] and automatic['automationGrantId']==grant['id'] and int(automatic['repositoryEventId'])>0
                    push_logs=check_logs(lambda method,payload:rpc('owner',method,payload),automatic,push_jobs)
                    assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==2
                    record(pushRun={k:automatic[k] for k in ('id','attemptId','commitId','workflowPath','workflowBlobId','sourceSha256','origin','eventRef','automationGrantId','repositoryEventId','state','engineCatalog','engineCommit','jobs')},pushLogReadbacks=push_logs,nativeSignedPush=True,runCount=2)
                if args.worker_death:
                    stage('abrupt enrolled worker death and explicit fenced owned recovery')
                    death_source=b'on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - id: wait\n        shell: sh\n        run: sleep 180\n'
                    current=smoke.provider(owner['token'],'GET',base+'/contents/'+PATH)
                    death_head=smoke.provider(owner['token'],'PUT',base+'/contents/'+PATH,{'sha':current['sha'],'content':base64.b64encode(death_source).decode(),'message':'Owned worker loss qualification'},expected=200)['commit']['sha']
                    death_run=rpc('owner','WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':death_head,'workflowPath':PATH,'idempotencyKey':str(uuid.uuid4())})['run']
                    def running_step():
                        row=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':death_run['id']})['run']
                        record(workerDeathLastObservation={'state':row['state'],'jobs':[{'state':job['state'],'steps':[step['state'] for step in job.get('steps',[])]} for job in row.get('jobs',[])]})
                        assert row['state'] in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING')
                        return row if any(step['state']=='WORKFLOW_STEP_STATE_RUNNING' for job in row.get('jobs',[]) for step in job.get('steps',[])) else None
                    death_run=helpers.until(running_step,timeout=90)
                    death_attempt=death_run['attemptId']
                    def residue():
                        return command('exec','-T','runner-daemon','docker','container','ls','-aq','--filter','label=io.golf.runner.attempt='+death_attempt)
                    assert residue()
                    command('kill','-s','SIGKILL','runner')
                    assert residue()
                    command('start','runner')
                    def refused_reuse():
                        info=json.loads(command('ps','-a','--format','json','runner'))
                        if isinstance(info,list):info=info[0]
                        return info.get('State')=='exited' and info.get('ExitCode')!=0
                    assert helpers.until(refused_reuse,timeout=30)
                    assert residue()
                    command('run','--rm','--no-deps','runner','recover')
                    recovered=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':death_run['id']})['run']
                    assert recovered['id']==death_run['id'] and recovered['attemptId']==death_attempt and recovered['state']=='WORKFLOW_RUN_STATE_LOST'
                    assert not residue() and not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.attempt='+death_attempt)
                    count=2+int(WITH_PUSH)
                    assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==count
                    command('start','runner')
                    assert helpers.until(lambda: json.loads(command('ps','--format','json','runner')).get('State')=='running',timeout=20)
                    record(workerDeath={'duringAdmittedStep':True,'signal':'SIGKILL','residueObserved':True,'reuseRefused':True,'explicitCoordinatorFence':True,'originalAttemptLost':True,'replacementRunCreated':False,'attemptContainersAbsent':True,'attemptVolumesAbsent':True},runCount=count)

            passed=True
        except Exception as error:
            if started:
                try:helpers.private_write(output/'private-runner-failure.log',redact(command('logs','--no-color','--tail','80','runner')))
                except Exception:pass
                try:helpers.private_write(output/'private-native-failure.log',redact(command('logs','--no-color','--tail','100',forge)))
                except Exception:pass
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
            if git_tag:
                try:execute('docker','image','rm','--no-prune',git_tag)
                except Exception:cleanup.append('owned-git-tag')
            try:
                after=snapshot();helpers.private_write(output/'foreign-after.json',json.dumps(after,indent=2));difference=notifications.foreign_diff(before,after);record(foreignComparison=difference,foreignIdentityUnchanged=difference['identityUnchanged']);assert difference['identityUnchanged']
            except Exception:cleanup.append('foreign-identity')
            smoke.GOLF,smoke.GITEA=previous
            smoke.client,smoke.request=original_client,original_request
            if ci_tag:
                try:execute("docker","image","rm","--no-prune",ci_tag)
                except Exception:cleanup.append("owned-ci-tag")
            record(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,bootstrap={'unmanagedTokenlessAdministrator':bootstrap_created,'disposedWithOwnedNativeVolume':started and 'owned-resources' not in cleanup},lastStage=STAGE)
            if 'originalFailure' not in manifest:assert not cleanup
    assert passed
    print('PASS: bounded actual unchanged Requests proof.' if WITH_ORDINARY else 'PASS: bounded actual maintained two-job needs/fresh-workspace/scoped-log proof; broader acceptance remains open.')


if __name__=='__main__':
    try:
        if '--self-check' in sys.argv:self_check()
        else:main()
    except Exception as error:
        if REPORT_FAILURE is not None:
            try:REPORT_FAILURE(error)
            except Exception:pass
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
