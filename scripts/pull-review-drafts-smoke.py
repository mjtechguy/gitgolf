#!/usr/bin/env python3
"""Qualify served browser-only private PR drafts on owned disposable fixtures.

Requires the deployed schema036/backend (and UI for --browser). Supported native
API/admin CLI, Golf RPC and managed-account operator CLI only. Read-only Golf
metadata counts verify no shared activity and retained history; no direct
database writes or source/ciphertext extraction. No model, workflow or remote
organization activity. Cleanup disables Golf fixture accounts, revokes sessions
and bearers, and purges native actors/repos. Golf's encrypted history is retained.
"""
import argparse
import base64
import copy
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote
import uuid

sys.dont_write_bytecode = True
import smoke

REPOSITORY = 'RepositoryService/'

BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(value){if(!value)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const p of process.stdin)input+=p;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers,data:{username:config.email,password:config.password}})).status()===200);
 const page=await context.newPage(),errors=[];page.on('pageerror',()=>errors.push(true));const url=config.golf+'/'+config.repository+'/pull/'+config.number+'/files';
 stage='served canonical Unicode source alias';await page.goto(config.golf+'/repositories/'+config.repository+'?ref='+config.snapshot.sha+'&path='+encodeURIComponent(config.path)+'#L2');
 await page.waitForURL(value=>decodeURIComponent(value.pathname)==='/'+config.repository+'/blob/'+config.snapshot.sha+'/'+config.path&&!value.searchParams.has('ref')&&value.hash==='#L2');await page.getByLabel('Plain text preview of '+config.path.split('/').at(-1),{exact:true}).waitFor();
 await page.reload();await page.getByLabel('Plain text preview of '+config.path.split('/').at(-1),{exact:true}).waitFor();check(new URL(page.url()).hash==='#L2');
 stage='served canonical settings and read-only unsupported Wiki';await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Settings',exact:true}).click();await page.waitForURL(value=>value.pathname==='/'+config.repository+'/settings');await page.getByRole('heading',{name:'Repository settings',exact:true}).waitFor();await page.getByText('Golf wiki workspace not yet available',{exact:false}).waitFor();check((await page.getByRole('button',{name:'Edit general settings',exact:true}).count())===0);
 const workspaceMetrics=[],codeMetrics=[],baselineAuthentication=await context.storageState();
 for(const theme of ['dark','light'])for(const width of [1280,1920,390]){
  const captureContext=await browser.newContext({viewport:{width,height:900},storageState:baselineAuthentication});const page=await captureContext.newPage();page.on('pageerror',()=>errors.push(true));
  stage='Code snapshot '+theme+' '+width;await page.goto(config.golf+'/'+config.repository);await page.locator('.source-tree-with-commits>li').first().waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check((await page.locator('html').getAttribute('data-theme'))===theme);
  stage='Code branch/tag menus '+theme+' '+width;await page.locator('.ref-controls>.ref-inventory-button').filter({hasText:'Branches'}).click();await page.locator('.branch-picker>.branch-options').getByRole('link',{name:new RegExp('^'+config.defaultBranch+' Listed at')}).waitFor();await page.locator('.branch-picker>.branch-options').getByRole('link',{name:/^proposal Listed at/}).waitFor();
  const tags=page.locator('.ref-controls>.ref-inventory-button').filter({hasText:'Tags'});await page.locator('.branch-picker>.branch-options').getByRole('button',{name:'Tags',exact:true}).click();const tag=page.locator('.branch-picker>.branch-options').getByRole('link',{name:new RegExp('^'+config.tagName+' Listed at')});await tag.waitFor();check((await tags.innerText())==='1 Tags');await tag.click();
  await page.waitForURL(value=>value.pathname.endsWith('/tree/'+config.snapshot.sha)&&value.searchParams.get('tag')===config.tagName);
  stage='Code native banner identity '+theme+' '+width;const banner=page.getByLabel('Latest commit',{exact:true});await banner.locator('.latest-commit-sha[title="'+config.snapshot.sha+'"]').waitFor({state:'attached'});check(await banner.locator('.latest-commit-author').isVisible());check(await banner.locator('.latest-commit-message').isVisible());check(await banner.locator('time').isVisible());check((await banner.locator('.latest-commit-author').innerText())===config.snapshot.authorName);check((await banner.locator('.latest-commit-message').getAttribute('title'))===config.snapshot.message);check((await banner.locator('.latest-commit-message').innerText())===config.snapshot.message.split('\n')[0]);check(Date.parse(await banner.locator('time').getAttribute('datetime'))===Date.parse(config.snapshot.authoredAt));
  stage='Code tag selection identity '+theme+' '+width;check((await page.locator('.branch-picker>summary').innerText())===config.tagName);check((await page.getByRole('button',{name:'Latest branch head',exact:true}).count())===0);
  stage='Code native row metadata '+theme+' '+width;const rows=page.locator('.source-tree-with-commits>li');check((await rows.count())>=2);for(let i=0;i<await rows.count();i++){const row=rows.nth(i);await row.locator('.source-entry-commit-title').waitFor();check(Boolean(await row.locator('.source-name').innerText()));check(Boolean(await row.locator('.source-entry-commit-title').innerText()));check(Number.isFinite(Date.parse(await row.locator('time').getAttribute('datetime'))));check(Boolean(await row.locator('time').getAttribute('title')));check(/ago|now|moment/.test(await row.locator('time').innerText()));}
  stage='Code bounded layout '+theme+' '+width;await page.evaluate(()=>window.scrollTo(0,0));const metrics=await page.evaluate(()=>{const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,main:box(document.querySelector('main')),latestCommit:box(document.querySelector('.repository-latest-commit')),firstFileRow:box(document.querySelector('.source-tree-with-commits>li')),refControls:box(document.querySelector('.ref-controls'))};});check(metrics.documentWidth<=width&&Math.abs(metrics.main.width-Math.min(width,1440))<=1&&Math.abs(metrics.main.x-(width-metrics.main.width)/2)<=1);codeMetrics.push({theme,width,...metrics});
  await page.screenshot({path:join(config.screenshots,'native-draft-code-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'native-draft-code-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());await captureContext.close();
 }
 await writeFile(join(config.screenshots,'native-draft-code-metrics.json'),JSON.stringify({runtime:config.runtime,fixture:{repository:config.repository,tag:config.tagName,peeledCommit:config.snapshot.sha},captureKind:'Actual supported-native tag selected through Branches/Tags UI; exact snapshot banner and file name/message/relative dates; independent clean-display contexts',metrics:codeMetrics},null,2),{mode:0o600});
 for(const theme of ['dark','light'])for(const width of [1280,390]){
  const captureContext=await browser.newContext({viewport:{width,height:900},storageState:baselineAuthentication});const page=await captureContext.newPage();page.on('pageerror',()=>errors.push(true));
  stage='plain Files changed '+theme+' '+width;await page.goto(url);await page.locator('.diff-file').first().waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check((await page.locator('html').getAttribute('data-theme'))===theme);await page.evaluate(()=>window.scrollTo(0,0));
  const metrics=await page.evaluate(()=>{const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};const first=document.querySelector('.diff-lines tr:not(.diff-hunk):not(.diff-annotation-row)');return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,firstDiffLine:box(first),toolbar:box(document.querySelector('.diff-toolbar')),controls:box(document.querySelector('.diff-controls')),fileTreeVisible:Boolean(document.querySelector('.diff-files')),privateDraftVisible:Boolean(document.querySelector('[aria-label="Private review draft"]'))};});
  check(metrics.firstDiffLine&&metrics.toolbar&&metrics.controls&&!metrics.privateDraftVisible&&metrics.documentWidth<=width);workspaceMetrics.push({theme,width,...metrics});
  await page.screenshot({path:join(config.screenshots,'native-draft-workspace-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'native-draft-workspace-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());await captureContext.close();
 }
 await writeFile(join(config.screenshots,'native-draft-workspace-metrics.json'),JSON.stringify({runtime:config.runtime,fixture:{repository:config.repository,pullNumber:config.number},captureKind:'Initial plain Files changed, before opening private draft; independent clean-display browser contexts share only the managed session cookies; viewport screenshots at scroll zero',metrics:workspaceMetrics},null,2),{mode:0o600});
 stage='explicit private line composition';await page.setViewportSize({width:1280,height:900});await page.goto(url);await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Private draft',exact:true}).click();await page.getByRole('button',{name:'Add private comment on new line 2 in '+config.path,exact:true}).click();
 const editor=page.getByRole('form',{name:'Private line comment editor',exact:true});await editor.getByRole('textbox',{name:'Private comment · new line 2 · '+config.path,exact:true}).fill('Browser-owned private note');await editor.getByRole('button',{name:'Keep comment',exact:true}).click();
 const region=page.getByRole('region',{name:'Private review draft',exact:true});await region.getByRole('button',{name:'Save private draft',exact:true}).click();await region.getByText('Saved privately in Golf. No review was published.',{exact:true}).waitFor();
 stage='reopen after navigation';await page.reload();await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Private draft',exact:true}).click();await region.getByRole('button',{name:'Reopen saved private draft',exact:true}).click();await region.getByText('Browser-owned private note',{exact:true}).waitFor();
 stage='explicit private edit';await page.getByRole('button',{name:'Edit private comment new line 2 in '+config.path,exact:true}).click();await editor.getByRole('textbox',{name:'Private comment · new line 2 · '+config.path,exact:true}).fill('Browser-edited private note');await editor.getByRole('button',{name:'Keep comment',exact:true}).click();await region.getByRole('button',{name:'Save private draft',exact:true}).click();await region.getByText('Saved privately in Golf. No review was published.',{exact:true}).waitFor();
 for(const theme of ['dark','light'])for(const width of [1280,390]){
  stage='private draft '+theme+' '+width;await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check((await page.locator('html').getAttribute('data-theme'))===theme);await region.getByText('Browser-edited private note',{exact:true}).waitFor();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await region.scrollIntoViewIfNeeded();await page.screenshot({path:join(config.screenshots,'native-private-draft-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'native-private-draft-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());
 }
 stage='live native private-access removal';check((await context.request.delete(config.forge+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);await page.locator('.diff-file').first().waitFor({state:'detached',timeout:15000});await region.waitFor({state:'detached',timeout:15000});check(!(await page.locator('body').innerText()).includes('Browser-edited private note'));check(errors.length===0);
 console.log('PASS: actual private draft canonical Unicode source alias/fragment/reload, settings/read-only Wiki, Add/Edit/Save/reopen, fourteen Code/workspace/draft captures, native tag selection/snapshot banner and measured layout positions, no overflow and live native revocation');
}catch(failure){console.error('Private draft browser failed at '+stage+'; '+(failure.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Private draft browser logout failed');process.exitCode=1;}await browser?.close();}
'''


def identity():
    return str(uuid.uuid4())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', required=True, type=Path,
                        help='Existing deployed Compose root with compose.yaml and .env; never starts/rebuilds services')
    parser.add_argument('--browser', action='store_true', help='Exercise deployed draft UI at1280/390px and Code tag/banner at1280/1920/390px in both themes')
    parser.add_argument('--screenshots', type=Path, help='Owner-only output directory for fourteen optional PNG/TXT pairs plus layout/provenance metadata')
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    if not (stack/'compose.yaml').is_file() or not (stack/'.env').is_file():
        parser.error('--stack-root must contain the deployed compose.yaml and .env')
    if args.browser and not (stack/'web/node_modules/playwright/index.mjs').is_file():
        parser.error('--browser requires the existing stack-root Playwright installation')
    compose = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack/'compose.yaml'), '--env-file', str(stack/'.env')]
    actors, enrolled, bearers = {}, [], []
    private = []
    stage = 'deployed readiness'

    def command(*arguments, payload=None):
        result = subprocess.run(arguments, cwd=stack, input=None if payload is None else json.dumps(payload),
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, 'Private subprocess failed'
        assert len(result.stdout) <= 2 << 20 and len(result.stderr) <= 2 << 20
        return result.stdout.strip()

    def admin(*arguments):
        return command(*compose, 'exec', '-T', 'forgejo', 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *arguments)  # Forgejo's upstream path

    def operator(action, payload):
        out = json.loads(command(*compose, 'exec', '-T', 'golf', '/usr/local/bin/golf', 'local-account', action, payload=payload))
        assert out['state'] == 'complete'
        return out['result']

    def metadata(query):
        # Queries below contain fixed SQL and validated native numeric IDs only.
        # Output is bounded counts; source/ciphertext/key material is never read.
        out = command(*compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'golf', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query)
        assert all(part.isdecimal() for part in out.split('|'))
        return tuple(map(int, out.split('|')))

    fixed_errors = set(re.findall(r'invalid\("([^"\n]+)"\)', (stack/'internal/server/pull_review_drafts.go').read_text()))

    def call(actor, method, payload, expected=200, code=None, headers=None):
        req = urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+REPOSITORY+method, data=json.dumps(payload).encode(), method='POST',
            headers={'Origin': smoke.GOLF, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json', **(headers or {})})
        try:
            response = actor['session'].open(req, timeout=20)
        except urllib.error.HTTPError as failure:
            response = failure
        with response:
            raw = response.read((2 << 20)+1)
            assert len(raw) <= 2 << 20 and response.headers.get('Cache-Control') == 'no-store'
            result = json.loads(raw) if raw else None
            if response.status != expected:
                error_code = result.get('code', '') if isinstance(result, dict) else ''
                message = result.get('message', '') if isinstance(result, dict) else ''
                if re.fullmatch(r'[a-z_]{1,40}', error_code):
                    print('RPC refusal class: '+error_code+(' · '+message if message in fixed_errors else ' · provider/private error text withheld'), file=sys.stderr)
            assert response.status == expected, 'HTTP '+str(response.status)+' expected '+str(expected)
            if expected != 200:
                codes = {400: 'invalid_argument', 401: 'unauthenticated', 403: 'permission_denied', 404: 'not_found', 409: 'aborted', 429: 'resource_exhausted', 503: 'unavailable'}
                assert result['code'] == (code or codes[expected]) and result['message']
            return result

    def capture(actor, target):
        selection = {**target, 'baseCommitId': current['base']['sha'], 'headCommitId': current['head']['sha']}
        pull = call(actor, 'GetPullRequest', {'repository': target['repository'], 'number': target['number']})['pullRequest']
        diff = call(actor, 'GetPullRequestDiff', selection)
        assert diff['mergeBaseCommitId'] == current['merge_base']
        assert diff['repositoryId'] == target['repositoryId'] and diff['pullRequestId'] == target['pullRequestId']
        req = urllib.request.Request(smoke.FORGE+'/api/v1/'+proute+'.diff', headers={'Authorization': 'token '+owner['token']})
        with smoke.client().open(req, timeout=15) as response:
            raw = response.read((512 << 10)+1)
        assert len(raw) <= 512 << 10 and raw.decode() == diff['rawDiff']
        return {'selection': selection, 'expectedPullRevision': pull['revision'], 'mergeBaseCommitId': diff['mergeBaseCommitId'], 'diffSha256': hashlib.sha256(raw).hexdigest()}, diff

    def creation(actor, target, generation):
        snapshot, _ = capture(actor, target)
        return {'target': target, 'draftId': identity(), 'operationId': identity(), 'expectedVersion': '0',
                'expectedTargetGeneration': generation, 'capture': snapshot, 'summary': 'Private draft qualification summary',
                'entries': [{'id': identity(), 'coordinate': {'side': side, 'line': 2, 'path': path}, 'body': 'Private draft qualification '+side}
                            for side in ['PULL_REVIEW_DRAFT_SIDE_OLD', 'PULL_REVIEW_DRAFT_SIDE_NEW']]}

    def edit(saved, text):
        return {'target': saved['draft']['target'], 'draftId': saved['draft']['id'], 'operationId': identity(),
                'expectedVersion': saved['currentVersion'], 'expectedTargetGeneration': saved['targetGeneration'],
                'comparisonId': saved['draft']['comparison']['id'], 'summary': text, 'entries': copy.deepcopy(saved['draft']['entries'])}

    def state(actor, target, draft=None, operation=None):
        payload = {'target': target}
        if draft is not None:
            payload['draftId'] = draft
        if operation is not None:
            payload['operationId'] = operation
        return call(actor, 'GetPullRequestReviewDraft', payload)

    def receipt(out, original, version, generation, kind):
        got = out['receipt']
        assert got['operationId'] == original['operationId'] and got['draftId'] == original['draftId']
        assert got['target'] == original['target'] and got['expectedVersion'] == original['expectedVersion']
        assert got['expectedTargetGeneration'] == original['expectedTargetGeneration']
        assert got['acceptedVersion'] == version and got['acceptedTargetGeneration'] == generation
        assert got['kind'] == 'PULL_REVIEW_DRAFT_OPERATION_KIND_'+kind

    try:
        smoke.ready()
        assert smoke.provider('', 'GET', 'version')['version'] == '15.0.9+gitea-1.22.0'  # Forgejo's upstream version string
        def runtime_identity():
            container = command(*compose, 'ps', '-q', 'golf')
            image_reference, compose_hash = command('docker', 'inspect', '--format', '{{.Image}}|{{index .Config.Labels "com.docker.compose.config-hash"}}', container).split('|')
            image_id, repo_digests = command('docker', 'image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}', image_reference).split('|')
            assert image_reference.startswith('sha256:') and image_id.startswith('sha256:')
            return {'containerImageReference': image_reference, 'imageInspectId': image_id, 'repoDigests': json.loads(repo_digests) or [], 'composeConfigHash': compose_hash,
                    'provenance': 'Supported Docker inspect selected fields; image IDs and Compose configuration hash are distinct fields, not inferred OCI manifest/config kinds.'}
        runtime = runtime_identity()
        print('Served Golf Docker container image reference: '+runtime['containerImageReference'], flush=True)
        stage = 'disposable native actors and managed Golf enrollment'
        prefix = 'golf-drafts-'+secrets.token_hex(4)
        for role in ['owner', 'reader', 'other', 'outsider']:
            name = prefix+'-'+role
            actors[role] = actor = {'name': name, 'session': None, 'created': False}
            admin('create', '--username', name, '--email', name+'@example.invalid', '--random-password', '--must-change-password=false')
            actor['created'] = True
            token = admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,read:issue', '--raw')
            actor.update(token=token, id=smoke.provider(token, 'GET', 'user')['id'], email=name+'@golf.invalid', password='Golf fixture '+secrets.token_urlsafe(24))
            private.extend([token, actor['password']])
            enrolled.append(actor)
            operator('create', {'username': name, 'email': actor['email'], 'password': actor['password'], 'forge_token': token, 'is_instance_admin': False})
            actor['session'] = smoke.client()
            smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username': actor['email'], 'password': actor['password']})
        owner, reader, other, outsider = [actors[r] for r in actors]
        stage = 'divergent native M B H comparison'
        repo = smoke.provider(owner['token'], 'POST', 'user/repos', {'name': 'private', 'private': True, 'auto_init': True}, 201)
        full, path = repo['full_name'], 'src/context ü.txt'
        route = 'repos/'+full
        smoke.wait_for_push(owner['token'], full)
        for actor in [reader, other]:
            smoke.provider(owner['token'], 'PUT', route+'/collaborators/'+actor['name'], {'permission': 'read'}, 204)
        stage = 'served native unit configuration receipts'
        repository_key = {'owner': owner['name'], 'name': 'private'}
        original_units = {field: repo[field] for field in ['has_issues', 'has_pull_requests', 'has_wiki']}
        assert all(isinstance(value, bool) for value in original_units.values())
        for configured in [dict.fromkeys(original_units, False), dict.fromkeys(original_units, True), {'has_issues': False, 'has_pull_requests': True, 'has_wiki': False}]:
            smoke.provider(owner['token'], 'PATCH', route, configured)
            native_units = smoke.provider(reader['token'], 'GET', route)
            projected = call(reader, 'GetRepository', {'repository': repository_key})['repository']
            assert projected['id'] == str(repo['id'])
            for native_field, golf_field in [('has_issues', 'issuesEnabled'), ('has_pull_requests', 'pullRequestsEnabled'), ('has_wiki', 'wikiEnabled')]:
                assert native_units[native_field] is configured[native_field] and projected[golf_field] is configured[native_field]
        call(outsider, 'GetRepository', {'repository': repository_key}, 404)
        smoke.provider(owner['token'], 'PATCH', route, original_units)
        print('PASS: actual served optional unit configuration matches native true/false/mixed receipts; private outsider denied; original configuration restored', flush=True)
        stage = 'divergent native M B H comparison'
        content_route = route+'/contents/'+quote(path, safe='/')
        def contents(method, branch, text, sha=None):
            payload = {'branch': branch, 'message': 'Private draft qualification fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha is not None:
                payload['sha'] = sha
            return smoke.provider(owner['token'], method, content_route, payload, 201 if method == 'POST' else 200)
        original = contents('POST', repo['default_branch'], 'context\nmerge-base old\nstable\n')
        merge_base = original['commit']['sha']
        smoke.provider(owner['token'], 'POST', route+'/branches', {'new_branch_name': 'proposal'}, 201)
        base = contents('PUT', repo['default_branch'], 'context\nbase-tip unrelated\nstable\n', original['content']['sha'])['commit']['sha']
        proposed = contents('PUT', 'proposal', 'context\nhead proposed\nstable\n', original['content']['sha'])
        head = proposed['commit']['sha']
        pull = smoke.provider(owner['token'], 'POST', route+'/pulls', {'head': 'proposal', 'base': repo['default_branch'], 'title': 'Private draft qualification'}, 201)
        proute = route+'/pulls/'+str(pull['number'])
        def settled(expected_head):
            deadline = time.monotonic()+30
            while True:
                observed = smoke.provider(owner['token'], 'GET', proute)
                retained = smoke.provider(owner['token'], 'GET', route+'/commits?sha=refs%2Fpull%2F'+str(pull['number'])+'%2Fhead&limit=1&stat=false&files=false&verification=false')
                if observed['merge_base'] == merge_base and observed['base']['sha'] == base and observed['head']['sha'] == expected_head and retained and retained[0]['sha'] == expected_head:
                    return observed
                assert time.monotonic() < deadline
                time.sleep(.2)
        current = settled(head)
        assert merge_base != base and head != merge_base
        stage = 'native annotated fixture tag and exact snapshot history'
        tag_name = 'qualification-snapshot'
        native_tag = smoke.provider(owner['token'], 'POST', route+'/tags', {'tag_name': tag_name, 'target': merge_base, 'message': 'Golf private fixture annotation'}, 201)
        assert native_tag['commit']['sha'] == merge_base and native_tag['id'] != merge_base
        native_snapshot = smoke.provider(owner['token'], 'GET', route+'/git/commits/'+merge_base+'?stat=false&files=false&verification=false')
        snapshot = {'sha': native_snapshot['sha'], 'message': native_snapshot['commit']['message'], 'authorName': native_snapshot['commit']['author']['name'], 'authoredAt': native_snapshot['commit']['author']['date']}
        tag_request = {'repository': {'owner': owner['name'], 'name': 'private'}, 'repositoryId': str(repo['id']), 'page': {'page': 1, 'limit': 100}}
        tags = call(reader, 'ListTags', tag_request)
        native_tag_request = urllib.request.Request(smoke.FORGE+'/api/v1/'+route+'/tags?limit=100&page=1', headers={'Authorization': 'token '+owner['token']})
        with smoke.client().open(native_tag_request, timeout=15) as tag_response:
            native_tags = json.loads(tag_response.read((2 << 20)+1))
            native_total = tag_response.headers.get('X-Total-Count')
        assert native_total == '1' and len(native_tags) == 1 and tags['repositoryId'] == str(repo['id']) and tags['totalCount'] == native_total
        assert len(tags['tags']) == 1 and tags['tags'][0]['name'] == tag_name and tags['tags'][0]['commitId'] == merge_base and tags['tags'][0]['id'] == native_tag['id']
        assert native_tags[0]['id'] == native_tag['id'] and native_tags[0]['commit']['sha'] == merge_base
        wrong_tag_target = copy.deepcopy(tag_request);wrong_tag_target['repositoryId'] = str(int(repo['id'])+1)
        call(reader, 'ListTags', wrong_tag_target, 400, 'failed_precondition')
        history = call(reader, 'ListCommits', {'repository': tag_request['repository'], 'repositoryId': str(repo['id']), 'ref': merge_base, 'page': {'page': 1, 'limit': 1}})
        assert history['repositoryId'] == str(repo['id']) and history['commitId'] == merge_base and not history.get('path', '') and history['commits'] == [snapshot]
        print('PASS: supported-native annotated tag object/peeled commit and observed total, wrong repository-ID denial, exact empty-path snapshot commit/author/message receipt', flush=True)
        stage = 'shared-publication baseline capture'
        target = {'repository': {'owner': owner['name'], 'name': 'private'}, 'repositoryId': str(repo['id']), 'pullRequestId': str(pull['id']), 'number': pull['number']}
        rid = int(repo['id'])
        activity_query = f'SELECT count(*) FROM golf_repository_activity WHERE repository_id={rid}'
        activity_before = metadata(activity_query)
        reviews_before = smoke.provider(owner['token'], 'GET', proute+'/reviews?limit=50')
        comments_before = smoke.provider(owner['token'], 'GET', route+'/issues/'+str(pull['number'])+'/comments?limit=50')
        assert not reviews_before and not comments_before
        stage = 'private original capture save and reopen'
        empty = state(reader, target)
        assert empty['targetGeneration'] == '0' and empty['currentVersion'] == '0' and 'draft' not in empty
        first = creation(reader, target, '0')
        _, initial_diff = capture(reader, target)
        headers = [line for line in initial_diff['rawDiff'].split('\n') if line.startswith(('diff --git ', '--- ', '+++ ', '@@ '))]
        print('Native diff header syntax traits: '+json.dumps([{'kind': 'file' if line.startswith('diff --git ') else 'hunk' if line.startswith('@@ ') else 'side', 'quoted': '"' in line, 'tabs': line.count('\t'), 'trailingTab': line.endswith('\t'), 'carriageReturns': line.count('\r')} for line in headers]), flush=True)
        saved = call(reader, 'SavePullRequestReviewDraft', first)
        receipt(saved, first, '1', '1', 'SAVE')
        assert saved['draft']['comparison']['capture'] == first['capture']
        assert saved['draft']['comparison']['parserVersion'] == 'golf-strict-diff-v1'
        assert saved['draft']['userId'] == str(reader['id']) and saved['draft']['entries'] == first['entries']
        assert all(entry['coordinate'].get('fileIndex', 0) == 0 and entry['coordinate'].get('hunkIndex', 0) == 0 for entry in saved['draft']['entries'])
        reopened = state(reader, target, first['draftId'], first['operationId'])
        assert reopened['draft'] == saved['draft'] and reopened['receipt'] == saved['receipt']
        stage = 'discarded acknowledgment and status-only inspection'
        second = edit(saved, 'Private draft qualification accepted without client receipt')
        req = urllib.request.Request(smoke.GOLF+'/rpc/golf.v1.'+REPOSITORY+'SavePullRequestReviewDraft', data=json.dumps(second).encode(), method='POST', headers={'Origin': smoke.GOLF, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json'})
        with reader['session'].open(req, timeout=20) as response:
            assert response.status == 200  # Intentionally do not consume the response body.
        inspected = state(reader, target, first['draftId'], second['operationId'])
        receipt(inspected, second, '2', '2', 'SAVE')
        assert inspected['draft']['summary'] == second['summary']
        replay = call(reader, 'SavePullRequestReviewDraft', second)
        assert replay['receipt'] == inspected['receipt'] and replay['draft'] == inspected['draft']
        changed = copy.deepcopy(second);changed['summary'] += ' different intent'
        call(reader, 'SavePullRequestReviewDraft', changed, 400, 'failed_precondition')
        stale = edit(saved, 'stale edit')
        call(reader, 'SavePullRequestReviewDraft', stale, 409, 'aborted')
        stage = 'head movement retains original comparison and exact operation receipt'
        advanced = contents('PUT', 'proposal', 'context\nnewer head\nstable\n', proposed['content']['sha'])
        current = settled(advanced['commit']['sha'])
        historical = state(reader, target)
        assert historical['draft']['comparison'] == saved['draft']['comparison']
        old_replay = call(reader, 'SavePullRequestReviewDraft', first)
        assert old_replay['receipt'] == saved['receipt'] and old_replay['currentVersion'] == '2'
        historical_edit = edit(inspected, 'Private draft qualification historical edit')
        historical_saved = call(reader, 'SavePullRequestReviewDraft', historical_edit)
        receipt(historical_saved, historical_edit, '3', '3', 'SAVE')
        stage = 'owner native identity and browser-only denials'
        exact = {'target': target, 'draftId': first['draftId'], 'operationId': first['operationId']}
        call(other, 'GetPullRequestReviewDraft', exact, 404)
        assert 'draft' not in state(other, target)
        call(outsider, 'GetPullRequestReviewDraft', exact, 404)
        wrong = copy.deepcopy(exact);wrong['target']['pullRequestId'] = str(int(pull['id'])+1)
        call(reader, 'GetPullRequestReviewDraft', wrong, 400, 'failed_precondition')
        for method, payload in [('GetPullRequestReviewDraft', exact), ('SavePullRequestReviewDraft', second), ('DeletePullRequestReviewDraft', {'target': target})]:
            call(reader, method, payload, 403, headers={'Origin': 'https://other.invalid'})
            smoke.rpc(smoke.client(), REPOSITORY+method, payload, 401, headers={'Authorization': 'token '+reader['token']})
        issued = smoke.rpc(reader['session'], 'ApiCredentialService/CreateApiCredential', {'label': 'Draft denial qualification', 'lifetimeSeconds': 600})
        bearers.append((reader, issued['credential']['id']))
        private.append(issued['token'])
        for method, payload in [('GetPullRequestReviewDraft', exact), ('SavePullRequestReviewDraft', second), ('DeletePullRequestReviewDraft', {'target': target})]:
            smoke.rpc(smoke.client(), REPOSITORY+method, payload, 403, headers={'Authorization': 'Bearer '+issued['token']})
        stage = 'tombstone recreation and old-request ABA rejection'
        deletion = {'target': target, 'draftId': first['draftId'], 'operationId': identity(), 'expectedVersion': '3', 'expectedTargetGeneration': '3'}
        deleted = call(reader, 'DeletePullRequestReviewDraft', deletion)
        receipt(deleted, deletion, '4', '4', 'DELETE')
        assert deleted['deleted'] and state(reader, target)['targetGeneration'] == '4'
        assert call(reader, 'DeletePullRequestReviewDraft', deletion) == deleted
        fresh = creation(reader, target, '4')
        replacement = call(reader, 'SavePullRequestReviewDraft', fresh)
        receipt(replacement, fresh, '1', '5', 'SAVE')
        delayed = copy.deepcopy(first);delayed['draftId'] = identity();delayed['operationId'] = identity()
        # Use a current capture so generation, rather than stale source, denies it.
        delayed['capture'] = fresh['capture']
        call(reader, 'SavePullRequestReviewDraft', delayed, 409, 'aborted')
        original_status = state(reader, target, first['draftId'], first['operationId'])
        assert original_status['deleted'] and 'draft' not in original_status and original_status['receipt'] == saved['receipt']
        assert state(reader, target)['draft']['id'] == fresh['draftId']
        stage = 'native permission revoke denies read save delete then restores receipt'
        smoke.provider(owner['token'], 'DELETE', route+'/collaborators/'+reader['name'], expected=204)
        call(reader, 'GetPullRequestReviewDraft', {'target': target}, 404)
        call(reader, 'SavePullRequestReviewDraft', edit(replacement, 'denied edit'), 404)
        call(reader, 'DeletePullRequestReviewDraft', {'target': target, 'draftId': fresh['draftId'], 'operationId': identity(), 'expectedVersion': '1', 'expectedTargetGeneration': '5'}, 404)
        smoke.provider(owner['token'], 'PUT', route+'/collaborators/'+reader['name'], {'permission': 'read'}, 204)
        assert state(reader, target)['draft'] == replacement['draft']
        fixture_names = ','.join("'"+actor['name']+"'" for actor in actors.values())
        owner_filter = f'user_id IN (SELECT id FROM golf_users WHERE login IN ({fixture_names}))'
        counts = metadata(f'SELECT count(*),(SELECT count(*) FROM golf_review_draft_versions WHERE {owner_filter}),(SELECT count(*) FROM golf_review_contents WHERE {owner_filter}) FROM golf_review_drafts WHERE {owner_filter}')
        assert counts == (2, 5, 7)
        assert metadata(activity_query) == activity_before
        assert smoke.provider(owner['token'], 'GET', proute+'/reviews?limit=50') == reviews_before
        assert smoke.provider(owner['token'], 'GET', route+'/issues/'+str(pull['number'])+'/comments?limit=50') == comments_before
        print('PASS: native M/B/H+diff SHA and old/new coordinates; save/reopen/edit CAS; discarded-body status/replay/intent denial; retained historical capture; delete/new UUID generation ABA; owner/PAT/bearer/Origin/native-revoke denials; no shared draft activity/native reviews', flush=True)
        print('Metadata evidence: two retained drafts, five immutable versions and seven encrypted-content records (no source/ciphertext extraction).', flush=True)
        if args.browser:
            stage = 'served private draft browser workflow'
            # Leave no active saved draft so browser explicitly authors its own.
            call(reader, 'DeletePullRequestReviewDraft', {'target': target, 'draftId': fresh['draftId'], 'operationId': identity(), 'expectedVersion': '1', 'expectedTargetGeneration': '5'})
            screens = (args.screenshots or stack/'.tmp/pull-review-drafts-smoke').resolve()
            screens.mkdir(parents=True, exist_ok=True, mode=0o700)
            if screens.stat().st_mode & 0o077:
                raise AssertionError('Screenshot output must be owner-only')
            proof = subprocess.run(['node', '--input-type=module', '-e', BROWSER], cwd=stack,
                input=json.dumps({'golf': smoke.GOLF, 'forge': smoke.FORGE, 'repository': full, 'number': pull['number'], 'path': path,
                    'email': reader['email'], 'password': reader['password'], 'user': reader['name'], 'ownerToken': owner['token'], 'screenshots': str(screens), 'runtime': runtime, 'tagName': tag_name, 'defaultBranch': repo['default_branch'], 'snapshot': snapshot}),
                capture_output=True, text=True, timeout=180)
            assert not any(secret in proof.stdout or secret in proof.stderr for secret in private)
            for line in proof.stdout.splitlines():
                if line.startswith('PASS: actual private draft '):
                    print(line, flush=True)
            for line in proof.stderr.splitlines():
                if line.startswith('Private draft browser failed at ') or line == 'Private draft browser logout failed':
                    print(line, file=sys.stderr)
            assert proof.returncode == 0
            assert runtime_identity() == runtime, 'Served runtime changed during qualifier'
            assert metadata(activity_query) == activity_before
            assert smoke.provider(owner['token'], 'GET', proute+'/reviews?limit=50') == reviews_before
            assert smoke.provider(owner['token'], 'GET', route+'/issues/'+str(pull['number'])+'/comments?limit=50') == comments_before
        else:
            print('Browser workflow/captures not run; use --browser after the draft UI is deployed.', flush=True)
    except Exception as failure:
        frames, trace = [], failure.__traceback__
        while trace is not None:
            frames.append(Path(trace.tb_frame.f_code.co_filename).name+':'+str(trace.tb_lineno))
            trace = trace.tb_next
        status = re.search(r'(?:HTTP |: )(\d{3}),? expected (\d{3})$', str(failure))
        detail = (' HTTP '+status[1]+' expected '+status[2]) if status else ''
        print('Private draft qualification failed at '+stage+'; '+type(failure).__name__+' '+','.join(frames)+detail+'; private diagnostics withheld', file=sys.stderr)
        raise
    finally:
        failures = []
        for actor, credential_id in bearers:
            try:
                smoke.rpc(actor['session'], 'ApiCredentialService/RevokeApiCredential', {'credentialId': credential_id})
            except Exception:
                failures.append('bearer revocation')
        for actor in actors.values():
            if actor['session'] is not None:
                try:
                    smoke.rpc(actor['session'], 'SessionService/RevokeOtherSessions')
                    smoke.rpc(actor['session'], 'SessionService/Logout')
                except Exception:
                    failures.append('session revocation')
        for actor in reversed(enrolled):
            try:
                assert operator('disable', {'username': actor['name']})['disabled']
            except Exception:
                failures.append('Golf account disable')
        for actor in reversed(list(actors.values())):
            if actor['created']:
                try:
                    admin('delete', '--username', actor['name'], '--purge')
                except Exception:
                    failures.append('native purge')
        assert not failures, 'Fixture cleanup failed; inspect the owned fixture account scope'
        print('Cleanup: native users/repos purged; fixture sessions/bearers revoked and Golf accounts disabled. Encrypted Golf draft/tombstone/account history remains retained by design.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Private draft qualification failed; private diagnostics withheld', file=sys.stderr)
        sys.exit(1)
