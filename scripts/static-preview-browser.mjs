// Actual served deployment views + native form POST; root supplies private stdin.
// No request mocks, host trust/DNS edits, blanket TLS bypass or provider writes.
import {mkdir, writeFile, chmod} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const check=(value,category)=>{if(!value)throw Error(category);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const observe=process.argv.includes('--observe-live');
function validate(c,live=false){
  const golf=new URL(c.golf),preview=new URL(c.previewBase),d=c.deployment;
  check(golf.protocol==='https:'&&golf.hostname==='localhost'&&golf.port&&golf.pathname==='/'&&!golf.search&&!golf.hash,'owned-golf-origin');
  check(preview.protocol==='https:'&&preview.hostname==='preview.localhost'&&preview.port&&preview.pathname==='/'&&!preview.search&&!preview.hash,'owned-preview-origin');
  check(/^[a-f0-9]{40}$/.test(c.sourceRevision)&&/^[A-Za-z0-9+/]{43}=$/.test(c.spki),'frozen-source-leaf');
  check(d.contract==='golf.repository.local-static.v1'&&uuid.test(d.id)&&uuid.test(c.secondDeploymentId)&&d.id!==c.secondDeploymentId&&(live?d.state==='REQUESTED'&&!d.canOpen:d.state==='READY'&&d.canOpen),'actual-original-state');
  check((live?!(d.openPath??''):d.openPath===`/api/deployments/${d.id}/open`)&&d.target?.repository?.owner===c.repository.owner&&d.target?.repository?.name===c.repository.name,'original-origin-repository');
  check(d.artifact?.workflowPath==='.gitlab-ci.yml'&&/^[a-f0-9]{64}$/.test(d.artifact.archiveSha256)&&d.staticRoot==='dist','qualified-shell-static-root');
  for(const rows of [c.cookies,c.readerCookies])check(rows.length===1&&rows[0].name==='__Host-golf_session'&&rows[0].url===c.golf&&rows[0].secure&&rows[0].httpOnly&&rows[0].sameSite==='Lax'&&!rows[0].domain,'secure-host-session');
  check(Object.keys(c.expectedFiles).sort().join(',')==='index.html,report.txt'&&c.forbidden.length<=100,'bounded-fixture');
}
function immutableReceipt(d,original){
  for(const field of ['id','contract','actorId','environmentId','environmentVersion','environmentName','manifestSha256','targetFingerprint','staticRoot','createdAt','eligibleAt','artifactStorage','artifactProfileId','artifactProfileVersion','artifactStorageFingerprint'])check(d?.[field]===original[field],'original-'+field);
  for(const field of ['artifact','target','source','policy'])check(isDeepStrictEqual(d?.[field],original[field]),'original-'+field);
}
function watchRequest(raw,repositoryId,repository){
  check(Buffer.isBuffer(raw)&&raw.length>=5&&raw.length<=16389&&raw[0]===0&&raw.readUInt32BE(1)===raw.length-5,'exact-live-request-frame');
  const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(5))),cursor=request?.cursor===undefined?'':request.cursor;
  check(request&&Object.keys(request).every(key=>['repositoryId','repository','cursor'].includes(key))&&request.repositoryId===repositoryId&&isDeepStrictEqual(request.repository,repository),'original-live-request');
  check(typeof cursor==='string'&&(cursor===''||/^(0|[1-9][0-9]{0,18})$/.test(cursor)&&BigInt(cursor)<=9223372036854775807n),'exact-live-request-cursor');
  return {...request,cursor};
}
function streamEvents(raw,repositoryId,cursor=''){
  check(raw.length<=65536,'bounded-live-stream');const events=[];let offset=0,ended=false;
  while(offset<raw.length){
    check(offset+5<=raw.length,'live-frame-header');const flag=raw[offset],size=raw.readUInt32BE(offset+1);offset+=5;
    check([0,2].includes(flag)&&size<=16384&&offset+size<=raw.length,'live-frame-bound');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(offset,offset+size)));offset+=size;
    if(flag===2){check(!value.error&&offset===raw.length,'live-end');ended=true;continue;}
    const topics=value.topics??[];
    check(value.repositoryId===repositoryId&&['reset','change','heartbeat','reconnect'].includes(value.kind)&&/^(0|[1-9][0-9]{0,18})$/.test(value.cursor)&&BigInt(value.cursor)<=9223372036854775807n&&Array.isArray(topics)&&topics.every(t=>['source','issues','pulls','actions','agents'].includes(t)),'exact-live-event');
    check(BigInt(value.cursor)>=BigInt(events.at(-1)?.cursor??(cursor||'0')),'ordered-live-cursor');events.push({...value,topics});
  }
  check(ended&&events.length>0&&events.at(-1).kind==='reconnect','complete-live-stream');return events;
}
if(process.argv.includes('--self-check')){
  const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
  const golf='https://localhost:12345',cookie={name:'__Host-golf_session',url:golf,secure:true,httpOnly:true,sameSite:'Lax'};
  const c={golf,previewBase:'https://preview.localhost:12346',sourceRevision:'a'.repeat(40),spki:'a'.repeat(43)+'=',cookies:[cookie],readerCookies:[cookie],repository:{owner:'owned',name:'static'},secondDeploymentId:other,expectedFiles:{'index.html':'owned','report.txt':'report'},forbidden:[],deployment:{contract:'golf.repository.local-static.v1',id,state:'READY',canOpen:true,openPath:`/api/deployments/${id}/open`,target:{repository:{owner:'owned',name:'static'}},staticRoot:'dist',artifact:{workflowPath:'.gitlab-ci.yml',archiveSha256:'b'.repeat(64)}}};
  validate(c);
  const requested={...c,deployment:{...c.deployment,state:'REQUESTED',canOpen:false,openPath:''}};validate(requested,true);
  for(const deployment of [c.deployment,{...requested.deployment,canOpen:true},{...requested.deployment,openPath:`/api/deployments/${id}/open`}]){let refused=false;try{validate({...requested,deployment},true);}catch{refused=true;}check(refused,'active-or-open-observer-fixture-admitted');}
  for(const patch of [{golf:'http://localhost:12345'},{previewBase:'https://outside.invalid:12345'},{spki:'*'},{secondDeploymentId:id},{cookies:[{...cookie,domain:'.localhost'}]},{deployment:{...c.deployment,state:'REQUESTED'}}]){
    let refused=false;try{validate({...c,...patch});}catch{refused=true;}check(refused,'foreign-browser-fixture-admitted');
  }
  immutableReceipt(requested.deployment,requested.deployment);
  for(const patch of [{artifact:{...requested.deployment.artifact,archiveSha256:'c'.repeat(64)}},{target:{repository:{owner:'foreign',name:'static'}}}]){let refused=false;try{immutableReceipt({...requested.deployment,...patch},requested.deployment);}catch{refused=true;}check(refused,'foreign-live-receipt-admitted');}
  const frame=(value,flag=0)=>{const body=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(5);head[0]=flag;head.writeUInt32BE(body.length,1);return Buffer.concat([head,body]);};
  const request=frame({repositoryId:'12',repository:c.repository,cursor:'0'});check(watchRequest(request,'12',c.repository).cursor==='0','live-request-self-check');
  check(watchRequest(frame({repositoryId:'12',repository:c.repository}),'12',c.repository).cursor==='','omitted-live-cursor');
  const badLength=Buffer.from(request);badLength.writeUInt32BE(request.length,1);
  for(const bad of [null,request.subarray(0,4),request.subarray(0,request.length-1),badLength,Buffer.concat([request,request]),frame({repositoryId:'12',repository:c.repository},2),frame({repositoryId:'12',repository:c.repository},1),frame({repositoryId:'13',repository:c.repository}),frame({repositoryId:'12',repository:{owner:'foreign',name:'static'}}),frame({repositoryId:'12',repository:c.repository,cursor:'01'}),frame({repositoryId:'12',repository:c.repository,cursor:'9223372036854775808'}),frame({repositoryId:'12',repository:c.repository,cursor:0}),frame({repositoryId:'12',repository:c.repository,cursor:null}),frame({repositoryId:'12',repository:c.repository,foreign:true}),Buffer.concat([Buffer.from([0,0,0,0,1]),Buffer.from([255])]),Buffer.alloc(16390)]){let refused=false;try{watchRequest(bad,'12',c.repository);}catch{refused=true;}check(refused,'malformed-live-request-admitted');}
  const change=frame({repositoryId:'12',kind:'change',cursor:'3',topics:['actions']}),end=frame({},2),reconnect=frame({repositoryId:'12',kind:'reconnect',cursor:'3'}),good=Buffer.concat([change,reconnect,end]);check(streamEvents(good,'12','2')[0].topics[0]==='actions','live-frame-self-check');
  for(const bad of [good.subarray(0,good.length-1),change,Buffer.concat([change,end]),Buffer.concat([frame({repositoryId:'13',kind:'change',cursor:'3',topics:['actions']}),reconnect,end]),Buffer.concat([change,frame({repositoryId:'12',kind:'change',cursor:'2',topics:['actions']}),reconnect,end]),Buffer.concat([change,reconnect,frame({error:{code:'canceled'}},2)])]){let refused=false;try{streamEvents(bad,'12');}catch{refused=true;}check(refused,'foreign-or-incomplete-live-stream-admitted');}
  let refused=false;try{streamEvents(good,'12','4');}catch{refused=true;}check(refused,'request-cursor-regression-admitted');
  console.log('PASS: pure original/browser/host-only TLS fixture checks; no resources.');process.exit(0);
}
let text='';for await(const piece of process.stdin){text+=piece;check(text.length<=262144,'private-stdin-bound');}
const c=JSON.parse(text);validate(c,observe);
const {chromium}=await import(pathToFileURL(join(c.stackRoot,'web/node_modules/playwright/index.mjs')).href);
await mkdir(c.output,{mode:0o700});await chmod(c.output,0o700);
const browser=await chromium.launch({args:[`--ignore-certificate-errors-spki-list=${c.spki}`,'--host-resolver-rules=MAP *.preview.localhost 127.0.0.1, MAP localhost 127.0.0.1']});
const context=await browser.newContext({acceptDownloads:false});
const reader=await browser.newContext({acceptDownloads:false});
await context.addCookies(c.cookies);await reader.addCookies(c.readerCookies);
const page=await context.newPage();
const manifest={passed:false,complete:false,kind:'actual-protected-static-preview',sourceRevision:c.sourceRevision,deploymentId:c.deployment.id,captures:[],checks:{},limits:['One bounded secretless static fixture. Leaf SPKI is trusted in this disposable browser only; parent independently verifies CA/name/TLS1.3.','Reads/POST open only; parent independently qualifies deployment transitions/current authority.']};
const requests=[],receipts=[],pending=[],observed=[],streams=[];let stage='configuration',observationFailure,recordWatch=true;
page.on('request',r=>{if(r.url().startsWith(c.golf+'/rpc/'))requests.push(r.url().split('/').at(-1));});
page.on('response',r=>{if(r.url().endsWith('/GetRepositoryDeployment'))pending.push((async()=>{
  check(r.status()===200,'actual-deployment-rpc');const d=(await r.json()).deployment;
  immutableReceipt(d,c.deployment);
  check(observe||d.state==='READY'&&d.canOpen,'current-exact-artifact');receipts.push(d.id);observed.push(d);
})().catch(error=>{observationFailure??=error;}));
  if(observe&&recordWatch&&r.url().endsWith('/WatchRepository'))pending.push((async()=>{
    check(r.status()===200&&r.headers()['cache-control']==='no-store'&&r.headers()['content-type']?.startsWith('application/connect+json'),'actual-live-stream');
    const request=watchRequest(r.request().postDataBuffer(),c.deployment.target.repositoryId,c.repository);
    streams.push(streamEvents(await r.body(),request.repositoryId,request.cursor));
  })().catch(error=>{observationFailure??=error;}));
});
const previewOrigin=`https://${c.deployment.id}.preview.localhost:${new URL(c.previewBase).port}`;
const path=`/${encodeURIComponent(c.repository.owner)}/${encodeURIComponent(c.repository.name)}/deployments/${c.deployment.id}`;
function headers(h){check(h['cache-control']==='no-store'&&h['x-content-type-options']==='nosniff'&&h['referrer-policy']==='no-referrer'&&h['x-frame-options']==='DENY','private-file-headers');check(h['content-security-policy']?.includes("worker-src 'none'")&&h['content-security-policy']?.includes("connect-src 'self'")&&h['content-security-policy']?.includes("form-action 'none'"),'project-isolation-csp');}
async function privateState(p){
  check(await p.evaluate(values=>{const body=document.body.innerText,storage=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);return values.every(v=>!v||(!body.includes(v)&&!storage.includes(v)))},c.forbidden),'private-browser-persistence');
}
async function projectRead(p,url){
  // Browser networking retains this process's scoped wildcard resolver and
  // frozen leaf trust. Playwright's Node APIRequest transport does neither.
  return p.evaluate(async url=>{const response=await fetch(url,{credentials:'same-origin'});return {status:response.status,text:await response.text(),headers:Object.fromEntries(response.headers)};},url);
}
async function observeLive(){
  manifest.kind='actual-live-deployment-observer';manifest.phases=[];
  const navigations=[];page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push(frame.url());});
  await page.addInitScript(()=>localStorage.setItem('golf.theme','dark'));
  await page.setViewportSize({width:1440,height:1000});await page.goto(c.golf+path,{waitUntil:'domcontentloaded'});
  const state=page.locator('.browser-panel').filter({has:page.getByRole('heading',{name:'Deployment state',exact:true})});
  const approvals=page.getByRole('table',{name:'Deployment approvals',exact:true}),open=page.getByRole('button',{name:'Open protected preview',exact:true});
  async function phase(name,predicate,visual,capture){
    stage='observe-'+name;const deadline=Date.now()+30000;
    while(!predicate(observed.at(-1))){check(!observationFailure,'live-receipt-observation');check(Date.now()<deadline,'live-phase-deadline');await page.waitForTimeout(50);}
    await visual();check(!observationFailure,'live-receipt-observation');
    check(navigations.length===1&&page.url()===c.golf+path&&requests.every(name=>/^(Get|List|Inspect|Watch|Resolve)/.test(name)),'live-read-only-no-navigation');
    await privateState(page);await page.evaluate(()=>document.fonts.ready);
    if(capture){const file=`live-${name}-dark-1440.png`;await page.screenshot({path:join(c.output,file),fullPage:true});await chmod(join(c.output,file),0o600);manifest.captures.push({file,width:1440,theme:'dark',phase:name});}
    const d=observed.at(-1);manifest.phases.push({phase:name,state:d.state,version:d.version,canOpen:!!d.canOpen,approvalCount:(d.approvals??[]).length,receiptCount:receipts.length});
    await writeFile(join(c.output,name+'.ready'),'ready\n',{mode:0o600,flag:'wx'});
  }
  await phase('requested',d=>d?.state==='REQUESTED'&&!d.canOpen&&!(d.approvals??[]).length,async()=>{
    await state.getByText('requested',{exact:true}).waitFor();await approvals.getByText('No reviewer decisions recorded.',{exact:true}).waitFor();await page.locator('.live-status-live').waitFor();check(await open.count()===0&&requests.includes('WatchRepository'),'requested-live-no-open');
  },true);
  await phase('approved',d=>d?.state==='REQUESTED'&&(d.approvals??[]).some(a=>a.approved),async()=>{await approvals.getByText('Approved',{exact:true}).waitFor();check(await open.count()===0,'approved-not-active');},false);
  await phase('active',d=>d?.state==='READY'&&d.canOpen&&d.openPath===`/api/deployments/${c.deployment.id}/open`,async()=>{await state.getByText('Active protected preview',{exact:true}).waitFor();await open.waitFor();check(await open.isEnabled(),'active-open-enabled');},true);
  await phase('revoked',d=>d?.state==='REVOKED'&&!d.canOpen&&!d.openPath,async()=>{await state.getByText('revoked',{exact:true}).waitFor();check(await open.count()===0,'revoked-no-open');},true);
  // Native streams end after 10s, before the client's 14s deadline. Drain
  // the admitted snapshot; a later rotation is unnecessary for this proof.
  recordWatch=false;await Promise.all([...pending]);check(!observationFailure,'live-receipt-observation');
  const events=streams.flat(),changes=events.filter(e=>e.kind==='change'&&e.topics.includes('actions'));
  check(changes.length>=3&&new Set(changes.map(e=>e.cursor)).size>=3,'actual-review-activation-revoke-events');
  manifest.checks={readOnlyDeploymentViews:true,noReloadOrRefresh:true,mainNavigations:navigations.length,actualImmutableReceipts:receipts.length,watchRequests:requests.filter(name=>name==='WatchRepository').length,actualActionsChanges:changes.map(e=>({kind:e.kind,cursor:e.cursor,topics:e.topics})),externalApprovalVisible:true,externalActivationVisible:true,externalRevocationVisible:true};
}
try{
  if(observe){await observeLive();}else{
  for(const width of [1440,390])for(const theme of ['dark','light']){
    stage='capture-'+theme+'-'+width;await page.setViewportSize({width,height:1000});
    await page.goto(c.golf,{waitUntil:'domcontentloaded'});await page.evaluate(value=>localStorage.setItem('golf.theme',value),theme);
    await page.goto(c.golf+path,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:c.deployment.environmentName,exact:true}).waitFor();
    const open=page.getByRole('button',{name:'Open protected preview',exact:true});await open.waitFor();
    check(await open.isEnabled(),'open-enabled');
    const form=open.locator('..');check(await form.getAttribute('method')==='post'&&await form.getAttribute('action')===c.deployment.openPath&&await form.getAttribute('target')==='_blank','native-protected-form');
    await page.evaluate(()=>document.fonts.ready);check(await page.evaluate(()=>document.documentElement.dataset.theme)===theme,'actual-theme');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile-overflow');await privateState(page);
    const file=`deployment-${theme}-${width}.png`;await page.screenshot({path:join(c.output,file),fullPage:true});await chmod(join(c.output,file),0o600);manifest.captures.push({file,width,theme});
  }
  await Promise.all(pending);check(!observationFailure&&receipts.length>=4&&requests.every(name=>/^(Get|List|Inspect|Watch|Resolve)/.test(name)),'read-only-views');
  stage='actual-native-protected-form-open';
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Open protected preview',exact:true}).click();const project=await popupPromise;
  await project.waitForURL(previewOrigin+'/',{timeout:30000});await project.waitForLoadState('domcontentloaded');
  check(await project.locator('body').innerText()==='owned artifact','actual-project-bytes');
  check(new URL(project.url()).search===''&&new URL(project.url()).hash==='','no-url-grant');
  const file=await projectRead(project,previewOrigin+'/report.txt');check(file.status===200&&file.text===c.expectedFiles['report.txt'],'actual-asset-bytes');headers(file.headers);
  const cookies=await context.cookies(previewOrigin);check(cookies.length===1&&cookies[0].name==='__Host-golf_preview'&&cookies[0].secure&&cookies[0].httpOnly&&cookies[0].domain===new URL(previewOrigin).hostname&&cookies[0].path==='/'&&cookies[0].sameSite==='Lax','isolated-preview-cookie');
  c.forbidden.push(cookies[0].value);
  const golfCookies=await context.cookies(c.golf);check(golfCookies.length===1&&golfCookies[0].name==='__Host-golf_session'&&golfCookies[0].domain==='localhost','canonical-cookie-isolated');
  check(await project.evaluate(()=>document.cookie)==='','project-js-cannot-read-auth');await privateState(project);
  const deniedRoutes=['/rpc/golf.v1.SessionService/GetSession','/api/deployments/'+c.deployment.id+'/open','/missing','/%2freport.txt'];
  for(const route of deniedRoutes){const response=await projectRead(project,previewOrigin+route);check(response.status===404&&!response.text.includes('owned artifact'),'project-no-golf-route');headers(response.headers);}
  const second=`https://${c.secondDeploymentId}.preview.localhost:${new URL(c.previewBase).port}/`;
  const otherPage=await context.newPage();const wrong=await otherPage.goto(second,{waitUntil:'domcontentloaded'});check(wrong.status()===404,'other-host-cookie-not-authority');await otherPage.close();
  const readerPage=await reader.newPage();const noLaunch=await readerPage.goto(previewOrigin+'/',{waitUntil:'domcontentloaded'});check(noLaunch.status()===404,'reader-needs-own-launch');await readerPage.close();
  const restrictions=await project.evaluate(async golf=>{
    let fetchDenied=false,workerDenied=false;const violations=[];
    document.addEventListener('securitypolicyviolation',event=>violations.push(event.effectiveDirective));
    try{await fetch(golf+'/rpc/golf.v1.SessionService/GetSession',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});}catch{fetchDenied=true;}
    try{await navigator.serviceWorker.register('/report.txt');}catch{workerDenied=true;}
    await new Promise(resolve=>setTimeout(resolve,50));
    return {fetchDenied,workerDenied,violations,registrations:(await navigator.serviceWorker.getRegistrations()).length};
  },c.golf);
  check(restrictions.fetchDenied&&restrictions.workerDenied&&restrictions.registrations===0&&restrictions.violations.includes('connect-src')&&restrictions.violations.includes('worker-src'),'csp-origin-worker-isolation');
  manifest.checks={actualNativeFormOpen:true,exactProjectAndAssetBytes:true,secureHttpOnlyHostCookies:true,noGrantInURL:true,noGolfCookieOnProject:true,noPreviewCookieOnGolf:true,projectJSCannotReadCookie:true,foreignDeploymentAndNoLaunchDenied:true,golfRoutesUnavailable:true,serviceWorkerDenied:true,crossOriginFetchDenied:true,actualImmutableReceipts:receipts.length,readOnlyDeploymentViews:true};
  }
  manifest.passed=true;manifest.complete=true;
}catch(error){manifest.originalFailure={stage,type:error.name};throw error;}
finally{
  await browser.close();await writeFile(join(c.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
}
console.log(observe?'PASS: actual read-only live review, activation and revoke observations.':'PASS: four served original deployment views and real protected browser open; parent owns transition/authority proof.');
