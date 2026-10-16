#!/usr/bin/env python3
"""Prepared disposable repository-team native qualification (not proof until run).

--image selects an already-built local Golf image for a fresh base Compose stack.
No retained stack, CI overlay, runner, inference, provider credentials or policy
changes are used. Native/API actors and managed Golf accounts are disposable;
all project resources are removed on exit. --output must be a new owner-only
evidence directory; --ui adds 12 real browser captures. --self-check performs
no operations. This qualifies bounded existing-team associations, not invitations, custom roles,
team-global permission editing or atomic native compare-and-swap.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import traceback

sys.dont_write_bytecode = True
import smoke
import uuid
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryTeamAccessService/'
STAGE = 'arguments'
OUTPUT = None
NATIVE_SOURCES = ['https://codeberg.org/forgejo/forgejo/raw/tag/v15.0.9/'+path for path in ('routers/api/v1/repo/teams.go', 'routers/api/v1/org/team.go', 'routers/api/v1/api.go', 'modules/structs/org_team.go', 'models/organization/org.go')]
PROOF = {'status':'not_started', 'nativeSources':NATIVE_SOURCES, 'scope':'Disposable organization repository existing-team associations only; no atomic CAS, invitations, custom roles, CI or full Access readiness', 'cleanup':'not_started', 'captures':[]}


def record(**values):
    PROOF.update(values)
    if OUTPUT is not None:
        temporary = OUTPUT/'manifest.json.tmp'
        with temporary.open('w', encoding='utf-8') as stream:
            temporary.chmod(0o600)
            json.dump(PROOF, stream, indent=2, sort_keys=True); stream.write('\n')
        temporary.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value
    record(stage=value)
    print('CHECK: '+value, flush=True)


def checked_rpc(session, procedure, payload=None, expected=200, headers=None, code=None):
    """One dispatch; persist only procedure/status/code, never bodies or messages."""
    import urllib.error
    import urllib.request
    assert re.fullmatch(r'[A-Za-z]+Service/[A-Za-z]+',procedure)
    request=urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure, data=json.dumps({} if payload is None else payload).encode(), method='POST', headers={'Origin':smoke.GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(headers or {})})
    try:response=session.open(request,timeout=15)
    except urllib.error.HTTPError as error:response=error
    except (urllib.error.URLError,OSError) as error:
        record(lastProcedure={'procedure':procedure,'status':None,'transportFailure':type(error).__name__})
        raise RuntimeError('RPC transport unavailable; safe metadata recorded') from None
    with response:
        raw=response.read((1<<20)+1)
        metadata={'procedure':procedure,'status':response.status,'noStore':response.headers.get('Cache-Control')=='no-store'}
        result=None
        if len(raw)<=1<<20:
            try:result=json.loads(raw) if raw else None
            except (ValueError,UnicodeError):pass
        if isinstance(result,dict) and isinstance(result.get('code'),str) and re.fullmatch(r'[a-z_]{1,64}',result['code']):metadata['code']=result['code']
        observations=PROOF.get('procedureObservations',[])
        assert len(observations)<256
        observations.append(metadata);record(lastProcedure=metadata,procedureObservations=observations)
        assert len(raw)<=1<<20 and response.status==expected and metadata['noStore'],'RPC status/protocol mismatch; safe procedure metadata recorded'
        if expected!=200:
            codes={400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found',429:'resource_exhausted',503:'unavailable'}
            assert isinstance(result,dict) and result.get('code')==(code or codes[expected]) and result.get('message'),'RPC error code mismatch; safe procedure metadata recorded'
        return result


def native_team(row):
    assert type(row['id']) is int and row['id'] > 0
    assert type(row['includes_all_repositories']) is bool
    assert isinstance(row['units_map'], dict)
    allowed = {'none','read','write','admin','owner'}
    assert row['permission'] in allowed and row['visibility'] in {'public','limited','private'}
    assert isinstance(row['name'], str) and row['name'].strip() and isinstance(row['description'], str)
    assert all(k.startswith('repo.') and v in allowed for k,v in row['units_map'].items())
    return row


def team_configuration(row):
    row = native_team(row)
    return {key:row[key] for key in ('id','name','description','permission','units_map','visibility','includes_all_repositories')}


def associations(token, repository, organization_id):
    import urllib.request
    request = urllib.request.Request(smoke.FORGE+'/api/v1/repos/'+repository+'/teams', headers={'Authorization':'token '+token})
    with smoke.client().open(request, timeout=15) as response:
        assert response.status == 200 and not response.headers.get('Link')
        raw = response.read((1<<20)+1); assert len(raw) <= 1<<20
        rows = json.loads(raw); assert isinstance(rows,list) and len(rows) <= 500
        ids = set()
        for row in rows:
            native_team(row); assert row['id'] not in ids; ids.add(row['id'])
            if row.get('organization') is not None: assert row['organization']['id'] == organization_id
        return ids


def wire_receipt(value, target):
    assert value['repositoryId'] == target['repositoryId'] and value['ownerId'] == target['ownerId'] and value['accessRevision'] == target['expectedRevision']
    assert re.fullmatch(r'[0-9a-f]{64}', value['accessRevision'])
    return value


def self_check():
    global OUTPUT, PROOF
    source = (ROOT/'api/golf/v1/golf.proto').read_text()
    for method in ('ListRepositoryTeamAccess','AttachRepositoryTeam','DetachRepositoryTeam'):
        assert 'rpc '+method+'(' in source
    for message, fields in {'RepositoryTeamAccess':[('OrganizationTeam','team',1),('bool','attached',2),('bool','can_attach',4),('string','revision',6)],'ListRepositoryTeamAccessRequest':[('string','repository_id',2),('string','owner_id',3),('string','expected_revision',4)],'AttachRepositoryTeamRequest':[('string','team_id',5),('string','expected_team_revision',6)],'DetachRepositoryTeamRequest':[('string','team_id',5),('string','expected_team_revision',6)]}.items():
        body = re.search(r'message '+message+r'\s*\{([^}]+)\}', source).group(1)
        for kind,name,tag in fields: assert re.search(re.escape(kind)+r'\s+'+name+r'\s*=\s*'+str(tag)+r'\s*;',body)
    row={'id':7,'includes_all_repositories':False,'units_map':{'repo.code':'read'},'permission':'write','visibility':'limited','name':'Builders','description':''}
    assert team_configuration(row)['includes_all_repositories'] is False
    for mutate in (lambda r:r.pop('includes_all_repositories'),lambda r:r.update(includes_all_repositories=None),lambda r:r.pop('units_map'),lambda r:r.update(units_map=None),lambda r:r.update(permission=''),lambda r:r.update(visibility='unknown')):
        broken=json.loads(json.dumps(row));mutate(broken)
        try: native_team(broken)
        except (AssertionError,KeyError,TypeError): pass
        else: raise AssertionError('Unknown native field accepted')
    target={'repositoryId':'7','ownerId':'9','expectedRevision':'a'*64}
    wire_receipt({'repositoryId':'7','ownerId':'9','accessRevision':'a'*64},target)
    try: wire_receipt({'repositoryId':'8','ownerId':'9','accessRevision':'a'*64},target)
    except AssertionError: pass
    else: raise AssertionError('Wrong immutable receipt accepted')
    prior_output,prior_proof=OUTPUT,PROOF
    try:
        with tempfile.TemporaryDirectory(prefix='golf-team-access-pure-') as temporary:
            OUTPUT=Path(temporary);OUTPUT.chmod(0o700);PROOF={}
            record(status='failed',failedStage='initial predicate',cleanup='passed')
            import io
            class FakeResponse(io.BytesIO):
                status=400
                headers={'Cache-Control':'no-store'}
            class FakeSession:
                def open(self,request,timeout):
                    assert request.method=='POST' and timeout==15
                    return FakeResponse(json.dumps({'code':'failed_precondition','message':'PRIVATE_MESSAGE_SENTINEL'}).encode())
            result=checked_rpc(FakeSession(),'RepositoryAccessService/GetRepositoryAccess',{},expected=400,code='failed_precondition')
            assert result['code']=='failed_precondition' and PROOF['lastProcedure']=={'procedure':'RepositoryAccessService/GetRepositoryAccess','status':400,'noStore':True,'code':'failed_precondition'}
            assert 'PRIVATE_MESSAGE_SENTINEL' not in (OUTPUT/'manifest.json').read_text()
            try:checked_rpc(FakeSession(),'RepositoryAccessService/GetRepositoryAccess',{})
            except AssertionError:pass
            else:raise AssertionError('Unexpected status was weakened')
            assert json.loads((OUTPUT/'manifest.json').read_text())['failedStage']=='initial predicate'
            assert OUTPUT.stat().st_mode&0o777==0o700 and (OUTPUT/'manifest.json').stat().st_mode&0o777==0o600
    finally: OUTPUT,PROOF=prior_output,prior_proof
    print('PASS: pure team-access wire/presence/identity/failure-provenance checks; no Docker, HTTP, native or runtime operations executed')


def main():
    global OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--image', help='Explicit already-built Golf image; resolved once, never built/pulled')
    parser.add_argument('--output', type=Path, help='New evidence directory, created mode 0700; safe manifests/captures only')
    parser.add_argument('--ui', action='store_true', help='Include actual browser association/readback/reload proof and 12 captures')
    args = parser.parse_args()
    if args.self_check:
        self_check(); return
    if not args.image or not args.output:
        parser.error('--image and --output are required for a fresh isolated qualification')
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700); args.output.chmod(0o700); OUTPUT = args.output.resolve(strict=True)
    record(status='running', browser='pending' if args.ui else 'not_requested')
    if args.ui:
        stage('local browser dependency, no installation')
        assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    spec = importlib.util.spec_from_file_location('team_access_helpers', ROOT/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_', 'FORGEJO_', 'POSTGRES_', 'COMPOSE_', 'OTEL_', 'AWS_', 'RUSTFS_')) and key != 'DATABASE_URL'}
    def run(*arguments, payload=None, timeout=180):
        result = subprocess.run(arguments, cwd=ROOT, env=environment, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact local image and pinned base dependencies')
    inspected = json.loads(run('docker', 'image', 'inspect', args.image))[0]
    image, revision = inspected['Id'], inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image) and re.fullmatch(r'[0-9a-f]{40}', revision or ''), 'Require explicitly revision-labeled product image'
    # Fail before creating anything rather than pulling or consuming retained disk.
    for name in ('postgres:18.4-alpine3.24', 'codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'):
        run('docker', 'image', 'inspect', name)
    space = run('docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/df', image, '-Pk', '/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB free Docker VM space before fresh stack'
    project = 'golf-team-access-proof-'+secrets.token_hex(5)
    ports = helpers.free_ports(2); previous = smoke.GOLF, smoke.FORGE
    smoke.GOLF, smoke.FORGE = 'http://127.0.0.1:'+str(ports[0]), 'http://127.0.0.1:'+str(ports[1])
    actors, enrolled, bearers, organizations, repositories, started, passed = {}, [], [], {}, {}, False, False
    record(project=project, selectedImage=image, sourceRevision=revision, cleanup='not_created')
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {key:secrets.token_hex(24) for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'FORGEJO_DB_PASSWORD')} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF, GOLF_PUSH_CI_ENABLED='false')
        env_file, override = directory/'core.env', directory/'proof.yaml'
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file), '-f', str(ROOT/'compose.yaml'), '-f', str(override)]
        def command(*arguments, **kwargs): return run(*compose, *arguments, **kwargs)
        def admin(*arguments): return command('exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *arguments)  # Forgejo's upstream path
        def operator(action, payload):
            result = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
            assert result['state'] == 'complete'; return result['result']
        def runtime():
            container = command('ps', '-q', 'golf'); assert re.fullmatch(r'[0-9a-f]{12,64}', container)
            observed = json.loads(run('docker', 'inspect', '--format', '{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}', container))
            assert observed['image'] == image and observed['reference'] == image and observed['revision'] == revision
            observed['nativeVersion'] = smoke.request(smoke.client(), 'GET', smoke.FORGE+'/api/v1/version')['version']; assert observed['nativeVersion'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
            return observed
        def call(actor, method, payload, **kwargs): return checked_rpc(actor['session'], SERVICE+method, payload, **kwargs)
        try:
            stage('fresh base stack, CI and agents unconfigured')
            record(cleanup='pending'); started = True; command('up', '-d', '--no-build', '--pull', 'never', timeout=180); smoke.ready(); before_runtime = runtime()
            record(runtime=before_runtime)
            print('Runtime provenance: '+json.dumps(before_runtime, sort_keys=True), flush=True)
            stage('disposable native ordinary actors and managed password sessions')
            for role in ('owner','member','admin','nonmember','outsider','golfadmin'):
                name=project+'-'+role; actor={'role':role,'name':name,'created':False,'session':smoke.client(),'loggedIn':False}; actors[role]=actor
                admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw')
                user=smoke.provider(actor['token'],'GET','user');assert not user['is_admin']
                actor.update(id=str(user['id']),email=name+'@golf.invalid',password='Team fixture '+secrets.token_urlsafe(24));enrolled.append(actor)
                operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='golfadmin'})
                user=checked_rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert user['id']==actor['id'] and user.get('isInstanceAdmin',False)==(role=='golfadmin');actor['loggedIn']=True
            owner,member,member_admin,nonmember,outsider,golfadmin=(actors[k] for k in ('owner','member','admin','nonmember','outsider','golfadmin'))
            stage('supported private organization, exact repository and native strict team fields')
            organization=project+'-org';org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},201);organizations[organization]=org['id']
            other_org=project+'-other';foreign_org=smoke.provider(owner['token'],'POST','orgs',{'username':other_org,'visibility':'private'},201);organizations[other_org]=foreign_org['id']
            native=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos',{'name':'team-access','private':True,'auto_init':True},201);repositories[native['full_name']]=native['id'];smoke.wait_for_push(owner['token'],native['full_name'])
            repository={'owner':organization,'name':'team-access'};path='repos/'+native['full_name'];repo_id=str(native['id']);org_id=str(org['id'])
            assert str(native['owner']['id'])==org_id
            def create_team(name, permission='read', all_repos=False, organization_name=organization):
                row=smoke.provider(owner['token'],'POST','orgs/'+organization_name+'/teams',{'name':name,'description':'Association fixture','permission':permission,'visibility':'limited','units_map':{'repo.code':permission},'includes_all_repositories':all_repos},201)
                native_team(row);assert row['includes_all_repositories'] is all_repos;return row
            reader_team=create_team('Readers');admin_team=create_team('Administrators','admin');builders=create_team('Builders','write');all_team=create_team('Inherited','read',True);foreign=create_team('Foreign',organization_name=other_org)
            for team,actor in ((reader_team,member),(reader_team,owner),(admin_team,member_admin)):
                smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/members/'+actor['name'],expected=204)
            for team in (reader_team,admin_team):smoke.provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+native['full_name'],expected=204)
            smoke.provider(owner['token'],'PUT',path+'/collaborators/'+nonmember['name'],{'permission':'admin'},204)
            native_teams=smoke.provider(owner['token'],'GET','orgs/'+organization+'/teams');assert isinstance(native_teams,list)
            for row in native_teams:native_team(row)
            owners=next(row for row in native_teams if row['permission']=='owner');owner_team_id=str(owners['id'])
            original_config=team_configuration(smoke.provider(owner['token'],'GET','teams/'+str(builders['id'])))
            assert int(builders['id']) not in associations(owner['token'],native['full_name'],int(org_id))
            record(nativeStrictFields='observed_present',nativeAssociations='bounded_unpaged_supported_collection')
            def access(actor=owner):
                stage('exact repository access observation · '+actor['role'])
                value=checked_rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
                assert value['repositoryId']==repo_id and value['ownerId']==org_id and value['organizationOwned'];assert re.fullmatch(r'[0-9a-f]{64}',value['revision']);return value
            def target(value):return {'repository':repository,'repositoryId':value['repositoryId'],'ownerId':value['ownerId'],'expectedRevision':value['revision']}
            def inspect(actor=owner):
                selected=target(access(actor));value=wire_receipt(call(actor,'ListRepositoryTeamAccess',{**selected,'page':{'page':1,'limit':20}}),selected)
                assert value.get('page',{}).get('nextPage',0)==0 and len(value['teams'])<=20
                assert len({row['team']['id'] for row in value['teams']})==len(value['teams'])
                associated=associations(owner['token'],native['full_name'],int(org_id))
                for row in value['teams']:
                    team=smoke.provider(owner['token'],'GET','teams/'+row['team']['id']);native_team(team)
                    assert team['organization']['id']==int(org_id) and team['organization']['name']==organization
                    assert row.get('attached',False)==(int(row['team']['id']) in associated) and re.fullmatch(r'[0-9a-f]{64}',row['revision'])
                    assert row['team'].get('includesAllRepositories',False) is team['includes_all_repositories']
                return selected,value
            def selected_row(value,team_id=str(builders['id'])):return next(row for row in value['teams'] if row['team']['id']==team_id)
            def mutation_target(selected,row):return {**selected,'teamId':row['team']['id'],'expectedTeamRevision':row['revision']}
            def mutation(method,actor,selected,row):
                before_config=team_configuration(smoke.provider(owner['token'],'GET','teams/'+row['team']['id']))
                response=wire_receipt(call(actor,method,mutation_target(selected,row)),selected)
                observed=response['team'];wanted=method=='AttachRepositoryTeam';assert observed['team']['id']==row['team']['id'] and observed.get('attached',False)==wanted and observed['revision']!=row['revision']
                assert team_configuration(smoke.provider(owner['token'],'GET','teams/'+row['team']['id']))==before_config
                assert (int(row['team']['id']) in associations(owner['token'],native['full_name'],int(org_id)))==wanted
                return response
            stage('member, member-admin, direct nonmember admin, outsider and Golf-admin boundaries')
            owner_target,inventory=inspect();assert inventory['canManage']
            for actor in (member,member_admin):
                current,readonly=inspect(actor);assert not readonly.get('canManage',False) and all(not r.get('canAttach',False) and not r.get('canDetach',False) for r in readonly['teams'])
                row=selected_row(readonly);call(actor,'AttachRepositoryTeam',mutation_target(current,row),expected=403)
            stage('native direct admin does not bypass private organization membership')
            nonmember_native=smoke.provider(nonmember['token'],'GET',path)
            assert str(nonmember_native['id'])==repo_id and str(nonmember_native['owner']['id'])==org_id and nonmember_native['permissions']['admin'] is True
            smoke.provider(owner['token'],'GET','orgs/'+organization+'/members/'+nonmember['name'],expected=404)
            checked_rpc(nonmember['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository},expected=404)
            call(nonmember,'ListRepositoryTeamAccess',{**owner_target,'page':{'page':1,'limit':20}},expected=404)
            for actor in (outsider,golfadmin):call(actor,'ListRepositoryTeamAccess',{**owner_target,'page':{'page':1,'limit':20}},expected=404)
            stage('owner and inherited-all protections, foreign IDs and stale revision no effects')
            for protected_id in (owner_team_id,str(all_team['id'])):
                row=selected_row(inventory,protected_id);assert not row.get('canAttach',False) and not row.get('canDetach',False)
                for method in ('AttachRepositoryTeam','DetachRepositoryTeam'):call(owner,method,mutation_target(owner_target,row),expected=403)
            row=selected_row(inventory);before=associations(owner['token'],native['full_name'],int(org_id))
            call(owner,'AttachRepositoryTeam',{**mutation_target(owner_target,row),'teamId':str(foreign['id'])},expected=404)
            for key in ('repositoryId','ownerId'):
                call(owner,'AttachRepositoryTeam',{**mutation_target(owner_target,row),key:'9223372036854775807'},expected=400,code='failed_precondition')
                call(owner,'ListRepositoryTeamAccess',{**owner_target,key:'9223372036854775807','page':{'page':1,'limit':20}},expected=400,code='failed_precondition')
            call(owner,'AttachRepositoryTeam',{**mutation_target(owner_target,row),'expectedRevision':'0'*64},expected=400,code='failed_precondition')
            call(owner,'AttachRepositoryTeam',{**mutation_target(owner_target,row),'expectedTeamRevision':'0'*64},expected=400,code='failed_precondition')
            assert associations(owner['token'],native['full_name'],int(org_id))==before
            stage('once-only attach and detach with independent native association/config readback')
            mutation('AttachRepositoryTeam',owner,owner_target,row)
            call(owner,'AttachRepositoryTeam',mutation_target(owner_target,row),expected=400,code='failed_precondition')
            owner_target,inventory=inspect();row=selected_row(inventory);mutation('DetachRepositoryTeam',owner,owner_target,row)
            call(owner,'DetachRepositoryTeam',mutation_target(owner_target,row),expected=400,code='failed_precondition')
            assert team_configuration(smoke.provider(owner['token'],'GET','teams/'+str(builders['id'])))==original_config
            stage('external association and team-permission changes cannot reuse previews')
            owner_target,inventory=inspect();row=selected_row(inventory)
            smoke.provider(owner['token'],'PUT','teams/'+str(builders['id'])+'/repos/'+native['full_name'],expected=204)
            call(owner,'AttachRepositoryTeam',mutation_target(owner_target,row),expected=400,code='failed_precondition')
            owner_target,inventory=inspect();row=selected_row(inventory)
            smoke.provider(owner['token'],'PATCH','teams/'+str(builders['id']),{'description':'Changed native preview'})
            call(owner,'DetachRepositoryTeam',mutation_target(owner_target,row),expected=400,code='failed_precondition')
            owner_target,inventory=inspect();mutation('DetachRepositoryTeam',owner,owner_target,selected_row(inventory))
            smoke.provider(owner['token'],'PATCH','teams/'+str(builders['id']),{'description':original_config['description']})
            if args.ui:
                stage('real shared team inventory/editor/attach/detach/reload and response-loss browser qualification')
                owner_target,inventory=inspect()
                browser_config={'stackRoot':str(ROOT),'golf':smoke.GOLF,'forge':smoke.FORGE,'repository':native['full_name'],'repositoryId':repo_id,'ownerId':org_id,'email':owner['email'],'password':owner['password'],'readerEmail':member['email'],'readerPassword':member['password'],'ownerToken':owner['token'],'teamId':str(builders['id']),'teamName':builders['name'],'screenshots':str(OUTPUT),'runtime':before_runtime}
                result=subprocess.run(['node',str(ROOT/'scripts/repository-team-access-browser.mjs')],cwd=ROOT,env=environment,input=json.dumps(browser_config).encode(),capture_output=True,timeout=360)
                assert len(result.stdout)<=65536 and len(result.stderr)<=65536
                browser_proof=json.loads((OUTPUT/'browser-manifest.json').read_text());record(browser=browser_proof['status'],captures=browser_proof['captures'],browserFailedStage=browser_proof.get('failedStage'),browserRequestCounts=browser_proof.get('requestCounts',{}),browserProcedureStatusCounts=browser_proof.get('procedureStatusCounts',{}))
                assert result.returncode==0 and browser_proof['status']=='browser_checks_passed_parent_native_cleanup_pending' and len(browser_proof['captures'])==12 and browser_proof['runtime']==before_runtime,'Browser proof failed; safe staged manifest available'
                assert result.stdout.decode().startswith('PASS: actual repository-team');print(result.stdout.decode().strip(),flush=True)
                assert int(builders['id']) not in associations(owner['token'],native['full_name'],int(org_id))
            stage('current owner role loss denies management despite additive read access')
            smoke.provider(owner['token'],'PUT','teams/'+owner_team_id+'/members/'+member_admin['name'],expected=204)
            try:
                smoke.provider(member_admin['token'],'DELETE','teams/'+owner_team_id+'/members/'+owner['name'],expected=204)
                readonly_target,readonly=inspect();assert not readonly.get('canManage',False)
                call(owner,'AttachRepositoryTeam',mutation_target(readonly_target,selected_row(readonly)),expected=403)
            finally:
                smoke.provider(member_admin['token'],'PUT','teams/'+owner_team_id+'/members/'+owner['name'],expected=204)
                smoke.provider(owner['token'],'DELETE','teams/'+owner_team_id+'/members/'+member_admin['name'],expected=204)
            owner_target,inventory=inspect();assert inventory['canManage']
            stage('native rename/replacement rejects former immutable repository target')
            pinned=owner_target;row=selected_row(inventory)
            renamed=smoke.provider(owner['token'],'PATCH',path,{'name':'team-access-renamed'});assert str(renamed['id'])==repo_id;repositories.pop(native['full_name']);repositories[renamed['full_name']]=renamed['id']
            replacement=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos',{'name':'team-access','private':True,'auto_init':True},201);assert str(replacement['id'])!=repo_id;repositories[replacement['full_name']]=replacement['id']
            replacement_before=associations(owner['token'],replacement['full_name'],int(org_id))
            for method in ('AttachRepositoryTeam','DetachRepositoryTeam'):call(owner,method,mutation_target(pinned,row),expected=400,code='failed_precondition')
            assert associations(owner['token'],replacement['full_name'],int(org_id))==replacement_before
            smoke.provider(owner['token'],'DELETE',path,expected=204);repositories.pop(replacement['full_name'])
            restored=smoke.provider(owner['token'],'PATCH','repos/'+renamed['full_name'],{'name':'team-access'});assert str(restored['id'])==repo_id;repositories.pop(renamed['full_name']);repositories[restored['full_name']]=restored['id']
            owner_target,inventory=inspect();assert inventory['canManage']
            stage('Origin, delegated bearer and logout cannot read or write private team inventory')
            credential=checked_rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Team association qualifier'});bearers.append((owner,credential['credential']['id']))
            row=selected_row(inventory);unchanged=associations(owner['token'],native['full_name'],int(org_id))
            for method in ('ListRepositoryTeamAccess','AttachRepositoryTeam','DetachRepositoryTeam'):
                payload={**owner_target,'page':{'page':1,'limit':20}} if method.startswith('List') else mutation_target(owner_target,row)
                call(owner,method,payload,headers={'Origin':'https://other.invalid'},expected=403)
                checked_rpc(smoke.client(),SERVICE+method,payload,headers={'Authorization':'Bearer '+credential['token']},expected=403)
            checked_rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']});bearers.clear()
            checked_rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False
            for method in ('ListRepositoryTeamAccess','AttachRepositoryTeam','DetachRepositoryTeam'):
                payload={**owner_target,'page':{'page':1,'limit':20}} if method.startswith('List') else mutation_target(owner_target,row)
                call(owner,method,payload,expected=401)
            assert associations(owner['token'],native['full_name'],int(org_id))==unchanged
            assert runtime()==before_runtime;record(nativeChecks='passed',runtimeUnchanged=True);passed=True
        finally:
            if not passed:record(failedStage=STAGE,failedProcedure=PROOF.get('lastProcedure'))
            print('CHECK: owned fixture cleanup',flush=True);failures=[]
            for actor,identifier in bearers:
                try:checked_rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try:checked_rpc(actor['session'],'SessionService/RevokeOtherSessions');checked_rpc(actor['session'],'SessionService/Logout')
                    except Exception:failures.append('session')
            for actor in reversed(enrolled):
                try:assert operator('disable',{'username':actor['name']})['disabled']
                except Exception:failures.append('managed disable')
            import urllib.request,urllib.error
            class NoCleanupRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,request,fp,code,msg,headers,newurl):return None
            cleanup_client=urllib.request.build_opener(NoCleanupRedirect)
            def remove(route,role,identifier,owner_identifier=None):
                # Never follow a stale alias or delete a different current native ID.
                def native_request(method):
                    request=urllib.request.Request(smoke.FORGE+'/api/v1/'+route,method=method,headers={'Authorization':'token '+actors['owner']['token']})
                    try:response=cleanup_client.open(request,timeout=15)
                    except urllib.error.HTTPError as error:response=error
                    with response:
                        metadata={'role':role,'method':method,'status':response.status}
                        observations=PROOF.get('cleanupObservations',[]);observations.append(metadata);record(cleanupObservations=observations)
                        raw=response.read((1<<20)+1);assert len(raw)<=1<<20
                        return response.status,json.loads(raw) if raw else None
                status,row=native_request('GET')
                if status==404:return
                assert status==200 and isinstance(row,dict) and row['id']==identifier
                if owner_identifier is not None:assert row['owner']['id']==owner_identifier
                assert native_request('DELETE')[0]==204
                assert native_request('GET')[0]==404
            for full_name,identifier in reversed(list(repositories.items())):
                try:remove('repos/'+full_name,'repository',identifier,organizations[full_name.split('/')[0]])
                except Exception:failures.append('native repository')
            for name,identifier in reversed(list(organizations.items())):
                try:remove('orgs/'+name,'organization',identifier)
                except Exception:failures.append('native organization')
            for actor in reversed(list(actors.values())):
                if actor['created']:
                    try:admin('delete','--username',actor['name'],'--purge')
                    except Exception:failures.append('native purge')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in [('ps','-aq'),('volume','ls','-q'),('network','ls','-q')]:assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
            except Exception:failures.append('fresh project resources')
            finally:smoke.GOLF,smoke.FORGE=previous;record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed:record(failedStage='owned fixture cleanup')
            assert not failures,'Owned native/managed cleanup incomplete (fresh project removed)'
            print('Cleanup: disposable actors/orgs/repos purged, managed sessions/bearers revoked/accounts disabled, fresh Compose resources removed.',flush=True)
    assert passed;record(status='qualified',browser='qualified' if args.ui else 'not_requested')
    print('PASS: actual pinned native repository-team exact identities, current owner/admin gates, protected teams, association readback, stale/external/role/replacement/Origin/bearer/logout fences on unchanged isolated runtime; full Access remains Partial')


if __name__=='__main__':
    try:main()
    except Exception as failure:
        frames=traceback.extract_tb(failure.__traceback__);frame=next((item for item in reversed(frames) if item.filename==__file__),frames[-1])
        try:record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureType=type(failure).__name__,failureLine=frame.lineno)
        except Exception:pass
        print('Team-access qualifier failed at '+PROOF.get('failedStage',STAGE)+': '+type(failure).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr);raise SystemExit(1)
