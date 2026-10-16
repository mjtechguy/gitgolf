#!/usr/bin/env python3
"""Source-prepared actual typed manual-input proof on a fresh owned stack.

Requires exact cached images/binary hashes, native transport proxy, and an
operator-seeded fresh DinD. Never builds/pulls or uses retained policy/accounts.
One actual v2 run, discarded response body + original-key inspection/restart,
exact source and encrypted-row metadata, literal/default/number/composite logs.
Optional --execution-values proves exact typed repository secret/variable
approval and real worker injection; input-declaring push and full Actions parity
remain outside this bounded proof.
The --self-check path performs no subprocess/network/resource operation.
"""
import argparse
import ast
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
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
import native_qualification_proxy as native_proxy
ROOT = Path(__file__).resolve().parents[1]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
act = load('typed_actions_helpers', 'actions-engine-smoke.py')
rules = load('typed_native_helpers', 'repository-rule-mutations-smoke.py')
notifications = load('typed_foreign_helpers', 'workflow-notifications-smoke.py')
helpers = act.helpers
CATALOG = 'golf.workflow.act.v0.2.89.linux.v2'
CONTRACT = 'golf.workflow.dispatch.inputs.v1'
IMAGE = act.IMAGE
DIND = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
NATIVE, PG = 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413', 'postgres:18.4-alpine3.24'
PATH = '.github/workflows/manual-inputs-proof.yml'
LITERAL = 'literal <>& 世界 ${{ inputs.flag }} $(touch /tmp/should-not-exist)'
STAGE = 'arguments'
REPORT_FAILURE = None


def source_files(execution_values=False):
    fixture = ROOT/'engines/act/testdata'
    files = {PATH:(fixture/'manual-inputs-proof.yml').read_bytes(), 'actions/manual-inputs-proof/action.yml':(fixture/'actions/manual-inputs-proof/action.yml').read_bytes()}
    if execution_values:
        files[PATH] += b'''      - id: approvedenv
        run: |
          test -n "$BUILD_CREDENTIAL"
          test "$BUILD_REGION" = "owned-region"
          printf '%s\\n' "$BUILD_CREDENTIAL"
          echo typed-approved-environment-verified
'''
    return files


def stage(value):
    global STAGE
    STAGE = value; print('CHECK: '+value, flush=True)


def prepared_receipt(row, target, head, blob):
    for field in ('repository','repositoryId','ownerId'):
        assert row[field] == target[field]
    assert row['commitId'] == head and row['workflowPath'] == PATH and row['workflowBlobId'] == blob and row['inputContract'] == CONTRACT
    assert re.fullmatch(r'[1-9][0-9]{0,18}',row['nativeActorId'])
    assert all(re.fullmatch(r'[a-f0-9]{64}',row[field]) for field in ('schemaSha256','submittedSha256','effectiveSha256'))
    assert [v['name'] for v in row['definitions']] == ['count','flag','mode','text']
    assert [v['type'] for v in row['definitions']] == ['WORKFLOW_DISPATCH_INPUT_TYPE_NUMBER','WORKFLOW_DISPATCH_INPUT_TYPE_BOOLEAN','WORKFLOW_DISPATCH_INPUT_TYPE_CHOICE','WORKFLOW_DISPATCH_INPUT_TYPE_STRING']
    return row


def original_request(prepared, key):
    return {k:prepared[k] for k in ('repository','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract')} | {'idempotencyKey':key}


def original_receipt(row, prepared, key):
    for field in ('repository','repositoryId','ownerId','nativeActorId','schemaSha256','submittedSha256','effectiveSha256','inputContract'):
        assert row[field] == prepared[field]
    assert row['idempotencyKey'] == key and row['run'].get('canCancel',False) is False
    run = row['run']
    assert str(uuid.UUID(run['id'])) == run['id']
    for field in ('repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract'):
        assert run[field] == prepared[field]
    assert run['engineCatalog'] == CATALOG and re.fullmatch('[a-f0-9]{64}',run['sourceSha256'])
    return run


def safe_json(value, forbidden):
    text = json.dumps(value,indent=2,sort_keys=True)+'\n'
    assert all(not secret or secret not in text and json.dumps(secret)[1:-1] not in text for secret in forbidden), 'Private material in receipt'
    return text


def self_check():
    tree=ast.parse(Path(__file__).read_text())
    for node in ast.walk(tree):
        for target in getattr(node,'targets',[]):
            assert not any(isinstance(value,ast.Name) and value.id in {'execute','command'} for value in ast.walk(target))
    files = source_files(); assert len(files)==2 and b'if:' in files[PATH] and b'INPUT_VALUE' in files['actions/manual-inputs-proof/action.yml']
    approved=source_files(True)
    assert approved[PATH].startswith(files[PATH]) and approved['actions/manual-inputs-proof/action.yml']==files['actions/manual-inputs-proof/action.yml']
    assert b'test -n "$BUILD_CREDENTIAL"' in approved[PATH] and b'typed-approved-environment-verified' in approved[PATH]
    assert b'should-not-exist' in files[PATH] and b'should-not-exist' in files['actions/manual-inputs-proof/action.yml']
    for data in files.values():
        assert b'${dollar}{{ inputs.flag }}' in data and b'${dollar}(touch /tmp/should-not-exist)' in data
        assert "'literal <>& 世界 ${{ inputs.flag }}".encode() not in data
    target={'repository':{'owner':'owned','name':'proof'},'repositoryId':'7','ownerId':'42'}
    prepared=target|{'nativeActorId':'42','commitId':'a'*40,'workflowPath':PATH,'workflowBlobId':'b'*40,'schemaSha256':'c'*64,'submittedSha256':'d'*64,'effectiveSha256':'e'*64,'inputContract':CONTRACT,'definitions':[{'name':name,'type':'WORKFLOW_DISPATCH_INPUT_TYPE_'+kind} for name,kind in [('count','NUMBER'),('flag','BOOLEAN'),('mode','CHOICE'),('text','STRING')]]}
    prepared_receipt(prepared,target,'a'*40,'b'*40)
    key=str(uuid.uuid4());run={k:prepared[k] for k in ('repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract')}|{'id':str(uuid.uuid4()),'sourceSha256':'f'*64,'engineCatalog':CATALOG}
    original={k:prepared[k] for k in ('repository','repositoryId','ownerId','nativeActorId','schemaSha256','submittedSha256','effectiveSha256','inputContract')}|{'idempotencyKey':key,'run':run}
    original_receipt(original,prepared,key)
    for field in ('idempotencyKey','schemaSha256','nativeActorId'):
        changed=copy.deepcopy(original);changed[field]='wrong'
        try: original_receipt(changed,prepared,key)
        except AssertionError: pass
        else: raise AssertionError('Changed original receipt admitted')
    before={'a'*64:{'image':'b'*64,'status':'running','running':True,'startedAt':'first','restartCount':0}}
    after=copy.deepcopy(before);after['a'*64]['restartCount']=1
    assert notifications.foreign_diff(before,after)['identityUnchanged'] and notifications.foreign_diff(before,after)['lifecycleObservations']
    after['a'*64]['image']='changed';assert not notifications.foreign_diff(before,after)['identityUnchanged']
    try: safe_json({'body':LITERAL},[LITERAL])
    except AssertionError: pass
    else: raise AssertionError('Private source/input artifact accepted')
    print('PASS: source-only immutable receipt/tamper, fixture and privacy checks; no resources.')


def main():
    global REPORT_FAILURE
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('image','runner-image','source-revision','expected-core-sha256','expected-runner-sha256','expected-engine-sha256'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--proxy-binary',type=Path,required=True)
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seed-wait-seconds',type=int,default=300)
    parser.add_argument('--ui',action='store_true',help='Also qualify read-only actual typed editor and exact recorded run/job/step pages')
    parser.add_argument('--execution-values',action='store_true',help='Approve and execute exact typed inputs with repository secret/variable versions (schema060+)')
    args=parser.parse_args();stack=args.stack_root.resolve();output=args.output.resolve()
    assert 1<=args.seed_wait_seconds<=600 and not output.exists()
    assert re.fullmatch('[a-f0-9]{40}',args.source_revision)
    for digest in (args.expected_core_sha256,args.expected_runner_sha256,args.expected_engine_sha256):assert re.fullmatch('[a-f0-9]{64}',digest)
    output.mkdir(parents=True,mode=0o700);output.chmod(0o700)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','FORGEJO_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    forbidden=[LITERAL];manifest={'complete':False,'passed':False,'proofKind':'typed-execution-values060' if args.execution_values else 'typed-manual-inputs059','sourceRevision':args.source_revision,'limitations':['One full-SHA manual v2 run only; no UI, input-declaring push, provider inference or full Actions parity.','Discarded actual response body after accepted HTTP headers; no arbitrary transport-loss guarantee.','Current native/lease fences source+PG-qualified separately; this runtime slice tests old/HTTP worker exclusion.']}
    def execute(*argv,payload=None,timeout=180,expected=0):
        result=subprocess.run(argv,input=None if payload is None else json.dumps(payload).encode(),cwd=stack,env=environment,capture_output=True,timeout=timeout)
        if result.returncode!=expected and not (output/'private-command-failure.json').exists():
            # Owner-only diagnostics survive exact-owned teardown. These bytes
            # can contain private CLI output; never include them in the manifest.
            assert len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20
            helpers.private_write(output/'private-command-failure.json',json.dumps({'stage':STAGE,'exitCode':result.returncode,'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace')}))
        assert result.returncode==expected and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Bounded subprocess failure; private output withheld'
        return result.stdout.decode().strip()
    def record(**items):
        manifest.update(items);path=output/'manifest.json.tmp';helpers.private_write(path,safe_json(manifest,forbidden));path.replace(output/'manifest.json')
    def failure(error):
        if 'originalFailure' not in manifest:
            record(originalFailure={'type':type(error).__name__,'stage':STAGE,'frames':[{'file':Path(v.filename).name if Path(v.filename).name in {Path(__file__).name,'observability-smoke.py','repository-rule-mutations-smoke.py','native_qualification_proxy.py','smoke.py'} else 'dependency','line':v.lineno} for v in traceback.extract_tb(error.__traceback__)[-6:]]})
    REPORT_FAILURE=failure
    synthetic_secret = secrets.token_urlsafe(32) if args.execution_values else None
    if synthetic_secret:
        forbidden.append(synthetic_secret)
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
    binary,binary_sha=rules.proxy_binary_receipt(args.proxy_binary)
    before=snapshot();helpers.private_write(output/'foreign-before.json',json.dumps(before,indent=2))
    project='golf-rules49-'+secrets.token_hex(5);ports=helpers.free_ports(4)
    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
    previous=smoke.GOLF,smoke.FORGE;smoke.GOLF=f'http://127.0.0.1:{ports[0]}';smoke.FORGE=f'http://127.0.0.1:{ports[1]}';secure=f'https://127.0.0.1:{ports[2]}'
    record(images=images,binarySha256=binaries,project=project,helperRevision=execute('git','rev-parse','HEAD'),proxyBinarySha256=binary_sha)
    actors={};started=False;passed=False;cleanup=[];bootstrap_created=False;proxy_ready=False
    with native_proxy.NativeProxy(ports[3],project) as proxy,tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700);environment.update(proxy.environment())
        ca,cert,key=directory/'ca.crt',directory/'server.crt',directory/'server.key'
        helpers.private_write(directory/'ca.conf','[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf typed fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        helpers.private_write(directory/'extensions','basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(directory/'ca.conf'),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(directory/'server.csr'))
        execute('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(cert))
        for file in (ca,cert,key):file.chmod(0o444)
        worker_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD')} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        forbidden.extend(values[k] for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD','GOLF_ENCRYPTION_KEY','GOLF_RUNNER_KEY'));forbidden.append(environment['NATIVE_QUALIFICATION_NONCE'])
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        overlay={'services':{'golf':{'image':images['golf'],'pull_policy':'never','mem_limit':'384m','environment':{'GOLF_FORGE_URL':'http://native-qualification-proxy:8081','GOLF_ACTIONS_ENGINE_CATALOG':CATALOG},'depends_on':{native_proxy.SERVICE_NAME:{'condition':'service_started'}}},'forgejo':{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{'FORGEJO__server__ROOT_URL':smoke.FORGE+'/','FORGEJO__server__DISABLE_SSH':'true','FORGEJO__server__START_SSH_SERVER':'false','FORGEJO__actions__ENABLED':'false'}},'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m','command':['postgres','-c','max_wal_size=64MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s']},'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m'},'runner-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},'runner-actions-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},native_proxy.SERVICE_NAME:proxy.compose_service(images['golf'],binary)}}
        helpers.private_write(directory/'services.json',json.dumps(overlay))
        helpers.private_write(directory/'ports.yaml',f'''services:
  golf:
    ports: !override ["127.0.0.1:{ports[0]}:8080", "127.0.0.1:{ports[2]}:8443"]
  forgejo:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
  postgres:
    volumes: !override ["{stack/'deploy/postgres/forgejo-init.sh'}:/docker-entrypoint-initdb.d/01-golf.sh:ro"]
    tmpfs: ["/var/lib/postgresql:size=1073741824,mode=0700,uid=70,gid=70"]
''')
        compose=['docker','compose','--project-directory',str(stack),'-p',project,'--env-file',str(directory/'proof.env')]
        for file in ('compose.yaml','deploy/compose/compose.ci.yaml','deploy/compose/compose.actions-engine.yaml','deploy/compose/compose.runner-tls.yaml'):compose+=['-f',str(stack/file)]
        compose+=['-f',str(directory/'services.json'),'-f',str(directory/'ports.yaml')]
        def command(*argv,**kw):return execute(*compose,*argv,**kw)
        def admin(*argv):return command('exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*argv)  # Forgejo's upstream path
        def rpc(role,method,body=None,**kw):return smoke.rpc(actors[role]['session'],method,body,**kw)
        def metadata(sql):return command('exec','-T','postgres','psql','-U','postgres','-d','golf','-v','ON_ERROR_STOP=1','-Atc',sql)
        def counts():return json.loads(metadata("SELECT json_build_object('runs',(SELECT count(*) FROM golf_workflow_runs),'inputs',(SELECT count(*) FROM golf_workflow_dispatch_inputs))"))
        def runtime():
            result={}
            for role in ('golf','runner'):
                cid=command('ps','-q',role);assert cid
                row=json.loads(execute('docker','inspect',cid))[0];assert row['Image']==images[role] and row['Config']['Labels']['com.docker.compose.project']==project
                result[role]={'containerId':row['Id'],'image':row['Image'],'composeConfigHash':row['Config']['Labels']['com.docker.compose.config-hash']}
            return result
        try:
            stage('fresh cached stack and verified TLS1.3 before any native actors')
            started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','forgejo','golf',native_proxy.SERVICE_NAME,'runner-daemon');proxy.ready();proxy_ready=True;smoke.ready();record(proxyRuntime=rules.verify_proxy_runtime(execute,command,proxy,binary,binary_sha,images['golf'],args.source_revision))
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
            seed={'schema':'golf.typed-inputs.seed.v1','project':project,'containerId':daemon_row['Id'],'containerImage':images['daemon'],'jobImage':IMAGE,'daemonImage':DIND,'expiresAfterSeconds':args.seed_wait_seconds,'helperNeverPullsOrBuilds':True}
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
            assert smoke.provider('','GET','version')['version']=='15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            for role in ('owner','reader'):
                actor={'name':project+'-'+role,'session':smoke.client(),'created':False,'enrolled':False};actors[role]=actor
                actor.update(email=actor['name']+'@example.invalid',password=secrets.token_urlsafe(32));forbidden.append(actor['password'])
                admin('create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
                identity=smoke.provider(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is False;actor['id']=str(identity['id'])
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'}));assert result['state']=='complete';actor['enrolled']=True
                rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'typed-inputs','private':True,'auto_init':True},expected=201)
            repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors['reader']['name'],{'permission':'read'},expected=204)
            files=source_files(args.execution_values)
            for path,data in files.items():smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(data).decode(),'message':'Controlled typed input fixture'},expected=201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            blob=hashlib.sha1(b'blob '+str(len(files[PATH])).encode()+b'\0'+files[PATH]).hexdigest();target={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id'])}
            for scope in ('INSTANCE','REPOSITORY'):
                selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                policy=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy.get('revision','0'),'expectedAuthorityRevision':policy['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})
            stage('exact source preparation/defaults/order and invalid zero-admission')
            inputs=[{'name':'text','stringValue':LITERAL},{'name':'mode','stringValue':'b'}]
            prepare=target|{'commitId':head,'workflowPath':PATH,'inputs':inputs}
            prepared=prepared_receipt(rpc('owner','WorkflowRunService/PrepareWorkflowDispatch',prepare),target,head,blob)
            assert prepared['nativeActorId']==owner['id']
            reordered=rpc('owner','WorkflowRunService/PrepareWorkflowDispatch',prepare|{'inputs':list(reversed(inputs))});assert reordered['submittedSha256']==prepared['submittedSha256'] and reordered['effectiveSha256']==prepared['effectiveSha256']
            explicit=rpc('owner','WorkflowRunService/PrepareWorkflowDispatch',prepare|{'inputs':inputs+[{'name':'flag','booleanValue':False},{'name':'count','numberValue':'2.500'}]});assert explicit['effectiveSha256']==prepared['effectiveSha256'] and explicit['submittedSha256']!=prepared['submittedSha256']
            binding = None
            if args.execution_values:
                stage('exact typed source approval with immutable encrypted secret and variable versions')
                def inventory():
                    access=rpc('owner','RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
                    t=target|{'accessRevision':access['revision']}
                    return rpc('owner','RepositoryExecutionValueService/ListRepositoryExecutionValues',{'target':t})
                refs=[]
                for kind,name,value in [('SECRET','BUILD_CREDENTIAL',synthetic_secret),('VARIABLE','BUILD_REGION','owned-region')]:
                    current=inventory(); item=str(uuid.uuid4())
                    request={'target':current['target'],'id':item,'expectedVersion':'0','expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4()),'name':name,'kind':'REPOSITORY_EXECUTION_VALUE_KIND_'+kind,'value':value}
                    accepted=rpc('owner','RepositoryExecutionValueService/SaveRepositoryExecutionValue',request)['operation']
                    assert accepted['itemId']==item and accepted['acceptedVersion']=='1'
                    refs.append({'id':item,'version':'1'})
                current=inventory()
                request={'target':current['target'],'id':str(uuid.uuid4()),'expectedVersion':'0','expectedBrokerRevision':current['brokerRevision'],'operationId':str(uuid.uuid4()),'workflowPath':PATH,'commitId':head,'event':'WORKFLOW_RUN_ORIGIN_MANUAL','expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat().replace('+00:00','Z'),'values':refs,'inputs':inputs}|{k:prepared[k] for k in ('inputContract','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256')}
                accepted=rpc('owner','RepositoryExecutionValueService/SaveRepositoryExecutionBinding',request)['operation']
                assert accepted['itemId']==request['id'] and accepted['acceptedVersion']=='1'
                replay=rpc('owner','RepositoryExecutionValueService/SaveRepositoryExecutionBinding',request)['operation'];assert replay.get('replayed') and replay['itemId']==request['id']
                binding=next(v for v in inventory()['bindings'] if v['id']==request['id'])
                assert binding['engineCatalog']==CATALOG and binding['values']==refs
                for field in ('inputContract','schemaSha256','submittedSha256','effectiveSha256'):assert binding[field]==prepared[field]
                record(typedExecutionApproval={'id':binding['id'],'version':binding['version'],'engineCatalog':CATALOG,'immutableValues':len(refs),'originalReplay':True,'identities':{k:binding[k] for k in ('inputContract','schemaSha256','submittedSha256','effectiveSha256')}})
            key_id=str(uuid.uuid4());dispatch={k:prepared[k] for k in ('repository','repositoryId','ownerId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract')}|{'ref':head,'inputs':inputs,'idempotencyKey':key_id}
            assert counts()=={'runs':0,'inputs':0}
            for change in ({'schemaSha256':'f'*64},{'workflowBlobId':'f'*40},{'inputs':[{'name':'text','booleanValue':True}]},{'inputs':inputs+[inputs[0]]}):rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch|change|{'idempotencyKey':str(uuid.uuid4())},expected=400,code='failed_precondition' if 'schemaSha256' in change or 'workflowBlobId' in change else 'invalid_argument')
            assert counts()=={'runs':0,'inputs':0};record(invalidZeroAdmission=True,canonicalOrdering=True,defaultsAndNumericCanonicalization=True)
            stage('one dispatch with unconsumed response body then exact original inspection/replay')
            body=json.dumps(dispatch).encode();cookie='; '.join(v.name+'='+v.value for handler in owner['session'].handlers if isinstance(handler,urllib.request.HTTPCookieProcessor) for v in handler.cookiejar)
            connection=http.client.HTTPConnection('127.0.0.1',ports[0],timeout=30)
            try:
                connection.request('POST','/rpc/golf.v1.WorkflowRunService/DispatchWorkflow',body,{'Content-Type':'application/json','Connect-Protocol-Version':'1','Origin':smoke.GOLF,'Cookie':cookie})
                response=connection.getresponse();assert response.status==200 and response.getheader('Cache-Control')=='no-store'
            finally:connection.close()
            original=original_request(prepared,key_id);run=original_receipt(rpc('owner','WorkflowRunService/GetWorkflowDispatch',original),prepared,key_id)
            replay=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run'];assert replay['id']==run['id'] and counts()=={'runs':1,'inputs':1}
            rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch|{'inputs':[{'name':'text','stringValue':'changed'},{'name':'mode','stringValue':'b'}]},expected=400,code='failed_precondition')
            rpc('reader','WorkflowRunService/GetWorkflowDispatch',original,expected=403)
            rpc('owner','WorkflowRunService/GetWorkflowDispatch',original|{'idempotencyKey':str(uuid.uuid4())},expected=404)
            command('restart','golf');smoke.ready();assert original_receipt(rpc('owner','WorkflowRunService/GetWorkflowDispatch',original),prepared,key_id)['id']==run['id']
            def machine(url,catalog,caps,ctx=None):
                request=urllib.request.Request(url+'/internal/ci/poll',data=json.dumps({'catalogs':[catalog],'capabilities':caps}).encode(),headers={'Content-Type':'application/json','Golf-Runner-ID':'local-docker','Authorization':'Bearer '+worker_key})
                opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx)) if ctx else urllib.request.build_opener()
                with opener.open(request,timeout=20) as reply:assert reply.status==204 and not reply.read(4096)
            caps=['golf.runner.job-limits.v1',CONTRACT]+(['golf.repository-env.v1'] if args.execution_values else [])
            machine(smoke.GOLF,CATALOG,caps);machine(secure,act.CATALOG,caps,context);machine(secure,CATALOG,['golf.runner.job-limits.v1'],context)
            assert rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']['state']=='WORKFLOW_RUN_STATE_QUEUED'
            record(original={'key':key_id,'runId':run['id'],'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'actorId':owner['id'],'commitId':head,'blobId':blob,'sourceSha256':run['sourceSha256'],'schemaSha256':prepared['schemaSha256'],'submittedSha256':prepared['submittedSha256'],'effectiveSha256':prepared['effectiveSha256']},oneAdmission=True,restartOriginalInspection=True,oldAndHTTPWorkerDenied=True)
            stage('actual maintained v2 runner execution and scoped literal/composite receipts')
            command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init');command('up','-d','--no-build','--pull','never','runner')
            initial=runtime();record(runtimeBefore=initial)
            def terminal():
                observed=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']
                return observed if observed['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None
            observed=helpers.until(terminal,timeout=240);assert observed['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and observed['engineCatalog']==CATALOG and observed['engineCommit']==act.ENGINE
            original_receipt(rpc('owner','WorkflowRunService/GetWorkflowDispatch',original),prepared,key_id)
            if binding:
                assert observed['executionBindingId']==binding['id'] and observed['executionBindingVersion']==binding['version'] and observed['outputState']=='WORKFLOW_OUTPUT_STATE_REDACTED'
            assert observed['id']==run['id'] and observed['commitId']==head and observed['workflowBlobId']==blob and observed['sourceSha256']==run['sourceSha256'] and re.fullmatch('[a-f0-9]{32}',observed['attemptId'])
            jobs=observed['jobs'];assert len(jobs)==1 and jobs[0]['jobId']=='inputs' and jobs[0]['state']=='WORKFLOW_STEP_STATE_SUCCEEDED' and jobs[0]['eventsRecorded'] is True
            steps={v['id']:v['state'] for v in jobs[0]['steps']};expected_steps={'literal':'WORKFLOW_STEP_STATE_SUCCEEDED','falseflag':'WORKFLOW_STEP_STATE_SKIPPED','numbertruth':'WORKFLOW_STEP_STATE_SUCCEEDED','composite':'WORKFLOW_STEP_STATE_SUCCEEDED'}
            if binding:expected_steps['approvedenv']='WORKFLOW_STEP_STATE_SUCCEEDED'
            assert steps==expected_steps
            evidence=[];log=act.read_logs(lambda method,payload:rpc('owner',method,payload),observed,evidence=evidence)
            for marker in ('typed-literal-values-verified','typed-number-truth-verified','typed-composite-nonrecursive-verified'):assert marker in log
            if binding:
                assert synthetic_secret not in log and 'typed-approved-environment-verified' in log
                record(typedExecutionConsumer={'secretDelivered':True,'variableDelivered':True,'secretNotInReadableLogs':True,'outputState':observed['outputState'],'bindingId':binding['id'],'bindingVersion':binding['version']},limitations=['One real typed manual workflow with exact approved repository values; broader Actions/GitLab compatibility, input-declaring push, agents/CD and recovery remain separate.','Lost response body after accepted headers, not arbitrary transport-loss proof.'])
            assert not observed.get('logsTruncated',False)
            composite=act.read_logs(lambda method,payload:rpc('owner',method,payload),observed,jobs[0]['instanceId'],'composite',evidence)
            assert 'typed-composite-nonrecursive-verified' in composite and 'typed-literal-values-verified' not in composite
            assert counts()=={'runs':1,'inputs':1} and runtime()==initial
            private_row=json.loads(metadata("SELECT json_build_object('runId',run_id::text,'contract',contract_version,'schemaSha256',schema_sha256,'submittedSha256',submitted_sha256,'effectiveSha256',effective_sha256,'cipherBytes',octet_length(encrypted_content),'payloadBytes',payload_bytes) FROM golf_workflow_dispatch_inputs WHERE run_id='"+run['id']+"'::uuid"))
            assert private_row['runId']==run['id'] and private_row['contract']==1 and private_row['schemaSha256']==prepared['schemaSha256'] and private_row['submittedSha256']==prepared['submittedSha256'] and private_row['effectiveSha256']==prepared['effectiveSha256'] and private_row['cipherBytes']==private_row['payloadBytes']+28
            record(run={'id':observed['id'],'attemptId':observed['attemptId'],'state':observed['state'],'jobs':jobs,'engineCatalog':CATALOG,'engineCommit':act.ENGINE},logReceipts=evidence,encryptedContentMetadata=private_row,workerFailureStages=act.worker_failure_stages(command('logs','--no-color','runner')))
            if args.ui:
                stage('actual read-only typed editor/run/scoped step browser qualification')
                cookies=[{'name':cookie.name,'value':cookie.value,'url':smoke.GOLF,'httpOnly':True,'sameSite':'Strict'} for handler in owner['session'].handlers if isinstance(handler,urllib.request.HTTPCookieProcessor) for cookie in handler.cookiejar]
                assert len(cookies)==1
                forbidden.extend(cookie['value'] for cookie in cookies)
                execute('node',str(ROOT/'scripts/workflow-dispatch-inputs-browser.mjs'),payload={'golf':smoke.GOLF,'cookies':cookies,'repository':repository,'run':observed,'literal':LITERAL,'sourceRevision':args.source_revision,'stackRoot':str(stack),'output':str(output/'typed-ui')},timeout=240)
                browser=json.loads((output/'typed-ui/manifest.json').read_text());assert browser['complete'] and browser['passed'] and len(browser['captures'])==12
                record(browser={'manifest':'typed-ui/manifest.json','captures':12,'readOnly':True},limitations=['One full-SHA manual v2 run and read-only served editor/run/scoped-step pages; no browser dispatch, input-declaring push, secret binding, provider inference or full Actions parity.','Discarded actual response body after accepted HTTP headers; no arbitrary transport-loss guarantee.','Current native/lease fences source+PG-qualified separately; this runtime slice tests old/HTTP worker exclusion.'])
            passed=True
        except Exception as error:
            if started:
                try:helpers.private_write(output/'private-postgres-failure.log',command('logs','--no-color','--tail','100','postgres'))
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
                if proxy_ready:
                    try:proxy.close()
                    except Exception:cleanup.append('proxy-stop')
                try:
                    command('down','--volumes','--remove-orphans')
                    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
                except Exception:cleanup.append('owned-resources')
            try:
                after=snapshot();helpers.private_write(output/'foreign-after.json',json.dumps(after,indent=2));difference=notifications.foreign_diff(before,after);record(foreignComparison=difference,foreignIdentityUnchanged=difference['identityUnchanged']);assert difference['identityUnchanged']
            except Exception:cleanup.append('foreign-identity')
            smoke.GOLF,smoke.FORGE=previous
            record(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,bootstrap={'unmanagedTokenlessAdministrator':bootstrap_created,'disposedWithOwnedNativeVolume':started and 'owned-resources' not in cleanup},lastStage=STAGE)
            if 'originalFailure' not in manifest:assert not cleanup
    assert passed
    print('PASS: bounded actual typed manual-input run and original-key proof; broader acceptance remains open.')


if __name__=='__main__':
    try:
        if '--self-check' in sys.argv:self_check()
        else:main()
    except Exception as error:
        if REPORT_FAILURE is not None:
            try:REPORT_FAILURE(error)
            except Exception:pass
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
