#!/usr/bin/env python3
"""Prepared read-only Rules qualification; source checks are not runtime proof.

Uses one cached --image in a fresh isolated Compose project, supported native
APIs and managed fixture accounts. Never builds/pulls, touches a retained stack,
executes workflows/models, or writes native SQL/files. --ui captures 12 actual
inventory/details/reload screens. All private credentials remain in RAM/private
stdin/tempfiles; safe manifest metadata only. Atomic native race/enforcement
qualification is explicitly outside this inventory proof.
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
import urllib.error
import urllib.request
sys.dont_write_bytecode = True
import smoke
import uuid
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryRulesService/GetRepositoryRules'
STAGE, OUTPUT = 'arguments', None
PROOF = {'status':'not_started', 'cleanup':'not_started', 'scope':'Current whole native rule inventories only; no matching/precedence, writes, merge eligibility, atomic race, trusted-check or P0.8 enforcement claim', 'captures':[]}
# Explicit native-to-wire mapping, independently compared for every returned row.
BRANCH = dict(ruleName='rule_name', priority='priority', requiredApprovals='required_approvals', statusCheckContexts='status_check_contexts', pushUsernames='push_whitelist_usernames', pushTeams='push_whitelist_teams', forcePushUsernames='force_push_allowlist_usernames', forcePushTeams='force_push_allowlist_teams', mergeUsernames='merge_whitelist_usernames', mergeTeams='merge_whitelist_teams', bypassUsernames='bypass_allowlist_usernames', bypassTeams='bypass_allowlist_teams', approvalsUsernames='approvals_whitelist_username', approvalsTeams='approvals_whitelist_teams', protectedFilePatterns='protected_file_patterns', unprotectedFilePatterns='unprotected_file_patterns', createdAt='created_at', updatedAt='updated_at', enablePush='enable_push', enablePushWhitelist='enable_push_whitelist', pushWhitelistDeployKeys='push_whitelist_deploy_keys', enableForcePush='enable_force_push', enableForcePushAllowlist='enable_force_push_allowlist', forcePushAllowlistDeployKeys='force_push_allowlist_deploy_keys', enableMergeWhitelist='enable_merge_whitelist', enableBypassAllowlist='enable_bypass_allowlist', enableStatusCheck='enable_status_check', enableApprovalsWhitelist='enable_approvals_whitelist', blockOnRejectedReviews='block_on_rejected_reviews', blockOnOfficialReviewRequests='block_on_official_review_requests', blockOnOutdatedBranch='block_on_outdated_branch', dismissStaleApprovals='dismiss_stale_approvals', ignoreStaleApprovals='ignore_stale_approvals', requireSignedCommits='require_signed_commits', blockAdminMergeOverride='block_admin_merge_override')
TAG = dict(id='id', namePattern='name_pattern', allowedUsernames='whitelist_usernames', allowedTeams='whitelist_teams', createdAt='created_at', updatedAt='updated_at')
MERGE = dict(allowMergeCommits='allow_merge_commits', allowRebase='allow_rebase', allowRebaseExplicit='allow_rebase_explicit', allowSquashMerge='allow_squash_merge', allowFastForwardOnlyMerge='allow_fast_forward_only_merge', allowManualMerge='allow_manual_merge', autodetectManualMerge='autodetect_manual_merge', allowMergeUpdate='allow_merge_update', allowRebaseUpdate='allow_rebase_update', defaultDeleteBranchAfterMerge='default_delete_branch_after_merge', defaultAllowMaintainerEdit='default_allow_maintainer_edit', defaultMergeStyle='default_merge_style', defaultUpdateStyle='default_update_style')


def record(**values):
    PROOF.update(values)
    if OUTPUT:
        target = OUTPUT/'manifest.json.tmp'
        with target.open('w') as file:
            target.chmod(0o600); json.dump(PROOF, file, indent=2, sort_keys=True); file.write('\n')
        target.replace(OUTPUT/'manifest.json')


def stage(value):
    global STAGE
    STAGE = value; record(stage=value); print('CHECK: '+value, flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl): return None


def native(token, method, path, payload=None, expected=200):
    request = urllib.request.Request(smoke.FORGE+'/api/v1/'+path, data=None if payload is None else json.dumps(payload).encode(), method=method, headers={'Content-Type':'application/json','Authorization':'token '+token})
    try: response = urllib.request.build_opener(NoRedirect()).open(request, timeout=45)
    except urllib.error.HTTPError as error: response = error
    with response:
        raw = response.read((2<<20)+1)
        record(lastNativeRequest={'method':method,'status':response.status,'expectedStatus':expected})
        assert response.status == expected and len(raw) <= 2<<20, 'Native status/bound mismatch; private response withheld'
        return json.loads(raw) if raw else None


def rpc(session, procedure, payload=None, expected=200, code=None, headers=None):
    request = urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+procedure, data=json.dumps(payload or {}).encode(), method='POST', headers={'Origin':smoke.GOLF,'Connect-Protocol-Version':'1','Content-Type':'application/json',**(headers or {})})
    try: response = session.open(request, timeout=20)
    except urllib.error.HTTPError as error: response = error
    with response:
        raw = response.read((1<<20)+1); metadata = {'procedure':procedure,'status':response.status}
        assert len(raw) <= 1<<20 and response.headers.get('Cache-Control') == 'no-store', 'RPC protocol/bound mismatch'
        result = json.loads(raw) if raw else None
        if isinstance(result, dict) and re.fullmatch(r'[a-z_]{1,64}', result.get('code','')): metadata['code'] = result['code']
        record(lastProcedure=metadata)
        assert response.status == expected, 'RPC status mismatch; safe procedure metadata recorded'
        if expected != 200:
            assert result['code'] == (code or {400:'invalid_argument',401:'unauthenticated',403:'permission_denied',404:'not_found'}[expected])
        return result


def projection(row, mapping):
    out = {}
    for wire, field in mapping.items():
        value = row[field]  # Missing provider fields must not become false.
        if field in ('id', 'priority', 'required_approvals'):
            assert type(value) is int; value = str(value)
        elif value is None and field in ('status_check_contexts','push_whitelist_usernames','push_whitelist_teams','force_push_allowlist_usernames','force_push_allowlist_teams','merge_whitelist_usernames','merge_whitelist_teams','bypass_allowlist_usernames','bypass_allowlist_teams','approvals_whitelist_username','approvals_whitelist_teams','whitelist_usernames','whitelist_teams'):
            value = []
        assert isinstance(value, (str,bool,list)), 'Unexpected native field shape'
        if value not in ('',False,[]): out[wire] = value
    return out


def receipt(value, target, repository, branches, tags):
    assert value['repositoryId'] == target['repositoryId'] and value['ownerId'] == target['ownerId'] and value['accessRevision'] == target['expectedRevision']
    assert re.fullmatch(r'[a-f0-9]{64}', value['rulesRevision'])
    assert len(value.get('branchProtections',[])) == len(branches) and len(value.get('tagProtections',[])) == len(tags)
    assert value.get('branchProtections',[]) == [projection(row, BRANCH) for row in branches]
    assert value.get('tagProtections',[]) == [projection(row, TAG) for row in tags]
    assert value['mergeConfiguration'] == projection(repository, MERGE)
    return value


def self_check():
    source = (ROOT/'api/golf/v1/golf.proto').read_text()
    assert 'rpc GetRepositoryRules(' in source
    for field, tag in [('repository_id',2),('owner_id',3),('expected_revision',4)]:
        body = re.search(r'message GetRepositoryRulesRequest\s*\{([^}]+)\}', source).group(1)
        assert re.search(r'string\s+'+field+r'\s*=\s*'+str(tag)+r'\s*;', body)
    assert len(BRANCH) == 35 and len(TAG) == 6 and len(MERGE) == 13
    native_row = {'id':9007199254740993,'priority':-2,'required_approvals':0,'flag':False,'items':[]}
    assert projection(native_row, {'id':'id','priority':'priority','requiredApprovals':'required_approvals','flag':'flag','items':'items'}) == {'id':'9007199254740993','priority':'-2','requiredApprovals':'0'}
    target = {'repositoryId':'7','ownerId':'9','expectedRevision':'a'*64}
    repository = {field:('merge' if field.startswith('default_') and field.endswith('_style') else False) for field in MERGE.values()}
    valid = {**{k:target[k] for k in ('repositoryId','ownerId')},'accessRevision':'a'*64,'rulesRevision':'b'*64,'mergeConfiguration':projection(repository,MERGE)}
    receipt(valid,target,repository,[],[])
    for field in ('repositoryId','ownerId','accessRevision','rulesRevision'):
        try: receipt({**valid,field:'bad'},target,repository,[],[])
        except (AssertionError,KeyError): pass
        else: raise AssertionError('Invalid exact receipt admitted')
    try: projection({}, {'missing':'enable_push'})
    except KeyError: pass
    else: raise AssertionError('Missing native boolean silently accepted')
    prior = globals()['OUTPUT'], dict(PROOF)
    try:
        with tempfile.TemporaryDirectory(prefix='golf-rules-pure-') as directory:
            globals()['OUTPUT'] = Path(directory); record(status='failed',failedStage='original predicate',cleanup='passed')
            assert json.loads((OUTPUT/'manifest.json').read_text())['failedStage'] == 'original predicate'
            assert OUTPUT.joinpath('manifest.json').stat().st_mode & 0o777 == 0o600
    finally: globals()['OUTPUT'] = prior[0]; PROOF.clear(); PROOF.update(prior[1])
    print('PASS: pure exact Rules wire/int64/presence/receipt/failure-preservation checks; no runtime operations')


def main():
    global OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true')
    parser.add_argument('--image',help='Cached explicitly revision-labeled Golf image; never build/pull')
    parser.add_argument('--output',type=Path,help='New owner-only artifact directory')
    parser.add_argument('--ui',action='store_true',help='Actual read-only inventory/details/reload,12 theme/width captures')
    args = parser.parse_args()
    if args.self_check: self_check(); return
    if not args.image or not args.output: parser.error('--image and --output are required')
    args.output.mkdir(mode=0o700,parents=True,exist_ok=False); args.output.chmod(0o700); OUTPUT = args.output.resolve(); record(status='running',browser='pending' if args.ui else 'not_requested')
    helper_spec = importlib.util.spec_from_file_location('rules_stack_helpers',ROOT/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helpers)
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','FORGEJO_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k != 'DATABASE_URL'}
    def run(*arguments,payload=None,timeout=180):
        result = subprocess.run(arguments,cwd=ROOT,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('cached images, disk reserve and local browser prerequisite')
    if args.ui: assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    info = json.loads(run('docker','image','inspect',args.image))[0]; image = info['Id']; revision = info['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',image) and re.fullmatch(r'[a-f0-9]{40}',revision or '')
    for dependency in ('postgres:18.4-alpine3.24','codeberg.org/forgejo/forgejo:15.0.9-rootless@sha256:caf1bca332f95cdcf124227a4bfa3b49bbbfbbc8a5e4a97406921cb581165413'): run('docker','image','inspect',dependency)
    free = run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',image,'-Pk','/')
    assert int(free.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB Docker VM reserve'
    project = 'golf-rules-proof-'+secrets.token_hex(5); ports = helpers.free_ports(2); previous = smoke.GOLF,smoke.FORGE
    smoke.GOLF,smoke.FORGE = 'http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1])
    actors,enrolled,bearers,repositories,orgs = {},[],[],{},{}
    started,passed = False,False; record(project=project,selectedImage=image,sourceRevision=revision)
    with tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD')} | {'GOLF_FORGE_INSTANCE_ID': str(uuid.uuid4())}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        env_file,override = directory/'proof.env',directory/'proof.yaml'; helpers.private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()))
        helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
  forgejo:
    environment:
      FORGEJO__server__ROOT_URL: {smoke.FORGE}/
      FORGEJO__migrations__ALLOWED_DOMAINS: forgejo
      FORGEJO__migrations__ALLOW_LOCALNETWORKS: "true"
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(override)]
        def command(*arguments,**kwargs): return run(*compose,*arguments,**kwargs)
        def admin(*arguments): return command('exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*arguments)  # Forgejo's upstream path
        def operator(action,payload):
            result = json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account',action,payload=payload)); assert result['state'] == 'complete'; return result['result']
        def runtime():
            cid = command('ps','-q','golf'); assert re.fullmatch(r'[a-f0-9]{12,64}',cid)
            value = json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',cid))
            assert value['image'] == image and value['reference'] == image and value['revision'] == revision
            value['nativeVersion'] = native('', 'GET','version')['version']; assert value['nativeVersion'] == '15.0.9+gitea-1.22.0'; return value  # Forgejo's upstream version string
        def access(actor,repository):
            a = rpc(actor['session'],'RepositoryAccessService/GetRepositoryAccess',{'repository':repository})['access']
            assert re.fullmatch(r'[1-9][0-9]*',a['repositoryId']) and re.fullmatch(r'[1-9][0-9]*',a['ownerId']) and re.fullmatch(r'[a-f0-9]{64}',a['revision'])
            return {'repository':repository,'repositoryId':a['repositoryId'],'ownerId':a['ownerId'],'expectedRevision':a['revision']}
        def read(actor,repository):
            target = access(actor,repository); path = 'repos/'+repository['owner']+'/'+repository['name']
            observed = rpc(actor['session'],SERVICE,target)
            baseline = [native(actors['owner']['token'],'GET',path+suffix) for suffix in ('','/branch_protections','/tag_protections')]
            receipt(observed,target,*baseline); return target,observed
        def create_repository(owner,name,organization=False):
            row = native(owner['token'],'POST',('orgs/'+name.split('/')[0]+'/repos') if organization else 'user/repos',{'name':name.split('/')[-1],'private':True,'auto_init':True,'default_branch':'main'},201)
            repositories[row['full_name']] = (row['id'],row['owner']['id']); smoke.wait_for_push(owner['token'],row['full_name']); return {'owner':row['owner']['login'],'name':row['name']}
        def configure(repository,team=None):
            path = 'repos/'+repository['owner']+'/'+repository['name']; owner = actors['owner']; usernames = [owner['name']]
            native(owner['token'],'PATCH',path,{'allow_merge_commits':True,'allow_rebase':False,'allow_rebase_explicit':True,'allow_squash_merge':True,'allow_fast_forward_only_merge':False,'allow_manual_merge':False,'autodetect_manual_merge':True,'allow_merge_update':True,'allow_rebase_update':False,'default_merge_style':'squash','default_update_style':'merge','default_delete_branch_after_merge':True,'default_allow_maintainer_edit':False})
            config = {'rule_name':'main','priority':9007199254740993,'enable_push':True,'enable_push_whitelist':True,'push_whitelist_usernames':usernames,'push_whitelist_deploy_keys':True,'enable_force_push':True,'enable_force_push_allowlist':True,'force_push_allowlist_usernames':usernames,'force_push_allowlist_deploy_keys':True,'enable_merge_whitelist':True,'merge_whitelist_usernames':usernames,'enable_bypass_allowlist':True,'bypass_allowlist_usernames':usernames,'enable_status_check':True,'status_check_contexts':['golf/test','golf/security'],'required_approvals':2,'enable_approvals_whitelist':True,'approvals_whitelist_username':usernames,'block_on_rejected_reviews':True,'block_on_official_review_requests':True,'block_on_outdated_branch':True,'dismiss_stale_approvals':True,'ignore_stale_approvals':False,'require_signed_commits':True,'block_admin_merge_override':True,'protected_file_patterns':'src/**','unprotected_file_patterns':'docs/**'}
            if team:
                for field in ('push_whitelist_teams','force_push_allowlist_teams','merge_whitelist_teams','bypass_allowlist_teams','approvals_whitelist_teams'): config[field] = [team['name']]
            row = native(owner['token'],'POST',path+'/branch_protections',config,201); assert row['rule_name'] == 'main' and row['priority'] == config['priority']
            native(owner['token'],'POST',path+'/branch_protections',{'rule_name':'release/*','priority':2,'enable_push':False,'required_approvals':0},201)
            for pattern in ('v*','release-*'):
                native(owner['token'],'POST',path+'/tag_protections',{'name_pattern':pattern,'whitelist_usernames':usernames,'whitelist_teams':[team['name']] if team else []},201)
        try:
            stage('fresh base stack only'); started = True; record(cleanup='pending'); command('up','-d','--no-build','--pull','never',timeout=180); smoke.ready(); before = runtime(); record(runtime=before)
            stage('ordinary native actors and managed sessions')
            for role in ('owner','direct','memberdirect','team','reader','global','outsider'):
                actor = {'role':role,'name':project+'-'+role,'created':False,'session':smoke.client(),'loggedIn':False}; actors[role] = actor
                admin('create','--username',actor['name'],'--email',actor['name']+'@example.invalid','--random-password','--must-change-password=false'); actor['created'] = True
                actor['token'] = admin('generate-access-token','--username',actor['name'],'--token-name',project,'--scopes','write:user,write:organization,write:repository','--raw')
                user = native(actor['token'],'GET','user'); assert not user['is_admin']; actor.update(id=str(user['id']),email=actor['name']+'@golf.invalid',password='Rules fixture '+secrets.token_urlsafe(24)); enrolled.append(actor)
                operator('create',{'username':actor['name'],'email':actor['email'],'password':actor['password'],'forge_token':actor['token'],'is_instance_admin':role=='global'})
                session = rpc(actor['session'],'SessionService/LoginWithPassword',{'username':actor['email'],'password':actor['password']})['user']; assert session['id'] == actor['id'] and session.get('isInstanceAdmin',False) == (role=='global'); actor['loggedIn'] = True
            owner = actors['owner']; personal = create_repository(owner,'rules'); path = 'repos/'+personal['owner']+'/'+personal['name']
            for role,permission in (('direct','admin'),('reader','read'),('global','read')): native(owner['token'],'PUT',path+'/collaborators/'+actors[role]['name'],{'permission':permission},204)
            configure(personal); target,initial = read(owner,personal); assert len(initial['branchProtections']) == 2 and len(initial['tagProtections']) == 2
            stage('personal owner/direct-admin and denied global/reader/outsider')
            read(actors['direct'],personal)
            for role in ('reader','global'): rpc(actors[role]['session'],SERVICE,access(actors[role],personal),expected=403)
            rpc(actors['outsider']['session'],SERVICE,target,expected=404)
            stage('organization owner/member-direct admin versus team-admin')
            org_name = project+'-org'; org = native(owner['token'],'POST','orgs',{'username':org_name,'visibility':'private'},201); orgs[org_name] = org['id']; organization = create_repository(owner,org_name+'/rules',True); org_path = 'repos/'+org_name+'/rules'
            def team(name,permission):
                row = native(owner['token'],'POST','orgs/'+org_name+'/teams',{'name':name,'permission':permission,'units_map':{'repo.code':permission,'repo.pulls':permission},'visibility':'limited','includes_all_repositories':False},201)
                native(owner['token'],'PUT','teams/'+str(row['id'])+'/repos/'+org_name+'/rules',expected=204); return row
            readers,admins = team('Readers','read'),team('Administrators','admin')
            native(owner['token'],'PUT','teams/'+str(readers['id'])+'/members/'+actors['memberdirect']['name'],expected=204)
            native(owner['token'],'PUT',org_path+'/collaborators/'+actors['memberdirect']['name'],{'permission':'admin'},204)
            native(owner['token'],'PUT','teams/'+str(admins['id'])+'/members/'+actors['team']['name'],expected=204)
            configure(organization,admins); read(owner,organization); read(actors['memberdirect'],organization)
            rpc(actors['team']['session'],SERVICE,access(actors['team'],organization),expected=403)
            record(authorityMatrix='passed')
            stage('serial native rule change gets different observation revision')
            native(owner['token'],'PATCH',path+'/branch_protections/main',{'required_approvals':3})
            changed_target,changed = read(owner,personal); assert changed['rulesRevision'] != initial['rulesRevision'] and next(row for row in changed['branchProtections'] if row['ruleName']=='main')['requiredApprovals'] == '3'
            stage('exact target, stale access and current role loss')
            for field,value in (('repositoryId','9223372036854775807'),('ownerId','9223372036854775807'),('expectedRevision','0'*64)): rpc(owner['session'],SERVICE,{**changed_target,field:value},expected=400,code='failed_precondition')
            direct_target = access(actors['direct'],personal); native(owner['token'],'PUT',path+'/collaborators/'+actors['direct']['name'],{'permission':'read'},204)
            rpc(actors['direct']['session'],SERVICE,direct_target,expected=403)
            native(owner['token'],'PUT',path+'/collaborators/'+actors['direct']['name'],{'permission':'admin'},204)
            stage('archived configuration remains readable, not editable')
            native(owner['token'],'PATCH',path,{'archived':True}); archived_target,archived = read(owner,personal); assert native(owner['token'],'GET',path)['archived'] is True
            assert archived['branchProtections'] == changed['branchProtections']; native(owner['token'],'PATCH',path,{'archived':False}); target,current = read(owner,personal)
            stage('actual owned Git mirror configuration remains readable')
            mirror = native(owner['token'],'POST','repos/migrate',{'clone_addr':'http://forgejo:3000/'+owner['name']+'/rules.git','repo_owner':owner['name'],'repo_name':'rules-mirror','service':'git','mirror':True,'private':True,'auth_username':owner['name'],'auth_password':owner['token'],'mirror_interval':'168h'},201)
            repositories[mirror['full_name']] = (mirror['id'],mirror['owner']['id']); assert mirror['mirror'] is True; read(owner,{'owner':owner['name'],'name':'rules-mirror'}); record(archivedAndMirrorReads='passed')
            if args.ui:
                stage('actual canonical Rules browser proof')
                config = {'golf':smoke.GOLF,'repository':owner['name']+'/rules','target':target,'expected':current,'email':owner['email'],'password':owner['password'],'screenshots':str(OUTPUT),'stackRoot':str(ROOT),'runtime':before}
                browser = subprocess.run(['node',str(ROOT/'scripts/repository-rules-browser.mjs')],cwd=ROOT,input=json.dumps(config).encode(),capture_output=True,timeout=240)
                proof = json.loads((OUTPUT/'browser-manifest.json').read_text()); record(browser=proof['status'],captures=proof['captures'],browserFailedStage=proof.get('failedStage'),browserProcedureStatusCounts=proof.get('procedureStatusCounts',{}))
                assert browser.returncode == 0 and proof['status'] == 'browser_checks_passed_parent_cleanup_pending' and len(proof['captures']) == 12 and proof['runtime'] == before, 'Browser proof failed; safe staged manifest retained'
                receipt(current,target,native(owner['token'],'GET',path),native(owner['token'],'GET',path+'/branch_protections'),native(owner['token'],'GET',path+'/tag_protections'))
            stage('native rename/replacement refuses historical target')
            renamed = native(owner['token'],'PATCH',path,{'name':'rules-renamed'}); assert str(renamed['id']) == target['repositoryId']; repositories.pop(owner['name']+'/rules'); repositories[renamed['full_name']] = (renamed['id'],renamed['owner']['id'])
            replacement = create_repository(owner,'rules'); assert str(repositories[owner['name']+'/rules'][0]) != target['repositoryId']; rpc(owner['session'],SERVICE,target,expected=400,code='failed_precondition')
            replacement_target,replacement_empty = read(owner,replacement); assert not replacement_empty.get('branchProtections',[]) and not replacement_empty.get('tagProtections',[])
            stage('Origin/bearer/logout deny private inventory')
            renamed_key = {'owner':owner['name'],'name':'rules-renamed'}; renamed_target,_ = read(owner,renamed_key)
            credential = rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Rules boundary'}); bearers.append((owner,credential['credential']['id']))
            rpc(owner['session'],SERVICE,renamed_target,headers={'Origin':'https://other.invalid'},expected=403)
            rpc(smoke.client(),SERVICE,renamed_target,headers={'Authorization':'Bearer '+credential['token']},expected=403)
            rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']}); bearers.clear()
            rpc(owner['session'],'SessionService/Logout'); owner['loggedIn'] = False; rpc(owner['session'],SERVICE,renamed_target,expected=401)
            assert runtime() == before; record(nativeChecks='passed',runtimeUnchanged=True); passed = True
        except Exception as error:
            frames = traceback.extract_tb(error.__traceback__)
            frame = next((f for f in reversed(frames) if f.filename == __file__),frames[-1])
            record(failedStage=STAGE,originalFailureType=type(error).__name__,originalFailureLine=frame.lineno,failedProcedure=PROOF.get('lastProcedure'),failedNativeRequest=PROOF.get('lastNativeRequest'))
            raise
        finally:
            if not passed and not PROOF.get('failedStage'): record(failedStage=STAGE)
            failures = []
            for actor,cid in bearers:
                try: rpc(actor['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':cid})
                except Exception: failures.append('bearer')
            for actor in actors.values():
                if actor['loggedIn']:
                    try: rpc(actor['session'],'SessionService/RevokeOtherSessions'); rpc(actor['session'],'SessionService/Logout')
                    except Exception: failures.append('session')
            for actor in reversed(enrolled):
                try: assert operator('disable',{'username':actor['name']})['disabled']
                except Exception: failures.append('managed disable')
            for full_name,(repo_id,owner_id) in reversed(list(repositories.items())):
                try:
                    row = native(actors['owner']['token'],'GET','repos/'+full_name); assert row['id'] == repo_id and row['owner']['id'] == owner_id
                    native(actors['owner']['token'],'DELETE','repos/'+full_name,expected=204); native(actors['owner']['token'],'GET','repos/'+full_name,expected=404)
                except Exception: failures.append('native repository')
            for name,org_id in reversed(list(orgs.items())):
                try:
                    assert native(actors['owner']['token'],'GET','orgs/'+name)['id'] == org_id; native(actors['owner']['token'],'DELETE','orgs/'+name,expected=204); native(actors['owner']['token'],'GET','orgs/'+name,expected=404)
                except Exception: failures.append('native organization')
            for actor in reversed(list(actors.values())):
                if actor['created']:
                    try:
                        observed = native(actor.get('token',''),'GET','users/'+actor['name'])
                        assert observed['login'] == actor['name'] and ('id' not in actor or observed['id'] == int(actor['id']))
                        admin('delete','--username',actor['name'],'--purge'); native('', 'GET','users/'+actor['name'],expected=404)
                    except Exception: failures.append('native actor')
            try:
                if started:
                    command('down','--volumes','--remove-orphans',timeout=180)
                    for arguments in (('ps','-aq'),('volume','ls','-q'),('network','ls','-q')): assert not run('docker',*arguments,'--filter','label=com.docker.compose.project='+project)
            except Exception: failures.append('fresh project resources')
            finally: smoke.GOLF,smoke.FORGE = previous; record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed: record(failedStage='owned fixture cleanup')
            assert not failures, 'Owned fixture cleanup incomplete; fresh project removal attempted'
            print('Cleanup: owned native repositories/org/users purged, managed sessions/bearers revoked/accounts disabled, fresh Compose volumes/network/containers removed.',flush=True)
    assert passed; record(status='qualified',browser='qualified' if args.ui else 'not_requested')
    print('PASS: actual supported-native whole Rules readback, individual authority/identity/revision boundaries and unchanged fresh runtime; no enforcement or atomic race claim')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        frames = traceback.extract_tb(error.__traceback__); frame = next((f for f in reversed(frames) if f.filename == __file__),frames[-1])
        try: record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureType=type(error).__name__,failureLine=frame.lineno)
        except Exception: pass
        print('Rules qualifier failed at '+PROOF.get('failedStage',STAGE)+'; '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr); sys.exit(1)
