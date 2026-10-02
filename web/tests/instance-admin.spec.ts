import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListLocalAccountsResponseSchema, ListLocalAccountsRequestSchema, UserSchema, DisableLocalAccountRequestSchema, DisableLocalAccountResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page, admin = true) {
  const state = { denied: false, reads: [] as number[], writes: [] as ReturnType<typeof request<typeof DisableLocalAccountRequestSchema>>[], failWrite: false, disabled: false, waitWrite: undefined as Promise<void> | undefined, logoutFail: false, user: create(UserSchema, { id: '9007199254740993', login: 'alex', isInstanceAdmin: admin }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'Logout' && state.logoutFail) { await new Promise(resolve => setTimeout(resolve, 200)); return reject(route, 'unavailable', 'Sign out could not be completed.'); }
    if (method === 'DisableLocalAccount') {
      const input = request(route, DisableLocalAccountRequestSchema); state.writes.push(input);
      if (state.failWrite) return reject(route, 'unavailable', 'Response lost.');
      state.disabled = true;
      if (state.waitWrite) await state.waitWrite;
      return respond(route, DisableLocalAccountResponseSchema, { account: { id: '21', username: 'next-account', nativeUserId: '22', credentialVersion: '2', disabled: true }, sessionsRevoked: 2n, operationId: 'operation-1' });
    }
    if (method === 'ListLocalAccounts') {
      const input = request(route, ListLocalAccountsRequestSchema); const number = input.page?.page ?? 1; state.reads.push(number);
      if (state.denied) return reject(route, 'permission_denied', 'Instance administration required.');
      return respond(route, ListLocalAccountsResponseSchema, { accounts: number === 1 ? [
        { id: '9007199254740997', username: 'alex', email: 'alex@example.invalid', nativeUserId: '9007199254740999', isInstanceAdmin: true, createdAt: '2026-10-02T10:00:00Z' },
        { id: '9007199254740998', username: 'disabled-user', email: 'disabled@example.invalid', nativeUserId: '9007199254740994', disabled: true, createdAt: '2026-10-01T10:00:00Z' },
      ] : [{ id: '21', username: 'next-account', nativeUserId: '22', credentialVersion: state.disabled ? '2' : '1', disabled: state.disabled, createdAt: '2026-09-01T10:00:00Z' }], page: { nextPage: number === 1 ? 2 : 0 } });
    }
    return reject(route, 'not_found', 'Unsupported fixture.');
  });
  return state;
}

test('instance inventory preserves exact IDs, loaded search, paging and protected administrator lifecycle', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin/settings');
  const table = page.getByRole('table', { name: 'Local accounts', exact: true });
  await expect(table.getByText('9007199254740997', { exact: true })).toBeVisible();
  await expect(table.getByText('9007199254740999', { exact: true })).toBeVisible();
  expect(await table.locator('tbody tr[data-row-id]').first().locator('small').evaluate(element => getComputedStyle(element).display)).toBe('block');
  await page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true }).fill('Disabled');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  await expect(table.getByText('disabled-user', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true }).fill('');
  await page.getByRole('button', { name: 'Load more accounts', exact: true }).click();
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(3);
  expect(state.reads.at(-1)).toBe(2);
  expect(state.reads.slice(0, -1).every(number => number === 1)).toBe(true);
  await expect(page.locator('input:not([type=search]),textarea,select:not(.data-table-page-size)')).toHaveCount(0);
  await expect(page.getByText(/Administrators can enroll existing Git identities and reset, enable or disable ordinary local accounts/)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('instance refresh denial removes private accounts and nonadmins never request inventory', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin/settings');
  await expect(page.getByText('disabled@example.invalid', { exact: true })).toBeVisible();
  state.denied = true;
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Instance administration required.');
  await expect(page.getByText('disabled@example.invalid', { exact: true })).toHaveCount(0);
  state.user.isInstanceAdmin = false;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Instance settings unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Local accounts', exact: true })).toHaveCount(0);
});


test('nonadministrators cannot initiate an instance inventory request', async ({ page }) => {
  const state = await backend(page, false);
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Instance settings unavailable', exact: true })).toBeVisible();
  expect(state.reads).toEqual([]);
});


test('ordinary local disable is explicit, password-confirmed and single-shot; administrators are protected', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin/settings');
  await expect(page.getByText('Protected administrator', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Disable local sign-in', exact: true }).click();
  const form = page.getByRole('form', { name: 'Disable local sign-in', exact: true });
  await form.getByLabel('Your Golf password').fill('secret-password-never-persist');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Disable local sign-in', exact: true }).click();
  await expect(form.getByLabel('Your Golf password')).toHaveValue('');
  await form.getByLabel('Your Golf password').fill('secret-password-never-persist');
  await form.getByRole('button', { name: 'Confirm disable local sign-in', exact: true }).click();
  await expect(page.getByText('Local sign-in disabled for next-account. 2 password sessions revoked.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.accountId).toBe('21');
  expect(state.writes[0]!.expectedCredentialVersion).toBe('1');
  expect(state.writes[0]!.passwordConfirmation).toBe('secret-password-never-persist');
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }))).not.toContain('secret-password-never-persist');
});

test('unconfirmed disable never retries and requires state inspection before another attempt', async ({ page }) => {
  const state = await backend(page); state.failWrite = true;
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Load more accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Disable local sign-in', exact: true }).click();
  await page.getByLabel('Your Golf password').fill('secret-password-never-persist');
  await page.getByRole('button', { name: 'Confirm disable local sign-in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No automatic retry');
  await expect(page.getByRole('button', { name: 'Disable local sign-in', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable local sign-in', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
});

test('global overview separates configuration coverage from account inventory', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin');
  await expect(page.getByRole('table', { name: 'Instance settings', exact: true })).toBeVisible();
  expect(state.reads).toHaveLength(0);
  await page.getByRole('link', { name: 'Local accounts', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Local accounts', exact: true })).toBeVisible();
});


test('failed logout during an in-flight disable retains unknown outcome until refreshed', async ({ page }) => {
  const state = await backend(page); state.logoutFail = true;
  let release!: () => void; state.waitWrite = new Promise<void>(resolve => { release = resolve; });
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Load more accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Disable local sign-in', exact: true }).click();
  await page.getByLabel('Your Golf password').fill('secret-password-never-persist');
  await page.getByRole('button', { name: 'Confirm disable local sign-in', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  release();
  await expect(page.getByText(/The disable outcome could not be confirmed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable local sign-in', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable local sign-in', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
