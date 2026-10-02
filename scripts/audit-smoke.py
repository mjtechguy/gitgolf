#!/usr/bin/env python3
"""Qualify durable account activity using ordinary disposable Compose users.

Provider users and live sessions are removed. Golf identities and append-only
history are deliberately retained; this fixture does not bypass audit retention.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys

sys.dont_write_bytecode = True
from smoke import GOLF, ROOT, admin, client, ready, rpc
spec=importlib.util.spec_from_file_location('organization_smoke',ROOT/'scripts/organizations-smoke.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
cli_call=helpers.cli_call

BROWSER=r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
let browser, context, config, stage='initialization';
function check(x){if(!x)throw new Error('assertion');}
try {
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));
 stage='sign in';await page.goto(config.golf);
 await page.getByText('Advanced token sign-in', { exact: true }).click();
 await page.getByLabel('Gitea access token',{exact:true}).fill(config.token);
 await page.getByRole('button',{name:'Continue to workspace',exact:true}).click();
 await page.getByRole('link',{name:'Account activity',exact:true}).click();
 stage='real activity';await page.getByRole('heading',{name:'Account activity',exact:true}).waitFor();
 await page.locator('.audit-event').first().waitFor();
 const first=(await page.locator('.audit-id').allTextContents())[0];
 check(await page.locator('.audit-event').count()===20);
 await page.getByRole('button',{name:'Load more activity',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.audit-event').length>20);
 check((await page.locator('.audit-id').allTextContents())[0]===first);
 stage='details and charcoal';await page.locator('.audit-event summary').first().click();
 await page.getByRole('button',{name:'Dark theme',exact:true}).click();await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:join(config.screenshots,'audit-dark.png')});
 stage='deep link and mobile';await page.reload();await page.locator('.audit-event').first().waitFor();check(new URL(page.url()).pathname==='/audit');
 await page.getByRole('button',{name:'Light theme',exact:true}).click();await page.setViewportSize({width:390,height:844});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(config.screenshots,'audit-light-mobile.png')});
 stage='current-session revocation';const sessions=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/ListSessions',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});
 check(sessions.status()===200);const current=(await sessions.json()).sessions.find(s=>s.current);check(current);
 const revoked=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/RevokeSession',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{sessionId:current.id}});
 check(revoked.status()===200);
 await page.getByRole('button',{name:'Refresh activity',exact:true}).click();
 await page.getByText('Advanced token sign-in',{exact:true}).waitFor();check(await page.locator('.audit-event').count()===0);check(errors.length===0);
 console.log('PASS: production account activity, snapshot pagination, details, deep links, dark/light/mobile and revoked-session cleanup');
} catch {console.error('Audit browser failed at '+stage+'; sensitive diagnostics withheld');process.exitCode=1;}
finally {
 if(context&&config)try {const r=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(r.status()===200);}
 catch {console.error('Browser logout failed');process.exitCode=1;}
 await browser?.close();
}
'''


def audit(session,payload=None,expected=200):
    return rpc(session,'AuditService/ListAuditEvents',payload or {},expected=expected)


def collect(session,initial=None):
    result=initial or audit(session,{'limit':1})
    snapshot=result.get('snapshotId','');events=list(result.get('events',[]))
    for _ in range(100):
        before=result.get('nextBeforeId','')
        if not before:return snapshot,events
        result=audit(session,{'limit':1,'beforeId':before,'snapshotId':snapshot})
        assert result['snapshotId']==snapshot
        events.extend(result.get('events',[]))
    raise AssertionError('Fixture pagination failed to terminate')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--cli',type=Path)
    parser.add_argument('--upgrade',action='store_true',help='apply an already-built new Golf image over a pre-audit preview and verify existing sessions')
    parser.add_argument('--restart',action='store_true',help='restart Golf to verify persisted history')
    args=parser.parse_args();binary=args.cli.resolve() if args.cli else None
    if binary and not binary.is_file():parser.error('build CLI first')
    ready();prefix='golf-audit-'+secrets.token_hex(5);users=[];sessions=[];actors=[]
    def login(token,session=None):
        session=session or client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':token})
        if session not in sessions:sessions.append(session)
        return session
    try:
        for role in ['owner','other']:
            name=prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password',
                  '--random-password-length','32','--must-change-password=false');users.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,
                        '--scopes','read:user','--raw').strip()
            actors.append({'name':name,'token':token,'session':login(token)})
        owner,other=actors
        primary=owner['session'];token=owner['token']
        if args.upgrade:
            existing=[rpc(a['session'],'SessionService/ListSessions')['sessions'] for a in actors]
            subprocess.run(['docker','compose','up','-d','golf'],cwd=ROOT,check=True,capture_output=True,timeout=90)
            ready()
            for actor,previous in zip(actors,existing):
                assert rpc(actor['session'],'SessionService/ListSessions')['sessions']==previous
                empty=audit(actor['session'])
                assert not empty.get('events',[]) and not empty.get('snapshotId','')
            login(token)
            historical_other=login(other['token']);rpc(historical_other,'SessionService/Logout')
            print('PASS: real pre-audit sessions survive image/schema upgrade without fabricated history',flush=True)
        assert [e['action'] for e in audit(primary)['events']]==['AUDIT_ACTION_SIGN_IN']
        assert audit(primary)['events'][0]['expiresAt']
        rpc(client(),'AuditService/ListAuditEvents',expected=401)
        target=login(token)
        target_id=next(s['id'] for s in rpc(target,'SessionService/ListSessions')['sessions'] if s.get('current'))
        rpc(primary,'SessionService/RevokeSession',{'sessionId':target_id})
        event=audit(primary)['events'][0]
        assert event['action']=='AUDIT_ACTION_SESSION_REVOKED' and event['targetSessionId']==target_id
        rpc(target,'AuditService/ListAuditEvents',expected=401)
        rpc(target,'SessionService/Logout')
        for _ in range(12):
            temporary=login(token);rpc(temporary,'SessionService/Logout')
        first=audit(primary,{'limit':1});old_snapshot,old_events=collect(primary,first)
        changed=login(token);rpc(changed,'SessionService/Logout')
        same_snapshot,same_events=collect(primary,first)
        assert same_snapshot==old_snapshot and same_events==old_events
        refreshed,new_events=collect(primary)
        assert int(refreshed)>int(old_snapshot) and len(new_events)==len(old_events)+2
        foreign=audit(other['session'])['snapshotId']
        for invalid in [{'snapshotId':foreign},{'snapshotId':'9223372036854775807'},
                        {'beforeId':'1'},{'limit':101},{'snapshotId':'01'}]:
            audit(primary,invalid,expected=400)
        assert not ({e['id'] for e in audit(other['session'])['events']} & {e['id'] for e in new_events})
        replacement=login(token)
        old_id=next(s['id'] for s in rpc(replacement,'SessionService/ListSessions')['sessions'] if s.get('current'))
        login(token,replacement)
        assert any(e['action']=='AUDIT_ACTION_SESSION_REPLACED' and e['targetSessionId']==old_id for e in audit(primary)['events'])
        # Switching identities records the old subject without disclosing the
        # new account in that subject's event; both retain their own history.
        login(other['token'],replacement)
        assert audit(primary)['events'][0]['action']=='AUDIT_ACTION_SESSION_REPLACED'
        assert audit(replacement)['events'][0]['action']=='AUDIT_ACTION_SIGN_IN'
        login(token)
        removed=rpc(primary,'SessionService/RevokeOtherSessions')
        count=int(removed.get('revokedCount','0'));assert count>=1
        event=audit(primary)['events'][0]
        assert event['action']=='AUDIT_ACTION_OTHER_SESSIONS_REVOKED' and int(event.get('revokedCount','0'))==count
        rpc(primary,'SessionService/RevokeOtherSessions')
        assert int(audit(primary)['events'][0].get('revokedCount','0'))==0
        serialized=json.dumps(audit(primary))
        assert all(a['token'] not in serialized for a in actors)
        assert not any(field in serialized for field in ['tokenHash','encryptedToken','authorization','bindingHash'])
        print('PASS: transactional lifecycle history, own-account scope, stable keyset snapshots, replacements, exact revocation counts and safe metadata',flush=True)
        if binary:
            before={s['id'] for s in rpc(primary,'SessionService/ListSessions')['sessions']}
            page=cli_call(binary,token,['audit','list','--limit','1'])
            assert len(page['events'])==1 and page['snapshotId']
            continuation=cli_call(binary,token,['audit','list','--limit','1','--before-id',page['nextBeforeId'],'--snapshot-id',page['snapshotId']])
            assert continuation['snapshotId']==page['snapshotId'] and int(continuation['events'][0]['id'])<int(page['events'][0]['id'])
            assert before=={s['id'] for s in rpc(primary,'SessionService/ListSessions')['sessions']}
            print('PASS: audit CLI JSON, snapshot continuation and ephemeral-session cleanup',flush=True)
        if args.restart:
            before=audit(primary)
            subprocess.run(['docker','compose','restart','golf'],cwd=ROOT,check=True,capture_output=True)
            ready();assert audit(primary)==before
            print('PASS: audit history and session survive Golf restart',flush=True)
        screenshots=ROOT/'.tmp/audit-smoke';screenshots.mkdir(parents=True,exist_ok=True)
        result=subprocess.run(['node','--input-type=module','-e',BROWSER],input=json.dumps({
            'golf':GOLF,'token':token,'screenshots':str(screenshots)}),cwd=ROOT,text=True,capture_output=True,timeout=90)
        assert result.returncode==0,result.stderr;print(result.stdout.strip(),flush=True)
        # Logout is a local credential cleanup even after provider account loss.
        revoked_provider=login(other['token'])
        admin('delete','--username',other['name'],'--purge');users.remove(other['name'])
        rpc(revoked_provider,'SessionService/Logout')
        rpc(revoked_provider,'AuditService/ListAuditEvents',expected=401)
        print('PASS: logout remains available after provider account removal',flush=True)
    finally:
        failures=[]
        for session in sessions:
            try:rpc(session,'SessionService/Logout')
            except Exception:failures.append('session')
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:failures.append('provider user')
        assert not failures,'Fixture cleanup failed; sensitive diagnostics withheld'
        print('CLEANUP: provider users and sessions removed; immutable account history retained',flush=True)

if __name__=='__main__':main()
