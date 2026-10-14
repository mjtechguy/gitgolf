#!/usr/bin/env python3
"""Actual fresh-stack execution-values proof, using already-built local images.

Source checking does not execute this proof. Requires an operator to seed the
owned fresh DinD with the pinned public job/daemon images during its bounded
seed window; this helper never pulls or builds. Uses supported native APIs,
managed browser RPCs and operator CLI. Synthetic secrets stay in memory or
encrypted product storage, never in source/controller environment/artifacts.
No provider inference, retained-instance policy changes or notifications.
"""
import argparse
import base64
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
import time
import traceback
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
import smoke
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('execution_values_actions', ROOT/'scripts/actions-engine-smoke.py')
actions = importlib.util.module_from_spec(spec); spec.loader.exec_module(actions)
helpers = actions.helpers
CATALOG, ENGINE, IMAGE = actions.CATALOG, actions.ENGINE, actions.IMAGE
DIND = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
SERVICE = 'RepositoryExecutionValueService/'
WITHHELD, REDACTED = 'WORKFLOW_OUTPUT_STATE_WITHHELD', 'WORKFLOW_OUTPUT_STATE_REDACTED'
PATH = '.github/workflows/values.yml'
STAGE = 'arguments'
WORKFLOW = b'''name: Repository environment qualification
on:
  workflow_dispatch: {}
defaults:
  run: {shell: sh}
jobs:
  cells:
    runs-on: linux
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix: {cell: [a, b]}
    steps:
      - id: environment
        name: Read explicitly approved environment
        run: |
          test -n "$BUILD_CREDENTIAL"
          test "$BUILD_REGION" = "owned-region"
          test -z "${GOLF_RUNNER_KEY:-}"
          printf 'visible-region-ok\\n'
          head -c 4090 /dev/zero | tr '\\000' x
          printf '%s\\n' "$BUILD_CREDENTIAL"
          sleep 15
          printf 'verified-environment-complete\\n'
  conclusion:
    needs: cells
    runs-on: linux
    steps: [{id: conclusion, run: 'echo verified-dependent-conclusion'}]
'''


def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)


def positive(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[1-9][0-9]{0,18}', value)) and int(value) <= 9223372036854775807


def receipt(value, request, action):
    value = value['operation']
    assert value['target'] == request['target'] and value['operationId'] == request['operationId']
    assert value['itemId'] == request['id'] and value['action'] == action
    assert value['acceptedVersion'] == str(int(request['expectedVersion'])+1)
    assert value['acceptedBrokerRevision'] == str(int(request['expectedBrokerRevision'])+1)
    assert datetime.fromisoformat(value['committedAt'].replace('Z','+00:00'))
    return value


def exact_run(value, native, head, binding, blob):
    assert str(uuid.UUID(value['id'])) == value['id']
    assert value['repositoryId'] == str(native['id']) and value['ownerId'] == str(native['owner']['id'])
    assert value['commitId'] == head and value['workflowPath'] == PATH and value['workflowBlobId'] == blob
    assert value['sourceSha256'] == binding['sourceSha256'] and value['engineCatalog'] == CATALOG and value['engineCommit'] == ENGINE
    assert value['executionBindingId'] == binding['id'] and value['executionBindingVersion'] == binding['version']
    return value


def safe_manifest(value, forbidden):
    raw = json.dumps(value, indent=2)+'\n'
    assert all(not item or item not in raw for item in forbidden), 'Private material entered a metadata artifact'
    return raw


def self_check():
    assert b'BUILD_CREDENTIAL' in WORKFLOW and b'4090' in WORKFLOW and b'fail-fast: false' in WORKFLOW
    target = {'repository': {'owner':'owned','name':'fixture'}, 'repositoryId':'1','ownerId':'2','accessRevision':'a'*64}
    request = {'target':target,'operationId':str(uuid.uuid4()),'id':str(uuid.uuid4()),'expectedVersion':'0','expectedBrokerRevision':'3'}
    row = {'operation':{'target':target,'operationId':request['operationId'],'itemId':request['id'],'action':'save_value','acceptedVersion':'1','acceptedBrokerRevision':'4','committedAt':'2026-10-04T01:00:00Z'}}
    receipt(row,request,'save_value')
    for field in ('itemId','acceptedVersion','acceptedBrokerRevision','action'):
        changed = {'operation':{**row['operation'],field:'wrong'}}
        try: receipt(changed,request,'save_value')
        except (AssertionError, ValueError): pass
        else: raise AssertionError('Wrong immutable receipt accepted')
    assert positive('9223372036854775807') and not positive('9223372036854775808') and not positive('01')
    try: safe_manifest({'unsafe':'private'},['private'])
    except AssertionError: pass
    else: raise AssertionError('Private artifact accepted')
    print('PASS: source-only receipt, workflow and artifact guards; no Docker/native/browser execution.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='already-built exact local Golf image')
    parser.add_argument('--runner-image', required=True, help='already-built exact local runner/helper image')
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    parser.add_argument('--output', '--output-dir', dest='output', type=Path, required=True, help='new owner-only artifact directory')
    parser.add_argument('--ui', action='store_true', help='actual settings/run captures through the prepared browser helper')
    parser.add_argument('--seed-timeout', type=int, default=300, help='bounded wait for operator-seeded fresh DinD images, 1–600 seconds')
    args = parser.parse_args(); stack = args.stack_root.resolve(); output = args.output.resolve()
    assert 1 <= args.seed_timeout <= 600 and not output.exists()
    output.mkdir(parents=True, mode=0o700); output.chmod(0o700)
    for path in ('compose.yaml','deploy/compose/compose.ci.yaml','deploy/compose/compose.actions-engine.yaml','deploy/compose/compose.runner-tls.yaml'):
        assert (stack/path).is_file()
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k != 'DATABASE_URL'}
    def run(*argv, payload=None, timeout=180, expected=0):
        result = subprocess.run(argv, input=None if payload is None else json.dumps(payload).encode(), cwd=stack, env=environment, capture_output=True, timeout=timeout)
        assert result.returncode == expected and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Bounded subprocess failed; private diagnostics withheld'
        return result.stdout.decode()
    core_record = json.loads(run('docker','image','inspect',args.image))[0]
    core = core_record['Id']; worker = json.loads(run('docker','image','inspect',args.runner_image))[0]['Id']
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',core) and re.fullmatch(r'sha256:[a-f0-9]{64}',worker)
    # The host daemon image is a precondition, never an implicit registry fetch.
    assert json.loads(run('docker','image','inspect',DIND))[0]['Os'] == 'linux'
    stage('exact local images and two-GiB fresh-stack reserve')
    space = run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',core,'-Pk','/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024
    project = 'golf-values-proof-'+secrets.token_hex(5)
    ports = helpers.free_ports(3); old_urls = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{ports[0]}', f'http://127.0.0.1:{ports[1]}'
    secure_url = f'https://127.0.0.1:{ports[2]}'
    synthetic = secrets.token_hex(32)  # Never persisted by this helper.
    forbidden = [synthetic]; actors = {}; started = False; cleanup = []; passed = False
    revision = (core_record.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    manifest = {'passed':False,'complete':False,'sourceRevision':revision if isinstance(revision,str) and re.fullmatch('[a-f0-9]{40}',revision) else None,
                'workingTreeHead':run('git','rev-parse','HEAD').strip(),'golfImageId':core,'runnerImageId':worker,'runs':[],
                'limitations':['Repository maintained-Actions environment only; no OIDC/org/environment/fork/agent/CD/expression-context/full Actions qualification.',
                               'Exact strings only: transformed-secret concealment is not proved.', 'Notification family counted but no notification is created/sent.',
                               'No crash/unknown-completion/recovery qualification; these remain source fault evidence only.']}
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        # Generate real TLS trust in this removed private directory. The mounted
        # server key is readable by the non-root Golf user; parent dir stays0700.
        ca, cert, key = directory/'ca.crt', directory/'server.crt', directory/'server.key'
        ca_config = directory/'ca.conf'; helpers.private_write(ca_config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        ext = directory/'extensions'; helpers.private_write(ext,'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(ca_config),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        run('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(directory/'server.csr'))
        run('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(ext),'-out',str(cert))
        (directory/'ca.key').chmod(0o600); key.chmod(0o444); ca.chmod(0o444); cert.chmod(0o444)
        runner_key = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        legacy, next_key = [base64.b64encode(secrets.token_bytes(32)).decode() for _ in range(2)]
        values = {k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY='',GOLF_ENCRYPTION_KEYS=json.dumps({'legacy':legacy,'next':next_key}),GOLF_ACTIVE_ENCRYPTION_KEY='legacy',
                      GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=runner_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':runner_key}),
                      GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),
                      GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),
                      GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        forbidden.extend([runner_key,legacy,next_key])
        forbidden.extend(v for k,v in values.items() if v and k not in ('GOLF_PUBLIC_URL','GOLF_INTERNAL_TLS_LISTEN_ADDR','GOLF_RUNNER_JOB_IMAGE','GOLF_RUNNER_TLS_URL','GOLF_ACTIVE_ENCRYPTION_KEY'))
        env_file, override = directory/'core.env', directory/'proof.yaml'
        def write_env():
            text = ''.join(k+"='"+v+"'\n" for k,v in values.items())
            if env_file.exists(): env_file.write_text(text); env_file.chmod(0o600)
            else: helpers.private_write(env_file,text)
        write_env()
        helpers.private_write(override,f'''services:
  golf:
    image: {core}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443"]
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
  runner-actions-image-init:
    entrypoint: [/bin/true]
    command: []
    pull_policy: never
''')
        compose = ['docker','compose','-p',project,'--env-file',str(env_file)]
        for path in ('compose.yaml','deploy/compose/compose.ci.yaml','deploy/compose/compose.actions-engine.yaml','deploy/compose/compose.runner-tls.yaml'):
            compose += ['-f',str(stack/path)]
        compose += ['-f',str(override)]
        def command(*argv,**kwargs): return run(*compose,*argv,**kwargs)
        def admin(*argv): return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*argv).strip()
        def rpc(actor, method, payload=None, **kwargs): return smoke.rpc(actor['session'],method,payload,**kwargs)
        def broker(actor, method, payload=None, **kwargs): return rpc(actor,SERVICE+method,payload,**kwargs)
        def metadata(sql): return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',sql).strip()
        def runtime():
            row = json.loads(run('docker','inspect',command('ps','-q','golf').strip()))[0]
            assert row['Image'] == core
            return {'containerImageReference':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
        def target(actor):
            access = rpc(actor,'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
            assert access['repositoryId'] == str(native['id']) and access['ownerId'] == str(native['owner']['id']) and re.fullmatch('[a-f0-9]{64}',access['revision'])
            return {'repository':repository,'repositoryId':access['repositoryId'],'ownerId':access['ownerId'],'accessRevision':access['revision']}
        def inventory(actor):
            t = target(actor); result = broker(actor,'ListRepositoryExecutionValues',{'target':t})
            assert result['target'] == t and result['maximumValues'] == 64 and result['maximumBindings'] == 20 and result['consumerProfile'] == 'golf.repository-env.v1'
            return result
        def value_request(actor, item_id, version, kind, name, body):
            current = inventory(actor)
            return {'target':current['target'],'id':item_id,'expectedVersion':version,'expectedBrokerRevision':current['brokerRevision'],
                    'operationId':str(uuid.uuid4()),'name':name,'kind':kind,'value':body}
        def approval(actor, value_refs, item_id=None, version='0'):
            current = inventory(actor)
            request = {'target':current['target'],'id':item_id or str(uuid.uuid4()),'expectedVersion':version,'expectedBrokerRevision':current['brokerRevision'],
                       'operationId':str(uuid.uuid4()),'workflowPath':PATH,'commitId':head,'event':'WORKFLOW_RUN_ORIGIN_MANUAL',
                       'values':value_refs,'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat().replace('+00:00','Z')}
            result = receipt(broker(actor,'SaveRepositoryExecutionBinding',request),request,'save_binding')
            binding = next(v for v in inventory(actor)['bindings'] if v['id'] == request['id'])
            assert binding['version'] == result['acceptedVersion'] and binding['commitId'] == head and binding['workflowBlobId'] == blob and binding['engineCatalog'] == CATALOG
            assert re.fullmatch('[a-f0-9]{64}',binding['sourceSha256']) and binding['values'] == value_refs and binding['approvalState'] == 'requires_current_authority'
            return binding
        def dispatch(binding):
            value = rpc(owner,'WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':str(uuid.uuid4())})['run']
            return exact_run(value,native,head,binding,blob)
        def read_run(run): return rpc(owner,'WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']
        def quarantine(run):
            return json.loads(metadata("SELECT json_build_object('quarantined',(SELECT count(*) FROM golf_workflow_quarantined_outputs WHERE run_id='"+run['id']+"'::uuid),'readable',(SELECT count(*) FROM golf_workflow_run_logs WHERE run_id='"+run['id']+"'::uuid))"))
        def wait_raw(run):
            def check():
                observed = read_run(run); exact_run(observed,native,head,current_binding,blob)
                assert observed['outputState'] == WITHHELD
                logs = rpc(owner,'WorkflowRunService/GetWorkflowRunLogs',{'runId':run['id']})
                assert logs['outputState'] == WITHHELD and not logs.get('logs')
                counts = quarantine(run); assert counts['readable'] == 0
                return observed if counts['quarantined'] >= 3 else None
            return helpers.until(check,timeout=180)
        def terminal(run, allow_success=False):
            observed = helpers.until(lambda: (r if r['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None) if (r:=read_run(run)) else None,timeout=240)
            if not allow_success: assert observed['state'] != 'WORKFLOW_RUN_STATE_SUCCEEDED' and observed['outputState'] == WITHHELD and quarantine(run)['readable'] == 0
            return observed
        def logs(run, job=None, step=None):
            after = 0; rows = []
            for _ in range(64):
                request = {'runId':run['id'],'afterSequence':str(after)}
                if job: request.update(jobInstanceId=job,stepId=step)
                page = rpc(owner,'WorkflowRunService/GetWorkflowRunLogs',request)
                assert page['outputState'] == REDACTED and page['runId'] == run['id'] and page['attemptId'] == run['attemptId'] and page['repositoryId'] == str(native['id']) and page['sourceCommitId'] == head
                assert page.get('jobInstanceId','') == (job or '') and page.get('stepId','') == (step or '') and not page.get('truncated',False)
                for row in page.get('logs',[]):
                    seq = int(row['sequence']); assert seq > after and (job or seq == after+1)
                    assert synthetic not in row['text']; after = seq; rows.append(row)
                if not page.get('hasMore',False): return rows
                assert page.get('logs')
            raise AssertionError('Log continuation exhausted bound')
        def machine(url, capability, tls_context=None):
            body = json.dumps({'catalogs':[CATALOG],**({'capabilities':['golf.repository-env.v1']} if capability else {})}).encode()
            request = urllib.request.Request(url+'/internal/ci/poll',data=body,headers={'Authorization':'Bearer '+runner_key,'Golf-Runner-ID':'local-docker','Content-Type':'application/json'})
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=tls_context)) if tls_context else urllib.request.build_opener()
            with opener.open(request,timeout=15) as response: assert response.status == 204 and not response.read(4096)
        try:
            stage('fresh core, real TLS endpoint and bounded externally seeded daemon')
            started = True
            command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf','runner-daemon')
            command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init')
            smoke.ready(); baseline = runtime(); manifest['runtimeBefore'] = baseline
            context = ssl.create_default_context(cafile=str(ca)); context.minimum_version = ssl.TLSVersion.TLSv1_3
            with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw:
                with context.wrap_socket(raw,server_hostname='127.0.0.1') as secured: assert secured.version() == 'TLSv1.3'
            for wrong in ('wrong.golf.invalid',):
                try:
                    with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw: context.wrap_socket(raw,server_hostname=wrong)
                except ssl.SSLCertVerificationError: pass
                else: raise AssertionError('Wrong TLS hostname trusted')
            untrusted = ssl.create_default_context(); untrusted.minimum_version = ssl.TLSVersion.TLSv1_3
            try:
                with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw: untrusted.wrap_socket(raw,server_hostname='127.0.0.1')
            except ssl.SSLCertVerificationError: pass
            else: raise AssertionError('Untrusted CA accepted')
            manifest['tls'] = {'version':'TLSv1.3','sanLoopbackVerified':True,'wrongHostnameDenied':True,'untrustedCADenied':True}
            old_tls = ssl.create_default_context(cafile=str(ca)); old_tls.maximum_version = ssl.TLSVersion.TLSv1_2
            try:
                with socket.create_connection(('127.0.0.1',ports[2]),timeout=10) as raw: old_tls.wrap_socket(raw,server_hostname='127.0.0.1')
            except ssl.SSLError: pass
            else: raise AssertionError('TLS1.2 accepted')
            manifest['tls']['tls12Denied'] = True
            daemon = command('ps','-q','runner-daemon').strip(); assert re.fullmatch('[a-f0-9]{12,64}',daemon)
            helpers.private_write(output/'seed-pending.json',json.dumps({'schema':'golf.execution-values.seed.v1','project':project,'containerId':daemon,'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_timeout,'helperNeverPullsOrBuilds':True},indent=2)+'\n')
            os.replace(output/'seed-pending.json',output/'seed.json')
            print('PREREQUISITE: operator-seed owned fresh daemon '+daemon+' with pinned Alpine and DinD images; helper never pulls/builds.',flush=True)
            def seeded():
                receipts = []
                for image in (IMAGE,DIND):
                    rows = json.loads(command('exec','-T','runner-daemon','docker','image','inspect',image))
                    assert len(rows) == 1 and rows[0]['Os'] == 'linux' and re.fullmatch('sha256:[a-f0-9]{64}',rows[0]['Id'])
                    matching = [v for v in rows[0].get('RepoDigests',[]) if v.endswith('@'+image.split('@')[1])]; assert matching
                    receipts.append({'imageReference':image,'resolvedImageId':rows[0]['Id'],'registryDigest':matching[0]})
                return receipts
            seeded_images = helpers.until(seeded,timeout=args.seed_timeout)
            manifest['seededImages'] = seeded_images
            helpers.private_write(output/'seed-ready.json',json.dumps({'schema':'golf.execution-values.seed.v1','project':project,'containerId':daemon,'verifiedImages':seeded_images},indent=2)+'\n')
            for role in ('owner','approver','reader'):
                name = 'values-'+role+'-'+secrets.token_hex(4); email = name+'@example.invalid'; password = secrets.token_urlsafe(32)
                actor = {'name':name,'email':email,'password':password}; actors[role] = actor; forbidden.append(password)
                admin('create','--username',name,'--email',email,'--random-password','--must-change-password=false'); actor['nativeCreated'] = True
                actor['token'] = admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:repository','--raw'); forbidden.append(actor['token'])
                command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':email,'password':password,'forge_token':actor['token'],'is_instance_admin':role=='owner'}); actor['enrolled'] = True
                actor['session'] = smoke.client(); rpc(actor,'SessionService/LoginWithPassword',{'username':email,'password':password})
            owner, approver, reader = (actors[k] for k in ('owner','approver','reader'))
            native = smoke.provider(owner['token'],'POST','user/repos',{'name':'values-proof','private':True,'auto_init':True},expected=201)
            repository = {'owner':owner['name'],'name':native['name']}; base = 'repos/'+owner['name']+'/'+native['name']; smoke.wait_for_push(owner['token'],native['full_name'])
            for actor, permission in ((approver,'admin'),(reader,'read')):
                smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actor['name'],{'permission':permission},expected=204)
            smoke.provider(owner['token'],'POST',base+'/contents/'+PATH,{'content':base64.b64encode(WORKFLOW).decode(),'message':'Controlled environment consumer'},expected=201)
            head = smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id']; assert re.fullmatch('[a-f0-9]{40}',head)
            blob = hashlib.sha1(b'blob '+str(len(WORKFLOW)).encode()+b'\0'+WORKFLOW).hexdigest()
            for scope in ('INSTANCE','REPOSITORY'):
                selection = {'scope':'EXECUTION_SCOPE_'+scope,**({'repository':repository} if scope=='REPOSITORY' else {})}
                p = rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',selection)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{**selection,'scopeId':p['scopeId'],'expectedRevision':p.get('revision','0'),'expectedAuthorityRevision':p['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('native-admin metadata, encrypted versions, CAS/replay/status and strict target boundaries')
            request = value_request(owner,str(uuid.uuid4()),'0','REPOSITORY_EXECUTION_VALUE_KIND_SECRET','BUILD_CREDENTIAL',synthetic)
            original = receipt(broker(owner,'SaveRepositoryExecutionValue',request),request,'save_value'); secret_id = request['id']
            replay = receipt(broker(owner,'SaveRepositoryExecutionValue',request),request,'save_value'); assert replay.get('replayed') is True
            inspected = broker(owner,'GetRepositoryExecutionValueOperation',{'target':target(owner),'operationId':request['operationId']})['operation']; assert inspected['itemId'] == secret_id and inspected['acceptedVersion'] == '1'
            broker(owner,'SaveRepositoryExecutionValue',{**request,'value':synthetic+'x'},expected=409,code='aborted')
            broker(owner,'GetRepositoryExecutionVariable',{'target':target(owner),'id':secret_id,'version':'1'},expected=404)
            broker(reader,'ListRepositoryExecutionValues',{'target':target(reader)},expected=403)
            wrong = target(owner); wrong['repositoryId'] = str(int(wrong['repositoryId'])+1)
            broker(owner,'ListRepositoryExecutionValues',{'target':wrong},expected=404)
            variable_request = value_request(owner,str(uuid.uuid4()),'0','REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE','BUILD_REGION','initial-region')
            receipt(broker(owner,'SaveRepositoryExecutionValue',variable_request),variable_request,'save_value'); variable_id = variable_request['id']
            variable = broker(owner,'GetRepositoryExecutionVariable',{'target':target(owner),'id':variable_id,'version':'1'}); assert variable['value'] == 'initial-region'
            edit_variable = value_request(owner,variable_id,'1','REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE','BUILD_REGION','owned-region')
            receipt(broker(owner,'SaveRepositoryExecutionValue',edit_variable),edit_variable,'save_value')
            broker(owner,'GetRepositoryExecutionVariable',{'target':target(owner),'id':variable_id,'version':'1'},expected=404)
            assert broker(owner,'GetRepositoryExecutionVariable',{'target':target(owner),'id':variable_id,'version':'2'})['value'] == 'owned-region'
            # All7 are managed-browser procedures; even metadata reads do not
            # become API-token grants. No malformed write is admitted here.
            credential = rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Execution broker denial fixture','lifetimeSeconds':600})
            forbidden.append(credential['token'])
            procedures = ('ListRepositoryExecutionValues','SaveRepositoryExecutionValue','DeleteRepositoryExecutionValue','GetRepositoryExecutionVariable','SaveRepositoryExecutionBinding','DeleteRepositoryExecutionBinding','GetRepositoryExecutionValueOperation')
            for procedure in procedures:
                broker(owner,procedure,{},expected=403,headers={'Origin':'https://wrong.golf.invalid'})
                smoke.rpc(smoke.client(),SERVICE+procedure,{},expected=403,headers={'Authorization':'Bearer '+credential['token']})
            rpc(owner,'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']})
            manifest['browserOnlyAuthority'] = {'foreignOriginDenials':7,'apiBearerDenials':7}
            refs = [{'id':secret_id,'version':'1'},{'id':variable_id,'version':'2'}]
            current_binding = approval(owner,refs)
            stage('HTTP/no-capability claims refuse secret assignment before real TLS runner')
            queued = dispatch(current_binding); machine(smoke.GOLF,True); machine(secure_url,False,context); assert read_run(queued)['state'] == 'WORKFLOW_RUN_STATE_QUEUED'
            manifest['transportAdmission'] = {'httpCapableClaimExcluded':True,'tlsNoCapabilityClaimExcluded':True}
            rpc(owner,'WorkflowRunService/DispatchWorkflow',{'repository':repository,'workflowPath':PATH,'idempotencyKey':str(uuid.uuid4())},expected=400,code='failed_precondition')
            command('up','-d','--no-build','--pull','never','runner',timeout=180)
            stage('actual exact-H matrix execution keeps genuine raw output encrypted until verified completion')
            running = wait_raw(queued); manifest['withheldObserved'] = {'runId':running['id'],'quarantinedCountsOnly':quarantine(running),'outputState':running['outputState']}
            observed = terminal(queued,allow_success=True); exact_run(observed,native,head,current_binding,blob)
            assert observed['state'] == 'WORKFLOW_RUN_STATE_SUCCEEDED' and observed['outputState'] == REDACTED and re.fullmatch('[a-f0-9]{32}',observed['attemptId'])
            expected_jobs = {actions.instance('cells',{'cell':'a'}),actions.instance('cells',{'cell':'b'}),actions.instance('conclusion',{})}
            assert len(observed['jobs']) == 3 and {j['instanceId'] for j in observed['jobs']} == expected_jobs
            for job in observed['jobs']:
                assert job['eventsRecorded'] is True and job['state'] == 'WORKFLOW_STEP_STATE_SUCCEEDED' and len(job['steps']) == 1 and job['steps'][0]['state'] == 'WORKFLOW_STEP_STATE_SUCCEEDED'
            selected = actions.instance('cells',{'cell':'a'}); selected_rows = logs(observed,selected,'environment'); text = ''.join(v['text'] for v in selected_rows)
            expected = 'x'*4090+'*'*len(synthetic)+'\n'
            assert expected in text and 'visible-region-ok' in text and 'verified-environment-complete' in text
            # Independently expected 4096-byte forwarding boundary:6/58 secret
            # bytes occur in separate durable receipt rows and are both masked.
            assert any(v['text'].endswith('x'*4090+'*'*6) for v in selected_rows)
            assert any(v['text'].startswith('*'*(len(synthetic)-6)+'\n') for v in selected_rows)
            assert synthetic not in ''.join(v['text'] for v in logs(observed))
            manifest['runs'].append({k:observed[k] for k in ('id','state','attemptId','commitId','sourceSha256','workflowBlobId','executionBindingId','executionBindingVersion','outputState','jobs')})
            manifest['crossChunkExactMask'] = {'verified':True,'maskedAcrossTwoRows':True,'selectedJobInstanceId':selected,'stepId':'environment','chunkCount':len(selected_rows)}
            if args.ui:
                stage('actual mounted settings and redacted run browser proof')
                screens = output/'browser'; screens.mkdir(mode=0o700)
                result = run('node',str(ROOT/'scripts/repository-execution-values-browser.mjs'),payload={'stackRoot':str(stack),'golf':smoke.GOLF,'screenshots':str(screens),'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id']),'email':owner['email'],'username':owner['name'],'password':owner['password'],'secret':synthetic,'run':observed,'selectedJob':selected,'runtime':baseline,'sourceRevision':manifest['sourceRevision']},timeout=240)
                assert result.strip().endswith('PASS: actual execution values settings/run captures; no browser mutations.')
                manifest['browser'] = {'passed':True,'manifestSha256':hashlib.sha256((screens/'manifest.json').read_bytes()).hexdigest()}
            stage('value version replacement cancels live bound output without release')
            interrupted = dispatch(current_binding); wait_raw(interrupted)
            replace = value_request(owner,secret_id,'1','REPOSITORY_EXECUTION_VALUE_KIND_SECRET','BUILD_CREDENTIAL',synthetic)
            receipt(broker(owner,'SaveRepositoryExecutionValue',replace),replace,'save_value'); terminal(interrupted)
            refs[0]['version'] = '2'; current_binding = approval(owner,refs,current_binding['id'],current_binding['version'])
            stage('current native administrator revocation prevents final output release')
            current_binding = approval(approver,refs,current_binding['id'],current_binding['version']); revoked = dispatch(current_binding); wait_raw(revoked)
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+approver['name'],{'permission':'read'},expected=204); terminal(revoked)
            broker(approver,'ListRepositoryExecutionValues',{'target':target(approver)},expected=403)
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+approver['name'],{'permission':'admin'},expected=204)
            stage('approval-session logout prevents release independently of dispatch session')
            current_binding = approval(approver,refs,current_binding['id'],current_binding['version']); signed_out = dispatch(current_binding); wait_raw(signed_out)
            rpc(approver,'SessionService/Logout'); approver['session'] = None; terminal(signed_out)
            stage('binding removal and value tombstone preserve encrypted retained history')
            current_binding = approval(owner,refs,current_binding['id'],current_binding['version']); removed = dispatch(current_binding); wait_raw(removed)
            current = inventory(owner); delete = {'target':current['target'],'id':current_binding['id'],'expectedVersion':current_binding['version'],'expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4())}
            receipt(broker(owner,'DeleteRepositoryExecutionBinding',delete),delete,'delete_binding'); terminal(removed)
            current = inventory(owner); delete_value = {'target':current['target'],'id':secret_id,'expectedVersion':'2','expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4())}
            receipt(broker(owner,'DeleteRepositoryExecutionValue',delete_value),delete_value,'delete_value')
            assert next(v for v in inventory(owner)['values'] if v['id'] == secret_id)['deleted'] is True
            stage('drained encryption rotation counts both retained execution families and preserves withheld histories')
            status = json.loads(command('exec','-T','golf','golf','keys','status'))['result']
            assert sum(k['repository_execution_values'] for k in status['keys']) >= 4 and sum(k['workflow_quarantined_outputs'] for k in status['keys']) > 0
            assert all('notification_contents' in k for k in status['keys'])
            command('stop','runner','golf')
            operator = lambda *argv, expected=0: json.loads(command('run','--rm','--no-deps','-T','--pull','never','-e','GOLF_ACTIVE_ENCRYPTION_KEY=next','golf','keys',*argv,expected=expected))
            assert operator('activate')['state'] == 'complete'
            operator('retirement-check','--key-id','legacy',expected=1)
            rotated = operator('rotate','--batch-size','100','--max-batches','100','--timeout','5m'); assert rotated['state'] == 'complete'
            assert rotated['result']['rotated_repository_execution_values'] >= 4 and rotated['result']['rotated_workflow_quarantined_outputs'] > 0
            assert operator('retirement-check','--key-id','legacy')['state'] == 'eligible'
            values['GOLF_ACTIVE_ENCRYPTION_KEY'] = 'next'; values['GOLF_ENCRYPTION_KEYS'] = json.dumps({'next':next_key}); write_env()
            command('up','-d','--no-build','--pull','never','golf'); smoke.ready()
            assert inventory(owner)['values'] and broker(owner,'GetRepositoryExecutionVariable',{'target':target(owner),'id':variable_id,'version':'2'})['value'] == 'owned-region'
            for stale in (interrupted,revoked,signed_out,removed): assert read_run(stale)['outputState'] == WITHHELD and quarantine(stale)['readable'] == 0
            after = runtime(); assert after['containerImageReference'] == baseline['containerImageReference']
            manifest['runtimeAfterRotation'] = after; manifest['keyRotation'] = {'bothExecutionFamiliesRotated':True,'legacyRetirementEligible':True,'restartedWithoutLegacyKey':True,'notificationFamilyCountedOnly':True}
            manifest['authorityFences'] = ['value-version-change','native-admin-loss','approval-session-logout','binding-removal']
            passed = True
        except Exception as error:
            frames = traceback.extract_tb(error.__traceback__)
            manifest['originalFailure'] = {'type':type(error).__name__,'stage':STAGE,'line':frames[-1].lineno}
            raise
        finally:
            for actor in actors.values():
                if actor.get('session') is not None:
                    try: rpc(actor,'SessionService/RevokeOtherSessions'); rpc(actor,'SessionService/Logout')
                    except Exception: cleanup.append('managed-session-cleanup')
                if actor.get('enrolled'):
                    try: command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                    except Exception: cleanup.append('managed-account-disable')
                if actor.get('nativeCreated'):
                    try: admin('delete','--username',actor['name'],'--purge')
                    except Exception: cleanup.append('native-actor-purge')
            if started:
                try:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):
                        assert not run('docker',*argv,'--filter','label=com.docker.compose.project='+project).strip()
                except Exception: cleanup.append('fresh-compose-resources')
            smoke.GOLF, smoke.GITEA = old_urls
            manifest.update(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,lastStage=STAGE)
            helpers.private_write(output/'manifest.json',safe_manifest(manifest,forbidden))
            if 'originalFailure' not in manifest:
                assert not cleanup, 'Owned cleanup failed; diagnostics withheld'
            print('Cleanup: managed sessions revoked/accounts disabled, native actors purged, fresh project and volumes removed.',flush=True)
    assert passed
    print('PASS: real TLS repository environment, quarantine/redaction, authority/version fences and retained-key lifecycle; broader Secrets/OIDC remains Partial.')


if __name__ == '__main__':
    try:
        if '--self-check' in sys.argv: self_check()
        else: main()
    except Exception as error:
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
