import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema,
  ListLocalAccountsRequestSchema, ListLocalAccountsResponseSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function inventory(page: Page, count = 55) {
  const state = { count, denied: false, reads: [] as number[] };
  await page.route('**/rpc/**', route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'owner', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListLocalAccounts') {
      const input = request(route, ListLocalAccountsRequestSchema);
      const number = input.page?.page || 1;
      expect(input.page?.limit).toBe(20);
      state.reads.push(number);
      if (state.denied) return reject(route, 'permission_denied', 'Instance administration required.');
      const start = (number - 1) * 20;
      const length = Math.max(0, Math.min(20, state.count - start));
      return respond(route, ListLocalAccountsResponseSchema, {
        accounts: Array.from({ length }, (_, i) => {
          const n = start + i + 1;
          const username = `account-${String(n).padStart(2, '0')}`;
          return { id: String(n + 100), username, email: `${username}@example.invalid`, nativeUserId: String(n + 200), credentialVersion: '1', createdAt: '2026-10-02T12:00:00Z' };
        }),
        page: { nextPage: start + length < state.count ? number + 1 : 0 },
      });
    }
    return reject(route, 'not_found', 'Unsupported fixture operation.');
  });
  await page.goto('/admin/settings');
  await expect(page.getByRole('table', { name: 'Local accounts', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(Math.min(20, state.count));
  return state;
}

const rows = (page: Page) => page.getByRole('table', { name: 'Local accounts', exact: true }).locator('tbody tr[data-row-id]');
const pager = (page: Page) => page.getByRole('navigation', { name: 'Local accounts pages', exact: true });
const next = (page: Page) => pager(page).getByRole('button', { name: 'Next loaded page', exact: true });
const previous = (page: Page) => pager(page).getByRole('button', { name: 'Previous loaded page', exact: true });
const size = (page: Page) => pager(page).getByRole('combobox', { name: 'Rows per page for Local accounts', exact: true });
const status = (page: Page) => pager(page).locator('.data-table-page-status');
const more = (page: Page) => page.getByRole('button', { name: 'Load more accounts', exact: true });

async function loadAll(page: Page) {
  await more(page).click();
  await expect(status(page)).toContainText('Page 1 of 2');
  await more(page).click();
  await expect(status(page)).toContainText('Page 1 of 3');
  await expect(more(page)).toHaveCount(0);
}

test('local pagination and server loading remain distinct, with all page sizes and bounded last pages', async ({ page }) => {
  const state = await inventory(page);
  const initialReads = [...state.reads];
  expect(initialReads.every(number => number === 1)).toBe(true);
  await expect(size(page)).toHaveValue('20');
  await expect(status(page)).toContainText('Page 1 of 1');
  await expect(previous(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await expect(more(page)).toBeEnabled();
  await more(page).click();
  await expect(status(page)).toContainText('Page 1 of 2');
  await expect(rows(page)).toHaveCount(20);
  const reads = state.reads.length;
  await next(page).click();
  await expect(status(page)).toContainText('Page 2 of 2');
  await expect(rows(page).first()).toContainText('account-21');
  expect(state.reads).toHaveLength(reads);
  await previous(page).click();
  await expect(rows(page).first()).toContainText('account-01');
  await size(page).selectOption('10');
  await expect(rows(page)).toHaveCount(10);
  await expect(status(page)).toContainText('Page 1 of 4');
  await next(page).click();
  await expect(rows(page).first()).toContainText('account-11');
  await more(page).click();
  await expect(status(page)).toContainText('Page 1 of 6');
  await expect(more(page)).toHaveCount(0);
  await size(page).selectOption('50');
  await expect(rows(page)).toHaveCount(50);
  await expect(status(page)).toContainText('Page 1 of 2');
  await next(page).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(status(page)).toContainText('Rows 51–55');
  await expect(next(page)).toBeDisabled();
  await previous(page).click();
  await expect(rows(page)).toHaveCount(50);
  expect(state.reads).toEqual([...initialReads, 2, 3]);
});

test('filtering and sorting cover all loaded rows and reset the local page without network requests', async ({ page }) => {
  const state = await inventory(page);
  await loadAll(page);
  const readsBeforeControls = [...state.reads];
  await next(page).click();
  await next(page).click();
  const search = page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true });
  await search.fill('account-03');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('account-03');
  await expect(status(page)).toContainText('Page 1 of 1');
  await expect(page.getByText('1 of 55 loaded', { exact: true })).toBeVisible();
  await expect(previous(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await search.fill('no-loaded-account');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('No loaded entries match your search.', { exact: true })).toBeVisible();
  await expect(status(page)).toContainText('Page 1 of 1');
  await expect(status(page)).toContainText('Rows 0–0');
  await search.fill('');
  await expect(rows(page)).toHaveCount(20);
  await next(page).click();
  const accountSort = page.getByRole('table', { name: 'Local accounts', exact: true }).getByRole('button', { name: 'Account', exact: true });
  await accountSort.click();
  await expect(status(page)).toContainText('Page 1 of 3');
  await accountSort.click();
  await expect(rows(page).first()).toContainText('account-55');
  await next(page).click();
  await expect(rows(page).first()).toContainText('account-35');
  expect(state.reads).toEqual(readsBeforeControls);
});

test('smaller refreshed inventories reset safely and denied data removes rows and pagination', async ({ page }) => {
  const state = await inventory(page);
  await loadAll(page);
  await next(page).click();
  await next(page).click();
  state.count = 7;
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(pager(page)).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true })).toBeVisible();
  state.count = 0;
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(pager(page)).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Local accounts', exact: true }).locator('thead')).toHaveCount(0);
  state.denied = true;
  await page.getByRole('button', { name: 'Refresh local accounts', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Instance administration required.');
  await expect(pager(page)).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Local accounts', exact: true })).toHaveCount(0);
});

test('pagination is keyboard accessible and reflows on charcoal and light mobile layouts', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await inventory(page);
  await more(page).click();
  await expect(status(page)).toContainText('Page 1 of 2');
  await next(page).focus();
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('Page 2 of 2');
  await previous(page).focus();
  await page.keyboard.press('Space');
  await expect(status(page)).toContainText('Page 1 of 2');
  await size(page).focus();
  await expect(size(page)).toBeFocused();
  await page.setViewportSize({ width: 320, height: 740 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await pager(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of [next(page), previous(page)]) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await expect(pager(page).getByText('Search, sorting and pages cover loaded entries only.', { exact: true })).toBeVisible();
  }
  expect(failures).toEqual([]);
});

for (const count of [0, 1, 10, 11]) test(`small inventory ${count} keeps only useful controls`, async ({ page }) => {
  await inventory(page, count);
  await expect(rows(page)).toHaveCount(count);
  await expect(pager(page)).toHaveCount(count > 10 ? 1 : 0);
  await expect(page.getByRole('searchbox', { name: 'Search loaded Local accounts', exact: true })).toHaveCount(count > 1 ? 1 : 0);
  if (count === 0) {
    await expect(page.getByRole('table', { name: 'Local accounts', exact: true }).locator('thead')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Local accounts', exact: true })).toContainText('No entries.');
  }
  if (count === 11) {
    await size(page).selectOption('10');
    await next(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(status(page)).toContainText('Rows 11–11');
  }
});
