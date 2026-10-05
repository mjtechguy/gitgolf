#!/usr/bin/env python3
"""Bounded native standard merge qualifier on an externally owned fresh stack.

Supported native fixture APIs/CLI only. Never builds/pulls/starts stacks. One
ordinary writer merge, optional browser confirmation and explicit core restart.
Protected/fork integration, atomic base/checks and fault recovery remain open.
"""
import argparse
import ast
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import uuid
sys.dont_write_bytecode = True

SUBMIT='StandardPullMergeService/SubmitStandardPullMerge'
GET='StandardPullMergeService/GetStandardPullMergeOperation'
CONTRACT='golf.pull.standard-native-merge.v1'
PHASES={'STANDARD_PULL_MERGE_PHASE_'+x for x in ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')}


def load_common(stack):
    spec=importlib.util.spec_from_file_location('merge_observation_fixture',stack/'scripts/pull-merge-observation-smoke.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.RPC_PROCEDURES=module.RPC_PROCEDURES|frozenset((SUBMIT,GET))
    return module


def allowed(common,method,path,prefix):
    if common.native_path_allowed(method,path,prefix):return True
    base=r'repos/'+re.escape(prefix)+r'-[a-z]+/private/'
    return method=='GET' and re.fullmatch(base+r'git/commits/[a-f0-9]{40}(?:[a-f0-9]{24})?',path) is not None


def status_request(intent):
    s=intent['selection']
    return {'repository':s['repository'],'repositoryId':s['repositoryId'],'ownerId':intent['ownerId'],'pullRequestId':s['pullRequestId'],'number':s['number'],'operationId':intent['operationId']}


def validate_receipt(common,row,intent,actor,phase):
    s=intent['selection'];assert row['phase']==phase and phase in PHASES
    for key,value in {'operationId':intent['operationId'],'actorId':actor,'repository':s['repository'],'repositoryId':s['repositoryId'],'ownerId':intent['ownerId'],'pullRequestId':s['pullRequestId'],'number':s['number'],'expectedPullRevision':intent['expectedPullRevision'],'headCommitId':s['headCommitId'],'observedBaseCommitId':s['baseCommitId'],'sourceRef':intent['sourceRef'],'targetRef':intent['targetRef'],'method':'merge','contract':CONTRACT}.items():assert row[key]==value
    for key in ('createdAt','updatedAt'):assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z',row[key])
    if phase.endswith('_SUCCEEDED'):
        assert common.OID.fullmatch(row['mergeCommitId']) and common.OID.fullmatch(row['actualBaseCommitId']) and len(row['mergeCommitId'])==len(s['headCommitId'])==len(row['actualBaseCommitId']) and not row.get('failureCode')
    else:
        assert not row.get('mergeCommitId') and not row.get('actualBaseCommitId')
        assert row.get('failureCode','')==('preflight_refused' if phase.endswith('_REJECTED') else '')
    return row


def callable_bindings_safe(source):
    names={'command','rpc','api','admin','operator'}
    return not any(isinstance(n,ast.Name) and isinstance(n.ctx,ast.Store) and n.id in names for n in ast.walk(ast.parse(source)))


def self_check(stack):
    assert callable_bindings_safe(Path(__file__).read_text())
    assert not callable_bindings_safe('def command(): pass\ncommand = {}\n')
    common=load_common(stack);prefix='golf-mergeobs-'+'a'*10
    assert allowed(common,'GET','repos/'+prefix+'-owner/private/git/commits/'+'a'*40,prefix)
    for method,path in [('POST','repos/'+prefix+'-owner/private/pulls/1/merge'),('GET','repos/foreign/private/git/commits/'+'a'*40),('PUT','repos/'+prefix+'-owner/private/git/refs/heads/main')]:assert not allowed(common,method,path,prefix)
    intent={'selection':{'repository':{'owner':'owner','name':'private'},'repositoryId':'1','pullRequestId':'2','number':1,'headCommitId':'a'*40,'baseCommitId':'b'*40},'ownerId':'3','operationId':str(uuid.uuid4()),'expectedPullRevision':'c'*64,'sourceRef':'feature/slash','targetRef':'main'}
    row={**status_request(intent),'actorId':'4','expectedPullRevision':intent['expectedPullRevision'],'headCommitId':'a'*40,'observedBaseCommitId':'b'*40,'sourceRef':'feature/slash','targetRef':'main','phase':'STANDARD_PULL_MERGE_PHASE_SUCCEEDED','mergeCommitId':'d'*40,'actualBaseCommitId':'b'*40,'createdAt':'2026-10-04T12:00:00Z','updatedAt':'2026-10-04T12:00:01Z','method':'merge','contract':CONTRACT}
    validate_receipt(common,row,intent,'4',row['phase'])
    for field in ('actorId','repositoryId','pullRequestId','operationId','expectedPullRevision','sourceRef','targetRef','contract','headCommitId','observedBaseCommitId','actualBaseCommitId'):
        bad=copy.deepcopy(row);bad[field]='invalid'
        try:validate_receipt(common,bad,intent,'4',row['phase'])
        except (AssertionError,KeyError):pass
        else:raise AssertionError('Changed original receipt admitted')
    rejected={k:v for k,v in row.items() if k not in ('mergeCommitId','actualBaseCommitId')};rejected.update(phase='STANDARD_PULL_MERGE_PHASE_REJECTED',failureCode='preflight_refused');validate_receipt(common,rejected,intent,'4',rejected['phase'])
    rejected['mergeCommitId']='d'*40
    try:validate_receipt(common,rejected,intent,'4',rejected['phase'])
    except AssertionError:pass
    else:raise AssertionError('Rejection invented native effect')
    print('PASS: original receipt/tamper, closed native fixture paths and no native merge bypass; no runtime')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--self-check',action='store_true');p.add_argument('--stack-root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--project');p.add_argument('--compose-file',type=Path);p.add_argument('--env-file',type=Path);p.add_argument('--image');p.add_argument('--source-revision');p.add_argument('--golf-url');p.add_argument('--native-url');p.add_argument('--output',type=Path);p.add_argument('--browser',action='store_true');p.add_argument('--restart',action='store_true',help='Explicitly restart only the validated root-owned Golf service after success')
    args=p.parse_args();stack=args.stack_root.resolve();common=load_common(stack)
    if args.self_check:return self_check(stack)
    assert all((args.project,args.compose_file,args.env_file,args.image,args.source_revision,args.golf_url,args.native_url,args.output))
    assert common.PROJECT.fullmatch(args.project) and re.fullmatch(r'sha256:[a-f0-9]{64}',args.image) and re.fullmatch(r'[a-f0-9]{40}',args.source_revision)
    golf,native=common.loopback(args.golf_url),common.loopback(args.native_url)
    assert args.compose_file.is_file() and args.env_file.is_file()
    output=args.output.resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False);output.chmod(0o700)
    compose=['docker','compose','--project-directory',str(stack),'-p',args.project,'-f',str(args.compose_file.resolve()),'--env-file',str(args.env_file.resolve())]
    prefix='golf-mergeobs-'+secrets.token_hex(5);actors={};repos=[];failure=None;cleanup=[];native_unknown=False;stage='runtime preflight'
    manifest={'status':'running','scope':'Standard native unprotected same-repository merge only','project':args.project,'fixturePrefix':prefix,'limits':['No atomic-base/checks/all-writer fence','No protected or fork publication','No accepted-response-loss recovery qualification','Root owns full stack disposal']}
    def persist():
        manifest['actors']=[{k:a[k] for k in ('name','id','created','enrolled') if k in a} for a in actors.values()]
        temp=output/'manifest.next';temp.write_text(json.dumps(manifest,indent=2)+'\n');temp.chmod(0o600);temp.replace(output/'manifest.json')
    def command(argv,payload=None):
        r=subprocess.run(argv,cwd=stack,input=None if payload is None else json.dumps(payload),text=True,capture_output=True,timeout=60)
        assert r.returncode==0 and len(r.stdout)+len(r.stderr)<2<<20
        return r.stdout.strip()
    def admin(*parts):return command(compose+['exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*parts])
    def operator(action,payload):
        r=json.loads(command(compose+['exec','-T','golf','/usr/local/bin/golf','local-account',action],payload));assert r['state']=='complete';return r['result']
    def rpc(actor,procedure,payload=None,status=200,code=None,extra=None):
        r=common.request(actor['session'] if actor else common.client(),'POST',golf+'/rpc/golf.v1.'+procedure,{} if payload is None else payload,{'Origin':golf,'Content-Type':'application/json','Connect-Protocol-Version':'1',**(extra or {})},status)
        if status!=200:assert r['code']==code
        return r
    def api(actor,method,path,payload=None,status=200):
        nonlocal native_unknown
        assert allowed(common,method,path,prefix)
        if method not in ('GET','HEAD'):native_unknown=True
        r=common.request(common.client(),method,native+'/api/v1/'+path,payload,{'Content-Type':'application/json',**({'Authorization':'token '+actor['token']} if actor else {})},status)
        if method not in ('GET','HEAD'):native_unknown=False
        return r
    def runtime_now():
        cid=command(compose+['ps','-q','golf']);assert re.fullmatch(r'[a-f0-9]{64}',cid)
        fmt='{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"configHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}}}'
        row=json.loads(command(['docker','inspect','--format',fmt,cid]));label=command(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',args.image])
        assert row['id']==cid and row['image']==args.image and row['project']==args.project and row['service']=='golf' and row['running'] and label==args.source_revision
        return {**row,'sourceRevision':label}
    def reference(actor,path,ref):return common.exact_ref(api(actor,'GET',path+'/git/refs/heads/'+common.urllib.parse.quote(ref,safe='')),ref)
    def intent(actor,path,target,pull):
        previous=None;stable=0;deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            sample=common.native_pull_metadata(api(actor,'GET',path+'/pulls/'+str(pull['number'])))
            stable=stable+1 if sample==previous else 0;previous=sample
            if stable>=2:break
            time.sleep(.5)
        assert stable>=2
        row=rpc(actor,'RepositoryService/GetPullRequest',{'repository':target,'number':pull['number']})['pullRequest']
        assert row['id']==str(pull['id']) and common.HASH.fullmatch(row['revision'])
        s={'repository':target,'repositoryId':str(repo['id']),'pullRequestId':row['id'],'number':pull['number'],'headCommitId':row['head']['commitId'],'baseCommitId':row['base']['commitId']}
        return {'selection':s,'ownerId':str(repo['owner']['id']),'expectedPullRevision':row['revision'],'operationId':str(uuid.uuid4()),'sourceRef':row['head']['ref'],'targetRef':row['base']['ref'],'commitTitle':'','commitMessage':''}
    def original(actor,m,phase):return validate_receipt(common,rpc(actor,GET,status_request(m))['operation'],m,actor['id'],phase)
    try:
        persist();runtime=runtime_now();manifest['runtimeBefore']=runtime;persist();assert common.request(common.client(),'GET',golf+'/readyz',None,{},200);assert api(None,'GET','version')['version']=='1.27.3'
        stage='ordinary actors and managed enrollment'
        for role in ('owner','author','writer','reader'):
            name=prefix+'-'+role;a={'name':name,'created':False,'enrolled':False,'loggedIn':False,'session':common.client()};actors[role]=a
            api(None,'GET','users/'+name,status=404);native_unknown=True;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');a['created']=True
            row=api(None,'GET','users/'+name);assert row['login']==name;a['id']=str(row['id']);native_unknown=False;persist()
            a['token']=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,read:issue','--raw')
            user=api(a,'GET','user');assert user['id']==int(a['id']) and user['is_admin'] is False
            a.update(email=name+'@golf.invalid',password='Fixture '+secrets.token_urlsafe(24));a['enrolled']=True;operator('create',{'username':name,'email':a['email'],'password':a['password'],'forge_token':a['token'],'is_instance_admin':False})
            assert rpc(a,'SessionService/LoginWithPassword',{'username':a['email'],'password':a['password']})['user']['id']==a['id'];a['loggedIn']=True
        owner,author,writer,reader=[actors[k] for k in actors]
        stage='same-repository source fixtures'
        repo=api(owner,'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);repos.append((owner,repo));target={'owner':owner['name'],'name':'private'};path='repos/'+repo['full_name'];assert repo['full_name']==owner['name']+'/private' and repo['owner']['id']==int(owner['id'])
        deadline=time.monotonic()+45
        while api(owner,'GET',path)['empty']:assert time.monotonic()<deadline;time.sleep(.25)
        for a,permission in ((author,'write'),(writer,'write'),(reader,'read')):api(owner,'PUT',path+'/collaborators/'+a['name'],{'permission':permission},204)
        base_ref=repo['default_branch'];B=reference(owner,path,base_ref)
        for branch in ('feature/slash','protected'):api(owner,'POST',path+'/branches',{'new_branch_name':branch,'old_branch_name':base_ref},201)
        content=api(owner,'POST',path+'/contents/fixture.txt',{'branch':'feature/slash','message':'Owned standard merge fixture','content':base64.b64encode(b'owned standard merge\n').decode()},201);H=content['commit']['sha'];assert H==reference(owner,path,'feature/slash') and H!=B
        def pull(source,base):return api(owner,'POST',path+'/pulls',{'head':source,'base':base,'title':'Owned standard merge fixture','body':'Owned standard merge fixture'},201)
        candidate=pull('feature/slash',base_ref);protected=pull('feature/slash','protected')
        stage='reader refusal leaves original target unchanged'
        reader_intent=intent(reader,path,target,candidate);rpc(reader,SUBMIT,reader_intent,404,'not_found');assert reference(owner,path,base_ref)==B;manifest['readerDenied']=True
        stage='protected refusal leaves target unchanged'
        api(owner,'POST',path+'/branch_protections',{'rule_name':'protected','enable_push':False,'enable_force_push':False,'enable_merge_whitelist':True,'merge_whitelist_usernames':[owner['name']],'block_admin_merge_override':True},201)
        protected_intent=intent(owner,path,target,protected);rejected=validate_receipt(common,rpc(owner,SUBMIT,protected_intent)['operation'],protected_intent,owner['id'],'STANDARD_PULL_MERGE_PHASE_REJECTED');assert reference(owner,path,'protected')==B;manifest['protectedRejected']=rejected;persist()
        stage='fork refusal leaves target unchanged'
        fork=api(author,'POST',path+'/forks',{},202);repos.append((author,fork));fork_path='repos/'+fork['full_name'];assert fork['full_name']==author['name']+'/private'
        deadline=time.monotonic()+45
        while api(author,'GET',fork_path)['empty']:assert time.monotonic()<deadline;time.sleep(.25)
        api(author,'POST',fork_path+'/branches',{'new_branch_name':'fork-feature','old_branch_name':base_ref},201)
        api(author,'POST',fork_path+'/contents/fixture.txt',{'branch':'fork-feature','message':'Owned fork fixture','content':base64.b64encode(b'owned fork\n').decode()},201)
        for a in (owner,writer):api(author,'PUT',fork_path+'/collaborators/'+a['name'],{'permission':'read'},204)
        fork_pull=pull(author['name']+':fork-feature',base_ref);fork_intent=intent(owner,path,target,fork_pull);fork_rejected=validate_receipt(common,rpc(owner,SUBMIT,fork_intent)['operation'],fork_intent,owner['id'],'STANDARD_PULL_MERGE_PHASE_REJECTED');assert reference(owner,path,base_ref)==B;manifest['forkRejected']=fork_rejected;persist()
        stage='one ordinary writer standard native merge'
        m=intent(writer,path,target,candidate);assert m['selection']['headCommitId']==H and m['selection']['baseCommitId']==B and m['sourceRef']=='feature/slash' and m['targetRef']==base_ref
        native_unknown=True  # A Golf/native merge may outlive a lost client ACK.
        if args.browser:
            browser_output=output/'browser';browser_output.mkdir(mode=0o700)
            config={'stackRoot':str(stack),'golf':golf,'repository':repo['full_name'],'repositoryId':str(repo['id']),'ownerId':owner['id'],'actorId':writer['id'],'pullRequestId':m['selection']['pullRequestId'],'number':m['selection']['number'],'expectedPullRevision':m['expectedPullRevision'],'headCommitId':H,'baseCommitId':B,'sourceRef':m['sourceRef'],'targetRef':m['targetRef'],'email':writer['email'],'password':writer['password'],'runtime':runtime,'output':str(browser_output)}
            r=subprocess.run(['node',str(stack/'scripts/standard-pull-merge-browser.mjs')],input=json.dumps(config),cwd=stack,text=True,capture_output=True,timeout=180)
            manifest['browserCommand']={'exitCode':r.returncode,'stdoutBytes':len(r.stdout.encode()),'stderrBytes':len(r.stderr.encode())};persist();assert all(secret not in r.stdout+r.stderr for a in actors.values() for secret in (a['token'],a['password']));assert r.returncode==0
            browser=json.loads((browser_output/'browser-manifest.json').read_text());assert browser['status']=='browser_checks_passed_parent_cleanup_pending' and len(browser['captures'])==4;m['operationId']=browser['original']['operationId'];manifest['browser']=browser
            result=original(writer,m,'STANDARD_PULL_MERGE_PHASE_SUCCEEDED')
        else:
            result=validate_receipt(common,rpc(writer,SUBMIT,m)['operation'],m,writer['id'],'STANDARD_PULL_MERGE_PHASE_SUCCEEDED')
        manifest['originalIntent']=m;manifest['operation']=result;persist()
        stage='independent native merge receipt'
        C=result['mergeCommitId'];native_pr=api(owner,'GET',path+'/pulls/'+str(candidate['number']));assert native_pr['merged'] is True and native_pr['merge_commit_sha']==C and native_pr['head']['sha']==H and native_pr['head']['repo_id']==repo['id']
        commit=api(owner,'GET',path+'/git/commits/'+C);assert commit['sha']==C and [p['sha'] for p in commit['parents']]==[result['actualBaseCommitId'],H] and reference(owner,path,base_ref)==C
        native_unknown=False  # Independent acknowledged final effect is now recorded.
        manifest['nativeReceipt']={'C':C,'H':H,'observedB':B,'actualB':result['actualBaseCommitId'],'parents':[p['sha'] for p in commit['parents']],'targetCommitId':C};persist()
        stage='original replay and changed intent refusal'
        assert validate_receipt(common,rpc(writer,SUBMIT,m)['operation'],m,writer['id'],result['phase'])==result
        changed=copy.deepcopy(m);changed['commitMessage']='Changed original request';rpc(writer,SUBMIT,changed,400,'failed_precondition');assert original(writer,m,result['phase'])==result and reference(owner,path,base_ref)==C
        missing=status_request(m);missing['operationId']=str(uuid.uuid4());rpc(writer,GET,missing,404,'not_found');rpc(reader,GET,status_request(m),404,'not_found');manifest.update(originalReplayExact=True,changedIntentRefused=True,missingOutcomeNotNoEffect=True)
        if args.restart:
            stage='explicit owned core restart original status'
            assert runtime_now()==runtime;command(compose+['restart','golf']);deadline=time.monotonic()+45
            while True:
                try:common.request(common.client(),'GET',golf+'/readyz',None,{},200);break
                except Exception:assert time.monotonic()<deadline;time.sleep(.5)
            assert runtime_now()==runtime and original(writer,m,result['phase'])==result and reference(owner,path,base_ref)==C
            manifest['restartOriginalExact']=True
        manifest['runtimeAfter']=runtime_now();assert manifest['runtimeAfter']==runtime;manifest['status']='checks_passed_cleanup_pending';persist()
    except Exception as e:
        failure={'stage':stage,'type':type(e).__name__,'frames':[]}
        if isinstance(e,common.HTTPContractFailure):failure['http']=e.diagnostic
        trace=e.__traceback__
        while trace:failure['frames'].append({'file':Path(trace.tb_frame.f_code.co_filename).name,'line':trace.tb_lineno});trace=trace.tb_next
        manifest.update(status='failed',failure=failure);persist()
    finally:
        for a in actors.values():
            if a['loggedIn']:
                try:rpc(a,'SessionService/RevokeOtherSessions');rpc(a,'SessionService/Logout')
                except Exception:cleanup.append('managed_session_cleanup')
        for a in reversed(list(actors.values())):
            if a['enrolled']:
                try:assert operator('disable',{'username':a['name']})['disabled']
                except Exception:cleanup.append('managed_account_disable')
        if native_unknown:cleanup.append('native_mutation_unknown_root_disposal_required')
        else:
            for a,row in reversed(repos):
                if native_unknown:break
                try:
                    observed=api(a,'GET','repos/'+row['full_name']);assert observed['id']==row['id'] and observed['full_name']==row['full_name'];api(a,'DELETE','repos/'+row['full_name'],status=204)
                except Exception:cleanup.append('owned_repository_cleanup')
            for a in reversed(list(actors.values())):
                if native_unknown:break
                if a['created']:
                    try:assert str(api(None,'GET','users/'+a['name'])['id'])==a['id'];admin('delete','--username',a['name'],'--purge')
                    except Exception:cleanup.append('owned_native_actor_cleanup')
        manifest['cleanup']={'failures':cleanup,'nativeScopePurged':not cleanup,'stackDisposal':'Root owns resources; no helper stack disposal','retainedGolfMetadata':'Disabled own accounts and journals retained; no Golf data purge claim'}
        if cleanup:manifest['status']='failed'
        elif failure is None:manifest['status']='qualified_bounded_standard_native_merge'
        persist()
    if failure or cleanup:print('FAIL: standard merge qualifier; closed receipt preserved, private diagnostics withheld',file=sys.stderr);return 1
    print('PASS: one standard native same-repository merge and original inspection; protected integration remains open');return 0


if __name__=='__main__':
    try:sys.exit(main() or 0)
    except Exception:print('FAIL: standard merge qualifier preflight; private diagnostics withheld',file=sys.stderr);sys.exit(1)
