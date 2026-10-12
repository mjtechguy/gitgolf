import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListSessionsRequestSchema, ListSessionsResponseSchema, RevokeOtherSessionsResponseSchema, RevokeSessionRequestSchema, RevokeSessionResponseSchema, SessionInfoSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const originalSessions = [
  create(SessionInfoSchema, { id: '9007199254740993', credentialKind: 'pat', current: true, createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-02T00:00:00Z' }),
  create(SessionInfoSchema, { id: '9007199254740994', credentialKind: 'oauth', createdAt: '2026-10-01T11:00:00Z', expiresAt: '2026-10-01T23:00:00Z' }),
  create(SessionInfoSchema, { id: '9007199254740995', credentialKind: '<img src=x onerror=alert(1)>', createdAt: 'invalid', expiresAt: 'invalid' }),
];
type Failure = 'permission_denied' | 'not_found' | 'unavailable' | 'unauthenticated';

async function backend(page: Page) {
  const state = { signedIn: true, sessions: [...originalSessions], pages: [] as number[], revoked: [] as string[], otherCalls: 0, otherCount: undefined as bigint | undefined, errors: {} as Record<string, Failure>, listBarrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = path.split('/').at(-1)!;
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (state.errors[method]) {
      const code = state.errors[method];
      if (code === 'unauthenticated') state.signedIn = false;
      return reject(route, code, code === 'unavailable' ? 'Sessions temporarily unavailable.' : code === 'unauthenticated' ? 'Your session expired.' : 'Session access denied.');
    }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [{ id: '1', name: 'kept-private', fullName: 'alex/kept-private', private: true }] });
    if (method === 'ListSessions') {
      const input = request(route, ListSessionsRequestSchema);
      expect(input.page?.limit).toBe(20);
      const number = input.page?.page || 1;
      state.pages.push(number);
      const sessions = state.sessions.slice((number - 1) * 2, number * 2);
      const nextPage = state.sessions.length > number * 2 ? number + 1 : 0;
      if (state.listBarrier) await state.listBarrier;
      return respond(route, ListSessionsResponseSchema, { sessions, page: { nextPage } });
    }
    if (method === 'RevokeSession') {
      const id = request(route, RevokeSessionRequestSchema).sessionId;
      state.revoked.push(id);
      const session = state.sessions.find((entry) => entry.id === id);
      if (!session) return reject(route, 'not_found', 'Session access denied.');
      state.sessions = state.sessions.filter((entry) => entry.id !== id);
      if (session.current) state.signedIn = false;
      return respond(route, RevokeSessionResponseSchema, { currentSessionRevoked: session.current });
    }
    if (method === 'RevokeOtherSessions') {
      state.otherCalls++;
      const revokedCount = state.otherCount ?? BigInt(state.sessions.filter((entry) => !entry.current).length);
      state.sessions = state.sessions.filter((entry) => entry.current);
      return respond(route, RevokeOtherSessionsResponseSchema, { revokedCount });
    }
    return reject(route, 'not_found', 'Method not found.');
  });
  return state;
}

async function openSessions(page: Page) {
  await page.goto('/');
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('link', { name: 'User settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your Golf sessions', exact:true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('sessions paginate, preserve IDs, confirm one revoke and return keyboard focus', async ({ page }) => {
  const state = await backend(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await openSessions(page);
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  await expect(page.getByText('Current session', { exact: true })).toBeVisible();
  await expect(page.getByText('This does not revoke your provider token', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Load more sessions' }).click();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(3);
  expect(state.pages).toContain(1);
  expect(state.pages.at(-1)).toBe(2);
  await expect(page.getByText('Time unavailable', { exact: true })).toHaveCount(2);
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id] img')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/sessions-dark.png', fullPage: true });
  const target = page.getByRole('button', { name: 'Revoke session 9007199254740994', exact: true });
  await target.click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  expect(state.revoked).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(target).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await target.click();
  await page.getByRole('button', { name: 'Confirm revoke session', exact: true }).click();
  await expect(page.getByText('Session revoked.', { exact: true })).toBeVisible();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  expect(state.revoked).toEqual(['9007199254740994']);
  expect(state.pages.at(-1)).toBe(1);
  await expect(page.getByText('9007199254740994', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', {name:'Your Golf sessions',exact:true})).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('900719925474099');
});

test('revoke others covers unloaded sessions, keeps this session and formats bigint counts', async ({ page }) => {
  const state = await backend(page);
  state.otherCount = 9007199254740993n;
  await openSessions(page);
  await page.getByRole('button', { name: 'Revoke all other sessions', exact: true }).click();
  await expect(page.getByText('including sessions not loaded', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.otherCalls).toBe(0);
  await page.getByRole('button', { name: 'Revoke all other sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke other sessions' }).click();
  await expect(page.getByText('9007199254740993 other sessions revoked.', { exact: true })).toBeVisible();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(1);
  await expect(page.getByText('Current session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke all other sessions', exact: true })).toBeDisabled();
  expect(state.signedIn).toBe(true);
  expect(state.otherCalls).toBe(1);
});

test('revoking current session signs out and removes all private content', async ({ page }) => {
  const state = await backend(page);
  await openSessions(page);
  await page.getByRole('button', { name: 'Revoke current session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Revoke this session and sign out?' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm revoke session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  expect(state.revoked).toEqual(['9007199254740993']);
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  await expect(page.getByText('alex/kept-private')).toHaveCount(0);
});

test('denied refresh and revoke hide prior rows; reopening waits for fresh data', async ({ page }) => {
  const state = await backend(page);
  await openSessions(page);
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  state.errors.ListSessions = 'permission_denied';
  await page.getByRole('button', { name: 'Load more sessions' }).click();
  await expect(page.getByRole('alert')).toHaveText('Session access denied.');
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  delete state.errors.ListSessions;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  state.errors.ListSessions = 'permission_denied';
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await expect(page.getByRole('alert')).toHaveText('Session access denied.');
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  delete state.errors.ListSessions;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  state.errors.RevokeSession = 'not_found';
  await page.getByRole('button', { name: 'Revoke session 9007199254740994', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke session', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Session access denied.');
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', {name:'Profile',exact:true}).click();
  let release!: () => void;
  state.listBarrier = new Promise<void>((resolve) => { release = resolve; });
  state.sessions = [originalSessions[0]!];
  await page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText('Loading sessions…')).toBeVisible();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  release();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('leaving the sessions page cancels an in-flight private list and returning starts fresh', async ({ page }) => {
  const state = await backend(page);
  await openSessions(page);
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', {name:'Profile',exact:true}).click();
  let release!: () => void;
  state.listBarrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText('Loading sessions…')).toBeVisible();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/ListSessions'));
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', {name:'Profile',exact:true}).click();
  await aborted;
  state.listBarrier = undefined;
  state.sessions = [create(SessionInfoSchema, { ...originalSessions[0]!, id: '9007199254741999' })];
  release();
  await page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText('9007199254741999', { exact: true })).toBeVisible();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(1);
  await expect(page.getByText('9007199254740993', { exact: true })).toHaveCount(0);
});

for (const method of ['ListSessions', 'RevokeSession', 'RevokeOtherSessions']) {
  test(`${method} expiry clears session and repository queries`, async ({ page }) => {
    const state = await backend(page);
    await openSessions(page);
    await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
    state.errors[method] = 'unauthenticated';
    if (method === 'ListSessions') await page.getByRole('button', { name: 'Refresh sessions' }).click();
    else {
      await page.getByRole('button', { name: method === 'RevokeSession' ? 'Revoke session 9007199254740994' : 'Revoke all other sessions', exact: true }).click();
      await page.getByRole('button', { name: method === 'RevokeSession' ? 'Confirm revoke session' : 'Confirm revoke other sessions', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
    await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(0);
    await expect(page.getByText('alex/kept-private')).toHaveCount(0);
  });
}

test('empty and unavailable sessions remain actionable in light mobile page', async ({ page }) => {
  const state = await backend(page);
  state.errors.ListSessions = 'unavailable';
  await page.goto('/');
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByLabel('Your account', { exact: true }).click();
  await page.getByRole('link', { name: 'User settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Sessions temporarily unavailable.');
  delete state.errors.ListSessions;
  state.sessions = [];
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No active sessions returned', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke all other sessions', exact: true })).toBeDisabled();
  state.sessions = [...originalSessions];
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await expect(page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/sessions-mobile-light.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', {name:'Your Golf sessions',exact:true})).toBeVisible();
});
