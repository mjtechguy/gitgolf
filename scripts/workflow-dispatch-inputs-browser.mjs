// Read-only actual-server proof. Private session/input configuration arrives on
// stdin; no storage-state file, mutation, mock RPC or workflow dispatch.
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const assert=(value,message)=>{if(!value)throw Error(message);};
const fields=['repositoryId','ownerId','commitId','workflowPath','workflowBlobId','schemaSha256','submittedSha256','effectiveSha256','inputContract'];
const catalog='golf.workflow.act.v0.2.89.linux.v2',contract='golf.workflow.dispatch.inputs.v1';
function validate(config){
 const url=new URL(config.golf);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port,'Owned loopback server required');
 assert(/^[a-f0-9]{40}$/.test(config.sourceRevision)&&config.cookies.length===1,'Source/session configuration invalid');
 assert(config.run.engineCatalog===catalog&&config.run.inputContract===contract&&config.run.jobs.length===1,'Exact typed fixture required');
 assert(fields.every(field=>typeof config.run[field]==='string'&&config.run[field]),'Missing immutable fixture binding');
 assert(['schemaSha256','submittedSha256','effectiveSha256'].every(field=>/^[a-f0-9]{64}$/.test(config.run[field])),'Input digest invalid');
}
if(process.argv.includes('--self-check')){
 const c={golf:'http://127.0.0.1:12345',sourceRevision:'a'.repeat(40),cookies:[{}],run:Object.fromEntries(fields.map(field=>[field,field.endsWith('Sha256')?'b'.repeat(64):'bound']))};c.run.engineCatalog=catalog;c.run.inputContract=contract;c.run.jobs=[{}];validate(c);
 for(const change of [{golf:'https://example.com'},{sourceRevision:'wrong'},{run:{...c.run,inputContract:'wrong'}}]){let denied=false;try{validate({...c,...change});}catch{denied=true;}assert(denied,'Invalid proof configuration accepted');}
 console.log('PASS typed browser qualification guard; no browser/resources.');process.exit(0);
}
let text='';for await(const chunk of process.stdin){text+=chunk;assert(text.length<=65536,'Private configuration bound exceeded');}
const config=JSON.parse(text);validate(config);
const {chromium}=await import(pathToFileURL(join(config.stackRoot,'web/node_modules/playwright/index.mjs')).href);
await mkdir(config.output,{mode:0o700});
const browser=await chromium.launch(),context=await browser.newContext();await context.addCookies(config.cookies);
const page=await context.newPage(),requests=[],readReceipts=[],pending=[];
const manifest={complete:false,passed:false,sourceRevision:config.sourceRevision,kind:'Actual typed editor and exact run/job/step reads',runId:config.run.id,captures:[],limitations:['Read-only editor and recorded execution; no browser dispatch or arbitrary lost-response proof.','One controlled default/literal/local-composite fixture; no full Actions or settings readiness.']};
let stage='configuration';
page.on('request',request=>{if(request.url().startsWith(config.golf+'/rpc/'))requests.push(request.url().split('/').at(-1));});
page.on('response',response=>{
 const procedure=response.url().split('/').at(-1);if(!['GetWorkflowRun','GetWorkflowRunLogs'].includes(procedure))return;
 pending.push((async()=>{
  assert(response.status()===200,'Actual run read failed');const body=await response.json();
  if(procedure==='GetWorkflowRun'){assert(body.run.id===config.run.id&&fields.every(field=>body.run[field]===config.run[field]),'Run binding differs');}
  else{const request=response.request().postDataJSON();assert(body.runId===config.run.id&&body.attemptId===config.run.attemptId&&body.repositoryId===config.run.repositoryId&&body.sourceCommitId===config.run.commitId&&(body.jobInstanceId??'')===(request.jobInstanceId??'')&&(body.stepId??'')===(request.stepId??''),'Log identity differs');}
  readReceipts.push({procedure,status:200});
 })());
});
const path='/'+encodeURIComponent(config.repository.owner)+'/'+encodeURIComponent(config.repository.name),job=config.run.jobs[0];
async function logs(marker,other){
 const log=page.getByLabel('Workflow run log',{exact:true});await log.waitFor();
 for(let i=0;i<64;i++){
  const more=page.getByRole('button',{name:'Load more log output',exact:true});
  if(!await more.count())break;
  await more.click();await page.waitForFunction(()=>!document.querySelector('button[disabled]')?.textContent?.includes('Load more log output'));
 }
 assert((await log.innerText()).includes(marker),'Recorded marker missing');if(other)assert(!(await log.innerText()).includes(other),'Selected step leaked another scope');
}
async function capture(surface,theme,width){
 await page.evaluate(()=>document.fonts.ready);assert(await page.evaluate(()=>document.documentElement.dataset.theme)===theme,'Actual theme differs');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
 const file=`${surface}-${theme}-${width}.png`;await page.screenshot({path:join(config.output,file),fullPage:true});manifest.captures.push({surface,theme,width,file});
}
try{
 for(const width of [1440,390])for(const theme of ['dark','light']){
  await page.setViewportSize({width,height:1000});await context.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
  stage='typed-editor';await page.goto(config.golf+path+'/settings/workflows',{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Workflow configuration',exact:true}).waitFor();
  const runButton=page.getByRole('button',{name:'Run workflow',exact:true});await runButton.waitFor();await runButton.click();
  const form=page.getByRole('form',{name:'Workflow inputs',exact:true});await form.waitFor();assert(await form.locator('fieldset').count()===4,'Four declared inputs missing');
  for(const name of ['count','flag','mode','text'])await form.getByLabel('Supply '+name,{exact:true}).check();
  await form.getByLabel('count value',{exact:true}).fill('2.500');await form.getByLabel('flag value',{exact:true}).uncheck();await form.getByLabel('mode value',{exact:true}).selectOption('b');await form.getByLabel('text value',{exact:true}).fill(config.literal);
  assert(await page.evaluate(value=>!JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]).includes(value),config.literal),'Private input persisted in browser');await capture('typed-editor',theme,width);await form.getByRole('button',{name:'Cancel',exact:true}).click();
  stage='typed-run';await page.goto(config.golf+path+'/actions/runs/'+config.run.id,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:config.run.workflowPath,exact:true}).waitFor();await logs('typed-literal-values-verified');await capture('typed-run',theme,width);
  stage='typed-composite-step';const navigation=page.getByLabel('Jobs and steps',{exact:true});if(width===390)await navigation.locator('summary').click();
  await navigation.locator('a[href*="jobInstanceId='+job.instanceId+'"]').first().click();await page.waitForURL(url=>url.searchParams.get('jobInstanceId')===job.instanceId);
  await navigation.locator('a[href*="stepId=composite"]').click();await page.waitForURL(url=>url.searchParams.get('stepId')==='composite');await page.reload({waitUntil:'domcontentloaded'});await logs('typed-composite-nonrecursive-verified','typed-literal-values-verified');await capture('typed-composite-step',theme,width);
 }
 await Promise.all(pending);assert(requests.every(procedure=>/^(Get|List|Watch|Inspect|Resolve)/.test(procedure)),'Unexpected modifying RPC');assert(manifest.captures.length===12&&readReceipts.length>=8,'Read proof incomplete');manifest.readReceipts=readReceipts;manifest.complete=true;manifest.passed=true;
}catch(error){manifest.failure={stage,type:error.name};throw error;}
finally{await browser.close();await writeFile(join(config.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});}
console.log('PASS twelve actual typed editor/run/scoped-step captures; no writes or dispatch.');
