import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListLocalAccountsResponseSchema, EnrollRegularLocalAccountRequestSchema, EnrollRegularLocalAccountResponseSchema, ResetRegularLocalPasswordRequestSchema, ResetRegularLocalPasswordResponseSchema, EnableRegularLocalAccountRequestSchema, EnableRegularLocalAccountResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
async function fixture(page: Page) {
 const state = { writes: [] as unknown[], unknown: false, denied: false, enabled: false };
 await page.route('**/rpc/**', async route => {
  const method = new URL(route.request().url()).pathname.split('/').at(-1);
  if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
  if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '1', login: 'admin', isInstanceAdmin: true } });
  if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
  if (method === 'ListLocalAccounts') return state.denied ? reject(route, 'permission_denied', 'Instance administration required.') : respond(route, ListLocalAccountsResponseSchema, { accounts: [{ id: '10', nativeUserId: '1', username: 'admin', isInstanceAdmin: true, credentialVersion: '1' }, { id: '9007199254740995', nativeUserId: '9007199254740993', username: 'member', email: 'member@example.invalid', credentialVersion: '9007199254740997', disabled: !state.enabled }] });
  if (method === 'EnrollRegularLocalAccount') { const input = request(route, EnrollRegularLocalAccountRequestSchema); state.writes.push(input); return respond(route, EnrollRegularLocalAccountResponseSchema, { account: { id: '12', nativeUserId: input.expectedNativeUserId, username: input.username, credentialVersion: '1' }, operationId: 'op', sessionsRevoked: 0n }); }
  if (method === 'ResetRegularLocalPassword' || method === 'EnableRegularLocalAccount') {
   state.writes.push(request(route, method === 'ResetRegularLocalPassword' ? ResetRegularLocalPasswordRequestSchema : EnableRegularLocalAccountRequestSchema)); if (state.unknown) return reject(route, 'unavailable', 'Response lost.'); state.enabled = method === 'EnableRegularLocalAccount';
   const account = { id: '9007199254740995', nativeUserId: '9007199254740993', username: 'member', credentialVersion: '9007199254740998', disabled: !state.enabled };
   return method === 'ResetRegularLocalPassword' ? respond(route, ResetRegularLocalPasswordResponseSchema, { account, operationId: 'op', sessionsRevoked: 3n }) : respond(route, EnableRegularLocalAccountResponseSchema, { account, operationId: 'op', sessionsRevoked: 3n });
  } return reject(route, 'not_found', 'Unsupported fixture.');
 }); return state;
}
async function passwords(page: Page) { await page.getByLabel('New account password', { exact: true }).fill('new-password-not-persisted'); await page.getByLabel('Repeat account password', { exact: true }).fill('new-password-not-persisted'); await page.getByLabel('Your Golf password', { exact: true }).fill('admin-password-not-persisted'); }
test('ordinary enrollment explicit editor maps existing identity and clears all secrets on cancel', async ({ page }) => {
 const state = await fixture(page); await page.goto('/admin/settings'); await expect(page.getByRole('form')).toHaveCount(0); await page.getByRole('button', { name: 'New local account', exact: true }).click();
 await expect(page.getByText(/does not create a Git account/)).toBeVisible(); await page.getByLabel('Existing Git identity credential').fill('private-provider-credential'); await passwords(page); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(state.writes).toHaveLength(0);
 await page.getByRole('button', { name: 'New local account', exact: true }).click(); await expect(page.getByLabel('Existing Git identity credential')).toHaveValue(''); await expect(page.getByLabel('Your Golf password', { exact: true })).toHaveValue('');
 await page.getByLabel('Golf username', { exact: true }).fill('new-user'); await page.getByLabel('Golf sign-in email (optional)').fill('new@example.invalid'); await page.getByLabel('Existing Git user ID').fill('9007199254740999'); await page.getByLabel('Existing Git identity credential').fill('provider-private-key'); await passwords(page); await page.getByRole('button', { name: 'Enroll local account', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Local account enrolled for new-user' })).toBeVisible();
 expect(state.writes).toEqual([expect.objectContaining({ username: 'new-user', email: 'new@example.invalid', expectedNativeUserId: '9007199254740999', forgeToken: 'provider-private-key', password: 'new-password-not-persisted', passwordConfirmation: 'admin-password-not-persisted' })]); await expect(page.getByRole('form')).toHaveCount(0);
});
for (const kind of ['reset', 'enable'] as const) test(`${kind} preserves immutable target/version and only enable requests source credential`, async ({ page }) => {
 const state = await fixture(page); await page.goto('/admin/settings'); await expect(page.getByText('Protected administrator', { exact: true })).toBeVisible(); await page.getByRole('button', { name: kind === 'reset' ? 'Reset password' : 'Enable local sign-in', exact: true }).click(); await passwords(page);
 if (kind === 'enable') await page.getByLabel('Existing Git identity credential').fill('fresh-provider-credential'); else await expect(page.getByLabel('Existing Git identity credential')).toHaveCount(0);
 await page.getByRole('form').getByRole('button', { name: kind === 'reset' ? 'Reset local password' : 'Enable local sign-in', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: kind === 'reset' ? 'Local password reset for member' : 'Local sign-in enabled for member' })).toBeVisible();
 expect(state.writes).toEqual([expect.objectContaining({ accountId: '9007199254740995', expectedCredentialVersion: '9007199254740997', passwordConfirmation: 'admin-password-not-persisted', password: 'new-password-not-persisted', ...(kind === 'enable' ? { forgeToken: 'fresh-provider-credential' } : {}) })]);
});
test('unknown account mutation never retries and denial clears private inventory', async ({ page }) => {
 const state = await fixture(page); state.unknown = true; await page.goto('/admin/settings'); await page.getByRole('button', { name: 'Reset password', exact: true }).click(); await passwords(page); await page.getByRole('button', { name: 'Reset local password', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('No automatic retry'); expect(state.writes).toHaveLength(1); await expect(page.getByRole('button', { name: 'New local account', exact: true })).toBeDisabled(); state.denied = true; await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click(); await expect(page.getByText('member@example.invalid', { exact: true })).toHaveCount(0); await expect(page.getByRole('form')).toHaveCount(0); expect(state.writes).toHaveLength(1);
});
