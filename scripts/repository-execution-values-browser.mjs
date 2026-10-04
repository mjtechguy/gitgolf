// Actual mounted settings + exact redacted run proof; credentials only on stdin.
// No browser writes; requested editors stay blank. Source checking is not proof.
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {writeFile,chmod} from 'node:fs/promises';

const readMethods=new Set(['GetSession','GetRepository','GetRepositoryAccess','GetRepositorySettings','GetRepositoryOverview','ListBranches','ListTags','ListRepositories','ListOrganizations','GetRepositoryEvents','WatchRepository','ListRepositoryExecutionValues','GetWorkflowRun','GetWorkflowRunLogs','ListActionRuns','GetActionRun','GetExecutionPolicy','GetEffectiveExecutionPolicy','InspectWorkflows','ListAutomationGrants','ListAgentTasks','ListReviewerRuns','ListReviewers','ListAgentConnections','ListReviewerPresets','GetCapabilities','ListCapabilities']);
function check(value){if(!value)throw new Error('proof assertion');}
function identity(body,config){return body?.repositoryId===config.repositoryId&&body?.ownerId===config.ownerId&&body.repository?.owner===config.repository.owner&&body.repository?.name===config.repository.name&&/^[a-f0-9]{64}$/.test(body.accessRevision);}
function runReceipt(value,config){return value?.id===config.run.id&&value.repositoryId===config.repositoryId&&value.ownerId===config.ownerId&&value.commitId===config.run.commitId&&value.workflowBlobId===config.run.workflowBlobId&&value.sourceSha256===config.run.sourceSha256&&value.attemptId===config.run.attemptId&&value.executionBindingId===config.run.executionBindingId&&value.executionBindingVersion===config.run.executionBindingVersion&&value.outputState==='WORKFLOW_OUTPUT_STATE_REDACTED'&&value.state==='WORKFLOW_RUN_STATE_SUCCEEDED';}
if(process.argv.includes('--self-check')){
  check(readMethods.has('ListRepositoryExecutionValues')&&!readMethods.has('SaveRepositoryExecutionValue')&&!readMethods.has('GetRepositoryExecutionVariable')&&!readMethods.has('DispatchWorkflow'));
  const config={repositoryId:'1',ownerId:'2',repository:{owner:'fixture',name:'owned'},run:{id:'run',commitId:'head',workflowBlobId:'blob',sourceSha256:'archive',attemptId:'attempt',executionBindingId:'binding',executionBindingVersion:'1'}};
  const row={...config.run,repositoryId:'1',ownerId:'2',outputState:'WORKFLOW_OUTPUT_STATE_REDACTED',state:'WORKFLOW_RUN_STATE_SUCCEEDED'};
  check(runReceipt(row,config));for(const field of ['repositoryId','ownerId','commitId','attemptId','executionBindingVersion','outputState'])check(!runReceipt({...row,[field]:'wrong'},config));
  check(identity({repositoryId:'1',ownerId:'2',repository:config.repository,accessRevision:'a'.repeat(64)},config));
  console.log('PASS: source-only12capture/read/receipt cases; no browser/native execution.');process.exit(0);
}
let config,browser,context,stage='configuration';const captures=[];
async function manifest(complete=false){if(config?.screenshots)await writeFile(join(config.screenshots,'manifest.json'),JSON.stringify({complete,passed:complete&&captures.length===12,captureKind:'Actual fresh mounted repository environment settings and verified redacted workflow output',sourceRevision:config.sourceRevision??null,runtime:config.runtime,repositoryId:config.repositoryId,runId:config.run.id,ownerOnly:true,captures,limits:['No browser mutation or native notification.','Secret editor captures contain only a blank replacement field.','Golf-only actual screenshots; GitHub authenticated settings/logs are not invented references.','Partial repository maintained-Actions environment; no OIDC/full CI/CD/fork/agent support.']},null,2)+'\n',{mode:0o600});}
try{
  let input='';for await(const chunk of process.stdin){input+=chunk;check(input.length<=256*1024);}config=JSON.parse(input);input='';
  check(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(config.golf)&&/^[1-9][0-9]*$/.test(config.repositoryId)&&/^[1-9][0-9]*$/.test(config.ownerId)&&runReceipt(config.run,config));
  const {chromium}=await import(pathToFileURL(join(config.stackRoot,'web/node_modules/playwright/index.mjs')));browser=await chromium.launch();await manifest();
  const repository='/'+encodeURIComponent(config.repository.owner)+'/'+encodeURIComponent(config.repository.name),headers={Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'};
  for(const theme of ['dark','light'])for(const width of [1440,390]){
    stage='managed owner login';context=await browser.newContext({viewport:{width,height:1000}});
    const login=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers,data:{username:config.email,password:config.password}});check(login.status()===200&&((await login.json()).user.login===config.username));
    await context.addInitScript(value=>localStorage.setItem('golf.theme',value),theme);
    const page=await context.newPage(),errors=[],writes=[],reads=[],pending=[],requestGenerations=new Map();let generation=0;page.setDefaultTimeout(15000);
    page.on('pageerror',()=>errors.push('browser_page_error'));
    await page.route('**/rpc/**',route=>{const method=route.request().url().split('/').at(-1);if(!readMethods.has(method)){writes.push(method);return route.abort('blockedbyclient');}return route.continue();});
    page.on('request',request=>{if(request.url().includes('/rpc/'))requestGenerations.set(request,generation);});
    page.on('requestfailed',request=>{if(request.url().includes('/rpc/')&&!(requestGenerations.get(request)<generation&&request.failure()?.errorText==='net::ERR_ABORTED'))errors.push('read_transport_error');});
    page.on('response',response=>{
      const method=response.url().split('/').at(-1);if(!response.url().includes('/rpc/'))return;
      pending.push((async()=>{
        check(response.status()===200&&response.headers()['cache-control']==='no-store');
        if(!['ListRepositoryExecutionValues','GetWorkflowRun','GetWorkflowRunLogs'].includes(method))return;
        const request=response.request().postDataJSON(),body=await response.json();
        if(method==='ListRepositoryExecutionValues')check(identity(body.target,config)&&JSON.stringify(body.target)===JSON.stringify(request.target)&&body.maximumValues===64&&body.maximumBindings===20&&body.consumerProfile==='golf.repository-env.v1');
        else if(method==='GetWorkflowRun')check(request.runId===config.run.id&&runReceipt(body.run,config));
        else{
          check(request.runId===config.run.id&&body.runId===config.run.id&&body.attemptId===config.run.attemptId&&body.repositoryId===config.repositoryId&&body.sourceCommitId===config.run.commitId&&body.outputState==='WORKFLOW_OUTPUT_STATE_REDACTED');
          check((request.jobInstanceId??'')===(body.jobInstanceId??'')&&(request.stepId??'')===(body.stepId??'')&&!(body.logs??[]).some(row=>row.text.includes(config.secret)));
        }
        reads.push({method});
      })().catch(()=>errors.push('read_receipt_error')));
    });
    async function capture(kind){
      await page.evaluate(()=>document.fonts.ready);await Promise.all(pending);check(!errors.length&&!writes.length);
      check(await page.locator('html').getAttribute('data-theme')===theme);
      const text=await page.locator('body').innerText();check(!text.includes(config.secret)&&!text.includes(config.password));
      const metrics=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,fontsLoaded:document.fonts.status==='loaded'}));check(metrics.documentWidth<=width&&metrics.fontsLoaded);
      const name='execution-values-'+kind+'-'+theme+'-'+width;
      await page.screenshot({path:join(config.screenshots,name+'.png'),fullPage:true});await chmod(join(config.screenshots,name+'.png'),0o600);await writeFile(join(config.screenshots,name+'.txt'),text,{mode:0o600});
      captures.push({kind,theme,width,metrics,image:name+'.png',text:name+'.txt',readOnly:true,privateValuesAbsent:true});await manifest();
    }
    stage='mounted native-admin inventory';generation++;await page.goto(config.golf+repository+'/settings/secrets');
    const table=page.getByRole('table',{name:'Repository secrets and variables',exact:true});await table.waitFor();await table.getByText('BUILD_CREDENTIAL',{exact:true}).waitFor();
    check(await page.getByRole('form',{name:'Repository execution value editor',exact:true}).count()===0&&reads.some(row=>row.method==='ListRepositoryExecutionValues'));await capture('inventory');
    stage='requested secret replacement remains blank';await page.getByRole('button',{name:'Replace secret BUILD_CREDENTIAL',exact:true}).click();
    check(await page.getByLabel('Replacement secret',{exact:true}).inputValue()==='');await capture('blank-secret-editor');await page.getByRole('button',{name:'Cancel',exact:true}).click();
    stage='exact selected job output and publication cue';generation++;await page.goto(config.golf+repository+'/actions/runs/'+config.run.id+'?jobInstanceId='+config.selectedJob+'&stepId=environment');
    const log=page.getByLabel('Workflow run log',{exact:true});await log.waitFor();
    for(let i=0;i<64;i++){const more=page.getByRole('button',{name:'Load more log output',exact:true});if(!await more.count())break;await more.click();await page.waitForTimeout(100);}
    await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow run log"]')?.textContent?.includes('verified-environment-complete'));
    check((await log.innerText()).includes('x'.repeat(4090)+'*'.repeat(config.secret.length)+'\n'));
    await page.getByText('Configured secret values were masked before this log was published.',{exact:true}).waitFor();
    check(reads.some(row=>row.method==='GetWorkflowRun')&&reads.some(row=>row.method==='GetWorkflowRunLogs'));await capture('redacted-selected-run');
    check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers,data:{}})).status()===200);await context.close();context=undefined;
  }
  await manifest(true);console.log('PASS: actual execution values settings/run captures; no browser mutations.');
}catch(error){console.error('Execution values browser failed at '+stage+'; '+(error.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;}
finally{
  if(context&&config)try{check((await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}})).status()===200);}catch{process.exitCode=1;}
  await browser?.close();
}
