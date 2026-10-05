// Actual publication proof. Credentials and volatile text arrive on stdin only.
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const check=(v,code)=>{if(!v)throw Error(code);};
const hash=v=>createHash('sha256').update(v).digest('hex');
const submit='SubmitRepositoryReleasePublication',inspect='GetRepositoryReleasePublicationOperation';
const originalFields=['operationId','actorId','repository','repositoryId','ownerId','accessRevision','tagName','tagObjectId','commitId','titleSha256','bodySha256','prerelease'];
const receiptFields=[...originalFields,'contract','phase','releaseId','createdAt','updatedAt','failureCode'];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function original(c,v){
 check(v&&Object.keys(v).length===12&&Object.keys(v).every(k=>originalFields.includes(k))&&uuid(v.operationId),'original-shape');
 for(const key of ['repositoryId','ownerId','accessRevision','tagName','tagObjectId','commitId'])check(v[key]===c.intent[key],'original-binding');
 check(same(v.repository,c.intent.repository)&&v.actorId===c.actorId&&v.titleSha256===hash(c.intent.title)&&v.bodySha256===hash(c.intent.bodyMarkdown)&&v.prerelease===c.intent.prerelease,'original-content-binding');
}
function submitted(c,v){
 check(Object.keys(v).every(k=>['repository','repositoryId','ownerId','accessRevision','operationId','tagName','tagObjectId','commitId','title','bodyMarkdown','prerelease'].includes(k))&&uuid(v.operationId),'submit-shape');
 for(const key of ['repositoryId','ownerId','accessRevision','tagName','tagObjectId','commitId','title','bodyMarkdown'])check(v[key]===c.intent[key],'submit-binding');
 check(same(v.repository,c.intent.repository)&&Boolean(v.prerelease)===c.intent.prerelease,'submit-target');return v.operationId;
}
function receipt(c,v,id){
 check(v&&Object.keys(v).every(k=>receiptFields.includes(k))&&v.contract==='golf.repository.release-publication.v1'&&v.phase==='REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED'&&!v.failureCode&&/^[1-9][0-9]{0,18}$/.test(v.releaseId)&&BigInt(v.releaseId)<=9223372036854775807n,'receipt-shape');
 original(c,Object.fromEntries(originalFields.map(k=>[k,k==='prerelease'?Boolean(v[k]):v[k]])));check(v.operationId===id,'original-key');
 for(const key of ['createdAt','updatedAt'])check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v[key])&&!Number.isNaN(Date.parse(v[key])),'receipt-time');check(Date.parse(v.updatedAt)>=Date.parse(v.createdAt),'receipt-time-order');return v;
}
if(process.argv.includes('--self-check')){
 const c={actorId:'4',intent:{repository:{owner:'owned',name:'private'},repositoryId:'2',ownerId:'4',accessRevision:'b'.repeat(64),tagName:'owned-publication',tagObjectId:'a'.repeat(40),commitId:'a'.repeat(40),title:'Owned title',bodyMarkdown:'Literal "notes" café',prerelease:false}},id='12345678-1234-4234-8234-123456789abc',s={...c.intent,operationId:id};
 check(submitted(c,s)===id,'submit-positive');const o={...Object.fromEntries(originalFields.map(k=>[k,s[k]])),actorId:c.actorId,titleSha256:hash(s.title),bodySha256:hash(s.bodyMarkdown),prerelease:false};original(c,o);
 const r={...o,contract:'golf.repository.release-publication.v1',phase:'REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED',releaseId:'12',createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'};receipt(c,r,id);
 for(const v of [{...s,commitId:'c'.repeat(40)},{...s,title:'changed'},{...s,bodyMarkdown:'changed'},{...s,repository:{owner:'other',name:'private'}}]){let refused=false;try{submitted(c,v);}catch{refused=true;}check(refused,'changed-submit');}
 for(const v of [{...r,actorId:'5'},{...r,bodySha256:'c'.repeat(64)},{...r,phase:'REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN'},{...r,title:'private value'},{...r,releaseId:'9223372036854775808'},{...r,updatedAt:'2026-10-03T23:59:59Z'}]){let refused=false;try{receipt(c,v,id);}catch{refused=true;}check(refused,'changed-receipt');}
 console.log('PASS: pure publication browser submit/original/receipt guards; no resources');process.exit(0);
}
let input='';for await(const chunk of process.stdin){input+=chunk;check(Buffer.byteLength(input)<=65536,'config-bound');}
const c=JSON.parse(input),url=new URL(c.golf);check(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port&&/^[a-f0-9]{40}$/.test(c.sourceRevision)&&c.cookies.length===1&&Array.isArray(c.forbidden),'owned-config');
const {chromium}=await import(pathToFileURL(join(c.stackRoot,'web/node_modules/playwright/index.mjs')).href);
await mkdir(c.output,{mode:0o700});
const manifest={status:'running',passed:false,complete:false,scope:'One existing-tag publication, explicit original inspection and four receipt views; not atomic publication',sourceRevision:c.sourceRevision,captures:[]},requests=[],pending=[];
let browser,stage='launch',invalid=false,operationId='',observed;
try{
 browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies(c.cookies);await context.addInitScript(()=>localStorage.setItem('golf.theme','dark'));const page=await context.newPage();
 page.on('request',r=>{
  if(!r.url().startsWith(c.golf+'/rpc/'))return;const method=r.url().split('/').at(-1);requests.push(method);
  if(method===submit){try{operationId=submitted(c,JSON.parse(r.postData()??''));}catch{invalid=true;}}
  if(method===inspect){try{const v=JSON.parse(r.postData()??'');check(Object.keys(v).length===4&&Object.keys(v).every(k=>['repository','repositoryId','ownerId','operationId'].includes(k))&&same(v.repository,c.intent.repository)&&v.repositoryId===c.intent.repositoryId&&v.ownerId===c.intent.ownerId&&v.operationId===operationId,'inspect-binding');}catch{invalid=true;}}
 });
 page.on('response',r=>{
  const method=r.url().split('/').at(-1);if(![submit,inspect].includes(method))return;
  pending.push((async()=>{check(r.status()===200,'publication-http');const v=await r.json();check(Object.keys(v).length===1&&v.operation,'publication-response');const row=receipt(c,v.operation,operationId);if(observed)check(same(row,observed),'stable-original-receipt');else observed=row;})().catch(()=>{invalid=true;}));
 });
 const base=c.golf+'/'+encodeURIComponent(c.intent.repository.owner)+'/'+encodeURIComponent(c.intent.repository.name)+'/releases';
 stage='requested-existing-tag-editor';await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Releases',exact:true}).waitFor();await page.getByRole('button',{name:'New release',exact:true}).click();
 const editor=page.getByRole('region',{name:'Publish release',exact:true});await editor.waitFor();await editor.getByRole('table',{name:'Existing release tags',exact:true}).waitFor();await editor.getByRole('button',{name:'Select release tag '+c.intent.tagName,exact:true}).click();
 await editor.getByLabel('Release title',{exact:true}).fill(c.intent.title);await editor.getByLabel('Release notes, Markdown',{exact:true}).fill(c.intent.bodyMarkdown);await editor.getByLabel('Pre-release',{exact:true}).setChecked(c.intent.prerelease);await editor.getByRole('button',{name:'Review publication',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Publish release '+c.intent.tagName+'?',exact:true});await dialog.waitFor();await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Cancel');check(!requests.includes(submit),'no-submit-before-confirmation');
 stage='one-confirmed-publication';await dialog.getByRole('button',{name:'Confirm publish release',exact:true}).click();await page.getByText('Release publication confirmed.',{exact:true}).waitFor();await Promise.all(pending);check(!invalid&&observed&&requests.filter(v=>v===submit).length===1&&!requests.includes(inspect),'one-submit');
 const link=page.getByRole('link',{name:'Open published release',exact:true});await link.waitFor();check(await link.getAttribute('href')===new URL(base+'/'+observed.releaseId).pathname,'published-link');
 const key='golf.release-publication.v1:'+c.actorId+':'+c.intent.repositoryId;original(c,await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),key));
 stage='reload-no-original-lookup-or-resend';await page.reload({waitUntil:'domcontentloaded'});const button=page.getByRole('button',{name:'Inspect original publication',exact:true});await button.waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()==='Inspect original publication'&&!b.disabled));check(requests.filter(v=>v===submit).length===1&&!requests.includes(inspect),'reload-read-only');
 stage='explicit-original-inspection';await button.click();await page.getByText('Release publication confirmed.',{exact:true}).waitFor();await Promise.all(pending);check(!invalid&&requests.filter(v=>v===submit).length===1&&requests.filter(v=>v===inspect).length===1,'one-explicit-inspection');
 for(const width of [1440,390])for(const theme of ['dark','light']){
  stage='publication-receipt-'+theme+'-'+width;await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('golf.theme',theme);document.documentElement.dataset.theme=theme;},theme);await page.evaluate(()=>document.fonts.ready);check(await page.evaluate(()=>document.fonts.check('14px Archivo')),'font-loaded');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow');
  check(await page.evaluate(c=>{const body=document.body.innerText,storage=JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]),inputs=Array.from(document.querySelectorAll('input,textarea')).map(x=>x.value).join('\n');return c.forbidden.every(v=>!v||(!body.includes(v)&&!inputs.includes(v)&&!storage.includes(v)))&&[c.intent.title,c.intent.bodyMarkdown].every(v=>!storage.includes(v)&&!storage.includes(JSON.stringify(v).slice(1,-1)));},{forbidden:c.forbidden,intent:c.intent}),'private-values');
  original(c,await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),key));if(width===390)check((await button.boundingBox()).height>=44,'mobile-inspection-target');const file=`publication-original-${theme}-${width}.png`;await page.screenshot({path:join(c.output,file),fullPage:true});await chmod(join(c.output,file),0o600);manifest.captures.push({theme,width,file});
 }
 await Promise.all(pending);check(!invalid&&requests.filter(v=>v===submit).length===1&&requests.filter(v=>v===inspect).length===1&&requests.every(v=>v===submit||/^(Get|List|Watch|Inspect|Resolve)/.test(v)),'final-request-scope');
 manifest.operation=observed;manifest.status='qualified_bounded_release_publication_browser';manifest.passed=true;manifest.complete=true;manifest.submitCount=1;manifest.originalGetCount=1;manifest.reloadNoDispatchOrAutomaticInspection=true;manifest.privateCredentialsPersisted=false;manifest.titleAndNotesPersisted=false;await context.close();
}catch(error){manifest.status='failed';manifest.failure={stage,type:error.name};throw Error('Publication browser qualification failed; private details withheld');}
finally{if(browser)await browser.close();await writeFile(join(c.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});}
console.log('PASS: one actual publication and one explicit original inspection with four receipt captures');
