// Actual served deployment views + native form POST; root supplies private stdin.
// No request mocks, host trust/DNS edits, blanket TLS bypass or provider writes.
import {mkdir, writeFile, chmod} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const check=(value,category)=>{if(!value)throw Error(category);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validate(c){
  const golf=new URL(c.golf),preview=new URL(c.previewBase),d=c.deployment;
  check(golf.protocol==='https:'&&golf.hostname==='localhost'&&golf.port&&golf.pathname==='/'&&!golf.search&&!golf.hash,'owned-golf-origin');
  check(preview.protocol==='https:'&&preview.hostname==='preview.localhost'&&preview.port&&preview.pathname==='/'&&!preview.search&&!preview.hash,'owned-preview-origin');
  check(/^[a-f0-9]{40}$/.test(c.sourceRevision)&&/^[A-Za-z0-9+/]{43}=$/.test(c.spki),'frozen-source-leaf');
  check(d.contract==='golf.repository.local-static.v1'&&uuid.test(d.id)&&uuid.test(c.secondDeploymentId)&&d.id!==c.secondDeploymentId&&d.state==='READY'&&d.canOpen,'actual-active-original');
  check(d.openPath===`/api/deployments/${d.id}/open`&&d.target?.repository?.owner===c.repository.owner&&d.target?.repository?.name===c.repository.name,'original-origin-repository');
  check(d.artifact?.workflowPath==='.gitlab-ci.yml'&&/^[a-f0-9]{64}$/.test(d.artifact.archiveSha256)&&d.staticRoot==='dist','qualified-shell-static-root');
  for(const rows of [c.cookies,c.readerCookies])check(rows.length===1&&rows[0].name==='__Host-golf_session'&&rows[0].url===c.golf&&rows[0].secure&&rows[0].httpOnly&&!rows[0].domain,'secure-host-session');
  check(Object.keys(c.expectedFiles).sort().join(',')==='index.html,report.txt'&&c.forbidden.length<=100,'bounded-fixture');
}
if(process.argv.includes('--self-check')){
  const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
  const golf='https://localhost:12345',cookie={name:'__Host-golf_session',url:golf,secure:true,httpOnly:true};
  const c={golf,previewBase:'https://preview.localhost:12346',sourceRevision:'a'.repeat(40),spki:'a'.repeat(43)+'=',cookies:[cookie],readerCookies:[cookie],repository:{owner:'owned',name:'static'},secondDeploymentId:other,expectedFiles:{'index.html':'owned','report.txt':'report'},forbidden:[],deployment:{contract:'golf.repository.local-static.v1',id,state:'READY',canOpen:true,openPath:`/api/deployments/${id}/open`,target:{repository:{owner:'owned',name:'static'}},staticRoot:'dist',artifact:{workflowPath:'.gitlab-ci.yml',archiveSha256:'b'.repeat(64)}}};
  validate(c);
  for(const patch of [{golf:'http://localhost:12345'},{previewBase:'https://outside.invalid:12345'},{spki:'*'},{secondDeploymentId:id},{cookies:[{...cookie,domain:'.localhost'}]},{deployment:{...c.deployment,state:'REQUESTED'}}]){
    let refused=false;try{validate({...c,...patch});}catch{refused=true;}check(refused,'foreign-browser-fixture-admitted');
  }
  console.log('PASS: pure original/browser/host-only TLS fixture checks; no resources.');process.exit(0);
}
let text='';for await(const piece of process.stdin){text+=piece;check(text.length<=262144,'private-stdin-bound');}
const c=JSON.parse(text);validate(c);
const {chromium}=await import(pathToFileURL(join(c.stackRoot,'web/node_modules/playwright/index.mjs')).href);
await mkdir(c.output,{mode:0o700});await chmod(c.output,0o700);
const browser=await chromium.launch({args:[`--ignore-certificate-errors-spki-list=${c.spki}`,'--host-resolver-rules=MAP *.preview.localhost 127.0.0.1, MAP localhost 127.0.0.1']});
const context=await browser.newContext({acceptDownloads:false});
const reader=await browser.newContext({acceptDownloads:false});
await context.addCookies(c.cookies);await reader.addCookies(c.readerCookies);
const page=await context.newPage();
const manifest={passed:false,complete:false,kind:'actual-protected-static-preview',sourceRevision:c.sourceRevision,deploymentId:c.deployment.id,captures:[],checks:{},limits:['One bounded secretless static fixture. Leaf SPKI is trusted in this disposable browser only; parent independently verifies CA/name/TLS1.3.','Reads/POST open only; parent independently qualifies deployment transitions/current authority.']};
const requests=[],receipts=[],pending=[];let stage='configuration';
page.on('request',r=>{if(r.url().startsWith(c.golf+'/rpc/'))requests.push(r.url().split('/').at(-1));});
page.on('response',r=>{if(r.url().endsWith('/GetRepositoryDeployment'))pending.push((async()=>{
  check(r.status()===200,'actual-deployment-rpc');const d=(await r.json()).deployment;
  for(const field of ['id','contract','actorId','environmentId','environmentVersion','manifestSha256','targetFingerprint','staticRoot'])check(d?.[field]===c.deployment[field],'original-'+field);
  check(d.artifact?.archiveSha256===c.deployment.artifact.archiveSha256&&d.artifact?.commitId===c.deployment.artifact.commitId&&d.state==='READY'&&d.canOpen,'current-exact-artifact');receipts.push(d.id);
})());});
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
try{
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
  await Promise.all(pending);check(receipts.length>=4&&requests.every(name=>/^(Get|List|Inspect|Watch|Resolve)/.test(name)),'read-only-views');
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
  manifest.passed=true;manifest.complete=true;
}catch(error){manifest.originalFailure={stage,type:error.name};throw error;}
finally{
  await browser.close();await writeFile(join(c.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
}
console.log('PASS: four served original deployment views and real protected browser open; parent owns transition/authority proof.');
