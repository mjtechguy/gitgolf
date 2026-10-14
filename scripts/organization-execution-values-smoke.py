#!/usr/bin/env python3
"""Prepared fresh-stack organization execution-values qualification, using already-built local images.

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
SERVICE = 'OrganizationExecutionValueService/'
REPOSITORY_SERVICE = 'RepositoryExecutionValueService/'
PROOF = None
OUTPUT = None
WITHHELD, REDACTED = 'WORKFLOW_OUTPUT_STATE_WITHHELD', 'WORKFLOW_OUTPUT_STATE_REDACTED'
PATH = '.github/workflows/values.yml'
STAGE = 'arguments'
WORKFLOW = b'''name: Organization environment qualification
on:
  workflow_dispatch: {}
defaults:
  run: {shell: sh}
jobs:
  environment:
    runs-on: linux
    steps:
      - id: environment
        name: Verify explicitly approved environment without printing values
        run: |
          test "${#BUILD_CREDENTIAL}" -eq 64
          test "$BUILD_REGION" = "owned-region"
          test -z "${GOLF_RUNNER_KEY:-}"
          printf 'verified-environment-present\\n'
          sleep 20
          printf 'verified-environment-complete\\n'
'''

def stage(value):
    global STAGE
    STAGE = value
    print('CHECK: '+value, flush=True)
    if PROOF is not None: PROOF['stage'] = value


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


def canonical(value, positive=False):
    return isinstance(value,str) and bool(re.fullmatch(r'0|[1-9][0-9]{0,18}',value)) and int(value)<=9223372036854775807 and (not positive or value!='0')


def checked_rpc(session,procedure,payload=None,expected=200,headers=None,code=None):
    """One real dispatch; persist only procedure/status/code, never error bodies."""
    request=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure,data=json.dumps(payload or {}).encode(),method='POST',headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
    try: response=session.open(request,timeout=15)
    except urllib.error.HTTPError as error: response=error
    except (urllib.error.URLError,OSError) as error:
        if PROOF is not None: PROOF['failedProcedure']={'procedure':procedure,'transportFailure':type(error).__name__}
        raise RuntimeError('RPC unavailable; private diagnostics withheld') from None
    with response:
        raw=response.read((2<<20)+1);assert len(raw)<=2<<20
        result=json.loads(raw) if raw else None
        fact={'procedure':procedure,'status':response.status,'noStore':response.headers.get('Cache-Control')=='no-store'}
        if isinstance(result,dict) and isinstance(result.get('code'),str) and re.fullmatch('[a-z_]{1,64}',result['code']):fact['code']=result['code']
        if PROOF is not None:
            assert len(PROOF['procedureObservations'])<4096;PROOF['procedureObservations'].append(fact)
        if response.status!=expected or not fact['noStore']:
            if PROOF is not None: PROOF['failedProcedure']=fact
            raise AssertionError('RPC status/protocol mismatch; safe metadata retained')
        if expected!=200:
            codes={400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',409:'aborted',429:'resource_exhausted',503:'unavailable'}
            assert isinstance(result,dict) and result.get('code')==(code or codes[expected])
        return result


def denied_rpc(session,procedure,payload):
    """Only authority-hidden404 or explicit403 counts as denied, never500."""
    request=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure,data=json.dumps(payload).encode(),method='POST',headers={'Origin':smoke.GOLF,'Connect-Protocol-Version':'1','Content-Type':'application/json'})
    try: response=session.open(request,timeout=15)
    except urllib.error.HTTPError as error: response=error
    with response:
        raw=response.read((1<<20)+1);assert len(raw)<=1<<20;body=json.loads(raw)
        fact={'procedure':procedure,'status':response.status,'code':body.get('code'),'noStore':response.headers.get('Cache-Control')=='no-store'}
        if PROOF is not None: PROOF['procedureObservations'].append(fact)
        assert fact['noStore'] and (fact['status'],fact['code']) in ((403,'permission_denied'),(404,'not_found'))
        return fact


def self_check():
    assert b'printf' in WORKFLOW and b'printf \'%s' not in WORKFLOW and b'echo "$BUILD_' not in WORKFLOW and b'test "${#BUILD_CREDENTIAL}" -eq 64' in WORKFLOW
    assert b'workflow_dispatch:' in WORKFLOW and b'sleep 20' in WORKFLOW and b'GOLF_RUNNER_KEY' in WORKFLOW
    target={'organization':'owned-org','organizationId':'9007199254740993'}
    request={'target':target,'operationId':str(uuid.uuid4()),'id':str(uuid.uuid4()),'expectedVersion':'0','expectedBrokerRevision':'3'}
    row={'operation':{'target':target,'operationId':request['operationId'],'itemId':request['id'],'action':'save_value','acceptedVersion':'1','acceptedBrokerRevision':'4','committedAt':'2026-10-04T01:00:00Z'}}
    receipt(row,request,'save_value')
    for field in ('itemId','acceptedVersion','acceptedBrokerRevision','action','target'):
        try:receipt({'operation':{**row['operation'],field:'wrong'}},request,'save_value')
        except (AssertionError,ValueError):pass
        else:raise AssertionError('Changed exact receipt accepted')
    assert canonical('0') and canonical('9007199254740993',True) and not canonical('01') and not canonical('9223372036854775808')
    try:safe_manifest({'unsafe':'private-fixture-value'},['private-fixture-value'])
    except AssertionError:pass
    else:raise AssertionError('Private artifact accepted')
    assert max(len('golf-orgv-proof-'+'f'*10+'-'+role) for role in ('owner','approver','reader','outsider','siteadmin','secondowner','bootstrap'))<=40
    print('PASS: source-only org receipt, fixed-output workflow, bounds and artifact guards; no resources executed.')


def main():
    global PROOF, OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='already-built exact local Golf image')
    parser.add_argument('--expected-source',required=True,help='exact 40-character hexadecimal source revision bound by the root-built Golf image receipt')
    parser.add_argument('--runner-image', required=True, help='already-built exact local runner/helper image')
    parser.add_argument('--stack-root', type=Path, default=ROOT)
    parser.add_argument('--output', '--output-dir', dest='output', type=Path, required=True, help='new owner-only artifact directory')
    parser.add_argument('--ui', action='store_true', help='actual settings/run captures through the prepared browser helper')
    parser.add_argument('--seed-timeout', type=int, default=300, help='bounded wait for operator-seeded fresh DinD images, 1–600 seconds')
    args = parser.parse_args(); stack = args.stack_root.resolve(); output = args.output.resolve()
    assert 1 <= args.seed_timeout <= 600 and not output.exists() and re.fullmatch('[a-f0-9]{40}',args.expected_source)
    assert re.fullmatch(r'(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})',args.image) and re.fullmatch(r'(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})',args.runner_image)
    output.mkdir(parents=True, mode=0o700); output.chmod(0o700); OUTPUT=output
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
    project = 'golf-orgv-proof-'+secrets.token_hex(5)
    ports = helpers.free_ports(3); old_urls = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = f'http://127.0.0.1:{ports[0]}', f'http://127.0.0.1:{ports[1]}'
    secure_url = f'https://127.0.0.1:{ports[2]}'
    synthetic = secrets.token_hex(32)  # Never persisted by this helper.
    forbidden = [synthetic]; actors = {}; started = False; cleanup = []; passed = False
    revision = (core_record.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')
    assert revision==args.expected_source, 'Golf image source revision differs from root-bound receipt'
    manifest = {'passed':False,'complete':False,'sourceRevision':revision if isinstance(revision,str) and re.fullmatch('[a-f0-9]{40}',revision) else None,
                'expectedSource':args.expected_source,'helperSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'browserHelperSha256':hashlib.sha256((ROOT/'scripts/organization-execution-values-browser.mjs').read_bytes()).hexdigest(),'workingTreeHead':run('git','rev-parse','HEAD').strip(),'golfImageId':core,'runnerImageId':worker,'runs':[],'checks':[], 'procedureObservations':[],
                 'limitations':['Organization selected-repository maintained-Actions env profile only; no named environments/OIDC/fork/agent/CD/context expressions.',
                               'No native atomic role/ref fence or transformed-secret concealment claim.',
                               'Key rotation, retirement and migration052 fresh recovery remain separate actual qualifications.']}
    PROOF = manifest
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        # Generate real TLS trust in this removed private directory. The mounted
        # server key is readable by the non-root Golf user; parent dir stays0700.
        ca, cert, key = directory/'ca.crt', directory/'server.crt', directory/'server.key'
        ca_config = directory/'ca.conf'; helpers.private_write(ca_config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        ext = directory/'extensions'; helpers.private_write(ext,'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
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
        def rpc(actor, method, payload=None, **kwargs): return checked_rpc(actor['session'],method,payload,**kwargs)
        def broker(actor, method, payload=None, **kwargs): return rpc(actor,SERVICE+method,payload,**kwargs)
        def metadata(sql): return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',sql).strip()
        def runtime():
            row = json.loads(run('docker','inspect',command('ps','-q','golf').strip()))[0]
            assert row['Image'] == core
            return {'containerImageReference':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}

        organizations, repositories = {}, {}
        def login(actor):
            actor['session'] = smoke.client()
            row = rpc(actor,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user']
            assert row['id'] == actor['id'] and row['login'] == actor['name']
        def organization_inventory(actor= None):
            result = broker(actor or owner,'ListOrganizationExecutionValues',{'target':org_target})
            assert result['target'] == org_target and result['maximumValues'] == 64 and result['maximumSelectedRepositories'] == 20 and result['consumerProfile'] == 'golf.repository-env.v1'
            assert len(result.get('values',[])) <= 64 and canonical(result['brokerRevision'])
            return result
        def save_org(item_id, version, name, kind, body=None, selected=None, expires=None, include_body=True):
            current = organization_inventory()
            request = {'target':org_target,'id':item_id,'expectedVersion':version,'expectedBrokerRevision':current['brokerRevision'],
                       'operationId':str(uuid.uuid4()),'name':name,'kind':kind,'selectedRepositories':selected if selected is not None else selections,
                       'expiresAt':expires or (datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat()}
            if include_body: request['value'] = body
            ack = receipt(broker(owner,'SaveOrganizationExecutionValue',request),request,'save_value')
            item = next(v for v in organization_inventory()['values'] if v['value']['id'] == item_id)
            assert item['value']['version'] == ack['acceptedVersion'] and item['selectedRepositories'] == request['selectedRepositories']
            return item, request
        def repo_target(actor= None, selected= None):
            selected = selected or native
            key = {'owner':selected['owner']['login'],'name':selected['name']}
            access = rpc(actor or approver,'RepositoryAccessService/GetRepositoryAccess',{'repository':key})['access']
            assert access['repositoryId'] == str(selected['id']) and access['ownerId'] == str(selected['owner']['id']) and re.fullmatch('[a-f0-9]{64}',access['revision'])
            return {'repository':key,'repositoryId':access['repositoryId'],'ownerId':access['ownerId'],'accessRevision':access['revision']}
        def repo_inventory(actor= None, selected= None):
            target = repo_target(actor,selected)
            result = rpc(actor or approver,REPOSITORY_SERVICE+'ListRepositoryExecutionValues',{'target':target})
            assert result['target'] == target and result['maximumValues'] == 64 and result['maximumBindings'] == 20 and result['consumerProfile'] == 'golf.repository-env.v1'
            for row in result.get('inheritedValues',[]):
                assert row['organizationId'] == org_target['organizationId'] and row['organizationName'] == organization
                assert 'value' not in row['value'] and 'encryptedContent' not in row
            assert all(not private or private not in json.dumps(result) for private in (synthetic,))
            return result
        def refs():
            values = organization_inventory()['values']
            return [{'id':next(v['value']['id'] for v in values if v['value']['name']==name),'version':next(v['value']['version'] for v in values if v['value']['name']==name),'scope':'EXECUTION_VALUE_SCOPE_ORGANIZATION','organizationId':org_target['organizationId']} for name in ('BUILD_CREDENTIAL','BUILD_REGION')]
        def approve(value_refs=None):
            current = repo_inventory()
            existing = [v for v in current.get('bindings',[]) if v['workflowPath']==PATH and not v.get('deleted',False)]
            assert len(existing)<=1
            request = {'target':current['target'],'id':existing[0]['id'] if existing else str(uuid.uuid4()),'expectedVersion':existing[0]['version'] if existing else '0','expectedBrokerRevision':current['brokerRevision'],
                       'operationId':str(uuid.uuid4()),'workflowPath':PATH,'commitId':head,'event':'WORKFLOW_RUN_ORIGIN_MANUAL',
                       'values':value_refs or refs(),'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat()}
            ack = receipt(rpc(approver,REPOSITORY_SERVICE+'SaveRepositoryExecutionBinding',request),request,'save_binding')
            binding = next(v for v in repo_inventory()['bindings'] if v['id']==request['id'])
            assert binding['version']==ack['acceptedVersion'] and binding['commitId']==head and binding['workflowBlobId']==blob and binding['engineCatalog']==CATALOG and binding['values']==request['values']
            assert re.fullmatch('[a-f0-9]{64}',binding['sourceSha256'])
            return binding
        def dispatch(binding, expected=200):
            result = rpc(approver,'WorkflowRunService/DispatchWorkflow',{'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':str(uuid.uuid4())},expected=expected,**({'code':'failed_precondition'} if expected==400 else {}))
            return exact_run(result['run'],native,head,binding,blob) if expected==200 else result
        def read_run(value): return rpc(approver,'WorkflowRunService/GetWorkflowRun',{'runId':value['id']})['run']
        def running(value):
            def observed():
                row=read_run(value)
                if row['state']!='WORKFLOW_RUN_STATE_RUNNING' or not row.get('jobs') or not any(j['state']=='WORKFLOW_STEP_STATE_RUNNING' for j in row['jobs']):return None
                counts=json.loads(metadata("SELECT json_build_object('quarantined',(SELECT count(*) FROM golf_workflow_quarantined_outputs WHERE run_id='"+value['id']+"'::uuid),'readable',(SELECT count(*) FROM golf_workflow_run_logs WHERE run_id='"+value['id']+"'::uuid))"))
                assert row['outputState']==WITHHELD and counts['readable']==0
                page=rpc(approver,'WorkflowRunService/GetWorkflowRunLogs',{'runId':value['id']});assert page['outputState']==WITHHELD and not page.get('logs')
                return row if counts['quarantined']>0 else None
            return helpers.until(observed,timeout=180)
        def terminal(value, success=False):
            row=helpers.until(lambda: r if (r:=read_run(value))['state'] not in ('WORKFLOW_RUN_STATE_RUNNING','WORKFLOW_RUN_STATE_QUEUED') else None,timeout=240)
            if success:
                exact_run(row,native,head,current_binding,blob)
                assert row['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and row['outputState']==REDACTED and re.fullmatch('[a-f0-9]{32}',row['attemptId'])
                assert row['jobs'] and all(j['eventsRecorded'] and j['state']=='WORKFLOW_STEP_STATE_SUCCEEDED' for j in row['jobs'])
            else:
                assert row['state']!='WORKFLOW_RUN_STATE_SUCCEEDED' and row['outputState']==WITHHELD
                page=rpc(approver,'WorkflowRunService/GetWorkflowRunLogs',{'runId':row['id']})
                assert page['outputState']==WITHHELD and not page.get('logs')
            manifest['runs'].append({k:row[k] for k in ('id','state','commitId','workflowBlobId','sourceSha256','executionBindingId','executionBindingVersion','outputState') if k in row})
            return row
        def verified_logs(value):
            after=0; texts=[]
            for _ in range(64):
                page=rpc(approver,'WorkflowRunService/GetWorkflowRunLogs',{'runId':value['id'],'afterSequence':str(after)})
                assert page['outputState']==REDACTED and page['repositoryId']==str(native['id']) and page['sourceCommitId']==head and page['attemptId']==value['attemptId'] and not page.get('truncated',False)
                for row in page.get('logs',[]):
                    assert int(row['sequence'])==after+1;after+=1;assert synthetic not in row['text'];texts.append(row['text'])
                if not page.get('hasMore'): break
                assert page.get('logs')
            else: raise AssertionError('Bounded log continuation exhausted')
            text=''.join(texts)
            assert 'verified-environment-present' in text and 'verified-environment-complete' in text and synthetic not in text
            return {'verifiedMarkerCount':text.count('verified-environment-complete'),'chunks':after,'noValuePrinted':True}
        def replace_share(selected=None, expiry=None, body= None):
            item=next(v for v in organization_inventory()['values'] if v['value']['id']==secret_id)
            return save_org(secret_id,item['value']['version'],'BUILD_CREDENTIAL','REPOSITORY_EXECUTION_VALUE_KIND_SECRET',synthetic if body is None else body,selected,expiry)
        def renew_variable_share():
            item=next(v for v in organization_inventory()['values'] if v['value']['id']==variable_id)
            # Rebind approving session/expiry without revealing or resending the
            # retained variable body. Old session-backed versions stay fenced.
            return save_org(variable_id,item['value']['version'],'BUILD_REGION','REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE',include_body=False)
        def machine(url, capability, tls_context=None):
            body=json.dumps({'catalogs':[CATALOG],**({'capabilities':['golf.repository-env.v1']} if capability else {})}).encode()
            request=urllib.request.Request(url+'/internal/ci/poll',data=body,headers={'Authorization':'Bearer '+runner_key,'Golf-Runner-ID':'local-docker','Content-Type':'application/json'})
            opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=tls_context)) if tls_context else urllib.request.build_opener()
            with opener.open(request,timeout=15) as response: assert response.status==204 and not response.read(4096)

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

            stage('ordinary native identities, private organization membership and separate managed accounts')
            # Native prevents deleting its final administrator. This unmanaged
            # fixture identity has no PAT or Golf account and is discarded with
            # the verified fresh Compose volumes after all tested actors purge.
            admin('create','--username',project+'-bootstrap','--email',project+'-bootstrap@example.invalid','--random-password','--must-change-password=false','--admin=true')
            manifest['unmanagedBootstrapAdmin']='fresh-volume-only; no token or managed account'
            for role in ('owner','approver','reader','outsider','siteadmin','secondowner'):
                name=project+'-'+role; actor={'name':name,'email':name+'@golf.invalid','password':secrets.token_urlsafe(32)};actors[role]=actor;forbidden.append(actor['password'])
                options=['create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false']
                if role=='siteadmin': options.append('--admin=true')
                admin(*options);actor['nativeCreated']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw');forbidden.append(actor['token'])
                user=smoke.provider(actor['token'],'GET','user');assert user['login']==name and user['is_admin']==(role=='siteadmin');actor['id']=str(user['id'])
                command('exec','-T','golf','golf','local-account','create',payload={'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'});actor['enrolled']=True;login(actor)
            owner,approver,reader,outsider,siteadmin,secondowner=(actors[k] for k in ('owner','approver','reader','outsider','siteadmin','secondowner'))
            organization=project+'-org'; org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},expected=201);organizations[organization]=org['id']
            foreign_name=project+'-other';foreign=smoke.provider(owner['token'],'POST','orgs',{'username':foreign_name,'visibility':'private'},expected=201);organizations[foreign_name]=foreign['id']
            org_target={'organization':organization,'organizationId':str(org['id'])}
            def new_repo(name,org_name=organization):
                row=smoke.provider(owner['token'],'POST','orgs/'+org_name+'/repos',{'name':name,'private':True,'auto_init':True},expected=201)
                repositories[str(row['id'])]={'ownerId':str(row['owner']['id']),'owner':org_name,'name':name};smoke.wait_for_push(owner['token'],row['full_name']);return row
            native=new_repo('execution');ui_repo=new_repo('ui');unselected=new_repo('unselected');foreign_repo=new_repo('foreign',foreign_name)
            repository={'owner':organization,'name':native['name']};base='repos/'+native['full_name']
            teams=smoke.provider(owner['token'],'GET','orgs/'+organization+'/teams');owner_team=next(row for row in teams if row['name']=='Owners' and row['permission']=='owner')
            members=smoke.provider(owner['token'],'POST','orgs/'+organization+'/teams',{'name':'Members','permission':'read','visibility':'limited','units_map':{'repo.code':'read'},'includes_all_repositories':True},expected=201)
            for actor in (owner,approver,reader,secondowner):smoke.provider(owner['token'],'PUT','teams/'+str(members['id'])+'/members/'+actor['name'],expected=204)
            smoke.provider(owner['token'],'PUT','teams/'+str(owner_team['id'])+'/members/'+secondowner['name'],expected=204)
            for selected in (native,ui_repo,unselected):smoke.provider(owner['token'],'PUT','repos/'+selected['full_name']+'/collaborators/'+approver['name'],{'permission':'admin'},expected=204)
            for actor in (approver,reader):
                assert smoke.provider(actor['token'],'GET','users/'+actor['name']+'/orgs/'+organization+'/permissions')['is_owner'] is False
            assert smoke.provider(owner['token'],'GET','users/'+owner['name']+'/orgs/'+organization+'/permissions')['is_owner'] is True
            assert smoke.provider(approver['token'],'GET','repos/'+native['full_name'])['permissions']['admin'] is True
            manifest['fixtureIdentities']={'organizationId':str(org['id']),'repositoryIds':[str(row['id']) for row in (native,ui_repo,unselected,foreign_repo)],'ordinarySourceAdminId':approver['id'],'organizationOwnerId':owner['id'],'nativeSiteAdminHasNoOrdinaryShareAuthority':True}
            for selection in ({'scope':'EXECUTION_SCOPE_INSTANCE'},{'scope':'EXECUTION_SCOPE_ORGANIZATION','organization':organization},{'scope':'EXECUTION_SCOPE_REPOSITORY','repository':repository}):
                p=rpc(owner,'ExecutionPolicyService/GetExecutionPolicy',selection)['policy']
                rpc(owner,'ExecutionPolicyService/UpdateExecutionPolicy',{**selection,'scopeId':p['scopeId'],'expectedRevision':p.get('revision','0'),'expectedAuthorityRevision':p['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            smoke.provider(owner['token'],'POST',base+'/contents/'+PATH,{'content':base64.b64encode(WORKFLOW).decode(),'message':'Controlled organization environment consumer'},expected=201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            blob=hashlib.sha1(b'blob '+str(len(WORKFLOW)).encode()+b'\0'+WORKFLOW).hexdigest()
            selections=[{'repository':{'owner':organization,'name':row['name']},'repositoryId':str(row['id'])} for row in (native,ui_repo)]
            stage('exact organization CRUD/replay, owner-only reveal, target and browser boundaries')
            secret_id=str(uuid.uuid4());variable_id=str(uuid.uuid4())
            secret,original=save_org(secret_id,'0','BUILD_CREDENTIAL','REPOSITORY_EXECUTION_VALUE_KIND_SECRET',synthetic)
            receipt(broker(owner,'SaveOrganizationExecutionValue',original),original,'save_value')
            inspected=broker(owner,'GetOrganizationExecutionValueOperation',{'target':org_target,'operationId':original['operationId']})['operation'];assert inspected['itemId']==secret_id and inspected['acceptedVersion']=='1' and inspected['replayed']
            broker(owner,'SaveOrganizationExecutionValue',{**original,'value':synthetic+'changed'},expected=409,code='aborted')
            broker(owner,'SaveOrganizationExecutionValue',{k:v for k,v in original.items() if k!='value'},expected=409,code='aborted')
            broker(owner,'GetOrganizationExecutionVariable',{'target':org_target,'id':secret_id,'version':'1'},expected=404)
            variable,_=save_org(variable_id,'0','BUILD_REGION','REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE','initial-region')
            variable,_=save_org(variable_id,'1','BUILD_REGION','REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE','owned-region')
            broker(owner,'GetOrganizationExecutionVariable',{'target':org_target,'id':variable_id,'version':'1'},expected=404)
            revealed=broker(owner,'GetOrganizationExecutionVariable',{'target':org_target,'id':variable_id,'version':'2'});assert revealed['target']==org_target and revealed['variable']['value']['id']==variable_id and revealed['value']=='owned-region'
            for actor in (approver,reader):
                broker(actor,'ListOrganizationExecutionValues',{'target':org_target},expected=403)
                broker(actor,'GetOrganizationExecutionVariable',{'target':org_target,'id':variable_id,'version':'2'},expected=403)
            for actor in (outsider,siteadmin):
                denied_rpc(actor['session'],SERVICE+'ListOrganizationExecutionValues',{'target':org_target})
            wrong={**org_target,'organizationId':str(int(org_target['organizationId'])+1)};broker(owner,'ListOrganizationExecutionValues',{'target':wrong},expected=404)
            bad={**original,'operationId':str(uuid.uuid4()),'selectedRepositories':[{'repository':{'owner':foreign_name,'name':foreign_repo['name']},'repositoryId':str(foreign_repo['id'])}]};broker(owner,'SaveOrganizationExecutionValue',bad,expected=400)
            assert repo_inventory()['inheritedValues'] and not repo_inventory(selected=unselected).get('inheritedValues')
            rpc(reader,REPOSITORY_SERVICE+'ListRepositoryExecutionValues',{'target':repo_target(reader)},expected=403)
            credential=rpc(owner,'ApiCredentialService/CreateApiCredential',{'label':'Organization values browser boundary','lifetimeSeconds':600});forbidden.append(credential['token'])
            for method in ('ListOrganizationExecutionValues','SaveOrganizationExecutionValue','DeleteOrganizationExecutionValue','GetOrganizationExecutionVariable','GetOrganizationExecutionValueOperation'):
                broker(owner,method,{},expected=403,headers={'Origin':'https://wrong.golf.invalid'})
                checked_rpc(smoke.client(),SERVICE+method,{},expected=403,headers={'Authorization':'Bearer '+credential['token']})
            rpc(owner,'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']})
            manifest['checks']+=['org-owner-positive-native-proof','member-direct-admin-not-share-owner','reader-denial','siteadmin-no-ordinary-authority','same-org-selected-only-metadata','secret-never-revealed','variable-owner-only','origin-and-api-bearer-denial','exact-target-and-original-intent']
            current_binding=approve()
            stage('actual TLS Actions environment with independent scoped source receipt')
            queued=dispatch(current_binding);machine(smoke.GOLF,True);machine(secure_url,False,context);assert read_run(queued)['state']=='WORKFLOW_RUN_STATE_QUEUED'
            manifest['transportAdmission']={'httpCapableClaimExcluded':True,'tlsWithoutEnvironmentCapabilityExcluded':True,'tlsServerAuthentication':'TLSv1.3 verified private fixture CA; not mTLS'}
            command('up','-d','--no-build','--pull','never','runner',timeout=180)
            succeeded=terminal(queued,success=True);manifest['actualEnvironment']=verified_logs(succeeded)
            if args.ui:
                stage('actual requested organization and inherited override editors; twelve captures')
                screens=output/'browser';screens.mkdir(mode=0o700)
                result=run('node',str(ROOT/'scripts/organization-execution-values-browser.mjs'),payload={'stackRoot':str(stack),'golf':smoke.GOLF,'screenshots':str(screens),'organization':organization,'organizationId':str(org['id']),'repository':{'owner':organization,'name':ui_repo['name']},'repositoryId':str(ui_repo['id']),'extraRepository':repository,'extraRepositoryId':str(native['id']),'email':owner['email'],'username':owner['name'],'password':owner['password'],'secret':synthetic,'runtime':baseline,'sourceRevision':manifest['sourceRevision']},timeout=360)
                assert result.strip().endswith('PASS: actual organization editors, sharing, blank overrides and private clearing; twelve captures.')
                manifest['browser']={'passed':True,'manifestSha256':hashlib.sha256((screens/'manifest.json').read_bytes()).hexdigest()}
            stage('cross-kind override is refused; same-kind override fences inherited running attempt')
            current=repo_inventory();wrong_override={'target':current['target'],'id':str(uuid.uuid4()),'expectedVersion':'0','expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4()),'name':'BUILD_CREDENTIAL','kind':'REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE','value':'different-kind'}
            rpc(approver,REPOSITORY_SERVICE+'SaveRepositoryExecutionValue',wrong_override,expected=400)
            interrupted=dispatch(current_binding);running(interrupted)
            local_id=str(uuid.uuid4());local_secret=synthetic+secrets.token_hex(8);forbidden.append(local_secret)
            override={**wrong_override,'id':local_id,'operationId':str(uuid.uuid4()),'kind':'REPOSITORY_EXECUTION_VALUE_KIND_SECRET','value':local_secret}
            receipt(rpc(approver,REPOSITORY_SERVICE+'SaveRepositoryExecutionValue',override),override,'save_value');terminal(interrupted)
            inherited=next(v for v in repo_inventory()['inheritedValues'] if v['value']['id']==secret_id);assert inherited['overridden'] is True
            override_workflow=WORKFLOW.replace(b'-eq 64',b'-eq 80')
            updated=smoke.provider(owner['token'],'PUT',base+'/contents/'+PATH,{'sha':blob,'content':base64.b64encode(override_workflow).decode(),'message':'Verify explicit local override length without printing value'},expected=200)
            head=updated['commit']['sha'];assert re.fullmatch('[a-f0-9]{40}',head);blob=hashlib.sha1(b'blob '+str(len(override_workflow)).encode()+b'\0'+override_workflow).hexdigest()
            value_refs=refs();value_refs[0]={'id':local_id,'version':'1','scope':'EXECUTION_VALUE_SCOPE_REPOSITORY'};current_binding=approve(value_refs)
            explicit=terminal(dispatch(current_binding),success=True);verified_logs(explicit)
            current=repo_inventory();delete={'target':current['target'],'id':local_id,'expectedVersion':'1','expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4())};receipt(rpc(approver,REPOSITORY_SERVICE+'DeleteRepositoryExecutionValue',delete),delete,'delete_value')
            restored=smoke.provider(owner['token'],'PUT',base+'/contents/'+PATH,{'sha':blob,'content':base64.b64encode(WORKFLOW).decode(),'message':'Restore exact org environment assertion'},expected=200)
            head=restored['commit']['sha'];assert re.fullmatch('[a-f0-9]{40}',head);blob=hashlib.sha1(b'blob '+str(len(WORKFLOW)).encode()+b'\0'+WORKFLOW).hexdigest()
            manifest['checks']+=['cross-kind-refused','same-kind-override-cancels-inherited-attempt','explicit-scoped-local-winner-real-environment']
            stage('current immutable organization share version and selected subset fence running output')
            current_binding=approve();replaced=dispatch(current_binding);running(replaced);replace_share();terminal(replaced)
            current_binding=approve();removed=dispatch(current_binding);running(removed);replace_share(selected=[selections[1]]);terminal(removed)
            assert not any(v['value']['id']==secret_id for v in repo_inventory().get('inheritedValues',[]));dispatch(current_binding,expected=400)
            replace_share();manifest['checks']+=['share-version-change','selected-repository-removal','stale-binding-admission-refused']
            stage('positive native owner loss while source administrator remains independently authorized')
            current_binding=approve();revoked=dispatch(current_binding);running(revoked)
            smoke.provider(secondowner['token'],'DELETE','teams/'+str(owner_team['id'])+'/members/'+owner['name'],expected=204)
            assert smoke.provider(owner['token'],'GET','users/'+owner['name']+'/orgs/'+organization+'/permissions')['is_owner'] is False
            terminal(revoked);broker(owner,'ListOrganizationExecutionValues',{'target':org_target},expected=403)
            smoke.provider(secondowner['token'],'PUT','teams/'+str(owner_team['id'])+'/members/'+owner['name'],expected=204);replace_share()
            stage('approving share session logout and local credential version change fence attempts')
            current_binding=approve();logged_out=dispatch(current_binding);running(logged_out);rpc(owner,'SessionService/Logout');owner['session']=None;terminal(logged_out)
            login(owner);replace_share();renew_variable_share();current_binding=approve();changed_cv=dispatch(current_binding);running(changed_cv)
            replacement=secrets.token_urlsafe(32);forbidden.append(replacement)
            command('exec','-T','golf','golf','local-account','reset-password',payload={'username':owner['name'],'password':replacement});owner['session']=None;owner['password']=replacement;terminal(changed_cv)
            login(owner);replace_share();renew_variable_share();manifest['checks']+=['native-org-owner-loss','share-session-logout','share-credential-version-change']
            stage('share expiry denies queued claim and fresh admission without a timing mock')
            expires=datetime.now(timezone.utc)+timedelta(seconds=70)
            replace_share(expiry=expires.isoformat());current_binding=approve();command('stop','runner')
            expiring=dispatch(current_binding);assert read_run(expiring)['state']=='WORKFLOW_RUN_STATE_QUEUED'
            deadline=time.monotonic()+85
            while datetime.now(timezone.utc)<=expires+timedelta(seconds=1):
                assert time.monotonic()<deadline;time.sleep(.5)
            dispatch(current_binding,expected=400);command('up','-d','--no-build','--pull','never','runner');terminal(expiring)
            replace_share();manifest['checks'].append('real-expiry-claim-and-admission-denial')
            stage('supported native transfer changes owning organization without rewriting share identity')
            current_binding=approve();transferred=dispatch(current_binding);running(transferred)
            moved=smoke.provider(owner['token'],'POST',base+'/transfer',{'new_owner':foreign_name},expected=202)
            assert str(moved['id'])==str(native['id']) and str(moved['owner']['id'])==str(foreign['id'])
            repositories[str(native['id'])]={'ownerId':str(foreign['id']),'owner':foreign_name,'name':native['name']}
            # Restore the source approver's independent read authority only in the
            # new namespace; this must not renew the old org share/binding.
            smoke.provider(owner['token'],'PUT','repos/'+foreign_name+'/'+native['name']+'/collaborators/'+approver['name'],{'permission':'admin'},expected=204)
            rpc(approver,'WorkflowRunService/GetWorkflowRun',{'runId':transferred['id']},expected=404)
            def withheld_transfer():
                row=json.loads(metadata("SELECT json_build_object('state',state,'outputState',(SELECT output_state FROM golf_workflow_execution_bindings WHERE run_id=golf_workflow_runs.id),'readable',(SELECT count(*) FROM golf_workflow_run_logs WHERE run_id='"+transferred['id']+"'::uuid)) FROM golf_workflow_runs WHERE id='"+transferred['id']+"'::uuid"))
                assert row['readable']==0 and row['outputState']=='withheld'
                return row if row['state'] not in ('queued','running') else None
            manifest['transferredRunFence']=helpers.until(withheld_transfer,timeout=240);manifest['checks'].append('same-native-repository-transferred-owner-denies-old-share')
            after=runtime();assert after==baseline;manifest['runtimeAfter']=after
            passed=True

        except Exception as error:
            frames=traceback.extract_tb(error.__traceback__)
            manifest['originalFailure']={'type':type(error).__name__,'stage':STAGE,'line':frames[-1].lineno}
            raise
        finally:
            # Exact immutable owned IDs select the current cleanup address; never
            # follow a rename/transfer redirect into a replacement repository.
            for identifier,owned in repositories.items():
                try:
                    current=smoke.provider(owner['token'],'GET','repositories/'+identifier)
                    assert str(current['id'])==identifier and str(current['owner']['id'])==owned['ownerId'] and current['owner']['login']==owned['owner'] and current['name']==owned['name']
                    smoke.provider(owner['token'],'DELETE','repos/'+current['full_name'],expected=204)
                except Exception:cleanup.append('exact-native-repository-cleanup')
            for name,identifier in organizations.items():
                try:
                    row=smoke.provider(owner['token'],'GET','orgs/'+name);assert row['id']==identifier and row['name']==name
                    smoke.provider(owner['token'],'DELETE','orgs/'+name,expected=204)
                except Exception:cleanup.append('exact-native-organization-cleanup')
            for actor in actors.values():
                if actor.get('session') is not None:
                    try:rpc(actor,'SessionService/RevokeOtherSessions');rpc(actor,'SessionService/Logout')
                    except Exception:cleanup.append('managed-session-cleanup')
                if actor.get('enrolled'):
                    try:command('exec','-T','golf','golf','local-account','disable',payload={'username':actor['name']})
                    except Exception:cleanup.append('managed-account-disable')
                if actor.get('nativeCreated'):
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:cleanup.append('native-actor-purge')
            if started:
                try:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not run('docker',*argv,'--filter','label=com.docker.compose.project='+project).strip()
                except Exception:cleanup.append('fresh-compose-resources')
            smoke.GOLF,smoke.GITEA=old_urls
            manifest.update(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,unmanagedBootstrapDiscardedWithFreshVolumes=started and 'fresh-compose-resources' not in cleanup,lastStage=STAGE)
            helpers.private_write(output/'manifest.json',safe_manifest(manifest,forbidden))
            if 'originalFailure' not in manifest:assert not cleanup,'Owned cleanup failed; safe categories retained'
            print('Cleanup attempted: exact owned native targets, accounts, sessions and fresh project; inspect cleanupPassed.',flush=True)
    assert passed
    print('PASS: actual organization sharing, TLS Actions environment, dual-authority/version fences and served controls; broader environments/recovery remain open.')


if __name__=='__main__':
    try:
        if '--self-check' in sys.argv:self_check()
        else:main()
    except Exception as error:
        if OUTPUT is not None and not (OUTPUT/'manifest.json').exists():
            helpers.private_write(OUTPUT/'manifest.json',json.dumps({'passed':False,'complete':False,'cleanupPassed':not bool(PROOF),'originalFailure':{'type':type(error).__name__,'stage':STAGE}},indent=2)+'\n')
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr)
        raise SystemExit(1)
