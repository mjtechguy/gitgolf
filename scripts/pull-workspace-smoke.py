#!/usr/bin/env python3
"""Qualify PR Commits/Checks with private-fork fixtures on the actual local stack.

Uses only supported native APIs/admin user commands; no DB/repository writes,
workflow execution or model calls. Credentials remain in memory. Purges fixtures.
"""
import base64
import importlib.util
import json
import secrets
import subprocess
import sys
import time
import urllib.request
import urllib.error

sys.dont_write_bytecode = True
from smoke import ROOT, GOLF, admin, client, ready, rpc
spec = importlib.util.spec_from_file_location('organization_smoke', ROOT / 'scripts/organizations-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
provider = helpers.provider

BROWSER = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
let browser,context,config,stage='initialization';
function check(x){if(!x)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});
 const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 stage='session';const auth=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithGiteaToken',{headers,data:{token:config.token}});check(auth.status()===200);
 const page=await context.newPage(),errors=[];page.on('pageerror',()=>errors.push(true));
 for(const theme of ['dark','light'])for(const width of [1280,390])for(const view of ['commits','checks']){
  stage=view+' '+theme+' '+width;
  await page.setViewportSize({width,height:900});await page.goto(config.golf+'/'+config.repository+'/pull/'+config.number+'/'+view);
  if(view==='commits'){await page.getByRole('link',{name:'Second feature commit',exact:true}).waitFor();check(await page.locator('.commit-list>li').count()===2);}
  else {await page.getByRole('cell',{name:'Pending',exact:true}).waitFor();check(await page.getByRole('cell',{name:'Failure',exact:true}).count()===1);check(await page.getByRole('cell',{name:'Success',exact:true}).count()===1);}
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(config.screenshots,'native-pr-'+view+'-'+theme+'-'+width+'.png'),fullPage:true});
 }
 stage='permission revocation';await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.reader,{headers:{Authorization:'token '+config.ownerToken}}).then(r=>check(r.status()===204));
 stage='live revoked row removal';await page.getByRole('cell',{name:'Pending',exact:true}).waitFor({state:'detached',timeout:15000});
 stage='revocation alert';await page.getByRole('alert').first().waitFor();stage='revoked row cleanup';for(const state of ['Pending','Failure','Success'])check(await page.getByRole('cell',{name:state,exact:true}).count()===0);
 stage='page runtime errors';check(errors.length===0);console.log('PASS: production-served PR commits/checks, exact links, dark/light/mobile and revoked-access cleanup');
}catch{console.error('PR workspace browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally{
 if(context&&config)try{const r=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(r.status()===200);}catch{console.error('Browser session cleanup failed');process.exitCode=1;}
 await browser?.close();
}
'''


def main():
    ready()
    prefix='golf-workspace-'+secrets.token_hex(5)
    users, actors, repositories=[],{},[]
    try:
        for role in ['owner','author','reader','outsider']:
            name=prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password',
                  '--random-password-length','32','--must-change-password=false')
            users.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,
                        '--scopes','write:user,write:repository','--raw').strip()
            read=admin('generate-access-token','--username',name,'--token-name',prefix+'-read',
                       '--scopes','read:user,read:repository','--raw').strip()
            session=client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':read})
            actors[role]={'name':name,'token':token,'read':read,'session':session}
        owner,author,reader,outsider=[actors[r] for r in ['owner','author','reader','outsider']]
        repo=provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},expected=201)
        full=repo['full_name'];route='repos/'+full;repositories.append((owner['token'],full))
        key={'owner':owner['name'],'name':'private'}
        for actor in [author,reader]:provider(owner['token'],'PUT',route+'/collaborators/'+actor['name'],{'permission':'write'},expected=204)
        fork=provider(author['token'],'POST',route+'/forks',{},expected=202);fork_route='repos/'+fork['full_name']
        repositories.append((author['token'],fork['full_name']))
        provider(owner['read'],'GET',fork_route,expected=404)
        branch='feature/example';provider(author['token'],'POST',fork_route+'/branches',{'new_branch_name':branch},expected=201)
        content=provider(author['token'],'POST',fork_route+'/contents/feature.txt',{
            'branch':branch,'message':'First feature commit','content':base64.b64encode(b'first\n').decode()},expected=201)
        content=provider(author['token'],'PUT',fork_route+'/contents/feature.txt',{
            'branch':branch,'sha':content['content']['sha'],'message':'Second feature commit','content':base64.b64encode(b'second\n').decode()})
        head=content['commit']['sha']
        pull=provider(author['token'],'POST',route+'/pulls',{'head':author['name']+':'+branch,'base':repo['default_branch'],'title':'Private workspace qualification'},expected=201)
        request={'repository':key,'number':pull['number']}
        def call(actor,method,payload,expected=200,code=None):
            return rpc(actor['session'],'RepositoryService/'+method,payload,expected=expected,code=code)
        def selected():
            observed=call(owner,'GetPullRequest',request)['pullRequest']
            return {**request,'repositoryId':str(repo['id']),'pullRequestId':observed['id'],
                    'baseCommitId':observed['base']['commitId'],'headCommitId':observed['head']['commitId']}
        selection=selected();assert selection['headCommitId']==head
        def wait_retained(selected_head):
            # Native source metadata can advance before its retained ref is
            # imported. Observe that supported read; never resend a mutation.
            deadline=time.monotonic()+20
            retained_route=route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false'
            while True:
                rows=provider(owner['read'],'GET',retained_route)
                if rows and rows[0]['sha']==selected_head:return
                assert time.monotonic()<deadline,'Native retained head did not advance'
                time.sleep(.25)
        def settled(actor,method,payload):
            # Only retry an observation refused as stale while native hooks
            # settle. The selected IDs/commits never change in this retry.
            deadline=time.monotonic()+20
            while True:
                req=urllib.request.Request(GOLF+'/rpc/golf.v1.RepositoryService/'+method,
                    data=json.dumps(payload).encode(),method='POST',headers={'Origin':GOLF,'Content-Type':'application/json','Connect-Protocol-Version':'1'})
                try:response=actor['session'].open(req,timeout=15)
                except urllib.error.HTTPError as error:response=error
                with response:
                    assert response.headers.get('Cache-Control')=='no-store'
                    result=json.loads(response.read())
                    if response.status==200:return result
                    assert response.status==400 and result['code']=='failed_precondition','Unexpected observation refusal'
                assert time.monotonic()<deadline,'Native comparison did not settle'
                time.sleep(.25)
        def paginated(actor,method,field,settling=False):
            rows=[];number=1
            for _ in range(10):
                result=(settled if settling else call)(actor,method,{'selection':selection,'page':{'limit':1,'page':number}})
                assert result['selection']==selection
                part=result.get(field,[]);assert len(part)<=1;rows+=part
                following=result.get('page',{}).get('nextPage',0)
                if not following:return rows
                assert following==number+1;number=following
            raise AssertionError('Pagination did not terminate')
        commits=paginated(owner,'ListPullRequestCommits','commits')
        assert len(commits)==2 and {c['message'].strip() for c in commits}=={'First feature commit','Second feature commit'}
        assert len({c['sha'] for c in commits})==2 and head in {c['sha'] for c in commits}
        diff=call(owner,'GetPullRequestDiff',{**request,'repositoryId':selection['repositoryId'],'pullRequestId':selection['pullRequestId'],'baseCommitId':selection['baseCommitId'],'headCommitId':head})
        assert diff['headCommitId']==head and '+second' in diff['rawDiff']
        provider(owner['read'],'GET',fork_route,expected=404)
        print('PASS: private-fork commits paginate; base-only reader can read retained comparison and diff without source access',flush=True)
        status_route=route+'/statuses/'+head
        for context,state in [('ci/build','pending'),('ci/build','success'),('review/security','failure'),('deploy/preview','pending')]:
            provider(owner['token'],'POST',status_route,{'context':context,'state':state,'description':'Disposable reported status','target_url':'https://example.invalid/check'},expected=201)
        checks=paginated(reader,'ListPullRequestChecks','checks')
        assert len(checks)==3
        assert {c['context']:c['state'] for c in checks}=={'ci/build':'REPORTED_CHECK_STATE_SUCCESS','review/security':'REPORTED_CHECK_STATE_FAILURE','deploy/preview':'REPORTED_CHECK_STATE_PENDING'}
        assert len({c['id'] for c in checks})==3
        print('PASS: latest status per context across explicit pages; mixed results remain observations, not aggregate readiness',flush=True)
        for method in ['ListPullRequestCommits','ListPullRequestChecks']:
            payload={'selection':selection}
            call(outsider,method,payload,404)
            rpc(client(),'RepositoryService/'+method,payload,expected=401)
            call(owner,method,{'selection':{**selection,'pullRequestId':str(int(selection['pullRequestId'])+1)}},400,'failed_precondition')
        credential=rpc(owner['session'],'ApiCredentialService/CreateApiCredential',{'label':prefix,'lifetimeSeconds':300})
        for method in ['ListPullRequestCommits','ListPullRequestChecks']:
            result=rpc(client(),'RepositoryService/'+method,{'selection':selection},headers={'Authorization':'Bearer '+credential['token']})
            assert result['selection']==selection
            rpc(client(),'RepositoryService/'+method,{'selection':selection},headers={'Origin':'https://foreign.invalid'},expected=403)
        rpc(client(),'SessionService/Logout',headers={'Authorization':'Bearer '+credential['token']},expected=403)
        rpc(owner['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':credential['credential']['id']})
        restricted=admin('generate-access-token','--username',owner['name'],'--token-name',prefix+'-no-repo','--scopes','read:user','--raw').strip()
        limited=client()
        try:
            rpc(limited,'SessionService/LoginWithGiteaToken',{'token':restricted})
            for method in ['ListPullRequestCommits','ListPullRequestChecks']:
                rpc(limited,'RepositoryService/'+method,{'selection':selection},expected=403)
        finally:rpc(limited,'SessionService/Logout')
        print('PASS: read-only Golf API delegation, missing repository scope, foreign Origin and management refusal',flush=True)
        # Current comparison selection must not silently follow an advanced head.
        changed=provider(author['token'],'PUT',fork_route+'/contents/feature.txt',{
            'branch':branch,'sha':content['content']['sha'],'message':'Advance source','content':base64.b64encode(b'advanced\n').decode()})
        deadline=time.monotonic()+20
        while selected()['headCommitId']!=changed['commit']['sha']:
            assert time.monotonic()<deadline,'Native head observation did not advance';time.sleep(.25)
        for method in ['ListPullRequestCommits','ListPullRequestChecks']:call(owner,method,{'selection':selection},400,'failed_precondition')
        selection=selected();wait_retained(selection['headCommitId']);assert not settled(owner,'ListPullRequestChecks',{'selection':selection}).get('checks',[])
        provider(author['token'],'DELETE',fork_route+'/branches/feature%2Fexample',expected=204)
        selection=selected();wait_retained(selection['headCommitId']);assert len(paginated(owner,'ListPullRequestCommits','commits',settling=True))==3
        assert not settled(owner,'ListPullRequestChecks',{'selection':selection}).get('checks',[])
        print('PASS: stale head refused; new head does not inherit old checks; deleted source branch retains readable PR history',flush=True)
        # Keep production browser fixture at two commits with mixed checks: use
        # the first retained PR in a second PR branch, without executing CI.
        provider(author['token'],'POST',fork_route+'/branches',{'new_branch_name':'browser','old_ref_name':head},expected=201)
        browser_pull=provider(author['token'],'POST',route+'/pulls',{'head':author['name']+':browser','base':repo['default_branch'],'title':'Browser workspace qualification'},expected=201)
        screenshots=ROOT/'.tmp/pull-workspace-smoke';screenshots.mkdir(parents=True,exist_ok=True)
        config={'golf':GOLF,'gitea':helpers.GITEA,'token':reader['read'],'ownerToken':owner['token'],
                'reader':reader['name'],'repository':full,'number':browser_pull['number'],'screenshots':str(screenshots)}
        result=subprocess.run(['node','--input-type=module','-e',BROWSER],input=json.dumps(config),cwd=ROOT,text=True,capture_output=True,timeout=120)
        assert result.returncode==0,result.stderr;print(result.stdout.strip(),flush=True)
        for method in ['ListPullRequestCommits','ListPullRequestChecks']:call(reader,method,{'selection':selection},404)
    finally:
        failures=[]
        for actor in actors.values():
            try:rpc(actor['session'],'SessionService/Logout')
            except Exception:failures.append('session')
        for token,full in reversed(repositories):
            try:provider(token,'DELETE','repos/'+full,expected=204)
            except Exception:failures.append('repository')
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:failures.append('user')
        assert not failures,'Fixture cleanup failed; private diagnostics withheld'
        print('CLEANUP: disposable private repositories/users and sessions purged',flush=True)

if __name__=='__main__':main()
