import { portableRuntimeFixture } from './runtime-fixture';
import {expect,test,type Page} from '@playwright/test';
import {respond,reject,disabledAgentTasks} from './rpc';
import {GetSessionResponseSchema,LogoutResponseSchema,ListCapabilitiesResponseSchema,ListRepositoriesResponseSchema,GetRepositoryResponseSchema,GetWorkflowRunResponseSchema,GetWorkflowRunLogsResponseSchema,GetWorkflowArtifactResponseSchema,WorkflowFormat,WorkflowRunState,WorkflowRunOrigin} from '../src/gen/golf/v1/golf_pb';

const id='12345678-1234-4234-8234-123456789abc',attempt='d'.repeat(32),commit='a'.repeat(40),url=`/alex/demo/actions/runs/${id}`;
async function backend(page:Page){
 const state={reads:0,writes:[] as string[],status:WorkflowRunState.SUCCEEDED,bad:'',denied:'' as ''|'permission_denied'|'unauthenticated',present:true,logged:true,held:undefined as Promise<void>|undefined};
 await page.route('**/rpc/**',async route=>{
  const method=new URL(route.request().url()).pathname.split('/').at(-1)!;
  if(method==='GetSession')return respond(route,GetSessionResponseSchema,{user:state.logged?{id:'42',login:'alex'}:undefined});
  if(method==='Logout'){state.logged=false;return respond(route,LogoutResponseSchema,{});}
  if(method==='ListCapabilities')return respond(route,ListCapabilitiesResponseSchema, portableRuntimeFixture);
  if(method==='ListRepositories')return respond(route,ListRepositoriesResponseSchema,{});
  if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'11',name:'demo',fullName:'alex/demo',defaultBranch:'main',private:true}});
  if(method==='ListAgentTasks')return disabledAgentTasks(route);
  if(method==='GetRepositoryStar')return reject(route,'unimplemented','Optional Star fixture unavailable.');
  if(method==='WatchRepository')return reject(route,'unimplemented','No source fixture stream.');
  if(method==='GetWorkflowRun')return respond(route,GetWorkflowRunResponseSchema,{run:{id,attemptId:attempt,repositoryId:'11',ownerId:'42',workflowPath:'.gitlab-ci.yml',workflowBlobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),commitId:commit,format:WorkflowFormat.GITLAB_CI,state:state.status,version:'3',createdAt:'2026-10-04T00:00:00Z',finishedAt:'2026-10-04T00:01:00Z',origin:WorkflowRunOrigin.MANUAL,engineCatalog:'golf.workflow.shell.v1'}});
  if(method==='GetWorkflowRunLogs')return respond(route,GetWorkflowRunLogsResponseSchema,{logs:[],runId:id,attemptId:attempt,repositoryId:'11',sourceCommitId:commit});
  if(method==='GetWorkflowArtifact'){
   state.reads++;if(state.held)await state.held;
   if(state.denied)return reject(route,state.denied,'Artifact access unavailable.');
   const artifact={runId:id,attemptId:attempt,repositoryId:'11',ownerId:'42',commitId:commit,workflowPath:'.gitlab-ci.yml',blobId:'b'.repeat(40),sourceSha256:'c'.repeat(64),archiveSha256:'e'.repeat(64),fileCount:2,fileBytes:'20',archiveBytes:'2048',createdAt:'2026-10-04T00:01:00Z',downloadPath:`/api/workflow-runs/${id}/artifact`};
   if(state.bad==='run')artifact.runId='87654321-1234-4234-8234-123456789abc';
   if(state.bad==='attempt')artifact.attemptId='f'.repeat(32);
   if(state.bad==='repo')artifact.repositoryId='12';
   if(state.bad==='owner')artifact.ownerId='43';
   if(state.bad==='source')artifact.sourceSha256='f'.repeat(64);
   if(state.bad==='url')artifact.downloadPath='https://foreign.invalid/private';
   if(state.bad==='count')artifact.fileBytes='020';
   return respond(route,GetWorkflowArtifactResponseSchema,{artifact:state.present?artifact:undefined});
  }
  if(!method.startsWith('Get')&&!method.startsWith('List'))state.writes.push(method);
  return reject(route,'not_found','No additional source fixture.');
 });return state;
}

test('successful artifact read exposes exact private attachment and reload never uploads',async({page})=>{
 const state=await backend(page);await page.goto(url);
 const link=page.getByRole('link',{name:'Download artifact',exact:true});await expect(link).toHaveAttribute('href',`/api/workflow-runs/${id}/artifact`);await expect(link).toHaveAttribute('download','build-artifacts.tar');
 await expect(page.getByRole('table',{name:'Build artifacts',exact:true})).toContainText('20 bytes');
 await page.getByText('Artifact receipt',{exact:true}).click();await expect(page.getByRole('region',{name:'Build artifacts',exact:true})).toContainText('Private attachment');
 const beforeReload=state.reads;await page.reload();await expect(link).toBeVisible();expect(state.reads).toBeGreaterThan(beforeReload);expect(state.reads).toBeLessThanOrEqual(beforeReload+2);expect(state.writes).toEqual([]);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('build-artifacts');
});

for(const bad of ['run','attempt','repo','owner','source','url','count'])test(`artifact ${bad} receipt fails closed`,async({page})=>{
 const state=await backend(page);state.bad=bad;await page.goto(url);await expect(page.getByRole('alert').filter({hasText:'artifact receipt could not be verified'})).toBeVisible();await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toHaveCount(0);expect(state.writes).toEqual([]);
});

test('non-success and absent results do not invent output',async({page})=>{
 const state=await backend(page);state.status=WorkflowRunState.LOST;await page.goto(url);await expect(page.getByRole('heading',{name:'.gitlab-ci.yml',exact:true})).toBeVisible();expect(state.reads).toBe(0);await expect(page.getByRole('region',{name:'Build artifacts',exact:true})).toHaveCount(0);
 state.status=WorkflowRunState.SUCCEEDED;state.present=false;await page.reload();await expect(page.getByText('No build artifact was recorded for this run.',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toHaveCount(0);
});

test('artifact authority denial clears the parent run and loaded logs',async({page})=>{
 const state=await backend(page);await page.goto(url);await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toBeVisible();state.denied='permission_denied';await page.getByRole('button',{name:'Refresh build artifact',exact:true}).click();await expect(page.getByRole('heading',{name:'.gitlab-ci.yml',exact:true})).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toHaveCount(0);
});

for(const theme of ['dark','light'])for(const width of [1440,390])test(`artifact shared inventory ${theme} ${width}`,async({page})=>{
 await backend(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto(url);await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toBeVisible();await page.evaluate(()=>document.fonts.ready);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('artifact 401 clears managed session and private run context',async({page})=>{
 const state=await backend(page);await page.goto(url);await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toBeVisible();state.denied='unauthenticated';await page.getByRole('button',{name:'Refresh build artifact',exact:true}).click();await expect(page.getByRole('form',{name:'Golf account sign-in'})).toBeVisible();await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toHaveCount(0);await expect(page.getByLabel('Workflow run log',{exact:true})).toHaveCount(0);
});

test('sign-out aborts a held artifact read and late data cannot restore a download',async({page})=>{
 const state=await backend(page);let release!:()=>void;state.held=new Promise(resolve=>{release=resolve;});await page.goto(url);await expect.poll(()=>state.reads).toBeGreaterThan(0);
 await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('form',{name:'Golf account sign-in'})).toBeVisible();release();
 await expect(page.getByRole('link',{name:'Download artifact',exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Build artifacts',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('build-artifacts');
});

for(const [width,theme] of [[1440,'dark'],[390,'light']] as const)test(`expanded artifact receipt uses shared padded metadata ${width} ${theme}`,async({page})=>{
 const state=await backend(page);await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto(url);
 const panel=page.getByRole('region',{name:'Build artifacts',exact:true});await expect(panel.getByRole('link',{name:'Download artifact',exact:true})).toBeVisible();await panel.getByText('Artifact receipt',{exact:true}).click();
 const receipt=panel.locator('details');await expect(receipt).toHaveAttribute('open','');await expect(receipt.locator('dt')).toHaveText(['Archive SHA-256','Attempt','Delivery']);await expect(receipt.locator('dd code')).toHaveText(['e'.repeat(64),attempt]);await page.evaluate(()=>document.fonts.ready);
 const metrics=await panel.evaluate(panel=>{const receipt=panel.querySelector('details')!,summary=receipt.querySelector('summary')!,label=receipt.querySelector('dt')!,value=receipt.querySelector('dd')!,box=panel.getBoundingClientRect();return{summaryInset:summary.getBoundingClientRect().left-box.left,labelInset:label.getBoundingClientRect().left-box.left,valueInset:box.right-value.getBoundingClientRect().right,columns:getComputedStyle(receipt.querySelector('dl')!).gridTemplateColumns.split(' ').length,overflow:document.documentElement.scrollWidth>innerWidth,font:document.fonts.check('14px Archivo')};});
 expect(metrics.summaryInset).toBeGreaterThanOrEqual(12);expect(metrics.labelInset).toBeGreaterThanOrEqual(12);expect(metrics.valueInset).toBeGreaterThanOrEqual(12);expect(metrics.columns).toBe(width===390?1:2);expect(metrics.overflow).toBe(false);expect(metrics.font).toBe(true);expect(state.writes).toEqual([]);
});
