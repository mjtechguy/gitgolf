import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, GetAccountSecurityResponseSchema, ChangeOwnPasswordRequestSchema, ChangeOwnPasswordResponseSchema, ChangeOwnLoginEmailRequestSchema, ChangeOwnLoginEmailResponseSchema, LogoutResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { request, respond, reject } from './rpc';
async function fixture(page: Page) {
  const state = { writes: [] as unknown[], unknown: false, signedOut: false, denied: false, logouts: 0 };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, state.signedOut ? {} : { user: { id: '9007199254740993', login: 'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'Logout') { state.logouts++; state.signedOut = true; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'GetAccountSecurity') return state.denied ? reject(route, 'permission_denied', 'Account access denied.') : respond(route, GetAccountSecurityResponseSchema, { security: { accountId: '9007199254740995', userId: '9007199254740993', username: 'alex', loginEmail: 'alex@example.invalid', credentialVersion: '9007199254740997', canManage: true } });
    if (method === 'ChangeOwnPassword' || method === 'ChangeOwnLoginEmail') {
      state.writes.push(request(route, method === 'ChangeOwnPassword' ? ChangeOwnPasswordRequestSchema : ChangeOwnLoginEmailRequestSchema));
      if (state.unknown) return reject(route, 'unavailable', 'Response lost.');
      state.signedOut = true; return method === 'ChangeOwnPassword' ? respond(route, ChangeOwnPasswordResponseSchema, { credentialVersion: '9007199254740998', operationId: 'operation', sessionsRevoked: 2n, requiresLogin: true }) : respond(route, ChangeOwnLoginEmailResponseSchema, { credentialVersion: '9007199254740998', operationId: 'operation', sessionsRevoked: 2n, requiresLogin: true });
    }
    return reject(route, 'not_found', 'Unsupported fixture.');
  }); return state;
}
test('security has explicit editors, cancellation clears secrets and original immutable password binding survives receipt logout', async ({ page }) => {
  const state = await fixture(page); await page.goto('/account/security');
  await expect(page.getByText('alex@example.invalid', { exact: true })).toBeVisible(); await expect(page.getByRole('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'Change password', exact: true }).click(); await page.getByLabel('New Golf password', { exact: true }).fill('never-persist-this-password'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Change password', exact: true }).click(); await expect(page.getByLabel('New Golf password', { exact: true })).toHaveValue('');
  await page.getByLabel('New Golf password', { exact: true }).fill('new-golf-password-long'); await page.getByLabel('Repeat new password', { exact: true }).fill('new-golf-password-long'); await page.getByLabel('Current Golf password', { exact: true }).fill('current-golf-password');
  await page.getByRole('button', { name: 'Change password and sign out', exact: true }).click(); await expect(page.getByText('Your Golf sign-in settings changed. Sign in again to continue.')).toBeVisible();
  expect(state.writes).toEqual([expect.objectContaining({ accountId: '9007199254740995', userId: '9007199254740993', expectedCredentialVersion: '9007199254740997', newPassword: 'new-golf-password-long', passwordConfirmation: 'current-golf-password' })]); await expect(page.getByText('alex@example.invalid', { exact: true })).toHaveCount(0);
});
test('login alias change is unverified and unknown outcome signs out without resending', async ({ page }) => {
  const state = await fixture(page); state.unknown = true; await page.goto('/account/security'); await page.getByRole('button', { name: 'Change sign-in email', exact: true }).click();
  await expect(page.getByText(/does not verify mailbox ownership/)).toBeVisible(); await page.getByLabel('Golf sign-in email', { exact: true }).fill('new@example.invalid'); await page.getByLabel('Current Golf password', { exact: true }).fill('current-golf-password'); await page.getByRole('button', { name: 'Change sign-in email and sign out', exact: true }).click();
  await expect(page.getByText(/The sign-in change outcome could not be confirmed/)).toBeVisible(); expect(state.logouts).toBe(1); expect(state.writes).toEqual([expect.objectContaining({ loginEmail: 'new@example.invalid', expectedCredentialVersion: '9007199254740997' })]);
});
test('security denial on refresh removes account alias and editor secrets', async ({ page }) => {
  const state = await fixture(page); await page.goto('/account/security'); await page.getByRole('button', { name: 'Change password', exact: true }).click(); await page.getByLabel('Current Golf password', { exact: true }).fill('never-persist-this-password'); state.denied = true; await page.getByRole('button', { name: 'Refresh sign-in settings', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Account access denied.'); await expect(page.getByRole('form')).toHaveCount(0); await expect(page.getByText('alex@example.invalid', { exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});
