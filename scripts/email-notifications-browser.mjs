// Maintained actual browser consumer. Prepared source is not served evidence.
// Credentials/codes are stdin + transient RAM only; no browser storage or logs.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
let browser, config, stage='initialization';
const contexts=[], captures=[], procedures={}, privateCodes=[];
const proof={status:'running',captures,codeOrBodyPersisted:false};
const check=value=>{if(!value)throw Error('assertion');};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function persist(){if(config)await writeFile(join(config.output,'browser-manifest.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});}
async function setTheme(page,theme){const button=page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true});if(await button.count())await button.click();
  await page.locator('html').waitFor();
  check(await page.locator('html').getAttribute('data-theme')===theme);}
async function controlCode(id){check(/^[a-f0-9-]{36}$/.test(id));
  const deadline=Date.now()+90000;while(Date.now()<deadline){const response=await fetch(config.control+'/code/'+id,{headers:{Authorization:'Bearer '+config.controlKey},signal:AbortSignal.timeout(5000),cache:'no-store'});if(response.status===200){const value=await response.json();
  check(/^[0-9]{8}$/.test(value.code));return value.code;}check(response.status===404);
  await pause(500);}throw Error('verification observation deadline');}
async function login(context,actor){const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/LoginWithPassword',{headers:{Origin:config.golf,'Content-Type':'application/json','Connect-Protocol-Version':'1'},data:{username:actor.email,password:actor.password}});
  check(response.status()===200);return (await response.json()).user;}
async function capture(page,theme,width,kind){check(await page.locator('html').getAttribute('data-theme')===theme);
  await page.evaluate(()=>document.fonts.ready);
  const secrets=[config.controlKey,config.ownerToken,config.operator.password,...Object.values(config.fixtures).map(actor=>actor.password),...privateCodes];
  check(await page.evaluate(values=>{const rendered=document.body.innerText+'\n'+Array.from(document.querySelectorAll('input,textarea'),element=>element.value).join('\n');const stored=JSON.stringify({...localStorage,...sessionStorage});return values.every(value=>typeof value==='string'&&value.length>0&&!rendered.includes(value)&&!stored.includes(value));},secrets));
  const metrics=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
  check(metrics.documentWidth<=width);
  const filename=`email-${kind}-${theme}-${width}.png`;
  await page.screenshot({path:join(config.output,filename),fullPage:true});
  captures.push({theme,width,kind,file:filename,overflow:false,...metrics});
  await persist();}
function track(page){page.on('pageerror',()=>{proof.pageErrors=(proof.pageErrors||0)+1;});page.on('request',request=>{if(request.url().includes('/rpc/golf.v1.EmailNotificationService/')){const method=request.url().split('/').at(-1);procedures[method]=(procedures[method]||0)+1;}});}
const writes=()=>Object.entries(procedures).filter(([name])=>/^(Save|Activate|Request|Confirm|Redeliver)/.test(name)).reduce((sum,[,count])=>sum+count,0);
try{
 let input='';for await(const chunk of process.stdin){input+=chunk;
  check(input.length<=1<<20);}config=JSON.parse(input);
  input='';
 check(config.paths.account==='/account/settings'&&config.paths.admin==='/admin/settings/notifications'&&config.paths.repository==='/'+config.repository+'/settings/webhooks');
 const {chromium}=await import(pathToFileURL(join(process.cwd(),'web/node_modules/playwright/index.mjs')));browser=await chromium.launch();
  proof.runtime=config.runtime;
  await persist();
 for(const theme of ['dark','light']){
  stage='managed local browser enrollment '+theme;
  const actor=config.fixtures[theme];
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  contexts.push(context);
  const user=await login(context,actor);
  check(user.id===actor.id);
  const page=await context.newPage();track(page);
  stage='explicit own verification '+theme;
  await page.goto(config.golf+config.paths.account);
  const own=page.getByRole('table',{name:'Notification email settings',exact:true});
  await own.waitFor();
  check((await own.innerText()).includes(actor.email));
  await setTheme(page,theme);
  const requested=page.waitForResponse(response=>response.url().endsWith('EmailNotificationService/RequestEmailVerification')&&response.status()===200);
  await page.getByRole('button',{name:'Send verification code',exact:true}).click();
  const verification=await (await requested).json();
  check(verification.state.nativeUserId===actor.id&&verification.state.loginEmail===actor.email&&verification.challengeId===verification.deliveryId&&verification.acceptedContactVersion==='1');
  let code=await controlCode(verification.deliveryId);
  privateCodes.push(code);
  await page.getByRole('button',{name:'Enter verification code',exact:true}).click();
  await page.getByLabel('Verification code',{exact:true}).fill(code);
  const confirmed=page.waitForResponse(response=>response.url().endsWith('EmailNotificationService/ConfirmEmailVerification')&&response.status()===200);
  await page.getByRole('button',{name:'Confirm email',exact:true}).click();
  check((await (await confirmed).json()).state.verified);
  check(!(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(code));
  code='';
  await page.getByRole('form',{name:'Notification email verification',exact:true}).waitFor({state:'detached'});
  await own.getByText('Verified',{exact:true}).waitFor();
  stage='explicit global consent '+theme;
  await page.getByRole('button',{name:'Edit email preference',exact:true}).click();
  await page.getByLabel('Enable notification email',{exact:true}).check();
  await page.getByLabel('Authorize my repository email subscriptions after browser logout',{exact:true}).check();
  await page.getByRole('button',{name:'Save preference',exact:true}).click();
  await page.getByRole('form',{name:'Email preference editor',exact:true}).waitFor({state:'detached'});
  await own.getByText('Enabled',{exact:true}).waitFor();
  stage='read-member explicit repository subscription '+theme;
  await page.goto(config.golf+config.paths.repository);
  const subscriptions=page.getByRole('table',{name:'My repository email subscription',exact:true});
  await subscriptions.waitFor();
  await page.getByRole('button',{name:'Add subscription',exact:true}).click();
  const editor=page.getByRole('form',{name:'Repository email subscription editor',exact:true});
  await editor.getByLabel('Issues',{exact:true}).check();
  await page.getByLabel('Enable this repository email subscription',{exact:true}).check();
  await page.getByLabel('Authorize background delivery using my local Golf account',{exact:true}).check();
  const saved=page.waitForResponse(response=>response.url().endsWith('EmailNotificationService/SaveRepositoryEmailSubscription')&&response.status()===200);
  await page.getByRole('button',{name:'Save subscription',exact:true}).click();
  const receipt=await (await saved).json();
  check(receipt.target?.repositoryId===config.target.repositoryId&&receipt.target.ownerId===config.target.ownerId&&receipt.target.repository?.owner===config.target.repository.owner&&receipt.target.repository.name===config.target.repository.name&&receipt.subscription.version==='1'&&receipt.subscription.contactVersion==='1'&&receipt.subscription.enabled);
  await editor.waitFor({state:'detached'});
  await subscriptions.getByText('Enabled',{exact:true}).waitFor();
  stage='reload never dispatches '+theme;
  const written=writes();
  await page.reload();
  await subscriptions.waitFor();
  check(writes()===written);
  await setTheme(page,theme);
  check(await page.getByRole('form',{name:'Repository email subscription editor',exact:true}).count()===0);
  const administrator=await browser.newContext({viewport:{width:1440,height:1000}});
  contexts.push(administrator);
  await login(administrator,config.operator);
  const adminPage=await administrator.newPage();track(adminPage);
  for(const width of [1440,390]){
   stage='served email captures '+theme+' '+width;
  await page.setViewportSize({width,height:1000});
  await page.goto(config.golf+config.paths.account);
  await own.waitFor();
  await setTheme(page,theme);
  await page.reload();
  await own.waitFor();
  check(writes()===written);
  check(await page.getByLabel('Verification code',{exact:true}).count()===0);
  await capture(page,theme,width,'account');
   await page.goto(config.golf+config.paths.repository);
  await subscriptions.waitFor();
  await subscriptions.getByText('Enabled',{exact:true}).waitFor();
  await setTheme(page,theme);
  await capture(page,theme,width,'repository');
  check(writes()===written);
   await adminPage.setViewportSize({width,height:1000});
  await adminPage.goto(config.golf+config.paths.admin);
  const transports=adminPage.getByRole('table',{name:'SMTP transports',exact:true});
  await transports.getByText('Owned TLS SMTP',{exact:true}).waitFor();
  await setTheme(adminPage,theme);
  check(await adminPage.getByRole('form',{name:'SMTP transport editor',exact:true}).count()===0);
  await adminPage.getByRole('button',{name:'Edit SMTP Owned TLS SMTP version 1',exact:true}).click();
  const smtp=adminPage.getByRole('form',{name:'SMTP transport editor',exact:true});
  await smtp.waitFor();
  check(await adminPage.getByLabel('SMTP password (optional)',{exact:true}).count()===0);
  check(await adminPage.getByLabel('Current Golf administrator password',{exact:true}).inputValue()==='');
  await capture(adminPage,theme,width,'smtp-editor');
  await smtp.getByRole('button',{name:'Cancel',exact:true}).click();
  check(writes()===written);
  }
  stage='native read revocation clears unsent private settings '+theme;
  await page.goto(config.golf+config.paths.repository);
  await subscriptions.waitFor();
  await page.getByRole('button',{name:'Edit subscription',exact:true}).click();
  await editor.waitFor();
  const removal=await context.request.delete(config.native+'/api/v1/repos/'+config.repository+'/collaborators/'+actor.name,{headers:{Authorization:'token '+config.ownerToken}});
  check(removal.status()===204);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange',{bubbles:true})));
  await editor.waitFor({state:'detached',timeout:20000});
  check(await subscriptions.count()===0);
  check(await page.getByRole('table',{name:'Email deliveries',exact:true}).count()===0);
  check(writes()===written);proof['nativeReadRevocation_'+theme]=true;
  await persist();
 }
 check(captures.length===12&&!proof.pageErrors);
  proof.status='passed_cleanup_pending';
  proof.reloadNoDispatch=true;
  proof.currentUserVerification=true;
  proof.explicitConsent=true;
  proof.currentReadMemberSubscription=true;
  proof.procedureCounts=procedures;
  await persist();
  console.log('PASS: actual verification/consent/subscription/reload/native-revocation and twelve theme/width/view captures; codes withheld');
}catch(error){proof.status='failed';
  proof.failedStage=stage;
  proof.failureType=error.name==='TimeoutError'?'TimeoutError':'assertion/error';
  await persist();
  console.error('Email browser failed at '+stage+'; '+proof.failureType+'; private diagnostics withheld');process.exitCode=1;}
finally{
 const errors=[];for(const context of contexts){if(config)try{const response=await context.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Content-Type':'application/json','Connect-Protocol-Version':'1'},data:{}});
  check(response.status()===200);}catch{errors.push('managed logout');}try{await context.close();}catch{errors.push('context close');}}
 try{await browser?.close();}catch{errors.push('browser close');}proof.browserCleanup=errors.length?'failed':'passed';
  proof.browserCleanupFailures=errors;
  await persist();if(errors.length){console.error('Email browser cleanup failed; fixed categories recorded');process.exitCode=1;}
}
