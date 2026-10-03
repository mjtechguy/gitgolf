#!/usr/bin/env python3
"""Qualify the deployed schema037 saved-draft publication UI on owned fixtures.

Supported native APIs/admin and managed Golf operator enrollment only. No direct
database writes, provider inference, workflows or remote repositories. Output is
fixed diagnostic labels; owner-only captures contain synthetic fixture content.
Cleanup purges native fixtures and revokes/disables Golf accounts while retaining
encrypted Golf history. Does not start, rebuild or deploy any service.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.request
from urllib.parse import quote

sys.dont_write_bytecode = True
import smoke

BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,config,stage='initialization';const contexts=[];const results=[],metrics=[];
function check(v){if(!v)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const p of process.stdin)input+=p;config=JSON.parse(input);input='';
 browser=await chromium.launch();const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 for(const item of config.pulls){
  stage='managed browser sign-in';const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
  check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers,data:{username:config.email,password:config.password}})).status()===200);
  const page=await context.newPage(),errors=[],publications=[];page.on('pageerror',()=>errors.push(true));page.on('dialog',dialog=>dialog.accept());
  page.on('request',request=>{if(request.url().endsWith('/PublishPullRequestReviewDraft'))publications.push(request.postDataJSON());});
  const url=config.golf+'/'+config.repository+'/pull/'+item.number+'/files';
  stage='served original old/new line authoring';await page.goto(url);await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Private draft',exact:true}).click();
  const region=page.getByRole('region',{name:'Private review draft',exact:true});
  for(const side of ['old','new']){
   await region.getByRole('button',{name:'Add private comment on '+side+' line 2 in '+config.path,exact:true}).click();const editor=region.getByRole('form',{name:'Private line comment editor',exact:true});
   await editor.getByRole('textbox',{name:'Private comment · '+side+' line 2 · '+config.path,exact:true}).fill(item[side+'Body']);await editor.getByRole('button',{name:'Keep comment',exact:true}).click();
  }
  await region.getByRole('button',{name:'Edit private draft summary',exact:true}).click();await region.getByRole('textbox',{name:'Private draft summary, Markdown',exact:true}).fill(item.summary);await region.getByRole('button',{name:'Keep summary',exact:true}).click();
  stage='explicit private save';await region.getByRole('button',{name:'Save private draft',exact:true}).click();await region.getByText('Saved privately in Golf. No review was published.',{exact:true}).waitFor();check(publications.length===0);
  const target={repository:config.repositoryKey,repositoryId:config.repositoryId,pullRequestId:item.id,number:item.number};
  const observed=await context.request.post(config.golf+'/rpc/golf.v1.RepositoryService/GetPullRequestReviewDraft',{headers,data:{target}});check(observed.status()===200);const saved=await observed.json();
  check(saved.currentVersion==='1'&&saved.targetGeneration==='1'&&saved.draft.entries.length===2&&saved.draft.summary===item.summary&&saved.draft.userId===config.userId);
  const capture=saved.draft.comparison.capture;check(capture.mergeBaseCommitId===config.merge&&capture.selection.baseCommitId===config.base&&capture.selection.headCommitId===item.head&&capture.diffSha256===item.digest);
  check(saved.draft.entries[0].coordinate.side==='PULL_REVIEW_DRAFT_SIDE_OLD'&&saved.draft.entries[1].coordinate.side==='PULL_REVIEW_DRAFT_SIDE_NEW');
  for(const entry of saved.draft.entries)check(entry.coordinate.line===2&&entry.coordinate.path===config.path&&!(entry.coordinate.fileIndex||entry.coordinate.hunkIndex));
  if(item.decision==='COMMENT'){
   await region.getByRole('button',{name:'Edit private draft summary',exact:true}).click();await region.getByRole('textbox',{name:'Private draft summary, Markdown',exact:true}).fill('Unsent inline working notes');await region.getByRole('button',{name:'Keep summary',exact:true}).click();
  }
  stage='second authorized conversation live stream';const reader=await context.newPage();reader.on('pageerror',()=>errors.push(true));let readerRows=[];reader.on('response',async response=>{if(response.url().endsWith('/ListPullRequestReviews')&&response.status()===200)readerRows=(await response.json()).reviews||[];});await reader.goto(config.golf+'/'+config.repository+'/pull/'+item.number);await reader.locator('.live-status-live').waitFor();await reader.getByText('No visible reviews in the loaded pages.',{exact:true}).waitFor();
  stage='explicit saved-only native publication';await region.getByRole('button',{name:'Publish saved review',exact:true}).click();const publication=page.getByRole('region',{name:'Saved review publication',exact:true});
  await publication.getByRole('group',{name:'Saved review decision'}).waitFor();if(item.decision!=='COMMENT')await publication.getByRole('radio',{name:item.decision==='APPROVED'?'Approve':'Request changes',exact:true}).check();
  await publication.getByText('Original saved review and comparison',{exact:true}).click();check((await publication.innerText()).includes(item.summary));check(!(await publication.innerText()).includes('Unsent inline working notes'));
  await publication.getByRole('button',{name:item.decision==='COMMENT'?'Publish saved comment':item.decision==='APPROVED'?'Publish saved approval':'Publish saved change request',exact:true}).click();
  await publication.getByText(/Published and independently verified against every intended comment/).waitFor();check(publications.length===1);const requested=publications[0];
  check(requested.draftId===saved.draft.id&&requested.expectedVersion===saved.currentVersion&&requested.expectedTargetGeneration===saved.targetGeneration&&requested.comparisonId===saved.draft.comparison.id&&requested.decision==='PULL_REQUEST_REVIEW_STATE_'+item.decision);
  check(Object.keys(requested).sort().join(',')==='comparisonId,decision,draftId,expectedTargetGeneration,expectedVersion,operationId,target');
  const statusRequest={target,draftId:requested.draftId,operationId:requested.operationId};const statusResponse=await context.request.post(config.golf+'/rpc/golf.v1.RepositoryService/GetPullRequestInlineReviewMutation',{headers,data:statusRequest});check(statusResponse.status()===200);const mutation=(await statusResponse.json()).mutation;
  check(mutation.phase==='PULL_INLINE_REVIEW_PHASE_SUCCEEDED'&&mutation.operationId===requested.operationId&&mutation.draftId===saved.draft.id&&mutation.acceptedVersion===saved.currentVersion&&mutation.acceptedTargetGeneration===saved.targetGeneration&&mutation.comparisonId===saved.draft.comparison.id&&mutation.decision===requested.decision&&mutation.verifiedCommentIds.length===2&&mutation.headCommitId===item.head&&mutation.baseTipCommitId===config.base&&mutation.mergeBaseCommitId===config.merge&&mutation.diffSha256===item.digest);
  check(/^[1-9][0-9]*$/.test(mutation.observedReviewId)&&mutation.verifiedCommentIds.every(id=>/^[1-9][0-9]*$/.test(id))&&new Set(mutation.verifiedCommentIds).size===2);
  stage='automatic cross-tab review readback';const liveReview=reader.locator('.pull-review-list>li').first();await liveReview.getByText(item.summary,{exact:true}).waitFor({timeout:20000});await liveReview.getByRole('heading',{name:config.user,exact:true}).first().waitFor();for(let i=0;i<20&&!readerRows.some(row=>row.id===mutation.observedReviewId);i++)await new Promise(resolve=>setTimeout(resolve,50));check(readerRows.some(row=>row.id===mutation.observedReviewId&&row.body===item.summary&&row.user.id===config.userId&&row.state===mutation.decision&&row.commentsCount===2&&row.commitId===item.head));check((await page.locator('.diff-file').first().innerText()).includes('merge-base old')&&(await page.locator('.diff-file').first().innerText()).includes('selected-head '+item.decision));
  const stored=await page.evaluate(()=>JSON.stringify({...sessionStorage}));check(stored.includes(requested.operationId)&&!stored.includes(item.summary)&&!stored.includes(item.oldBody)&&!stored.includes(config.path)&&!stored.includes(item.head)&&!stored.includes(item.digest));
  stage='reload and status are inspection only';await publication.getByRole('button',{name:'Check publication status',exact:true}).click();await page.reload();await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Private draft',exact:true}).click();await publication.getByText(/Published and independently verified against every intended comment/).waitFor();await publication.getByRole('button',{name:'Check publication status',exact:true}).click();check(publications.length===1);
  check((await publication.getByRole('button',{name:/Prepare another/}).count())===0);await publication.getByText('Publication receipt',{exact:true}).click();check((await publication.innerText()).includes(item.head));
  if(item.decision==='COMMENT'&&config.restartBackend){
   stage='same-image backend restart and cookie continuity';const {execFile}=await import('node:child_process');
   await new Promise((resolve,reject)=>execFile('docker',[...config.compose.slice(1),'restart','golf'],{cwd:config.stack,timeout:60000,maxBuffer:65536},error=>error?reject(Error('backend restart failed')):resolve()));
   let ready=false;for(let i=0;i<60&&!ready;i++){try{ready=(await context.request.get(config.golf+'/readyz')).status()===200;}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,250));}check(ready);
   check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/GetSession',{headers,data:{}})).status()===200);
   await page.reload();await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Private draft',exact:true}).click();await publication.getByText(/Published and independently verified against every intended comment/).waitFor();
   await publication.getByRole('button',{name:'Check publication status',exact:true}).click();await publication.getByText('Publication receipt',{exact:true}).click();check(publications.length===1);
  }
  if(item.decision==='COMMENT')for(const theme of ['dark','light'])for(const width of [1280,390]){
   stage='actual publication capture '+theme+' '+width;await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check((await page.locator('html').getAttribute('data-theme'))===theme);
   await publication.scrollIntoViewIfNeeded();const observed=await publication.evaluate(region=>{const box=node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height,x:r.x,y:r.y};};return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,region:box(region),buttons:[...region.querySelectorAll('button')].filter(node=>node.getClientRects().length&&!node.disabled).map(node=>({label:node.getAttribute('aria-label')||node.textContent,box:box(node)}))};});
   check(observed.documentWidth<=width&&observed.buttons.length>0);if(width===390)check(observed.buttons.every(row=>row.box.width>=44&&row.box.height>=44));metrics.push({theme,width,...observed});
   await page.screenshot({path:join(config.screenshots,'served-inline-publication-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'served-inline-publication-'+theme+'-'+width+'.txt'),await page.locator('body').innerText(),{mode:0o600});
  }
  check(errors.length===0);results.push({number:item.number,mutation});
  if(item.decision==='REQUEST_CHANGES'){
   stage='live native access removal';check((await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);
   await page.locator('.diff-file').first().waitFor({state:'detached',timeout:20000});await publication.waitFor({state:'detached',timeout:20000});const body=await page.locator('body').innerText();check(!body.includes(item.summary)&&!body.includes(item.oldBody)&&!body.includes(item.newBody)&&!body.includes(item.head));
  }
  await reader.close();await page.close();
 }
 await writeFile(join(config.screenshots,'served-inline-publication-metrics.json'),JSON.stringify({runtime:config.runtime,captureKind:'Actual schema037 saved-draft native publication through managed browser; historical receipts, no merge eligibility claim',metrics},null,2),{mode:0o600});
 console.log(JSON.stringify({results,captures:4}));
}catch(failure){console.error('Served inline publication failed at '+stage+'; '+(failure.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;}
finally{for(const context of contexts)if(config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Served inline publication logout failed');process.exitCode=1;}await browser?.close();}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', required=True, type=Path)
    parser.add_argument('--screenshots', type=Path, help='Owner-only capture directory; defaults under stack-root/.tmp')
    parser.add_argument('--restart-backend', action='store_true', help='Restart the same existing Golf container after the first publication and verify cookie/status continuity without reposting')
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    if not all((stack / item).is_file() for item in ('compose.yaml', '.env', 'web/node_modules/playwright/index.mjs')):
        parser.error('--stack-root requires an existing deployed Compose stack and Playwright installation')
    screens = (args.screenshots or stack / '.tmp/served-inline-review-publication').resolve()
    screens.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(screens, 0o700)
    compose = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack / 'compose.yaml'), '--env-file', str(stack / '.env')]
    actors, enrolled = {}, []
    stage = 'served readiness'

    def command(*values, payload=None):
        result = subprocess.run(values, cwd=stack, input=None if payload is None else json.dumps(payload), capture_output=True, text=True, timeout=60)
        assert result.returncode == 0 and len(result.stdout) <= 2 << 20 and len(result.stderr) <= 2 << 20, 'Bounded subprocess failed'
        return result.stdout.strip()

    def admin(*values):
        return command(*compose, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', *values)

    def operator(action, payload):
        out = json.loads(command(*compose, 'exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
        assert out['state'] == 'complete'
        return out['result']

    def runtime():
        container = command(*compose, 'ps', '-q', 'golf')
        reference, config = command('docker', 'inspect', '--format', '{{.Image}}|{{index .Config.Labels "com.docker.compose.config-hash"}}', container).split('|')
        image, digests = command('docker', 'image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}', reference).split('|')
        assert reference.startswith('sha256:') and image.startswith('sha256:')
        return {'containerImageReference': reference, 'imageInspectId': image, 'composeConfigHash': config, 'repoDigests': json.loads(digests) or []}

    def native_diff(token, route):
        req = urllib.request.Request(smoke.GITEA + '/api/v1/' + route + '.diff', headers={'Authorization': 'token ' + token})
        with smoke.client().open(req, timeout=20) as response:
            assert response.status == 200
            raw = response.read((512 << 10) + 1)
            assert len(raw) <= 512 << 10
            return raw.decode('utf-8')

    try:
        smoke.ready()
        assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
        baseline = runtime()
        prefix = 'golf-inline-served-' + secrets.token_hex(4)
        stage = 'disposable native actors and managed enrollment'
        for role in ('owner', 'reviewer'):
            name = prefix + '-' + role
            actors[role] = actor = {'name': name, 'created': False, 'session': None}
            admin('create', '--username', name, '--email', name + '@example.invalid', '--random-password', '--must-change-password=false')
            actor['created'] = True
            token = admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue', '--raw')
            actor.update(token=token, id=smoke.provider(token, 'GET', 'user')['id'], email=name + '@golf.invalid', password='Golf fixture ' + secrets.token_urlsafe(24))
            enrolled.append(actor)
            operator('create', {'username': name, 'email': actor['email'], 'password': actor['password'], 'forge_token': token, 'is_instance_admin': False})
            actor['session'] = smoke.client()
            smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username': actor['email'], 'password': actor['password']})
        owner, reviewer = actors['owner'], actors['reviewer']
        stage = 'private divergent native comparison'
        repo = smoke.provider(owner['token'], 'POST', 'user/repos', {'name': 'private', 'private': True, 'auto_init': True}, 201)
        full, path = repo['full_name'], 'src/context ü.txt'
        route = 'repos/' + full
        smoke.wait_for_push(owner['token'], full)
        smoke.provider(owner['token'], 'PUT', route + '/collaborators/' + reviewer['name'], {'permission': 'write'}, 204)

        def contents(method, branch, text, sha=None):
            body = {'branch': branch, 'message': 'Deterministic served publication fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha:
                body['sha'] = sha
            return smoke.provider(owner['token'], method, route + '/contents/' + quote(path, safe='/'), body, 201 if method == 'POST' else 200)

        initial = contents('POST', repo['default_branch'], 'context one\nmerge-base old\nstable three\n')
        merge = initial['commit']['sha']
        decisions = ['COMMENT', 'APPROVED', 'REQUEST_CHANGES']
        for index in range(3):
            smoke.provider(owner['token'], 'POST', route + '/branches', {'new_branch_name': 'proposal-' + str(index)}, 201)
        base = contents('PUT', repo['default_branch'], 'context one\nbase-tip unrelated\nstable three\n', initial['content']['sha'])['commit']['sha']
        assert base != merge
        pulls = []
        for index, decision in enumerate(decisions):
            branch = 'proposal-' + str(index)
            selected = contents('PUT', branch, 'context one\nselected-head ' + decision + '\nstable three\n', initial['content']['sha'])
            head = selected['commit']['sha']
            pull = smoke.provider(owner['token'], 'POST', route + '/pulls', {'head': branch, 'base': repo['default_branch'], 'title': 'Served inline qualification ' + decision}, 201)
            proute = route + '/pulls/' + str(pull['number'])
            deadline = time.monotonic() + 45
            while True:
                current = smoke.provider(owner['token'], 'GET', proute)
                retained = smoke.provider(owner['token'], 'GET', route + '/commits?sha=refs%2Fpull%2F' + str(pull['number']) + '%2Fhead&limit=1&stat=false&files=false&verification=false')
                if current['merge_base'] == merge and current['base']['sha'] == base and current['head']['sha'] == head and retained and retained[0]['sha'] == head:
                    break
                assert time.monotonic() < deadline, 'Native comparison did not settle'
                time.sleep(.2)
            raw = native_diff(owner['token'], proute)
            assert 'base-tip unrelated' not in raw and '-merge-base old' in raw and '+selected-head ' + decision in raw
            assert not smoke.provider(owner['token'], 'GET', proute + '/reviews?limit=50')
            pulls.append({'id': str(pull['id']), 'number': pull['number'], 'head': head, 'digest': hashlib.sha256(raw.encode()).hexdigest(), 'decision': decision,
                          'summary': 'Saved inline qualification ' + decision, 'oldBody': 'Saved old-side note ' + decision, 'newBody': 'Saved new-side note ' + decision,
                          'hunkHeader': next(line for line in raw.splitlines() if line.startswith('@@ '))})
        stage = 'actual served browser publication'
        config = {'golf': smoke.GOLF, 'gitea': smoke.GITEA, 'email': reviewer['email'], 'password': reviewer['password'], 'user': reviewer['name'], 'userId': str(reviewer['id']),
                  'ownerToken': owner['token'], 'repository': full, 'repositoryKey': {'owner': owner['name'], 'name': 'private'}, 'repositoryId': str(repo['id']), 'path': path,
                  'merge': merge, 'base': base, 'pulls': pulls, 'screenshots': str(screens), 'runtime': baseline, 'restartBackend': args.restart_backend, 'compose': compose, 'stack': str(stack)}
        result = subprocess.run(['node', '--input-type=module', '-e', BROWSER], cwd=stack, input=json.dumps(config), capture_output=True, text=True, timeout=180)
        if result.returncode:
            for line in result.stderr.splitlines():
                if line.startswith('Served inline publication failed at ') or line == 'Served inline publication logout failed':
                    print(line, file=sys.stderr)
        assert result.returncode == 0 and len(result.stdout) <= 2 << 20, 'Browser publication failed; private diagnostics withheld'
        receipt = json.loads(result.stdout)
        assert receipt['captures'] == 4 and len(receipt['results']) == 3
        stage = 'independent complete native readback'
        for item, outcome in zip(pulls, receipt['results'], strict=True):
            assert item['number'] == outcome['number']
            mutation = outcome['mutation']
            proute = route + '/pulls/' + str(item['number'])
            reviews = smoke.provider(owner['token'], 'GET', proute + '/reviews?limit=50')
            assert len(reviews) == 1
            review = reviews[0]
            assert str(review['id']) == mutation['observedReviewId'] and review['state'] == item['decision'] and review['commit_id'] == item['head'] and review['user']['id'] == reviewer['id'] and review['body'] == item['summary'] and review['comments_count'] == 2
            children = smoke.provider(owner['token'], 'GET', proute + '/reviews/' + str(review['id']) + '/comments?limit=50')
            assert len(children) == 2 and {str(child['id']) for child in children} == set(mutation['verifiedCommentIds'])
            by_id = {str(child['id']): child for child in children}
            for side, comment_id in zip(('old', 'new'), mutation['verifiedCommentIds'], strict=True):
                child = by_id[comment_id]
                assert child['body'] == item[side + 'Body'] and child['path'] == path and child['user']['id'] == reviewer['id']
                assert (child['position'], child['original_position']) == ((0, 2) if side == 'old' else (2, 0))
                expected = item['hunkHeader'] + '\n context one\n-merge-base old' + ('\n+selected-head ' + item['decision'] if side == 'new' else '')
                assert child['diff_hunk'] in (expected, expected + '\n') and 'base-tip unrelated' not in child['diff_hunk']
        assert runtime() == baseline, 'Served runtime changed during proof'
        assert len(list(screens.glob('served-inline-publication-*.png'))) == 4 and len(list(screens.glob('served-inline-publication-*.txt'))) == 4
        for capture in screens.iterdir():
            if capture.is_file():
                os.chmod(capture, 0o600)
        print('PASS: actual served Add old/new comments and summary, private Save, explicit saved COMMENT/APPROVED/REQUEST_CHANGES, exact version/generation/comparison receipts, status/reload without repost, automatic authorized cross-tab review updates, four both-theme desktop/mobile captures and 44px mobile targets', flush=True)
        if args.restart_backend:
            print('PASS: same-image backend restart preserves the managed cookie and original publication status without another native POST', flush=True)
        print('PASS: independent native single-review/two-child/body/path/side/M-H context readback excludes divergent base tip; live access removal clears private details; unchanged runtime; no merge eligibility/recovery/Cloudflare/inference claim', flush=True)
    except Exception:
        print('Served inline publication qualification failed at ' + stage + '; private diagnostics withheld', file=sys.stderr)
        raise
    finally:
        failures = []
        for actor in actors.values():
            if actor['session'] is not None:
                try:
                    smoke.rpc(actor['session'], 'SessionService/RevokeOtherSessions')
                    smoke.rpc(actor['session'], 'SessionService/Logout')
                except Exception:
                    failures.append('managed session revocation')
        for actor in reversed(enrolled):
            try:
                assert operator('disable', {'username': actor['name']})['disabled']
            except Exception:
                failures.append('managed account disable')
        for actor in reversed(list(actors.values())):
            if actor['created']:
                try:
                    admin('delete', '--username', actor['name'], '--purge')
                except Exception:
                    failures.append('native fixture purge')
        assert not failures, 'Owned fixture cleanup failed'
        print('Cleanup: native actors/repository purged, managed sessions revoked and accounts disabled; encrypted Golf draft/publication/account history retained by design.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Served inline publication qualifier failed; private diagnostics withheld', file=sys.stderr)
        sys.exit(1)
