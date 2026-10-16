#!/usr/bin/env python3
"""Qualify PR creation/lifecycle using disposable users and supported native APIs.

No workflows/inference or retained account edits. Credentials remain in memory.
This proves observed outcomes and permissions, not atomic title/state writes,
protected merging or latest-schema recovery.
"""
import base64
import json
import subprocess
import secrets
import sys
import uuid
sys.dont_write_bytecode = True
from smoke import ROOT, GOLF, FORGE, admin, client, provider, ready, rpc, wait_for_push


BROWSER = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
let browser,context,config,stage='initialization';
const check=value=>{if(!value)throw Error('qualification assertion')};
try {
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});
 const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 stage='sign-in';const auth=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithForgeToken',{headers,data:{token:config.token}});check(auth.status()===200);
 const page=await context.newPage(),errors=[];page.on('pageerror',()=>errors.push(true));
 stage='compare renamed fork';const search=new URLSearchParams({base:config.baseBranch,head:'feature/browser',sourceOwner:config.sourceOwner,sourceName:config.sourceName});await page.goto(config.golf+'/'+config.repository+'/compare?'+search);await page.getByRole('button',{name:'Compare',exact:true}).click();await page.locator('.diff-file').waitFor();
 for(const theme of ['dark','light'])for(const width of [1280,390]) {
  stage='compare '+theme+' '+width;await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'native-pr-compare-'+theme+'-'+width+'.png'),fullPage:true});
 }
 stage='create browser PR';await page.getByRole('button',{name:'Open pull request',exact:true}).click();await page.getByLabel('Pull request title',{exact:true}).fill('Browser-created proposal');await page.getByLabel('Description, Markdown',{exact:true}).fill('## Browser-created description');await page.getByLabel('Pull request readiness',{exact:true}).selectOption('draft');await page.getByRole('button',{name:'Preview Markdown',exact:true}).click();await page.getByRole('heading',{name:'Browser-created description',exact:true}).waitFor();await page.getByRole('button',{name:'Create draft pull request',exact:true}).click();await page.waitForURL(/\/pull\/[1-9][0-9]*$/);await page.getByRole('heading',{name:/Browser-created proposal/}).waitFor();
 const createdNumber=Number(new URL(page.url()).pathname.split('/').at(-1));const created=await context.request.post(config.golf+'/rpc/golf.v1.RepositoryService/GetPullRequest',{headers,data:{repository:{owner:config.repository.split('/')[0],name:config.repository.split('/')[1]},number:createdNumber}});check(created.status()===200);const createdPull=(await created.json()).pullRequest;check(createdPull.draft===true&&createdPull.head.repositoryId===config.sourceId&&createdPull.head.ref==='feature/browser'&&createdPull.body==='## Browser-created description');
 stage='source private draft';await page.goto(config.golf+'/'+config.repository+'/compare?'+search);await page.getByRole('button',{name:'Compare',exact:true}).click();await page.locator('.diff-file').waitFor();await page.getByRole('button',{name:'Open pull request',exact:true}).click();await page.getByLabel('Description, Markdown',{exact:true}).fill('PRIVATE_UNSENT_SOURCE_DRAFT');
 const sourcePath=config.forge+'/api/v1/repos/'+config.sourceOwner+'/'+config.sourceName+'/collaborators/'+config.actor;const deniedSource=await context.request.delete(sourcePath,{headers:{Authorization:'token '+config.sourceToken}});check(deniedSource.status()===204);await page.getByLabel('Description, Markdown',{exact:true}).waitFor({state:'detached',timeout:20000});check(!await page.locator('body').innerText().then(t=>t.includes('PRIVATE_UNSENT_SOURCE_DRAFT')));check(await page.locator('.diff-file').count()===0);const restoredSource=await context.request.put(sourcePath,{headers:{Authorization:'token '+config.sourceToken},data:{permission:'read'}});check(restoredSource.status()===204);
 console.log('PASS: live independently revoked source-fork access removes comparison and unsent PR draft');
 console.log('PASS: actual renamed-fork compare/commits/files and explicit Markdown/draft PR creation; both themes and widths');
 stage='open PR';await page.goto(config.golf+'/'+config.repository+'/pull/'+config.number);await page.getByRole('button',{name:'Edit pull request title',exact:true}).waitFor();
 stage='title edit';await page.getByRole('button',{name:'Edit pull request title',exact:true}).click();await page.getByLabel('Pull request title',{exact:true}).fill('Browser-qualified proposal');await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByRole('heading',{name:'Browser-qualified proposal #'+config.number,exact:true}).waitFor();
 for(const theme of ['dark','light'])for(const width of [1280,390]) {
  stage='editor '+theme+' '+width;await page.setViewportSize({width,height:900});
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  await page.getByRole('button',{name:'Edit pull request description',exact:true}).click();await page.getByLabel('Description, Markdown',{exact:true}).fill('PRIVATE_UNSENT_BROWSER_DRAFT');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(config.screenshots,'native-pr-editor-'+theme+'-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'Close editor',exact:true}).click();
 }
 await page.setViewportSize({width:1280,height:900});
 for(const label of ['Convert to draft','Ready for review','Close pull request','Reopen pull request']) {
  stage=label;await page.getByRole('button',{name:label,exact:true}).click();const editor=page.getByRole('region',{name:label,exact:true});await editor.getByRole('button',{name:label,exact:true}).click();await editor.waitFor({state:'detached'});
 }
 stage='description edit';await page.getByRole('button',{name:'Edit pull request description',exact:true}).click();await page.getByLabel('Description, Markdown',{exact:true}).fill('Browser-confirmed description');await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByLabel('Pull request body, rendered Markdown').filter({hasText:'Browser-confirmed description'}).waitFor();
 stage='private draft revocation';await page.getByRole('button',{name:'Edit pull request title',exact:true}).click();await page.getByLabel('Pull request title',{exact:true}).fill('PRIVATE_REVOKED_DRAFT');
 const revoked=await context.request.delete(config.forge+'/api/v1/repos/'+config.repository+'/collaborators/'+config.actor,{headers:{Authorization:'token '+config.ownerToken}});check(revoked.status()===204);
 stage='live revocation cleanup';await page.getByLabel('Pull request title',{exact:true}).waitFor({state:'detached',timeout:20000});await page.locator('.repository-browser').getByRole('alert').waitFor();check(await page.getByLabel('Pull request title',{exact:true}).count()===0);check(!await page.locator('body').innerText().then(t=>t.includes('PRIVATE_REVOKED_DRAFT')));
 check(errors.length===0);console.log('PASS: actual served PR title/description/draft/ready/close/reopen; explicit shared editors; dark/light desktop/mobile; private draft/access revocation cleanup');
} catch {console.error('Native PR mutation browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally {
 if(context&&config)try{const result=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(result.status()===200)}catch{console.error('Native PR browser session cleanup failed');process.exitCode=1}
 await browser?.close();
}
'''

def main():
    ready()
    prefix = 'golf-pull-mutation-' + secrets.token_hex(4)
    users, sessions, actors, repositories = [], [], {}, []
    try:
        for role in ['owner', 'author', 'writer', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            # Deliberately omit issue scope: native PR IDs/permissions are separate.
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            actors[role] = {'name':name, 'token':token, 'session':session}
        owner, author, writer, reader, outsider = [actors[r] for r in ['owner','author','writer','reader','outsider']]
        repo = provider(owner['token'], 'POST', 'user/repos', {'name':'private','private':True,'auto_init':True}, expected=201)
        full, path = repo['full_name'], 'repos/'+repo['full_name']; repositories.append((owner['token'],full)); wait_for_push(owner['token'],full)
        key = {'owner':owner['name'],'name':repo['name']}
        for actor, permission in [(author,'write'),(writer,'write'),(reader,'read')]:
            provider(owner['token'], 'PUT', path+'/collaborators/'+actor['name'], {'permission':permission}, expected=204)
        fork = provider(author['token'], 'POST', path+'/forks', {'name':'renamed-fork'}, expected=202)
        fork_path = 'repos/'+fork['full_name']; repositories.append((author['token'],fork['full_name'])); wait_for_push(author['token'],fork['full_name'])
        def branch(token, route, name):
            provider(token, 'POST', route+'/branches', {'new_branch_name':name}, expected=201)
            provider(token, 'POST', route+'/contents/'+name.replace('/','-')+'.txt', {'branch':name,'message':'Qualification change','content':base64.b64encode(b'qualification\n').decode()}, expected=201)
        branch(author['token'], fork_path, 'feature/fork'); branch(author['token'], fork_path, 'feature/browser'); branch(owner['token'], path, 'feature/local'); branch(owner['token'], path, 'feature/reader')
        def request(source, branch_name, draft=False, title='Qualification proposal'):
            base = provider(owner['token'],'GET',path+'/branches/'+repo['default_branch'])['commit']['id']
            head = provider(source['token'],'GET',source['route']+'/branches/'+branch_name)['commit']['id']
            return {'repository':key,'repositoryId':str(repo['id']),'sourceRepository':source['key'],'sourceRepositoryId':str(source['id']), 'baseBranch':repo['default_branch'],'headBranch':branch_name,'baseCommitId':base,'headCommitId':head,'title':title,'body':'Original description','draft':draft,'idempotencyKey':str(uuid.uuid4())}
        local = {**owner, 'id':repo['id'],'key':key,'route':path}
        fork_source = {**author,'id':fork['id'],'key':{'owner':author['name'],'name':fork['name']},'route':fork_path}
        def compare(actor, payload):
            selection={k:payload[k] for k in ['repository','repositoryId','sourceRepository','sourceRepositoryId','baseBranch','headBranch','baseCommitId','headCommitId']}
            result=rpc(actor['session'],'RepositoryService/GetRepositoryComparison',{'selection':selection})
            assert result['selection']==selection and len(result['commits'])>=1
            assert result['byteSize']==len(result['rawDiff'].encode('utf-8')) and 'diff --git' in result['rawDiff']
            return selection
        fork_selection=compare(author,request(fork_source,'feature/fork'))
        local_selection=compare(owner,request(local,'feature/local'))
        rpc(reader['session'],'RepositoryService/GetRepositoryComparison',{'selection':fork_selection},expected=404)
        rpc(outsider['session'],'RepositoryService/GetRepositoryComparison',{'selection':local_selection},expected=404)
        rpc(author['session'],'RepositoryService/GetRepositoryComparison',{'selection':{**fork_selection,'headCommitId':'f'*40}},expected=400,code='failed_precondition')
        rpc(author['session'],'RepositoryService/GetRepositoryComparison',{'selection':fork_selection},headers={'Origin':'https://other.invalid'},expected=403)
        print('PASS: actual exact same-repo/renamed-private-fork comparisons; native commits/diff; source/outsider denial; stale-head and Origin boundaries',flush=True)
        def create(actor, payload):
            result = rpc(actor['session'],'RepositoryService/CreatePullRequest',payload)
            assert result['mutation']['state']=='ISSUE_MUTATION_STATE_SUCCEEDED', result['mutation'].get('failureCode','unknown')
            assert result['mutation']['kind']=='ISSUE_MUTATION_KIND_CREATE_PULL'
            pull=result['pullRequest'];assert result['mutation']['pullRequestId']==pull['id'] and not result['mutation'].get('issueId')
            assert pull['head']['repositoryId']==payload['sourceRepositoryId'] and pull['head']['commitId']==payload['headCommitId']
            replay=rpc(actor['session'],'RepositoryService/CreatePullRequest',payload);assert replay['mutation']==result['mutation']
            return pull
        fork_payload=request(fork_source,'feature/fork',True);pull=create(author,fork_payload);assert pull['draft'] and pull['title'].startswith('WIP: ')
        native=provider(owner['token'],'GET',path+'/pulls/'+str(pull['number']));assert native['id']==int(pull['id']) and native['head']['repo_id']==fork['id']
        duplicate=rpc(author['session'],'RepositoryService/CreatePullRequest',{**fork_payload,'idempotencyKey':str(uuid.uuid4())});assert duplicate['mutation']['state']=='ISSUE_MUTATION_STATE_REJECTED' and duplicate['mutation']['failureCode']=='provider_http_409'
        rpc(author['session'],'RepositoryService/CreatePullRequest',{**fork_payload,'body':'Different intent'},expected=400,code='failed_precondition')
        def read(actor, number):
            return rpc(actor['session'],'RepositoryService/GetPullRequest',{'repository':key,'number':number})['pullRequest']
        def edit_request(pull, **field):
            return {'repository':key,'repositoryId':str(repo['id']),'pullRequestId':pull['id'],'number':pull['number'],'expectedRevision':pull['revision'],'idempotencyKey':str(uuid.uuid4()),**field}
        def apply(actor, pull, **field):
            payload=edit_request(pull,**field);result=rpc(actor['session'],'RepositoryService/UpdatePullRequest',payload)
            assert result['mutation']['state']=='ISSUE_MUTATION_STATE_SUCCEEDED', result['mutation'].get('failureCode','unknown')
            assert result['mutation']['pullRequestId']==pull['id'] and not result['mutation'].get('issueId')
            assert rpc(actor['session'],'RepositoryService/UpdatePullRequest',payload)['mutation']==result['mutation']
            return result['pullRequest']
        pull=apply(author,pull,draft=False);assert not pull.get('draft',False) and pull['title']=='Qualification proposal'
        before=pull;pull=apply(writer,read(writer,pull['number']),title='Writer-edited proposal')
        stale=rpc(author['session'],'RepositoryService/UpdatePullRequest',edit_request(before,title='Stale edit'));assert stale['mutation']['failureCode']=='revision_changed'
        denied=rpc(reader['session'],'RepositoryService/UpdatePullRequest',edit_request(read(reader,pull['number']),title='Denied reader'));assert denied['mutation']['failureCode']=='provider_http_403'
        rpc(outsider['session'],'RepositoryService/GetPullRequest',{'repository':key,'number':pull['number']},expected=404)
        denied=rpc(outsider['session'],'RepositoryService/UpdatePullRequest',edit_request(pull,title='Denied outsider'));assert denied['mutation']['state']=='ISSUE_MUTATION_STATE_REJECTED'
        native_before=provider(owner['token'],'GET',path+'/pulls/'+str(pull['number']));pull=apply(author,read(author,pull['number']),body='');assert pull.get('body','')==''
        native_after=provider(owner['token'],'GET',path+'/pulls/'+str(pull['number']));assert native_after['content_version']>native_before['content_version']
        provider(author['token'],'PATCH',path+'/pulls/'+str(pull['number']),{'body':'Stale native body','content_version':native_before['content_version']},expected=409)
        pull=apply(author,pull,state='ISSUE_STATE_CLOSED');assert pull['state']=='ISSUE_STATE_CLOSED'
        pull=apply(author,pull,state='ISSUE_STATE_OPEN');assert pull['state']=='ISSUE_STATE_OPEN'
        pull=apply(author,pull,draft=True);assert pull['draft'];pull=apply(author,pull,draft=False);assert not pull.get('draft',False)
        local_pull=create(owner,request(local,'feature/local'))
        provider(owner['token'],'PATCH',path+'/pulls/'+str(local_pull['number']),{'title':'[WIP] Alternate native draft'},expected=201)
        local_pull=apply(owner,read(owner,local_pull['number']),draft=False);assert local_pull['title']=='Alternate native draft' and not local_pull.get('draft',False)
        own=create(reader,request(local,'feature/reader'));own=apply(reader,own,title='Reader author edited own PR');own=apply(reader,own,state='ISSUE_STATE_CLOSED');assert own['state']=='ISSUE_STATE_CLOSED'
        # Source access is independently necessary even when the base is readable.
        denied_payload=request(fork_source,'feature/fork',True)
        denied=rpc(reader['session'],'RepositoryService/CreatePullRequest',denied_payload);assert denied['mutation']['state']=='ISSUE_MUTATION_STATE_REJECTED'
        assert len(provider(owner['token'],'GET',path+'/pulls?state=all'))==3
        rpc(author['session'],'RepositoryService/UpdatePullRequest',edit_request(pull,title='Mixed fields',body='Rejected'),expected=400)
        rpc(author['session'],'RepositoryService/UpdatePullRequest',edit_request(pull,title='Wrong origin'),headers={'Origin':'https://other.invalid'},expected=403)
        delegation=rpc(author['session'],'ApiCredentialService/CreateApiCredential',{'label':'PR mutation boundary'})['token']
        rpc(client(),'RepositoryService/UpdatePullRequest',edit_request(pull,title='Read-only delegation'),headers={'Authorization':'Bearer '+delegation},expected=403)
        rpc(author['session'],'SessionService/Logout');rpc(author['session'],'RepositoryService/UpdatePullRequest',edit_request(pull,title='Logged out'),expected=401)
        print('PASS: actual native PR API creation/lifecycle, permissions, source selection, replay and boundaries',flush=True)
        # Separate browser PAT includes issue reads for the discussion surface;
        # the API qualification above deliberately omitted issue scope.
        provider(author['token'],'PUT',fork_path+'/collaborators/'+writer['name'],{'permission':'read'},expected=204)
        browser_token=admin('generate-access-token','--username',writer['name'],'--token-name',prefix+'-browser','--scopes','write:user,write:repository,read:issue','--raw')
        screenshots=ROOT/'.tmp/github-visual-audit/pull-mutations';screenshots.mkdir(parents=True,exist_ok=True)
        result=subprocess.run(['node','--input-type=module','-e',BROWSER],input=json.dumps({'golf':GOLF,'forge':FORGE,'token':browser_token,'ownerToken':owner['token'],'actor':writer['name'],'repository':full,'number':pull['number'],'baseBranch':repo['default_branch'],'sourceOwner':author['name'],'sourceName':fork['name'],'sourceId':str(fork['id']),'sourceToken':author['token'],'screenshots':str(screenshots)}),text=True,cwd=ROOT,capture_output=True,timeout=120)
        print(result.stdout, end='',flush=True)
        if result.returncode:
            print(result.stderr, end='',file=sys.stderr);raise RuntimeError('Native PR browser failed (private diagnostics withheld)')
        print('PASS: actual same-repo/renamed-private-fork creation; separate PR IDs; draft/ready/default prefixes; title/empty body/close/reopen; writer/author permissions; reader/outsider/source denial; durable replay/conflict; stale revision/native body-version; Origin/API/logout boundaries',flush=True)
    finally:
        for session in sessions:
            try:rpc(session,'SessionService/Logout')
            except Exception:pass
        for token,full in reversed(repositories):
            provider(token,'DELETE','repos/'+full,expected=204)
        for name in reversed(users):admin('delete','--username',name,'--purge')
        print('Disposable PR qualification users/repositories purged.',flush=True)

if __name__=='__main__':main()
