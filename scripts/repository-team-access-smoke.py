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
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryTeamAccessService/'
STAGE = 'arguments'
OUTPUT = None
NATIVE_SOURCES = ['https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/'+path for path in ('routers/api/v1/repo/teams.go', 'routers/api/v1/org/team.go', 'routers/api/v1/api.go', 'modules/structs/org_team.go', 'models/organization/org.go')]
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
    request = urllib.request.Request(smoke.GITEA+'/api/v1/repos/'+repository+'/teams', headers={'Authorization':'token '+token})
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
    environment = {key:value for key,value in os.environ.items() if not key.startswith(('GOLF_', 'GITEA_', 'POSTGRES_', 'COMPOSE_', 'OTEL_', 'AWS_', 'RUSTFS_')) and key != 'DATABASE_URL'}
    def run(*arguments, payload=None, timeout=180):
        result = subprocess.run(arguments, cwd=ROOT, env=environment, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('exact local image and pinned base dependencies')
    inspected = json.loads(run('docker', 'image', 'inspect', args.image))[0]
    image, revision = inspected['Id'], inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image) and re.fullmatch(r'[0-9a-f]{40}', revision or ''), 'Require explicitly revision-labeled product image'
    # Fail before creating anything rather than pulling or consuming retained disk.
    for name in ('postgres:18.4-alpine3.24', 'gitea/gitea:1.27.3-rootless'):
        run('docker', 'image', 'inspect', name)
    space = run('docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/df', image, '-Pk', '/')
    assert int(space.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB free Docker VM space before fresh stack'
    project = 'golf-team-access-proof-'+secrets.token_hex(5)
    ports = helpers.free_ports(2); previous = smoke.GOLF, smoke.GITEA
    smoke.GOLF, smoke.GITEA = 'http://127.0.0.1:'+str(ports[0]), 'http://127.0.0.1:'+str(ports[1])
    actors, enrolled, bearers, organizations, repositories, started, passed = {}, [], [], [], [], False, False
    record(project=project, selectedImage=image, sourceRevision=revision, cleanup='not_created')
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {key:secrets.token_hex(24) for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(), GOLF_PUBLIC_URL=smoke.GOLF, GOLF_PUSH_CI_ENABLED='false')
        env_file, override = directory/'core.env', directory/'proof.yaml'
        helpers.private_write(env_file, ''.join(key+'='+value+'\n' for key,value in values.items()))
        helpers.private_write(override, f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker', 'compose', '-p', project, '--env-file', str(env_file), '-f', str(ROOT/'compose.yaml'), '-f', str(override)]
        def command(*arguments, **kwargs): return run(*compose, *arguments, **kwargs)
        def admin(*arguments): return command('exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *arguments)
        def operator(action, payload):
            result = json.loads(command('exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
            assert result['state'] == 'complete'; return result['result']
        def runtime():
            container = command('ps', '-q', 'golf'); assert re.fullmatch(r'[0-9a-f]{12,64}', container)
            observed = json.loads(run('docker', 'inspect', '--format', '{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}', container))
            assert observed['image'] == image and observed['reference'] == image and observed['revision'] == revision
            observed['nativeVersion'] = smoke.request(smoke.client(), 'GET', smoke.GITEA+'/api/v1/version')['version']; assert observed['nativeVersion'] == '1.27.3'
            return observed
        def call(actor, method, payload, **kwargs): return smoke.rpc(actor['session'], SERVICE+method, payload, **kwargs)
        try:
            stage('fresh base stack, CI and agents unconfigured')
            record(cleanup='pending'); started = True; command('up', '-d', '--no-build', '--pull', 'never', timeout=180); smoke.ready(); before_runtime = runtime()
            record(runtime=before_runtime)
            print('Runtime provenance: '+json.dumps(before_runtime, sort_keys=True), flush=True)
            stage('disposable native ordinary actors and managed password sessions')
            for role in ('owner','member','admin','nonmember','outsider','golfadmin'):
                name=project+'-'+role; actor={'name':name,'created':False,'session':smoke.client(),'loggedIn':False}; actors[role]=actor
                admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');actor['created']=True
                actor['token']=admin('generate-access-token','--username',name,'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw')
                user=smoke.provider(actor['token'],'GET','user');assert not user['is_admin']
                actor.update(id=str(user['id']),email=name+'@golf.invalid',password='Team fixture '+secrets.token_urlsafe(24));enrolled.append(actor)
                operator('create',{'username':name,'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='golfadmin'})
                user=smoke.rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user'];assert user['id']==actor['id'] and user.get('isInstanceAdmin',False)==(role=='golfadmin');actor['loggedIn']=True
            owner,member,member_admin,nonmember,outsider,golfadmin=(actors[k] for k in ('owner','member','admin','nonmember','outsider','golfadmin'))
            stage('supported private organization, exact repository and native strict team fields')
            organization=project+'-org';org=smoke.provider(owner['token'],'POST','orgs',{'username':organization,'visibility':'private'},201);organizations.append(organization)
            other_org=project+'-other';foreign_org=smoke.provider(owner['token'],'POST','orgs',{'username':other_org,'visibility':'private'},201);organizations.append(other_org)
            native=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos',{'name':'team-access','private':True,'auto_init':True},201);repositories.append(native['full_name']);smoke.wait_for_push(owner['token'],native['full_name'])
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
                value=smoke.rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
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
            nonmember_target=target(access(nonmember));assert nonmember_target['repositoryId']==repo_id
            call(nonmember,'ListRepositoryTeamAccess',{**nonmember_target,'page':{'page':1,'limit':20}},expected=404)
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
                browser_config={'stackRoot':str(ROOT),'golf':smoke.GOLF,'gitea':smoke.GITEA,'repository':native['full_name'],'repositoryId':repo_id,'ownerId':org_id,'email':owner['email'],'password':owner['password'],'readerEmail':member['email'],'readerPassword':member['password'],'ownerToken':owner['token'],'teamId':str(builders['id']),'teamName':builders['name'],'screenshots':str(OUTPUT),'runtime':before_runtime}
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
            renamed=smoke.provider(owner['token'],'PATCH',path,{'name':'team-access-renamed'});repositories.append(renamed['full_name']);assert str(renamed['id'])==repo_id
            replacement=smoke.provider(owner['token'],'POST','orgs/'+organization+'/repos',{'name':'team-access','private':True,'auto_init':True},201);assert str(replacement['id'])!=repo_id
            replacement_before=associations(owner['token'],replacement['full_name'],int(org_id))
            for method in ('AttachRepositoryTeam','DetachRepositoryTeam'):call(owner,method,mutation_target(pinned,row),expected=400,code='failed_precondition')
            assert associations(owner['token'],replacement['full_name'],int(org_id))==replacement_before
            smoke.provider(owner['token'],'DELETE',path,expected=204)
            restored=smoke.provider(owner['token'],'PATCH','repos/'+renamed['full_name'],{'name':'team-access'});assert str(restored['id'])==repo_id
            owner_target,inventory=inspect();assert inventory['canManage']
            stage('Origin, delegated bearer and logout cannot read or write private team inventory')
            credential=smoke.rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Team association qualifier'});bearers.append((owner,credential['credential']['id']))
            row=selected_row(inventory);unchanged=associations(owner['token'],native['full_name'],int(org_id))
            for method in ('ListRepositoryTeamAccess','AttachRepositoryTeam','DetachRepositoryTeam'):
                payload={**owner_target,'page':{'page':1,'limit':20}} if method.startswith('List') else mutation_target(owner_target,row)
                call(owner,method,payload,headers={'Origin':'https://other.invalid'},expected=403)
                smoke.rpc(smoke.client(),SERVICE+method,payload,headers={'Authorization':'Bearer '+credential['token']},expected=403)
            smoke.rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']});bearers.clear()
            smoke.rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False
            for method in ('ListRepositoryTeamAccess','AttachRepositoryTeam','DetachRepositoryTeam'):
                payload={**owner_target,'page':{'page':1,'limit':20}} if method.startswith('List') else mutation_target(owner_target,row)
                call(owner,method,payload,expected=401)
            assert associations(owner['token'],native['full_name'],int(org_id))==unchanged
            assert runtime()==before_runtime;record(nativeChecks='passed',runtimeUnchanged=True);passed=True
        finally:
            if not passed:record(failedStage=STAGE)
            print('CHECK: owned fixture cleanup',flush=True);failures=[]
            for actor,identifier in bearers:
                try:smoke.rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':identifier})
                except Exception:failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try:smoke.rpc(actor['session'],'SessionService/RevokeOtherSessions');smoke.rpc(actor['session'],'SessionService/Logout')
                    except Exception:failures.append('session')
            for actor in reversed(enrolled):
                try:assert operator('disable',{'username':actor['name']})['disabled']
                except Exception:failures.append('managed disable')
            import urllib.request,urllib.error
            def remove(route):
                request=urllib.request.Request(smoke.GITEA+'/api/v1/'+route,method='DELETE',headers={'Authorization':'token '+actors['owner']['token']})
                try:response=smoke.client().open(request,timeout=15)
                except urllib.error.HTTPError as error:response=error
                with response:assert response.status in (204,404)
            for full_name in reversed(list(dict.fromkeys(repositories))):
                try:remove('repos/'+full_name)
                except Exception:failures.append('native repository')
            for name in reversed(organizations):
                try:remove('orgs/'+name)
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
            finally:smoke.GOLF,smoke.GITEA=previous;record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
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
