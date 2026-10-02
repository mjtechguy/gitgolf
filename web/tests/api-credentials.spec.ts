import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  ApiCredentialSchema, CreateApiCredentialRequestSchema, CreateApiCredentialResponseSchema,
  GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListApiCredentialsRequestSchema,
  ListApiCredentialsResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema,
  LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, RevokeApiCredentialRequestSchema,
  RevokeApiCredentialResponseSchema, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const token = `golf_ro_${'a'.repeat(43)}`;
const sourceExpiry = '2099-10-02T14:00:00Z';
const originals = [
  create(ApiCredentialSchema, { id: '9007199254740995', label: 'Local reader', createdAt: '2026-10-02T12:00:00Z', expiresAt: '2099-10-02T13:00:00Z', sourceSessionId: '9007199254740989', sourceSessionActive: true }),
  create(ApiCredentialSchema, { id: '9007199254740994', label: '<img src=x onerror=alert(1)>', createdAt: '2026-10-02T11:00:00Z', expiresAt: '2026-10-02T12:00:00Z', revokedAt: '2026-10-02T11:30:00Z', sourceSessionId: '9007199254740988', sourceSessionActive: true }),
  create(ApiCredentialSchema, { id: '9007199254740993', label: 'Ended source', createdAt: '2026-10-02T10:00:00Z', expiresAt: '2099-10-02T12:00:00Z', sourceSessionId: '9007199254740987', sourceSessionActive: false }),
];
type Failure = 'permission_denied' | 'not_found' | 'unavailable' | 'unauthenticated';

async function backend(page: Page) {
  const state = {
    signedIn: true, user, credentials: originals.map((credential) => ({ ...credential })), pages: [] as number[],
    issued: [] as { label: string; lifetimeSeconds: number }[], revoked: [] as string[],
    errors: {} as Record<string, Failure>, dropCreation: false, emptySecret: false,
    createBarrier: undefined as Promise<void> | undefined, listBarrier: undefined as Promise<void> | undefined,
    revokeBarrier: undefined as Promise<void> | undefined,
  };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (state.errors[method]) {
      const code = state.errors[method];
      if (code === 'unauthenticated') state.signedIn = false;
      return reject(route, code, code === 'unauthenticated' ? 'Your session expired.' : code === 'unavailable' ? 'Credential service temporarily unavailable.' : 'Credential access denied.');
    }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'ListApiCredentials') {
      const input = request(route, ListApiCredentialsRequestSchema);
      expect(input.page?.limit).toBe(20);
      const number = input.page?.page || 1;
      state.pages.push(number);
      if (state.listBarrier) await state.listBarrier;
      return respond(route, ListApiCredentialsResponseSchema, { credentials: state.credentials.slice((number - 1) * 2, number * 2), page: { nextPage: state.credentials.length > number * 2 ? number + 1 : 0 }, currentSourceExpiresAt: sourceExpiry });
    }
    if (method === 'CreateApiCredential') {
      const input = request(route, CreateApiCredentialRequestSchema);
      state.issued.push({ label: input.label, lifetimeSeconds: input.lifetimeSeconds });
      const credential = create(ApiCredentialSchema, { ...originals[0]!, id: String(9007199254740996n + BigInt(state.issued.length - 1)), label: input.label, expiresAt: sourceExpiry });
      state.credentials.unshift(credential);
      if (state.createBarrier) await state.createBarrier;
      if (state.dropCreation) return route.abort('failed');
      return respond(route, CreateApiCredentialResponseSchema, { credential, token: state.emptySecret ? '' : token });
    }
    if (method === 'RevokeApiCredential') {
      const id = request(route, RevokeApiCredentialRequestSchema).credentialId;
      state.revoked.push(id);
      if (state.revokeBarrier) await state.revokeBarrier;
      const credential = state.credentials.find((entry) => entry.id === id);
      if (!credential) return reject(route, 'not_found', 'Credential access denied.');
      credential.revokedAt = '2026-10-02T12:30:00Z';
      return respond(route, RevokeApiCredentialResponseSchema, { credential });
    }
    return reject(route, 'not_found', 'Unsupported fixture operation.');
  });
  return state;
}

async function open(page: Page) {
  await page.goto('/account/api-credentials');
  await expect(page.getByRole('heading', { name: 'API credentials', exact: true })).toBeVisible();
  await expect(page.locator('.credential-row')).toHaveCount(2);
}
async function issue(page: Page, label = 'My read tool') {
  await page.getByLabel('Credential label', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Create API credential', exact: true }).click();
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveValue(token);
  await expect(page.getByRole('button', { name: 'Refresh credentials', exact: true })).toBeEnabled();
}
async function noStoredSecret(page: Page) {
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(token);
  expect(page.url()).not.toContain(token);
}

test('credential metadata paginates with exact IDs, native source status and literal labels', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'API credentials', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/api-credentials$/);
  await expect(page.locator('.credential-row')).toHaveCount(2);
  await expect(page.getByText('Not revoked or expired', { exact: true })).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('.credential-row img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke credential 9007199254740994', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more credentials', exact: true }).click();
  await expect(page.locator('.credential-row')).toHaveCount(3);
  await expect(page.getByText('Source session ended', { exact: true })).toBeVisible();
  expect(state.pages.at(-1)).toBe(2);
  await expect(page.locator('.credential-metadata code').filter({ hasText: '9007199254740987' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator('.credential-row')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'API credentials', exact: true })).toBeVisible();
  await noStoredSecret(page);
});

test('issuance shows the secret once, copies explicitly, caps expiry and keeps it out of storage', async ({ page, context }) => {
  const state = await backend(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await expect(page.getByLabel('Requested lifetime')).toHaveValue('3600');
  await page.getByLabel('Requested lifetime').selectOption('43200');
  await issue(page, '  My tool  ');
  expect(state.issued).toEqual([{ label: 'My tool', lifetimeSeconds: 43200 }]);
  await expect(page.getByRole('button', { name: 'Copy credential', exact: true })).toBeFocused();
  await expect(page.locator('.credential-secret time')).toHaveAttribute('datetime', sourceExpiry);
  await page.getByRole('button', { name: 'Copy credential', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await expect(page.getByRole('status').filter({ hasText: 'Credential copied' })).toBeVisible();
  await noStoredSecret(page);
  await page.getByRole('button', { name: 'Dismiss credential', exact: true }).click();
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Credential label', { exact: true })).toBeFocused();
  await expect(page.getByText('Secret dismissed. Golf cannot show it again.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My tool', exact: true })).toBeVisible();
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  expect(state.issued).toHaveLength(1);
});

test('synchronous submit events issue only once and unmount discards a late secret', async ({ page }) => {
  const state = await backend(page);
  let release!: () => void;
  state.createBarrier = new Promise<void>((resolve) => { release = resolve; });
  await open(page);
  await page.getByLabel('Credential label', { exact: true }).fill('Single submit');
  await page.locator('.credential-form-content form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.issued.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Account activity', exact: true }).click();
  release();
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'API credentials', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Single submit', exact: true })).toBeVisible();
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  expect(state.issued).toHaveLength(1);
  await noStoredSecret(page);
});

for (const failure of ['lost response', 'missing secret'] as const) {
  test(`${failure} requires metadata review and revocation before a separate issuance`, async ({ page }) => {
    const state = await backend(page);
    state.dropCreation = failure === 'lost response';
    state.emptySecret = failure === 'missing secret';
    await open(page);
    await page.getByLabel('Credential label', { exact: true }).fill('Lost issuance');
    await page.getByRole('button', { name: 'Create API credential', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Issuance outcome is unknown', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I reviewed the list; start a separate credential', exact: true })).toBeDisabled();
    expect(state.issued).toHaveLength(1);
    await page.getByRole('button', { name: 'Refresh credential list', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lost issuance', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Revoke credential 9007199254740996', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm revoke credential', exact: true }).click();
    await expect(page.getByText('API credential revoked.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
    state.dropCreation = false;
    state.emptySecret = false;
    await page.getByRole('button', { name: 'I reviewed the list; start a separate credential', exact: true }).click();
    await issue(page, 'Separate issuance');
    expect(state.issued).toHaveLength(2);
    expect(state.revoked).toEqual(['9007199254740996']);
  });
}

test('label validation uses UTF-8 bytes, controls and Unicode roundtrip before any request', async ({ page }) => {
  const state = await backend(page);
  await open(page);
  for (const invalid of ['é'.repeat(33), 'contains\tcontrol', '\ud800']) {
    const label = page.getByLabel('Credential label', { exact: true });
    if (invalid === '\ud800') {
      await label.evaluate((input) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, '\ud800');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    } else await label.fill(invalid);
    await page.getByRole('button', { name: 'Create API credential', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Use a label of 1–64 UTF-8 bytes without control characters.');
    await expect(label).toBeEnabled();
    expect(state.issued).toHaveLength(0);
  }
  await issue(page, 'é'.repeat(32));
  expect(state.issued[0]?.label).toBe('é'.repeat(32));
});

test('revoke confirmation is keyboard usable, deduplicates submissions and preserves source session', async ({ page }) => {
  const state = await backend(page);
  let release!: () => void;
  state.revokeBarrier = new Promise<void>((resolve) => { release = resolve; });
  await open(page);
  const target = page.getByRole('button', { name: 'Revoke credential 9007199254740995', exact: true });
  await target.click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(target).toBeFocused();
  expect(state.revoked).toEqual([]);
  await target.click();
  await page.getByRole('button', { name: 'Confirm revoke credential', exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state.revoked.length).toBe(1);
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('API credential revoked.', { exact: true })).toBeVisible();
  await expect(target).toHaveCount(0);
  expect(state.signedIn).toBe(true);
  await expect(page.getByRole('heading', { name: 'Local reader', exact: true })).toBeVisible();
});

test('denied pagination and revocation remove the one-time secret and earlier private rows', async ({ page }) => {
  const state = await backend(page);
  await open(page);
  await issue(page);
  state.errors.ListApiCredentials = 'permission_denied';
  await page.getByRole('button', { name: 'Load more credentials', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Credential access denied.');
  await expect(page.locator('.credential-row')).toHaveCount(0);
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  delete state.errors.ListApiCredentials;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.credential-row')).toHaveCount(2);
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  state.errors.RevokeApiCredential = 'not_found';
  await page.getByRole('button', { name: 'Revoke credential 9007199254740996', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke credential', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Credential access denied.');
  await expect(page.locator('.credential-row')).toHaveCount(0);
});

for (const transition of ['navigation', 'sign out', 'expiry'] as const) {
  test(`${transition} clears a displayed secret and cannot restore it on back navigation`, async ({ page }) => {
    const state = await backend(page);
    await open(page);
    await issue(page);
    if (transition === 'navigation') {
      await page.getByRole('link', { name: 'Repositories', exact: false }).first().click();
      await page.goBack();
    } else if (transition === 'sign out') {
      await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
      await page.getByText('Advanced token sign-in', { exact: true }).click();
      await page.getByLabel('Provider access token', { exact: true }).fill('fixture-token');
      await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
    } else {
      state.errors.ListApiCredentials = 'unauthenticated';
      await page.getByRole('button', { name: 'Load more credentials', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
    }
    await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
    expect(state.issued).toHaveLength(1);
    await noStoredSecret(page);
  });
}

test('account switch and empty list do not retain the previous account metadata', async ({ page }) => {
  const state = await backend(page);
  await open(page);
  await issue(page);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.user = create(UserSchema, { id: '9007199254740900', login: 'other', fullName: 'Other' });
  state.credentials = [];
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token', { exact: true }).fill('other-token');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No API credentials', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My read tool', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
});

test('pagehide clears the secret before a document can be frozen for browser history', async ({ page }) => {
  await backend(page);
  await open(page);
  await issue(page);
  const retained = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return Boolean(document.getElementById('new-api-credential'));
  });
  expect(retained).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My read tool', exact: true })).toBeVisible();
});

test('credential page is usable in dark and light mobile layouts', async ({ page }) => {
  await backend(page);
  await open(page);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/api-credentials-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await issue(page);
  await expect(page.getByRole('button', { name: 'Copy credential', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Dismiss credential', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('New API credential', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Credential label', { exact: true })).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/api-credentials-mobile-light.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
