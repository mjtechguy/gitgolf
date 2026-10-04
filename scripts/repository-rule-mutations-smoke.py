#!/usr/bin/env python3
"""Prepared actual Rules049 mutation qualification; source checks are not runtime proof.

Uses one cached --image in a fresh isolated Compose project, supported native
APIs and managed fixture accounts. Never builds/pulls, touches a retained stack,
executes workflows/models, or writes native SQL/files. --ui captures 12 actual
inventory/requested-editor/verified-receipt screens. An owned loopback proxy
forwards unchanged supported native APIs and drops one accepted201 response.
No native atomic CAS, protected-write/P0.8 enforcement or full Rules readiness. All private credentials remain in RAM/private
stdin/tempfiles; safe manifest metadata only. Atomic native race/enforcement
qualification is explicitly outside this inventory proof.
"""
import argparse
import datetime
import http.client
import http.server
import socket
import threading
import uuid
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
ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'RepositoryRulesService/GetRepositoryRules'
MUTATE = 'RepositoryRulesService/MutateRepositoryRules'
STATUS = 'RepositoryRulesService/GetRepositoryRuleMutation'
STAGE, OUTPUT = 'arguments', None
PROOF = {'status':'not_started', 'cleanup':'not_started', 'scope':'Once-only supported native rule configuration and independent whole readback; no atomic native CAS/attribution, rule precedence, protected merge/P0.8, recovery or full Rules readiness', 'captures':[]}
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
    request = urllib.request.Request(smoke.GITEA+'/api/v1/'+path, data=None if payload is None else json.dumps(payload).encode(), method=method, headers={'Content-Type':'application/json','Authorization':'token '+token})
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
        if isinstance(result, dict) and isinstance(result.get('code'),str) and re.fullmatch(r'[a-z_]{1,64}', result.get('code','')): metadata['code'] = result['code']
        observations=PROOF.setdefault('procedureObservations',[]); assert len(observations)<1024; observations.append(metadata); record(lastProcedure=metadata,procedureObservations=observations)
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


class NativeProxy:
    """No logs/bodies retained; fixed owned native destination, no redirects."""
    def __init__(self,destination,port,project):
        from urllib.parse import urlsplit
        parsed=urlsplit(destination)
        assert parsed.scheme=='http' and parsed.hostname=='127.0.0.1' and parsed.port and parsed.path=='' and not parsed.query and not parsed.fragment and parsed.username is None and parsed.password is None
        assert re.fullmatch(r'golf-rules49-[a-f0-9]{10}',project)
        self.project=project;self.destination=parsed;self.lock=threading.Lock();self.counts={};self.armed=None;self.lost=0;self.failures=0
        owner=self
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def forward(self):
                connection=None
                try:
                    assert self.path.startswith('/api/v1/') and len(self.path)<=4096
                    if self.command!='GET':
                        assert owner.allowed_write(self.command,self.path), 'Unexpected native mutation refused'
                    assert self.headers.get('Transfer-Encoding') is None
                    length=int(self.headers.get('Content-Length','0'));assert 0<=length<=1<<20
                    payload=self.rfile.read(length);assert len(payload)==length
                    headers={k:v for k,v in self.headers.items() if k.lower() not in {'host','connection','proxy-connection','transfer-encoding','content-length','expect'}}
                    headers['Content-Length']=str(length);headers['Connection']='close'
                    connection=http.client.HTTPConnection(owner.destination.hostname,owner.destination.port,timeout=15)
                    connection.request(self.command,self.path,body=payload,headers=headers);response=connection.getresponse();body=response.read((2<<20)+1);assert len(body)<=2<<20
                    drop=owner.observe(self.command,self.path,response.status,body)
                    if drop:
                        self.close_connection=True
                        try:self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:pass
                        return
                    self.send_response(response.status)
                    for k,v in response.getheaders():
                        if k.lower() not in {'connection','transfer-encoding','content-length','server','date'}:self.send_header(k,v)
                    self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close');self.end_headers();self.wfile.write(body);self.close_connection=True
                except Exception:
                    with owner.lock:owner.failures+=1
                    self.close_connection=True
                    try:self.send_error(502,'Owned fixture forwarding unavailable')
                    except OSError:pass
                finally:
                    if connection:connection.close()
            do_GET=do_POST=do_PUT=do_PATCH=do_DELETE=forward
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler);self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
    def allowed_write(self,method,path):
        base=r'/api/v1/repos/'+re.escape(self.project)+r'-(?:owner|org)/[A-Za-z0-9_-]+'
        return (method=='PATCH' and re.fullmatch(base,path) is not None) or (method in {'POST','PATCH','DELETE'} and re.fullmatch(base+r'/(?:branch_protections|tag_protections)(?:/[^/?]+)?',path) is not None)
    def observe(self,method,path,status,body):
        with self.lock:
            if method in {'POST','PATCH','DELETE'}:
                identity=(method,path);self.counts[identity]=self.counts.get(identity,0)+1
            drop=self.armed is not None and self.armed[:2]==(method,path)
            if drop:
                assert status==201
                value=json.loads(body);assert isinstance(value,dict) and value['rule_name']==self.armed[2]
                self.armed=None;self.lost+=1
            return drop
    def start(self):self.thread.start()
    def __enter__(self):self.start();return self
    def __exit__(self,kind,*args):
        try:self.close()
        except Exception:
            record(cleanup='failed',proxyCleanup='failed')
            if kind is None:raise
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=5);assert not self.thread.is_alive()
    def arm(self,method,path,pattern):
        assert method=='POST' and self.allowed_write(method,path) and path.endswith('/branch_protections') and pattern=='unknown/*'
        with self.lock:assert self.armed is None and self.lost==0;self.armed=(method,path,pattern)
    def total(self,repository):
        prefix='/api/v1/repos/'+repository['owner']+'/'+repository['name']
        with self.lock:return sum(n for (_,path),n in self.counts.items() if path==prefix or path.startswith(prefix+'/'))


def operation(row,request,actor,phase):
    assert row['repository']==request['repository'] and row['actorId']==actor['id']
    for field in ('operationId','repositoryId','ownerId','action','expectedAccessRevision','expectedRulesRevision'):assert row[field]==request[field]
    assert row['phase']==phase and re.fullmatch(r'[a-f0-9]{64}',row['inputFingerprint'])
    assert row.get('failureCode','')==('preflight_refused' if phase=='REJECTED' else '')
    assert datetime.datetime.fromisoformat(row['updatedAt'].replace('Z','+00:00'))>=datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00'))
    if phase=='SUCCEEDED':assert re.fullmatch(r'[a-f0-9]{64}',row.get('observedRulesRevision',''))
    else:assert 'observedRulesRevision' not in row
    assert set(row)<={'repository','operationId','repositoryId','ownerId','actorId','action','phase','expectedAccessRevision','expectedRulesRevision','inputFingerprint','observedRulesRevision','createdAt','updatedAt','failureCode'}
    return row


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
    for procedure in ('MutateRepositoryRules','GetRepositoryRuleMutation'):assert 'rpc '+procedure+'(' in source
    for message,fields in {'MutateRepositoryRulesRequest':{'repository_id':2,'owner_id':3,'expected_access_revision':4,'expected_rules_revision':5,'operation_id':6},'GetRepositoryRuleMutationRequest':{'repository_id':2,'owner_id':3,'operation_id':4}}.items():
        body=re.search(r'message '+message+r'\s*\{([^}]+)\}',source).group(1)
        for field,tag in fields.items():assert re.search(r'string\s+'+field+r'\s*=\s*'+str(tag)+r'\s*;',body)
    assert 'REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH = 1;' in source
    proxy=object.__new__(NativeProxy);proxy.project='golf-rules49-0123456789';proxy.lock=threading.Lock();proxy.counts={};proxy.armed=None;proxy.lost=0
    path='/api/v1/repos/'+proxy.project+'-owner/rules/branch_protections';proxy.arm('POST',path,'unknown/*')
    assert not proxy.observe('GET',path,201,b'{}') and proxy.lost==0
    for status,body in ((200,b'{"rule_name":"unknown/*"}'),(201,b'{"rule_name":"wrong"}'),(201,b'{}')):
        try:proxy.observe('POST',path,status,body)
        except (AssertionError,KeyError):pass
        else:raise AssertionError('Invalid native receipt used as accepted response loss')
    assert proxy.lost==0 and proxy.observe('POST',path,201,b'{"rule_name":"unknown/*"}') and proxy.lost==1
    assert not proxy.allowed_write('POST','/api/v1/repos/foreign/rules/branch_protections') and not proxy.allowed_write('POST',path+'?x=1')
    request={'repository':{'owner':'owned','name':'rules'},'repositoryId':'9007199254740993','ownerId':'9','operationId':str(uuid.uuid4()),'action':'REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH','expectedAccessRevision':'a'*64,'expectedRulesRevision':'b'*64}
    row={**request,'actorId':'11','phase':'SUCCEEDED','inputFingerprint':'c'*64,'observedRulesRevision':'d'*64,'createdAt':'2026-10-04T12:00:00Z','updatedAt':'2026-10-04T12:00:01Z'}
    operation(row,request,{'id':'11'},'SUCCEEDED')
    for field in ('operationId','repositoryId','ownerId','actorId','action','expectedAccessRevision','expectedRulesRevision'):
        try:operation({**row,field:'wrong'},request,{'id':'11'},'SUCCEEDED')
        except AssertionError:pass
        else:raise AssertionError('Foreign rule mutation receipt admitted')
    try:operation({**row,'phase':'DISPATCH_UNKNOWN'},request,{'id':'11'},'DISPATCH_UNKNOWN')
    except AssertionError:pass
    else:raise AssertionError('Unknown operation adopted verified revision')
    print('PASS: pure049 wire/int64/whole native projection/operation receipts/real proxy-loss guard/failure preservation; no runtime resources')


def main():
    global OUTPUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-check',action='store_true')
    parser.add_argument('--image',help='Cached explicitly revision-labeled Golf image; never build/pull')
    parser.add_argument('--output',type=Path,help='New owner-only artifact directory')
    parser.add_argument('--ui',action='store_true',help='Actual explicit rule edits and12 theme/width captures')
    args = parser.parse_args()
    if args.self_check: self_check(); return
    if not args.image or not args.output: parser.error('--image and --output are required')
    args.output.mkdir(mode=0o700,parents=True,exist_ok=False); args.output.chmod(0o700); OUTPUT = args.output.resolve(); record(status='running',browser='pending' if args.ui else 'not_requested')
    helper_spec = importlib.util.spec_from_file_location('rules_stack_helpers',ROOT/'scripts/observability-smoke.py')
    helpers = importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helpers)
    environment = {k:v for k,v in os.environ.items() if not k.startswith(('GOLF_','GITEA_','POSTGRES_','COMPOSE_','OTEL_','AWS_','RUSTFS_')) and k != 'DATABASE_URL'}
    def run(*arguments,payload=None,timeout=180):
        result = subprocess.run(arguments,cwd=ROOT,env=environment,input=None if payload is None else json.dumps(payload).encode(),capture_output=True,timeout=timeout)
        assert result.returncode == 0 and len(result.stdout) <= 8<<20 and len(result.stderr) <= 8<<20, 'Private subprocess failed; diagnostics withheld'
        return result.stdout.decode().strip()
    stage('cached images, disk reserve and local browser prerequisite')
    if args.ui: assert (ROOT/'web/node_modules/playwright/index.mjs').is_file()
    info = json.loads(run('docker','image','inspect',args.image))[0]; image = info['Id']; revision = info['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
    assert re.fullmatch(r'sha256:[a-f0-9]{64}',image) and re.fullmatch(r'[a-f0-9]{40}',revision or '')
    for dependency in ('postgres:18.4-alpine3.24','gitea/gitea:1.27.3-rootless'): run('docker','image','inspect',dependency)
    free = run('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','/bin/df',image,'-Pk','/')
    assert int(free.splitlines()[-1].split()[3]) >= 2*1024*1024, 'Require 2 GiB Docker VM reserve'
    project = 'golf-rules49-'+secrets.token_hex(5); ports = helpers.free_ports(3); previous = smoke.GOLF,smoke.GITEA
    smoke.GOLF,smoke.GITEA = 'http://127.0.0.1:'+str(ports[0]),'http://127.0.0.1:'+str(ports[1])
    actors,enrolled,bearers,repositories,orgs = {},[],[],{},{}
    started,passed = False,False; record(project=project,selectedImage=image,sourceRevision=revision)
    with NativeProxy(smoke.GITEA,ports[2],project) as proxy, tempfile.TemporaryDirectory(prefix=project+'-') as temporary:
        directory = Path(temporary); directory.chmod(0o700)
        values = {k:secrets.token_hex(24) for k in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','GITEA_DB_PASSWORD')}
        values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_PUBLIC_URL=smoke.GOLF,GOLF_PUSH_CI_ENABLED='false')
        env_file,override = directory/'proof.env',directory/'proof.yaml'; helpers.private_write(env_file,''.join(k+'='+v+'\n' for k,v in values.items()))
        helpers.private_write(override,f'''services:
  golf:
    image: {image}
    pull_policy: never
    ports: !override ["127.0.0.1:{ports[0]}:8080"]
    environment:
      GITEA_URL: http://host.docker.internal:{ports[2]}
      GITEA_PUBLIC_URL: {smoke.GITEA}
  gitea:
    environment:
      GITEA__server__ROOT_URL: {smoke.GITEA}/
      GITEA__migrations__ALLOWED_DOMAINS: gitea
      GITEA__migrations__ALLOW_LOCALNETWORKS: "true"
    ports: !override ["127.0.0.1:{ports[1]}:3000"]
''')
        compose = ['docker','compose','-p',project,'--env-file',str(env_file),'-f',str(ROOT/'compose.yaml'),'-f',str(override)]
        def command(*arguments,**kwargs): return run(*compose,*arguments,**kwargs)
        def admin(*arguments): return command('exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*arguments)
        def operator(action,payload):
            result = json.loads(command('exec','-T','golf','/usr/local/bin/golf','local-account',action,payload=payload)); assert result['state'] == 'complete'; return result['result']
        def runtime():
            cid = command('ps','-q','golf'); assert re.fullmatch(r'[a-f0-9]{12,64}',cid)
            value = json.loads(run('docker','inspect','--format','{"image":{{json .Image}},"reference":{{json .Config.Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}',cid))
            assert value['image'] == image and value['reference'] == image and value['revision'] == revision
            value['nativeVersion'] = native('', 'GET','version')['version']; assert value['nativeVersion'] == '1.27.3'; return value
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
        def intent(actor,repository,action,**fields):
            target,value=read(actor,repository)
            return {'repository':repository,'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'expectedAccessRevision':target['expectedRevision'],'expectedRulesRevision':value['rulesRevision'],'operationId':str(uuid.uuid4()),'action':'REPOSITORY_RULE_MUTATION_ACTION_'+action,**fields}
        def inspect(actor,request,phase):
            row=rpc(actor['session'],STATUS,{field:request[field] for field in ('repository','repositoryId','ownerId','operationId')})['operation']
            return operation(row,request,actor,phase)
        def change(actor,request,phase='SUCCEEDED'):
            stage('supported Golf '+request['action'].removeprefix('REPOSITORY_RULE_MUTATION_ACTION_').lower()+' and independent native receipt'); record(lastMutationAction=request['action']); count=proxy.total(request['repository']); result=rpc(actor['session'],MUTATE,request)
            row=operation(result['operation'],request,actor,phase)
            assert proxy.total(request['repository'])==count+(1 if phase=='SUCCEEDED' else 0)
            if phase=='SUCCEEDED':
                target,current=read(actor,request['repository']); assert result['currentRules']==current and row['observedRulesRevision']==current['rulesRevision']
            else: assert 'currentRules' not in result
            replay=rpc(actor['session'],MUTATE,request); assert replay=={'operation':row}
            assert inspect(actor,request,phase)==row and proxy.total(request['repository'])==count+(1 if phase=='SUCCEEDED' else 0)
            return result
        def configure(repository,actor,team=None):
            usernames=[actors['owner']['name']]
            b={'ruleName':'main','priority':'9007199254740993','requiredApprovals':'2','enablePush':True,'enablePushWhitelist':True,'pushUsernames':usernames,'pushWhitelistDeployKeys':True,'enableForcePush':True,'enableForcePushAllowlist':True,'forcePushUsernames':usernames,'forcePushAllowlistDeployKeys':True,'enableMergeWhitelist':True,'mergeUsernames':usernames,'enableBypassAllowlist':True,'bypassUsernames':usernames,'enableStatusCheck':True,'statusCheckContexts':['golf/test','golf/security'],'enableApprovalsWhitelist':True,'approvalsUsernames':usernames,'blockOnRejectedReviews':True,'blockOnOfficialReviewRequests':True,'blockOnOutdatedBranch':True,'dismissStaleApprovals':True,'requireSignedCommits':True,'blockAdminMergeOverride':True,'protectedFilePatterns':'src/**','unprotectedFilePatterns':'docs/**'}
            if team:
                for field in ('pushTeams','forcePushTeams','mergeTeams','bypassTeams','approvalsTeams'):b[field]=[team['name']]
            change(actor,intent(actor,repository,'CREATE_BRANCH',ruleName='main',desiredBranch=b))
            change(actor,intent(actor,repository,'EDIT_BRANCH',ruleName='main',desiredBranch={**b,'requiredApprovals':'3'}))
            minimal={'ruleName':'release/*','priority':'2','requiredApprovals':'0'}
            change(actor,intent(actor,repository,'CREATE_BRANCH',ruleName='release/*',desiredBranch=minimal))
            change(actor,intent(actor,repository,'REMOVE_BRANCH',ruleName='release/*'))
            for pattern in ('v*','release-*'):
                t={'namePattern':pattern,'allowedUsernames':usernames,'allowedTeams':[team['name']] if team else []}
                change(actor,intent(actor,repository,'CREATE_TAG',desiredTag=t))
            _,value=read(actor,repository); tag=next(row for row in value['tagProtections'] if row['namePattern']=='v*')
            t={'namePattern':'v*','allowedUsernames':usernames+[actors['direct']['name']],'allowedTeams':[team['name']] if team else []}
            change(actor,intent(actor,repository,'EDIT_TAG',tagId=tag['id'],desiredTag={'namePattern':'v*'}))
            _,cleared=read(actor,repository);empty=next(row for row in cleared['tagProtections'] if row['id']==tag['id']);assert not empty.get('allowedUsernames',[]) and not empty.get('allowedTeams',[])
            change(actor,intent(actor,repository,'EDIT_TAG',tagId=tag['id'],desiredTag=t))
            _,value=read(actor,repository); tag=next(row for row in value['tagProtections'] if row['namePattern']=='release-*')
            change(actor,intent(actor,repository,'REMOVE_TAG',tagId=tag['id']))
            m={'allowMergeCommits':True,'allowRebaseExplicit':True,'allowSquashMerge':True,'autodetectManualMerge':True,'allowMergeUpdate':True,'defaultMergeStyle':'squash','defaultUpdateStyle':'merge','defaultDeleteBranchAfterMerge':True}
            last=intent(actor,repository,'EDIT_MERGE',desiredMerge=m);change(actor,last);return last
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
            known_request=configure(personal,owner); target,initial = read(owner,personal); assert len(initial['branchProtections']) == 1 and len(initial['tagProtections']) == 1
            direct_b={'ruleName':'direct/*','priority':'1','requiredApprovals':'0'}; change(actors['direct'],intent(actors['direct'],personal,'CREATE_BRANCH',ruleName='direct/*',desiredBranch=direct_b)); change(actors['direct'],intent(actors['direct'],personal,'REMOVE_BRANCH',ruleName='direct/*'))
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
            configure(organization,owner,admins); read(owner,organization); read(actors['memberdirect'],organization)
            direct_b={'ruleName':'member-direct/*','priority':'1','requiredApprovals':'0'}; change(actors['memberdirect'],intent(actors['memberdirect'],organization,'CREATE_BRANCH',ruleName='member-direct/*',desiredBranch=direct_b)); change(actors['memberdirect'],intent(actors['memberdirect'],organization,'REMOVE_BRANCH',ruleName='member-direct/*'))
            rpc(actors['team']['session'],SERVICE,access(actors['team'],organization),expected=403)
            record(authorityMatrix='passed')
            stage('current individual role and operation-boundary denial')
            denied=intent(owner,personal,'CREATE_BRANCH',ruleName='denied/*',desiredBranch={'ruleName':'denied/*','priority':'0','requiredApprovals':'0'})
            before_count=proxy.total(personal)
            for role in ('reader','global'):
                rpc(actors[role]['session'],MUTATE,{**denied,'operationId':str(uuid.uuid4())},expected=403)
                rpc(actors[role]['session'],STATUS,{field:denied[field] for field in ('repository','repositoryId','ownerId','operationId')},expected=403)
            rpc(actors['outsider']['session'],MUTATE,denied,expected=404)
            org_denied=intent(owner,organization,'CREATE_BRANCH',ruleName='denied/*',desiredBranch=denied['desiredBranch'])
            rpc(actors['team']['session'],MUTATE,org_denied,expected=403)
            direct=intent(actors['direct'],personal,'CREATE_BRANCH',ruleName='denied/*',desiredBranch=denied['desiredBranch'])
            native(owner['token'],'PUT',path+'/collaborators/'+actors['direct']['name'],{'permission':'read'},204)
            rpc(actors['direct']['session'],MUTATE,direct,expected=403); native(owner['token'],'PUT',path+'/collaborators/'+actors['direct']['name'],{'permission':'admin'},204)
            assert proxy.total(personal)==before_count
            stage('serial whole/access drift rejects before supported write')
            stale=intent(owner,personal,'CREATE_BRANCH',ruleName='stale/*',desiredBranch={'ruleName':'stale/*','priority':'0','requiredApprovals':'0'})
            native(owner['token'],'PATCH',path+'/branch_protections/main',{'required_approvals':4})
            change(owner,stale,'REJECTED')
            stale_access=intent(owner,personal,'CREATE_BRANCH',ruleName='stale-access/*',desiredBranch={'ruleName':'stale-access/*','priority':'0','requiredApprovals':'0'})
            native(owner['token'],'PUT',path+'/collaborators/'+actors['reader']['name'],{'permission':'write'},204)
            change(owner,stale_access,'REJECTED'); native(owner['token'],'PUT',path+'/collaborators/'+actors['reader']['name'],{'permission':'read'},204)
            for field in ('repositoryId','ownerId'):
                rpc(owner['session'],MUTATE,{**intent(owner,personal,'CREATE_BRANCH',ruleName='wrong/*',desiredBranch={'ruleName':'wrong/*','priority':'0','requiredApprovals':'0'}),field:'9223372036854775807'},expected=400,code='failed_precondition')
            record(staleObservationFences='passed',knownReplayNoNativeWrite='passed')
            stage('archive and actual mirror refuse configuration writes')
            native(owner['token'],'PATCH',path,{'archived':True}); archived_intent=intent(owner,personal,'CREATE_BRANCH',ruleName='archive/*',desiredBranch={'ruleName':'archive/*','priority':'0','requiredApprovals':'0'})
            archive_count=proxy.total(personal);rpc(owner['session'],MUTATE,archived_intent,expected=400,code='failed_precondition');inspect(owner,archived_intent,'REJECTED');assert proxy.total(personal)==archive_count
            native(owner['token'],'PATCH',path,{'archived':False})
            mirror=native(owner['token'],'POST','repos/migrate',{'clone_addr':'http://gitea:3000/'+owner['name']+'/rules.git','repo_owner':owner['name'],'repo_name':'rules-mirror','service':'git','mirror':True,'private':True,'auth_username':owner['name'],'auth_password':owner['token'],'mirror_interval':'168h'},201)
            repositories[mirror['full_name']]=(mirror['id'],mirror['owner']['id']);assert mirror['mirror'] is True;mirror_key={'owner':owner['name'],'name':'rules-mirror'}
            mirror_intent=intent(owner,mirror_key,'CREATE_BRANCH',ruleName='mirror/*',desiredBranch={'ruleName':'mirror/*','priority':'0','requiredApprovals':'0'})
            mirror_count=proxy.total(mirror_key);rpc(owner['session'],MUTATE,mirror_intent,expected=400,code='failed_precondition');inspect(owner,mirror_intent,'REJECTED');assert proxy.total(mirror_key)==mirror_count
            record(archivedAndMirrorWriteRefusals='passed')
            if args.ui:
                stage('actual canonical requested rule editor and verified receipt')
                target,current=read(owner,personal)
                config={'golf':smoke.GOLF,'repository':owner['name']+'/rules','target':target,'email':owner['email'],'password':owner['password'],'actorId':owner['id'],'screenshots':str(OUTPUT),'stackRoot':str(ROOT),'runtime':before}
                browser=subprocess.run(['node',str(ROOT/'scripts/repository-rule-mutations-browser.mjs')],cwd=ROOT,input=json.dumps(config).encode(),capture_output=True,timeout=360)
                proof=json.loads((OUTPUT/'browser-manifest.json').read_text());record(browser=proof['status'],captures=proof['captures'],browserFailedStage=proof.get('failedStage'),browserProcedureStatusCounts=proof.get('procedureStatusCounts',{}))
                assert browser.returncode==0 and proof['status']=='browser_checks_passed_parent_cleanup_pending' and len(proof['captures'])==12 and proof['runtime']==before,'Browser proof failed; safe staged manifest retained'
                target,current=read(owner,personal)
                for accepted in proof['acceptedRules']:
                    rule=next(row for row in current['branchProtections'] if row['ruleName']==accepted['pattern']);assert rule.get('requiredApprovals','0')==accepted['requiredApprovals'] and rule['priority']=='0'
            stage('real accepted native write loses response; unknown is inspection-only')
            unknown_repo=create_repository(owner,'unknown-rules');u_path='repos/'+unknown_repo['owner']+'/'+unknown_repo['name'];native(owner['token'],'PUT',u_path+'/collaborators/'+actors['direct']['name'],{'permission':'admin'},204)
            unknown=intent(owner,unknown_repo,'CREATE_BRANCH',ruleName='unknown/*',desiredBranch={'ruleName':'unknown/*','priority':'0','requiredApprovals':'0'})
            count=proxy.total(unknown_repo);proxy.arm('POST','/api/v1/'+u_path+'/branch_protections','unknown/*')
            result=rpc(owner['session'],MUTATE,unknown);unknown_receipt=operation(result['operation'],unknown,owner,'DISPATCH_UNKNOWN');assert 'currentRules' not in result
            assert proxy.lost==1 and proxy.total(unknown_repo)==count+1 and any(row['rule_name']=='unknown/*' for row in native(owner['token'],'GET',u_path+'/branch_protections'))
            assert inspect(owner,unknown,'DISPATCH_UNKNOWN')==unknown_receipt
            assert rpc(owner['session'],MUTATE,unknown)=={'operation':unknown_receipt}
            replacement_intent=intent(owner,unknown_repo,'CREATE_BRANCH',ruleName='replacement/*',desiredBranch={'ruleName':'replacement/*','priority':'0','requiredApprovals':'0'})
            rpc(owner['session'],MUTATE,replacement_intent,expected=400,code='failed_precondition')
            other_intent=intent(actors['direct'],unknown_repo,'CREATE_BRANCH',ruleName='other-actor/*',desiredBranch={'ruleName':'other-actor/*','priority':'0','requiredApprovals':'0'});rpc(actors['direct']['session'],MUTATE,other_intent,expected=400,code='failed_precondition')
            lifecycle=rpc(owner['session'],'RepositoryLifecycleService/GetRepositoryLifecycle',{'repository':unknown_repo,'repositoryId':unknown['repositoryId']})['lifecycle'];assert int(lifecycle['activeWorkCount'])>=1 and not lifecycle.get('archiveAvailable',False)
            archive={'repository':unknown_repo,'repositoryId':unknown['repositoryId'],'ownerId':unknown['ownerId'],'expectedRevision':lifecycle['revision'],'archived':True,'confirmationName':unknown_repo['owner']+'/'+unknown_repo['name'],'currentPassword':owner['password'],'idempotencyKey':str(uuid.uuid4())}
            refused_archive=rpc(owner['session'],'RepositoryLifecycleService/ChangeRepositoryArchiveState',archive)['operation'];assert refused_archive['phase']=='REJECTED' and refused_archive['failureCode']=='preflight_refused' and refused_archive['actorId']==owner['id'] and refused_archive.get('fromArchived',False) is False and refused_archive['toArchived'] is True
            for field in ('repository','repositoryId','ownerId','expectedRevision','idempotencyKey'):assert refused_archive[field]==archive[field]
            assert native(owner['token'],'GET',u_path)['archived'] is False and proxy.total(unknown_repo)==count+1
            command('restart','golf');smoke.ready();assert inspect(owner,unknown,'DISPATCH_UNKNOWN')==unknown_receipt and rpc(owner['session'],MUTATE,unknown)=={'operation':unknown_receipt};assert proxy.total(unknown_repo)==count+1
            record(nativeAcceptedResponseLoss='passed',unknownOriginalReplayStatusRestart='passed',unknownReplacementArchiveBlocked='passed')
            target,current=read(owner,personal)
            stage('native rename/replacement refuses historical target')
            renamed = native(owner['token'],'PATCH',path,{'name':'rules-renamed'}); assert str(renamed['id']) == target['repositoryId']; repositories.pop(owner['name']+'/rules'); repositories[renamed['full_name']] = (renamed['id'],renamed['owner']['id'])
            replacement = create_repository(owner,'rules'); assert str(repositories[owner['name']+'/rules'][0]) != target['repositoryId']; rpc(owner['session'],SERVICE,target,expected=400,code='failed_precondition')
            original_status={field:known_request[field] for field in ('repository','repositoryId','ownerId','operationId')};rpc(owner['session'],STATUS,original_status,expected=400,code='failed_precondition')
            historical={**denied,'repositoryId':target['repositoryId'],'ownerId':target['ownerId'],'operationId':str(uuid.uuid4())};rpc(owner['session'],MUTATE,historical,expected=400,code='failed_precondition')
            replacement_target,replacement_empty = read(owner,replacement); assert not replacement_empty.get('branchProtections',[]) and not replacement_empty.get('tagProtections',[])
            stage('all mutation/read/status Origin/bearer/logout boundaries')
            renamed_key={'owner':owner['name'],'name':'rules-renamed'};renamed_target,_=read(owner,renamed_key)
            boundary=intent(owner,renamed_key,'CREATE_BRANCH',ruleName='boundary/*',desiredBranch={'ruleName':'boundary/*','priority':'0','requiredApprovals':'0'})
            status_target={field:boundary[field] for field in ('repository','repositoryId','ownerId','operationId')}
            credential=rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':'Rules boundary'});bearers.append((owner,credential['credential']['id']))
            for procedure,payload in ((SERVICE,renamed_target),(MUTATE,boundary),(STATUS,status_target)):
                rpc(owner['session'],procedure,payload,headers={'Origin':'https://other.invalid'},expected=403)
                rpc(smoke.client(),procedure,payload,headers={'Authorization':'Bearer '+credential['token']},expected=403)
            rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']});bearers.clear()
            rpc(owner['session'],'SessionService/Logout');owner['loggedIn']=False
            for procedure,payload in ((SERVICE,renamed_target),(MUTATE,boundary),(STATUS,status_target)):rpc(owner['session'],procedure,payload,expected=401)
            record(allProcedureBoundaryDenials='passed',proxyFailures=proxy.failures);assert proxy.failures==0
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
            finally: smoke.GOLF,smoke.GITEA = previous; record(cleanup='failed' if failures else 'passed',cleanupFailureCategories=failures)
            if failures and passed: record(failedStage='owned fixture cleanup')
            if failures:
                if not passed: record(originalFailurePreserved=True)
                else: raise AssertionError('Owned fixture cleanup incomplete; fresh project removal attempted')
            print('Cleanup: owned native repositories/org/users purged, managed sessions/bearers revoked/accounts disabled, fresh Compose volumes/network/containers removed.',flush=True)
    assert passed; record(status='qualified',browser='qualified' if args.ui else 'not_requested')
    print('PASS: actual once-only Rules configuration, independent full supported-native readbacks, original uncertain receipt/no replay and12 optional actual UI captures; no native CAS, protected merge or full Rules readiness')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        frames = traceback.extract_tb(error.__traceback__); frame = next((f for f in reversed(frames) if f.filename == __file__),frames[-1])
        try: record(status='failed',failedStage=PROOF.get('failedStage',STAGE),failureType=type(error).__name__,failureLine=frame.lineno)
        except Exception: pass
        print('Rules qualifier failed at '+PROOF.get('failedStage',STAGE)+'; '+type(error).__name__+'; line '+str(frame.lineno)+'; private diagnostics withheld',file=sys.stderr); sys.exit(1)
