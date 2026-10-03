import { disabledAgentTasks, disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetRepositorySettingsResponseSchema, GetSessionResponseSchema, InspectWorkflowsRequestSchema, InspectWorkflowsResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ExecutionScope, ExecutionMode, GetExecutionPolicyResponseSchema, ListWorkflowRunsResponseSchema, ListWorkflowRunsRequestSchema, WorkflowRunState, WorkflowRunOrigin, WorkflowConfigurationSchema, WorkflowFormat, WorkflowInspectionState } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const path = '/repositories/alex/private/settings/workflows';
const commit = 'a'.repeat(40);
const manual = create(WorkflowConfigurationSchema, { path: '.github/workflows/manual.yml', blobId: 'b'.repeat(40), byteSize: 123n, format: WorkflowFormat.GITHUB_ACTIONS, state: WorkflowInspectionState.VALIDATED_SUBSET, name: '<literal-workflow>', events: ['workflow_dispatch'], jobs: [{ id: 'check', name: '<img src=x onerror=alert(1)>', stepCount: 1 }] });
async function backend(page: Page) {
  const state = { mode: 'ready', signedIn: true, barrier: undefined as Promise<void> | undefined, requests: [] as unknown[], runPages: false, denyRuns: false, requestedRunPages: [] as number[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
 if(method === 'ListAgentTasks') return disabledAgentTasks(route);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
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
      return respond(route, ListWorkflowRunsResponseSchema, { runs: Array.from({ length: current === 1 ? 20 : 1 }, (_, index) => ({ id: `run-${current}-${index}`, workflowPath: current === 2 ? '.github/workflows/later.yml' : `.github/workflows/job-${index}.yml`, state: WorkflowRunState.SUCCEEDED, origin: index === 0 ? WorkflowRunOrigin.PUSH : WorkflowRunOrigin.MANUAL, commitId: commit })), page: { nextPage: current === 1 ? 2 : 0 } });
    }
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'InspectWorkflows') {
      state.requests.push(request(route, InspectWorkflowsRequestSchema));
      if (state.barrier) await state.barrier;
      if (state.mode === 'denied') return reject(route, 'permission_denied', 'Workflow inspection requires repository read access.');
      if (state.mode === 'expired') { state.signedIn = false; return reject(route, 'unauthenticated', 'Your session ended.'); }
      if (state.mode === 'overfull') return reject(route, 'resource_exhausted', 'Workflow configuration inventory exceeds its bound.');
      return respond(route, InspectWorkflowsResponseSchema, { repositoryId: '9007199254740997', commitId: commit, catalogVersion: 'golf.workflow.inspect.v2', executionAvailable: false, configurations: state.mode === 'empty' ? [] : [state.mode === 'push' ? { ...manual, events: ['push'] } : manual, { path: '.gitlab-ci.yml', blobId: 'c'.repeat(40), byteSize: 321n, format: WorkflowFormat.GITLAB_CI, state: WorkflowInspectionState.UNSUPPORTED, jobs: [{ id: 'build', stage: 'test', stepCount: 1 }], diagnostics: [{ code: 'unsupported_field', message: 'Remote includes are not fetched.', line: 3, column: 2 }] }] });
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
  const url = new URL((await source.getAttribute('href'))!, 'http://127.0.0.1:4179');
  expect(url.searchParams.get('ref')).toBe(commit); expect(url.searchParams.get('path')).toBe(manual.path);
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
  await expect(table.getByRole('columnheader', { name: 'Trigger' })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Push', exact: true })).toHaveCount(1);
  await expect(table.getByRole('cell', { name: 'Manual', exact: true })).toHaveCount(19);
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
