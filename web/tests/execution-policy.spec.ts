import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ExecutionMode, ExecutionScope, ExecutionPolicySchema, GetExecutionPolicyResponseSchema, UpdateExecutionPolicyRequestSchema, UpdateExecutionPolicyResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, InspectWorkflowsResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
const path = '/repositories/alex/private/settings/workflows';
async function backend(page: Page) {
  const state = { reads: 0, writes: [] as ReturnType<typeof request<typeof UpdateExecutionPolicyRequestSchema>>[], failure: false, invalidReceipt: false, denied: false, policy: create(ExecutionPolicySchema, { scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', ownerId: '9007199254740993', mode: ExecutionMode.DISABLED, revision: '0', revocationEpoch: '0', authorityRevision: 'a'.repeat(64), canEdit: true }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'InspectWorkflows') return respond(route, InspectWorkflowsResponseSchema, { repositoryId: state.policy.scopeId, commitId: 'b'.repeat(40), catalogVersion: 'golf.workflow.inspect.v1' });
    if (method === 'GetExecutionPolicy') { state.reads++; if (state.denied) return reject(route, 'permission_denied', 'Policy access ended.'); return respond(route, GetExecutionPolicyResponseSchema, { policy: state.policy }); }
    if (method === 'UpdateExecutionPolicy') {
      const input = request(route, UpdateExecutionPolicyRequestSchema); state.writes.push(input);
      state.policy = create(ExecutionPolicySchema, { ...state.policy, mode: input.mode, manualDispatchEnabled: input.manualDispatchEnabled, allowAllWorkflows: input.allowAllWorkflows, workflowPaths: input.workflowPaths, selectedRepositoryIds: input.selectedRepositoryIds, revision: (BigInt(state.policy.revision) + 1n).toString(), revocationEpoch: (BigInt(state.policy.revocationEpoch) + 1n).toString() });
      if (state.failure) return reject(route, 'unavailable', 'Receipt unavailable.');
      return respond(route, UpdateExecutionPolicyResponseSchema, { policy: state.invalidReceipt ? { ...state.policy, scopeId: 'another-id' } : state.policy });
    }
    return reject(route, 'not_found', 'Unsupported policy fixture.');
  });
  return state;
}
async function open(page: Page) { await page.goto(path); await expect(page.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeVisible(); }
async function edit(page: Page) { await page.getByRole('button', { name: 'Edit execution policy', exact: true }).click(); const form = page.getByRole('form', { name: 'Edit execution policy', exact: true }); await form.getByLabel('Repository eligibility', { exact: true }).selectOption(String(ExecutionMode.ALL)); await form.getByLabel('Manual dispatch', { exact: true }).selectOption('true'); await form.getByLabel('Allowed workflow paths', { exact: true }).fill('.github/workflows/check.yml'); return form; }

test('policy editor is explicit and cancel never writes; save binds exact immutable ID and both revisions', async ({ page }) => {
  const state = await backend(page); await open(page);
  await expect(page.getByRole('form', { name: 'Edit execution policy' })).toHaveCount(0);
  let form = await edit(page); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  form = await edit(page); await form.getByRole('button', { name: 'Save execution policy', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Execution policy', exact: true }).getByRole('status')).toHaveText('Execution policy saved.'); expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', expectedRevision: '0', expectedAuthorityRevision: 'a'.repeat(64), manualDispatchEnabled: true, workflowPaths: ['.github/workflows/check.yml'] });
  await page.reload(); await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid literal workflow paths do not dispatch policy mutations', async ({ page }) => {
  const state = await backend(page); await open(page); const form = await edit(page);
  await form.getByLabel('Allowed workflow paths', { exact: true }).fill('.github/workflows/*.yml'); await form.getByRole('button', { name: 'Save execution policy', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Execution policy', exact: true }).getByRole('alert')).toHaveText('Provide up to 100 unique literal supported workflow paths.'); expect(state.writes).toHaveLength(0);
});

for (const failure of ['lost receipt', 'wrong binding'] as const) test(`${failure} requires explicit refresh and never retries automatically`, async ({ page }) => {
  const state = await backend(page); state.failure = failure === 'lost receipt'; state.invalidReceipt = failure === 'wrong binding'; await open(page); const form = await edit(page); await form.getByRole('button', { name: 'Save execution policy', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Execution policy', exact: true }).getByRole('alert')).toContainText('No automatic retry was made.'); await expect(page.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  state.failure = false; state.invalidReceipt = false; await page.getByRole('button', { name: 'Refresh execution policy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeEnabled(); await expect(page.getByText('1 / 1', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
});

test('permission loss clears policy and editor after refresh', async ({ page }) => {
  const state = await backend(page); await open(page); await edit(page); state.denied = true;
  await page.getByRole('button', { name: 'Refresh execution policy', exact: true }).click(); await expect(page.getByRole('region', { name: 'Execution policy', exact: true }).getByRole('alert')).toHaveText('Policy access ended.'); await expect(page.getByRole('form', { name: 'Edit execution policy' })).toHaveCount(0); await expect(page.getByText('9007199254740997', { exact: true })).toHaveCount(0);
});
