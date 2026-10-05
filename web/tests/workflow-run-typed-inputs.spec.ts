import {expect,test,type Locator} from '@playwright/test';

// Read xterm's own screen-reader rows, excluding only blank viewport padding.
async function terminalText(log:Locator){
 const rows=await log.locator('.xterm-accessibility-tree [role="listitem"]').allTextContents();
 return rows.map(row=>row.replaceAll('\u00a0',' ').trimEnd()).join('\n').trim();
}
import {WorkflowRunState,WorkflowRunOrigin,WorkflowOutputState} from '../src/gen/golf/v1/golf_pb';
import {typedRunFixture,path,selectedPath,job,contract} from './workflow-run-typed-inputs-fixture';

test('typed manual run drills into exact job/step output, pagination, reload and safe receipt metadata',async({page})=>{
 const state=await typedRunFixture(page);await page.goto(path);
 await page.getByRole('link',{name:'succeeded Typed inputs inputs · 10s',exact:true}).click();
 await page.getByRole('link',{name:'succeeded Check literal input 10s',exact:true}).click();
 await expect(page).toHaveURL(/stepId=literal/);
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Literal input stayed literal.\nNumber and boolean input checks passed.');
 expect(state.filters.at(-1)).toEqual({job,step:'literal',after:'7'});
 await page.reload();await expect(page.getByRole('link',{name:'succeeded Check literal input 10s',exact:true})).toHaveAttribute('aria-current','page');
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Literal input stayed literal.\nNumber and boolean input checks passed.');
 await page.getByText('Execution receipt',{exact:true}).click();
 const receipt=page.getByLabel('Run summary');await expect(receipt).toContainText(contract);await expect(receipt).toContainText(state.schema);await expect(receipt).toContainText(state.submitted);await expect(receipt).toContainText(state.effective);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Literal input');
});
for(const status of [WorkflowRunState.QUEUED,WorkflowRunState.RUNNING,WorkflowRunState.SUCCEEDED])test(`typed run state ${status} keeps actual recorded-start semantics`,async({page})=>{
 const state=await typedRunFixture(page);state.status=status;await page.goto(selectedPath);
 if(status===WorkflowRunState.QUEUED){await expect(page.getByRole('status').filter({hasText:'has no recorded start or output'})).toBeVisible();expect(state.filters).toEqual([]);}
 else await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Literal input stayed literal.\nNumber and boolean input checks passed.');
 await expect(page.getByLabel('Jobs and steps')).toContainText('Typed inputs');
});
for(const bad of ['contract','schema','submitted','effective','push','withheld','v1-with-inputs','legacy-with-inputs'])test(`inconsistent ${bad} typed receipt is rejected before logs`,async({page})=>{
 const state=await typedRunFixture(page);
 if(bad==='contract')state.contract='';if(bad==='schema')state.schema='E'.repeat(64);if(bad==='submitted')state.submitted='';if(bad==='effective')state.effective='9'.repeat(63);
 if(bad==='push')state.origin=WorkflowRunOrigin.PUSH;if(bad==='withheld'){state.publication=WorkflowOutputState.WITHHELD;state.withheldBinding=false;}
 if(bad==='v1-with-inputs')state.catalog='golf.workflow.act.v0.2.89.linux.v1';if(bad==='legacy-with-inputs')state.catalog='golf.workflow.shell.v1';
 await page.goto(selectedPath);await expect(page.getByRole('alert')).toContainText('recorded job graph');expect(state.filters).toEqual([]);await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);
});
for(const bad of ['run','attempt','repository','source','job','step'])test(`typed ${bad} log mismatch cannot display private output`,async({page})=>{
 const state=await typedRunFixture(page);state.badReceipt=bad;await page.goto(selectedPath);
 await expect(page.getByRole('alert')).toContainText('log receipt does not match');await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});
for(const code of ['permission_denied','not_found','unauthenticated'] as const)test(`typed log ${code} clears current private run`,async({page})=>{
 const state=await typedRunFixture(page);await page.goto(selectedPath);await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Literal input stayed literal.\nNumber and boolean input checks passed.');
 state.logError=code;await page.getByRole('button',{name:'Refresh run log',exact:true}).click();
 if(code==='unauthenticated')await expect(page.getByRole('form',{name:'Golf account sign-in',exact:true})).toBeVisible();
 else await expect(page.getByRole('alert')).toHaveText('Typed run log unavailable.');
 await expect(page.getByLabel('Jobs and steps')).toHaveCount(0);await expect(page.getByLabel('Run summary')).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});
test('late typed log cannot restore output after parent authority denial',async({page})=>{
 const state=await typedRunFixture(page);let release!:()=>void;state.continuationBarrier=new Promise(resolve=>{release=resolve});await page.goto(selectedPath);
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe('Literal input stayed literal.');await expect.poll(()=>state.filters.some(filter=>filter.after==='7')).toBe(true);state.deny=true;await page.getByRole('button',{name:'Refresh selected run',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveText('Run access removed.');release();
 await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Run summary')).toHaveCount(0);
 expect(state.filters.every(filter=>filter.job===job&&filter.step==='literal'&&['0','7'].includes(filter.after))).toBe(true);
 const reads=state.filters.length;await page.waitForTimeout(250);expect(state.filters).toHaveLength(reads);expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('Literal input');
});
for(const theme of ['dark','light'])for(const width of [390,1440])test(`typed selected step ${theme}/${width} uses existing contained log workspace`,async({page})=>{
 await typedRunFixture(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto(selectedPath);
 await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
 // Native a11y rows preserve the terminal's real soft wrapping at 390px.
 const visibleText=width===390?'Literal input stayed literal.\nNumber and boolean input checks passe\nd.':'Literal input stayed literal.\nNumber and boolean input checks passed.';
 await expect.poll(()=>terminalText(page.getByLabel('Workflow run log',{exact:true}))).toBe(visibleText);
 if(width===390){const log=await page.getByLabel('Workflow run log',{exact:true}).boundingBox();expect(log!.y).toBeLessThan(700);await page.locator('.workflow-jobs-disclosure summary').click();}
 await expect(page.getByRole('link',{name:'succeeded Check literal input 10s',exact:true})).toBeVisible();
 await page.getByText('Execution receipt',{exact:true}).click();await expect(page.getByLabel('Run summary')).toContainText(contract);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a typed false-condition step remains skipped and never requests scoped output',async({page})=>{
 const state=await typedRunFixture(page);await page.goto(selectedPath.replace('stepId=literal','stepId=false-flag'));
 await expect(page.getByRole('status').filter({hasText:'has no recorded start or output'})).toBeVisible();
 await expect(page.getByRole('link',{name:'skipped False flag branch skipped',exact:true})).toHaveAttribute('aria-current','page');
 expect(state.filters).toEqual([]);
});
