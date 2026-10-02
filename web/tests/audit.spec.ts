import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  AuditAction, AuditEventSchema, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema,
  ListAuditEventsRequestSchema, ListAuditEventsResponseSchema, ListCapabilitiesResponseSchema,
  ListRepositoriesResponseSchema, LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import type { ListAuditEventsResponse } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const events = [
  create(AuditEventSchema, { id: '9223372036854775806', occurredAt: '2026-10-02T12:00:01.123Z', action: AuditAction.SIGN_IN, actorSessionId: '9007199254740993', targetSessionId: '9007199254740993', credentialKind: 'pat', operationId: 'signin-private-operation', expiresAt: '2026-10-03T00:00:01.123Z' }),
  create(AuditEventSchema, { id: '9007199254740996', occurredAt: '2026-10-02T11:59:00Z', action: AuditAction.SIGN_OUT, actorSessionId: '9007199254740994', targetSessionId: '9007199254740994', credentialKind: 'oauth', operationId: 'logout-private-operation', revokedCount: 1n }),
  create(AuditEventSchema, { id: '9007199254740995', occurredAt: '2026-10-02T11:58:00Z', action: AuditAction.OTHER_SESSIONS_REVOKED, actorSessionId: '9007199254740993', credentialKind: 'oauth', operationId: 'bulk-private-operation', revokedCount: 9007199254740993n }),
  create(AuditEventSchema, { id: '9007199254740994', occurredAt: '2026-10-02T11:57:00Z', action: AuditAction.SESSION_REVOKED, actorSessionId: '9007199254740993', targetSessionId: '9007199254740995', credentialKind: 'pat', operationId: 'revoke-private-operation', revokedCount: 1n }),
  create(AuditEventSchema, { id: '9007199254740993', occurredAt: '2026-10-02T11:56:00Z', action: AuditAction.SESSION_REPLACED, actorSessionId: '9007199254740996', targetSessionId: '9007199254740996', credentialKind: 'pat', operationId: 'replacement-private-operation', revokedCount: 1n }),
];
type Failure = 'permission_denied' | 'unauthenticated' | 'unavailable';

async function backend(page: Page) {
  const state = { signedIn: true, events: [...events], inputs: [] as { beforeId: string; snapshotId: string }[], error: undefined as Failure | undefined,
    barrier: undefined as Promise<void> | undefined, corrupt: undefined as ((response: ListAuditEventsResponse) => void) | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [{ id: '1', name: 'private-repository', fullName: 'alex/private-repository', private: true }] });
    if (method === 'ListAuditEvents') {
      const input = request(route, ListAuditEventsRequestSchema);
      expect(input.limit).toBe(20);
      expect(route.request().method()).toBe('POST');
      state.inputs.push({ beforeId: input.beforeId, snapshotId: input.snapshotId });
      const snapshotId = input.snapshotId || state.events[0]?.id || '';
      const eligible = state.events.filter((event) => BigInt(event.id) <= BigInt(snapshotId) && (!input.beforeId || BigInt(event.id) < BigInt(input.beforeId)));
      const response = create(ListAuditEventsResponseSchema, { events: eligible.slice(0, 2), snapshotId, nextBeforeId: eligible.length > 2 ? eligible[1]!.id : '' });
      state.corrupt?.(response);
      if (state.barrier) await state.barrier;
      if (state.error) { if (state.error === 'unauthenticated') state.signedIn = false; return reject(route, state.error, state.error === 'unauthenticated' ? 'Your session expired.' : state.error === 'permission_denied' ? 'Account activity access denied.' : 'Account activity temporarily unavailable.'); }
      return respond(route, ListAuditEventsResponseSchema, response);
    }
    return reject(route, 'not_found', 'Unsupported fixture operation.');
  });
  return state;
}

test('activity preserves a snapshot through new events, exact IDs and all lifecycle metadata', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Account activity', exact: true })).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(2);
  await expect(page.getByText('History begins when session activity recording', { exact: false })).toBeVisible();
  const newest = create(AuditEventSchema, { ...events[0]!, id: '9223372036854775807', operationId: 'newer-private-operation' });
  state.events.unshift(newest);
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.locator('.audit-event')).toHaveCount(4);
  expect(state.inputs.at(-1)).toEqual({ beforeId: '9007199254740996', snapshotId: '9223372036854775806' });
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.locator('.audit-event')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Load more activity' })).toHaveCount(0);
  await expect(page.locator('.audit-event h3')).toHaveText(['Signed in', 'Signed out', 'Other sessions revoked', 'Session revoked', 'Session replaced']);
  for (const summary of await page.locator('.audit-event summary').all()) await summary.click();
  await expect(page.locator('.audit-event').first().getByText('9223372036854775806', { exact: true })).toHaveCount(2);
  await expect(page.locator('.audit-event').nth(2).locator('dd')).toContainText(['9007199254740995', 'bulk-private-operation', '9007199254740993', 'No individual target', '9007199254740993']);
  await expect(page.locator('.audit-metadata dt', { hasText: /^Session expiry$/ })).toHaveCount(1);
  await expect(page.locator('time[datetime="2026-10-02T12:00:01.123Z"]')).toHaveAttribute('title', '2026-10-02T12:00:01.123Z');
  await expect(page.getByText('newer-private-operation', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.locator('.audit-event')).toHaveCount(2);
  expect(state.inputs.at(-1)).toEqual({ beforeId: '', snapshotId: '' });
  await page.locator('.audit-event summary').first().click();
  await expect(page.getByText('newer-private-operation', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('private-operation');
  expect(new URL(page.url()).search).toBe('');
});

test('empty history is explicit and later successful events appear only after refresh', async ({ page }) => {
  const state = await backend(page); state.events = [];
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'No recorded account activity' })).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load more activity' })).toHaveCount(0);
  state.events = [events[0]!];
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.locator('.audit-event')).toHaveCount(1);
  await expect(page.getByText('1 loaded event', { exact: true })).toBeVisible();
});

test('denied continuation and refetch remove loaded history; retry starts a new snapshot', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/audit');
  await expect(page.locator('.audit-event')).toHaveCount(2);
  state.error = 'permission_denied';
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.getByRole('alert')).toHaveText('Account activity access denied.');
  await expect(page.locator('.audit-event')).toHaveCount(0);
  state.error = undefined;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.audit-event')).toHaveCount(2);
  expect(state.inputs.at(-1)).toEqual({ beforeId: '', snapshotId: '' });
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.getByText('Loading account activity…')).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(0);
  state.error = 'unavailable'; release();
  await expect(page.getByRole('alert')).toHaveText('Account activity temporarily unavailable.');
  await expect(page.locator('.audit-event')).toHaveCount(0);
});

for (const invalid of ['noncanonical cursor', 'changed snapshot', 'non-advancing event']) {
  test(`malformed ${invalid} refuses continuation without exposing old rows`, async ({ page }) => {
    const state = await backend(page);
    await page.goto('/audit');
    await expect(page.locator('.audit-event')).toHaveCount(2);
    state.corrupt = (response) => {
      if (invalid === 'noncanonical cursor') response.nextBeforeId = '09007199254740994';
      else if (invalid === 'changed snapshot') response.snapshotId = '9223372036854775807';
      else response.events[0] = create(AuditEventSchema, { ...response.events[0]!, id: '9007199254740996' });
    };
    await page.getByRole('button', { name: 'Load more activity' }).click();
    await expect(page.getByRole('alert')).toContainText('inconsistent history page');
    await expect(page.locator('.audit-event')).toHaveCount(0);
    state.corrupt = undefined;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.audit-event')).toHaveCount(2);
  });
}

test('leaving the view cancels private reads; reopening and deep reload request fresh history', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  expect(state.inputs).toEqual([]);
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Account activity', exact: true }).click();
  await expect(page).toHaveURL(/\/audit$/);
  await expect(page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Account activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.audit-event')).toHaveCount(2);
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.getByText('Loading account activity…')).toBeVisible();
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/ListAuditEvents'));
  await page.getByRole('link', { name: /Repositories/ }).click();
  await aborted;
  state.events = [events[4]!]; state.barrier = undefined; release();
  await page.goBack();
  await expect(page.locator('.audit-event')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Session replaced', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.audit-event')).toHaveCount(1);
  expect(state.inputs.at(-1)).toEqual({ beforeId: '', snapshotId: '' });
});

test('expired sessions clear history and return to sign-in', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/audit');
  await expect(page.locator('.audit-event')).toHaveCount(2);
  state.error = 'unauthenticated';
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Account activity' })).toHaveCount(0);
});

test('sign-out aborts pending history and another sign-in never reuses it', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/audit');
  await expect(page.locator('.audit-event')).toHaveCount(2);
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.locator('.account-activity section')).toHaveAttribute('aria-busy', 'true');
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/ListAuditEvents'));
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await aborted;
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(0);
  state.events = []; state.barrier = undefined; release();
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token').fill('fixture-only-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'No recorded account activity' })).toBeVisible();
  await expect(page.locator('.audit-event')).toHaveCount(0);
});

test('activity details remain plain text, accessible by keyboard, and fit dark desktop and light mobile', async ({ page }) => {
  const state = await backend(page);
  state.events = [create(AuditEventSchema, { ...events[0]!, operationId: '<img src=x onerror="window.executed=true">', actorSessionId: '9007199254741999' })];
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/audit');
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  const details = page.locator('.audit-event summary');
  await details.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.audit-event details')).toHaveAttribute('open', '');
  await expect(page.getByText('<img src=x onerror="window.executed=true">', { exact: true })).toBeVisible();
  await expect(page.locator('.audit-event img')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/activity-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Refresh activity' })).toBeVisible();
  await page.screenshot({ path: 'test-results/activity-light-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Account activity', exact: true }).focus();
  await expect(page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Account activity', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
