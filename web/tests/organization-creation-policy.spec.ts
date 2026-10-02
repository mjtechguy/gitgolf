import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, OrganizationCreationMode, OrganizationCreationPolicySchema, GetOrganizationCreationPolicyResponseSchema, UpdateOrganizationCreationPolicyRequestSchema, UpdateOrganizationCreationPolicyResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
async function backend(page: Page) {
  const state = { lost: false, denied: false, writes: [] as ReturnType<typeof request<typeof UpdateOrganizationCreationPolicyRequestSchema>>[], policy: create(OrganizationCreationPolicySchema, { mode: OrganizationCreationMode.ADMINISTRATORS_ONLY, revision: '0', revocationEpoch: '0', canEdit: true, canCreate: true, enforcementScope: 'Golf API', nativeAuthorityKnown: false }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex', isInstanceAdmin: true } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'GetOrganizationCreationPolicy') { if (state.denied) return reject(route, 'permission_denied', 'Policy access ended.'); return respond(route, GetOrganizationCreationPolicyResponseSchema, { policy: state.policy }); }
    if (method === 'UpdateOrganizationCreationPolicy') { const input = request(route, UpdateOrganizationCreationPolicyRequestSchema); state.writes.push(input); state.policy = create(OrganizationCreationPolicySchema, { ...state.policy, mode: input.mode, selectedGolfUserIds: input.selectedGolfUserIds, revision: '1', revocationEpoch: '1' }); if (state.lost) return reject(route, 'unavailable', 'Policy receipt lost.'); return respond(route, UpdateOrganizationCreationPolicyResponseSchema, { policy: state.policy }); }
    return reject(route, 'not_found', 'Unsupported creation policy fixture.');
  }); return state;
}
async function edit(page: Page) { await page.goto('/admin/organizations'); await page.getByRole('button', { name: 'Edit organization creation policy', exact: true }).click(); return page.getByRole('form', { name: 'Edit organization creation policy', exact: true }); }

test('organization policy has explicit editor and exact immutable Golf IDs, CAS save and native scope disclosure', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/organizations'); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByText(/does not change existing native permissions/)).toBeVisible();
  let form = await edit(page); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit organization creation policy', exact: true }).click(); form = page.getByRole('form', { name: 'Edit organization creation policy', exact: true });
  await form.getByLabel('Who may request organizations', { exact: true }).selectOption(String(OrganizationCreationMode.SELECTED_USERS)); await form.getByLabel('Selected Golf user IDs', { exact: true }).fill('9007199254740997'); await form.getByRole('button', { name: 'Save organization creation policy', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Organization creation policy saved.'); expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ expectedRevision: '0', selectedGolfUserIds: ['9007199254740997'] });
  await page.reload(); await expect(page.getByText('9007199254740997', { exact: true })).toBeVisible(); await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid selected IDs never dispatch, and lost receipt requires manual inspection without retry', async ({ page }) => {
  const state = await backend(page); const form = await edit(page);
  await form.getByLabel('Who may request organizations', { exact: true }).selectOption(String(OrganizationCreationMode.SELECTED_USERS)); await form.getByLabel('Selected Golf user IDs', { exact: true }).fill('001'); await form.getByRole('button', { name: 'Save organization creation policy', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Provide up to 100 unique canonical Golf user IDs.'); expect(state.writes).toHaveLength(0);
  state.lost = true; await form.getByLabel('Selected Golf user IDs', { exact: true }).fill('9007199254740997'); await form.getByRole('button', { name: 'Save organization creation policy', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('No automatic retry was made.'); await expect(page.getByRole('button', { name: 'Edit organization creation policy', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  state.lost = false; await page.getByRole('button', { name: 'Refresh organization creation policy', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit organization creation policy', exact: true })).toBeEnabled(); expect(state.writes).toHaveLength(1);
});

test('policy denial clears editing and stored selected IDs', async ({ page }) => {
  const state = await backend(page); state.policy.selectedGolfUserIds = ['9007199254740997']; await edit(page); state.denied = true; await page.getByRole('button', { name: 'Refresh organization creation policy', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Policy access ended.'); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByText('9007199254740997', { exact: true })).toHaveCount(0);
});
