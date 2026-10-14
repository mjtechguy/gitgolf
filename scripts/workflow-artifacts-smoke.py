#!/usr/bin/env python3
"""Prepared actual bounded GitLab build artifact proof; root operator runs it.
Exact cached images, fresh owned native/PG/TLS/DinD, no builds/pulls/provider.
One successful secretless shell job, private attachment and current read fences.
--self-check opens no sockets/subprocesses/resources. No preview/CD claim.
"""
import argparse
import io
import tarfile
import ast
import base64
from datetime import datetime
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
act = load('artifact_actions_helpers', 'actions-engine-smoke.py')
rules = load('artifact_native_helpers', 'repository-rule-mutations-smoke.py')
notifications = load('artifact_foreign_helpers', 'workflow-notifications-smoke.py')
helpers = act.helpers

CATALOG = 'golf.workflow.shell.v1'
CAPABILITY = 'golf.workflow.shell.artifacts.v1'
IMAGE = act.IMAGE
DIND = 'docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0'
NATIVE, PG = 'gitea/gitea:1.27.3-rootless', 'postgres:18.4-alpine3.24'
RUSTFS = 'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
PATH = '.gitlab-ci.yml'
PROJECT_PREFIX = 'golf-rules49-'
EXPECTED = {'dist/index.html': b'<html>owned artifact</html>\n', 'dist/report.txt': b'owned build report\n'}
STAGE = 'arguments'
REPORT_FAILURE = None

def source_files():
    return {PATH:('build:\n  image: '+IMAGE+'''\n  script:
    - mkdir -p dist
    - printf '<html>owned artifact</html>\\n' > dist/index.html
    - printf 'owned build report\\n' > dist/report.txt
    - echo owned-artifact-build-completed
  artifacts:
    paths: [dist]
''').encode()}

def stage(value):
    global STAGE
    STAGE=value;print('CHECK: '+value,flush=True)

def safe_json(value, forbidden):
    text=json.dumps(value,indent=2)
    assert len(text)<=1048576 and all(not item or item not in text for item in forbidden)
    return text

def artifact_receipt(row,run):
    mappings={'runId':'id','attemptId':'attemptId','repositoryId':'repositoryId','ownerId':'ownerId','commitId':'commitId','workflowPath':'workflowPath','blobId':'workflowBlobId','sourceSha256':'sourceSha256'}
    assert all(row[k]==run[v] for k,v in mappings.items())
    assert re.fullmatch('[a-f0-9]{64}',row['archiveSha256']) and row['fileCount']==2
    assert row['fileBytes']==str(sum(map(len,EXPECTED.values()))) and 1024<=int(row['archiveBytes'])<=10<<20
    assert row['downloadPath']=='/api/workflow-runs/'+run['id']+'/artifact' and len(row['createdAt'])<=64
    datetime.fromisoformat(row['createdAt'].replace('Z','+00:00'))
    return row

def archive_receipt(data,row):
    assert len(data)==int(row['archiveBytes']) and hashlib.sha256(data).hexdigest()==row['archiveSha256']
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as archive:
        files=archive.getmembers();assert [v.name for v in files]==sorted(EXPECTED)
        for item in files:
            assert item.isfile() and not item.linkname and item.mode==0o444 and item.uid==item.gid==0
            assert item.size==len(EXPECTED[item.name]) and archive.extractfile(item).read()==EXPECTED[item.name]
    return {'archiveSha256':row['archiveSha256'],'fileCount':2,'fileBytes':row['fileBytes'],'exactOwnedContent':True,'attachmentNotPreview':True}

def object_receipt(row, run, artifact):
    # This is an independent SQL read of the original immutable address, not
    # current active infrastructure or an assertion about loaded row totals.
    assert str(uuid.UUID(run['id'])) == run['id'] and re.fullmatch('[a-f0-9]{32}',run['attemptId'])
    expected_key='ci-artifacts/'+run['id']+'/'+run['attemptId']+'/'+artifact['archiveSha256']+'.tar'
    address={'Endpoint':'http://rustfs:9000','Bucket':'golf-ci','Region':'us-east-1','Prefix':'golf','PathStyle':True}
    fingerprint=hashlib.sha256(json.dumps(address,separators=(',',':')).encode()).hexdigest()
    assert row['sourceStorage']==row['artifactStorage']=='env_s3' and row['sourceAbsent'] is True and row['archiveAbsent'] is True
    assert row['sourceProfileAbsent'] is True and row['artifactProfileAbsent'] is True
    assert row['sourceKey']=='ci-sources/'+run['sourceSha256']+'.tar' and row['objectKey']==expected_key
    assert row['sourceFingerprint']==row['objectFingerprint']==fingerprint
    assert row['archiveSha256']==artifact['archiveSha256'] and str(row['archiveBytes'])==artifact['archiveBytes']
    return 'golf/'+expected_key

def signed_get_config(endpoint,key,access,secret):
    assert re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}',endpoint) and 1<=int(endpoint.rsplit(':',1)[1])<=65535
    assert re.fullmatch('[a-f0-9]{48}',access) and re.fullmatch('[a-f0-9]{64}',secret)
    assert re.fullmatch(r'golf/ci-artifacts/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/[a-f0-9]{32}/[a-f0-9]{64}\.tar',key)
    return 'url = "'+endpoint+'/golf-ci/'+key+'"\nuser = "'+access+':'+secret+'"\n'

def self_check():
    assert native_proxy.PROJECT.fullmatch(PROJECT_PREFIX+'0123456789')
    source=source_files()[PATH];assert b'artifacts:' in source and b'paths: [dist]' in source and IMAGE.encode() in source
    tree=ast.parse(Path(__file__).read_text())
    for node in ast.walk(tree):
        for target in getattr(node,'targets',[]):
            assert not any(isinstance(v,ast.Name) and v.id in {'execute','command'} for v in ast.walk(target))
    run={'id':str(uuid.uuid4()),'attemptId':'a'*32,'repositoryId':'12','ownerId':'13','commitId':'b'*40,'workflowPath':PATH,'workflowBlobId':'c'*40,'sourceSha256':'d'*64}
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w') as archive:
        for name,data in sorted(EXPECTED.items()):
            item=tarfile.TarInfo(name);item.mode=0o444;item.size=len(data);archive.addfile(item,io.BytesIO(data))
    data=stream.getvalue();row={'runId':run['id'],'attemptId':run['attemptId'],'repositoryId':run['repositoryId'],'ownerId':run['ownerId'],'commitId':run['commitId'],'workflowPath':PATH,'blobId':run['workflowBlobId'],'sourceSha256':run['sourceSha256'],'archiveSha256':hashlib.sha256(data).hexdigest(),'fileCount':2,'fileBytes':str(sum(map(len,EXPECTED.values()))),'archiveBytes':str(len(data)),'createdAt':'2026-10-04T00:00:00Z','downloadPath':'/api/workflow-runs/'+run['id']+'/artifact'}
    artifact_receipt(row,run);archive_receipt(data,row)
    address={'Endpoint':'http://rustfs:9000','Bucket':'golf-ci','Region':'us-east-1','Prefix':'golf','PathStyle':True}
    fp=hashlib.sha256(json.dumps(address,separators=(',',':')).encode()).hexdigest()
    record={'sourceStorage':'env_s3','artifactStorage':'env_s3','sourceAbsent':True,'archiveAbsent':True,'sourceProfileAbsent':True,'artifactProfileAbsent':True,'sourceKey':'ci-sources/'+run['sourceSha256']+'.tar','objectKey':'ci-artifacts/'+run['id']+'/'+run['attemptId']+'/'+row['archiveSha256']+'.tar','sourceFingerprint':fp,'objectFingerprint':fp,'archiveSha256':row['archiveSha256'],'archiveBytes':len(data)}
    key=object_receipt(record,run,row);config=signed_get_config('http://127.0.0.1:12345',key,'a'*48,'b'*64)
    assert 'golf-ci/golf/ci-artifacts/' in config and ('a'*48+':'+ 'b'*64) in config
    for change in ({'archiveAbsent':False},{'sourceStorage':'postgres'},{'objectKey':'ci-sources/'+row['archiveSha256']+'.tar'},{'objectFingerprint':'0'*64},{'archiveBytes':1}):
        try:object_receipt(record|change,run,row)
        except AssertionError:pass
        else:raise AssertionError('Unbound artifact object admitted')
    for endpoint,badkey in [('http://outside.invalid:9000',key),('http://127.0.0.1:9000',key.replace('golf/','')),('http://127.0.0.1:9000',key+'/../other')]:
        try:signed_get_config(endpoint,badkey,'a'*48,'b'*64)
        except AssertionError:pass
        else:raise AssertionError('Unowned object read admitted')
    for field in ('attemptId','commitId','sourceSha256','downloadPath'):
        try:artifact_receipt(row|{field:'wrong'},run)
        except AssertionError:pass
        else:raise AssertionError('Changed immutable receipt admitted')
    try:archive_receipt(data[:-1],row)
    except AssertionError:pass
    else:raise AssertionError('Changed archive admitted')
    try:safe_json({'private':'PRIVATE_SENTINEL'},['PRIVATE_SENTINEL'])
    except AssertionError:pass
    else:raise AssertionError('Private value admitted')
    print('PASS: pure artifact fixture/receipt/archive/private-object guards; no resources.')

def main():
    global REPORT_FAILURE
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('image','runner-image','source-revision','expected-core-sha256','expected-runner-sha256','expected-engine-sha256'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--proxy-binary',type=Path,required=True)
    parser.add_argument('--stack-root',type=Path,default=ROOT)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--seed-wait-seconds',type=int,default=300)
    parser.add_argument('--rustfs',action='store_true',help='Fresh private pinned RustFS source/artifact storage; PostgreSQL recipe unchanged by default')
    parser.add_argument('--ui',action='store_true',help='Four actual read-only run/attachment captures (dark/light1440/390)')

    args=parser.parse_args();stack=args.stack_root.resolve();output=args.output.resolve()
    assert 1<=args.seed_wait_seconds<=600 and not output.exists()
    assert re.fullmatch('[a-f0-9]{40}',args.source_revision)
    for digest in (args.expected_core_sha256,args.expected_runner_sha256,args.expected_engine_sha256):assert re.fullmatch('[a-f0-9]{64}',digest)
    output.mkdir(parents=True,mode=0o700);output.chmod(0o700)
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    forbidden=[];manifest={'complete':False,'passed':False,'proofKind':'gitlab-shell-artifacts062','sourceRevision':args.source_revision,'limitations':['One secretless successful legacy GitLab shell job only; no Actions artifact service, preview or deployment.','PG bounded attachment profile; no object-storage scale or latest-schema recovery proof.','Current native before/after read authority is not an atomic native CAS.']}
    if args.rustfs:
        manifest['proofKind']='gitlab-shell-artifacts064-rustfs'
        manifest['limitations'][1]='One private operator env_s3 RustFS profile; retained20/repository and200/instance caps; no profile activation, scale or latest-schema recovery proof.'
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
            record(originalFailure={'type':type(error).__name__,'stage':STAGE,'frames':[{'file':Path(v.filename).name if Path(v.filename).name in {Path(__file__).name,'observability-smoke.py','repository-rule-mutations-smoke.py','native_qualification_proxy.py','smoke.py'} else 'dependency','line':v.lineno} for v in traceback.extract_tb(error.__traceback__)[-6:]]})
    REPORT_FAILURE=failure
    record(stage=STAGE)
    def snapshot():
        ids=execute('docker','ps','-aq','--no-trunc').splitlines();assert len(ids)<=500
        if not ids:return {}
        template='{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}}},"RestartCount":{{json .RestartCount}}}'
        return notifications.filtered_foreign([json.loads(line) for line in execute('docker','inspect','--format',template,*ids).splitlines()])
    stage('cached immutable images/binaries and two-GiB reserve')
    if args.rustfs:assert '--aws-sigv4' in execute('curl','--disable','--help','all')
    images={}
    for role,ref in [('golf',args.image),('runner',args.runner_image),('native',NATIVE),('postgres',PG),('daemon',DIND)]+([('rustfs',RUSTFS)] if args.rustfs else []):
        row=json.loads(execute('docker','image','inspect',ref))[0];assert re.fullmatch('sha256:[a-f0-9]{64}',row['Id']);images[role]=row['Id']
        if role=='rustfs':assert RUSTFS.split('@')[0].split(':')[0]+'@'+RUSTFS.split('@')[1] in row.get('RepoDigests',[])
        if role in ('golf','runner'):assert ref==row['Id'] and (row['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')==args.source_revision
    binaries={}
    for role,binary,digest in [('golf','golf',args.expected_core_sha256),('runner','golf-runner',args.expected_runner_sha256),('golf','golf-actions-engine',args.expected_engine_sha256),('runner','golf-actions-engine',args.expected_engine_sha256)]:
        raw=execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/usr/bin/sha256sum',images[role],'/usr/local/bin/'+binary)
        assert raw.split()==[digest,'/usr/local/bin/'+binary];binaries[role+'/'+binary]=digest
    assert int(execute('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',images['golf'],'-Pk','/').splitlines()[-1].split()[3])>=2*1024*1024
    binary,binary_sha=rules.proxy_binary_receipt(args.proxy_binary)
    before=snapshot();helpers.private_write(output/'foreign-before.json',json.dumps(before,indent=2))
    project=PROJECT_PREFIX+secrets.token_hex(5);ports=helpers.free_ports(5 if args.rustfs else 4)
    for argv in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not execute('docker',*argv,'--filter','label=com.docker.compose.project='+project)
    previous=smoke.GOLF,smoke.GITEA;smoke.GOLF=f'http://127.0.0.1:{ports[0]}';smoke.GITEA=f'http://127.0.0.1:{ports[1]}';secure=f'https://127.0.0.1:{ports[2]}'
    record(images=images,binarySha256=binaries,project=project,helperRevision=execute('git','rev-parse','HEAD'),proxyBinarySha256=binary_sha)
    actors={};started=False;passed=False;cleanup=[];bootstrap_created=False;proxy_ready=False
    with native_proxy.NativeProxy(ports[3],project) as proxy,tempfile.TemporaryDirectory(prefix=project+'-') as tmp:
        directory=Path(tmp);directory.chmod(0o700);environment.update(proxy.environment())
        ca,cert,key=directory/'ca.crt',directory/'server.crt',directory/'server.key'
        helpers.private_write(directory/'ca.conf','[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Golf artifact fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n')
        helpers.private_write(directory/'extensions','basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(directory/'ca.conf'),'-keyout',str(directory/'ca.key'),'-out',str(ca))
        execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(directory/'server.csr'))
        execute('openssl','x509','-req','-days','1','-in',str(directory/'server.csr'),'-CA',str(ca),'-CAkey',str(directory/'ca.key'),'-CAcreateserial','-extfile',str(directory/'extensions'),'-out',str(cert))
        for file in (ca,cert,key):file.chmod(0o444)
        worker_key=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_RUNNER_KEY=worker_key,GOLF_RUNNER_KEYS=json.dumps({'local-docker':worker_key}),GOLF_RUNNER_IMAGES=json.dumps({'linux':IMAGE}),GOLF_RUNNER_JOB_IMAGE=IMAGE,GOLF_RUNNER_APPROVED_IMAGES=json.dumps([IMAGE]),GOLF_INTERNAL_TLS_LISTEN_ADDR=':8443',GOLF_INTERNAL_TLS_CERT_FILE=str(cert),GOLF_INTERNAL_TLS_KEY_FILE=str(key),GOLF_RUNNER_TLS_CA_FILE=str(ca),GOLF_RUNNER_TLS_URL='https://127.0.0.1:8443')
        forbidden.extend(values[k] for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD','GOLF_ENCRYPTION_KEY','GOLF_RUNNER_KEY'));forbidden.append(environment['NATIVE_QUALIFICATION_NONCE'])
        if args.rustfs:
            values.update(RUSTFS_ACCESS_KEY=secrets.token_hex(24),RUSTFS_SECRET_KEY=secrets.token_hex(32))
            forbidden.extend([values['RUSTFS_ACCESS_KEY'],values['RUSTFS_SECRET_KEY']])
        helpers.private_write(directory/'proof.env',''.join(k+"='"+v+"'\n" for k,v in values.items()))
        overlay={'services':{'golf':{'image':images['golf'],'pull_policy':'never','mem_limit':'384m','environment':{'GITEA_URL':'http://native-qualification-proxy:8081','GOLF_ACTIONS_ENGINE_CATALOG':act.CATALOG},'depends_on':{native_proxy.SERVICE_NAME:{'condition':'service_started'}}},'gitea':{'image':images['native'],'pull_policy':'never','mem_limit':'512m','environment':{'GITEA__server__ROOT_URL':smoke.GITEA+'/','GITEA__server__DISABLE_SSH':'true','GITEA__server__START_SSH_SERVER':'false','GITEA__actions__ENABLED':'false'}},'postgres':{'image':images['postgres'],'pull_policy':'never','mem_limit':'768m','command':['postgres','-c','max_wal_size=64MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s']},'runner':{'image':images['runner'],'pull_policy':'never'},'runner-daemon':{'image':images['daemon'],'pull_policy':'never','mem_limit':'1024m'},'runner-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},'runner-actions-image-init':{'entrypoint':['/bin/true'],'command':[],'pull_policy':'never'},native_proxy.SERVICE_NAME:proxy.compose_service(images['golf'],binary)}}
        if args.rustfs:
            overlay['services']['rustfs']={'image':images['rustfs'],'pull_policy':'never','mem_limit':'512m','cpus':2,'pids_limit':256,'ports':['127.0.0.1:'+str(ports[4])+':9000']}
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
        for file in ('compose.yaml','deploy/compose/compose.ci.yaml','deploy/compose/compose.actions-engine.yaml','deploy/compose/compose.runner-tls.yaml'):compose+=['-f',str(stack/file)]
        if args.rustfs:compose+=['-f',str(stack/'deploy/compose/compose.storage.yaml')]
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
            started=True;command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres','gitea','golf',native_proxy.SERVICE_NAME,'runner-daemon');proxy.ready();proxy_ready=True;smoke.ready();record(proxyRuntime=rules.verify_proxy_runtime(execute,command,proxy,binary,binary_sha,images['golf'],args.source_revision))
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
            if args.rustfs:
                stage('operator initializes only the fresh private RustFS bucket')
                cid=command('ps','-q','rustfs');row=json.loads(execute('docker','inspect',cid))[0]
                assert row['Image']==images['rustfs'] and row['Config']['Labels']['com.docker.compose.project']==project
                binding=row['NetworkSettings']['Ports']['9000/tcp'];assert len(binding)==1 and binding[0]['HostIp']=='127.0.0.1' and binding[0]['HostPort']==str(ports[4])
                assert row['State']['Running'] and row['State']['Health']['Status']=='healthy'
                command('exec','-T','golf','golf','objectstore','initialize')
                record(objectStore={'kind':'env_s3','bucket':'golf-ci','prefix':'golf','image':images['rustfs'],'containerId':row['Id'],'freshOperatorBootstrap':True,'privateOnly':True})
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
            for role in ('owner','reader'):
                actor={'name':project+'-'+role,'session':smoke.client(),'created':False,'enrolled':False};actors[role]=actor
                actor.update(email=actor['name']+'@example.invalid',password=secrets.token_urlsafe(32));forbidden.append(actor['password'])
                admin('create','--username',actor['name'],'--email',actor['email'],'--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:repository','--raw');forbidden.append(actor['token'])
                identity=smoke.provider(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is False;actor['id']=str(identity['id'])
                result=json.loads(command('exec','-T','golf','golf','local-account','create',payload={'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='owner'}));assert result['state']=='complete';actor['enrolled']=True
                rpc(role,'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})
            owner=actors['owner'];native=smoke.provider(owner['token'],'POST','user/repos',{'name':'build-artifacts','private':True,'auto_init':True},expected=201)
            repository={'owner':owner['name'],'name':native['name']};base='repos/'+native['full_name'];smoke.wait_for_push(owner['token'],native['full_name'])
            smoke.provider(owner['token'],'PUT',base+'/collaborators/'+actors['reader']['name'],{'permission':'read'},expected=204)
            files=source_files()
            for path,data in files.items():smoke.provider(owner['token'],'POST',base+'/contents/'+path,{'content':base64.b64encode(data).decode(),'message':'Controlled build artifact fixture'},expected=201)
            head=smoke.provider(owner['token'],'GET',base+'/branches/'+native['default_branch'])['commit']['id'];assert re.fullmatch('[a-f0-9]{40}',head)
            blob=hashlib.sha1(b'blob '+str(len(files[PATH])).encode()+b'\0'+files[PATH]).hexdigest();target={'repository':repository,'repositoryId':str(native['id']),'ownerId':str(native['owner']['id'])}
            for scope in ('INSTANCE','REPOSITORY'):
                selected={'scope':'EXECUTION_SCOPE_'+scope}|({'repository':repository} if scope=='REPOSITORY' else {})
                policy=rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
                rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected|{'scopeId':policy['scopeId'],'expectedRevision':policy.get('revision','0'),'expectedAuthorityRevision':policy['authorityRevision'],'mode':'EXECUTION_MODE_ALL','manualDispatchEnabled':True,'pushAllowed':False,'allowAllWorkflows':True})

            stage('legacy GitLab declaration and one exact admission')
            inspection=rpc('owner','WorkflowService/InspectWorkflows',{'repository':repository,'ref':head,'repositoryId':target['repositoryId']})
            assert inspection['repositoryId']==target['repositoryId'] and inspection['commitId']==head
            configurations=inspection.get('configurations',[]);assert len(configurations)==1 and configurations[0]['path']==PATH and configurations[0]['blobId']==blob and configurations[0]['format']=='WORKFLOW_FORMAT_GITLAB_CI'
            operation=str(uuid.uuid4());dispatch={'repository':repository,'ref':head,'workflowPath':PATH,'idempotencyKey':operation}
            run=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run']
            assert run['engineCatalog']==CATALOG and run['state']=='WORKFLOW_RUN_STATE_QUEUED' and run['commitId']==head and run['workflowBlobId']==blob and run['repositoryId']==target['repositoryId'] and run['ownerId']==target['ownerId']
            assert not rpc('owner','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']}).get('artifact')
            def machine(url,caps,ctx=None):
                request=urllib.request.Request(url+'/internal/ci/poll',data=json.dumps({'catalogs':[],'capabilities':caps}).encode(),headers={'Content-Type':'application/json','Golf-Runner-ID':'local-docker','Authorization':'Bearer '+worker_key})
                opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx)) if ctx else urllib.request.build_opener()
                with opener.open(request,timeout=20) as reply:assert reply.status==204 and not reply.read(4096)
            machine(smoke.GOLF,['golf.runner.job-limits.v1',CAPABILITY]);machine(secure,['golf.runner.job-limits.v1'],context)
            assert rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']['state']=='WORKFLOW_RUN_STATE_QUEUED'
            record(oldAndHTTPWorkerExcluded={'authenticatedProtocolOnly':True,'missingArtifactCapability204':True,'httpCapability204':True,'realOldBinaryNotExercised':True})
            stage('actual TLS Docker shell artifact producer')
            command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init');command('up','-d','--no-build','--pull','never','runner')
            initial=runtime();record(runtimeBefore=initial)
            if args.rustfs:
                env=json.loads(execute('docker','inspect',initial['runner']['containerId']))[0]['Config']['Env']
                assert not any(v.startswith(('GOLF_OBJECT_','RUSTFS_','AWS_')) or values['RUSTFS_SECRET_KEY'] in v or values['RUSTFS_ACCESS_KEY'] in v for v in env)

            def terminal():
                current=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':run['id']})['run']
                return current if current['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING') else None
            observed=helpers.until(terminal,timeout=240)
            record(terminalRun={k:observed[k] for k in ('id','attemptId','state','engineCatalog','jobs','failureCode') if k in observed}, retainedArtifactCount=int(metadata('SELECT count(*) FROM golf_workflow_artifacts')))
            if observed['state']!='WORKFLOW_RUN_STATE_SUCCEEDED':
                helpers.private_write(output/'private-runner-failure.log',redact(command('logs','--no-color','--tail','80','runner')))
                helpers.private_write(output/'private-run-output.json',redact(json.dumps(rpc('owner','WorkflowRunService/GetWorkflowRunLogs',{'runId':observed['id']}))))
            assert observed['state']=='WORKFLOW_RUN_STATE_SUCCEEDED' and observed['engineCatalog']==CATALOG and not observed.get('inputContract') and not observed.get('executionBindingId')
            assert all(observed[k]==run[k] for k in ('id','repositoryId','ownerId','commitId','workflowPath','workflowBlobId','sourceSha256')) and re.fullmatch('[a-f0-9]{32}',observed['attemptId'])
            log=act.read_logs(lambda method,payload:rpc('owner',method,payload),observed)
            assert 'owned-artifact-build-completed' in log and not observed.get('logsTruncated',False)
            def removed():
                containers=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
                volumes=command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
                return not containers and not volumes
            assert helpers.until(removed,timeout=45)
            metadata_row=artifact_receipt(rpc('owner','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']})['artifact'],observed)
            assert rpc('reader','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']})['artifact']==metadata_row
            def download(role,extra=None,status=200):
                request=urllib.request.Request(smoke.GOLF+metadata_row['downloadPath'],headers={'Origin':smoke.GOLF}|(extra or {}))
                try:reply=actors[role]['session'].open(request,timeout=20)
                except urllib.error.HTTPError as error:
                    assert error.code==status and error.read(4096);return None
                with reply:
                    assert reply.status==status
                    assert reply.headers['Content-Type']=='application/octet-stream' and reply.headers['Content-Disposition']=='attachment; filename="build-artifacts.tar"'
                    assert reply.headers['X-Content-Type-Options']=='nosniff' and reply.headers['Content-Security-Policy']=="sandbox; default-src 'none'" and reply.headers['Cache-Control']=='no-store'
                    value=reply.read((10<<20)+1);assert len(value)<=10<<20;return value
            payload=download('owner');proof=archive_receipt(payload,metadata_row);assert download('reader')==payload
            download('owner',{'Origin':'https://outside.invalid'},403);download('owner',{'Authorization':'Bearer '+owner['token']},403)
            record(artifact=metadata_row,archiveVerification=proof,actualDockerCleanup={'attemptContainersAbsent':True,'attemptVolumesAbsent':True},run={'id':observed['id'],'attemptId':observed['attemptId'],'state':observed['state'],'engineCatalog':CATALOG})
            if args.rustfs:
                stage('original source and artifact object locators plus independent signed read')
                def object_state():
                    return json.loads(metadata("SELECT jsonb_build_object('sourceStorage',r.source_storage,'artifactStorage',a.storage,'sourceAbsent',r.source_archive IS NULL,'archiveAbsent',a.archive IS NULL,'sourceProfileAbsent',r.source_profile_id IS NULL AND r.source_profile_version IS NULL,'artifactProfileAbsent',a.object_profile_id IS NULL AND a.object_profile_version IS NULL,'sourceKey',r.source_key,'objectKey',a.object_key,'sourceFingerprint',r.source_fingerprint,'objectFingerprint',a.object_fingerprint,'archiveSha256',a.archive_sha256,'archiveBytes',a.archive_bytes) FROM golf_workflow_runs r JOIN golf_workflow_artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id WHERE r.id='"+str(uuid.UUID(run['id']))+"'::uuid"))
                original_object=object_state();key=object_receipt(original_object,observed,metadata_row)
                def independent_object():
                    cid=command('ps','-q','rustfs');receipt=json.loads(execute('docker','inspect',cid))[0]
                    assert receipt['Id']==manifest['objectStore']['containerId'] and receipt['Image']==images['rustfs'] and receipt['State']['Running'] and receipt['Config']['Labels']['com.docker.compose.project']==project
                    ports_receipt=receipt['NetworkSettings']['Ports']['9000/tcp']
                    assert len(ports_receipt)==1 and ports_receipt[0]['HostIp']=='127.0.0.1' and ports_receipt[0]['HostPort']==str(ports[4])
                    config=signed_get_config('http://127.0.0.1:'+str(ports[4]),key,values['RUSTFS_ACCESS_KEY'],values['RUSTFS_SECRET_KEY'])
                    path=directory/'independent-object.tar';path.touch(mode=0o600,exist_ok=True);path.chmod(0o600)
                    result=subprocess.run(['curl','--disable','--silent','--show-error','--request','GET','--aws-sigv4','aws:amz:us-east-1:s3','--noproxy','*','--proto','=http','--max-time','30','--retry','0','--max-filesize',str(10<<20),'--output',str(path),'--write-out','%{http_code}','--config','-'],input=config.encode(),env=environment,cwd=stack,capture_output=True,timeout=35)
                    assert result.returncode==0 and result.stdout==b'200' and len(result.stderr)<65536 and path.stat().st_size<=10<<20,'Independent private S3 read refused; diagnostics withheld'
                    data=path.read_bytes();assert data==payload;archive_receipt(data,metadata_row);path.unlink()
                    return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'exactAttachmentMatch':True}
                signed=independent_object()
                record(objectProof={'sourceStorage':'env_s3','artifactStorage':'env_s3','postgresSourceAndArtifactBytesAbsent':True,'exactOriginalAddress':True,'fullObjectKey':key,'independentSignedRead':signed,'workerCredentialsAbsent':True})
                stage('private RustFS unavailable refuses rather than PostgreSQL fallback')
                command('stop','rustfs')
                # Raw attachment handler explicitly maps storage failures to503.
                # Do not invent a new RPC status mapping for the provider error.
                download('owner',status=503)
                assert object_state()==original_object
                command('up','-d','--no-build','--pull','never','--wait','--wait-timeout','90','rustfs')
                assert independent_object()==signed and download('owner')==payload
                manifest['objectProof']['providerUnavailableNoFallback']=True;manifest['objectProof']['rustfsRestartExactBytes']=True;record()
            stage('restart original immutable run and attachment without redispatch')
            command('restart','golf');smoke.ready()
            assert rpc('owner','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']})['artifact']==metadata_row and download('owner')==payload
            replay=rpc('owner','WorkflowRunService/DispatchWorkflow',dispatch)['run'];assert replay['id']==observed['id'] and replay['attemptId']==observed['attemptId'] and replay['state']==observed['state']
            assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==1 and int(metadata('SELECT count(*) FROM golf_workflow_artifacts'))==1
            if args.rustfs:assert object_state()==original_object and independent_object()==signed
            record(restart={'sameMetadataAndHash':True,'originalDispatchNoReplay':True,'runCount':1,'artifactCount':1},runtimeAfter=runtime())
            if args.ui:
                stage('actual read-only run attachment browser')
                cookies=[{'name':cookie.name,'value':cookie.value,'url':smoke.GOLF,'httpOnly':True,'sameSite':'Strict'} for handler in owner['session'].handlers if isinstance(handler,urllib.request.HTTPCookieProcessor) for cookie in handler.cookiejar]
                assert len(cookies)==1;forbidden.extend(cookie['value'] for cookie in cookies)
                execute('node',str(ROOT/'scripts/workflow-artifacts-browser.mjs'),payload={'golf':smoke.GOLF,'cookies':cookies,'repository':repository,'run':observed,'artifact':metadata_row,'forbidden':[owner['password'],owner['token']]+[cookie['value'] for cookie in cookies],'sourceRevision':args.source_revision,'stackRoot':str(stack),'output':str(output/'artifact-ui')},timeout=180)
                browser=json.loads((output/'artifact-ui/manifest.json').read_text());assert browser['complete'] and browser['passed'] and len(browser['captures'])==4
                record(browser={'manifest':'artifact-ui/manifest.json','captures':4,'readOnly':True})
            stage('current native reader removal fences metadata and attachment')
            smoke.provider(owner['token'],'DELETE',base+'/collaborators/'+actors['reader']['name'],expected=204)
            rpc('reader','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']},expected=404);download('reader',status=404)
            assert rpc('owner','WorkflowArtifactService/GetWorkflowArtifact',{'runId':run['id']})['artifact']==metadata_row
            record(readerReadThenRevocationDenied=True,foreignOriginAndBearerDenied=True)
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
            smoke.GOLF,smoke.GITEA=previous
            record(passed=passed,complete=passed and not cleanup,cleanupPassed=not cleanup,cleanupFailures=cleanup,bootstrap={'unmanagedTokenlessAdministrator':bootstrap_created,'disposedWithOwnedNativeVolume':started and 'owned-resources' not in cleanup},lastStage=STAGE)
            if 'originalFailure' not in manifest:assert not cleanup
    assert passed
    print('PASS: bounded actual GitLab artifact producer, private attachment and current-read proof; broader acceptance remains open.')


if __name__=='__main__':
    try:
        if '--self-check' in sys.argv:self_check()
        else:main()
    except Exception as error:
        if REPORT_FAILURE is not None:
            try:REPORT_FAILURE(error)
            except Exception:pass
        print('FAIL at '+STAGE+': '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
