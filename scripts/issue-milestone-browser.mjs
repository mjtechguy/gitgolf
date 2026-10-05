// Parent owns fixture creation, native readback and private session cleanup.
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../web/node_modules/playwright/index.mjs';
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)throw Error('Private configuration exceeds limit');}
const c=JSON.parse(input);input='';const origin=new URL(c.url).origin;
if(!['localhost','127.0.0.1'].includes(new URL(c.url).hostname)||!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/issues\/[1-9][0-9]*$/.test(new URL(c.url).pathname)||!c.cookies.every(v=>v.httpOnly&&new URL(v.url).origin===origin))throw Error('Owned loopback fixture required');
await mkdir(c.output,{mode:0o700});const report={passed:false,writes:[],captures:[],violations:[]};let browser;
const check=(value,message)=>{if(!value)throw Error(message);};
try{
 browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:900},locale:'en-US',timezoneId:'America/New_York'});await context.addCookies(c.cookies);await context.addInitScript(()=>localStorage.setItem('golf.theme','dark'));const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){report.violations.push('external_request');return route.abort();}
  if(url.pathname.startsWith('/rpc/')){const method=url.pathname.split('/').at(-1);if(method==='UpdateIssue'){const v=request.postDataJSON();check(v.repositoryId===c.repositoryId&&v.issueId===c.issueId&&v.number===c.number&&!v.title&&!v.body&&!v.state,'Exact owned single-field target required');check(report.writes.length<2&&v.milestone.expectedMilestoneId===String(report.writes.length?c.selectedId:c.originalId)&&v.milestone.milestoneId===String(report.writes.length?'0':c.selectedId),'Original observed milestone required');report.writes.push({key:v.idempotencyKey,expected:v.milestone.expectedMilestoneId,selected:v.milestone.milestoneId});}
   else if(!/^(Get|List|Watch|Inspect|Resolve)[A-Z]/.test(method)){report.violations.push('unexpected_write');return route.abort();}
  }else if(!['GET','HEAD'].includes(request.method())){report.violations.push('unexpected_http_write');return route.abort();}return route.continue();});
 await page.goto(c.url,{waitUntil:'domcontentloaded'});
 for(const [theme,width]of [['dark',1440],['light',390]]){
  await page.setViewportSize({width,height:900});if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true}).click();
  await page.getByRole('button',{name:'Edit issue milestone',exact:true}).click();const editor=page.getByRole('region',{name:'Edit issue milestone',exact:true});await editor.getByRole('combobox',{name:'Issue milestone',exact:true}).selectOption(theme==='dark'?c.selectedId:'0');
  await page.evaluate(()=>document.fonts.ready);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No document overflow');const file=`milestone-editor-${theme}-${width}.png`;await page.screenshot({path:c.output+'/'+file,fullPage:true});report.captures.push(file);
  const response=page.waitForResponse(r=>r.url().endsWith('/UpdateIssue'));await editor.getByRole('button',{name:'Save changes',exact:true}).click();const r=await response;check(r.status()===200&&r.headers()['cache-control']==='no-store','Private successful RPC required');const value=await r.json();check(value.mutation.state==='ISSUE_MUTATION_STATE_SUCCEEDED'&&value.issue.id===c.issueId&&value.issue.metadata.milestoneKnown===true&&(value.issue.metadata.milestone?.id||'0')===(theme==='dark'?c.selectedId:'0'),'Exact native assignment receipt required');await editor.waitFor({state:'detached'});
 }
 check(report.writes.length===2&&report.violations.length===0,'Exactly two qualified writes');check(await page.evaluate(values=>values.every(v=>!document.documentElement.outerHTML.includes(v)&&!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(v)),[...c.forbidden,...c.cookies.map(v=>v.value)]),'No credentials persisted');report.passed=true;
}catch{process.exitCode=1;console.error('Milestone browser qualification failed; private details withheld.');}
finally{await browser?.close();await writeFile(c.output+'/manifest.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});}
if(!process.exitCode)console.log('PASS exact browser milestone change/clear and private desktop/mobile captures');
