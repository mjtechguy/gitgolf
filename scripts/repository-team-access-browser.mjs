// Prepared actual disposable team-association proof; credentials only on stdin.
// No raw RPC bodies, native credentials or source data are written to diagnostics.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile, chmod } from 'node:fs/promises';
let config, browser, context, page, readerContext, stage = 'initialization';
const captures = [], requests = [], replies = [], errors = [], pending = [], counts = {}, statuses = {};
const methods = ['ListRepositoryTeamAccess', 'AttachRepositoryTeam', 'DetachRepositoryTeam'];
const rev = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function check(value) { if (!value) throw new Error('assertion'); }
function bound(body) { check(body.repositoryId === config.repositoryId && body.ownerId === config.ownerId && rev(body.accessRevision)); }
function fields(team) { return JSON.stringify([team.id, team.name, team.description || '', team.permission, Object.entries(team.unitPermissions || {}).sort(([a],[b]) => a.localeCompare(b)), team.includesAllRepositories || false, team.visibility]); }
async function nativeAssociation(wanted) {
  stage += ' · independent native association/config readback';
  const response = await context.request.get(config.gitea+'/api/v1/repos/'+config.repository+'/teams', { headers:{Authorization:'token '+config.ownerToken} });
  check(response.status() === 200 && !response.headers()['link']); const rows = await response.json(); check(Array.isArray(rows) && rows.length <= 500);
  check(rows.some(row => String(row.id) === config.teamId) === wanted);
  const selected = await context.request.get(config.gitea+'/api/v1/teams/'+config.teamId, { headers:{Authorization:'token '+config.ownerToken} }); check(selected.status() === 200);
  const team = await selected.json(); check(String(team.id) === config.teamId && String(team.organization.id) === config.ownerId && team.name === config.teamName && typeof team.includes_all_repositories === 'boolean' && !team.includes_all_repositories && typeof team.units_map === 'object' && team.units_map !== null);
  return JSON.stringify([team.id,team.name,team.description,team.permission,team.units_map,team.visibility,team.includes_all_repositories]);
}
async function capture(theme,width,state) {
  check(await page.locator('html').getAttribute('data-theme') === theme);check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const text = await page.locator('body').innerText();for(const value of [config.password,config.readerPassword,config.ownerToken])check(!text.includes(value));
  const id='team-access-'+theme+'-'+width+'-'+state;
  await page.screenshot({path:join(config.screenshots,id+'.png'),fullPage:true});await chmod(join(config.screenshots,id+'.png'),0o600);
  await writeFile(join(config.screenshots,id+'.txt'),text,{mode:0o600});
  captures.push({id,page:'Repository settings · Access · Organization teams',role:'ordinary-native-organization-owner',state,theme,viewport:{width,height:900},image:id+'.png',text:id+'.txt',result:'captured',caption:'Actual disposable shared inventory, requested association editor and independently verified attached state. Global team permissions/membership remain unchanged. Full Access, invites/custom roles and atomic native CAS remain open.'});
}
async function login(target,email,password) {
  await target.goto(config.golf);await target.getByLabel('Email or username',{exact:true}).fill(email);await target.getByLabel('Password',{exact:true}).fill(password);
  await target.getByRole('button',{name:'Sign in',exact:true}).click();await target.getByRole('form',{name:'Golf account sign-in',exact:true}).waitFor({state:'detached'});
}
const table = () => page.getByRole('table',{name:'Repository team access',exact:true});
const selectedRow = () => table().getByRole('row').filter({has:page.getByText(config.teamName,{exact:true})});
async function navigate() { await page.goto(config.golf+'/'+config.repository+'/settings/access');await table().waitFor();await selectedRow().waitFor();check(new URL(page.url()).pathname === '/'+config.repository+'/settings/access'); }
function latestRow() { const list = replies.filter(row => row.method === 'ListRepositoryTeamAccess').at(-1);check(list);const row=list.body.teams.find(row => row.team.id === config.teamId);check(row);return {list,row}; }
async function attach(theme,width,captureEditor=false) {
  stage='explicit attach editor · '+theme+' '+width;const oldConfig=await nativeAssociation(false);await Promise.all(pending);const frozen=latestRow();check(frozen.list.body.canManage && frozen.row.canAttach && !frozen.row.attached);
  await page.getByRole('button',{name:'Attach existing team',exact:true}).click();const form=page.getByRole('form',{name:'Attach existing organization team',exact:true});
  await form.getByLabel('Team',{exact:true}).selectOption(config.teamId);check(await form.getByLabel('Team',{exact:true}).evaluate(el=>el===document.activeElement));
  if(captureEditor)await capture(theme,width,'requested-attach-editor');
  const before=requests.filter(row=>row.method==='AttachRepositoryTeam').length;
  stage='submit attach once · '+theme+' '+width;
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/AttachRepositoryTeam'));
  await form.getByRole('button',{name:'Attach team',exact:true}).click();const response=await responsePromise;check(response.status()===200);const body=await response.json();bound(body);
  check(body.team.team.id===config.teamId && body.team.attached && body.team.revision!==frozen.row.revision && fields(body.team.team)===fields(frozen.row.team));
  stage='await verified attached inventory · '+theme+' '+width;await page.getByRole('status').filter({hasText:'Team attached.'}).waitFor();await form.waitFor({state:'detached'});await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).waitFor();await Promise.all(pending);
  check(requests.filter(row=>row.method==='AttachRepositoryTeam').length===before+1);const dispatched=requests.filter(row=>row.method==='AttachRepositoryTeam').at(-1).body;
  check(dispatched.expectedRevision===frozen.list.body.accessRevision && dispatched.expectedTeamRevision===frozen.row.revision);
  check(await nativeAssociation(true)===oldConfig);
  stage='attached reload · '+theme+' '+width;await page.reload();await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).waitFor();check(await page.getByRole('form',{name:'Attach existing organization team',exact:true}).count()===0);
}
async function detach(theme,width) {
  stage='detach confirmation · '+theme+' '+width;await Promise.all(pending);const frozen=latestRow();const oldConfig=await nativeAssociation(true);
  await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).click();let dialog=page.getByRole('dialog',{name:'Detach this team?',exact:true});await dialog.waitFor();check(await dialog.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement));
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});check(await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).evaluate(el=>el===document.activeElement));
  await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).click();dialog=page.getByRole('dialog',{name:'Detach this team?',exact:true});const before=requests.filter(row=>row.method==='DetachRepositoryTeam').length;
  stage='confirm detach once · '+theme+' '+width;const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/DetachRepositoryTeam'));await dialog.getByRole('button',{name:'Confirm detach team',exact:true}).click();const response=await responsePromise;check(response.status()===200);const body=await response.json();bound(body);
  check(body.team.team.id===config.teamId && !body.team.attached && body.team.revision!==frozen.row.revision && fields(body.team.team)===fields(frozen.row.team));
  stage='await verified detached inventory · '+theme+' '+width;await page.getByRole('status').filter({hasText:'Team detached.'}).waitFor();await dialog.waitFor({state:'detached'});await selectedRow().getByRole('button',{name:'Attach team '+config.teamName,exact:true}).waitFor();await Promise.all(pending);
  check(requests.filter(row=>row.method==='DetachRepositoryTeam').length===before+1);const dispatched=requests.filter(row=>row.method==='DetachRepositoryTeam').at(-1).body;check(dispatched.expectedRevision===frozen.list.body.accessRevision && dispatched.expectedTeamRevision===frozen.row.revision);
  check(await nativeAssociation(false)===oldConfig);stage='detached reload · '+theme+' '+width;await page.reload();await selectedRow().getByRole('button',{name:'Attach team '+config.teamName,exact:true}).waitFor();
}
try {
  let input='';for await(const chunk of process.stdin){input+=chunk;check(input.length<=65536);}config=JSON.parse(input);input='';
  check(config.repository.split('/').length===2 && /^[1-9][0-9]*$/.test(config.repositoryId) && /^[1-9][0-9]*$/.test(config.ownerId) && /^[1-9][0-9]*$/.test(config.teamId));
  const { chromium }=await import(pathToFileURL(join(config.stackRoot,'web/node_modules/playwright/index.mjs')));browser=await chromium.launch();context=await browser.newContext();page=await context.newPage();page.on('pageerror',()=>errors.push(true));
  page.on('request',request=>{const method=new URL(request.url()).pathname.split('/').at(-1);if(!methods.includes(method))return;counts[method]=(counts[method]||0)+1;try{const body=request.postDataJSON();check(body.repository.owner+'/'+body.repository.name===config.repository && body.repositoryId===config.repositoryId && body.ownerId===config.ownerId && rev(body.expectedRevision));if(method!=='ListRepositoryTeamAccess')check(body.teamId===config.teamId && rev(body.expectedTeamRevision));requests.push({method,body});}catch{errors.push(true);}});
  page.on('response',response=>{const method=new URL(response.url()).pathname.split('/').at(-1);if(!methods.includes(method))return;const key=method+':'+response.status();statuses[key]=(statuses[key]||0)+1;pending.push((async()=>{check(response.status()===200);const body=await response.json();bound(body);replies.push({method,body});})().catch(()=>errors.push(true)));});
  stage='managed ordinary organization-owner password sign-in';await login(page,config.email,config.password);
  for(const theme of ['dark','light'])for(const width of [1440,390]){
    stage='canonical Access inventory · '+theme+' '+width;await page.setViewportSize({width,height:900});await navigate();const toggle=page.getByRole('button',{name:'Switch to '+theme+' theme',exact:true});if(await toggle.count())await toggle.click();
    check(await page.getByRole('form',{name:'Attach existing organization team',exact:true}).count()===0);await capture(theme,width,'current-inventory');
    await attach(theme,width,true);await capture(theme,width,'verified-attached');await detach(theme,width);
  }
  stage='ordinary reader inventory has no association editors';readerContext=await browser.newContext();const readerPage=await readerContext.newPage();await login(readerPage,config.readerEmail,config.readerPassword);await readerPage.goto(config.golf+'/'+config.repository+'/settings/access');const readerTable=readerPage.getByRole('table',{name:'Repository team access',exact:true});await readerTable.waitFor();
  check(await readerPage.getByRole('button',{name:'Attach existing team',exact:true}).count()===0 && await readerTable.getByRole('button',{name:/^(Attach|Detach) team /}).count()===0 && await readerPage.getByRole('form',{name:'Attach existing organization team',exact:true}).count()===0);
  stage='accepted native effect with withheld browser acknowledgement';await navigate();await page.getByRole('button',{name:'Attach existing team',exact:true}).click();const form=page.getByRole('form',{name:'Attach existing organization team',exact:true});await form.getByLabel('Team',{exact:true}).selectOption(config.teamId);
  let intercepted=0;await page.route('**/rpc/golf.v1.RepositoryTeamAccessService/AttachRepositoryTeam',async route=>{intercepted++;check(intercepted===1);const response=await route.fetch();check(response.status()===200);const body=await response.json();bound(body);check(body.team.team.id===config.teamId && body.team.attached);await route.abort('failed');});
  const before=requests.filter(row=>row.method==='AttachRepositoryTeam').length;await form.getByRole('button',{name:'Attach team',exact:true}).click();await page.getByRole('heading',{name:'Team association change could not be confirmed',exact:true}).waitFor();await Promise.all(pending);check(intercepted===1 && requests.filter(row=>row.method==='AttachRepositoryTeam').length===before+1);
  check(await page.getByRole('button',{name:'Attach existing team',exact:true}).isDisabled());check(await page.getByRole('status').filter({hasText:'Team attached.'}).count()===0);await nativeAssociation(true);await page.unroute('**/rpc/golf.v1.RepositoryTeamAccessService/AttachRepositoryTeam');
  stage='independent inspection is not uncertain-write attribution or retry';await page.getByRole('button',{name:'Refresh organization team access',exact:true}).click();await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).waitFor();check(requests.filter(row=>row.method==='AttachRepositoryTeam').length===before+1 && await page.getByRole('status').filter({hasText:'Team attached.'}).count()===0);
  stage='uncertain effect reload remains read-only';await page.reload();await selectedRow().getByRole('button',{name:'Detach team '+config.teamName,exact:true}).waitFor();check(requests.filter(row=>row.method==='AttachRepositoryTeam').length===before+1);await detach('light',390);
  await Promise.all(pending);check(errors.length===0 && captures.length===12 && counts.AttachRepositoryTeam===5 && counts.DetachRepositoryTeam===5);
  await writeFile(join(config.screenshots,'browser-manifest.json'),JSON.stringify({status:'browser_checks_passed_parent_native_cleanup_pending',runtime:config.runtime,captureKind:'Actual12 dark/light1440/390 organization team inventories/requested editors/verified attached states; reader/no-edit and lost-acknowledgement inspection separately verified',requestCounts:counts,procedureStatusCounts:statuses,readerChecks:'passed',controlledLostAcknowledgement:'one_actual_accepted_write_browser_ack_withheld_no_retry',captures},null,2),{mode:0o600});
  console.log('PASS: actual repository-team12 captures,4 explicit attach/detach/reload cycles,reader inventory and1 accepted response-loss inspection without replay');
}catch(error){
  console.error('Team-access browser failed at '+stage+'; '+(error.name==='TimeoutError'?'TimeoutError':'assertion/error')+'; private diagnostics withheld');process.exitCode=1;
  if(config?.screenshots){let failureCapture;if(page&&!page.isClosed())try{let text=await page.locator('body').innerText();for(const value of [config.password,config.readerPassword,config.ownerToken].filter(Boolean))text=text.split(value).join('[redacted]');await page.screenshot({path:join(config.screenshots,'failure.png'),fullPage:true,mask:[page.locator('input,textarea,pre,code')],timeout:10000});await chmod(join(config.screenshots,'failure.png'),0o600);await writeFile(join(config.screenshots,'failure.txt'),text,{mode:0o600});failureCapture={stage,image:'failure.png',text:'failure.txt',result:'failed',caption:'Actual failure-only diagnostic; inputs/code masked, known fixture credentials redacted. Not qualification.'};}catch{}
    await writeFile(join(config.screenshots,'browser-manifest.json'),JSON.stringify({status:'failed',failedStage:stage,runtime:config.runtime,requestCounts:counts,procedureStatusCounts:statuses,validationOrPageErrorCount:errors.length,captures,failureCapture},null,2),{mode:0o600});}
}finally{
  for(const ctx of [readerContext,context])if(ctx&&config)try{const response=await ctx.request.post(config.golf+'/rpc/golf.v1.SessionService/Logout',{headers:{Origin:config.golf,'Connect-Protocol-Version':'1','Content-Type':'application/json'},data:{}});check(response.status()===200);}catch{console.error('Team-access browser logout failed');process.exitCode=1;}
  await browser?.close();
}
