#!/usr/bin/env python3
"""Qualify literal file/directory history and source controls on local Compose.

Own disposable private fixtures; supported native APIs/CLI/Git only. No workflows
or models run. Credentials remain in memory, stdin or child environment.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True
from smoke import ROOT, GOLF, FORGE, admin, client, command, commit, provider, ready, rpc, wait_for_push
spec=importlib.util.spec_from_file_location('organization_smoke',ROOT/'scripts/organizations-smoke.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)

BROWSER=r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';
let browser,context,config,stage='initialization';function check(v){if(!v)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
 const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithForgeToken',{headers,data:{token:config.readerToken}})).status()===200);
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));
 const source=config.golf+'/'+config.repository+'/blob/'+config.ref+'/'+config.path.split('/').map(encodeURIComponent).join('/');
 stage='native directory latest change';await page.goto(config.golf+'/'+config.repository+'/tree/'+config.ref+'/src');
 const latest=page.getByLabel('Latest change for '+config.path,{exact:true});await latest.getByRole('link',{name:'Literal source change 62',exact:true}).waitFor({timeout:15000});
 check(new URL(await latest.getByRole('link').getAttribute('href'),config.golf).pathname.endsWith('/commit/'+config.ref));
 check(await latest.locator('time').count()===1);
 for(const theme of ['dark','light'])for(const width of [1280,390]){
  stage='source '+theme+' '+width;await page.setViewportSize({width,height:900});await page.goto(source+'#L2-L4');await page.locator('.numbered-source').waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();await page.evaluate(()=>document.fonts.ready);
  check(await page.locator('.numbered-source tr').count()===4);check(await page.locator('.source-line-selected').count()===3);
  check(await page.locator('.source-code-text script,.source-code-text img').count()===0);check(!await page.evaluate(()=>window.golfSourceExecuted));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const files=page.locator('.source-navigator');if(width===390&&(await files.getAttribute('open'))===null)await files.locator('summary').click();await page.getByRole('navigation',{name:'Repository files',exact:true}).getByRole('link',{name:config.path.split('/').pop(),exact:true}).waitFor();
  await page.getByLabel('Filter expanded folder entries',{exact:true}).fill('literal');check(await page.getByRole('navigation',{name:'Repository files',exact:true}).getByRole('link',{name:config.path,exact:true}).count()===1);await page.getByLabel('Filter expanded folder entries',{exact:true}).fill('');
  await page.screenshot({path:join(config.screenshots,'native-source-code-'+theme+'-'+width+'.png')});
  await page.getByLabel('Source actions',{exact:true}).click();const rect=await page.locator('.source-action-options').boundingBox();check(rect&&rect.x>=0&&rect.x+rect.width<=width);
  await page.getByLabel('Copy source permalink',{exact:true}).click();const copied=new URL(await page.evaluate(()=>navigator.clipboard.readText()));check(decodeURIComponent(copied.pathname)===decodeURIComponent(new URL(source).pathname)&&copied.hash==='#L2-L4');
  await page.getByLabel('Copy repository path',{exact:true}).click();check(await page.evaluate(()=>navigator.clipboard.readText())===config.path);
  await page.screenshot({path:join(config.screenshots,'native-source-actions-'+theme+'-'+width+'.png')});
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download text',exact:true}).click();const download=await pending;const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);check(Buffer.concat(chunks).toString('utf8')===config.text);
  await page.getByLabel('Source actions',{exact:true}).press('Escape');check(await page.getByLabel('Source actions',{exact:true}).evaluate(e=>e===document.activeElement));
  stage='native path history';await page.getByRole('link',{name:'History',exact:true}).click();await page.locator('.commit-list>li').first().waitFor();check(await page.locator('.commit-list>li').count()===20);
  check(decodeURIComponent(new URL(page.url()).pathname).endsWith('/commits/'+config.ref+'/'+config.path));check(await page.locator('.branch-picker').count()===0);
  await page.screenshot({path:join(config.screenshots,'native-source-history-'+theme+'-'+width+'.png')});
  await page.getByRole('button',{name:'Load more commits',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.commit-list>li').length===40);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.commit-list>li').length===20);
  await page.getByRole('link',{name:'Back to source',exact:true}).click();await page.locator('.numbered-source').waitFor();
 }
 stage='live repository revocation';check((await context.request.delete(config.forge+'/api/v1/repos/'+config.repository+'/collaborators/'+config.reader,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);
 await page.getByRole('alert').waitFor({timeout:15000});check(await page.locator('.numbered-source,.source-action-menu').count()===0);check(errors.length===0);
 stage='owner full-page issue creation';
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers,data:{}})).status()===200);
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithForgeToken',{headers,data:{token:config.ownerToken}})).status()===200);
 await page.goto(config.golf+'/'+config.repository+'/issues/new');const editor=page.getByRole('region',{name:'New issue',exact:true});await editor.waitFor();check(await page.getByRole('dialog').count()===0);
 await editor.getByLabel('Issue title',{exact:true}).fill('Native full-page issue proof');
 const body='## Actual issue\n\nExpected full-page editor.\n\n```ts\nconst safe = true;\n```';await editor.getByLabel('Description, plain text',{exact:true}).fill(body);await editor.getByRole('button',{name:'Preview Markdown',exact:true}).click();await page.getByLabel('Draft Markdown preview',{exact:true}).waitFor();
 for(const theme of ['dark','light'])for(const width of [1280,390]){await page.setViewportSize({width,height:900});const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'native-issue-create-'+theme+'-'+width+'.png')});}
 await editor.getByRole('button',{name:'Write',exact:true}).click();await editor.getByRole('button',{name:'Create issue',exact:true}).click();await page.waitForURL(new RegExp('/issues/[1-9][0-9]*'));
 await page.locator('#issue-detail-title').waitFor();check((await page.locator('#issue-detail-title').textContent()).startsWith('Native full-page issue proof')); const number=Number(new URL(page.url()).pathname.split('/').pop());
 const receipt=await context.request.get(config.forge+'/api/v1/repos/'+config.repository+'/issues/'+number,{headers:{Authorization:'token '+config.ownerToken}});check(receipt.status()===200);const actual=await receipt.json();check(actual.title==='Native full-page issue proof'&&actual.body===body);
 console.log('PASS: actual latest-change rows, source/tree/range links, copy/download exact text, path pagination/reload, both themes/mobile, revoked-access cleanup and native full-page issue creation/readback');
}catch{console.error('Path history browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Browser logout failed');process.exitCode=1;}await browser?.close();}
'''

def mcp_history(binary, credential, api, full, ref, path, expected):
 env={k:v for k,v in os.environ.items() if k not in {'GOLF_API_TOKEN','GOLF_FORGE_TOKEN','GOLF_URL','MCPGODEBUG'}}
 env['GOLF_API_TOKEN' if api else 'GOLF_FORGE_TOKEN']=credential
 process=subprocess.Popen([str(binary),'--url',GOLF,'mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
 def send(value):process.stdin.write((json.dumps(value)+'\n').encode());process.stdin.flush()
 def receive(identity):
  for _ in range(10):
   assert select.select([process.stdout],[],[],20)[0],'MCP response timed out'
   line=process.stdout.readline();assert line and credential.encode() not in line,'MCP credential/output failure'
   result=json.loads(line)
   if result.get('id')==identity:return result
  raise AssertionError('MCP response not found')
 try:
  send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'golf-path-proof','version':'1'}}});assert receive(1)['result']['serverInfo']['name']=='golf'
  send({'jsonrpc':'2.0','method':'notifications/initialized'})
  send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'golf_repo_commits','arguments':{'repository':full,'ref':ref,'path':path,'page':3,'limit':20}}})
  result=receive(2)['result'];assert not result.get('isError')
  envelope=json.loads(result['content'][0]['text']);assert envelope==result['structuredContent'] and envelope['schema_version']=='golf.mcp.v1'
  assert [row['sha'] for row in envelope['data']['commits']]==expected[40:60] and envelope['data']['path']==path
  process.stdin.close();assert process.wait(timeout=10)==0
 finally:
  if process.poll() is None:process.terminate();process.wait(timeout=10)
  process.stdout.close();process.stderr.close()

def main():
 ready();prefix='golf-path-'+secrets.token_hex(5);users=[];sessions=[]
 binary=ROOT/'bin/golf';assert binary.is_file(),'Build CLI first'
 try:
  actors={}
  for role in ['owner','reader','outsider']:
   name=prefix+'-'+role
   admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--random-password-length','32','--must-change-password=false');users.append(name)
   token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository'+(',write:issue' if role=='owner' else ''),'--raw').strip()
   session=client();rpc(session,'SessionService/LoginWithForgeToken',{'token':token});sessions.append(session);actors[role]=(name,token,session)
  owner,token,session=actors['owner'];reader,reader_token,reader_session=actors['reader'];outsider,outsider_token,outsider_session=actors['outsider']
  repo=provider(token,'POST','user/repos',{'name':'history','private':True},201);key={'owner':owner,'name':'history'};full=owner+'/history';repo_id=str(repo['id'])
  path='src/[literal]* 世界.ts';magic=':(glob)*'
  def history(ref,file_path=path,page=1,limit=20,actor=session,expected=200,code=None,identity=repo_id):
   return rpc(actor,'RepositoryService/ListCommits',{'repository':key,'repositoryId':identity,'ref':ref,'path':file_path,'page':{'page':page,'limit':limit}},expected,code=code)
  with tempfile.TemporaryDirectory(prefix='golf-path-') as directory:
   work=Path(directory)/'work';work.mkdir();command('git','init','-b','main',cwd=work);(work/'src').mkdir();(work/magic).write_text('literal leading magic\n')
   for i in range(63):
    text='export const iteration = '+str(i)+';\r\nconst html = "<script>window.golfSourceExecuted=true</script>";\r\n/* multi\r\n   line */\r\n';(work/path).write_bytes(text.encode());command('git','add','.',cwd=work);ref=commit(work,'Literal source change '+str(i))
   expected=command('git','log','--format=%H',ref,'--',':(literal)'+path,cwd=work).splitlines();assert len(expected)==63
   (work/'src/literal-decoy.ts').write_text('decoy-only change\n');command('git','add','.',cwd=work);advanced=commit(work,'Decoy should not appear in file history')
   askpass=Path(directory)/'askpass.py';askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n');askpass.chmod(0o700)
   env={**os.environ,'GIT_ASKPASS':str(askpass),'GIT_TERMINAL_PROMPT':'0','GOLF_CHECK_USER':owner,'GOLF_CHECK_TOKEN':token};command('git','-c','credential.helper=','push',FORGE+'/'+full+'.git','main',env=env,cwd=work);wait_for_push(token,full)
   for limit in [1,20,100]:
    actual=[];page=1
    while True:
     result=history(ref,page=page,limit=limit);assert result['path']==path and result['commitId']==ref and result['repositoryId']==repo_id
     rows=result.get('commits',[]);assert len(rows)<=limit;actual.extend(row['sha'] for row in rows);next_page=result.get('page',{}).get('nextPage',0)
     if not next_page:break
     assert next_page==page+1;page=next_page
    assert actual==expected,'Native file history skipped/reordered rows'
   assert [row['sha'] for row in history(advanced,limit=100)['commits']]==expected
   assert len(history(ref,magic,limit=100)['commits'])==1
   directory_expected=command('git','log','--format=%H',advanced,'--',':(literal)src',cwd=work).splitlines();assert [r['sha'] for r in history(advanced,'src',limit=100)['commits']]==directory_expected
   native=provider(token,'GET','repos/'+full+'/commits?'+urllib.parse.urlencode({'sha':ref,'path':':(literal)'+path,'limit':1,'page':1,'stat':'false','verification':'false','files':'false'}));print('Observed native fixed path page span:',len(native));assert len(native)>1
   history(ref,actor=reader_session,expected=404);history(ref,actor=outsider_session,expected=404);history(ref,identity=str(int(repo_id)+1),expected=400,code='failed_precondition');history('main',expected=400);history(ref,'../escape',expected=400);history(ref,'missing.ts',expected=404)
   provider(token,'PUT','repos/'+full+'/collaborators/'+reader,{'permission':'read'},204)
   assert history(ref,actor=reader_session)['commits'][0]['sha']==ref
   result=helpers.cli_call(binary,reader_token,['repo','commits',full,'--ref',ref,'--path',path,'--page','3','--limit','20']);assert [r['sha'] for r in result['commits']]==expected[40:60] and result['repositoryId']==repo_id
   helpers.cli_call(binary,outsider_token,['repo','commits',full,'--ref',ref,'--path',path],expected=1)
   issued=rpc(session,'ApiCredentialService/CreateApiCredential',{'label':'Path history native qualifier','lifetimeSeconds':600})
   bearer=issued['token']
   try:
    delegated=rpc(client(),'RepositoryService/ListCommits',{'repository':key,'repositoryId':repo_id,'ref':ref,'path':path,'page':{'page':3,'limit':20}},headers={'Authorization':'Bearer '+bearer})
    assert [r['sha'] for r in delegated['commits']]==expected[40:60]
    mcp_history(binary,reader_token,False,full,ref,path,expected);mcp_history(binary,bearer,True,full,ref,path,expected)
   finally:rpc(session,'ApiCredentialService/RevokeApiCredential',{'credentialId':issued['credential']['id']})
   print('PASS: native literal Unicode/glob/leading-colon paths, file/directory order, 1/20/100 page sizes, pinned ref, CLI, PAT/bearer MCP and private denials')
   screenshots=ROOT/'.tmp/path-history-smoke';screenshots.mkdir(exist_ok=True)
   proof=subprocess.run(['node','--input-type=module','-e',BROWSER],cwd=ROOT,input=json.dumps({'golf':GOLF,'forge':FORGE,'repository':full,'reader':reader,'readerToken':reader_token,'ownerToken':token,'ref':ref,'path':path,'text':text,'screenshots':str(screenshots)}),capture_output=True,text=True,timeout=120)
   for line in proof.stdout.splitlines():print(line)
   for line in proof.stderr.splitlines():
    if line.startswith('Path history browser failed at ') or line=='Browser logout failed':print(line)
   assert proof.returncode==0,'Browser qualification failed'
   history(ref,actor=reader_session,expected=404)
 finally:
  failures=[]
  for session in sessions:
   try:rpc(session,'SessionService/RevokeOtherSessions');rpc(session,'SessionService/Logout')
   except Exception:failures.append('session cleanup')
  for user in reversed(users):
   try:admin('delete','--username',user,'--purge')
   except Exception:failures.append('provider cleanup')
  assert not failures,'Fixture cleanup failed'
  print('Disposable native path history users/repositories purged.')
if __name__=='__main__':
 try:main()
 except Exception as error:print(type(error).__name__+': qualification failed; private diagnostics withheld',file=sys.stderr);sys.exit(1)
