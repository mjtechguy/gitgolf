import { expect, test, type Page } from '@playwright/test';
import { OrganizationCreationMode, OrganizationVisibility, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListOrganizationsResponseSchema, GetOrganizationCreationPolicyResponseSchema, CreateOrganizationRequestSchema, CreateOrganizationResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
async function backend(page: Page) {
  const state = { canCreate: true, created: false, fail: '' as '' | 'permission_denied' | 'failed_precondition' | 'unavailable', wrongVisibility: false, writes: [] as ReturnType<typeof request<typeof CreateOrganizationRequestSchema>>[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '9007199254740993', login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'GetOrganizationCreationPolicy') return respond(route, GetOrganizationCreationPolicyResponseSchema, { policy: { mode: OrganizationCreationMode.ALL_USERS, revision: '7', revocationEpoch: '7', canCreate: state.canCreate, enforcementScope: 'Golf API' } });
    if (method === 'ListOrganizations') return respond(route, ListOrganizationsResponseSchema, { organizations: [{ id: '20', name: 'public-lab', visibility: OrganizationVisibility.PUBLIC }, ...(state.created ? [{ id: '9007199254740997', name: 'private-lab', fullName: 'Private Lab', description: 'Created fixture', visibility: OrganizationVisibility.PRIVATE }] : [])] });
    if (method === 'CreateOrganization') { const input = request(route, CreateOrganizationRequestSchema); state.writes.push(input); if (state.fail) { if (state.fail === 'unavailable') state.created = true; return reject(route, state.fail, state.fail === 'permission_denied' ? 'Native organization creation denied.' : state.fail === 'failed_precondition' ? 'Organization policy changed.' : 'Receipt lost.'); } state.created = true; return respond(route, CreateOrganizationResponseSchema, { organization: { id: '9007199254740997', name: input.username, fullName: input.fullName, description: input.description, visibility: state.wrongVisibility ? OrganizationVisibility.PUBLIC : OrganizationVisibility.PRIVATE } }); }
    return reject(route, 'not_found', 'Unsupported creation fixture.');
  }); return state;
}
async function edit(page: Page) { await page.goto('/organizations'); await page.getByRole('button', { name: 'New organization', exact: true }).click(); const form = page.getByRole('form', { name: 'Create private organization', exact: true }); await form.getByLabel('Organization name', { exact: true }).fill('private-lab'); await form.getByLabel('Organization display name', { exact: true }).fill('Private Lab'); await form.getByLabel('Organization description', { exact: true }).fill('Created fixture'); return form; }

test('organization creation is explicit, cancel is empty, private-only response is verified and listing refreshed', async ({ page }) => {
  const state = await backend(page); await page.goto('/organizations'); await expect(page.getByRole('form')).toHaveCount(0); let form = await edit(page); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'New organization', exact: true }).click(); form = page.getByRole('form', { name: 'Create private organization', exact: true }); await expect(form.getByLabel('Organization name', { exact: true })).toHaveValue(''); await form.getByLabel('Organization name', { exact: true }).fill('private-lab'); await form.getByLabel('Organization display name', { exact: true }).fill('Private Lab'); await form.getByLabel('Organization description', { exact: true }).fill('Created fixture'); await form.getByRole('button', { name: 'Create private organization', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Private organization private-lab created.'); expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ username: 'private-lab', visibility: 'private', expectedPolicyRevision: '7' });
  await expect(page.getByRole('link', { name: 'private-lab', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'public-lab', exact: true })).toBeVisible(); await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const failure of ['permission_denied', 'failed_precondition', 'unavailable'] as const) test(`${failure} creation stops without automatic retry or fake success`, async ({ page }) => {
  const state = await backend(page); state.fail = failure; const form = await edit(page); await form.getByRole('button', { name: 'Create private organization', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('No automatic retry was made.'); await expect(page.getByRole('button', { name: 'New organization', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1); await expect(page.getByText('Private organization private-lab created.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh your organizations', exact: true }).click(); expect(state.writes).toHaveLength(1); await expect(page.getByRole('button', { name: 'New organization', exact: true })).toBeDisabled();
});

test('policy denial never displays a creation editor or dispatches', async ({ page }) => {
  const state = await backend(page); state.canCreate = false; await page.goto('/organizations'); await expect(page.getByText('Your current Golf session is not permitted to request organization creation.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New organization', exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); expect(state.writes).toHaveLength(0);
});
