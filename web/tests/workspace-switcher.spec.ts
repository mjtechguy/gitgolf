import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetOrganizationRequestSchema, GetOrganizationResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListOrganizationsRequestSchema, ListOrganizationsResponseSchema, ListRepositoriesResponseSchema, ListTeamsResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page) {
  const state = { login: 'alex', signedIn: true, mode: 'ready', pages: [] as number[], barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    const user = { id: state.login === 'alex' ? '9007199254740993' : '9007199254740994', login: state.login };
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { id: '17', fullName: 'lab/project', name: 'project', private: true, empty: true } });
    if (method === 'GetOrganization') return respond(route, GetOrganizationResponseSchema, { organization: { id: '19', name: request(route, GetOrganizationRequestSchema).organization } });
    if (method === 'ListTeams') return respond(route, ListTeamsResponseSchema, {});
    if (method === 'ListOrganizations') {
      const input = request(route, ListOrganizationsRequestSchema); expect(input.page?.limit).toBe(20);
      const number = input.page?.page || 1; state.pages.push(number);
      if (state.barrier) await state.barrier;
      if (state.mode === 'denied') return reject(route, 'permission_denied', 'Organization browsing requires read:organization and provider permission.');
      if (state.mode === 'expired') { state.signedIn = false; return reject(route, 'unauthenticated', 'Your session ended.'); }
      if (state.mode === 'empty' || state.login !== 'alex') return respond(route, ListOrganizationsResponseSchema, {});
      return respond(route, ListOrganizationsResponseSchema, number === 1 ? { organizations: state.mode === 'empty-first' ? [] : [{ id: '9007199254740995', name: 'lab' }], page: { nextPage: 2 } } : { organizations: [{ id: '9007199254740996', name: 'second-lab' }] });
    }
    return reject(route, 'not_found', 'Unsupported workspace fixture.');
  });
  return state;
}
const chooser = (page: Page) => page.getByRole('navigation', { name: 'Choose workspace', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: 'Switch workspace', exact: true });

test('header switcher loads memberships only on demand and closes with keyboard focus restored', async ({ page }, testInfo) => {
  const state = await backend(page); await page.emulateMedia({ colorScheme: 'dark' }); await page.goto('/');
  await expect(trigger(page)).toBeVisible(); expect(state.pages).toHaveLength(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Switch workspace', exact: true })).toBeVisible();
  await trigger(page).focus(); await page.keyboard.press('Enter');
  await expect(chooser(page).getByRole('link', { name: 'lab', exact: true })).toBeVisible(); expect(state.pages.every(number => number === 1)).toBe(true);
  const initialRequests = state.pages.length;
  await page.screenshot({ path: testInfo.outputPath('switcher-dark.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(chooser(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await trigger(page).click(); await expect(chooser(page).getByRole('link', { name: 'lab', exact: true })).toBeVisible(); expect(state.pages.length).toBeGreaterThan(initialRequests); expect(state.pages.every(number => number === 1)).toBe(true);
  await chooser(page).getByRole('button', { name: 'Load more organizations', exact: true }).click();
  await expect(chooser(page).getByRole('link', { name: 'second-lab', exact: true })).toBeVisible(); expect(state.pages.at(-1)).toBe(2);
  await chooser(page).getByRole('link', { name: 'second-lab', exact: true }).click();
  await expect(page).toHaveURL(/\/organizations\/second-lab$/); await expect(chooser(page)).toHaveCount(0); await expect(trigger(page)).toHaveText('second-lab');
  await trigger(page).click(); await chooser(page).getByRole('link', { name: 'Personal workspace alex', exact: true }).click();
  await expect(page).toHaveURL(/\/$/); await expect(trigger(page)).toHaveText('alex');
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click(); await page.setViewportSize({ width: 320, height: 844 });
  await trigger(page).click(); await expect(chooser(page).getByRole('link', { name: 'lab', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('switcher-mobile.png'), fullPage: true });
});

test('repository owners never imply active organization and Browse organizations is explicit', async ({ page }) => {
  const state = await backend(page); await page.goto('/repositories/lab/project');
  await expect(trigger(page)).toHaveText('alex'); expect(state.pages).toHaveLength(0);
  await trigger(page).click(); await chooser(page).getByRole('link', { name: 'Browse organizations', exact: true }).click();
  await expect(page).toHaveURL(/\/organizations$/); await expect(chooser(page)).toHaveCount(0); await expect(trigger(page)).toHaveText('alex');
});

test('empty intermediate membership pages can advance and refresh denial removes prior rows', async ({ page }) => {
  const state = await backend(page); state.mode = 'empty-first'; await page.goto('/'); await trigger(page).click();
  await expect(chooser(page).getByText('No organization memberships in the loaded pages.', { exact: true })).toBeVisible();
  await chooser(page).getByRole('button', { name: 'Load more organizations', exact: true }).click();
  await expect(chooser(page).getByRole('link', { name: 'second-lab', exact: true })).toBeVisible();
  let release!: () => void; state.barrier = new Promise<void>(resolve => { release = resolve; }); state.mode = 'denied';
  await chooser(page).getByRole('button', { name: 'Refresh organizations', exact: true }).click();
  await expect(chooser(page).getByText('Loading organization memberships…', { exact: true })).toBeVisible();
  await expect(chooser(page).getByRole('link', { name: 'second-lab', exact: true })).toHaveCount(0); release(); state.barrier = undefined;
  await expect(chooser(page).getByRole('alert')).toHaveText(/read:organization/);
  await expect(chooser(page).getByRole('link', { name: 'Browse organizations', exact: true })).toBeVisible();
  await page.reload(); await expect(trigger(page)).toBeVisible(); await expect(chooser(page)).toHaveCount(0);
});

test('sign-out/account switch and expired membership checks discard private lists', async ({ page }) => {
  const state = await backend(page); await page.goto('/'); await trigger(page).click();
  await expect(chooser(page).getByRole('link', { name: 'lab', exact: true })).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await expect(chooser(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible();
  state.login = 'other'; await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('new-fixture-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(trigger(page)).toHaveText('other'); await trigger(page).click();
  await expect(chooser(page).getByText('No organization memberships in the loaded pages.', { exact: true })).toBeVisible();
  await expect(chooser(page).getByRole('link', { name: 'lab', exact: true })).toHaveCount(0);
  state.mode = 'expired'; await chooser(page).getByRole('button', { name: 'Refresh organizations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible(); await expect(chooser(page)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('second-lab');
});
