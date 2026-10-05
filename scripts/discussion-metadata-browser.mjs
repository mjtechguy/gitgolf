// Actual owned native fixture, read-only browser qualification. Private config is stdin only.
// Parent creates the fixture, owns source/runtime identity and logs out the in-memory session.
import {mkdir,writeFile,chmod,lstat} from 'node:fs/promises';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const check=(value,code)=>{if(!value){const e=new Error('qualification assertion');e.code=code;throw e;}};
const permitted=name=>/^(Get|List|Watch|Inspect|Resolve)[A-Z][A-Za-z0-9]*$/.test(name||'');
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
function validate(c){
 const issue=new URL(c.issueUrl),pull=new URL(c.pullUrl);
 check(['http:','https:'].includes(issue.protocol)&&['localhost','127.0.0.1','[::1]'].includes(issue.hostname)&&issue.origin===pull.origin&&!issue.username&&!issue.password&&!pull.username&&!pull.password,'owned_loopback');
 check(/^\/[^/]+\/[^/]+\/issues\/[1-9][0-9]*$/.test(issue.pathname)&&/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(pull.pathname)&&issue.pathname.split('/').slice(1,3).join('/')===pull.pathname.split('/').slice(1,3).join('/'),'same_owned_repository');
 check(Array.isArray(c.cookies)&&c.cookies.length>0&&c.cookies.length<=4&&c.cookies.every(v=>text(v.name)&&text(v.value)&&v.httpOnly===true&&(v.url?new URL(v.url).origin===issue.origin:[issue.hostname,'.'+issue.hostname].includes(v.domain))),'session_cookie');
 check(Array.isArray(c.forbidden)&&c.forbidden.length>0&&c.forbidden.every(text)&&text(c.source)&&isAbsolute(c.output),'private_config');
 const e=c.expected;check(e&&[e.labelName,e.assigneeLogin,e.milestoneTitle].every(text)&&/^[a-f0-9]{6}$/i.test(e.labelColor)&&decimal(e.openIssues)&&decimal(e.closedIssues)&&typeof e.dueOn==='string'&&Number.isFinite(Date.parse(e.dueOn)),'expected_metadata');
 check(c.forbidden.every(v=>!c.source.includes(v)),'public_source');return issue.origin;
}
function metadata(v,e){
 check(v?.labelsKnown===true&&v.assigneesKnown===true&&v.milestoneKnown===true,'known_native_fields');
 const label=v.labels?.find(row=>row.name===e.labelName),assignee=v.assignees?.find(row=>row.login===e.assigneeLogin),milestone=v.milestone;
 check(label&&label.color.toLowerCase()===e.labelColor.toLowerCase()&&assignee&&milestone?.title===e.milestoneTitle,'native_expected_identity');
 check((milestone.openIssues||'0')===e.openIssues&&(milestone.closedIssues||'0')===e.closedIssues&&milestone.dueOn===e.dueOn,'native_expected_counts_due');return {labelDescription:label.description||'',milestoneDescription:milestone.description||''};
}
if(process.argv.includes('--self-check')){
 const e={labelName:'bug',labelColor:'Aa00ff',assigneeLogin:'owned',milestoneTitle:'v1',openIssues:'9007199254740995',closedIssues:'0',dueOn:'2026-12-01T00:00:00Z'},v={labelsKnown:true,assigneesKnown:true,milestoneKnown:true,labels:[{name:'bug',color:'aa00ff'}],assignees:[{login:'owned'}],milestone:{title:'v1',openIssues:e.openIssues,dueOn:e.dueOn}};metadata(v,e);
 for(const bad of [{labelsKnown:false},{assignees:[]},{milestone:{...v.milestone,openIssues:'9007199254740996'}},{labels:[{name:'bug',color:'url(secret)'}]}]){let refused=false;try{metadata({...v,...bad},e);}catch{refused=true;}check(refused,'negative_metadata');}
 check(permitted('GetIssue')&&permitted('WatchRepositoryEvents')&&!permitted('Get')&&!permitted('LoginWithPassword')&&!permitted('Logout')&&!permitted('SubmitIssueUpdate')&&!decimal('01')&&!decimal('9223372036854775808'),'read_only_bounds');
 console.log('PASS: pure exact metadata, integer and strict read-only guards; no browser or runtime operations.');process.exit(0);
}
let c,browser,context,page,origin,stage='stdin',outputReady=false;
const manifest={passed:false,complete:false,scope:'Actual owned private issue/PR metadata reads and list controls only; no writes, login/logout, fixture creation or deployment.',captures:[],listChecks:[],requestCounts:{},procedureStatusCounts:{},validationFailures:[]},pending=[],native={};
const record=e=>{manifest.validationFailures.push(/^[a-z_]{1,64}$/.test(e?.code||'')?e.code:'browser_runtime_error');};
try{
 let raw='';for await(const chunk of process.stdin){raw+=chunk;check(Buffer.byteLength(raw)<=65536,'stdin_bound');}c=JSON.parse(raw);raw='';
 check(typeof c.output==='string'&&isAbsolute(c.output),'output_path');await mkdir(c.output,{recursive:true,mode:0o700});const info=await lstat(c.output);check(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o077)===0,'private_output');outputReady=true;
 origin=validate(c);manifest.source=c.source;
 const {chromium}=await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),'../web/node_modules/playwright/index.mjs')).href);browser=await chromium.launch();
 for(const [theme,width]of [['dark',1440],['light',390]]){
  stage='context_'+theme+'_'+width;context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/New_York',locale:'en-US'});await context.addCookies(c.cookies);await context.addInitScript(v=>localStorage.setItem('golf.theme',v),theme);page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',()=>record({code:'page_error'}));
  await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.origin!==origin){record({code:'external_request'});await route.abort();return;}if(url.pathname.startsWith('/rpc/')){const method=url.pathname.split('/').at(-1);manifest.requestCounts[method]=(manifest.requestCounts[method]||0)+1;if(!permitted(method)){record({code:'unexpected_mutation'});await route.abort();return;}}else if(!['GET','HEAD'].includes(r.method())){record({code:'unexpected_http_write'});await route.abort();return;}await route.continue();});
  page.on('response',r=>{const url=new URL(r.url()),method=url.pathname.split('/').at(-1);if(!url.pathname.startsWith('/rpc/'))return;const key=method+':'+r.status();manifest.procedureStatusCounts[key]=(manifest.procedureStatusCounts[key]||0)+1;if(!['GetIssue','GetPullRequest'].includes(method))return;pending.push((async()=>{check(r.status()===200,'native_detail_http');const body=await r.json(),value=method==='GetIssue'?body.issue:body.pullRequest;native[method]=metadata(value?.metadata,c.expected);})().catch(record));});
  for(const [kind,url,method]of [['issue',c.issueUrl,'GetIssue'],['pull',c.pullUrl,'GetPullRequest']]){
   stage=kind+'_'+theme+'_'+width;await page.goto(url,{waitUntil:'domcontentloaded'});
   const sidebar=page.getByRole('complementary',{name:kind==='issue'?'Issue metadata':'Pull request metadata',exact:true}),view=sidebar.locator('.discussion-metadata');await view.waitFor();await Promise.all(pending);check(native[method]&&manifest.validationFailures.length===0,'real_metadata_read');
   const labels=view.getByRole('region',{name:'Labels',exact:true}),assignees=view.getByRole('region',{name:'Assignees',exact:true}),milestone=view.getByRole('region',{name:'Milestone',exact:true});
   const label=labels.locator('li').filter({has:page.getByText(c.expected.labelName,{exact:true})});check(await label.count()===1,'label_row');check((await label.locator('.discussion-label-swatch circle').getAttribute('fill')).toLowerCase()==='#'+c.expected.labelColor.toLowerCase(),'safe_label_color');check((await assignees.innerText()).includes(c.expected.assigneeLogin),'assignee_read');
   check((await milestone.locator('.discussion-milestone-title').innerText()).trim()===c.expected.milestoneTitle,'milestone_title');const counts=await milestone.locator('dd').allTextContents();check(counts.join('|')===[BigInt(c.expected.openIssues).toLocaleString(),BigInt(c.expected.closedIssues).toLocaleString()].join('|'),'exact_visible_counts');check(await milestone.locator('time').getAttribute('datetime')===c.expected.dueOn,'visible_due');check((await milestone.locator('time').innerText()).trim()===new Intl.DateTimeFormat('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(c.expected.dueOn)),'calendar_due_date');
   check(await view.locator('input,select,textarea,form,[style],a,img,script').count()===0,'no_unopened_metadata_forms_or_html');const buttons=await view.locator('button').count();const edits=await milestone.getByRole('button',{name:'Edit issue milestone',exact:true}).count()+await labels.getByRole('button',{name:'Edit issue labels',exact:true}).count()+await assignees.getByRole('button',{name:'Edit issue assignees',exact:true}).count();check(buttons===0||(kind==='issue'&&buttons<=3&&buttons===edits),'only_supported_metadata_controls');if(native[method].labelDescription)check(await label.getAttribute('title')===native[method].labelDescription,'plain_label_description');if(native[method].milestoneDescription)check(await milestone.locator('.discussion-milestone-details p').textContent()===native[method].milestoneDescription,'plain_milestone_description');
   await page.getByRole('button',{name:'Add a comment',exact:true}).waitFor();check(await page.locator(kind==='issue'?'#issue-detail-title':'#pull-detail-title').count()===1,'existing_title');if(kind==='pull')for(const name of ['Conversation','Commits','Checks','Files changed'])check(await page.getByRole('link',{name,exact:true}).count()>=1,'workspace_tabs');
   await page.evaluate(async()=>{await document.fonts.ready;scrollTo(0,0);});const metrics=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,fontLoaded:document.fonts.check('16px Archivo')}));check(metrics.documentWidth<=width&&metrics.viewportWidth===width&&metrics.fontLoaded&&await page.locator('html').getAttribute('data-theme')===theme,'layout_fonts');
   check(await page.evaluate(values=>{const dom=document.documentElement.outerHTML,storage=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]);return values.every(v=>!dom.includes(v)&&!storage.includes(v)&&!storage.includes(JSON.stringify(v).slice(1,-1)));},[...c.forbidden,...c.cookies.map(v=>v.value)]),'credentials_not_persisted');
   const file=`metadata-${kind}-${theme}-${width}.png`;await page.screenshot({path:join(c.output,file),fullPage:true});await chmod(join(c.output,file),0o600);manifest.captures.push({kind,theme,width,file,...metrics,knownSections:true,exactCounts:true,noFakeMetadataControls:true});
   if(theme==='dark'){
    stage=kind+'_loaded_list';await page.getByRole('link',{name:kind==='issue'?/^All (?:open |closed )?issues$/:/^All (?:open |closed )?pull requests$/}).click();const sort=page.getByRole('combobox',{name:'Sort loaded '+(kind==='issue'?'issues':'pull requests'),exact:true});await sort.waitFor();const values=await sort.locator('option').evaluateAll(rows=>rows.map(row=>row.value));check(['updated-newest','updated-oldest'].every(v=>values.includes(v)),'updated_sort_options');check(kind==='issue'?['most-commented','least-commented'].every(v=>values.includes(v)):!values.includes('most-commented'),'issue_only_comment_sort');await sort.selectOption('updated-newest');check(await sort.inputValue()==='updated-newest','loaded_sort_selection');await page.getByRole('searchbox',{name:'Search loaded '+(kind==='issue'?'issues':'pull requests'),exact:true}).waitFor();manifest.listChecks.push({kind,loadedScope:true,updatedSort:true,commentSort:kind==='issue'});
   }
  }
  await Promise.all(pending);check(manifest.validationFailures.length===0,'read_only_browser');await context.close();context=undefined;
 }
 check(manifest.captures.length===4&&manifest.listChecks.length===2,'coverage');manifest.passed=true;manifest.complete=true;
}catch(e){process.exitCode=1;manifest.failure={stage,code:/^[a-z_]{1,64}$/.test(e?.code||'')?e.code:'withheld',type:['TimeoutError','SyntaxError','TypeError'].includes(e?.name)?e.name:'assertion_or_runtime_error'};console.error('Discussion metadata browser failed at '+stage+'; private error details withheld.');}
finally{
 try{await context?.close();await browser?.close();}catch{process.exitCode=1;manifest.passed=false;manifest.complete=false;record({code:'browser_close_failed'});}
 await Promise.all(pending);if(manifest.validationFailures.length){manifest.passed=false;manifest.complete=false;process.exitCode=1;}
 if(outputReady)await writeFile(join(c.output,'browser-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
 if(!process.exitCode)console.log('PASS: actual owned issue/PR metadata, read-only list controls and four settled captures; parent session cleanup pending.');
}
