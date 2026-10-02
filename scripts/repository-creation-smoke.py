#!/usr/bin/env python3
"""Qualify durable own-account creation against the actual local Compose Gitea.

Creates/purges ordinary provider users through supported interfaces; immutable
Golf identities/operation history remain. --restart briefly restarts Golf only.
This observes native effects/record identity, not the number of hidden upstream
POSTs or lost-response behavior; counted transport-fault tests cover those.
Credentials stay in memory/child input and all failure diagnostics are sanitized.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import traceback
import uuid

sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, provider, ready, request, rpc, wait_for_push

CREATE = 'RepositoryService/CreateRepository'
LOOKUP = 'RepositoryService/GetRepositoryCreation'
UNKNOWN = 'REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN'
SUCCEEDED = 'REPOSITORY_CREATION_STATE_SUCCEEDED'
REJECTED = 'REPOSITORY_CREATION_STATE_REJECTED'
STAGE = 'initialization'

BROWSER = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
let browser,context,config,stage='initialization';
function check(value){if(!value)throw new Error('assertion');}
const procedure='/rpc/golf.v1.RepositoryService/CreateRepository';
try {
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();const errors=[],sent=[];page.on('pageerror',()=>errors.push(true));
 page.on('request',request=>{if(new URL(request.url()).pathname===procedure)sent.push(request.postDataJSON());});
 const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 const stored=()=>page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('golf.repository-creation.')));
 stage='actual sign-in';await page.goto(config.golf);
 await page.getByLabel('Gitea access token',{exact:true}).fill(config.token);
 await page.getByRole('button',{name:'Continue to workspace',exact:true}).click();
 await page.getByRole('button',{name:'New repository',exact:true}).click();
 await page.getByLabel('Repository name').fill('browser-lost-ack');
 const description='Native <script>window.golfCreateExecuted=true</script>';
 await page.getByLabel('Description').fill(description);
 stage='real creation with lost browser acknowledgment';let accepted,routeFailed=false;
 await page.route('**'+procedure,async route=>{
   try {const response=await route.fetch();check(response.status()===200);accepted=await response.json();
     check(accepted.creation.state==='REPOSITORY_CREATION_STATE_SUCCEEDED');check(accepted.repository.id===accepted.creation.repositoryId);
   } catch {routeFailed=true;} finally {await route.abort('failed');}
 },{times:1});
 await page.getByRole('button',{name:'Create repository',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.creation-status')?.textContent?.includes('Creation may still be running'));
 check(!routeFailed&&accepted&&sent.length===1);check(await page.getByLabel('Repository name').isDisabled());
 let saved=await stored();check(saved.length===1);const intent=JSON.parse(saved[0][1]);
 check(Object.keys(intent).sort().join(',')==='key,name,private');check(intent.key===sent[0].idempotencyKey&&intent.private===true);
 check(!JSON.stringify(await page.evaluate(()=>({...sessionStorage,...localStorage}))).includes(config.token));
 check(!saved[0][1].includes(description));
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Dark theme',exact:true}).click();
 stage='reload resumes status-only lookup';await page.reload();
 await page.getByRole('button',{name:'Resume repository creation',exact:true}).click();
 stage='resumed intent is inspection-only';
 check(await page.getByRole('button',{name:'Retry same request',exact:true}).count()===0);
 check(await page.getByLabel('Description').inputValue()==='');
 await page.waitForFunction(()=>document.activeElement?.textContent==='Check status');
 await page.screenshot({path:join(config.screenshots,'creation-resume-dark.png')});
 stage='status lookup finishes before checking recovered intent';
 await page.getByRole('button',{name:'Check status',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('link',{name:config.owner+'/browser-lost-ack',exact:true}).waitFor();
 check(sent.length===1);check((await stored()).length===0);check(await page.evaluate(()=>window.golfCreateExecuted!==true));
 stage='real conflict and explicit new request';await page.getByRole('button',{name:'New repository',exact:true}).click();
 await page.getByLabel('Repository name').fill('keep-existing');
 await page.getByRole('button',{name:'Create repository',exact:true}).click();
 await page.getByRole('button',{name:'Start a new request',exact:true}).waitFor();
 check((await page.locator('.creation-status').innerText()).includes('Creation was rejected.'));
 check(await page.getByRole('button',{name:'Retry same request',exact:true}).count()===0);
 const rejected=sent.at(-1).idempotencyKey;await page.getByRole('button',{name:'Check status',exact:true}).click();
 await page.getByRole('button',{name:'Start a new request',exact:true}).waitFor();check(sent.length===2);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Light theme',exact:true}).click();await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Resume repository creation',exact:true}).click();
 await page.getByRole('button',{name:'Check status',exact:true}).click();
 await page.getByRole('button',{name:'Start a new request',exact:true}).waitFor();
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(config.screenshots,'creation-rejected-light-mobile.png')});
 await page.getByRole('button',{name:'Start a new request',exact:true}).click();
 await page.getByLabel('Repository name').fill('browser-new-request');
 await page.getByRole('button',{name:'Create repository',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('link',{name:config.owner+'/browser-new-request',exact:true}).waitFor();
 check(sent.length===3&&sent.at(-1).idempotencyKey!==rejected);check((await stored()).length===0);
 stage='real session revocation clears saved intent';await page.getByRole('button',{name:'New repository',exact:true}).click();
 await page.getByLabel('Repository name').fill('keep-existing');
 await page.getByRole('button',{name:'Create repository',exact:true}).click();
 await page.getByRole('button',{name:'Start a new request',exact:true}).waitFor();check((await stored()).length===1);
 const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/ListSessions',{headers,data:{}});
 check(response.status()===200);const current=(await response.json()).sessions.find(row=>row.current);check(current);
 const revoked=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/RevokeSession',{headers,data:{sessionId:current.id}});
 check(revoked.status()===200);await page.getByRole('button',{name:'Check status',exact:true}).click();
 await page.getByLabel('Gitea access token',{exact:true}).waitFor();check((await stored()).length===0);
 check(await page.locator('.creation-status').count()===0);check(errors.length===0);
 console.log('PASS: actual creation with lost browser acknowledgment, reload/status-only recovery, native rejection/new key, themes/mobile/keyboard and revoked-session privacy');
} catch {console.error('Creation browser failed at '+stage+'; diagnostics withheld');process.exitCode=1;}
finally {
 if(context&&config)try {const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(response.status()===200);}
 catch {console.error('Browser logout failed');process.exitCode=1;}
 await browser?.close();
}
'''


def stage(name):
    global STAGE
    STAGE = name
    print('CHECK: ' + name, flush=True)


def key():
    return str(uuid.uuid4())


def creation(result, expected_key, name, private, expected_state=None):
    row = result['creation']
    assert str(int(row['id'])) == row['id'] and int(row['id']) > 0
    parsed = uuid.UUID(row['idempotencyKey'])
    assert parsed.version == 4 and str(parsed) == row['idempotencyKey'] == expected_key
    assert row['requestedName'] == name and row.get('private', False) == private
    assert row['state'] in {UNKNOWN, SUCCEEDED, REJECTED}
    if expected_state:
        assert row['state'] == expected_state
    for field in ['createdAt', 'updatedAt']:
        assert datetime.fromisoformat(row[field].replace('Z', '+00:00')).utcoffset() is not None
    assert set(row) <= {'id', 'idempotencyKey', 'state', 'requestedName', 'private',
                        'createdAt', 'updatedAt', 'repositoryId', 'failureCode'}
    if row['state'] == SUCCEEDED:
        assert str(int(row['repositoryId'])) == row['repositoryId'] and int(row['repositoryId']) > 0
        assert not row.get('failureCode')
    else:
        assert not result.get('repository') and not row.get('repositoryId')
    return row


def lookup(session, operation_key, **kwargs):
    return rpc(session, LOOKUP, {'idempotencyKey': operation_key}, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart', action='store_true', help='restart Golf to check durable operation records')
    parser.add_argument('--cli', type=Path, help='verify the built read-only repo creation CLI')
    parser.add_argument('--browser', action='store_true', help='verify the production-served browser, including lost browser acknowledgment')
    args = parser.parse_args()
    binary = args.cli.resolve() if args.cli else None
    if binary and not binary.is_file():
        parser.error('build the CLI before supplying --cli')
    ready()
    assert request(client(), 'GET', GITEA + '/api/v1/version')['version'] == '1.27.3'
    users, sessions, actors = [], [], []
    prefix = 'golf-create-' + secrets.token_hex(5)

    def login(token):
        session = client()
        rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})
        sessions.append(session)
        return session

    try:
        for role in ['owner', 'other']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name + '@example.invalid',
                  '--random-password', '--random-password-length', '32', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository', '--raw')
            actors.append({'name': name, 'token': token, 'session': login(token)})
        owner, other = actors
        primary = owner['session']
        operation_key = key()
        payload = {'name': 'durable-private', 'description': 'Native durable creation fixture',
                   'private': True, 'idempotencyKey': operation_key}

        stage('origin, authentication and canonical-key validation')
        rpc(client(), CREATE, payload, expected=401)
        lookup(client(), operation_key, expected=401)
        rpc(primary, CREATE, payload, headers={'Origin': 'https://invalid.example'}, expected=403)
        lookup(primary, operation_key, headers={'Origin': 'https://invalid.example'}, expected=403)
        lookup(primary, operation_key, expected=404)
        uppercase = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'
        for malformed in [uppercase, ' ' + operation_key, str(uuid.uuid1()), '../' + operation_key]:
            rpc(primary, CREATE, {**payload, 'idempotencyKey': malformed}, expected=400)
            lookup(primary, malformed, expected=400)
        rpc(primary, CREATE, {'name': 'missing-visibility', 'idempotencyKey': key()}, expected=400)

        stage('concurrent identical requests and stable native repository identity')
        peers = [login(owner['token']) for _ in range(4)]
        barrier = threading.Barrier(len(peers), timeout=15)

        def dispatch(session):
            barrier.wait()
            return rpc(session, CREATE, payload)

        with ThreadPoolExecutor(max_workers=len(peers)) as workers:
            responses = list(workers.map(dispatch, peers))
        records = [creation(value, operation_key, payload['name'], True) for value in responses]
        assert len({record['id'] for record in records}) == 1
        assert all(record['state'] in {UNKNOWN, SUCCEEDED} for record in records)
        deadline = time.monotonic() + 45
        while True:
            result = lookup(primary, operation_key)
            record = creation(result, operation_key, payload['name'], True)
            if record['state'] != UNKNOWN:
                break
            assert time.monotonic() < deadline, 'Creation did not settle within the fixture deadline'
            time.sleep(0.25)
        assert record['state'] == SUCCEEDED and record['id'] == records[0]['id']
        repository = result['repository']
        full_name = owner['name'] + '/' + payload['name']
        assert repository['fullName'] == full_name and repository['private'] is True
        assert repository['id'] == record['repositoryId']
        native = provider(owner['token'], 'GET', 'repos/' + full_name)
        assert str(native['id']) == repository['id'] and native['description'] == payload['description']
        repeated = rpc(primary, CREATE, payload)
        assert creation(repeated, operation_key, payload['name'], True, SUCCEEDED) == record
        assert repeated['repository']['id'] == repository['id']
        listed = provider(owner['token'], 'GET', 'user/repos?limit=100')
        assert [row['id'] for row in listed if row['name'] == payload['name']] == [native['id']]

        stage('same-key payload collisions and foreign-account privacy')
        for change in [{'name': 'changed-name'}, {'description': 'changed'}, {'private': False}]:
            rpc(primary, CREATE, {**payload, **change}, expected=400, code='failed_precondition')
        assert lookup(primary, operation_key)['creation'] == record
        provider(owner['token'], 'GET', 'repos/' + owner['name'] + '/changed-name', expected=404)
        missing = lookup(other['session'], key(), expected=404)
        assert lookup(other['session'], operation_key, expected=404) == missing
        provider(other['token'], 'GET', 'repos/' + full_name, expected=404)
        request(client(), 'GET', GITEA + '/api/v1/repos/' + full_name, expected=404)
        separate = rpc(other['session'], CREATE, payload)
        separate_row = creation(separate, operation_key, payload['name'], True, SUCCEEDED)
        assert separate_row['id'] != record['id'] and separate_row['repositoryId'] != record['repositoryId']
        assert separate['repository']['fullName'] == other['name'] + '/' + payload['name']
        print('PASS: native concurrent creation, stable own-account records, payload binding and private/key isolation', flush=True)

        stage('terminal native conflict without overwriting existing repository')
        existing = provider(owner['token'], 'POST', 'user/repos',
                            {'name': 'keep-existing', 'description': 'Preserve this native content',
                             'private': True, 'auto_init': True}, 201)
        existing_full = owner['name'] + '/keep-existing'
        wait_for_push(owner['token'], existing_full)
        branch = existing['default_branch']
        before = provider(owner['token'], 'GET', 'repos/' + existing_full + '/branches/' + branch)['commit']['id']
        collision_key = key()
        collision_payload = {'name': 'keep-existing', 'description': 'Must not overwrite',
                             'private': False, 'idempotencyKey': collision_key}
        rejected = rpc(primary, CREATE, collision_payload)
        rejected_row = creation(rejected, collision_key, 'keep-existing', False, REJECTED)
        assert rejected_row['failureCode'] == 'provider_http_409'
        assert rpc(primary, CREATE, collision_payload)['creation'] == rejected_row
        assert lookup(primary, collision_key)['creation'] == rejected_row
        preserved = provider(owner['token'], 'GET', 'repos/' + existing_full)
        assert preserved['id'] == existing['id'] and preserved['private'] is True
        assert preserved['description'] == 'Preserve this native content'
        assert provider(owner['token'], 'GET', 'repos/' + existing_full + '/branches/' + branch)['commit']['id'] == before
        rpc(primary, CREATE, {'name': 'keep-existing', 'private': True}, expected=409, code='already_exists')

        stage('scoped rejection stays terminal after credential permissions change')
        narrow_token = admin('generate-access-token', '--username', owner['name'], '--token-name', prefix + '-read',
                             '--scopes', 'read:user,read:repository', '--raw')
        narrow = login(narrow_token)
        scope_key = key()
        scope_payload = {'name': 'scope-rejected', 'private': True, 'idempotencyKey': scope_key}
        denied = rpc(narrow, CREATE, scope_payload)
        denied_row = creation(denied, scope_key, scope_payload['name'], True, REJECTED)
        assert denied_row['failureCode'] == 'provider_http_403'
        assert rpc(primary, CREATE, scope_payload)['creation'] == denied_row
        assert lookup(primary, scope_key)['creation'] == denied_row
        provider(owner['token'], 'GET', 'repos/' + owner['name'] + '/scope-rejected', expected=404)
        rpc(narrow, CREATE, {'name': 'legacy-scope-rejected', 'private': True}, expected=403)
        scope_success = rpc(primary, CREATE, {**scope_payload, 'idempotencyKey': key()})
        assert scope_success['repository']['name'] == scope_payload['name']
        legacy = rpc(primary, CREATE, {'name': 'legacy-public', 'private': False})
        creation(legacy, legacy['creation']['idempotencyKey'], 'legacy-public', False, SUCCEEDED)
        assert legacy['repository'].get('private', False) is False
        print('PASS: native terminal conflict/scope rejection, no overwrite and legacy/public compatibility', flush=True)

        stage('current authorization and immutable ID prevent historical access grants')
        identity_token = admin('generate-access-token', '--username', owner['name'], '--token-name', prefix + '-identity',
                               '--scopes', 'read:user', '--raw')
        identity_only = login(identity_token)
        inaccessible = lookup(identity_only, operation_key)
        assert inaccessible['creation'] == record and not inaccessible.get('repository')
        assert lookup(primary, operation_key)['repository']['id'] == str(native['id'])
        victim = login(owner['token'])
        victim_id = next(row['id'] for row in rpc(victim, 'SessionService/ListSessions')['sessions'] if row.get('current'))
        rpc(primary, 'SessionService/RevokeSession', {'sessionId': victim_id})
        lookup(victim, operation_key, expected=401)
        revoked_key = key()
        rpc(victim, CREATE, {'name': 'revoked-session', 'private': True, 'idempotencyKey': revoked_key}, expected=401)
        lookup(primary, revoked_key, expected=404)
        if args.restart:
            stage('operation persistence across actual Golf restart')
            subprocess.run(['docker', 'compose', 'restart', 'golf'], cwd=ROOT, capture_output=True, check=True, timeout=90)
            ready()
            assert lookup(primary, operation_key)['creation'] == record
            assert lookup(primary, collision_key)['creation'] == rejected_row
            assert lookup(primary, scope_key)['creation'] == denied_row
            assert rpc(primary, CREATE, payload)['repository']['id'] == record['repositoryId']
            print('PASS: actual Golf restart preserves successful and rejected operation records', flush=True)
        else:
            print('SKIP: actual Golf restart (enable --restart)', flush=True)
        if binary:
            stage('read-only CLI record/state/identity and credential cleanup')
            spec = importlib.util.spec_from_file_location('organization_smoke', ROOT / 'scripts/organizations-smoke.py')
            helpers = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helpers)
            before_sessions = rpc(primary, 'SessionService/ListSessions')
            inspected = helpers.cli_call(binary, owner['token'], ['repo', 'creation', operation_key])
            assert inspected['creation']['id'] == record['id'] and inspected['creation']['state'] == SUCCEEDED
            assert inspected['creation']['repositoryId'] == inspected['repository']['id'] == record['repositoryId']
            rejected_cli = helpers.cli_call(binary, owner['token'], ['repo', 'creation', collision_key])
            assert rejected_cli['creation']['state'] == REJECTED and not rejected_cli.get('repository')
            helpers.cli_call(binary, other['token'], ['repo', 'creation', collision_key], expected=1)
            helpers.cli_call(binary, owner['token'], ['repo', 'creation', uppercase], expected=2)
            assert rpc(primary, 'SessionService/ListSessions') == before_sessions
            print('PASS: read-only CLI own record/native identity, rejected evidence, foreign denial and ephemeral cleanup', flush=True)
        else:
            print('SKIP: read-only CLI (enable --cli)', flush=True)
        provider(owner['token'], 'DELETE', 'repos/' + full_name, expected=204)
        deleted = lookup(primary, operation_key)
        assert deleted['creation'] == record and not deleted.get('repository')
        replacement = provider(owner['token'], 'POST', 'user/repos',
                               {'name': payload['name'], 'description': 'Different native repository identity', 'private': True}, 201)
        assert str(replacement['id']) != record['repositoryId']
        replaced = lookup(primary, operation_key)
        assert replaced['creation'] == record and not replaced.get('repository')
        assert not rpc(primary, CREATE, payload).get('repository')
        assert provider(owner['token'], 'GET', 'repos/' + full_name)['description'] == 'Different native repository identity'
        print('PASS: revoked-session denial and historical records never bind deleted/replaced native identities', flush=True)
        if args.browser:
            stage('production browser and real downstream acknowledgment loss')
            screenshots = ROOT / '.tmp/repository-creation-smoke'
            screenshots.mkdir(parents=True, exist_ok=True)
            outcome = subprocess.run(['node', '--input-type=module', '-e', BROWSER], cwd=ROOT,
                text=True, capture_output=True, timeout=120,
                input=json.dumps({'golf': GOLF, 'token': owner['token'], 'owner': owner['name'], 'screenshots': str(screenshots)}))
            if outcome.returncode:
                for line in outcome.stderr.splitlines():
                    if line.startswith('Creation browser failed at ') or line == 'Browser logout failed':
                        print(line)
            assert outcome.returncode == 0, 'Production browser qualification failed'
            for line in outcome.stdout.splitlines():
                if line.startswith('PASS: '):
                    print(line)
        else:
            print('SKIP: production browser (enable --browser)', flush=True)
        print('BOUNDARY: native checks observe effects; exact POST counts/lost-response UNKNOWN are separate transport-fault evidence', flush=True)
    finally:
        failures = []
        for actor in actors:
            try:
                rpc(actor['session'], 'SessionService/RevokeOtherSessions')
            except Exception:
                failures.append('session cleanup')
        for session in sessions:
            try:
                rpc(session, 'SessionService/Logout')
            except Exception:
                failures.append('logout')
        for name in reversed(users):
            try:
                admin('delete', '--username', name, '--purge')
            except Exception:
                failures.append('provider cleanup')
        assert not failures, 'Repository creation fixture cleanup failed'
        print('PASS: disposable provider users/repositories and active Golf sessions removed; immutable Golf history retained', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        locations = ' > '.join(str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)
                               if Path(frame.filename).name == Path(__file__).name)
        raise SystemExit('Repository creation qualification failed at ' + STAGE + ' (' + locations + '); diagnostics withheld')
