// Parent owns fixture creation, native readback and private session cleanup.
import {mkdir,writeFile} from 'node:fs/promises';
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const sortedIds=(values,limit=100)=>Array.isArray(values)&&values.length<=limit&&values.every((v,i)=>decimal(v)&&v!=='0'&&(i===0||BigInt(values[i-1])<BigInt(v)));
const closed=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const selections=values=>Array.isArray(values)&&sortedIds(values.map(v=>v?.id))&&new Set(values.map(v=>v?.login?.toLowerCase?.())).size===values.length&&values.every(v=>closed(v,['id','login'])&&typeof v.login==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.login));
function singleMetadataField(value,field){
 if(!closed(value,['repository','repositoryId','issueId','number','expectedRevision','idempotencyKey','state',field])||!Object.hasOwn(value,field)||![undefined,0,'ISSUE_STATE_UNSPECIFIED'].includes(value.state))return false;
 const change=value[field];
 if(field==='assignees')return closed(change,['expectedAssigneeIds','assignees'])&&(!Object.hasOwn(change,'expectedAssigneeIds')||sortedIds(change.expectedAssigneeIds))&&(!Object.hasOwn(change,'assignees')||selections(change.assignees));
 if(field==='labels')return closed(change,['expectedLabelIds','labelIds'])&&(!Object.hasOwn(change,'expectedLabelIds')||sortedIds(change.expectedLabelIds,256))&&(!Object.hasOwn(change,'labelIds')||sortedIds(change.labelIds,256));
 return field==='milestone'&&closed(change,['expectedMilestoneId','milestoneId'])&&(!Object.hasOwn(change,'expectedMilestoneId')||decimal(change.expectedMilestoneId))&&(!Object.hasOwn(change,'milestoneId')||decimal(change.milestoneId));
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const idOrder=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
if(process.argv.includes('--self-check')){
 const valid=[['milestone',{milestone:{expectedMilestoneId:'1',milestoneId:'0'}}],['labels',{labels:{expectedLabelIds:['1'],labelIds:[]}}],['assignees',{assignees:{expectedAssigneeIds:['1'],assignees:[]}}],['assignees',{assignees:{}}],['assignees',{assignees:{expectedAssigneeIds:['2','9007199254740995'],assignees:[{id:'2',login:'first'},{id:'9007199254740995',login:'second'}]}}]];
 for(const [field,value]of valid)if(!singleMetadataField(value,field))throw Error('Valid metadata envelope refused');
 for(const [field,value]of valid)for(const mixed of ['title','body','labels','milestone','assignees'].filter(name=>name!==field))for(const extra of [null,'',{},[]])if(singleMetadataField({...value,[mixed]:extra},field))throw Error('Mixed metadata envelope accepted');
 for(const [field,key]of [['assignees','expectedAssigneeIds'],['assignees','assignees'],['labels','labelIds'],['labels','expectedLabelIds'],['milestone','milestoneId']])if(singleMetadataField({[field]:{[key]:null}},field))throw Error('Null field alias accepted');
 const labelMax={labels:{expectedLabelIds:[],labelIds:Array.from({length:256},(_,i)=>String(i+1))}};if(!singleMetadataField(labelMax,'labels')||singleMetadataField({labels:{labelIds:[...labelMax.labels.labelIds,'257']}},'labels'))throw Error('Label256 bound changed');
 if(singleMetadataField({assignees:{assignees:[{id:'1',login:'first'},{id:'2',login:'FIRST'}]}},'assignees'))throw Error('Duplicate login alias accepted');
 const base={assignees:{expectedAssigneeIds:['1'],assignees:[]}};
 for(const value of [{...base,title:''},{...base,body:null},{...base,state:'ISSUE_STATE_CLOSED'},{...base,labels:{}},{...base,milestone:{}},{...base,unknown:true},{assignees:null},{assignees:{expectedAssigneeIds:['01']}},{assignees:{expectedAssigneeIds:['2','1']}},{assignees:{expectedAssigneeIds:['1','1']}},{assignees:{assignees:[{id:'1',login:'first',avatarUrl:'extra'}]}},{assignees:{assignees:[{id:1,login:'first'}]}},{assignees:{assignees:[{id:'9223372036854775808',login:'first'}]}},{assignees:{assignees:Array.from({length:101},(_,i)=>({id:String(i+1),login:'first'}))}}])if(singleMetadataField(value,'assignees'))throw Error('Mixed or malformed mutation envelope accepted');
 console.log('PASS strict metadata-only envelopes, explicit empty assignees, sorted int64/100-user bounds; no browser or fixture writes');process.exit(0);
}
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)throw Error('Private configuration exceeds limit');}
const c=JSON.parse(input);input='';const target=new URL(c.url),origin=target.origin,field=c.assignees?'assignees':c.labels?'labels':'milestone';
if(c.assignees&&c.labels||!['localhost','127.0.0.1'].includes(target.hostname)||target.username||target.password||target.search||target.hash||!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/issues\/[1-9][0-9]*$/.test(target.pathname)||!c.cookies.length||!c.cookies.every(v=>v.httpOnly&&new URL(v.url).origin===origin))throw Error('Owned loopback fixture required');
const choices=c.assigneeChoices||[],choiceIds=choices.map(v=>v.id).sort(idOrder),originalIds=c.originalAssigneeIds||[];
if(c.assignees&&(!selections([...choices].sort((a,b)=>idOrder(a.id,b.id)))||!sortedIds(originalIds)||originalIds.length!==1||choices.length!==2||!choiceIds.includes(originalIds[0])))throw Error('Exact owned assignee choices required');
await mkdir(c.output,{mode:0o700});const report={passed:false,writes:[],captures:[],violations:[],field};let browser;
const check=(value,message)=>{if(!value)throw Error(message);};
try{
 const {chromium}=await import('../web/node_modules/playwright/index.mjs');
 browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:900},locale:'en-US',timezoneId:'America/New_York'});await context.addCookies(c.cookies);await context.addInitScript(()=>localStorage.setItem('golf.theme','dark'));const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.route('**/*',async route=>{
  try{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin){report.violations.push('external_request');return route.abort();}
   if(url.pathname.startsWith('/rpc/')){
    const method=url.pathname.split('/').at(-1);
    if(method==='UpdateIssue'){
     const v=request.postDataJSON();check(v.repositoryId===c.repositoryId&&v.issueId===c.issueId&&v.number===c.number&&closed(v.repository,['owner','name'])&&v.repository.owner===target.pathname.split('/')[1]&&v.repository.name===target.pathname.split('/')[2]&&singleMetadataField(v,field),'Exact owned single-field target required');check(report.writes.length<2,'Two owned metadata writes required');
     if(c.assignees){
      const expected=v.assignees.expectedAssigneeIds||[],selected=v.assignees.assignees||[],wanted=report.writes.length?[]:[...choices].sort((a,b)=>idOrder(a.id,b.id));
      check(equal(expected,report.writes.length?choiceIds:originalIds)&&equal(selected,wanted),'Exact observed assignee IDs/logins required');report.writes.push({key:v.idempotencyKey,expected,selected});
     }else if(c.labels){
      check(equal(v.labels.expectedLabelIds||[],report.writes.length?c.labelIds:[c.labelIds[0]])&&equal(v.labels.labelIds||[],report.writes.length?[]:c.labelIds),'Original observed labels required');report.writes.push({key:v.idempotencyKey,expected:v.labels.expectedLabelIds||[],selected:v.labels.labelIds||[]});
     }else{
      check((v.milestone.expectedMilestoneId||'0')===String(report.writes.length?c.selectedId:c.originalId)&&(v.milestone.milestoneId||'0')===String(report.writes.length?'0':c.selectedId),'Original observed milestone required');report.writes.push({key:v.idempotencyKey,expected:v.milestone.expectedMilestoneId||'0',selected:v.milestone.milestoneId||'0'});
     }
    }else if(!/^(Get|List|Watch|Inspect|Resolve)[A-Z][A-Za-z0-9]*$/.test(method)){report.violations.push('unexpected_write');return route.abort();}
   }else if(!['GET','HEAD'].includes(request.method())){report.violations.push('unexpected_http_write');return route.abort();}
   return route.continue();
  }catch{report.violations.push('request_guard');return route.abort();}
 });
 await page.goto(c.url,{waitUntil:'domcontentloaded'});
 for(const [theme,width]of [['dark',1440],['light',390]]){
  await page.setViewportSize({width,height:900});if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true}).click();
  const name=c.assignees?'Edit issue assignees':c.labels?'Edit issue labels':'Edit issue milestone';await page.getByRole('button',{name,exact:true}).click();const editor=page.getByRole('region',{name,exact:true});
  if(c.assignees){for(const user of choices){const checkbox=editor.getByRole('checkbox',{name:user.login,exact:true});if(theme==='dark')await checkbox.check();else await checkbox.uncheck();}}
  else if(c.labels){if(theme==='dark')await editor.getByRole('checkbox',{name:c.labelNames[1],exact:true}).check();else for(const label of c.labelNames)await editor.getByRole('checkbox',{name:label,exact:true}).uncheck();}
  else await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption(theme==='dark'?c.selectedId:'0');
  await page.evaluate(async()=>{await document.fonts.ready;scrollTo(0,0);});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No document overflow');const file=`${field}-editor-${theme}-${width}.png`;await page.screenshot({path:c.output+'/'+file,fullPage:true});report.captures.push(file);
  const response=page.waitForResponse(r=>r.url().endsWith('/UpdateIssue'));await editor.getByRole('button',{name:'Save changes',exact:true}).click();const r=await response;check(r.status()===200&&r.headers()['cache-control']==='no-store','Private successful RPC required');const value=await r.json();check(value.mutation.state==='ISSUE_MUTATION_STATE_SUCCEEDED'&&value.issue.id===c.issueId,'Exact native issue receipt required');
  const metadata=value.issue.metadata;
  if(c.assignees)check(metadata.assigneesKnown===true&&equal((metadata.assignees||[]).map(row=>row.id).sort(idOrder),theme==='dark'?choiceIds:[]),'Exact native assignee IDs required');
  else if(c.labels)check(metadata.labelsKnown===true&&equal((metadata.labels||[]).map(row=>row.id).sort(idOrder),theme==='dark'?c.labelIds:[]),'Exact native label IDs required');
  else check(metadata.milestoneKnown===true&&(metadata.milestone?.id||'0')===(theme==='dark'?c.selectedId:'0'),'Exact native milestone required');
  await editor.waitFor({state:'detached'});
 }
 check(report.writes.length===2&&report.violations.length===0,'Exactly two qualified writes');check(await page.evaluate(values=>values.every(v=>!document.documentElement.outerHTML.includes(v)&&!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(v)),[...c.forbidden,...c.cookies.map(v=>v.value)]),'No credentials persisted');report.passed=true;
}catch{process.exitCode=1;console.error('Metadata browser qualification failed; private details withheld.');}
finally{await browser?.close();await writeFile(c.output+'/manifest.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});}
if(!process.exitCode)console.log('PASS exact browser metadata change/clear and private desktop/mobile captures');
