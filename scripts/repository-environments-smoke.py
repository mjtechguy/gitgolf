#!/usr/bin/env python3
"""Prepared actual055 environment configuration qualification; root runs resources.

One fresh isolated Compose project uses cached exact core/PG/native images and
an owned internal NativeProxy. Supported API/admin/operator procedures only;
read-only Golf SQL inspects counts/identity, never native SQL or repository files.
No workers, deployment, CD, models, remote CI, pulls/builds or retained changes.
Private credentials stay in RAM/private stdin/tempfiles. --self-check is pure.
"""
import argparse
import base64
import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import traceback
import uuid
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import smoke
import native_qualification_proxy as native_proxy


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


helpers = load('environment_stack_helpers', ROOT/'scripts/observability-smoke.py')
rules = load('environment_native_helpers', ROOT/'scripts/repository-rule-mutations-smoke.py')
SERVICE = 'RepositoryEnvironmentService/'
CAPABILITY = 'REPOSITORY_ENVIRONMENT_CAPABILITY_CONFIGURATION_ONLY'
POLICY = dict(allowAllSources=True, preventSelfApproval=True, protectedPreviews=True,
              maxConcurrency=1, previewTtlSeconds=3600)
SOURCE = '3cadc2aa339698138f6b1d561f4fdffa51c3e2bc'
STAGE, OUTPUT = 'arguments', None
PROOF = {'status':'prepared_not_run','cleanup':'not_created',
         'scope':'Configuration-only055 atomic local saved versions/original receipts; no actual deployment, CD release, native atomic authority, recovery or full Environments readiness.',
         'remaining':['actual environment deployment consumer and protected preview expiry','deployment approvals/wait/concurrency enforcement','secret release/CD/fork authority','recovery and atomic native authority']}


def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        temporary = OUTPUT/'manifest.json.tmp'
        with temporary.open('w') as file:
            temporary.chmod(0o600); json.dump(PROOF,file,indent=2,sort_keys=True); file.write('\n')
        temporary.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value; record(stage=value); print('CHECK: '+value,flush=True)


def decimal(value, positive=True):
    return isinstance(value,str) and re.fullmatch(r'[1-9][0-9]{0,18}' if positive else r'0|[1-9][0-9]{0,18}',value) is not None and int(value)<=9223372036854775807


def timestamp(value):
    assert isinstance(value,str) and len(value)<=64 and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z',value)
    return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))


def receipt(result, request, actor, action, prior=None):
    env, op = result['environment'], result['operation']
    version = str(int(request['expectedVersion'])+1)
    assert env['id']==request['environmentId'] and env['version']==version
    assert env['target']==request['target'] and op['target']==env['target']
    assert env['capability']==CAPABILITY and env.get('deploymentAvailable',False) is False
    assert env.get('deleted',False) is (action=='DELETE')
    assert env['updaterId']==actor['id'] and timestamp(env['updatedAt'])>=timestamp(env['createdAt'])
    assert op['operationId']==request['operationId'] and op['environmentId']==env['id']
    assert op['actorId']==actor['id'] and op['action']=='REPOSITORY_ENVIRONMENT_ACTION_'+action
    assert op['expectedVersion']==request['expectedVersion'] and op['version']==version and op['state']=='SUCCEEDED'
    assert op['createdAt']==env['updatedAt']
    if action=='SAVE': assert env['name']==request['name'] and env['policy']==request['policy']
    if prior is None: assert env['creatorId']==actor['id'] and env['createdAt']==env['updatedAt']
    else:
        assert env['creatorId']==prior['creatorId'] and env['createdAt']==prior['createdAt']
        if action=='DELETE': assert env['name']==prior['name'] and env['policy']==prior['policy']
    assert set(op)=={'operationId','environmentId','target','actorId','action','expectedVersion','version','state','createdAt'}
    return result


def self_check():
    proto=(ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('ListRepositoryEnvironments','SaveRepositoryEnvironment','DeleteRepositoryEnvironment','GetRepositoryEnvironmentOperation'):
        assert 'rpc '+method+'(' in proto
    for message, fields in {'RepositoryEnvironmentTarget':{'repository_id':2,'owner_id':3,'access_revision':4},'SaveRepositoryEnvironmentRequest':{'environment_id':2,'expected_version':3,'operation_id':6,'current_password':7},'DeleteRepositoryEnvironmentRequest':{'environment_id':2,'expected_version':3,'operation_id':4,'current_password':5}}.items():
        body=re.search(r'message '+message+r'\s*\{([^}]+)\}',proto).group(1)
        for field,tag in fields.items(): assert re.search(r'string\s+'+field+r'\s*=\s*'+str(tag)+r'\s*;',body)
    target={'repository':{'owner':'owned','name':'private'},'repositoryId':'9007199254740993','ownerId':'7','accessRevision':'a'*64}
    request={'target':target,'environmentId':str(uuid.uuid4()),'expectedVersion':'0','operationId':str(uuid.uuid4()),'name':'Preview ü','policy':POLICY,'currentPassword':'never-recorded'}
    env={'id':request['environmentId'],'target':target,'name':request['name'],'version':'1','policy':POLICY,'creatorId':'8','updaterId':'8','createdAt':'2026-10-04T01:02:03.123456789Z','updatedAt':'2026-10-04T01:02:03.123456789Z','capability':CAPABILITY}
    op={'operationId':request['operationId'],'environmentId':env['id'],'target':target,'actorId':'8','action':'REPOSITORY_ENVIRONMENT_ACTION_SAVE','expectedVersion':'0','version':'1','state':'SUCCEEDED','createdAt':env['createdAt']}
    valid={'environment':env,'operation':op}; receipt(valid,request,{'id':'8'},'SAVE')
    edit={**request,'expectedVersion':'1','operationId':str(uuid.uuid4()),'name':'Independent editor'}
    edited=copy.deepcopy(valid);edited['environment'].update(name=edit['name'],version='2',updaterId='9',updatedAt='2026-10-04T01:02:04Z')
    edited['operation'].update(operationId=edit['operationId'],actorId='9',expectedVersion='1',version='2',createdAt=edited['environment']['updatedAt'])
    receipt(edited,edit,{'id':'9'},'SAVE',env)
    deletion={key:edit[key] for key in ('target','environmentId','currentPassword')};deletion.update(expectedVersion='2',operationId=str(uuid.uuid4()))
    deleted=copy.deepcopy(edited);deleted['environment'].update(version='3',deleted=True,updatedAt='2026-10-04T01:02:05Z')
    deleted['operation'].update(operationId=deletion['operationId'],action='REPOSITORY_ENVIRONMENT_ACTION_DELETE',expectedVersion='2',version='3',createdAt=deleted['environment']['updatedAt'])
    receipt(deleted,deletion,{'id':'9'},'DELETE',edited['environment'])
    for section,field,value in (('environment','deploymentAvailable',True),('environment','creatorId','9'),('environment','version','2'),('environment','target',{**target,'repositoryId':'9'}),('operation','actorId','9'),('operation','state','UNKNOWN'),('operation','operationId',str(uuid.uuid4())),('operation','createdAt','2026-10-04T01:02:02Z')):
        wrong=copy.deepcopy(valid);wrong[section][field]=value
        try:receipt(wrong,request,{'id':'8'},'SAVE')
        except (AssertionError,ValueError,KeyError):pass
        else:raise AssertionError('Foreign/unqualified configuration receipt admitted')
    for value in ('0','01','9223372036854775808','1e2'):assert not decimal(value)
    assert decimal(target['repositoryId'])
    with tempfile.TemporaryDirectory(prefix='golf-env-pure-') as folder:
        helpers.private_write(Path(folder)/'private','private fixture only')
        assert (Path(folder)/'private').stat().st_mode&0o777==0o600
    print('PASS: pure055 wire tags, int64 identity, exact operation/configuration-only receipts and private file mode; no resources')


def main():
    global OUTPUT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true')
    parser.add_argument('--image',help='Cached immutable core SHA; no build/pull')
    parser.add_argument('--source-revision',default=SOURCE,help='Exact OCI source revision expected on core')
    parser.add_argument('--proxy-binary',type=Path,help='Owned frozen Linux ARM64 NativeProxy')
    parser.add_argument('--output',type=Path,help='Fresh private output directory')
    parser.add_argument('--stack-root',type=Path,default=ROOT,help='Checkout containing shared compose/helpers/browser dependencies')
    parser.add_argument('--ui',action='store_true',help='Actual requested editors/version receipts in twelve theme/width captures')
    args=parser.parse_args()
    if args.self_check:self_check();return
    if not args.image or not args.proxy_binary or not args.output:parser.error('--image, --proxy-binary and --output required')
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',args.image) and re.fullmatch(r'[a-f0-9]{40}',args.source_revision)
    stack=args.stack_root.resolve(); assert (stack/'compose.yaml').is_file()
    binary,binary_sha=rules.proxy_binary_receipt(args.proxy_binary)
    args.output.mkdir(mode=0o700,parents=True,exist_ok=False);args.output.chmod(0o700);OUTPUT=args.output.resolve()
    rules.PROOF=PROOF;rules.OUTPUT=OUTPUT;rules.ROOT=stack
    record(status='running',browser='pending' if args.ui else 'not_requested',helperSha256=rules.file_sha256(Path(__file__),1<<20))
    environment={k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k!='DATABASE_URL'}
    def run(*arguments,payload=None,timeout=180):
        result=subprocess.run(arguments,cwd=stack,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode==0 and len(result.stdout)<=8<<20 and len(result.stderr)<=8<<20,'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('cached immutable images and2GiB reserve')
    if args.ui:assert (stack/'web/node_modules/playwright/index.mjs').is_file() and (stack/'scripts/repository-environments-ui-smoke.mjs').is_file()
    image_info=json.loads(run('docker','image','inspect',args.image))[0];image=image_info['Id']
    assert image==args.image and image_info['Config'].get('Labels',{}).get('org.opencontainers.image.revision')==args.source_revision
    for dependency in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless'):run('docker','image','inspect',dependency)
    free=run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',image,'-Pk','/')
    assert int(free.splitlines()[-1].split()[3])>=2*1024*1024,'Require2GiB Docker reserve'
    foreign=run('docker','ps','-aq')
    record(helperCheckoutRevision=run('git','rev-parse','HEAD'),runtimeSourceRevision=args.source_revision)
    project='golf-rules49-'+secrets.token_hex(5); ports=helpers.free_ports(3)
    previous=smoke.GOLF,smoke.GITEA;smoke.GOLF,smoke.GITEA='http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1])
    actors,enrolled,bearers,repositories,orgs={},[],[],{},{}
    bootstrap=project+'-bootstrap';bootstrap_created=False;started=False;passed=False
    record(project=project,proofKind='environments055',selectedImage=image,sourceRevision=args.source_revision)
    with native_proxy.NativeProxy(ports[2],project) as proxy,tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory=Path(temporary);directory.chmod(0o700);rules.ACTIVE_PROXY=proxy
        values={k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        env_file,override,proxy_file=directory/'proof.env',directory/'proof.yaml',directory/'proxy.json'
        helpers.private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()))
        helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
    environment:
      GITEA_URL: http://native-qualification-proxy:8081
  gitea:
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__server__DISABLE_SSH: "true"
      GITEA__server__START_SSH_SERVER: "false"
''')
        environment.update(proxy.environment())
        helpers.private_write(proxy_file,json.dumps({'services':{native_proxy.SERVICE_NAME:proxy.compose_service(image,binary),'golf':{'depends_on':{native_proxy.SERVICE_NAME:{'condition':'service_started'}}}}}))
        compose=['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(stack/'compose.yaml'),'-f',str(override),'-f',str(proxy_file)]
        def command(*arguments,**kwargs):return run(*compose,*arguments,**kwargs)
        def admin(*arguments):return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        def operator(action,payload):
            result=json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account',action,payload=payload));assert result['state']=='complete';return result['result']
        native,rpc=rules.native,rules.rpc
        def runtime():
            cid=command('ps','-q','golf');assert re.fullmatch(r'[a-f0-9]{12,64}',cid)
            result=json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}',cid))
            assert result['image']==image and result['reference']==image and result['revision']==args.source_revision and result['project']==project
            result['nativeVersion']=native('','GET','version')['version'];assert result['nativeVersion']=='1.27.3';return result
        def access(actor,key):
            observed=rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':key})['access']
            assert decimal(observed['repositoryId']) and decimal(observed['ownerId']) and re.fullmatch(r'[a-f0-9]{64}',observed['revision'])
            independent=native(actor['token'],'GET','repos/'+key['owner']+'/'+key['name'])
            assert str(independent['id'])==observed['repositoryId'] and str(independent['owner']['id'])==observed['ownerId'] and independent['full_name']==key['owner']+'/'+key['name']
            return dict(repository=key,repositoryId=observed['repositoryId'],ownerId=observed['ownerId'],accessRevision=observed['revision'])
        def create(name,org=None):
            row=native(actors['owner']['token'],'POST','orgs/'+org+'/repos' if org else 'user/repos',{'name':name,'private':True,'auto_init':True,'default_branch':'main'},201)
            repositories[row['full_name']]=(row['id'],row['owner']['id']);smoke.wait_for_push(actors['owner']['token'],row['full_name'])
            return {'owner':row['owner']['login'],'name':row['name']}
        def intent(actor,target,name,version='0',environment_id=None,policy=None):
            return dict(target=target,environmentId=environment_id or str(uuid.uuid4()),expectedVersion=version,name=name,policy=copy.deepcopy(policy or POLICY),operationId=str(uuid.uuid4()),currentPassword=actor['password'])
        def inventory(actor,target):
            rows=[];total=None
            for page in range(1,102):
                result=rpc(actor['session'],SERVICE+'ListRepositoryEnvironments',{'target':target,'page':{'page':page,'limit':1}})
                assert result['target']==target and result['capability']==CAPABILITY and result.get('deploymentAvailable',False) is False and decimal(result['totalCount'],False)
                if total is None:total=int(result['totalCount']);assert total<=100
                assert int(result['totalCount'])==total
                part=result.get('environments',[]);assert len(part)<=1
                for row in part:
                    assert row['target']['repositoryId']==target['repositoryId'] and row['target']['ownerId']==target['ownerId'] and not row.get('deleted',False)
                    assert row['capability']==CAPABILITY and row.get('deploymentAvailable',False) is False
                rows.extend(part);next_page=result.get('page',{}).get('nextPage',0)
                if not next_page:
                    assert len(rows)==total and len({row['id'] for row in rows})==total;return rows
                assert part and next_page==page+1
            raise AssertionError('Inventory pagination exceeded100bounded rows')
        def inspect(actor,request,result):
            observed=rpc(actor['session'],SERVICE+'GetRepositoryEnvironmentOperation',{'target':request['target'],'operationId':request['operationId']})
            assert observed==result;return observed
        def change(actor,request,action='SAVE',prior=None):
            result=rpc(actor['session'],SERVICE+('SaveRepositoryEnvironment' if action=='SAVE' else 'DeleteRepositoryEnvironment'),request)
            receipt(result,request,actor,action,prior)
            assert rpc(actor['session'],SERVICE+('SaveRepositoryEnvironment' if action=='SAVE' else 'DeleteRepositoryEnvironment'),request)==result
            inspect(actor,request,result);return result
        def counts(target):
            repo_id=target['repositoryId'];owner_id=target['ownerId'];assert decimal(repo_id) and decimal(owner_id)
            # Golf metadata only. Never inspect policy bytea, credentials or nativeSQL.
            query="SELECT json_build_object('versions',count(*),'operations',(SELECT count(*) FROM golf_repository_environment_operations WHERE forge_url='http://native-qualification-proxy:8081' AND repository_id="+repo_id+" AND owner_id="+owner_id+"),'creatorNativeIds',array_agg(DISTINCT creator_native_id ORDER BY creator_native_id),'updaterNativeIds',array_agg(DISTINCT actor_native_id ORDER BY actor_native_id)) FROM golf_repository_environment_versions WHERE forge_url='http://native-qualification-proxy:8081' AND repository_id="+repo_id+" AND owner_id="+owner_id
            value=json.loads(command('exec','-T','postgres','psql','-U','postgres','-d','golf','-At','-v','ON_ERROR_STOP=1','-c',query))
            assert type(value['versions']) is int and value['versions']==value['operations']
            for field in ('creatorNativeIds','updaterNativeIds'):
                assert all(str(identifier) in {actor['id'] for actor in actors.values() if 'id' in actor} for identifier in value[field] or [])
            return value
        def boundaries(actor,target,saved):
            return [(SERVICE+'ListRepositoryEnvironments',{'target':target}),(SERVICE+'SaveRepositoryEnvironment',intent(actor,target,'Denied')),(SERVICE+'DeleteRepositoryEnvironment',{'target':target,'environmentId':saved['environment']['id'],'expectedVersion':saved['environment']['version'],'operationId':str(uuid.uuid4()),'currentPassword':actor['password']}),(SERVICE+'GetRepositoryEnvironmentOperation',{'target':target,'operationId':saved['operation']['operationId']})]
        try:
            stage('fresh pinned base stack and internal-only proxy');started=True;record(cleanup='pending')
            command('up','-d','--no-build','--pull','never',timeout=180);proxy.ready();smoke.ready()
            rendered=json.loads(command('config','--format','json'));assert set(rendered['services'])=={'golf','gitea','postgres',native_proxy.SERVICE_NAME}
            assert not rendered['services']['postgres'].get('ports') and all(binding['host_ip']=='127.0.0.1' for service in rendered['services'].values() for binding in service.get('ports',[]))
            proxy_runtime=rules.verify_proxy_runtime(run,command,proxy,binary,binary_sha,image,args.source_revision);baseline=rules.checked_startup_proxy(proxy.snapshot(),project)
            before=runtime();record(runtime=before,proxyRuntime=proxy_runtime)
            stage('unmanaged bootstrap then ordinary native actors and local Golfsessions')
            admin('create','--username',bootstrap,'--email',bootstrap+'@example.invalid','--random-password','--must-change-password=false','--admin');bootstrap_created=True
            for role in ('owner','direct','memberdirect','team','reader','global','outsider'):
                actor={'role':role,'name':project+'-'+role,'created':False,'loggedIn':False,'session':smoke.client()};actors[role]=actor
                options=['create','--username',actor['name'],'--email',actor['name']+'@example.invalid','--random-password','--must-change-password=false']
                if role=='global':options.append('--admin')
                admin(*options);actor['created']=True
                actor['token']=admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw')
                identity=native(actor['token'],'GET','user');assert identity['login']==actor['name'] and identity['is_admin'] is (role=='global')
                actor.update(id=str(identity['id']),email=actor['name']+'@golf.invalid',password='Environment fixture '+secrets.token_urlsafe(24));enrolled.append(actor)
                operator('create',{'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='global'})
                identity=rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert identity['id']==actor['id'];actor['loggedIn']=True
            owner=actors['owner'];personal=create('environments');path='repos/'+personal['owner']+'/'+personal['name']
            for role,permission in (('direct','admin'),('reader','read'),('global','read')):native(owner['token'],'PUT',path+'/collaborators/'+actors[role]['name'],{'permission':permission},204)
            target=access(owner,personal);assert inventory(owner,target)==[]
            stage('two saved configs, complete pagination, wrongpassword no effect and exact replay')
            first=intent(owner,target,'Alpha ü');rpc(owner['session'],SERVICE+'SaveRepositoryEnvironment',{**first,'currentPassword':'wrong fixture password'},403,'permission_denied')
            assert counts(target)['versions']==0
            accepted=change(owner,first);second=intent(owner,target,'Beta');second_saved=change(owner,second)
            assert [row['id'] for row in inventory(owner,target)]==[first['environmentId'],second['environmentId']]
            initial_counts=counts(target);assert initial_counts['versions']==2
            for field,value in (('repositoryId','9223372036854775807'),('ownerId','9223372036854775807'),('accessRevision','0'*64)):
                rpc(owner['session'],SERVICE+'ListRepositoryEnvironments',{'target':{**target,field:value}},400,'failed_precondition')
            changed={**first,'name':'Changed original'};rpc(owner['session'],SERVICE+'SaveRepositoryEnvironment',changed,400,'failed_precondition');assert counts(target)==initial_counts
            stage('independent direct-admin edit and creator CAS')
            direct=actors['direct'];direct_target=access(direct,personal)
            edit=intent(direct,direct_target,'Alpha edited','1',first['environmentId'],{**POLICY,'waitSeconds':60})
            edited=change(direct,edit,prior=accepted['environment'])
            stale=intent(owner,target,'Stale edit','1',first['environmentId']);rpc(owner['session'],SERVICE+'SaveRepositoryEnvironment',stale,409,'aborted')
            inspect(owner,first,accepted);assert rpc(owner['session'],SERVICE+'SaveRepositoryEnvironment',first)==accepted
            # Original operation ownership is never conferred by current repo administration.
            rpc(owner['session'],SERVICE+'GetRepositoryEnvironmentOperation',{'target':target,'operationId':edit['operationId']},404,'not_found')
            stage('actual requested browser editors/lost acknowledgement/original status')
            if args.ui:
                out=OUTPUT/'browser';out.mkdir(mode=0o700);pre_ui_counts=counts(target)
                config=dict(golf=smoke.GOLF,repository=personal['owner']+'/'+personal['name'],target=target,email=owner['email'],password=owner['password'],actorId=owner['id'],runtime=before,output=str(out),stackRoot=str(stack),readerEmail=actors['reader']['email'],readerPassword=actors['reader']['password'],readerLogin=actors['reader']['name'])
                browser=subprocess.run(['node',str(stack/'scripts/repository-environments-ui-smoke.mjs')],cwd=stack,env=environment,input=json.dumps(config).encode(),capture_output=True,timeout=300)
                assert browser.returncode==0 and len(browser.stdout)<=1<<20 and len(browser.stderr)<=1<<20,'Actual browser failed; private output withheld'
                ui=json.loads((out/'browser-manifest.json').read_text());assert ui['status']=='browser_checks_passed_parent_cleanup_pending' and len(ui['captures'])==12 and ui['runtime']==before
                record(browser='passed_parent_cleanup_pending',browserManifest=str(out/'browser-manifest.json'))
                assert counts(target)['versions']-pre_ui_counts['versions']==13,'Nine actual UI Saves and four Deletes must commit exactly13 versions/receipts'
                assert len(inventory(owner,target))==2
            stage('retained tombstone deletion, historical own receipts and UUID ABA refusal')
            deletion={'target':direct_target,'environmentId':first['environmentId'],'expectedVersion':'2','operationId':str(uuid.uuid4()),'currentPassword':direct['password']}
            removed=change(direct,deletion,'DELETE',edited['environment']);assert len(inventory(owner,target))==1
            inspect(direct,edit,edited);inspect(owner,first,accepted)
            recreated=intent(owner,target,'Alpha recreated','0',first['environmentId']);rpc(owner['session'],SERVICE+'SaveRepositoryEnvironment',recreated,409,'aborted')
            rpc(direct['session'],SERVICE+'SaveRepositoryEnvironment',intent(direct,direct_target,'Tombstone edit','3',first['environmentId']),409,'aborted')
            stage('reader/globaladmin/outsider never gain ordinary environment authority')
            for role in ('reader','global','outsider'):
                denied=actors[role];expected=404 if role=='outsider' else 403
                denied_target=target if role=='outsider' else access(denied,personal)
                for procedure,payload in boundaries(denied,denied_target,second_saved):rpc(denied['session'],procedure,payload,expected,'not_found' if expected==404 else 'permission_denied')
            stage('organization owner/member-directadmin versus inherited teamadmin')
            org_name=project+'-org';org=native(owner['token'],'POST','orgs',{'username':org_name,'visibility':'private'},201);orgs[org_name]=org['id'];organization=create('environments',org_name);org_path='repos/'+org_name+'/environments'
            for role,permission in (('memberdirect','read'),('team','admin')):
                team=native(owner['token'],'POST','orgs/'+org_name+'/teams',{'name':role,'permission':permission,'units_map':{'repo.code':permission},'includes_all_repositories':False,'visibility':'limited'},201)
                native(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+org_name+'/environments',expected=204)
                native(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+actors[role]['name'],expected=204)
            native(owner['token'],'PUT',org_path+'/collaborators/'+actors['memberdirect']['name'],{'permission':'admin'},204)
            org_target=access(owner,organization);org_request=intent(owner,org_target,'Org config');org_saved=change(owner,org_request)
            member=actors['memberdirect'];member_target=access(member,organization);member_edit=intent(member,member_target,'Org edit','1',org_request['environmentId'])
            member_saved=change(member,member_edit,prior=org_saved['environment']);assert len(inventory(member,member_target))==1
            for procedure,payload in boundaries(actors['team'],access(actors['team'],organization),member_saved):rpc(actors['team']['session'],procedure,payload,403,'permission_denied')
            stage('native role loss refuses read/mutate/status and retains exact history')
            baseline_counts=counts(target);native(owner['token'],'PUT',path+'/collaborators/'+direct['name'],{'permission':'read'},204)
            for procedure,payload in boundaries(direct,direct_target,removed):rpc(direct['session'],procedure,payload,403,'permission_denied')
            assert counts(target)==baseline_counts
            stage('stale native namespace and replacement IDs are never adopted')
            renamed=native(owner['token'],'PATCH',path,{'name':'environments-renamed'});assert str(renamed['id'])==target['repositoryId']
            repositories.pop(personal['owner']+'/'+personal['name']);repositories[renamed['full_name']]=(renamed['id'],renamed['owner']['id'])
            replacement=create('environments');replacement_target=access(owner,replacement);assert replacement_target['repositoryId']!=target['repositoryId'] and inventory(owner,replacement_target)==[]
            for procedure,payload in boundaries(owner,target,second_saved):rpc(owner['session'],procedure,payload,400,'failed_precondition')
            stage('allfour Origin/bearer/logout boundaries')
            clean=intent(owner,replacement_target,'Fresh boundary');fresh=change(owner,clean)
            credential=rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Environment boundary'});bearers.append((owner,credential['credential']['id']))
            for procedure,payload in boundaries(owner,replacement_target,fresh):
                rpc(owner['session'],procedure,payload,headers={'Origin':'https://other.invalid'},expected=403,code='permission_denied')
                rpc(smoke.client(),procedure,payload,headers={'Authorization':'Bearer '+credential['token']},expected=403,code='permission_denied')
            rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']});bearers.clear()
            rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False
            for procedure,payload in boundaries(owner,replacement_target,fresh):rpc(owner['session'],procedure,payload,401,'unauthenticated')
            record(configurationApi='passed',originalReplayTombstoneCas='passed',ordinaryAuthorityBoundaries='passed',metadataCounts={'personal':counts(target),'organization':counts(org_target),'replacement':counts(replacement_target)})
            assert runtime()==before and rules.verify_proxy_runtime(run,command,proxy,binary,binary_sha,image,args.source_revision)==proxy_runtime
            state=rules.checked_proxy_progress(proxy.snapshot(),baseline,project);assert state['counts']==[] and state['lost']==0,'Environment config must not dispatch native mutations'
            record(runtimeUnchanged=True,nativeMutationDispatches=0);passed=True
        except Exception as error:
            frame=next((row for row in reversed(traceback.extract_tb(error.__traceback__)) if row.filename==__file__),traceback.extract_tb(error.__traceback__)[-1])
            record(failedStage=STAGE,originalFailureType=type(error).__name__,originalFailureLine=frame.lineno);raise
        finally:
            failures=[]
            for actor,cid in bearers:
                try:rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':cid})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try:rpc(actor['session'],'SessionService/RevokeOtherSessions');rpc(actor['session'],'SessionService/Logout')
                    except Exception:failures.append('session')
            for actor in reversed(enrolled):
                try:assert operator('disable',{'username':actor['name']})['disabled']
                except Exception:failures.append('managed disable')
            for fullname,(repo_id,owner_id) in reversed(list(repositories.items())):
                try:
                    row=native(actors['owner']['token'],'GET','repos/'+fullname);assert (row['id'],row['owner']['id'])==(repo_id,owner_id)
                    native(actors['owner']['token'],'DELETE','repos/'+fullname,expected=204);native(actors['owner']['token'],'GET','repos/'+fullname,expected=404)
                except Exception:failures.append('owned native repo')
            for name,org_id in orgs.items():
                try:assert native(actors['owner']['token'],'GET','orgs/'+name)['id']==org_id;native(actors['owner']['token'],'DELETE','orgs/'+name,expected=204)
                except Exception:failures.append('owned native org')
            for actor in reversed(list(actors.values())):
                if actor['created']:
                    try:
                        row=native(actor.get('token',''),'GET','users/'+actor['name']);assert row['login']==actor['name'] and ('id' not in actor or str(row['id'])==actor['id'])
                        admin('delete','--username',actor['name'],'--purge');native('','GET','users/'+actor['name'],expected=404)
                    except Exception:failures.append('owned native actor')
            if bootstrap_created:
                try:admin('delete','--username',bootstrap,'--purge')
                except Exception:failures.append('bootstrap')
            try:proxy.close()
            except Exception:failures.append('owned proxy')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')):assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
                    assert run('docker','ps','-aq')==foreign,'Foreign container identities changed during fixture'
            except Exception:failures.append('fresh resource cleanup or foreign identity')
            rules.ACTIVE_PROXY=None;smoke.GOLF,smoke.GITEA=previous
            record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=sorted(set(failures)),originalFailurePreserved=bool(PROOF.get('failedStage')),status='qualified' if passed and not failures else 'failed')
            if failures and passed:raise AssertionError('Owned cleanup incomplete')
            print('Cleanup: owned native actors/repos/organization purged, Golfsessions/bearers revoked/accounts disabled, fresh resources removed; isolated metadata discarded with owned Golfvolume.',flush=True)
    if passed:print('PASS: actual configuration-only055 API/authority/original receipts and fresh cleanup; no deployment readiness claim',flush=True)


if __name__=='__main__':
    def interrupted(_signum,_frame):raise RuntimeError('Owned qualifier interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:main()
    except Exception as error:
        record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureType=type(error).__name__)
        print('Environment qualifier failed at '+PROOF.get('failedStage',STAGE)+'; '+type(error).__name__+'; private diagnostics withheld',file=sys.stderr);sys.exit(1)
