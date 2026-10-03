#!/usr/bin/env python3
"""Qualify exact-ID PR diffs and actual old-side objects on a private fork.

Supported API/Git/CLI only; owned disposable actors and repositories are purged.
No workflow, inference, merge, native storage edits or remote organization writes.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
from smoke import ROOT, GOLF, GITEA, admin, client, provider, ready, request, rpc, wait_for_push

BROWSER = r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(value){if(!value)throw Error('assertion');}
try {
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const p of process.stdin)input+=p;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithGiteaToken',{headers,data:{token:config.token}})).status()===200);
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));
 for(const theme of ['dark','light'])for(const width of [1280,390]) {
  stage='exact diff '+theme+' '+width;await page.setViewportSize({width,height:900});await page.goto(config.golf+'/'+config.repository+'/pull/'+config.number+'/files');await page.locator('.diff-file').first().waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  const diff=page.getByRole('region',{name:'Pull request diff',exact:true});check((await diff.innerText()).includes('merge-base original'));check((await diff.innerText()).includes('source proposed'));check(!(await diff.innerText()).includes('base-tip unrelated'));
  check((await diff.innerText()).includes(config.mergeBase.slice(0,7)));
  for(const object of [config.mergeBase,config.head,config.baseTip])check(await diff.locator('code').evaluateAll((nodes,object)=>nodes.some(node=>node.title===object),object));
  const anchors=await diff.locator('.diff-line-number a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));check(anchors.length>0);check(anchors.every(anchor=>anchor.startsWith('#diff-'+config.mergeBase+'-'+config.head+'-file-')));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(config.screenshots,'native-bound-diff-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'native-bound-diff-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());
 }
 stage='live private diff revocation';check((await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);
 await page.locator('.diff-file').first().waitFor({state:'detached',timeout:15000});check(!(await page.locator('body').innerText()).includes('source proposed'));check(errors.length===0);
 console.log('PASS: actual exact-bound Files changed, merge-base old side distinct from base tip, dark/light/mobile and live private diff removal');
} catch {console.error('Bound diff browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally {if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Bound diff browser logout failed');process.exitCode=1;}await browser?.close();}
'''


def mcp_diff(binary, credential, api, arguments, expected):
    env = {k:v for k,v in os.environ.items() if k not in {'GOLF_API_TOKEN','GOLF_GITEA_TOKEN','GOLF_URL','MCPGODEBUG'}}
    env['GOLF_API_TOKEN' if api else 'GOLF_GITEA_TOKEN'] = credential
    process = subprocess.Popen([str(binary),'--url',GOLF,'mcp'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    def send(value):
        process.stdin.write((json.dumps(value)+'\n').encode());process.stdin.flush()
    def receive(identity):
        for _ in range(10):
            assert select.select([process.stdout],[],[],20)[0]
            line = process.stdout.readline();assert line and credential.encode() not in line
            value = json.loads(line)
            if value.get('id') == identity:return value
        raise AssertionError('No MCP response')
    try:
        send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'golf-diff-proof','version':'1'}}})
        assert receive(1)['result']['serverInfo']['name'] == 'golf'
        send({'jsonrpc':'2.0','method':'notifications/initialized'})
        send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'golf_pr_diff','arguments':arguments}})
        result = receive(2)['result'];assert not result.get('isError')
        envelope = json.loads(result['content'][0]['text'])
        assert envelope == result['structuredContent'] and envelope['schema_version'] == 'golf.mcp.v1'
        assert envelope['data'] == expected
        process.stdin.close();assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:process.terminate();process.wait(timeout=10)
        process.stdout.close();process.stderr.close()


def main():
    ready();assert request(client(),'GET',GITEA+'/api/v1/version')['version'] == '1.27.3'
    prefix = 'golf-diff-bind-'+secrets.token_hex(4)
    users, actors = [], {}
    stage = 'accounts'
    try:
        for role in ['owner','author','reader','outsider']:
            name = prefix+'-'+role
            admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository','--raw').strip()
            read = admin('generate-access-token','--username',name,'--token-name',prefix+'-read','--scopes','read:user,read:repository','--raw').strip()
            session = client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':read})
            actors[role] = {'name':name,'token':token,'read':read,'session':session}
        owner, author, reader, outsider = [actors[r] for r in actors]
        stage = 'divergent private fork setup'
        repo = provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},201)
        full = repo['full_name'];route = 'repos/'+full;wait_for_push(owner['token'],full)
        for actor, permission in [(author,'write'),(reader,'read')]:
            provider(owner['token'],'PUT',route+'/collaborators/'+actor['name'],{'permission':permission},204)
        path = 'context.txt'
        original = provider(owner['token'],'POST',route+'/contents/'+path,{'branch':repo['default_branch'],'message':'Original comparison base','content':base64.b64encode(b'merge-base original\nstable line\n').decode()},201)
        merge_base = original['commit']['sha']
        fork = provider(author['token'],'POST',route+'/forks',{'name':'renamed-fork'},202)
        fork_full = fork['full_name'];fork_route = 'repos/'+fork_full;wait_for_push(author['token'],fork_full)
        provider(author['token'],'POST',fork_route+'/branches',{'new_branch_name':'proposal'},201)
        advanced = provider(owner['token'],'PUT',route+'/contents/'+path,{'branch':repo['default_branch'],'sha':original['content']['sha'],'message':'Divergent target tip','content':base64.b64encode(b'base-tip unrelated\nstable line\n').decode()})
        base_tip = advanced['commit']['sha']
        source = provider(author['token'],'PUT',fork_route+'/contents/'+path,{'branch':'proposal','sha':original['content']['sha'],'message':'Proposed source change','content':base64.b64encode(b'source proposed\nstable line\n').decode()})
        head = source['commit']['sha']
        pull = provider(author['token'],'POST',route+'/pulls',{'head':author['name']+'/renamed-fork:proposal','base':repo['default_branch'],'title':'Exact diff qualification'},201)
        number = pull['number'];proute = route+'/pulls/'+str(number)
        deadline = time.monotonic()+30
        while True:
            pull = provider(owner['read'],'GET',proute)
            retained = provider(owner['read'],'GET',route+'/commits?sha=refs%2Fpull%2F'+str(number)+'%2Fhead&limit=1&stat=false&files=false&verification=false')
            if pull['merge_base'] == merge_base and pull['base']['sha'] == base_tip and pull['head']['sha'] == head and retained and retained[0]['sha'] == head:break
            assert time.monotonic()<deadline;time.sleep(.2)
        selection = {'repository':{'owner':owner['name'],'name':'private'},'number':number,'repositoryId':str(repo['id']),'pullRequestId':str(pull['id']),'baseCommitId':base_tip,'headCommitId':head}
        stage = 'Git object comparison'
        with tempfile.TemporaryDirectory(prefix='golf-diff-bind-') as directory:
            work = Path(directory);askpass = work/'askpass.py'
            askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n');askpass.chmod(0o700)
            env = {**os.environ,'GIT_ASKPASS':str(askpass),'GIT_TERMINAL_PROMPT':'0','GOLF_CHECK_USER':owner['name'],'GOLF_CHECK_TOKEN':owner['read'],'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull,'GIT_CONFIG_NOSYSTEM':'1'}
            def git(*args,cwd=work):
                result = subprocess.run(['git','-c','credential.helper=',*args],cwd=cwd,env=env,capture_output=True,text=True,timeout=30)
                assert result.returncode == 0,'Git observation failed; private output withheld'
                return result.stdout
            clone = work/'clone';git('clone',GITEA+'/'+full+'.git',str(clone));git('fetch','origin','refs/pull/'+str(number)+'/head',cwd=clone)
            assert git('rev-parse','FETCH_HEAD',cwd=clone).strip() == head
            assert git('merge-base',base_tip,head,cwd=clone).strip() == merge_base != base_tip
            assert git('show',merge_base+':'+path,cwd=clone) == 'merge-base original\nstable line\n'
            assert git('show',head+':'+path,cwd=clone) == 'source proposed\nstable line\n'
            assert git('show',base_tip+':'+path,cwd=clone) == 'base-tip unrelated\nstable line\n'
            patch = git('diff','--no-ext-diff','--no-textconv',merge_base,head,'--',path,cwd=clone)
            stage = 'exact Golf diff read'
            result = rpc(reader['session'],'RepositoryService/GetPullRequestDiff',selection)
            assert result['repositoryId'] == selection['repositoryId'] and result['pullRequestId'] == selection['pullRequestId']
            assert result['baseCommitId'] == base_tip and result['headCommitId'] == head and result['mergeBaseCommitId'] == merge_base
            assert result['rawDiff'] == patch and result['byteSize'] == len(result['rawDiff'].encode())
        provider(owner['read'],'GET',fork_route,expected=404);provider(reader['read'],'GET',fork_route,expected=404)
        rpc(outsider['session'],'RepositoryService/GetPullRequestDiff',selection,404)
        rpc(reader['session'],'RepositoryService/GetPullRequestDiff',{**selection,'repositoryId':str(repo['id']+1)},400,code='failed_precondition')
        rpc(reader['session'],'RepositoryService/GetPullRequestDiff',{**selection,'pullRequestId':str(pull['id']+1)},400,code='failed_precondition')
        rpc(reader['session'],'RepositoryService/GetPullRequestDiff',{**selection,'headCommitId':'f'*40},400,code='failed_precondition')
        rpc(reader['session'],'RepositoryService/GetPullRequestDiff',selection,403,headers={'Origin':'https://other.invalid'})
        stage = 'CLI and delegated MCP'
        binary = ROOT/'bin/golf'
        proof = subprocess.run([str(binary),'--url',GOLF,'--token-stdin','pr','diff',full,str(number),'--repo-id',selection['repositoryId'],'--pull-id',selection['pullRequestId'],'--base',base_tip,'--head',head],input=reader['read']+'\n',capture_output=True,text=True,timeout=30)
        assert proof.returncode == 0 and reader['read'] not in proof.stdout and json.loads(proof.stdout)['data'] == result
        args = {'repository':full,'number':number,'repository_id':selection['repositoryId'],'pull_request_id':selection['pullRequestId'],'base_commit_id':base_tip,'head_commit_id':head}
        issued = rpc(reader['session'],'ApiCredentialService/CreateApiCredential',{'label':'Exact diff proof','lifetimeSeconds':600})
        try:
            assert rpc(client(),'RepositoryService/GetPullRequestDiff',selection,headers={'Authorization':'Bearer '+issued['token']}) == result
            mcp_diff(binary,reader['read'],False,args,result);mcp_diff(binary,issued['token'],True,args,result)
        finally:rpc(reader['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':issued['credential']['id']})
        print('PASS: actual Git merge-base/blob/diff identity; exact Golf receipt, private-fork base-only authority, wrong IDs/head/Origin denied, CLI and PAT/bearer MCP',flush=True)
        stage = 'served browser'
        screenshots = ROOT/'.tmp/pull-diff-binding-smoke';screenshots.mkdir(exist_ok=True)
        proof = subprocess.run(['node','--input-type=module','-e',BROWSER],cwd=ROOT,input=json.dumps({'golf':GOLF,'gitea':GITEA,'repository':full,'number':number,'mergeBase':merge_base,'head':head,'baseTip':base_tip,'token':reader['read'],'user':reader['name'],'ownerToken':owner['token'],'screenshots':str(screenshots)}),capture_output=True,text=True,timeout=120)
        print(proof.stdout.strip(),flush=True)
        if proof.returncode:
            for line in proof.stderr.splitlines():
                if line.startswith('Bound diff browser failed at ') or line=='Bound diff browser logout failed':print(line,file=sys.stderr)
        assert proof.returncode == 0
        stage = 'stale target observation'
        newer = provider(owner['token'],'PUT',route+'/contents/'+path,{'branch':repo['default_branch'],'sha':advanced['content']['sha'],'message':'Advance target again','content':base64.b64encode(b'newer target\nstable line\n').decode()})
        deadline = time.monotonic()+30
        while provider(owner['read'],'GET',proute)['base']['sha'] != newer['commit']['sha']:
            assert time.monotonic()<deadline;time.sleep(.2)
        rpc(owner['session'],'RepositoryService/GetPullRequestDiff',selection,400,code='failed_precondition')
        print('PASS: original base-tip selection refused after actual target movement',flush=True)
    except Exception:
        print('Bound diff qualification failed at '+stage+'; private diagnostics withheld',file=sys.stderr);raise
    finally:
        failures = []
        for actor in actors.values():
            try:rpc(actor['session'],'SessionService/RevokeOtherSessions');rpc(actor['session'],'SessionService/Logout')
            except Exception:failures.append('session cleanup')
        for name in reversed(users):
            try:admin('delete','--username',name,'--purge')
            except Exception:failures.append('native cleanup')
        assert not failures,'Fixture cleanup failed'
        print('Disposable private fork/base/users purged; temporary sessions revoked.',flush=True)

if __name__ == '__main__':
    try:main()
    except Exception as error:print(type(error).__name__+': bound diff qualification failed; private diagnostics withheld',file=sys.stderr);sys.exit(1)
