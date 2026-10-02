#!/usr/bin/env python3
"""Qualify read-only PR API/CLI/UI with disposable private Compose fixtures."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from smoke import ROOT, GITEA, GOLF, admin, client, ready, rpc
spec = importlib.util.spec_from_file_location('organization_smoke', ROOT / 'scripts/organizations-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
provider, cli_call = helpers.provider, helpers.cli_call

BROWSER = r'''
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let browser, context, config, stage = 'initialization';
function check(x) { if (!x) throw new Error('assertion'); }
try {
 const { chromium } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/playwright/index.mjs')));
 let input = ''; for await (const part of process.stdin) input += part;
 config = JSON.parse(input); input = '';
 browser = await chromium.launch(); context = await browser.newContext({viewport:{width:1440,height:1000}});
 const page = await context.newPage(); const errors=[]; page.on('pageerror',()=>errors.push(true));
 stage='sign in'; await page.goto(config.golf);
 await page.getByText('Advanced token sign-in', { exact: true }).click();
 await page.getByLabel('Gitea access token',{exact:true}).fill(config.token);
 await page.getByRole('button',{name:'Continue to workspace',exact:true}).click();
 await page.getByRole('link',{name:'Organizations',exact:true}).waitFor();
 stage='private PR list'; await page.goto(config.golf+'/repositories/'+config.repository+'?view=pulls');
 await page.getByRole('link',{name:config.title,exact:false}).first().click();
 stage='private PR detail'; await page.getByRole('heading',{name:config.title,exact:false}).waitFor();
 stage='private PR metadata'; await page.getByLabel('Pull request body, plain text').waitFor();
 check((await page.getByLabel('Pull request body, plain text').innerText()).includes('<script>'));
 await page.getByRole('region',{name:'Head metadata'}).waitFor();
 await page.getByRole('heading',{name:'Native Gitea reviews'}).waitFor();
 stage='review pagination'; await page.getByRole('button',{name:'Load more reviews',exact:true}).click();
 await page.getByLabel('Review '+config.lastReview+' body, plain text').waitFor();
 stage='theme and deep link'; await page.getByRole('button',{name:'Dark theme',exact:true}).click();
 await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:join(config.screenshots,'pulls-dark.png')});
 await page.reload(); await page.getByRole('heading',{name:config.title,exact:false}).waitFor();
 check(new URL(page.url()).searchParams.get('pull')===String(config.number));
 await page.getByRole('button',{name:'Light theme',exact:true}).click(); await page.setViewportSize({width:390,height:844});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:join(config.screenshots,'pulls-light-mobile.png')});
 stage='revocation'; const response=await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.reader,
 {headers:{Authorization:'token '+config.ownerToken}}); check(response.status()===204);
 await page.getByRole('button',{name:'Refresh pull request',exact:true}).click();
 await page.getByRole('alert').waitFor(); check(await page.getByLabel('Pull request body, plain text').count()===0);
 check(await page.getByRole('heading',{name:'Native Gitea reviews'}).count()===0);
 check(errors.length===0); console.log('PASS: production PR navigation, review pagination, deep links, dark/light/mobile and revoked-access cleanup');
} catch { console.error('PR browser failed at '+stage+'; sensitive diagnostics withheld'); process.exitCode=1; }
finally {
 if(context&&config) try { const r=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}}); check(r.status()===200); }
 catch {console.error('Browser logout failed');process.exitCode=1;}
 await browser?.close();
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', type=Path)
    args = parser.parse_args()
    binary = args.cli.resolve() if args.cli else None
    if binary and not binary.is_file():
        parser.error('build CLI first')
    ready()
    prefix = 'golf-pulls-' + secrets.token_hex(5)
    users, actors, repositories = [], {}, []
    try:
        for role in ['owner', 'author', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name + '@example.invalid', '--random-password',
                  '--random-password-length', '32', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw').strip()
            read = admin('generate-access-token', '--username', name, '--token-name', prefix+'-read',
                         '--scopes', 'read:user,read:repository', '--raw').strip()
            session = client()
            rpc(session, 'SessionService/LoginWithGiteaToken', {'token': read})
            actors[role] = {'name': name, 'token': token, 'read': read, 'session': session}
        owner, author, reader, outsider = [actors[r] for r in ['owner','author','reader','outsider']]
        repo = provider(owner['token'], 'POST', 'user/repos', {'name':'private', 'private':True,'auto_init':True}, expected=201)
        full = repo['full_name']; repositories.append((owner['token'], full))
        route = 'repos/' + full
        key = {'owner':owner['name'],'name':'private'}
        for actor in [author, reader]:
            provider(owner['token'], 'PUT', route+'/collaborators/'+actor['name'], {'permission':'write'}, expected=204)
        fork = provider(author['token'], 'POST', route+'/forks', {}, expected=202)
        repositories.append((author['token'], fork['full_name']))
        fork_route = 'repos/'+fork['full_name']
        branch = 'feature/example'
        provider(author['token'], 'POST', fork_route+'/branches', {'new_branch_name':branch}, expected=201)
        content = provider(author['token'], 'POST', fork_route+'/contents/feature.txt', {
            'branch':branch,'message':'Disposable feature','content':base64.b64encode(b'feature\n').decode()}, expected=201)
        head = content['commit']['sha']
        title = 'Private fork contribution'
        pull = provider(author['token'], 'POST', route+'/pulls', {
            'head':author['name']+':'+branch,'base':repo['default_branch'],'title':title,
            'body':'Plain text <script>window.golfUnsafe=true</script>'}, expected=201)
        number = pull['number']
        request = {'repository': key,'number':number}
        def call(actor, method, payload, expected=200):
            return rpc(actor['session'], 'RepositoryService/'+method, payload, expected=expected)
        listed = call(owner,'ListPullRequests', {'repository':key})['pullRequests']
        assert listed[0]['number']==number and listed[0]['head']['retainedSnapshot']
        detail = call(owner,'GetPullRequest',request)['pullRequest']
        assert detail['head']['commitId']==head and detail['head']['repositoryId']==str(fork['id'])
        assert not detail['head'].get('retainedSnapshot',False)
        provider(owner['read'], 'GET', fork_route, expected=404)
        provider(author['token'],'POST',fork_route+'/branches',
                 {'new_branch_name':'feature/closed','old_branch_name':branch},expected=201)
        closed = provider(author['token'],'POST',route+'/pulls', {
            'head':author['name']+':feature/closed','base':repo['default_branch'],'title':'Closed fixture'},expected=201)
        provider(owner['token'],'PATCH',route+f'/pulls/{closed["number"]}',{'state':'closed'},expected=201)
        closed_rows=call(owner,'ListPullRequests',{'repository':key,'state':'ISSUE_STATE_CLOSED'})['pullRequests']
        assert [p['number'] for p in closed_rows]==[closed['number']]
        first_page=call(owner,'ListPullRequests',{'repository':key,'state':'ISSUE_STATE_ALL','page':{'limit':1}})
        second_page=call(owner,'ListPullRequests',{'repository':key,'state':'ISSUE_STATE_ALL','page':{'limit':1,'page':2}})
        assert first_page['page']['nextPage']==2
        assert {p['number'] for p in first_page['pullRequests']+second_page['pullRequests']}=={number,closed['number']}
        assert not second_page.get('page',{}).get('nextPage',0)
        restricted=admin('generate-access-token','--username',owner['name'],'--token-name',prefix+'-no-repo',
                         '--scopes','read:user','--raw').strip()
        restricted_session=client()
        try:
            rpc(restricted_session,'SessionService/LoginWithGiteaToken',{'token':restricted})
            for method in ['GetPullRequest','ListPullRequestReviews']:
                rpc(restricted_session,'RepositoryService/'+method,request,expected=403)
            rpc(restricted_session,'RepositoryService/ListPullRequests',{'repository':key},expected=403)
        finally:
            rpc(restricted_session,'SessionService/Logout')
        print('PASS: open/closed/all PR filters, explicit list pagination and missing-repository-scope denial',flush=True)
        for method,payload in [('ListPullRequests',{'repository':key}),('GetPullRequest',request),('ListPullRequestReviews',request)]:
            call(outsider,method,payload,404)
            rpc(client(),'RepositoryService/'+method,payload,expected=401)
        # Review totals include another user's hidden pending review. An empty
        # first page must still advance to the visible review on the next page.
        provider(reader['token'],'POST',route+f'/pulls/{number}/reviews',
                 {'event':'PENDING','body':'Unpublished private draft','commit_id':head},expected=200)
        reviews=[]
        for index in range(21):
            reviews.append(provider(owner['token'],'POST',route+f'/pulls/{number}/reviews',
                 {'event':'COMMENT','body':f'Native comment {index} <script>','commit_id':head},expected=200))
        first = call(owner,'ListPullRequestReviews',{**request,'page':{'limit':1}})
        assert not first.get('reviews',[]) and first['page']['nextPage']==2
        second = call(owner,'ListPullRequestReviews',{**request,'page':{'limit':1,'page':2}})
        assert second['reviews'][0]['id']==str(reviews[0]['id']) and second['reviews'][0]['commitId']==head
        print('PASS: private-fork PR reads using read:repository without read:issue; private denial and hidden-pending pagination',flush=True)
        if binary:
            before = rpc(owner['session'],'SessionService/ListSessions')['sessions']
            assert cli_call(binary,owner['read'],['pr','list',full])['pullRequests'][0]['number']==number
            assert cli_call(binary,owner['read'],['pr','view',full,str(number)])['pullRequest']['head']['commitId']==head
            assert cli_call(binary,owner['read'],['pr','reviews',full,str(number),'--limit','1'])['page']['nextPage']==2
            cli_call(binary,outsider['read'],['pr','view',full,str(number)],expected=1)
            after = rpc(owner['session'],'SessionService/ListSessions')['sessions']
            assert {s['id'] for s in before}=={s['id'] for s in after}
            print('PASS: PR CLI wire output, denial and ephemeral session cleanup',flush=True)
        changed=provider(author['token'],'PUT',fork_route+'/contents/feature.txt', {
            'branch':branch,'sha':content['content']['sha'],'message':'Advance disposable source',
            'content':base64.b64encode(b'new feature\n').decode()})
        new_head=changed['commit']['sha']
        deadline=time.monotonic()+15
        while call(owner,'GetPullRequest',request)['pullRequest']['head']['commitId']!=new_head:
            assert time.monotonic()<deadline, 'Provider source observation did not advance'
            time.sleep(0.25)
        recorded=call(owner,'ListPullRequestReviews',{**request,'page':{'limit':1,'page':2}})['reviews'][0]
        assert recorded['commitId']==head and head!=new_head
        print('PASS: advanced source observation preserves the native reviewed commit',flush=True)
        screenshots=ROOT/'.tmp/pull-smoke'; screenshots.mkdir(parents=True,exist_ok=True)
        config={'golf':GOLF,'gitea':GITEA,'token':reader['read'],'ownerToken':owner['token'],
                'reader':reader['name'],'repository':full,'title':title,'number':number,
                'lastReview':str(reviews[-1]['id']),'screenshots':str(screenshots)}
        result=subprocess.run(['node','--input-type=module','-e',BROWSER],input=json.dumps(config),
                              cwd=ROOT,text=True,capture_output=True,timeout=90)
        assert result.returncode==0, result.stderr
        print(result.stdout.strip(),flush=True)
        provider(author['token'],'DELETE',fork_route+'/branches/feature%2Fexample',expected=204)
        retained=call(owner,'GetPullRequest',request)['pullRequest']['head']
        assert retained['retainedSnapshot'] and retained['ref']==f'refs/pull/{number}/head'
        print('PASS: deleted source branch is labeled as retained PR snapshot',flush=True)
    finally:
        failures=[]
        for actor in actors.values():
            try:
                rpc(actor['session'],'SessionService/Logout')
            except Exception:
                failures.append('session')
        for token,full in reversed(repositories):
            try:
                provider(token,'DELETE','repos/'+full,expected=204)
            except Exception:
                failures.append('repository')
        for name in reversed(users):
            try:
                admin('delete','--username',name,'--purge')
            except Exception:
                failures.append('user')
        assert not failures, 'Fixture cleanup failed; sensitive diagnostics withheld'
        print('CLEANUP: disposable PR users/repos and Golf sessions removed',flush=True)

if __name__=='__main__':
    main()
