import { disabledAgentTasks, disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetRepositorySettingsResponseSchema, GetSessionResponseSchema, GetReviewerResponseSchema, ListReviewerRunsResponseSchema, GetRepositoryResponseSchema, InspectWorkflowsRequestSchema, InspectWorkflowsResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ExecutionScope, ExecutionMode, GetExecutionPolicyResponseSchema, ListWorkflowRunsResponseSchema, ListWorkflowRunsRequestSchema, WorkflowRunState, WorkflowRunOrigin, WorkflowConfigurationSchema, WorkflowFormat, WorkflowInspectionState } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const path = '/repositories/alex/private/settings/workflows';
const commit = 'a'.repeat(40);
const manual = create(WorkflowConfigurationSchema, { path: '.github/workflows/manual.yml', blobId: 'b'.repeat(40), byteSize: 123n, format: WorkflowFormat.GITHUB_ACTIONS, state: WorkflowInspectionState.VALIDATED_SUBSET, name: '<literal-workflow>', events: ['workflow_dispatch'], jobs: [{ id: 'check', name: '<img src=x onerror=alert(1)>', stepCount: 1 }] });
async function backend(page: Page) {
  const state = { mode: 'ready', worker: false, policyKnown: true, manualPolicy: false, pushPolicy: false, badPolicyRevision: false, badTarget: false, badMetadata: false, missingMetadata: false, signedIn: true, barrier: undefined as Promise<void> | undefined, requests: [] as unknown[], runPages: false, matchingRuns: false, methods: [] as string[], denyRuns: false, requestedRunPages: [] as number[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1); state.methods.push(method||'');
 if(method === 'ListAgentTasks') return disabledAgentTasks(route);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if(method==='GetReviewer')return respond(route,GetReviewerResponseSchema,{executionAvailable:false});
    if(method==='ListReviewerRuns')return respond(route,ListReviewerRunsResponseSchema,{});
    if(method==='GetRepository')return respond(route,GetRepositoryResponseSchema,{repository:{id:'9007199254740997',name:state.missingMetadata?'':state.badMetadata?'other':'private',fullName:state.missingMetadata?'':'alex/private',defaultBranch:'main',private:true}});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '9007199254740997', ownerId: '9007199254740993', currentPermission: 'read' } });
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: { repositoryId: '9007199254740997', ownerId: '9007199254740993', canEdit: false } });
    if (method === 'GetExecutionPolicy') return respond(route, GetExecutionPolicyResponseSchema, { policy: { scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', ownerId: '9007199254740993', mode: ExecutionMode.DISABLED, revision: '0', revocationEpoch: '0', authorityRevision: 'd'.repeat(64) } });
    if (method === 'ListWorkflowRuns') {
      const input = request(route, ListWorkflowRunsRequestSchema); state.requestedRunPages.push(input.page?.page || 1);
      if (state.denyRuns) return reject(route, 'permission_denied', 'Workflow runs require repository read access.');
      if (!state.runPages) return respond(route, ListWorkflowRunsResponseSchema, {});
      const current = input.page?.page || 1;
      return respond(route, ListWorkflowRunsResponseSchema, { runs: Array.from({ length: current === 1 ? 20 : 1 }, (_, index) => ({ id: `12345678-1234-4234-8234-${(current*100+index).toString(16).padStart(12,'0')}`, workflowPath: state.matchingRuns && index===0 ? manual.path : current === 2 ? '.github/workflows/later.yml' : `.github/workflows/job-${index}.yml`, state: WorkflowRunState.SUCCEEDED, origin: index === 0 ? WorkflowRunOrigin.PUSH : WorkflowRunOrigin.MANUAL, commitId: commit })), page: { nextPage: current === 1 ? 2 : 0 } });
    }
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
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
  const state = await backend(page); state.runPages = true; await open(page);
  const table = page.getByRole('table', { name: 'Workflow runs', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
  await expect(table.getByRole('columnheader', { name: 'Run', exact: false })).toBeVisible();
  await expect(table.locator('.workflow-run-row small').filter({hasText:/^Push ·/})).toHaveCount(1);
  await expect(table.locator('.workflow-run-row small').filter({hasText:/^Manual ·/})).toHaveCount(19);
  await page.getByRole('button', { name: 'Load more workflow runs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more workflow runs', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search loaded Workflow runs', exact: true }).fill('later.yml');
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
 await expect(page.getByRole('table',{name:'Workflow runs',exact:true})).toBeVisible();
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeHidden();
 await expect(page.getByRole('navigation',{name:'Workflow navigation'})).toBeVisible();
 await page.getByText('Workflow configuration files',{exact:true}).click();
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeVisible();
 await expect(page.locator('.settings-navigation')).toHaveCount(0);
 await page.reload();await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Actions');
});

for(const theme of ['dark','light'])for(const width of [1440,390])test(`Actions ${theme}/${width} defaults to runs and filters only loaded history without eager coding tasks`,async({page},testInfo)=>{
 const s=await backend(page);s.runPages=true;s.matchingRuns=true;await page.setViewportSize({width,height:1000});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto('/alex/private/actions?ref='+commit+'&branch=older-context');
 const table=page.getByRole('table',{name:'Workflow runs',exact:true});await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
 const navigation=page.getByRole('navigation',{name:'Workflow navigation'});await expect(navigation.getByRole('button',{name:'All workflows'})).toHaveAttribute('aria-current','page');
 expect(s.methods).not.toContain('ListAgentTasks');await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toBeHidden();
 await expect(page.getByText('Current default-branch configurations at',{exact:false})).toBeVisible();
 await expect(page.getByText('Workflow worker execution is unavailable.',{exact:false})).toBeVisible();
 const select=navigation.getByRole('button',{name:'Show loaded runs for '+manual.path,exact:true});await select.focus();await page.keyboard.press('Enter');
 await expect(select).toHaveAttribute('aria-current','page');await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);await expect(table).toContainText(manual.path);
 await expect(page.getByText('this is not a complete history count.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Load more workflow runs'}).click();await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(2);expect(s.requestedRunPages.filter(p=>p===2)).toEqual([2]);
 await navigation.getByRole('button',{name:'All workflows'}).click();await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(20);
 await page.getByText('Workflow configuration files',{exact:true}).click();await expect(page.getByRole('button',{name:'Run workflow',exact:true})).toBeDisabled();
 await page.getByText('Coding tasks',{exact:true}).click();await expect.poll(()=>s.methods.filter(m=>m==='ListAgentTasks').length).toBeGreaterThan(0);
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
 await expect(page.getByRole('button',{name:'Show loaded runs for '+manual.path,exact:true})).toHaveCount(0);await expect(page.getByText('<literal-workflow>',{exact:true})).toHaveCount(0);expect(s.methods).not.toContain('DispatchWorkflow');
});


for(const missing of [false,true])test(`settings workflow inspection refuses ${missing?'missing':'mismatched'} repository metadata before protected inspection`, async ({page})=>{
 const state=await backend(page);state.badMetadata=!missing;state.missingMetadata=missing;await page.goto(path);
 await expect(page.getByRole('alert')).toHaveText('Repository identity could not be verified for workflow inspection.');
 expect(state.methods).toContain('GetRepository');expect(state.requests).toHaveLength(0);
 await expect(page.getByRole('table',{name:'Workflow configurations',exact:true})).toHaveCount(0);
 await expect(page.getByRole('link',{name:manual.path,exact:true})).toHaveCount(0);
 expect(state.methods.some(method=>/^(Dispatch|Update|Create)/.test(method))).toBe(false);
});
