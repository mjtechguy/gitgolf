#!/usr/bin/env python3
"""Qualify human overall reviews on owned local fixtures, with actual UI/API.

Supported native APIs/CLI only; no imported workflows, inference or remote
organization writes. Credentials stay in memory/stdin; fixtures are purged.
"""
import base64
import json
import secrets
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
from smoke import ROOT, GOLF, GITEA, admin, client, provider, ready, rpc, wait_for_push

BROWSER=r'''
import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {writeFile} from 'node:fs/promises';
let browser,context,config,stage='initialization';function check(v){if(!v)throw Error('assertion');}
try{
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
 let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);input='';
 browser=await chromium.launch();context=await browser.newContext({viewport:{width:1280,height:900}});
 const headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
 check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithGiteaToken',{headers,data:{token:config.token}})).status()===200);
 const page=await context.newPage();const errors=[];page.on('pageerror',()=>errors.push(true));
 const url=config.golf+'/'+config.repository+'/pull/'+config.number;
 for(const theme of ['dark','light'])for(const width of [1280,390]){
  stage='review editor '+theme+' '+width;await page.setViewportSize({width,height:900});await page.goto(url+'/files');await page.locator('.diff-file').first().waitFor();
  const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
  await page.getByRole('button',{name:'Review changes',exact:true}).click();const editor=page.getByRole('region',{name:'Review changes',exact:true});await editor.waitFor();
  check(await page.getByRole('dialog').count()===0);await editor.getByLabel('Review summary, Markdown',{exact:true}).fill('## Actual human review\n\nVerified exact selected changes.');
  await editor.getByRole('button',{name:'Preview Markdown',exact:true}).click();await page.getByLabel('Review summary preview',{exact:true}).waitFor();
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(config.screenshots,'native-human-review-'+theme+'-'+width+'.png')});
  await writeFile(join(config.screenshots,'native-human-review-'+theme+'-'+width+'.txt'),await page.locator('body').innerText());
  page.once('dialog',dialog=>dialog.accept());await editor.getByRole('button',{name:'Cancel',exact:true}).click();await editor.waitFor({state:'detached'});
 }
 stage='actual browser review submission';await page.goto(url+'/files');await page.locator('.diff-file').first().waitFor();await page.getByRole('button',{name:'Review changes',exact:true}).click();
 const editor=page.getByRole('region',{name:'Review changes',exact:true});await editor.getByLabel('Review summary, Markdown',{exact:true}).fill('Native browser review proof');
 await editor.getByRole('button',{name:'Submit review',exact:true}).click();await editor.getByRole('status').filter({hasText:'Review submitted.'}).waitFor();
 const reviews=await context.request.get(config.gitea+'/api/v1/repos/'+config.repository+'/pulls/'+config.number+'/reviews?limit=100',{headers:{Authorization:'token '+config.token}});check(reviews.status()===200);const rows=await reviews.json();const row=rows.find(r=>r.body==='Native browser review proof');check(row&&row.commit_id===config.head&&row.user.id===config.userId&&row.comments_count===0&&row.state==='COMMENT');
 await editor.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('navigation',{name:'Pull request workspace',exact:true}).getByRole('link',{name:'Conversation',exact:true}).click();await page.getByText('Native browser review proof',{exact:true}).waitFor();
 stage='live review draft access revocation';await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByLabel('Review summary, Markdown',{exact:true}).fill('Private unsent reviewer draft');
 check((await context.request.delete(config.gitea+'/api/v1/repos/'+config.repository+'/collaborators/'+config.user,{headers:{Authorization:'token '+config.ownerToken}})).status()===204);
 stage='live review revocation signal';await page.getByRole('alert').first().waitFor({timeout:15000});stage='private review draft cleanup';await page.getByLabel('Review summary, Markdown',{exact:true}).waitFor({state:'detached',timeout:15000});check(await page.getByLabel('Review summary, Markdown',{exact:true}).count()===0);check(!await page.locator('body').innerText().then(t=>t.includes('Private unsent reviewer draft')));check(errors.length===0);
 console.log('PASS: production review editor on exact changed files, safe Markdown, both themes/mobile, actual review/readback and live private draft revocation');
}catch{console.error('Human review browser failed at '+stage+'; private diagnostics withheld');process.exitCode=1;}
finally{if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{console.error('Review browser logout failed');process.exitCode=1;}await browser?.close();}
'''

def main():
 ready();prefix='golf-human-review-'+secrets.token_hex(4);users=[];actors={};stage='accounts'
 try:
  for role in ['owner','reviewer','reader','outsider']:
   name=prefix+'-'+role;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');users.append(name)
   token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository','--raw').strip()
   session=client();rpc(session,'SessionService/LoginWithGiteaToken',{'token':token});actors[role]={'name':name,'token':token,'session':session,'id':provider(token,'GET','user')['id']}
  owner,reviewer,reader,outsider=[actors[r] for r in ['owner','reviewer','reader','outsider']]
  stage='native PR setup';repo=provider(owner['token'],'POST','user/repos',{'name':'private','private':True,'auto_init':True},201);full=repo['full_name'];route='repos/'+full;key={'owner':owner['name'],'name':'private'};wait_for_push(owner['token'],full)
  for actor,permission in [(reviewer,'write'),(reader,'read')]:provider(owner['token'],'PUT',route+'/collaborators/'+actor['name'],{'permission':permission},204)
  provider(owner['token'],'POST',route+'/branches',{'new_branch_name':'human-review'},201)
  content=provider(owner['token'],'POST',route+'/contents/review.py',{'branch':'human-review','message':'Human review fixture','content':base64.b64encode(b'answer = 42\n').decode()},201)
  pull=provider(owner['token'],'POST',route+'/pulls',{'head':'human-review','base':repo['default_branch'],'title':'Human review qualification'},201);head=content['commit']['sha'];number=pull['number'];proute=route+'/pulls/'+str(number)
  deadline=time.monotonic()+30
  while True:
   rows=provider(owner['token'],'GET',route+'/commits?sha=refs%2Fpull%2F'+str(number)+'%2Fhead&limit=1&stat=false&files=false&verification=false')
   if rows and rows[0]['sha']==head:break
   assert time.monotonic()<deadline;time.sleep(.2)
  def selection(actor,state='PULL_REQUEST_REVIEW_STATE_COMMENT',body='Exact human review'):
   value=rpc(actor['session'],'RepositoryService/GetPullRequest',{'repository':key,'number':number})['pullRequest']
   return {'repository':key,'repositoryId':str(repo['id']),'pullRequestId':value['id'],'number':number,'expectedRevision':value['revision'],'baseCommitId':value['base']['commitId'],'headCommitId':value['head']['commitId'],'state':state,'body':body,'idempotencyKey':str(uuid.uuid4())}
  def publish(actor,payload):
   result=rpc(actor['session'],'RepositoryService/CreatePullRequestReview',payload)
   if 'review' not in result:print('Observed review outcome: '+result.get('mutation',{}).get('state','missing')+' / '+result.get('mutation',{}).get('failureCode','none'),flush=True)
   return result
  def count():return len(provider(owner['token'],'GET',proute+'/reviews?limit=100'))
  stage='Golf review receipts/replay';request=selection(reviewer,body='## Exact body\n\nHuman commentary.');before=count();result=publish(reviewer,request);mutation=result['mutation'];review=result['review'];assert mutation['state']=='ISSUE_MUTATION_STATE_SUCCEEDED' and review['commitId']==head and int(review['user']['id'])==reviewer['id']
  actual=provider(reviewer['token'],'GET',proute+'/reviews/'+review['id']);assert actual['body']==request['body'] and actual['commit_id']==head and actual['comments_count']==0
  repeated=publish(reviewer,request);assert repeated['mutation']['observedReviewId']==review['id'] and count()==before+1
  rpc(reviewer['session'],'RepositoryService/CreatePullRequestReview',{**request,'body':'changed'},400,code='failed_precondition')
  own=rpc(reviewer['session'],'RepositoryService/GetPullRequestReviewMutation',{'idempotencyKey':request['idempotencyKey']});assert own['review']['id']==review['id']
  rpc(reader['session'],'RepositoryService/GetPullRequestReviewMutation',{'idempotencyKey':request['idempotencyKey']},404)
  for state,body in [('PULL_REQUEST_REVIEW_STATE_APPROVED',''),('PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES','Please revise')]:
   outcome=publish(reviewer,selection(reviewer,state,body));assert outcome['mutation']['state']=='ISSUE_MUTATION_STATE_SUCCEEDED' and outcome['review']['state']==state
  unofficial=publish(reader,selection(reader,'PULL_REQUEST_REVIEW_STATE_APPROVED',''));assert unofficial['review'].get('official',False) is False
  rejected=publish(owner,selection(owner,'PULL_REQUEST_REVIEW_STATE_APPROVED',''));assert rejected['mutation']['failureCode']=='review_unavailable'
  wrong=publish(reviewer,{**selection(reviewer),'repositoryId':str(repo['id']+1)});assert wrong['mutation']['failureCode']=='target_changed'
  stage='delegation/Origin';issued=rpc(reviewer['session'],'ApiCredentialService/CreateApiCredential',{'label':'Human review read proof','lifetimeSeconds':600})
  try:
   read=rpc(client(),'RepositoryService/GetPullRequestReviewMutation',{'idempotencyKey':request['idempotencyKey']},headers={'Authorization':'Bearer '+issued['token']});assert read['review']['id']==review['id']
   rpc(client(),'RepositoryService/CreatePullRequestReview',selection(reviewer),403,headers={'Authorization':'Bearer '+issued['token']})
  finally:rpc(reviewer['session'],'ApiCredentialService/RevokeApiCredential',{'credentialId':issued['credential']['id']})
  rpc(reviewer['session'],'RepositoryService/CreatePullRequestReview',selection(reviewer),403,headers={'Origin':'https://other.invalid'})
  stage='pending draft exclusion';provider(reviewer['token'],'POST',proute+'/reviews',{'event':'PENDING','body':'Existing draft','commit_id':head})
  before=count();pending=publish(reviewer,selection(reviewer));assert pending['mutation']['failureCode']=='pending_review' and count()==before
  # Remove only this owned native pending draft so the actual UI can submit a new overall review.
  draft=next(r for r in provider(reviewer['token'],'GET',proute+'/reviews?limit=100') if r['state']=='PENDING' and r['user']['id']==reviewer['id'])
  provider(reviewer['token'],'DELETE',proute+'/reviews/'+str(draft['id']),expected=204)
  print('PASS: actual Golf review decisions, zero-comment independent receipts, once-only replay/conflict, self/wrong-target/pending exclusion, owner-status, PAT/bearer/Origin boundaries',flush=True)
  stage='served browser';screens=ROOT/'.tmp/pull-review-mutations-smoke';screens.mkdir(exist_ok=True)
  proof=subprocess.run(['node','--input-type=module','-e',BROWSER],cwd=ROOT,input=json.dumps({'golf':GOLF,'gitea':GITEA,'repository':full,'number':number,'head':head,'token':reviewer['token'],'user':reviewer['name'],'userId':reviewer['id'],'ownerToken':owner['token'],'screenshots':str(screens)}),capture_output=True,text=True,timeout=120)
  for line in proof.stdout.splitlines():print(line)
  for line in proof.stderr.splitlines():
   if line.startswith('Human review browser failed at ') or line=='Review browser logout failed':print(line)
  assert proof.returncode==0,'Served browser review proof failed'
 except Exception:
  print("Human review qualification failed at "+stage+"; private diagnostics withheld",file=sys.stderr)
  raise
 finally:
  failures=[]
  for actor in actors.values():
   try:rpc(actor['session'],'SessionService/RevokeOtherSessions');rpc(actor['session'],'SessionService/Logout')
   except Exception:failures.append('session cleanup')
  for user in reversed(users):
   try:admin('delete','--username',user,'--purge')
   except Exception:failures.append('native cleanup')
  assert not failures,'Fixture cleanup failed'
  print('Disposable human review users/repositories purged.',flush=True)
if __name__=='__main__':
 try:main()
 except Exception as error:print(type(error).__name__+': human review qualification failed; private diagnostics withheld',file=sys.stderr);sys.exit(1)
