// Actual retained agent/review results, read-only. Private managed credentials
// arrive on stdin; no dispatch, provider inference, publication or source writes.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const headers=origin=>({Origin:origin,'Connect-Protocol-Version':'1','Content-Type':'application/json'});
const readProcedure=method=>/^(Get|List|Watch|Inspect|Resolve)/.test(method)||method==='QueryRepositoryComparison';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const assert=(value,message)=>{if(!value){const error=Error(message);error.name='AgentUIProofAssertion';throw error;}};
function exactDetail(body,summary,repositoryId){
  if(body?.repositoryId!==repositoryId||body.summary?.repositoryId!==repositoryId||body.summary?.ref?.kind!==summary.ref.kind||body.summary.ref.id!==summary.ref.id||body.summary.commitId!==summary.commitId||body.summary.ownerId!==summary.ownerId||body.summary.state!==summary.state)return false;
  if(summary.ref.kind==='ACTION_RUN_KIND_REVIEW')return body.review?.id===summary.ref.id&&body.review.headCommit===summary.commitId&&body.review.state===summary.state&&body.review.pullNumber===summary.pullNumber;
  return summary.ref.kind==='ACTION_RUN_KIND_CODING_TASK'&&body.task?.id===summary.ref.id&&body.task.commitId===summary.commitId&&body.task.state===summary.state&&body.task.attemptId===summary.attemptId;
}
if(process.argv.includes('--self-check')){
  const summary={ref:{kind:'ACTION_RUN_KIND_REVIEW',id:'owned'},repositoryId:'1',ownerId:'2',commitId:'source',state:'published',pullNumber:1};
  const body={repositoryId:'1',summary,review:{id:'owned',headCommit:'source',state:'published',pullNumber:1}};
  assert(exactDetail(body,summary,'1'),'Exact review receipt refused');
  for(const changed of [{repositoryId:'2'},{summary:{...summary,commitId:'other'}},{review:{...body.review,id:'other'}},{review:{...body.review,pullNumber:2}}])assert(!exactDetail({...body,...changed},summary,'1'),'Mismatched receipt accepted');
  for(const method of ['GetActionRun','ListActionRuns','WatchRepository'])assert(readProcedure(method),'Read guard failed');
  for(const method of ['CreateAgentTask','CancelAgentTask','RequestReview','LoginWithPassword'])assert(!readProcedure(method),'Write guard failed');
  console.log('PASS: exact typed review receipts and browser write guard; no browser, authentication or provider call executed.');process.exit(0);
}

let config,browser,stage='configuration',initialRuntime;
const contexts=[],results=[];
function runtime(){
  const inspect=JSON.parse(execFileSync('docker',['inspect','golf-forgejo-golf-1'],{encoding:'utf8',maxBuffer:1024*1024}))[0];
  return {image:inspect.Image,revision:inspect.Config.Labels?.['org.opencontainers.image.revision']??null,running:inspect.State.Running};
}
async function manifest(complete=false){
  if(!config?.screenshots)return;
  await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({captureKind:'Actual retained local review and linked private coding-task results; read-only managed browser',ownerOnly:true,workingTreeHead:config.workingTreeHead,servedRuntime:initialRuntime,repository:config.repository,complete,passed:complete&&results.length===12&&results.every(row=>row.status==='captured'),results,limitations:['Existing retained terminal records only; no new agent execution or provider inference.','No durable conversation, interactive replies, approvals or session recovery qualified.','No repository/source/policy/native review mutation; managed login/logout creates session activity.','Screenshots contain private retained results and are owner-only; not public demo assets.']},null,2)+'\n',{mode:0o600});
}
async function rpc(context,service,method,data){
  const response=await context.request.post(config.golf+'/rpc/golf.v1.'+service+'/'+method,{headers:headers(config.golf),data});
  assert(response.status()===200,'Expected authorized '+method+' read failed');
  const raw=await response.text();assert(Buffer.byteLength(raw)<=1024*1024,'Read exceeds qualifier response bound');return JSON.parse(raw);
}
try{
  let raw='';for await(const chunk of process.stdin){raw+=chunk;assert(Buffer.byteLength(raw)<=65536,'Configuration exceeds bound');}config=JSON.parse(raw);raw='';
  const origin=new URL(config.golf);assert(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)&&origin.origin===config.golf&&origin.port==='8080','Expected retained loopback origin');
  assert(config.repository?.owner==='golf-admin'&&config.repository.name==='golf-review-demo'&&config.actor?.name==='golf-admin'&&config.actor.email==='admin@golfgit.local'&&config.actor.password&&config.screenshots,'Expected explicitly selected retained actor/repository');
  await mkdir(config.screenshots,{recursive:true,mode:0o700});await chmod(config.screenshots,0o700);
  initialRuntime=runtime();assert(initialRuntime.running&&initialRuntime.image===config.expectedImage&&initialRuntime.revision===config.expectedRevision,'Served runtime differs from frozen source');
  const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));browser=await chromium.launch();await manifest();
  const repository=config.repository,repo='/'+encodeURIComponent(repository.owner)+'/'+encodeURIComponent(repository.name);
  for(const width of [1440,390])for(const theme of ['dark','light']){
    stage='managed-login';const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme}),record={context,loggedIn:false};contexts.push(record);
    const login=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers:headers(config.golf),data:{username:config.actor.email,password:config.actor.password}});
    assert(login.status()===200,'Existing local credentials were refused; no reset attempted');record.loggedIn=true;
    const actor=(await login.json()).user;assert(actor?.login===config.actor.name&&actor.isInstanceAdmin===true,'Actor identity differs');
    const native=(await rpc(context,'RepositoryService','GetRepository',{repository})).repository;
    assert(native?.fullName===repository.owner+'/'+repository.name&&/^[1-9][0-9]*$/.test(native.id),'Current native repository identity differs');const repositoryId=native.id;
    const inventory=await rpc(context,'ActionRunService','ListActionRuns',{repository,repositoryId,limit:25});
    assert(inventory.repositoryId===repositoryId&&inventory.runs?.length&&inventory.runs.length<=25,'Inventory boundary differs');
    const identities=new Set();for(const row of inventory.runs){assert(row.repositoryId===repositoryId&&uuid(row.ref?.id)&&/^[0-9a-f]{40}$/.test(row.commitId),'Inventory source/typed identity differs');const key=row.ref.kind+':'+row.ref.id;assert(!identities.has(key),'Duplicate typed inventory row');identities.add(key);for(const field of ['prompt','instructions','configuration','findingsJson','summary','patch','sourceArchive'])assert(!(field in row),'Private result leaked into metadata inventory');}
    let selected;
    for(const summary of inventory.runs.filter(row=>row.ref.kind==='ACTION_RUN_KIND_REVIEW'&&row.state==='published'&&row.childTask?.kind==='ACTION_RUN_KIND_CODING_TASK')){
      const body=await rpc(context,'ActionRunService','GetActionRun',{repository,repositoryId,ref:summary.ref});assert(exactDetail(body,summary,repositoryId),'Review source/detail differs');
      if(body.review.findingsJson&&body.review.findingsJson!=='null'){selected=body;break;}
    }
    assert(selected,'No retained published structured review with an authorized private task exists');
    const review=selected.summary,taskRef=review.childTask;assert(uuid(taskRef.id)&&selected.review.taskId===taskRef.id,'Private child linkage differs');
    const child=await rpc(context,'ActionRunService','GetActionRun',{repository,repositoryId,ref:taskRef});assert(exactDetail(child,child.summary,repositoryId)&&child.task.repository?.owner===repository.owner&&child.task.repository.name===repository.name&&child.task.commitId===review.commitId&&child.summary.ref.id===taskRef.id&&/^[0-9a-f]{32}$/.test(child.task.attemptId)&&child.task.summary,'Retained task source/attempt/result differs');
    await context.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);
    for(const surface of ['inventory','review','task']){
      stage=surface;const page=await context.newPage();page.setDefaultTimeout(20000);
      const rpcReads=[],receipts=[],writes=[],errors=[],pending=new Set(),responses=[];let lastResponse=Date.now();
      await page.route('**/rpc/**',route=>{const method=route.request().url().split('/').at(-1);if(!readProcedure(method)){writes.push(method);return route.abort('blockedbyclient');}return route.continue();});
      page.on('pageerror',()=>errors.push('page-error'));
      page.on('request',request=>{if(request.url().includes('/rpc/')&&!request.url().endsWith('/WatchRepository'))pending.add(request);});
      page.on('requestfailed',request=>{if(pending.delete(request))lastResponse=Date.now();});
      page.on('response',response=>{if(!response.url().includes('/rpc/'))return;const procedure=response.url().split('/').at(-1);rpcReads.push({procedure,status:response.status()});if(procedure!=='WatchRepository'){pending.delete(response.request());lastResponse=Date.now();}if(['GetActionRun','ListActionRuns'].includes(procedure))responses.push((async()=>{try{receipts.push({procedure,status:response.status(),request:response.request().postDataJSON(),body:await response.json()});}catch{errors.push('invalid-receipt');}})());});
      const output={surface,width,theme,status:'pending',repositoryId,reviewId:review.ref.id,taskId:taskRef.id,commitId:review.commitId,rpc:rpcReads};
      try{
        await page.goto(config.golf+repo+'/actions',{waitUntil:'domcontentloaded'});
        const row=page.getByRole('table',{name:'Action runs',exact:true}).locator('tr[data-row-id="3:'+review.ref.id+'"]');await row.getByRole('link',{name:review.title,exact:true}).waitFor();
        if(surface!=='inventory'){
          await row.getByRole('link',{name:review.title,exact:true}).click();await page.waitForURL(url=>url.pathname===repo+'/actions/reviews/'+review.ref.id);await page.getByLabel('PR review result',{exact:true}).waitFor();
          output.inventoryDrilldown=true;
          if(surface==='task'){await page.getByRole('link',{name:'Related coding task',exact:true}).click();await page.waitForURL(url=>url.pathname===repo+'/actions/tasks/'+taskRef.id);await page.getByLabel('Coding task result',{exact:true}).waitFor();output.privateChildDrilldown=true;}
          pending.clear();await page.reload({waitUntil:'domcontentloaded'});await page.getByLabel(surface==='review'?'PR review result':'Coding task result',{exact:true}).waitFor();output.reloaded=true;
        }
        const deadline=Date.now()+12000;while(Date.now()<deadline&&(pending.size||Date.now()-lastResponse<450))await page.waitForTimeout(100);assert(!pending.size,'Actual page reads did not settle');await Promise.all(responses);
        if(surface==='inventory')assert(receipts.some(r=>r.procedure==='ListActionRuns'&&r.status===200&&r.request.repositoryId===repositoryId&&r.body.repositoryId===repositoryId&&r.body.runs?.some(value=>value.ref?.kind===review.ref.kind&&value.ref.id===review.ref.id&&value.commitId===review.commitId)),'Exact metadata inventory receipt missing');
        else{const expected=surface==='review'?review:child.summary;assert(receipts.some(r=>r.procedure==='GetActionRun'&&r.status===200&&r.request.repositoryId===repositoryId&&r.request.ref?.id===expected.ref.id&&exactDetail(r.body,expected,repositoryId)),'Exact typed drilldown receipt missing');}
        assert(!rpcReads.some(r=>r.procedure==='ListAgentAccounts'||r.procedure==='ListAgentModels'),'Viewing results eagerly queried provider catalog');
        output.metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,actualTheme:document.documentElement.dataset.theme,rawHTMLCount:document.querySelectorAll('.markdown-body script,.markdown-body iframe,.markdown-body form').length}));
        assert(output.metrics.documentWidth<=width&&output.metrics.actualTheme===theme&&!output.metrics.rawHTMLCount&&!errors.length&&!writes.length&&!rpcReads.some(r=>r.status>=400),'Layout/theme/read-only boundary failed');
        output.actualRoute=new URL(page.url()).pathname;const basename='agent-actions-'+surface+'-'+theme+'-'+width;
        await page.screenshot({path:join(config.screenshots,basename+'.png'),fullPage:true,timeout:20000});await chmod(join(config.screenshots,basename+'.png'),0o600);await writeFile(join(config.screenshots,basename+'.txt'),await page.locator('body').innerText(),{mode:0o600});output.screenshot=basename+'.png';output.status='captured';
      }catch(error){output.status='failed';output.reason=error.name==='AgentUIProofAssertion'?error.message:'Actual browser capture failed; sensitive diagnostics withheld';}
      output.pageErrorCount=errors.length;output.blockedWriteCount=writes.length;results.push(output);await page.close();await manifest();assert(output.status==='captured','Retained page qualification failed');
    }
    await rpc(context,'SessionService','Logout',{});record.loggedIn=false;await context.close();console.log('PASS: actual retained inventory/review/private task click and reload: '+theme+' '+width+'.');
  }
  assert(JSON.stringify(runtime())===JSON.stringify(initialRuntime),'Runtime changed during proof');await manifest(true);console.log('PASS: twelve actual retained agent Actions captures, exact source/attempt/typed receipts and read-only drilldowns.');
}catch(error){console.error('Agent Actions proof failed at '+stage+'; '+(error.name==='AgentUIProofAssertion'?error.message:'sensitive diagnostics withheld'));process.exitCode=1;}
finally{
  for(const record of contexts){try{if(record.loggedIn)await rpc(record.context,'SessionService','Logout',{});await record.context.close();}catch{console.error('Managed session cleanup failed; sensitive diagnostics withheld');process.exitCode=1;}}
  if(browser)await browser.close();
}
