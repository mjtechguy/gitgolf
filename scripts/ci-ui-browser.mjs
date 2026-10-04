// Optional actual CI proof. Private managed credentials arrive only on stdin.
// This never dispatches/cancels a workflow or mocks a provider/browser response.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {chmod,writeFile} from 'node:fs/promises';

const headers=origin=>({Origin:origin,'Connect-Protocol-Version':'1','Content-Type':'application/json'});
const readProcedure=method=>/^(Get|List|Watch|Inspect|Resolve)/.test(method)||method==='QueryRepositoryComparison';
const surfaces=['actions-inventory','actions-run','actions-selected-step'];
const widths=[1440,390],themes=['dark','light'];
const assert=(condition,message)=>{if(!condition){const error=Error(message);error.name='CIProofAssertion';throw error;}};
if(process.argv.includes('--self-check')){
  assert(surfaces.length*widths.length*themes.length===12,'Capture inventory changed');
  for(const method of ['GetWorkflowRun','GetWorkflowRunLogs','ListWorkflowRuns','WatchRepository'])assert(readProcedure(method),'Read guard failed');
  for(const method of ['DispatchWorkflow','CancelWorkflowRun','SavePullRequestReviewDraft','UpdateExecutionPolicy','LoginWithPassword'])assert(!readProcedure(method),'Effect guard failed');
  console.log('PASS: twelve capture cases and read-only browser guard; no browser or native fixture executed.');
  process.exit(0);
}

let config,browser,stage='configuration';
const active=[],results=[];
async function manifest(complete=false){
  if(!config?.screenshots)return;
  await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({
    captureKind:'Actual successful controlled shell Actions run in a disposable isolated Compose installation',
    workingTreeHead:config.workingTreeHead,servedSourceCommit:config.servedSourceCommit??null,
    servedSourceProvenance:config.servedSourceProvenance,runtime:config.runtime,
    repositoryId:config.repositoryId,runId:config.run.id,commitId:config.run.commitId,
    ownerOnly:true,complete,passed:complete&&results.length===12&&results.every(r=>r.status==='captured'),results,
    limitations:[
      'GitHub public run logs may require sign-in; these captures are Golf-only, not authenticated GitHub comparisons.',
      'Controlled shell workflow only; this does not qualify hosted actions, complete Actions/GitLab compatibility, artifacts, cache or protected merges.',
      'Fresh disposable instance policies only; retained instance settings are unchanged.',
      'Working-tree HEAD is separate from served-source provenance; an absent OCI revision label remains unknown.',
    ],
  },null,2)+'\n',{mode:0o600});
}
function exactRun(run){
  return run?.id===config.run.id&&run.repositoryId===config.repositoryId&&run.ownerId===config.run.ownerId&&run.commitId===config.run.commitId&&run.workflowPath===config.run.workflowPath&&run.workflowBlobId===config.run.workflowBlobId&&run.sourceSha256===config.run.sourceSha256&&run.state==='WORKFLOW_RUN_STATE_SUCCEEDED';
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
  assert(exactRun(config.run)&&config.run.progress?.eventsRecorded&&config.run.progress.steps?.length===2,'Expected independently proven successful two-step run');
  assert(config.run.progress.steps[0].name==='Read source'&&config.run.progress.steps[1].name==='Verify workspace','Controlled fixture differs');
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
      const rpc=[],writes=[],errors=[],receipts=[],responseTasks=[];
      const inflight=new Set();let lastResponse=Date.now();
      await page.route('**/rpc/**',route=>{
        const method=route.request().url().split('/').at(-1);
        if(!readProcedure(method)){writes.push(method);return route.abort('blockedbyclient');}
        return route.continue();
      });
      page.on('pageerror',()=>errors.push('page-error'));
      page.on('request',request=>{if(request.url().includes('/rpc/')&&!request.url().endsWith('/WatchRepository'))inflight.add(request);});
      page.on('requestfailed',request=>{if(inflight.delete(request)){lastResponse=Date.now();errors.push('unary-read-failed');}});
      page.on('response',response=>{
        if(!response.url().includes('/rpc/'))return;
        const procedure=response.url().split('/').at(-1);rpc.push({procedure,status:response.status()});
        if(procedure!=='WatchRepository'){inflight.delete(response.request());lastResponse=Date.now();}
        if(['ListWorkflowRuns','GetWorkflowRun','GetWorkflowRunLogs'].includes(procedure))responseTasks.push((async()=>{
          try{receipts.push({procedure,status:response.status(),request:response.request().postDataJSON(),body:await response.json()});}catch{errors.push('invalid-read-receipt');}
        })());
      });
      const route=id==='actions-inventory'?repo+'/actions':repo+'/actions/runs/'+config.run.id;
      const result={id,width,height:1000,theme,role:'owner',status:'pending',requestedRoute:route,rpc,check:'page-readiness'};
      try{
        await page.goto(config.golf+route,{waitUntil:'domcontentloaded'});
        if(id==='actions-inventory'){
          const row=page.getByRole('table',{name:'Workflow runs',exact:true}).locator('tr[data-row-id="'+config.run.id+'"]');
          await row.getByRole('link',{name:config.run.workflowPath,exact:true}).waitFor();
          assert(await row.getByText('succeeded',{exact:true}).count()===1,'Run result not shown');
        }else{
          await page.getByRole('heading',{name:config.run.workflowPath,exact:true}).waitFor();
          if(id==='actions-selected-step'){
            result.check='selected-step-navigation';
            result.check='selected-step-open-jobs';
            if(width===390)await page.getByLabel('Jobs and steps').locator('summary').click();
            result.check='selected-step-visible-link';
            await page.getByLabel('Jobs and steps').getByRole('link',{name:/Read source/}).click();
            await page.waitForURL(url=>url.searchParams.get('step')==='0');
            assert(new URL(page.url()).searchParams.get('step')==='0','Selected step URL differs');
            // The old document's reads may be cancelled without a terminal
            // response event on navigation. Track only the reloaded document;
            // request identities fence any late responses from the old one.
            inflight.clear();
            await page.reload({waitUntil:'domcontentloaded'});
            result.check='selected-step-reload-binding';
            const selectedLink=page.getByLabel('Jobs and steps').getByRole('link',{name:/Read source/,includeHidden:width===390});
            await selectedLink.waitFor({state:width===390?'attached':'visible'});
            assert(await selectedLink.getAttribute('aria-current')==='page','Reload lost selected step');
          }
          const log=page.getByLabel('Workflow run log',{exact:true});await log.waitFor();
          result.check='controlled-output';
          await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow run log"]')?.textContent?.includes('actions proof'));
          const text=await log.innerText();
          assert(text.includes('actions proof'),'Controlled first-step output absent');
          assert(text.includes('second step proof')===(id==='actions-run'),'Selected log range differs');
        }
        result.check='read-receipts';
        const deadline=Date.now()+12000;
        while(Date.now()<deadline&&(inflight.size>0||Date.now()-lastResponse<450))await page.waitForTimeout(100);
        result.pendingReads=[...inflight].map(request=>request.url().split('/').at(-1));
        assert(inflight.size===0,'Reads did not settle');await Promise.all(responseTasks);
        if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true}).click();
        result.actualTheme=await page.locator('html').getAttribute('data-theme');
        const current=receipts.filter(r=>r.status===200);
        result.logSelections=current.filter(r=>r.procedure==='GetWorkflowRunLogs').map(r=>r.request.stepIndex??'all');
        if(id==='actions-inventory')assert(current.some(r=>r.procedure==='ListWorkflowRuns'&&r.request.repository?.owner===config.repository.owner&&r.request.repository?.name===config.repository.name&&r.body.runs?.some(exactRun)),'Exact inventory receipt missing');
        else{
          assert(current.some(r=>r.procedure==='GetWorkflowRun'&&r.request.runId===config.run.id&&exactRun(r.body.run)),'Exact run receipt missing');
          assert(current.some(r=>r.procedure==='GetWorkflowRunLogs'&&r.request.runId===config.run.id&&(id==='actions-selected-step'?r.request.stepIndex===0:r.request.stepIndex===undefined)),'Exact log request missing');
        }
        result.check='layout';
        result.metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,firstLogY:document.querySelector('.execution-log')?.getBoundingClientRect().y??null,jobNavigationWidth:document.querySelector('.automation-job-navigation')?.getBoundingClientRect().width??null,jobsOpen:document.querySelector('.workflow-jobs-disclosure')?.open??null}));
        if(width===390&&id!=='actions-inventory'){assert(result.metrics.jobsOpen===false,'Mobile jobs disclosure did not start collapsed');assert(result.metrics.firstLogY!==null&&result.metrics.firstLogY<750,'Mobile log begins too far below the run header');}
        assert(!errors.length&&!writes.length&&!rpc.some(r=>r.status>=400)&&result.actualTheme===theme&&result.metrics.documentWidth<=width,'Runtime/read-only/theme/layout boundary failed');
        result.actualRoute=new URL(page.url()).pathname+new URL(page.url()).search;
        const basename=id+'-'+theme+'-'+width;
        await page.screenshot({path:join(config.screenshots,basename+'.png'),fullPage:true,timeout:20000});await chmod(join(config.screenshots,basename+'.png'),0o600);
        await writeFile(join(config.screenshots,basename+'.txt'),await page.locator('body').innerText(),{mode:0o600});
        result.screenshot=basename+'.png';result.textSnapshot=basename+'.txt';result.status='captured';
      }catch(error){result.status='failed';result.reason=error.name==='CIProofAssertion'?error.message:'Expected actual page/read/capture failed; sensitive diagnostics withheld';}
      result.pageErrorCount=errors.length;result.blockedWriteCount=writes.length;
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
