import { portableRuntimeFixture } from './runtime-fixture';
import { disabledAgentTasks, disabledAgentUsage } from './rpc';
import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { ExecutionMode, ExecutionScope, ExecutionPolicySchema, GetExecutionPolicyResponseSchema, UpdateExecutionPolicyRequestSchema, UpdateExecutionPolicyResponseSchema, GetRepositoryResponseSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, InspectWorkflowsResponseSchema, GetOrganizationResponseSchema, GetRepositorySettingsResponseSchema, GetRepositoryAccessResponseSchema } from '../src/gen/golf/v1/golf_pb';
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
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, {repository:{id:'9007199254740997',name:'private',fullName:'alex/private',defaultBranch:'main'}});
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

// Cloudflare native: one stored switch per run kind. The fixture keeps the revocation epoch at zero, as that runtime does.
async function nativeBackend(page: Page) {
  const state = { methods: [] as string[], writes: [] as ReturnType<typeof request<typeof UpdateExecutionPolicyRequestSchema>>[], advanceEpoch: false, policy: create(ExecutionPolicySchema, { scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', ownerId: '9007199254740993', mode: ExecutionMode.ALL, manualDispatchEnabled: true, pushAllowed: true, allowAllWorkflows: true, revision: '0', revocationEpoch: '0', authorityRevision: 'a'.repeat(64), canEdit: true }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!; state.methods.push(method);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: ['settings.repository-workflows', 'settings.repository-execution-policy'].map(id => ({ id, label: id, state: 3, reason: 'Native test capability.' })) });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '9007199254740997', ownerId: '9007199254740993', currentPermission: state.policy.canEdit ? 'admin' : 'read' } });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { id: '9007199254740997', name: 'private', fullName: 'alex/private', defaultBranch: 'main' } });
    if (method === 'InspectWorkflows') return respond(route, InspectWorkflowsResponseSchema, { repositoryId: state.policy.scopeId, commitId: 'b'.repeat(40), catalogVersion: 'golf.native.workflow-inventory.v1', executionAvailable: true, policyRevision: 'e'.repeat(64) });
    if (method === 'GetExecutionPolicy') return respond(route, GetExecutionPolicyResponseSchema, { policy: state.policy });
    if (method === 'UpdateExecutionPolicy') {
      const input = request(route, UpdateExecutionPolicyRequestSchema); state.writes.push(input);
      state.policy = create(ExecutionPolicySchema, { ...state.policy, mode: input.mode, manualDispatchEnabled: input.manualDispatchEnabled, pushAllowed: input.pushAllowed, revision: (BigInt(state.policy.revision) + 1n).toString(), revocationEpoch: state.advanceEpoch ? '1' : '0' });
      return respond(route, UpdateExecutionPolicyResponseSchema, { policy: state.policy });
    }
    return reject(route, 'unimplemented', 'This capability is not implemented on the native forge.');
  });
  return state;
}

test('the native repository switch leads with current values and saves only its two run kinds', async ({ page }) => {
  const state = await nativeBackend(page); await page.goto(path);
  const panel = page.getByRole('region', { name: 'Pull-request execution', exact: true });
  await expect(panel.getByRole('button', { name: 'Edit pull-request execution', exact: true })).toBeVisible();
  await expect(panel.getByRole('form')).toHaveCount(0);
  await expect(panel.getByText('Pull-request runs', { exact: true }).locator('..')).toContainText('Allowed within the operator allocation');
  await expect(panel.getByText('Automatic push tests', { exact: true }).locator('..')).toContainText('Allowed within the operator allocation');
  await expect(panel.getByText('Revision', { exact: true }).locator('..')).toContainText('Never changed');
  await expect(panel.getByText('a run already admitted finishes within its ten-minute limit', { exact: false })).toBeVisible();
  for (const portable of ['Repository eligibility', 'Selected IDs', 'Manual dispatch', 'Workflows', 'Revision / revocation epoch']) await expect(panel.getByText(portable, { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Unset scopes deny execution', { exact: false })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Edit pull-request execution', exact: true }).click();
  const form = panel.getByRole('form', { name: 'Edit pull-request execution', exact: true });
  await expect(form.locator('select, textarea, input')).toHaveCount(2);
  await form.getByLabel('Pull-request runs', { exact: true }).selectOption('false');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  await panel.getByRole('button', { name: 'Edit pull-request execution', exact: true }).click();
  await expect(form.getByLabel('Pull-request runs', { exact: true })).toHaveValue('true');
  await form.getByLabel('Pull-request runs', { exact: true }).selectOption('false');
  await form.getByRole('button', { name: 'Save pull-request execution', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Execution policy saved.');
  expect(state.writes).toEqual([expect.objectContaining({ scope: ExecutionScope.REPOSITORY, scopeId: '9007199254740997', expectedRevision: '0', expectedAuthorityRevision: 'a'.repeat(64), mode: ExecutionMode.ALL, manualDispatchEnabled: false, pushAllowed: true, allowAllWorkflows: true, workflowPaths: [], selectedRepositoryIds: [] })]);
  await expect(panel.getByText('Pull-request runs', { exact: true }).locator('..')).toContainText('Turned off');
  await expect(panel.getByText('Revision', { exact: true }).locator('..')).toContainText('1');
  // Turning the second kind off as well stores the disabled mode; no other field is offered.
  await panel.getByRole('button', { name: 'Edit pull-request execution', exact: true }).click();
  await form.getByLabel('Automatic push tests', { exact: true }).selectOption('false');
  await form.getByRole('button', { name: 'Save pull-request execution', exact: true }).click();
  await expect(panel.getByText('Automatic push tests', { exact: true }).locator('..')).toContainText('Turned off');
  expect(state.writes[1]).toMatchObject({ expectedRevision: '1', mode: ExecutionMode.DISABLED, manualDispatchEnabled: false, pushAllowed: false, allowAllWorkflows: true });
  await page.waitForLoadState('networkidle');
  for (const method of ['GetReviewer', 'GetAgentUsage', 'ListAutomationGrants', 'ListActionRuns']) expect(state.methods).not.toContain(method);
  await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a native reader sees the switch without an edit action', async ({ page }) => {
  const state = await nativeBackend(page); state.policy.canEdit = false; state.policy.manualDispatchEnabled = false; state.policy.revision = '4'; await page.goto(path);
  const panel = page.getByRole('region', { name: 'Pull-request execution', exact: true });
  await expect(panel.getByText('Pull-request runs', { exact: true }).locator('..')).toContainText('Turned off');
  await expect(panel.getByText('Revision', { exact: true }).locator('..')).toContainText('4');
  await expect(panel.getByRole('button', { name: 'Edit pull-request execution', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Refresh execution policy', exact: true })).toBeVisible();
});

test('a native receipt that claims to revoke admitted runs is not accepted as saved', async ({ page }) => {
  const state = await nativeBackend(page); state.advanceEpoch = true; await page.goto(path);
  const panel = page.getByRole('region', { name: 'Pull-request execution', exact: true });
  await panel.getByRole('button', { name: 'Edit pull-request execution', exact: true }).click();
  await panel.getByRole('form').getByLabel('Automatic push tests', { exact: true }).selectOption('false');
  await panel.getByRole('form').getByRole('button', { name: 'Save pull-request execution', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('The saved policy could not be verified.'); expect(state.writes).toHaveLength(1);
  await expect(panel.getByRole('button', { name: 'Edit pull-request execution', exact: true })).toBeDisabled();
});
