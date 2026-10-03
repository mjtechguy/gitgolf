#!/usr/bin/env python3
"""Qualify bounded inline-review reads in Golf/UI/CLI/MCP on owned fixtures."""
import base64
import json
import os
import secrets
import select
import subprocess
import sys
import time
from urllib.parse import quote

sys.dont_write_bytecode=True
from smoke import ROOT,GOLF,GITEA,admin,client,provider,ready,request,rpc,wait_for_push

BROWSER=r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(value){if(!value)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));let input='';for await(const p of process.stdin)input+=p;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithGiteaToken',{headers,data:{token:config.token}})).status()===200);
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));const url=config.golf+'/'+config.repository+'/pull/'+config.number;
 for(const theme of ['dark','light'])for(const width of [1280,390]){
  stage='inline comments '+theme+' '+width;await page.setViewportSize({width,height:900});await page.goto(url);await page.getByRole('button',{name:'Show inline comments (54)',exact:true}).waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  check(await page.getByRole('region',{name:'Inline comments for review '+config.reviewId,exact:true}).count()===0);await page.getByRole('button',{name:'Show inline comments (54)',exact:true}).click();
  const region=page.getByRole('region',{name:'Inline comments for review '+config.reviewId,exact:true});await region.locator('.review-inline-list>li').last().waitFor();check(await region.locator('.review-inline-list>li').count()===54);
  check(await region.getByText('Native reader reply',{exact:true}).count()===1);check(await region.getByText('Comment resolved',{exact:true}).count()===1);const marked=region.getByRole('article',{name:'Inline comment '+config.resolvedId,exact:true});await marked.getByText('Comment details',{exact:true}).click();await marked.getByText('Deleted or unavailable resolver',{exact:true}).waitFor();check(await region.getByRole('article',{name:'Inline comment '+config.replyId,exact:true}).getByText('Comment resolved',{exact:true}).count()===0);check(await region.locator('script').count()===0);check(!await page.evaluate(()=>window.golfInlineExecuted));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await region.locator('.review-inline-summary').scrollIntoViewIfNeeded();await page.screenshot({path:join(config.screenshots,'native-inline-comments-'+theme+'-'+width+'.png')});await writeFile(join(config.screenshots,'native-inline-comments-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());
  await page.getByRole('button',{name:'Hide inline comments (54)',exact:true}).click();await region.waitFor({state:'detached'});
 }
 stage='own pending draft inspection';await page.getByRole('button',{name:'Show inline comments (1)',exact:true}).click();const pending=page.getByRole('region',{name:'Inline comments for review '+config.pendingId,exact:true});await pending.getByText('Own pending inline text',{exact:true}).waitFor();await page.getByRole('button',{name:'Hide inline comments (1)',exact:true}).click();
 stage='files changed comment panel';await page.getByRole('navigation',{name:'Pull request workspace',exact:true}).getByRole('link',{name:'Files changed',exact:true}).click();await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Show review comments',exact:true}).click();await page.getByRole('button',{name:'Show inline comments (54)',exact:true}).click();await page.getByRole('region',{name:'Inline comments for review '+config.reviewId,exact:true}).getByText('Native reader reply',{exact:true}).waitFor();
 stage='live private inline read revocation';check((await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);await page.getByRole('region',{name:'Inline comments for review '+config.reviewId,exact:true}).waitFor({state:'detached',timeout:15000});check(!await page.locator('body').innerText().then(t=>t.includes('Native reader reply')||t.includes('Own pending inline text')));check(errors.length===0);
 console.log('PASS: actual inline-comment UI, 54 complete reads, safe Markdown, individual/deleted-resolver observation, own pending inspection, Files changed panel, both themes/mobile and live private revocation');
}catch{console.error('Inline review browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Inline review browser logout failed');process.exitCode=1;}await browser?.close();}
'''

def mcp_comments(binary,credential,api,selection,expected_ids):
 env={k:v for k,v in os.environ.items() if k not in {'GOLF_API_TOKEN','GOLF_GITEA_TOKEN','GOLF_URL','MCPGODEBUG'}};env['GOLF_API_TOKEN' if api else 'GOLF_GITEA_TOKEN']=credential
 process=subprocess.Popen([str(binary),'--url',GOLF,'mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
 def send(value):process.stdin.write((json.dumps(value)+'\n').encode());process.stdin.flush()
 def receive(identity):
  for _ in range(10):
   assert select.select([process.stdout],[],[],20)[0];line=process.stdout.readline();assert line and credential.encode() not in line;value=json.loads(line)
   if value.get('id')==identity:return value
  raise AssertionError('No MCP response')
 try:
  send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'golf-inline-proof','version':'1'}}});assert receive(1)['result']['serverInfo']['name']=='golf';send({'jsonrpc':'2.0','method':'notifications/initialized'})
  send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'golf_pr_review_comments','arguments':selection}});result=receive(2)['result'];assert not result.get('isError');envelope=json.loads(result['content'][0]['text']);assert envelope==result['structuredContent'] and envelope['schema_version']=='golf.mcp.v1';assert [row['id'] for row in envelope['data']['comments']]==expected_ids
  process.stdin.close();assert process.wait(timeout=10)==0
 finally:
  if process.poll() is None:process.terminate();process.wait(timeout=10)
  process.stdout.close();process.stderr.close()

def main():
 ready();assert request(client(),'GET',GITEA+'/api/v1/version')['version']=='1.27.3';stage='accounts';prefix='golf-inline-read-'+secrets.token_hex(4);users=[];actors={};deleted=set()
 try:
  for role in ['owner','author','reviewer','reader','outsider']:
   name=prefix+'-'+role;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');users.append(name);token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository','--raw').strip();session=None
   if role!='author':session=client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':token})
   actors[role]={'name':name,'token':token,'session':session,'id':provider(token,'GET','user')['id']}
  owner,author,reviewer,reader,outsider=[actors[role] for role in actors];stage='native PR setup';repo=provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);full=repo['full_name'];route='repos/'+full;key={'owner':owner['name'],'name':'private'};wait_for_push(owner['token'],full)
  for actor,permission in [(author,'write'),(reviewer,'write'),(reader,'read')]:provider(owner['token'],'PUT',route+'/collaborators/'+actor['name'],{'permission':permission},204)
  path='src/space ü.py';content=provider(owner['token'],'POST',route+'/contents/'+quote(path,safe='/'),{'branch':repo['default_branch'],'message':'Base inline fixture','content':base64.b64encode(b'first\nold second\nthird\n').decode()},201);provider(owner['token'],'POST',route+'/branches',{'new_branch_name':'inline-head'},201);changed=provider(owner['token'],'PUT',route+'/contents/'+quote(path,safe='/'),{'branch':'inline-head','sha':content['content']['sha'],'message':'Changed inline fixture','content':base64.b64encode(b'first\nnew second\nthird\n').decode()});head=changed['commit']['sha'];pull=provider(author['token'],'POST',route+'/pulls',{'head':'inline-head','base':repo['default_branch'],'title':'Inline comment qualification'},201);number=pull['number'];proute=route+'/pulls/'+str(number)
  deadline=time.monotonic()+30
  while True:
   rows=provider(owner['token'],'GET',route+'/commits?sha=refs%2Fpull%2F'+str(number)+'%2Fhead&limit=1&stat=false&files=false&verification=false')
   if rows and rows[0]['sha']==head:break
   assert time.monotonic()<deadline;time.sleep(.2)
  inline=[]
  for i in range(53):inline.append({'path':path,'body':('## Inline security note\n\n<script>window.golfInlineExecuted=true</script>' if i==0 else '' if i==1 else 'Native inline '+str(i)),'old_position':2 if i%2 else 0,'new_position':0 if i%2 else 1})
  review=provider(reviewer['token'],'POST',proute+'/reviews',{'event':'COMMENT','body':'Published inline review','commit_id':head,'comments':inline});review_id=str(review['id']);native=provider(reader['token'],'GET',proute+'/reviews/'+review_id+'/comments');assert len(native)==53;parent=next(row for row in native if row['body'].startswith('## Inline'))
  reply=provider(reader['token'],'POST',proute+'/comments/'+str(parent['id'])+'/replies',{'body':'Native reader reply'},201);provider(author['token'],'POST',route+'/pulls/comments/'+str(parent['id'])+'/resolve',expected=204);admin('delete','--username',author['name'],'--purge');deleted.add(author['name']);native=provider(reader['token'],'GET',proute+'/reviews/'+review_id+'/comments');assert len(native)==54;resolved=next(row for row in native if row['id']==parent['id']);assert resolved['resolver']['id']==-1
  selection={'repository':key,'repositoryId':str(repo['id']),'pullRequestId':str(pull['id']),'number':number,'reviewId':review_id,'reviewCommitId':head};stage='Golf exact whole collection';result=rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',selection);rows=result['comments'];expected_ids=[str(row['id']) for row in sorted(native,key=lambda r:(r['created_at'],r['id']))];assert [row['id'] for row in rows]==expected_ids and result['currentHeadCommitId']==head and result['review']['id']==review_id
  for row in rows:
   actual=next(n for n in native if str(n['id'])==row['id']);assert row.get('body','')==actual['body'] and row['path']==actual['path'] and row.get('oldLine',0)==actual['original_position'] and row.get('newLine',0)==actual['position'] and row.get('commitId','')==actual['commit_id'];assert row.get('resolved',False)==bool(actual['resolver']);assert row['reviewId']==str(actual['pull_request_review_id']) and row['htmlUrl']==actual['html_url'] and row['createdAt']==actual['created_at'] and row['updatedAt']==actual['updated_at'];assert row.get('originalCommitId','')==actual['original_commit_id'] and row.get('diffHunk','')==actual['diff_hunk'];assert row['user']['id']==str(actual['user']['id']) and row['user']['login']==actual['user']['login']
  ghost=next(row for row in rows if row['id']==str(parent['id']));assert ghost['resolved'] and 'resolver' not in ghost
  rpc(outsider['session'],'RepositoryService/GetPullRequestReviewComments',selection,404);rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',{**selection,'repositoryId':str(repo['id']+1)},400,code='failed_precondition');rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',{**selection,'pullRequestId':str(pull['id']+1)},400,code='failed_precondition');rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',{**selection,'reviewCommitId':'f'*40},503);rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',selection,403,headers={'Origin':'https://other.invalid'})
  stage='pending visibility';foreign=provider(reviewer['token'],'POST',proute+'/reviews',{'event':'PENDING','body':'Foreign pending','commit_id':head,'comments':[{'path':path,'body':'Foreign pending inline text','new_position':1}]});rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',{**selection,'reviewId':str(foreign['id'])},404);own=provider(reader['token'],'POST',proute+'/reviews',{'event':'PENDING','body':'Own pending','commit_id':head,'comments':[{'path':path,'body':'Own pending inline text','new_position':1}]});own_read=rpc(reader['session'],'RepositoryService/GetPullRequestReviewComments',{**selection,'reviewId':str(own['id'])});assert own_read['comments'][0]['body']=='Own pending inline text'
  stage='delegation CLI and MCP';issued=rpc(reader['session'],'ApiCredentialService/CreateApiCredential',{'label':'Inline review proof','lifetimeSeconds':600})
  try:
   bearer=issued['token'];delegated=rpc(client(),'RepositoryService/GetPullRequestReviewComments',selection,headers={'Authorization':'Bearer '+bearer});assert [r['id'] for r in delegated['comments']]==expected_ids
   binary=ROOT/'bin/golf';proof=subprocess.run([str(binary),'--url',GOLF,'--token-stdin','pr','review-comments',full,str(number),review_id,'--repo-id',selection['repositoryId'],'--pull-id',selection['pullRequestId'],'--review-commit',head],input=reader['token']+'\n',capture_output=True,text=True,timeout=30);assert proof.returncode==0 and reader['token'] not in proof.stdout;assert [r['id'] for r in json.loads(proof.stdout)['data']['comments']]==expected_ids
   args={'repository':full,'number':number,'review_id':review_id,'repository_id':selection['repositoryId'],'pull_request_id':selection['pullRequestId'],'review_commit_id':head};mcp_comments(binary,reader['token'],False,args,expected_ids);mcp_comments(binary,bearer,True,args,expected_ids)
  finally:rpc(reader['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':issued['credential']['id']})
  print('PASS: actual Golf54-comment complete read/order/body/location/blame/resolver-ghost preservation; wrong identities/head/private/Origin/pending denial; own pending; CLI and PAT/bearer MCP',flush=True)
  stage='served browser';screens=ROOT/'.tmp/pull-review-comments-smoke';screens.mkdir(exist_ok=True);proof=subprocess.run(['node','--input-type=module','-e',BROWSER],cwd=ROOT,input=json.dumps({'golf':GOLF,'gitea':GITEA,'repository':full,'number':number,'reviewId':review_id,'pendingId':str(own['id']),'resolvedId':str(parent['id']),'replyId':str(reply['id']),'token':reader['token'],'user':reader['name'],'ownerToken':owner['token'],'screenshots':str(screens)}),capture_output=True,text=True,timeout=120)
  for line in proof.stdout.splitlines():print(line)
  for line in proof.stderr.splitlines():
   if line.startswith('Inline review browser failed at ') or line=='Inline review browser logout failed':print(line)
  assert proof.returncode==0
 except Exception:
  print('Inline review qualification failed at '+stage+'; private diagnostics withheld',file=sys.stderr);raise
 finally:
  failures=[]
  for actor in actors.values():
   if actor['session'] is not None:
    try:rpc(actor['session'],'SessionService/RevokeOtherSessions');rpc(actor['session'],'SessionService/Logout')
    except Exception:failures.append('session cleanup')
  for name in reversed(users):
   if name not in deleted:
    try:admin('delete','--username',name,'--purge')
    except Exception:failures.append('native cleanup')
  assert not failures,'Fixture cleanup failed';print('Disposable inline-read users/repositories purged; temporary sessions revoked.',flush=True)
if __name__=='__main__':
 try:main()
 except Exception as error:print(type(error).__name__+': inline review qualification failed; private diagnostics withheld',file=sys.stderr);sys.exit(1)
