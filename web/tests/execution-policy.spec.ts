import { disabledAgentTasks, disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ExecutionMode, ExecutionScope, ExecutionPolicySchema, GetExecutionPolicyResponseSchema, UpdateExecutionPolicyRequestSchema, UpdateExecutionPolicyResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, InspectWorkflowsResponseSchema, GetOrganizationResponseSchema, GetRepositorySettingsResponseSchema, GetRepositoryAccessResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
const path = '/repositories/alex/private/settings/workflows';
async function backend(page: Page, scope = ExecutionScope.REPOSITORY) {
  const state = { reads: 0, writes: [] as ReturnType<typeof request<typeof UpdateExecutionPolicyRequestSchema>>[], failure: false, invalidReceipt: false, invalidPushReceipt: false, denied: false, policy: create(ExecutionPolicySchema, { scope, scopeId: '9007199254740997', ownerId: '9007199254740993', mode: ExecutionMode.DISABLED, revision: '0', revocationEpoch: '0', authorityRevision: 'a'.repeat(64), canEdit: true }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
 if(method === 'ListAgentTasks') return disabledAgentTasks(route);
 if(method === 'GetAgentUsage') return disabledAgentUsage(route);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex', isInstanceAdmin: true } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '9007199254740997', ownerId: '9007199254740993', currentPermission: 'read' } });
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: { repositoryId: '9007199254740997', ownerId: '9007199254740993', canEdit: false } });
    if (method === 'GetOrganization') return respond(route, GetOrganizationResponseSchema, { organization: { id: '9007199254740997', name: 'acme' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'InspectWorkflows') return respond(route, InspectWorkflowsResponseSchema, { repositoryId: state.policy.scopeId, commitId: 'b'.repeat(40), catalogVersion: 'golf.workflow.inspect.v1' });
    if (method === 'GetExecutionPolicy') { state.reads++; if (state.denied) return reject(route, 'permission_denied', 'Policy access ended.'); return respond(route, GetExecutionPolicyResponseSchema, { policy: state.policy }); }
    if (method === 'UpdateExecutionPolicy') {
      const input = request(route, UpdateExecutionPolicyRequestSchema); state.writes.push(input);
      state.policy = create(ExecutionPolicySchema, { ...state.policy, mode: input.mode, manualDispatchEnabled: input.manualDispatchEnabled, pushAllowed: input.pushAllowed, allowAllWorkflows: input.allowAllWorkflows, workflowPaths: input.workflowPaths, selectedRepositoryIds: input.selectedRepositoryIds, revision: (BigInt(state.policy.revision) + 1n).toString(), revocationEpoch: (BigInt(state.policy.revocationEpoch) + 1n).toString() });
      if (state.failure) return reject(route, 'unavailable', 'Receipt unavailable.');
      return respond(route, UpdateExecutionPolicyResponseSchema, { policy: state.invalidReceipt ? { ...state.policy, scopeId: 'another-id' } : state.invalidPushReceipt ? { ...state.policy, pushAllowed: !state.policy.pushAllowed } : state.policy });
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
  expect(state.writes[0]).toMatchObject({ scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', expectedRevision: '0', expectedAuthorityRevision: 'a'.repeat(64), manualDispatchEnabled: true, pushAllowed: false, workflowPaths: ['.github/workflows/check.yml'] });
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

for (const scope of [ExecutionScope.INSTANCE, ExecutionScope.ORGANIZATION, ExecutionScope.REPOSITORY]) test(`push permission is explicit and independent of manual dispatch at scope ${scope}`, async ({ page }) => {
  const state = await backend(page, scope); state.policy.mode = ExecutionMode.ALL; state.policy.manualDispatchEnabled = true; state.policy.allowAllWorkflows = true;
  await page.goto(scope === ExecutionScope.INSTANCE ? '/admin/execution' : scope === ExecutionScope.ORGANIZATION ? '/organizations/acme/settings' : path);
  const panel = page.getByRole('region', { name: 'Execution policy', exact: true }); await expect(panel.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeVisible();
  await expect(panel.getByRole('form')).toHaveCount(0); await expect(panel.getByText('Automatic push execution', { exact: true }).locator('..')).toContainText('Denied');
  await panel.getByRole('button', { name: 'Edit execution policy', exact: true }).click(); const form = panel.getByRole('form'); await expect(form.getByLabel('Automatic push execution', { exact: true })).toHaveValue('false'); await form.getByLabel('Automatic push execution', { exact: true }).selectOption('true'); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  await panel.getByRole('button', { name: 'Edit execution policy', exact: true }).click(); await expect(form.getByLabel('Automatic push execution', { exact: true })).toHaveValue('false'); await form.getByLabel('Automatic push execution', { exact: true }).selectOption('true'); await form.getByLabel('Manual dispatch', { exact: true }).selectOption('false'); await expect(form.getByText(/permission alone starts no runs/)).toBeVisible(); await form.getByRole('button', { name: 'Save execution policy', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Execution policy saved.'); expect(state.writes).toEqual([expect.objectContaining({ scope, scopeId: '9007199254740997', expectedRevision: '0', expectedAuthorityRevision: 'a'.repeat(64), manualDispatchEnabled: false, pushAllowed: true })]);
  await expect(panel.getByText('Automatic push execution', { exact: true }).locator('..')).toContainText('Allowed within ceilings'); await expect(panel.getByText('Manual dispatch', { exact: true }).locator('..')).toContainText('Denied'); await page.reload(); await expect(panel.getByText('Automatic push execution', { exact: true }).locator('..')).toContainText('Allowed within ceilings');
});
test('a mismatched push receipt requires inspection and never silently accepts or repeats a save', async ({ page }) => {
  const state = await backend(page); state.invalidPushReceipt = true; await open(page); const form = await edit(page); await form.getByLabel('Automatic push execution', { exact: true }).selectOption('true'); await form.getByRole('button', { name: 'Save execution policy', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Execution policy', exact: true }).getByRole('alert')).toContainText('The saved policy could not be verified.'); expect(state.writes).toHaveLength(1); await expect(page.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Refresh execution policy', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit execution policy', exact: true })).toBeEnabled(); expect(state.writes).toHaveLength(1);
});
