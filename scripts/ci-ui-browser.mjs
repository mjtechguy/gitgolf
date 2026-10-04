// Optional actual CI proof. Private managed credentials arrive only on stdin.
// This never dispatches/cancels a workflow or mocks a provider/browser response.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {chmod,writeFile} from 'node:fs/promises';

const headers=origin=>({Origin:origin,'Connect-Protocol-Version':'1','Content-Type':'application/json'});
const readProcedure=method=>/^(Get|List|Watch|Inspect|Resolve)/.test(method)||method==='QueryRepositoryComparison';
const surfaces=['actions-inventory','actions-run','actions-selected-step'];
const widths=[1440,390],themes=['dark','light'];
const catalog='golf.workflow.act.v0.2.89.linux.v1',engineCommit='4f411281417e88660bea1c1a1749aa71ae0bd60f';
function graphSelection(run,selection){
  if(run?.engineCatalog!==catalog||run.engineCommit!==engineCommit||!/^[a-f0-9]{32}$/.test(run.attemptId)||!selection||!/^[a-f0-9]{32}$/.test(selection.jobInstanceId)||!/^[A-Za-z0-9_-]{1,64}$/.test(selection.stepId)||!selection.logMarker||!selection.otherLogMarker||selection.logMarker===selection.otherLogMarker||run.jobs?.length!==5)return undefined;
  const jobs=run.jobs.filter(job=>job.instanceId===selection.jobInstanceId);if(jobs.length!==1||jobs[0].state!=='WORKFLOW_STEP_STATE_SUCCEEDED'||!jobs[0].eventsRecorded)return undefined;
  const steps=jobs[0].steps.filter(step=>step.id===selection.stepId);return steps.length===1&&steps[0].state==='WORKFLOW_STEP_STATE_SUCCEEDED'&&steps[0].startedAt&&steps[0].finishedAt?{job:jobs[0],step:steps[0]}:undefined;
}
const assert=(condition,message)=>{if(!condition){const error=Error(message);error.name='CIProofAssertion';throw error;}};
function exactActionSummary(summary,run,repositoryId){
  return summary?.ref?.kind==='ACTION_RUN_KIND_WORKFLOW'&&summary.ref.id===run.id&&summary.repositoryId===repositoryId&&summary.ownerId===run.ownerId&&summary.commitId===run.commitId&&summary.workflowPath===run.workflowPath&&summary.workflowBlobId===run.workflowBlobId&&summary.sourceSha256===run.sourceSha256&&summary.state==='succeeded';
}
function logSequence(value){assert(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)<=9223372036854775807n,'Invalid log sequence receipt');return BigInt(value);}
function logScope(request,run,engine,selection){
  return request?.runId===run.id&&(engine?request.stepIndex===undefined&&(request.jobInstanceId??'')===(selection?.jobInstanceId??'')&&(request.stepId??'')===(selection?.stepId??''):request.jobInstanceId===undefined&&request.stepId===undefined&&request.stepIndex===selection?.stepIndex);
}
function validateLogPage(receipt,run,repositoryId,engine,selection,after){
  assert(receipt.status===200&&logScope(receipt.request,run,engine,selection)&&logSequence(receipt.request.afterSequence??'0')===after,'Log continuation request differs');
  const body=receipt.body;
  if(engine)assert(body.runId===run.id&&body.attemptId===run.attemptId&&body.repositoryId===repositoryId&&body.sourceCommitId===run.commitId&&(body.jobInstanceId??'')===(selection?.jobInstanceId??'')&&(body.stepId??'')===(selection?.stepId??''),'Log continuation source/scope receipt differs');
  assert((body.hasMore===undefined||typeof body.hasMore==='boolean')&&(body.truncated===undefined||typeof body.truncated==='boolean'),'Invalid log continuation flags');
  const rows=body.logs??[];assert(Array.isArray(rows)&&rows.length<=16&&!body.truncated&&(!body.hasMore||rows.length>0),'Log page cannot be safely continued');
  let next=after;const scoped=engine?Boolean(selection?.jobInstanceId):selection?.stepIndex!==undefined;
  for(const row of rows){const sequence=logSequence(row.sequence);assert(sequence>next&&(scoped||sequence===next+1n)&&typeof row.text==='string','Log page duplicated/skipped unsliced output');next=sequence;}
  return {next,hasMore:body.hasMore===true,count:rows.length};
}
function supersededAbort(requestGeneration,currentGeneration,errorText){return Number.isSafeInteger(requestGeneration)&&requestGeneration>=1&&requestGeneration<currentGeneration&&errorText==='net::ERR_ABORTED';}
function pageErrorCategory(error){
  if(/^Minified React error #[0-9]{1,4};/.test(error?.message??''))return 'browser_react_error';
  if((error?.message??'').startsWith('Maximum update depth exceeded'))return 'browser_react_update_depth';
  switch(error?.name){case 'TypeError':return 'browser_type_error';case 'ReferenceError':return 'browser_reference_error';case 'SyntaxError':return 'browser_syntax_error';case 'RangeError':return 'browser_range_error';default:return 'browser_page_error';}
}
if(process.argv.includes('--self-check')){
  assert(surfaces.length*widths.length*themes.length===12,'Capture inventory changed');
  for(const method of ['GetWorkflowRun','GetWorkflowRunLogs','ListActionRuns','GetActionRun','WatchRepository'])assert(readProcedure(method),'Read guard failed');
  for(const method of ['DispatchWorkflow','CancelWorkflowRun','SavePullRequestReviewDraft','UpdateExecutionPolicy','LoginWithPassword'])assert(!readProcedure(method),'Effect guard failed');
  const run={id:'owned-id',ownerId:'7',commitId:'owned-commit',workflowPath:'.github/workflows/owned.yml',workflowBlobId:'owned-blob',sourceSha256:'owned-source'};
  const summary={ref:{kind:'ACTION_RUN_KIND_WORKFLOW',id:run.id},repositoryId:'9',...run,state:'succeeded'};
  assert(exactActionSummary(summary,run,'9'),'Typed workflow receipt guard failed');
  for(const changed of [{ref:{kind:'ACTION_RUN_KIND_CODING_TASK',id:run.id}},{repositoryId:'8'},{ownerId:'8'},{commitId:'different'},{workflowBlobId:'different'},{sourceSha256:'different'},{state:'running'}])assert(!exactActionSummary({...summary,...changed},run,'9'),'Mismatched receipt accepted');
  const graph={engineCatalog:catalog,engineCommit,attemptId:'a'.repeat(32),jobs:[{instanceId:'b'.repeat(32),state:'WORKFLOW_STEP_STATE_SUCCEEDED',eventsRecorded:true,steps:[{id:'local',state:'WORKFLOW_STEP_STATE_SUCCEEDED',startedAt:'2026-10-04T01:00:00Z',finishedAt:'2026-10-04T01:01:00Z'}]},...Array.from({length:4},(_,i)=>({instanceId:String(i+1).repeat(32)}))]};
  const selection={jobInstanceId:'b'.repeat(32),stepId:'local',logMarker:'local marker',otherLogMarker:'other marker'};assert(graphSelection(graph,selection),'Exact recorded graph selection refused');
  for(const changes of [{jobInstanceId:'c'.repeat(32)},{stepId:'missing'},{stepId:'bad/path'},{logMarker:selection.otherLogMarker}])assert(!graphSelection(graph,{...selection,...changes}),'Invalid graph selection accepted');
  for(const changes of [{engineCatalog:'unqualified'},{engineCommit:'different'},{attemptId:'wrong'},{jobs:[...graph.jobs,graph.jobs[0]]}])assert(!graphSelection({...graph,...changes},selection),'Invalid graph run accepted');
  const logRun={...run,attemptId:'a'.repeat(32)},logPage={status:200,request:{runId:run.id},body:{runId:run.id,attemptId:logRun.attemptId,repositoryId:'9',sourceCommitId:run.commitId,logs:Array.from({length:16},(_,i)=>({sequence:String(i+1),text:'bounded output'})),hasMore:true}};
  assert(validateLogPage(logPage,logRun,'9',true,undefined,0n).next===16n,'First full log page refused');
  const continued={...logPage,request:{runId:run.id,afterSequence:'16'},body:{...logPage.body,logs:[{sequence:'17',text:'later marker'}],hasMore:false}};
  assert(validateLogPage(continued,logRun,'9',true,undefined,16n).next===17n,'Later marker page refused');
  for(const bad of [{...continued,body:{...continued.body,repositoryId:'8'}},{...continued,request:{...continued.request,afterSequence:'0'}},{...continued,body:{...continued.body,logs:[{sequence:'18',text:'skipped chunk'}]}},{...continued,body:{...continued.body,logs:[],hasMore:true}}]){let denied=false;try{validateLogPage(bad,logRun,'9',true,undefined,16n);}catch{denied=true;}assert(denied,'Invalid continuation accepted');}
  const selected={jobInstanceId:'b'.repeat(32),stepId:'local'},scoped={status:200,request:{runId:run.id,...selected},body:{...continued.body,...selected,logs:[{sequence:'33',text:'selected later chunk'}]}};
  assert(validateLogPage(scoped,logRun,'9',true,selected,0n).next===33n,'Legitimate scoped sequence gap refused');
  let wrongScope=false;try{validateLogPage({...scoped,body:{...scoped.body,stepId:'other'}},logRun,'9',true,selected,0n);}catch{wrongScope=true;}assert(wrongScope,'Different step receipt accepted');
  assert(supersededAbort(1,2,'net::ERR_ABORTED'),'Known old navigation abort not recognized');
  for(const args of [[2,2,'net::ERR_ABORTED'],[3,2,'net::ERR_ABORTED'],[undefined,2,'net::ERR_ABORTED'],[1,2,'net::ERR_CONNECTION_RESET'],[1,2,'private provider response']])assert(!supersededAbort(...args),'Active or unknown read failure discounted');
  assert(pageErrorCategory({name:'TypeError',message:'private source'})==='browser_type_error'&&pageErrorCategory({name:'private credential',message:'private source'})==='browser_page_error'&&pageErrorCategory({name:'__proto__',message:'private source'})==='browser_page_error','Page error classifier exposed arbitrary details');
  console.log('PASS: twelve capture cases and read-only browser guard; no browser or native fixture executed.');
  process.exit(0);
}

let config,browser,engine=false,selectedGraph,stage='configuration';
const active=[],results=[];
async function manifest(complete=false){
  if(!config?.screenshots)return;
  await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({
    captureKind:engine?'Actual successful controlled pinned Actions graph in a disposable isolated Compose installation':'Actual successful controlled shell Actions run in a disposable isolated Compose installation',
    workingTreeHead:config.workingTreeHead,servedSourceCommit:config.servedSourceCommit??null,
    servedSourceProvenance:config.servedSourceProvenance,runtime:config.runtime,
    repositoryId:config.repositoryId,runId:config.run.id,commitId:config.run.commitId,graphSelection:engine?{jobInstanceId:config.graphSelection.jobInstanceId,stepId:config.graphSelection.stepId}:undefined,
    ownerOnly:true,complete,passed:complete&&results.length===12&&results.every(r=>r.status==='captured'),results,
    limitations:[
      'GitHub public run logs may require sign-in; these captures are Golf-only, not authenticated GitHub comparisons.',
      engine?'Controlled successful graph, exact job/step output and UI only; this does not qualify automatic push, cancellation, owner-loss recovery, the full catalog or protected merges.':'Controlled shell workflow only; this does not qualify hosted actions, complete Actions/GitLab compatibility, artifacts, cache or protected merges.',
      'Fresh disposable instance policies only; retained instance settings are unchanged.',
      'Working-tree HEAD is separate from served-source provenance; an absent OCI revision label remains unknown.',
    ],
  },null,2)+'\n',{mode:0o600});
}
function exactRun(run){
  return run?.id===config.run.id&&run.repositoryId===config.repositoryId&&run.ownerId===config.run.ownerId&&run.commitId===config.run.commitId&&run.workflowPath===config.run.workflowPath&&run.workflowBlobId===config.run.workflowBlobId&&run.sourceSha256===config.run.sourceSha256&&run.state==='WORKFLOW_RUN_STATE_SUCCEEDED'&&(!engine||run.engineCatalog===catalog&&run.engineCommit===engineCommit&&run.attemptId===config.run.attemptId&&JSON.stringify(run.jobs)===JSON.stringify(config.run.jobs));
}
async function logout(context){
  const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:headers(config.golf),data:{}});
  assert(response.status()===200,'Managed logout failed');
}
try{
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  assert(raw.length<=256*1024,'Configuration exceeds bound');config=JSON.parse(raw);raw='';
  const origin=new URL(config.golf);
  assert(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)&&origin.port&&origin.origin===config.golf,'Expected loopback proof origin');
  assert(config.screenshots&&/^[1-9][0-9]*$/.test(config.repositoryId)&&/^[0-9a-f]{40}$/.test(config.run?.commitId)&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.run?.id),'Invalid proof identities');
  engine=config.run.engineCatalog===catalog;selectedGraph=engine?graphSelection(config.run,config.graphSelection):undefined;
  if(engine)assert(exactRun(config.run)&&selectedGraph&&!config.run.progress&&!Object.hasOwn(config.run,'exitCode'),'Expected independently proven complete graph and actual selected step');
  else{assert(exactRun(config.run)&&config.run.progress?.eventsRecorded&&config.run.progress.steps?.length===2,'Expected independently proven successful two-step run');assert(config.run.progress.steps[0].name==='Read source'&&config.run.progress.steps[1].name==='Verify workspace','Controlled fixture differs');}
  const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));
  browser=await chromium.launch();await manifest();
  const repo='/'+encodeURIComponent(config.repository.owner)+'/'+encodeURIComponent(config.repository.name);
  for(const width of widths)for(const theme of themes){
    stage='managed-login';
    const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});
    const record={context,loggedIn:false};active.push(record);
    const login=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers:headers(config.golf),data:{username:config.actor.email,password:config.actor.password}});
    assert(login.status()===200,'Managed sign-in refused');record.loggedIn=true;
    const identity=(await login.json()).user;
    assert(identity?.login===config.actor.name&&identity.isInstanceAdmin===true,'Managed actor differs');
    await context.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);
    for(const id of surfaces){
      stage=id;
      const page=await context.newPage();page.setDefaultTimeout(15000);
      const rpc=[],writes=[],errors=[],receipts=[],responseTasks=[],supersededReads=[];let generation=0,pageErrorCount=0,readErrorCount=0,errorCategoriesTruncated=false;const requestGenerations=new Map();
      const inflight=new Set();let lastResponse=Date.now();
      await page.route('**/rpc/**',route=>{
        const method=route.request().url().split('/').at(-1);
        if(!readProcedure(method)){writes.push(method);return route.abort('blockedbyclient');}
        return route.continue();
      });
      function recordError(entry){if(entry.category.startsWith('browser_'))pageErrorCount++;else readErrorCount++;if(errors.length<32)errors.push(entry);else errorCategoriesTruncated=true;}
      function recordReadFailure(category,request){
        const requestGeneration=requestGenerations.get(request),aborted=supersededAbort(requestGeneration,generation,request.failure()?.errorText);
        const entry={category,generation:requestGeneration??0,currentGeneration:generation};
        if(aborted){if(supersededReads.length<32)supersededReads.push(entry);else recordError({category:'diagnostic_bound',generation});}
        else recordError(entry);
      }
      page.on('pageerror',error=>recordError({category:pageErrorCategory(error),generation}));
      page.on('request',request=>{if(request.url().includes('/rpc/'))requestGenerations.set(request,generation);if(request.url().includes('/rpc/')&&!request.url().endsWith('/WatchRepository'))inflight.add(request);});
      page.on('requestfailed',request=>{if(requestGenerations.has(request)&&!request.url().endsWith('/WatchRepository')){inflight.delete(request);lastResponse=Date.now();recordReadFailure('unary_read_failed',request);}});
      page.on('response',response=>{
        if(!response.url().includes('/rpc/'))return;
        const procedure=response.url().split('/').at(-1);rpc.push({procedure,status:response.status()});
        if(procedure!=='WatchRepository'){inflight.delete(response.request());lastResponse=Date.now();}
        if(['ListActionRuns','GetActionRun','GetWorkflowRun','GetWorkflowRunLogs'].includes(procedure))responseTasks.push((async()=>{
          try{receipts.push({procedure,generation:requestGenerations.get(response.request()),status:response.status(),request:response.request().postDataJSON(),body:await response.json()});}catch{recordReadFailure('invalid_read_receipt',response.request());}
        })());
      });
      const route=id==='actions-inventory'?repo+'/actions':repo+'/actions/runs/'+config.run.id;
      const result={id,width,height:1000,theme,role:'owner',status:'pending',requestedRoute:route,rpc,check:'page-readiness'};
      async function loadActualLogPages(selection){
        let after=0n;
        const log=page.getByLabel('Workflow run log',{exact:true});await log.waitFor();
        for(let pages=0;pages<64;pages++){
          await Promise.all(responseTasks);
          const candidates=receipts.filter(r=>r.generation===generation&&r.procedure==='GetWorkflowRunLogs'&&logScope(r.request,config.run,engine,selection)&&logSequence(r.request.afterSequence??'0')===after);
          assert(candidates.length===1,'Current-document log page receipt missing or duplicated');
          const checked=validateLogPage(candidates[0],config.run,config.repositoryId,engine,selection,after);
          (result.logPages??=[]).push({generation,afterSequence:String(after),nextSequence:String(checked.next),chunkCount:checked.count,hasMore:checked.hasMore});
          if(!checked.hasMore)return log;
          result.check='actual-log-pagination';
          const next=page.getByRole('button',{name:'Load more log output',exact:true});await next.waitFor();
          const response=page.waitForResponse(response=>{if(!response.url().endsWith('/GetWorkflowRunLogs'))return false;const request=response.request().postDataJSON();return requestGenerations.get(response.request())===generation&&logScope(request,config.run,engine,selection)&&request.afterSequence===String(checked.next);});
          await next.click();await response;after=checked.next;
        }
        assert(false,'Bounded actual log pagination exhausted');
      }
      try{
        generation++;await page.goto(config.golf+route,{waitUntil:'domcontentloaded'});
        if(id==='actions-inventory'){
          const row=page.getByRole('table',{name:'Action runs',exact:true}).locator('tr[data-row-id="1:'+config.run.id+'"]');
          await row.getByRole('link',{name:config.run.workflowPath,exact:true}).waitFor();
          assert(await row.getByText('succeeded',{exact:true}).count()===1,'Run result not shown');
        }else{
          await page.getByRole('heading',{name:config.run.workflowPath,exact:true}).waitFor();
          if(id==='actions-selected-step'){
            result.check='selected-step-navigation';
            result.check='selected-step-open-jobs';
            if(width===390)await page.getByLabel('Jobs and steps').locator('summary').click();
            result.check='selected-step-visible-link';
            if(engine){
              const jobLink=page.getByLabel('Jobs and steps').locator('a[href*="jobInstanceId='+config.graphSelection.jobInstanceId+'"]').first();
              const jobURL=new URL(await jobLink.getAttribute('href'),config.golf);assert(jobURL.searchParams.get('jobInstanceId')===config.graphSelection.jobInstanceId&&!jobURL.searchParams.has('stepId'),'Job link scope differs');
              generation++;inflight.clear();await jobLink.click();await page.waitForURL(url=>url.searchParams.get('jobInstanceId')===config.graphSelection.jobInstanceId);
              generation++;inflight.clear();await page.getByLabel('Jobs and steps').locator('a[href*="jobInstanceId='+config.graphSelection.jobInstanceId+'"][href*="stepId='+config.graphSelection.stepId+'"]').click();
              await page.waitForURL(url=>url.searchParams.get('jobInstanceId')===config.graphSelection.jobInstanceId&&url.searchParams.get('stepId')===config.graphSelection.stepId);
              assert(!new URL(page.url()).searchParams.has('step'),'Graph step conflated with legacy index');
            }else{generation++;inflight.clear();await page.getByLabel('Jobs and steps').getByRole('link',{name:/Read source/}).click();await page.waitForURL(url=>url.searchParams.get('step')==='0');assert(new URL(page.url()).searchParams.get('step')==='0','Selected step URL differs');}
            // The old document's reads may be cancelled without a terminal
            // response event on navigation. Track only the reloaded document;
            // request identities fence any late responses from the old one.
            inflight.clear();
            generation++;await page.reload({waitUntil:'domcontentloaded'});
            result.check='selected-step-reload-binding';
            const selectedLink=engine?page.getByLabel('Jobs and steps').locator('a[href*="jobInstanceId='+config.graphSelection.jobInstanceId+'"][href*="stepId='+config.graphSelection.stepId+'"]'):page.getByLabel('Jobs and steps').getByRole('link',{name:/Read source/,includeHidden:width===390});
            await selectedLink.waitFor({state:width===390?'attached':'visible'});
            assert(await selectedLink.getAttribute('aria-current')==='page','Reload lost selected step');
          }
          result.check='actual-log-readiness';
          const log=await loadActualLogPages(id==='actions-selected-step'?(engine?config.graphSelection:{stepIndex:0}):undefined);
          result.check='controlled-output';
          const marker=engine?config.graphSelection.logMarker:'actions proof',other=engine?config.graphSelection.otherLogMarker:'second step proof';
          await page.waitForFunction(marker=>document.querySelector('[aria-label="Workflow run log"]')?.textContent?.includes(marker),marker);
          const text=await log.innerText();assert(text.includes(marker),'Controlled source output absent');assert(text.includes(other)===(id==='actions-run'),'Selected log range differs');
        }
        result.check='read-receipts';
        const deadline=Date.now()+12000;
        while(Date.now()<deadline&&(inflight.size>0||Date.now()-lastResponse<450))await page.waitForTimeout(100);
        result.pendingReads=[...inflight].map(request=>request.url().split('/').at(-1));
        assert(inflight.size===0,'Reads did not settle');await Promise.all(responseTasks);
        if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true}).click();
        result.actualTheme=await page.locator('html').getAttribute('data-theme');
        const current=receipts.filter(r=>r.generation===generation&&r.status===200);
        result.logSelections=current.filter(r=>r.procedure==='GetWorkflowRunLogs').map(r=>engine?{jobInstanceId:r.request.jobInstanceId??'',stepId:r.request.stepId??''}:r.request.stepIndex??'all');
        if(id==='actions-inventory')assert(current.some(r=>r.procedure==='ListActionRuns'&&r.request.repositoryId===config.repositoryId&&r.request.repository?.owner===config.repository.owner&&r.request.repository?.name===config.repository.name&&r.body.repositoryId===config.repositoryId&&r.body.runs?.some(summary=>exactActionSummary(summary,config.run,config.repositoryId))),'Exact typed inventory receipt missing');
        else{
          assert(current.some(r=>r.procedure==='GetWorkflowRun'&&r.request.runId===config.run.id&&exactRun(r.body.run)),'Exact run receipt missing');
          assert(current.some(r=>r.procedure==='GetWorkflowRunLogs'&&r.request.runId===config.run.id&&(engine?r.request.stepIndex===undefined&&r.body.runId===config.run.id&&r.body.attemptId===config.run.attemptId&&r.body.repositoryId===config.repositoryId&&r.body.sourceCommitId===config.run.commitId&&(r.body.jobInstanceId??'')===(id==='actions-selected-step'?config.graphSelection.jobInstanceId:'')&&(r.body.stepId??'')===(id==='actions-selected-step'?config.graphSelection.stepId:'')&&(r.request.jobInstanceId??'')===(r.body.jobInstanceId??'')&&(r.request.stepId??'')===(r.body.stepId??''):id==='actions-selected-step'?r.request.stepIndex===0:r.request.stepIndex===undefined)),'Exact scoped log request/receipt missing');
        }
        result.check='layout';
        result.metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,firstLogY:document.querySelector('.execution-log')?.getBoundingClientRect().y??null,jobNavigationWidth:document.querySelector('.automation-job-navigation')?.getBoundingClientRect().width??null,jobsOpen:document.querySelector('.workflow-jobs-disclosure')?.open??null}));
        if(width===390&&id!=='actions-inventory'){assert(result.metrics.jobsOpen===false,'Mobile jobs disclosure did not start collapsed');assert(result.metrics.firstLogY!==null&&result.metrics.firstLogY<750,'Mobile log begins too far below the run header');}
        assert(!errors.length&&!writes.length&&!rpc.some(r=>r.status>=400)&&result.actualTheme===theme&&result.metrics.documentWidth<=width,'Runtime/read-only/theme/layout boundary failed');
        result.actualRoute=new URL(page.url()).pathname+new URL(page.url()).search;
        const basename=id+'-'+theme+'-'+width;
        await page.screenshot({path:join(config.screenshots,basename+'.png'),fullPage:true,timeout:20000});await chmod(join(config.screenshots,basename+'.png'),0o600);
        await writeFile(join(config.screenshots,basename+'.txt'),await page.locator('body').innerText(),{mode:0o600});
        result.screenshot=basename+'.png';result.textSnapshot=basename+'.txt';
        if(id==='actions-inventory'){
          result.check='actual-inventory-drilldown';
          generation++;inflight.clear();await page.getByRole('table',{name:'Action runs',exact:true}).locator('tr[data-row-id="1:'+config.run.id+'"]')
            .getByRole('link',{name:config.run.workflowPath,exact:true}).click();
          await page.waitForURL(url=>url.pathname===repo+'/actions/runs/'+config.run.id);
          await page.getByRole('heading',{name:config.run.workflowPath,exact:true}).waitFor();
          inflight.clear();generation++;await page.reload({waitUntil:'domcontentloaded'});
          result.check='drilldown-log-pagination';await loadActualLogPages(undefined);
          await page.waitForFunction(marker=>document.querySelector('[aria-label="Workflow run log"]')?.textContent?.includes(marker),engine?config.graphSelection.logMarker:'actions proof');
          const deadline=Date.now()+12000;
          while(Date.now()<deadline&&(inflight.size>0||Date.now()-lastResponse<450))await page.waitForTimeout(100);
          assert(inflight.size===0,'Drilldown reads did not settle');await Promise.all(responseTasks);
          assert(receipts.some(r=>r.generation===generation&&r.status===200&&r.procedure==='GetWorkflowRun'&&r.request.runId===config.run.id&&exactRun(r.body.run)),'Drilldown selected a different run');
          assert(!errors.length&&!writes.length&&!rpc.some(r=>r.status>=400),'Drilldown read boundary failed');
          result.drilldown={kind:'workflow',id:config.run.id,route:new URL(page.url()).pathname,reloaded:true};
        }
        result.status='captured';
      }catch(error){result.status='failed';result.reason=error.name==='CIProofAssertion'?error.message:'Expected actual page/read/capture failed; sensitive diagnostics withheld';}
      result.errorCategories=errors;result.errorCategoriesTruncated=errorCategoriesTruncated;result.pageErrorCount=pageErrorCount;result.readErrorCount=readErrorCount;result.supersededAbortedReads=supersededReads;result.blockedWriteCount=writes.length;
      results.push(result);await page.close();await manifest();
      assert(result.status==='captured','Actual capture failed');
    }
    await logout(context);record.loggedIn=false;await context.close();active.splice(active.indexOf(record),1);
    console.log('Captured actual Actions inventory, run and selected step: '+theme+' '+width+'.');
  }
  await manifest(true);
  console.log('PASS: twelve actual Actions screenshots, exact run/source receipts and selected-step reload; no browser effects dispatched.');
}catch{
  console.error('CI browser failed at '+stage+'; sensitive diagnostics withheld.');process.exitCode=1;
}finally{
  for(const record of active){
    if(record.loggedIn)try{await logout(record.context);}catch{console.error('CI browser session cleanup failed; sensitive diagnostics withheld.');process.exitCode=1;}
    await record.context.close().catch(()=>{});
  }
  await browser?.close();
}
