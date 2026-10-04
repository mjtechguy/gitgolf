import { disabledAgentTasks, disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ActionRunKind, ListActionRunsRequestSchema, ListActionRunsResponseSchema, DispatchWorkflowRequestSchema, DispatchWorkflowResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetRepositorySettingsResponseSchema, GetSessionResponseSchema, GetReviewerResponseSchema, ListReviewerRunsResponseSchema, GetRepositoryResponseSchema, InspectWorkflowsRequestSchema, InspectWorkflowsResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ExecutionScope, ExecutionMode, GetExecutionPolicyResponseSchema, WorkflowRunOrigin, WorkflowRunState, GetWorkflowDispatchRequestSchema, GetWorkflowDispatchResponseSchema, WorkflowConfigurationSchema, WorkflowFormat, WorkflowInspectionState } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const path = '/repositories/alex/private/settings/workflows';
const commit = 'a'.repeat(40);
const manual = create(WorkflowConfigurationSchema, { path: '.github/workflows/manual.yml', blobId: 'b'.repeat(40), byteSize: 123n, format: WorkflowFormat.GITHUB_ACTIONS, state: WorkflowInspectionState.VALIDATED_SUBSET, name: '<literal-workflow>', events: ['workflow_dispatch'], jobs: [{ id: 'check', name: '<img src=x onerror=alert(1)>', stepCount: 1 }] });
function completeRun(ref:string,file:string){return {id:'12345678-1234-4234-8234-123456789012',repositoryId:'9007199254740997',ownerId:'9007199254740993',commitId:ref,workflowPath:file,workflowBlobId:'b'.repeat(40),state:WorkflowRunState.QUEUED,origin:WorkflowRunOrigin.MANUAL,eventRef:'',sourceSha256:'d'.repeat(64),version:'1',createdAt:'2026-10-01T12:00:00Z',canCancel:false};}
async function backend(page: Page) {
  const state = { mode: 'ready', worker: false, policyKnown: true, manualPolicy: false, pushPolicy: false, badPolicyRevision: false, badTarget: false, dispatchLost: false, inspectBarrier: undefined as Promise<void>|undefined, inspectMode: 'ready', permission: 'write', badOwner:false, badReceipt:'', actor:'9007199254740993', signedRun: undefined as ReturnType<typeof completeRun>|undefined, writes: [] as ReturnType<typeof request<typeof DispatchWorkflowRequestSchema>>[], inspections: [] as ReturnType<typeof request<typeof GetWorkflowDispatchRequestSchema>>[], badMetadata: false, missingMetadata: false, signedIn: true, barrier: undefined as Promise<void> | undefined, requests: [] as unknown[], runPages: false, matchingRuns: false, methods: [] as string[], denyRuns: false, requestedRunPages: [] as number[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1); state.methods.push(method||'');
 if(method === 'ListAgentTasks') return disabledAgentTasks(route);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if(method==='Logout'){state.signedIn=false;return respond(route,LogoutResponseSchema,{});}
    if(method==='LoginWithPassword'){state.signedIn=true;return respond(route,LoginWithPasswordResponseSchema,{user:{id:state.actor,login:'alex'}});}
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if(method==='GetReviewer')return respond(route,GetReviewerResponseSchema,{executionAvailable:false});
    if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
    if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'9007199254740997',name:state.missingMetadata?'':state.badMetadata?'other':'private',fullName:state.missingMetadata?'':'alex/private',defaultBranch:'main',private:true}});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: state.actor, login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '9007199254740997', ownerId: state.badOwner?'18':'9007199254740993', currentPermission: state.permission } });
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: { repositoryId: '9007199254740997', ownerId: '9007199254740993', canEdit: false } });
    if (method === 'GetExecutionPolicy') return respond(route, GetExecutionPolicyResponseSchema, { policy: { scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', ownerId: '9007199254740993', mode: ExecutionMode.DISABLED, revision: '0', revocationEpoch: '0', authorityRevision: 'd'.repeat(64) } });
    if (method === 'ListActionRuns') {
      const input=request(route,ListActionRunsRequestSchema),current=input.cursor?2:1;state.requestedRunPages.push(current);
      if(state.denyRuns)return reject(route,'permission_denied','Workflow runs require repository read access.');
      let runs=state.runPages?Array.from({length:current===1?20:1},(_,index)=>({ref:{kind:ActionRunKind.WORKFLOW,id:`12345678-1234-4234-8234-${(current*100+index).toString(16).padStart(12,'0')}`},repositoryId:'9007199254740997',ownerId:'9007199254740993',title:state.matchingRuns&&index===0?manual.path:current===2?'.github/workflows/later.yml':`.github/workflows/job-${index}.yml`,workflowPath:state.matchingRuns&&index===0?manual.path:current===2?'.github/workflows/later.yml':`.github/workflows/job-${index}.yml`,state:'succeeded',trigger:index===0?'push':'manual',commitId:commit,createdAt:'2026-10-01T12:00:00Z'})):[];
      if(input.workflowPath)runs=runs.filter(run=>run.workflowPath===input.workflowPath);
      return respond(route,ListActionRunsResponseSchema,{repositoryId:'9007199254740997',runs,nextCursor:state.runPages&&current===1?'page-two':''});
    }
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if(method==='DispatchWorkflow') { const input=request(route,DispatchWorkflowRequestSchema);state.writes.push(input);state.signedRun=completeRun(input.ref,input.workflowPath);if(state.dispatchLost)return reject(route,'unavailable','Dispatch acknowledgement unavailable.');return respond(route,DispatchWorkflowResponseSchema,{run:state.badReceipt==='dispatch-head'?{...state.signedRun,commitId:'f'.repeat(40)}:state.signedRun}); }
    if(method==='GetWorkflowDispatch'){
     const input=request(route,GetWorkflowDispatchRequestSchema);state.inspections.push(input);if(state.inspectBarrier)await state.inspectBarrier;
     if(state.inspectMode==='missing')return reject(route,'not_found','Original receipt missing.');if(state.inspectMode==='denied')return reject(route,'permission_denied','Current workflow authority was revoked.');
     const run=state.signedRun||completeRun(input.commitId,input.workflowPath);
     return respond(route,GetWorkflowDispatchResponseSchema,{repository:state.badReceipt==='route'?{owner:'other',name:'private'}:input.repository,repositoryId:state.badReceipt==='repository'?'18':input.repositoryId,ownerId:state.badReceipt==='owner'?'18':input.ownerId,nativeActorId:state.badReceipt==='actor'?'18':state.actor,idempotencyKey:state.badReceipt==='key'?'12345678-1234-4234-8234-123456789099':input.idempotencyKey,run:{...run,canCancel:state.badReceipt==='cancel',commitId:state.badReceipt==='head'?'f'.repeat(40):run.commitId,workflowBlobId:state.badReceipt==='blob'?'f'.repeat(40):run.workflowBlobId,workflowPath:state.badReceipt==='path'?'.github/workflows/other.yml':run.workflowPath,origin:state.badReceipt==='origin'?WorkflowRunOrigin.PUSH:WorkflowRunOrigin.MANUAL,eventRef:state.badReceipt==='event-ref'?input.commitId:'',sourceSha256:state.badReceipt==='digest'?'invalid':run.sourceSha256,version:state.badReceipt==='version'?'01':run.version}});
    }
    if (method === 'InspectWorkflows') {
      state.requests.push(request(route, InspectWorkflowsRequestSchema));
      if (state.barrier) await state.barrier;
      if (state.mode === 'denied') return reject(route, 'permission_denied', 'Workflow inspection requires repository read access.');
      if (state.mode === 'expired') { state.signedIn = false; return reject(route, 'unauthenticated', 'Your session ended.'); }
      if (state.mode === 'overfull') return reject(route, 'resource_exhausted', 'Workflow configuration inventory exceeds its bound.');
      return respond(route, InspectWorkflowsResponseSchema, { repositoryId: state.badTarget?'18':'9007199254740997', commitId: commit, catalogVersion: 'golf.workflow.inspect.v2', executionAvailable: state.worker, policyRevision: state.policyKnown?(state.badPolicyRevision?'not-a-revision':'e'.repeat(64)):'', configurations: (state.mode === 'empty' ? [] : [state.mode === 'push' ? { ...manual, events: ['push'] } : manual, { path: '.gitlab-ci.yml', blobId: 'c'.repeat(40), byteSize: 321n, format: WorkflowFormat.GITLAB_CI, state: WorkflowInspectionState.UNSUPPORTED, jobs: [{ id: 'build', stage: 'test', stepCount: 1 }], diagnostics: [{ code: 'unsupported_field', message: 'Remote includes are not fetched.', line: 3, column: 2 }] }]).map(item=>({...item,manualPolicyAllowed:state.policyKnown?state.manualPolicy:undefined,pushPolicyAllowed:state.policyKnown?state.pushPolicy:undefined})) });
    }
    return reject(route, 'not_found', 'Unsupported workflow fixture.');
  });
  return state;
}
async function open(page: Page) {
  await page.goto(path);
  await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(2);
}

test('workflow inventory pins source links, exposes keyboard details and renders metadata literally', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const state = await backend(page); await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Manual execution requires every applicable execution policy', { exact: false })).toBeVisible();
  await expect(page.getByText('Inspection subset checked', { exact: true })).toBeVisible();
  const source = page.getByRole('link', { name: manual.path, exact: true });
  const url = new URL((await source.getAttribute('href'))!, page.url());
  expect(url.origin).toBe(new URL(page.url()).origin);
  expect(url.pathname).toBe(`/alex/private/tree/${commit}/${manual.path}`);
  expect(url.searchParams.has('ref')).toBe(false);
  const details = page.locator('summary').filter({ hasText: `Inspect ${manual.path}` });
  await details.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true }).locator('img')).toHaveCount(0);
  await page.locator('summary').filter({ hasText: 'Inspect .gitlab-ci.yml' }).click();
  await expect(page.getByText('Line 3:2 ·', { exact: true })).toBeVisible();
  await expect(page.getByText('Remote includes are not fetched.', { exact: false })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search loaded Workflow configurations', exact: true });
  await search.fill('GitLab CI'); await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(1);
  await search.fill(''); await page.screenshot({ path: testInfo.outputPath('workflow-dark.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Workflow configuration', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workflow-mobile.png'), fullPage: true });
  expect(state.requests.every(input => JSON.stringify(input).includes('"owner":"alex","name":"private"'))).toBe(true);
  expect(state.requests.every(input => (input as { ref: string }).ref === '')).toBe(true);
  expect(state.requests.every(input => (input as { repositoryId:string }).repositoryId==='9007199254740997')).toBe(true);
});

test('workflow refresh clears prior private rows while waiting and after provider denial or expiry', async ({ page }) => {
  const state = await backend(page); await open(page);
  let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; });
  state.mode = 'denied'; await page.getByRole('button', { name: 'Refresh workflow inspection', exact: true }).click();
  await expect(page.getByText('Inspecting workflow configuration…', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: manual.path, exact: true })).toHaveCount(0);
  release(); state.barrier = undefined;
  await expect(page.getByRole('alert')).toHaveText('Workflow inspection requires repository read access.');
  await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true })).toHaveCount(0);
  state.mode = 'ready'; await page.getByRole('button', { name: 'Refresh workflow inspection', exact: true }).click();
  await expect(page.getByRole('link', { name: manual.path, exact: true })).toBeVisible();
  state.mode = 'expired'; await page.getByRole('button', { name: 'Refresh workflow inspection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Workflow configurations', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('literal-workflow');
});

test('empty workflow inventory and bounded refusal remain distinct without fake execution controls', async ({ page }) => {
  const state = await backend(page); state.mode = 'empty'; await page.goto(path);
  await expect(page.getByText('No matching workflow configuration files at this commit.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Run|Execute|Enable workflow)/ })).toHaveCount(0);
  state.mode = 'overfull'; await page.getByRole('button', { name: 'Refresh workflow inspection', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Workflow configuration inventory exceeds its bound.');
  await expect(page.getByText('No matching workflow configuration files at this commit.', { exact: true })).toHaveCount(0);
});


test('run inventory loads the next server page and clears private rows on denial', async ({ page }) => {
  const state = await backend(page); state.runPages = true; await page.goto('/alex/private/actions');
  const table = page.getByRole('table', { name: 'Action runs', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
  await expect(table.getByRole('columnheader', { name: 'Run', exact: false })).toBeVisible();
  await expect(table.locator('.workflow-run-row small').filter({hasText:/push ·/})).toHaveCount(1);
  await expect(table.locator('.workflow-run-row small').filter({hasText:/manual ·/})).toHaveCount(19);
  await page.getByRole('button', { name: 'Load more action runs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more action runs', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search loaded Action runs', exact: true }).fill('later.yml');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  await expect(table).toContainText('.github/workflows/later.yml');
  expect(state.requestedRunPages.filter(value => value === 2)).toEqual([2]);
  expect(state.requestedRunPages.every(value => value === 1 || value === 2)).toBe(true);
  state.denyRuns = true; await page.getByRole('button', { name: 'Refresh runs', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Workflow runs require repository read access.');
  await expect(table).toHaveCount(0);
});

// A checked push file cannot be presented as a runnable manual workflow.
test('push-only inspection hides the manual Run action', async ({ page }) => {
  const state = await backend(page); await open(page);
  state.mode = 'push';
  await page.getByRole('button', { name: 'Refresh workflow inspection', exact: true }).click();
  await expect(page.getByText('Push trigger only', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run workflow', exact: true })).toHaveCount(0);
});


test('Actions is a repository work tab with direct run inventory and configuration links', async({page})=>{
 const state=await backend(page);state.runPages=true;
 await page.goto('/repositories/alex/private?view=actions');
 await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Actions');
 await expect(page.getByRole('heading',{name:'Actions',exact:true})).toBeVisible();
 await expect(page.getByRole('table',{name:'Action runs',exact:true})).toBeVisible();
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeHidden();
 await expect(page.getByRole('navigation',{name:'Workflow navigation'})).toBeVisible();
 await page.getByText('Execution details and configuration',{exact:true}).click();
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeVisible();
 await expect(page.locator('.settings-navigation')).toHaveCount(0);
 await page.reload();await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Actions');
});

for(const theme of ['dark','light'])for(const width of [1440,390])test(`Actions ${theme}/${width} defaults to runs and filters server history without eager coding tasks`,async({page},testInfo)=>{
 const s=await backend(page);s.runPages=true;s.matchingRuns=true;await page.setViewportSize({width,height:1000});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto('/alex/private/actions?ref='+commit+'&branch=older-context');
 const table=page.getByRole('table',{name:'Action runs',exact:true});await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
 if(width===390){await expect(page.getByRole('combobox',{name:'Run type',exact:true})).toBeVisible();expect((await table.boundingBox())!.y).toBeLessThan(700);}
 const navigation=page.getByRole('navigation',{name:'Workflow navigation'});await expect(page.getByRole('link',{name:'All runs',exact:true,includeHidden:true})).toHaveAttribute('aria-current','page');
 expect(s.methods).not.toContain('ListAgentTasks');await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeHidden();
 await page.getByText('Execution details and configuration',{exact:true}).click();
 await expect(page.getByText('Current default-branch configurations at',{exact:false})).toBeVisible();
 await expect(page.getByText('Workflow worker execution is unavailable.',{exact:false})).toBeVisible();
 await page.getByText('Execution details and configuration',{exact:true}).click();
 const select=navigation.getByRole('link',{name:'Show runs for '+manual.path,exact:true,includeHidden:width===390});
 if(width===390){await page.getByRole('combobox',{name:'Workflow',exact:true}).selectOption(manual.path);await expect(page.getByRole('combobox',{name:'Run type',exact:true})).toHaveValue('workflow');}else{await select.focus();await page.keyboard.press('Enter');}
 if(width===390)await expect(page.getByRole('combobox',{name:'Workflow',exact:true})).toHaveValue(manual.path);else await expect(select).toHaveAttribute('aria-current','page');await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);await expect(table).toContainText(manual.path);
 await page.getByText('History visibility',{exact:true}).click();await expect(page.getByText('Private coding tasks require your ownership and current repository write access.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Load more action runs'}).click();await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(2);expect(s.requestedRunPages.filter(p=>p===2)).toEqual([2]);
 if(width===390)await page.getByRole('combobox',{name:'Run type',exact:true}).selectOption('');else await page.getByRole('link',{name:'All runs',exact:true}).click();await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
 await page.getByText('Execution details and configuration',{exact:true}).click();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'New coding task',exact:true}).click();await expect.poll(()=>s.methods.filter(m=>m==='ListAgentTasks').length).toBeGreaterThan(0);
 expect(s.methods.some(m=>/^(Dispatch|Update|Cancel)/.test(m))).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('actions-workflow-filter.png'),fullPage:true});
});

for(const [known,manualAllowed,pushAllowed,badRevision,expected] of [[true,false,true,false,'Ceilings deny'],[false,false,false,false,'Unknown'],[true,true,false,true,'Unknown'],[true,true,false,false,'Ceilings allow']] as const)test(`manual controls honor independent observed ceilings ${known}/${manualAllowed}/${pushAllowed}/${badRevision}`,async({page})=>{
 const s=await backend(page);s.worker=true;s.policyKnown=known;s.manualPolicy=manualAllowed;s.pushPolicy=pushAllowed;s.badPolicyRevision=badRevision;await open(page);
 const row=page.getByRole('table',{name:'Workflow configurations',exact:true}).locator('tbody tr[data-row-id]').filter({has:page.getByRole('link',{name:manual.path,exact:true})});
 await expect(row).toContainText('Manual: '+expected);await expect(row).toContainText('Automatic push: '+(!known||badRevision?'Unknown':pushAllowed?'Ceilings allow':'Ceilings deny'));
 const button=row.getByRole('button',{name:'Run workflow',exact:true});if(known&&manualAllowed&&!badRevision)await expect(button).toBeEnabled();else await expect(button).toBeDisabled();
 expect(s.methods).not.toContain('DispatchWorkflow');
});

test('Actions refuses a wrong native repository inspection receipt before rendering private workflow metadata',async({page})=>{
 const s=await backend(page);s.badTarget=true;await page.goto('/alex/private/actions');
 await expect(page.getByRole('alert')).toHaveText('Workflow inspection does not match the selected repository.');
 await expect(page.getByRole('link',{name:'Show runs for '+manual.path,exact:true})).toHaveCount(0);await expect(page.getByText('<literal-workflow>',{exact:true})).toHaveCount(0);expect(s.methods).not.toContain('DispatchWorkflow');
});


for(const missing of [false,true])test(`settings workflow inspection refuses ${missing?'missing':'mismatched'} repository metadata before protected inspection`, async ({page})=>{
 const state=await backend(page);state.badMetadata=!missing;state.missingMetadata=missing;await page.goto(path);
 await expect(page.getByRole('alert')).toHaveText('Repository identity could not be verified for workflow inspection.');
 expect(state.methods).toContain('GetRepository');expect(state.requests).toHaveLength(0);
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:manual.path,exact:true})).toHaveCount(0);
 expect(state.methods.some(method=>/^(Dispatch|Update|Create)/.test(method))).toBe(false);
});

for(const mode of ['manual','denied','unknown','push'] as const)test(`selected workflow exposes only a guarded manual action (${mode})`,async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=mode==='manual';s.pushPolicy=true;s.policyKnown=mode!=='unknown';if(mode==='push')s.mode='push';
 await page.setViewportSize({width:390,height:844});await page.goto('/alex/private/actions');
 await expect(page.getByRole('link',{name:'All runs',exact:true,includeHidden:true})).toHaveAttribute('aria-current','page');await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeHidden();
 await page.getByRole('combobox',{name:'Workflow',exact:true}).selectOption(manual.path);
 const action=page.locator('.workflow-selected-heading').getByRole('button',{name:'Run workflow',exact:true});
 if(mode==='manual'){await expect(action).toBeEnabled();await action.click();await expect(page.getByRole('status').filter({hasText:'Run 12345678-1234-4234-8234-123456789012 recorded.'})).toBeVisible();expect(s.methods.filter(m=>m==='DispatchWorkflow')).toHaveLength(1);let release!:()=>void;s.barrier=new Promise<void>(resolve=>release=resolve);s.mode='denied';await page.getByText('Execution details and configuration',{exact:true}).click();await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Run 12345678-1234-4234-8234-123456789012 recorded.'})).toHaveCount(0);release();s.barrier=undefined;await expect(page.getByRole('alert').filter({hasText:'Workflow inspection requires repository read access.'}).first()).toBeVisible();await expect(page.getByText('12345678-1234-4234-8234-123456789012',{exact:false})).toHaveCount(0);}
 else if(mode==='push')await expect(action).toHaveCount(0);else await expect(action).toBeDisabled();
 if(mode!=='manual')expect(s.methods).not.toContain('DispatchWorkflow');
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeHidden();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('selected manual dispatch uncertainty survives inspection refresh without another write',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await page.goto('/alex/private/actions');
 await page.getByRole('link',{name:'Show runs for '+manual.path,exact:true}).click();const action=page.locator('.workflow-selected-heading').getByRole('button',{name:'Run workflow',exact:true});await action.click();
 const notice=page.getByRole('status').filter({hasText:'Dispatch acknowledgement unavailable.'});await expect(notice).toBeVisible();await expect(action).toBeDisabled();
 let release!:()=>void;s.barrier=new Promise<void>(resolve=>release=resolve);await page.getByText('Execution details and configuration',{exact:true}).click();await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(notice).toHaveCount(0);release();s.barrier=undefined;
 await expect(notice).toBeVisible();await expect(action).toBeDisabled();expect(s.methods.filter(m=>m==='DispatchWorkflow')).toHaveLength(1);
});

for(const [theme,width] of [['dark',1440],['light',390]] as const)test(`accepted dispatch with discarded acknowledgement reloads inspection-only (${theme}/${width})`,async({page},testInfo)=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;await page.addInitScript(()=>{const original=window.fetch;let discarded=false;window.fetch=async(...args)=>{const response=await original(...args);const input=args[0];const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(!discarded&&url.endsWith('/DispatchWorkflow')&&response.ok){discarded=true;throw new TypeError('Accepted dispatch acknowledgement discarded.');}return response;};});await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:844});await open(page);
 await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Accepted dispatch acknowledgement discarded.'})).toBeVisible();expect(s.writes).toHaveLength(1);
 const original=s.writes[0]!;const metadata=await page.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('golf.workflow-dispatch.v1:')));
 expect(metadata).toHaveLength(1);expect(JSON.parse(metadata[0]![1])).toEqual({actorId:s.actor,key:original.idempotencyKey,owner:'alex',name:'private',repositoryId:'9007199254740997',ownerId:s.actor,commitId:commit,workflowPath:manual.path,workflowBlobId:manual.blobId});
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('literal-workflow');
 await page.reload();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();await expect(page.getByText('Original dispatch outcome has not been inspected.',{exact:false})).toBeVisible();expect(s.writes).toHaveLength(1);expect(s.inspections).toHaveLength(0);
 s.manualPolicy=false;await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByText('Manual: Ceilings deny',{exact:false}).first()).toBeVisible();
 await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toBeVisible();expect(s.inspections).toHaveLength(1);expect(s.inspections[0]).toMatchObject({repository:{owner:'alex',name:'private'},repositoryId:'9007199254740997',ownerId:s.actor,commitId:commit,workflowPath:manual.path,idempotencyKey:original.idempotencyKey});expect(s.writes).toHaveLength(1);
 await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('original-dispatch-inspected.png'),fullPage:true});
 s.manualPolicy=true;s.dispatchLost=false;await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect.poll(()=>s.writes.length).toBe(2);expect(s.writes[1]!.idempotencyKey).not.toBe(original.idempotencyKey);
});

test('missing original receipt remains unknown through reload and never permits replacement',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();s.inspectMode='missing';await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Absence does not establish'})).toBeVisible();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'I inspected runs; allow a new dispatch'})).toHaveCount(0);await page.reload();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();expect(s.writes).toHaveLength(1);expect(s.inspections).toHaveLength(1);
});

for(const invalid of ['repository','owner','actor','key','head','blob','path','origin','event-ref','digest','version','cancel','route'])test(`original inspection refuses mismatched ${invalid} receipt`,async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();s.badReceipt=invalid;await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'The original dispatch receipt could not be verified.'})).toBeVisible();await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();expect(s.writes).toHaveLength(1);
});

test('dispatch and inspection reject duplicated same-tick clicks',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);
 await page.getByRole('button',{name:'Run workflow',exact:true}).evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();expect(s.writes).toHaveLength(1);
 let release!:()=>void;s.inspectBarrier=new Promise<void>(resolve=>release=resolve);await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});await expect.poll(()=>s.inspections.length).toBe(1);await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toHaveCount(0);release();s.inspectBarrier=undefined;await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toBeVisible();expect(s.inspections).toHaveLength(1);
});

for(const storage of ['corrupt','blocked'])test(`unavailable original ${storage} metadata prevents dispatch`,async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;await page.addInitScript((kind)=>{if(kind==='corrupt')sessionStorage.setItem(`golf.workflow-dispatch.v1:${location.origin}:9007199254740993:9007199254740997`,'{not-json');else Storage.prototype.setItem=function(){throw new Error('Storage disabled');};},storage);await open(page);const button=page.getByRole('button',{name:'Run workflow',exact:true});if(storage==='corrupt')await expect(button).toBeDisabled();else await button.click();await expect(page.getByRole('alert').filter({hasText:'Original dispatch metadata is unavailable.'})).toBeVisible();expect(s.writes).toHaveLength(0);expect(s.inspections).toHaveLength(0);
});

test('receipt is hidden during authority refresh and cleared after denial',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toBeVisible();let release!:()=>void;s.barrier=new Promise<void>(resolve=>release=resolve);s.mode='denied';await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toHaveCount(0);release();s.barrier=undefined;await expect(page.getByRole('alert').filter({hasText:'Workflow inspection requires repository read access.'}).first()).toBeVisible();expect(s.writes).toHaveLength(1);
});

test('original inspection denial hides private details and requires fresh authority',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();s.inspectMode='denied';await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Current workflow authority is unavailable.'}).first()).toBeVisible();await expect(page.getByRole('link',{name:manual.path,exact:true})).toHaveCount(0);await expect(page.getByText('Original workflow',{exact:false})).toHaveCount(0);s.inspectMode='ready';await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();expect(s.writes).toHaveLength(1);
});

test('late inspection cannot repopulate private details after inspection revocation',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();let release!:()=>void;s.inspectBarrier=new Promise<void>(resolve=>release=resolve);await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect.poll(()=>s.inspections.length).toBe(1);s.mode='denied';await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Workflow inspection requires repository read access.'}).first()).toBeVisible();release();s.inspectBarrier=undefined;await page.waitForTimeout(100);await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toHaveCount(0);await expect(page.getByText('Original workflow',{exact:false})).toHaveCount(0);s.mode='ready';await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();expect(s.writes).toHaveLength(1);
});

test('sign-out forgets original metadata and a held receipt cannot cross account scope',async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();let release!:()=>void;s.inspectBarrier=new Promise<void>(resolve=>release=resolve);await page.getByRole('button',{name:'Inspect original dispatch',exact:true}).click();await expect.poll(()=>s.inspections.length).toBe(1);await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to Golf',exact:true})).toBeVisible();expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('golf.workflow-dispatch.v1:')))).toEqual([]);s.actor='18';release();s.inspectBarrier=undefined;await page.getByLabel('Email or username',{exact:true}).fill('other@example.invalid');await page.getByLabel('Password',{exact:true}).fill('fixture-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.goto(path);await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'View recorded run',exact:true})).toHaveCount(0);expect(s.writes).toHaveLength(1);
});

for(const changes of ['reader','owner'] as const)test(`changed ${changes} observation cannot inspect or replace original intent`,async({page})=>{
 const s=await backend(page);s.worker=true;s.manualPolicy=true;s.dispatchLost=true;await open(page);await page.getByRole('button',{name:'Run workflow',exact:true}).click();await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeEnabled();if(changes==='reader')s.permission='read';else s.badOwner=true;await page.getByRole('button',{name:'Refresh workflow inspection',exact:true}).click();await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();if(changes==='reader'){await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toHaveCount(0);await expect(page.getByText('Original workflow',{exact:false})).toHaveCount(0);}else await expect(page.getByRole('button',{name:'Inspect original dispatch',exact:true})).toBeDisabled();expect(s.inspections).toHaveLength(0);expect(s.writes).toHaveLength(1);
});
