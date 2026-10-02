import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListLocalAccountsResponseSchema, ListLocalAccountsRequestSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page, admin = true) {
  const state = { denied: false, reads: [] as number[], user: create(UserSchema, { id: '9007199254740993', login: 'alex', isInstanceAdmin: admin }) };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListLocalAccounts') {
      const input = request(route, ListLocalAccountsRequestSchema); const number = input.page?.page ?? 1; state.reads.push(number);
      if (state.denied) return reject(route, 'permission_denied', 'Instance administration required.');
      return respond(route, ListLocalAccountsResponseSchema, { accounts: number === 1 ? [
        { id: '9007199254740997', username: 'alex', email: 'alex@example.invalid', nativeUserId: '9007199254740999', isInstanceAdmin: true, createdAt: '2026-10-02T10:00:00Z' },
        { id: '9007199254740998', username: 'disabled-user', email: 'disabled@example.invalid', nativeUserId: '9007199254740994', disabled: true, createdAt: '2026-10-01T10:00:00Z' },
      ] : [{ id: '21', username: 'next-account', nativeUserId: '22', createdAt: '2026-09-01T10:00:00Z' }], page: { nextPage: number === 1 ? 2 : 0 } });
    }
    return reject(route, 'not_found', 'Unsupported fixture.');
  });
  return state;
}

test('instance inventory preserves exact IDs, loaded search, paging and explicit operator-only lifecycle', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/admin/settings');
  const table = page.getByRole('table', { name: 'Local accounts', exact: true });
  await expect(table.getByText('9007199254740997', { exact: true })).toBeVisible();
  await expect(table.getByText('9007199254740999', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true }).fill('Disabled');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  await expect(table.getByText('disabled-user', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true }).fill('');
  await page.getByRole('button', { name: 'Load more accounts', exact: true }).click();
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(3);
  expect(state.reads.at(-1)).toBe(2);
  expect(state.reads.slice(0, -1).every(number => number === 1)).toBe(true);
  await expect(page.locator('input:not([type=search]),textarea,select')).toHaveCount(0);
  await expect(page.getByText(/Enrollment, reset, suspension and recovery still use operator commands/)).toBeVisible();
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
