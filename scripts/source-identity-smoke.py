#!/usr/bin/env python3
"""Qualify served exact source/README/image identity on disposable native fixtures.

Uses supported native APIs/admin CLI and managed Golf enrollment only. Never
starts services, writes forge storage, runs inference/workflows or contacts a
remote organization. Credentials stay in memory; captures are owner-only.
This qualifies exact source selection, not the later readable-ref route packet.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from urllib.parse import quote

sys.dont_write_bytecode = True
import smoke

BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(value){if(!value)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers,data:{username:config.email,password:config.password}})).status()===200);
 const page=await context.newPage(),errors=[],requests=[],receipts=[];page.on('pageerror',()=>errors.push(true));
 page.on('request',request=>{if(/RepositoryService\/(GetContents|GetRepositoryImage)$/.test(request.url()))requests.push({procedure:request.url().split('/').at(-1),body:request.postDataJSON()});});
 page.on('response',async response=>{if(response.status()!==200||!/RepositoryService\/(GetContents|GetRepositoryImage)$/.test(response.url()))return;try{receipts.push({procedure:response.url().split('/').at(-1),body:await response.json()});}catch{errors.push(true);}});
 stage='served default source and referenced image';await page.goto(config.golf+'/'+config.repository);const readme=page.getByRole('region',{name:'Repository README',exact:true});await readme.getByRole('heading',{name:'Moved source identity',exact:true}).waitFor();const logo=readme.getByRole('img',{name:'Fixture logo',exact:true});await logo.waitFor();check((await logo.getAttribute('src')).startsWith('data:image/svg+xml;base64,'));
 if(config.overview){
  stage='served root repository sidebar';const sidebar=page.getByRole('complementary',{name:'About this repository',exact:true});await sidebar.getByRole('heading',{name:'About',exact:true}).waitFor();await sidebar.getByText('Repository overview qualification',{exact:true}).waitFor();await sidebar.getByRole('link',{name:'example.invalid/golf',exact:true}).waitFor();await sidebar.getByText('agentic',{exact:true}).waitFor();await sidebar.getByText('Python',{exact:true}).waitFor();
  for(const theme of ['dark','light'])for(const width of [1280,390]){await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.locator('html').getAttribute('data-theme')===theme);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'repository-overview-'+theme+'-'+width+'.png'),fullPage:true});await writeFile(join(config.screenshots,'repository-overview-'+theme+'-'+width+'.txt'),await page.locator('body').innerText(),{mode:0o600});}
 }
 stage='served immutable README after ref movement';await page.goto(config.golf+'/'+config.repository+'/blob/'+config.commit+'/README.md');await page.getByRole('heading',{name:'Exact source identity',exact:true}).waitFor();await page.getByRole('img',{name:'Fixture logo',exact:true}).waitFor();check(!new URL(page.url()).searchParams.has('ref'));
 const metrics=[];for(const theme of ['dark','light'])for(const width of [1280,390]){
  stage='served exact source capture '+theme+' '+width;await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.locator('html').getAttribute('data-theme')===theme);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'source-identity-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'source-identity-'+theme+'-'+width+'.txt'),await page.locator('body').innerText(),{mode:0o600});metrics.push({theme,width,documentWidth:await page.evaluate(()=>document.documentElement.scrollWidth)});
 }
 stage='served literal Unicode source and reload';await page.goto(config.golf+'/'+config.repository+'/blob/'+config.commit+'/'+config.path.split('/').map(encodeURIComponent).join('/')+'#L2');await page.getByLabel('Plain text preview of '+config.path.split('/').at(-1),{exact:true}).waitFor();check((await page.locator('body').innerText()).includes(config.text.trim().split('\n').at(-1)));await page.reload();await page.getByLabel('Plain text preview of '+config.path.split('/').at(-1),{exact:true}).waitFor();check(new URL(page.url()).hash==='#L2');
 stage='all served content and image requests use exact identity';await page.waitForTimeout(100);check(requests.some(row=>row.procedure==='GetContents')&&requests.some(row=>row.procedure==='GetRepositoryImage')&&receipts.some(row=>row.procedure==='GetRepositoryImage'));
 for(const row of requests){check(row.body.repositoryId===config.repositoryId);check(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.body.ref||row.body.commitId));}
 for(const row of receipts){check(row.body.repositoryId===config.repositoryId);if(row.procedure==='GetRepositoryImage')check(row.body.documentPath==='README.md'&&row.body.imageUrl==='./logo.svg'&&[config.commit,config.latest].includes(row.body.commitId));else check([config.commit,config.latest].includes(row.body.commitId));}
 let overviewPage;if(config.overview){stage='second-tab current root sidebar';overviewPage=await context.newPage();overviewPage.on('pageerror',()=>errors.push(true));await overviewPage.goto(config.golf+'/'+config.repository);await overviewPage.getByText('Repository overview qualification',{exact:true}).waitFor();await overviewPage.getByText('Python',{exact:true}).waitFor();await overviewPage.getByRole('heading',{name:'Moved source identity',exact:true}).waitFor();await overviewPage.getByRole('img',{name:'Fixture logo',exact:true}).waitFor();}
 stage='live private source revocation';check((await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);await page.getByLabel('Plain text preview of '+config.path.split('/').at(-1),{exact:true}).waitFor({state:'detached',timeout:20000});check(!(await page.locator('body').innerText()).includes(config.text.trim().split('\n').at(-1))&&errors.length===0);
 if(overviewPage){await overviewPage.getByRole('complementary',{name:'About this repository',exact:true}).waitFor({state:'detached',timeout:20000});await overviewPage.getByRole('region',{name:'Repository README',exact:true}).waitFor({state:'detached',timeout:20000});check(await overviewPage.getByRole('img',{name:'Fixture logo',exact:true}).count()===0);const remaining=await overviewPage.locator('body').innerText();check(!['Repository overview qualification','example.invalid/golf','Moved source identity','agentic','Python'].some(value=>remaining.includes(value))&&errors.length===0);}
 await writeFile(join(config.screenshots,'source-identity-metrics.json'),JSON.stringify({runtime:config.runtime,captureKind:'Actual exact source/README/image receipts; named route behavior not qualified',metrics},null,2),{mode:0o600});
 console.log('PASS: served exact source/README/image receipts, immutable source after branch movement, Unicode fragment/reload, four theme/mobile captures and live private revocation');
}catch(failure){console.error('Source identity browser failed at '+stage+'; '+(failure.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Source identity browser logout failed');process.exitCode=1;}await browser?.close();}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-root', required=True, type=Path)
    parser.add_argument('--screenshots', type=Path)
    parser.add_argument('--cli', type=Path, help='Optional current Golf CLI binary')
    parser.add_argument('--overview', action='store_true', help='Also qualify the integrated repository overview and root sidebar')
    args = parser.parse_args()
    stack = args.stack_root.resolve()
    if not all((stack / item).is_file() for item in ('compose.yaml', '.env', 'web/node_modules/playwright/index.mjs')):
        parser.error('--stack-root requires an existing deployed Compose stack and Playwright installation')
    cli = args.cli.resolve() if args.cli else None
    if cli and not cli.is_file():
        parser.error('--cli must name an existing binary')
    screens = (args.screenshots or stack / '.tmp/source-identity-served').resolve()
    screens.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(screens, 0o700)
    compose = ['docker', 'compose', '--project-directory', str(stack), '--file', str(stack / 'compose.yaml'), '--env-file', str(stack / '.env')]
    actors, enrolled = {}, []
    stage = 'readiness'

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
        image, settings = command('docker', 'inspect', '--format', '{{.Image}}|{{index .Config.Labels "com.docker.compose.config-hash"}}', container).split('|')
        assert image.startswith('sha256:')
        return {'containerImageReference': image, 'composeConfigHash': settings}

    try:
        smoke.ready()
        assert smoke.provider('', 'GET', 'version')['version'] == '1.27.3'
        baseline = runtime()
        prefix = 'golf-source-served-' + secrets.token_hex(4)
        stage = 'disposable actors and enrollment'
        for role in ('owner', 'reader', 'outsider'):
            name = prefix + '-' + role
            actors[role] = actor = {'name': name, 'created': False, 'session': None}
            admin('create', '--username', name, '--email', name + '@example.invalid', '--random-password', '--must-change-password=false')
            actor['created'] = True
            token = admin('generate-access-token', '--username', name, '--token-name', prefix, '--scopes', 'write:user,write:repository,write:issue', '--raw')
            actor.update(token=token, email=name + '@golf.invalid', password='Golf fixture ' + secrets.token_urlsafe(24))
            enrolled.append(actor)
            operator('create', {'username': name, 'email': actor['email'], 'password': actor['password'], 'forge_token': token, 'is_instance_admin': False})
            actor['session'] = smoke.client()
            smoke.rpc(actor['session'], 'SessionService/LoginWithPassword', {'username': actor['email'], 'password': actor['password']})
        owner, reader, outsider = (actors[role] for role in ('owner', 'reader', 'outsider'))
        stage = 'private source fixtures'
        repo = smoke.provider(owner['token'], 'POST', 'user/repos', {'name': 'private', 'private': True, 'auto_init': True}, 201)
        full, route = repo['full_name'], 'repos/' + repo['full_name']
        smoke.wait_for_push(owner['token'], full)
        smoke.provider(owner['token'], 'PUT', route + '/collaborators/' + reader['name'], {'permission': 'read'}, 204)
        key, rid = {'owner': owner['name'], 'name': 'private'}, str(repo['id'])

        def write(path, text, sha=None):
            body = {'branch': repo['default_branch'], 'message': 'Deterministic exact-source fixture', 'content': base64.b64encode(text.encode()).decode()}
            if sha:
                body['sha'] = sha
            return smoke.provider(owner['token'], 'PUT' if sha else 'POST', route + '/contents/' + quote(path, safe='/'), body, 200 if sha else 201)

        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#b8f36a"/></svg>'
        write('logo.svg', svg)
        if args.overview:
            write('app.py', 'def greet(name):\n    return f"Hello {name}"\n')
            smoke.provider(owner['token'], 'PATCH', route, {'description': 'Repository overview qualification', 'website': 'https://example.invalid/golf'})
            smoke.provider(owner['token'], 'PUT', route + '/topics', {'topics': ['agentic', 'golf', 'self-hosted']}, 204)
        path, text = 'docs/source % #? ü.txt', 'Source identity fixture\nExact immutable Unicode content\n'
        write(path, text)
        original = '# Exact source identity\n\n![Fixture logo](./logo.svg)\n'
        readme = smoke.provider(owner['token'], 'GET', route + '/contents/README.md')
        saved = write('README.md', original, readme['sha'])
        commit = saved['commit']['sha']
        named = 'feature/exact-source'
        smoke.provider(owner['token'], 'POST', route + '/branches', {'new_branch_name': named}, 201)
        smoke.provider(owner['token'], 'POST', route + '/tags', {'tag_name': named, 'target': commit}, 201)
        latest = write('README.md', original.replace('Exact source identity', 'Moved source identity'), saved['content']['sha'])['commit']['sha']
        # A valid Git ref can look exactly like another object's full ID. The
        # native contents endpoint guesses branches first; exact source must
        # still read the original object, not this deliberately different head.
        smoke.provider(owner['token'], 'POST', route + '/branches', {'new_branch_name': commit, 'old_branch_name': repo['default_branch']}, 201)

        def rpc(actor, procedure, payload, expected=200, code=None):
            return smoke.rpc(actor['session'], 'RepositoryService/' + procedure, payload, expected=expected, code=code)

        def resolve(kind, name, selected):
            response = rpc(reader, 'ResolveRepositorySource', {'repository': key, 'repositoryId': rid, 'selector': {'kind': 'REPOSITORY_SOURCE_REF_KIND_' + kind, 'name': name}, 'path': path})
            assert response['repositoryId'] == rid and response['repository'] == key and response['path'] == path
            assert response['selection']['kind'] == 'REPOSITORY_SOURCE_REF_KIND_' + kind and response['selection']['commitId'] == selected
            assert response['selection']['name'] == (repo['default_branch'] if kind == 'DEFAULT_BRANCH' else name)
            return response

        if args.overview:
            stage = 'current native repository overview observations'
            observed = smoke.provider(reader['token'], 'GET', route)
            # Native language indexing is asynchronous. Require meaningful real
            # fixture data, without representing it as selected-commit proof.
            for attempt in range(30):
                languages = smoke.provider(reader['token'], 'GET', route + '/languages')
                if languages.get('Python', 0) > 0:
                    break
                time.sleep(1)
            assert languages.get('Python', 0) > 0
            licenses = smoke.provider(reader['token'], 'GET', route + '/licenses')
            overview_request = {'repository': key, 'repositoryId': rid}
            overview = rpc(reader, 'GetRepositoryOverview', overview_request)
            assert overview['repository'] == key and overview['repositoryId'] == rid
            assert overview['description'] == observed['description'] == 'Repository overview qualification'
            assert overview['website'] == observed['website'] == 'https://example.invalid/golf'
            assert sorted(overview['topics']) == sorted(observed['topics']) == ['agentic', 'golf', 'self-hosted']
            for field, native in [('starsCount', 'stars_count'), ('watchersCount', 'watchers_count'), ('forksCount', 'forks_count')]:
                assert overview[field] == str(observed[native])
            assert overview['languagesState'] == 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE'
            assert {entry['name']: int(entry['byteCount']) for entry in overview['languages']} == languages
            assert overview['licensesState'] == 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE'
            assert sorted(overview.get('licenseIds', [])) == sorted(licenses)
            rpc(reader, 'GetRepositoryOverview', {**overview_request, 'repositoryId': str(repo['id'] + 1000000)}, 400, 'failed_precondition')
            rpc(outsider, 'GetRepositoryOverview', overview_request, 404)
            print('PASS: exact-ID authorized native overview, real indexed language bytes, topics/website/counts/license observations and private/wrong-ID denial', flush=True)

        stage = 'typed namespace and immutable source receipts'
        resolve('DEFAULT_BRANCH', '', latest)
        resolve('BRANCH', named, commit)
        resolve('TAG', named, commit)
        resolve('COMMIT', commit, commit)
        resolve('BRANCH', commit, latest)
        exact = {'repository': key, 'repositoryId': rid, 'ref': commit, 'path': path}
        source = rpc(reader, 'GetContents', exact)
        blob = hashlib.sha1(('blob ' + str(len(text.encode())) + '\0').encode() + text.encode()).hexdigest()
        assert source['repositoryId'] == rid and source['commitId'] == commit and source['path'] == path and source['file']['content'] == text and source['file']['entry']['sha'] == blob
        assert rpc(reader, 'GetContents', {**exact, 'path': 'README.md'})['file']['content'] == original
        image_request = {'repository': key, 'repositoryId': rid, 'commitId': commit, 'documentPath': 'README.md', 'imageUrl': './logo.svg'}
        image = rpc(reader, 'GetRepositoryImage', image_request)
        assert image['repositoryId'] == rid and all(image[field] == image_request[field] for field in ('commitId', 'documentPath', 'imageUrl'))
        assert image['mediaType'] == 'image/svg+xml' and base64.b64decode(image['content']) == svg.encode()
        for procedure, payload in [('GetContents', exact), ('GetRepositoryImage', image_request)]:
            rpc(reader, procedure, {**payload, 'repositoryId': str(repo['id'] + 1000000)}, 400, 'failed_precondition')
            rpc(outsider, procedure, payload, 404)
        rpc(reader, 'GetContents', {**exact, 'ref': named}, 400)
        legacy = rpc(reader, 'GetContents', {'repository': key, 'ref': repo['default_branch'], 'path': 'README.md'})
        assert legacy['repositoryId'] == rid and legacy['commitId'] == latest
        delegated = smoke.rpc(reader['session'], 'ApiCredentialService/CreateApiCredential', {'label': 'Exact source fixture', 'lifetimeSeconds': 300})
        bearer = smoke.client()
        authorization = {'Authorization': 'Bearer ' + delegated['token']}
        selected = smoke.rpc(bearer, 'RepositoryService/ResolveRepositorySource', {'repository': key, 'repositoryId': rid, 'selector': {'kind': 'REPOSITORY_SOURCE_REF_KIND_TAG', 'name': named}, 'path': path}, headers=authorization)
        assert selected['repositoryId'] == rid and selected['selection']['commitId'] == commit
        assert smoke.rpc(bearer, 'RepositoryService/GetContents', exact, headers=authorization)['file']['entry']['sha'] == blob
        assert smoke.rpc(bearer, 'RepositoryService/GetRepositoryImage', image_request, headers=authorization)['repositoryId'] == rid
        if args.overview:
            assert smoke.rpc(bearer, 'RepositoryService/GetRepositoryOverview', overview_request, headers=authorization)['repositoryId'] == rid
        smoke.rpc(reader['session'], 'ApiCredentialService/RevokeApiCredential', {'credentialId': delegated['credential']['id']})
        smoke.rpc(bearer, 'RepositoryService/GetContents', exact, headers=authorization, expected=401)
        print('PASS: typed default/slash branch/tag/commit selection, same-name branch/tag explicit namespaces, exact ID/SHA/path/blob/image receipts, wrong-ID/private denials and additive legacy receipt', flush=True)
        print('PASS: managed-session delegated typed resolver/source/image reads and revoked-bearer denial', flush=True)
        if cli:
            stage = 'current CLI exact source'
            smoke.cli_check(cli, reader['token'], full, commit, path, text)
            environment = {key: value for key, value in os.environ.items() if key not in {'GOLF_GITEA_TOKEN', 'GOLF_API_TOKEN'}}
            environment['GOLF_URL'] = smoke.GOLF
            checked = subprocess.run([str(cli), '--token-stdin', 'repo', 'contents', full, '--ref', named, '--ref-kind', 'tag', '--path', path], input=reader['token'] + '\n', cwd=stack, env=environment, capture_output=True, text=True, timeout=30)
            assert checked.returncode == 0 and reader['token'] not in checked.stdout and reader['token'] not in checked.stderr
            data = json.loads(checked.stdout)['data']
            assert data['repositoryId'] == rid and data['commitId'] == commit and data['path'] == path and data['file']['content'] == text
            print('PASS: current CLI explicit slash-tag selection and exact source identity', flush=True)
        stage = 'actual served exact source browser'
        config = {'golf': smoke.GOLF, 'gitea': smoke.GITEA, 'email': reader['email'], 'password': reader['password'], 'user': reader['name'], 'ownerToken': owner['token'], 'repository': full, 'repositoryId': rid, 'commit': commit, 'latest': latest, 'path': path, 'text': text, 'screenshots': str(screens), 'runtime': baseline, 'overview': args.overview}
        result = subprocess.run(['node', '--input-type=module', '-e', BROWSER], cwd=stack, input=json.dumps(config), capture_output=True, text=True, timeout=150)
        if result.returncode:
            for line in result.stderr.splitlines():
                if line.startswith('Source identity browser failed at ') or line == 'Source identity browser logout failed':
                    print(line, file=sys.stderr)
        assert result.returncode == 0, 'Browser qualification failed; private diagnostics withheld'
        assert result.stdout.startswith('PASS:') and len(result.stdout) < 4096
        print(result.stdout.strip(), flush=True)
        assert runtime() == baseline
        for capture in screens.iterdir():
            if capture.is_file():
                os.chmod(capture, 0o600)
    except Exception:
        print('Source identity qualifier failed at ' + stage + '; private diagnostics withheld', file=sys.stderr)
        raise
    finally:
        failures = []
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
                failures.append('managed disable')
        for actor in reversed(list(actors.values())):
            if actor['created']:
                try:
                    admin('delete', '--username', actor['name'], '--purge')
                except Exception:
                    failures.append('native purge')
        assert not failures, 'Owned fixture cleanup failed'
        print('Cleanup: native actors/repository purged, managed sessions revoked and accounts disabled.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Source identity qualifier failed; private diagnostics withheld', file=sys.stderr)
        sys.exit(1)
