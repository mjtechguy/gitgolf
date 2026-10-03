#!/usr/bin/env python3
"""Qualify immutable native commit diffs on the actual local Compose provider.

Creates/purges ordinary users and a private repository using supported APIs/Git.
Credentials remain in memory, environment or child stdin; diagnostics withheld.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import traceback
import urllib.request
import re

sys.dont_write_bytecode = True
from smoke import GOLF, GITEA, ROOT, admin, client, command, commit, provider, ready, rpc, wait_for_push
spec = importlib.util.spec_from_file_location('organization_smoke', ROOT/'scripts/organizations-smoke.py')
helpers = importlib.util.module_from_spec(spec); spec.loader.exec_module(helpers)

BROWSER = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
let browser,context,config,stage='initialization';
function check(value){if(!value)throw new Error('assertion');}
try {
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));
 stage='sign in';await page.goto(config.golf);
 await page.getByText('Advanced token sign-in', { exact: true }).click();
 await page.getByLabel('Provider access token',{exact:true}).fill(config.memberToken);
 await page.getByRole('button',{name:'Continue to workspace',exact:true}).click();
 await page.getByLabel('Your account', { exact: true }).waitFor();
 const url=config.golf+'/'+config.owner+'/diffs/commit/'+config.root;
 stage='root diff deep link';await page.goto(url);
 const diff=page.getByLabel('Unified diff, plain text',{exact:true});await diff.waitFor({state:'attached'});
 check((await diff.textContent()).includes('<script>window.golfDiffExecuted=true</script>'));
 check(await page.evaluate(()=>window.golfDiffExecuted!==true));
 check(await page.locator('.branch-picker').count()===0);
 if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
 await page.screenshot({path:join(config.screenshots,'commit-diff-dark.png')});
 stage='shared diff tree/filter/display controls';
 const navigation=page.getByRole('navigation',{name:'Changed file navigation'});
 const source=navigation.getByRole('link',{name:'src/example.ts',exact:true});await source.waitFor();
 const count=await page.locator('.diff-file').count();check(count===5);
 await page.getByLabel('Folder src',{exact:true}).click();check(!await source.isVisible());
 await page.getByLabel('Folder src',{exact:true}).click();await source.click();
 const target=await source.getAttribute('href');check(target&&target.startsWith('#diff-'+config.root+'-file-'));
 const file=page.locator(target);await file.locator('.hljs-keyword').waitFor();
 check((await file.locator('.diff-code code').textContent()).includes('const greeting'));
 check(await file.locator('.diff-code img,.diff-code script').count()===0);
 await page.getByText('File filter',{exact:true}).click();await page.getByLabel('.ts',{exact:true}).uncheck();check(await page.locator('.diff-file').count()===3);
 await page.getByLabel('.ts',{exact:true}).check();await page.getByText('File filter',{exact:true}).press('Escape');
 await file.getByLabel('Viewed',{exact:true}).check();
 await page.getByText('File filter',{exact:true}).click();await page.getByLabel('Viewed files visibility').selectOption('viewed');
 check(await page.locator('.diff-file').count()===1);check(await file.count()===1);
 await page.getByRole('button',{name:'Reset file filters',exact:true}).click();await page.getByText('File filter',{exact:true}).press('Escape');
 await file.getByLabel('Viewed',{exact:true}).uncheck();
 await page.getByRole('button',{name:'Split',exact:true}).click();await page.getByLabel('Diff settings',{exact:true}).click();
 await page.getByLabel('Wrap lines',{exact:true}).check();await page.getByLabel('Diff settings',{exact:true}).press('Escape');
 await page.getByRole('button',{name:'Hide file tree',exact:true}).click();await page.reload();await diff.waitFor({state:'attached'});
 check(await page.getByRole('button',{name:'Show file tree',exact:true}).count()===1);check(await page.getByText('0/5 viewed this session',{exact:true}).count()===1);
 check(await page.locator('.diff-lines.split').count()===5);check(await page.locator('.diff-workspace.wrap-lines').count()===1);
 const preferences=await page.evaluate(()=>JSON.parse(localStorage.getItem('golf.diff-display.v1')));
 check(Object.keys(preferences).length===4&&Object.values(preferences).every(value=>typeof value==='boolean'));
 check(!await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('src/example.ts')));
 await page.getByRole('button',{name:'Show file tree',exact:true}).click();
 for(const theme of ['dark','light'])for(const width of [1280,390]) {
  await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>scrollTo(0,0));check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(config.screenshots,'diff-workspace-'+theme+'-'+width+'.png'),fullPage:true});
 }
 stage='reload selected commit';await page.reload();await diff.waitFor({state:'attached'});
 check(new URL(page.url()).pathname.endsWith('/commit/'+config.root));
 stage='exact source navigation';await page.getByRole('link',{name:'Browse this commit',exact:true}).click();
 await page.locator('.source-tree').waitFor();check(new URL(page.url()).pathname.endsWith('/tree/'+config.root));
 stage='back to selected commit/history';await page.goBack();await diff.waitFor({state:'attached'});
 await page.getByRole('link',{name:'Back to commit history',exact:true}).click();
 await page.locator('.commit-list').waitFor();
 stage='merge diff and mobile';await page.goto(config.golf+'/'+config.owner+'/diffs/commit/'+config.merge);
 await diff.waitFor({state:'attached'});check((await diff.textContent()).includes('side.txt'));check(!(await diff.textContent()).includes('diff --git a/README.md'));
 if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();await page.setViewportSize({width:390,height:844});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(config.screenshots,'commit-diff-light-mobile.png')});
 stage='provider membership revocation';const removed=await context.request.delete(config.gitea+'/api/v1/repos/'+config.owner+'/diffs/collaborators/'+config.member,
 {headers:{Authorization:'token '+config.ownerToken}});check(removed.status()===204);
 await page.getByRole('alert').waitFor({timeout:15000});
 check(await diff.count()===0);check(errors.length===0);
 console.log('PASS: real diff tree/filter/Viewed/display/syntax controls, literal HTML text, exact source/history/reload, first-parent merge, dark/light desktop/mobile and live revoked-access cleanup');
} catch {console.error('Diff browser failed at '+stage+'; sensitive diagnostics withheld');process.exitCode=1;}
finally {
 if(context&&config)try {const r=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',
 {headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(r.status()===200);}
 catch {console.error('Browser logout failed');process.exitCode=1;}
 await browser?.close();
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', type=Path)
    args = parser.parse_args()
    binary = args.cli.resolve() if args.cli else None
    if binary:
        assert binary.is_file(), 'Build CLI first'
    ready(); prefix = 'golf-diff-'+secrets.token_hex(5); users=[]; sessions=[]
    try:
        for role, scopes in [('owner','write:user,write:repository'),('member','read:user,read:repository')]:
            name=prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password',
                  '--random-password-length','32','--must-change-password=false'); users.append(name)
            token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes',scopes,'--raw').strip()
            session=client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':token});sessions.append(session)
            if role=='owner': owner,owner_token,owner_name=session,token,name
            else: member,member_token,member_name=session,token,name
        rpc(owner,'RepositoryService/CreateRepository',{'name':'diffs','private':True})
        key={'owner':owner_name,'name':'diffs'};full_name=owner_name+'/diffs'
        def diff(sha, session=owner, expected=200, code=None):
            try:
                return rpc(session,'RepositoryService/GetCommitDiff',{'repository':key,'commitId':sha},expected=expected,code=code)
            except AssertionError as error:
                match=re.search(r': ([0-9]{3}), expected ([0-9]{3})$',str(error))
                if match:print('Diff RPC actual/expected HTTP:',match.group(1),match.group(2))
                raise
        with tempfile.TemporaryDirectory(prefix='golf-diff-') as directory:
            path=Path(directory); work=path/'work';work.mkdir();command('git','init','-b','main',cwd=work)
            (work/'README.md').write_text('alpha\n<script>window.golfDiffExecuted=true</script>\n')
            (work/'src/nested').mkdir(parents=True)
            (work/'src/example.ts').write_text('const greeting = \"<script>window.golfDiffExecuted=true</script>\";\n')
            (work/'src/nested/test.ts').write_text('const value = 1;\n')
            (work/'rename.txt').write_text('rename fixture\n'*20);(work/'remove.txt').write_text('remove fixture\n')
            command('git','add','.',cwd=work);root=commit(work,'Root native diff fixture')
            command('git','checkout','-b','side',cwd=work);(work/'side.txt').write_text('side first-parent fixture\n')
            command('git','add','.',cwd=work);side=commit(work,'Side fixture');command('git','checkout','main',cwd=work)
            (work/'README.md').write_text('beta\n<script>window.golfDiffExecuted=true</script>\n')
            (work/'rename.txt').rename(work/'naïve space.txt');(work/'remove.txt').unlink()
            (work/'binary.bin').write_bytes(b'Golf\x00binary\xff\n');(work/'link').symlink_to('../../outside-diff')
            command('git','add','.',cwd=work)
            command('git','update-index','--add','--cacheinfo','160000,'+root+',vendor/sample',cwd=work)
            edited=commit(work,'Text rename delete binary symlink gitlink fixture')
            command('git','-c','user.name=Golf Check','-c','user.email=check@example.invalid',
                    'merge','--no-ff','-m','Merge first-parent fixture','side',cwd=work)
            merge=command('git','rev-parse','HEAD',cwd=work)
            command('git','-c','user.name=Golf Check','-c','user.email=check@example.invalid',
                    'commit','--allow-empty','-m','Empty diff fixture',cwd=work)
            empty=command('git','rev-parse','HEAD',cwd=work)
            command('git','checkout','-b','large-diff',cwd=work)
            (work/'large.txt').write_text('x'*(600<<10));command('git','add','.',cwd=work);large=commit(work,'Oversized diff fixture')
            command('git','checkout','main',cwd=work);command('git','checkout','-b','control-diff',cwd=work)
            (work/'control.txt').write_bytes(b'unsafe\x1b[31mtext\n')
            command('git','add','.',cwd=work);control=commit(work,'Control text fixture')
            command('git','checkout','main',cwd=work);command('git','checkout','-b','nonutf8-diff',cwd=work)
            (work/'invalid.txt').write_bytes(b'invalid utf8 \xff\n')
            command('git','add','.',cwd=work);invalid_utf8=commit(work,'Invalid UTF8 fixture');command('git','checkout','main',cwd=work)
            askpass=path/'askpass.py';askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n');askpass.chmod(0o700)
            env={**os.environ,'GIT_ASKPASS':str(askpass),'GIT_TERMINAL_PROMPT':'0','GOLF_CHECK_USER':owner_name,'GOLF_CHECK_TOKEN':owner_token}
            command('git','-c','credential.helper=','push',GITEA+'/'+full_name+'.git','main','side','large-diff','control-diff','nonutf8-diff',env=env,cwd=work)
            wait_for_push(owner_token,full_name)
            initial=diff(root);assert initial['commit']['sha']==root and initial['base']=='COMMIT_DIFF_BASE_ROOT'
            assert not initial.get('parentCommitIds') and not initial.get('baseCommitId') and 'commit '+root in initial['rawDiff']
            (work/'forward.txt').write_text('Advance main after selecting the immutable root diff\n')
            command('git','add','.',cwd=work);advanced=commit(work,'Advance main after diff snapshot')
            command('git','-c','credential.helper=','push',GITEA+'/'+full_name+'.git','main',env=env,cwd=work)
            assert provider(owner_token,'GET','repos/'+full_name+'/branches/main')['commit']['id']==advanced
            changed=diff(edited);assert changed['baseCommitId']==root and changed['parentCommitIds']==[root]
            assert changed['base']=='COMMIT_DIFF_BASE_FIRST_PARENT'
            for text in ['-alpha','+beta','rename from rename.txt','deleted file mode','Binary files','new file mode 120000','Subproject commit '+root]:
                assert text in changed['rawDiff'], 'Native diff fixture missing expected marker'
            merged=diff(merge);assert merged['baseCommitId']==edited and merged['parentCommitIds']==[edited,side]
            assert 'side.txt' in merged['rawDiff'] and 'diff --git a/README.md' not in merged['rawDiff']
            assert not diff(empty).get('rawDiff') and not diff(empty).get('byteSize')
            assert diff(root)==initial, 'Advancing refs changed an exact commit selection'
            request=urllib.request.Request(GITEA+'/api/v1/repos/'+full_name+'/git/commits/'+root+'.diff',headers={'Authorization':'token '+owner_token})
            with urllib.request.urlopen(request,timeout=15) as response:
                assert response.status==200 and response.read().decode()==initial['rawDiff']
                print('Native diff Content-Type: '+response.headers.get('Content-Type','(absent)'))
            for result in [initial,changed,merged]:
                assert result['byteSize']==len(result['rawDiff'].encode())<=512<<10
            diff(large,expected=429);diff(control,expected=400,code='failed_precondition');diff(invalid_utf8,expected=400,code='failed_precondition')
            for value in ['main','a'*7,root.upper(),root+'^','../main']:
                diff(value,expected=400)
            diff('f'*40,expected=404);diff(root,member,404);diff(root,client(),401)
            narrow_token=admin('generate-access-token','--username',owner_name,'--token-name',prefix+'-narrow','--scopes','read:user','--raw').strip()
            narrow=client();rpc(narrow,'SessionService/LoginWithGiteaToken',{'token':narrow_token});sessions.append(narrow)
            diff(root,narrow,403)
            print('PASS: root/first-parent merge, empty, text/rename/delete/binary/symlink/gitlink output, byte bounds, exact IDs and private/scope denial')
            if binary:
                before=rpc(owner,'SessionService/ListSessions')
                # CLI emits default Protobuf values; Connect JSON omits them.
                assert helpers.cli_call(binary,owner_token,['commit','diff',full_name,root])=={**initial,'parentCommitIds':[],'baseCommitId':''}
                helpers.cli_call(binary,member_token,['commit','diff',full_name,root],expected=1)
                helpers.cli_call(binary,owner_token,['commit','diff',full_name,'main'],expected=2)
                assert rpc(owner,'SessionService/ListSessions')==before
                print('PASS: diff CLI exact JSON, denial, argument validation and ephemeral cleanup')
            provider(owner_token,'PUT','repos/'+full_name+'/collaborators/'+member_name,{'permission':'read'},204)
            assert diff(root,member)['commit']['sha']==root
            screenshots=ROOT/'.tmp/commit-diff-smoke';screenshots.mkdir(parents=True,exist_ok=True)
            result=subprocess.run(['node','--input-type=module','-e',BROWSER],cwd=ROOT,text=True,capture_output=True,timeout=90,
                input=json.dumps({'golf':GOLF,'gitea':GITEA,'owner':owner_name,'member':member_name,
                                 'memberToken':member_token,'ownerToken':owner_token,'root':root,'merge':merge,'screenshots':str(screenshots)}))
            if result.returncode:
                for line in result.stderr.splitlines():
                    if line.startswith('Diff browser failed at ') or line=='Browser logout failed':print(line)
            assert result.returncode==0,result.stderr;print(result.stdout.strip())
            diff(root,member,404)
    finally:
        failures=[]
        for session in sessions[:2]:
            try:rpc(session,'SessionService/RevokeOtherSessions')
            except Exception:failures.append('other-session cleanup')
        for session in sessions:
            try:rpc(session,'SessionService/Logout')
            except Exception:failures.append('logout')
        for user in reversed(users):
            try:admin('delete','--username',user,'--purge')
            except Exception:failures.append('provider cleanup')
        assert not failures, 'Diff fixture cleanup failed'
        print('Disposable native diff users/repositories purged.')


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=traceback.extract_tb(error.__traceback__)
        locations=' > '.join(f'{Path(frame.filename).name}:{frame.lineno}' for frame in frames)
        raise SystemExit(f'Commit diff qualification failed at {locations}; sensitive diagnostics withheld')
