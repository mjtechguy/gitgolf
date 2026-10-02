import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { BeginGiteaOAuthResponseSchema, GetAuthenticationOptionsResponseSchema, CapabilityState, RepositoryCreationState, CreateRepositoryRequestSchema, CreateRepositoryResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, LoginWithGiteaTokenRequestSchema, LoginWithGiteaTokenResponseSchema, LoginWithPasswordRequestSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, RepositorySchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import type { CreateRepositoryRequest } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const originalRepositories = [
  create(RepositorySchema, { id: '9007199254740992', name: 'design-system', fullName: 'alex/design-system', description: 'A shared foundation for our next idea.', private: true, htmlUrl: 'https://forge.example/alex/design-system', defaultBranch: 'main', updatedAt: '2026-10-01T12:00:00Z' }),
  create(RepositorySchema, { id: '9007199254740993', name: 'tiny-tools', fullName: 'alex/tiny-tools', description: 'Small tools for everyday work.', private: false, htmlUrl: 'https://forge.example/alex/tiny-tools', defaultBranch: 'main', updatedAt: '2026-09-30T10:00:00Z' }),
];
const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });

async function backend(page: Page, signedIn = true) {
  const state = { signedIn, oauthOptions: create(GetAuthenticationOptionsResponseSchema, { providerLabel: 'Gitea', localPasswordEnabled: true }), oauthUrl: 'https://forge.example/login/oauth/authorize?client_id=golf&state=server-state&code_challenge=server-challenge&code_challenge_method=S256', beginError: false, optionsError: false, beginCalls: 0, passwordCalls: 0, passwordWait: undefined as Promise<void> | undefined, passwordDenied: false, receivedUsername: '', receivedPassword: '', passwordAdmin: false, repositories: [...originalRepositories], rejectCreation: false, receivedToken: '', created: undefined as CreateRepositoryRequest | undefined };
  await page.route('**/rpc/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/rpc/golf.v1.SessionService/GetAuthenticationOptions') return state.optionsError ? reject(route, 'unavailable', 'Options unavailable.') : respond(route, GetAuthenticationOptionsResponseSchema, state.oauthOptions);
    if (path === '/rpc/golf.v1.SessionService/BeginGiteaOAuth') {
      state.beginCalls++;
      if (state.beginError || !state.oauthOptions.giteaOauthEnabled) return reject(route, 'unavailable', 'Gitea sign-in could not be started. Please try again.');
      return respond(route, BeginGiteaOAuthResponseSchema, { authorizationUrl: state.oauthUrl });
    }
    if (path === '/rpc/golf.v1.SessionService/LoginWithPassword') {
      const input = request(route, LoginWithPasswordRequestSchema);
      state.passwordCalls++;
      state.receivedUsername = input.username; state.receivedPassword = input.password;
      await state.passwordWait;
      if (state.passwordDenied) return reject(route, 'unauthenticated', 'INTERNAL_ACCOUNT_LOOKUP_DETAIL');
      state.signedIn = true;
      return respond(route, LoginWithPasswordResponseSchema, { user: { ...user, isInstanceAdmin: state.passwordAdmin } });
    }
    if (path === '/rpc/golf.v1.SessionService/LoginWithGiteaToken') {
      state.receivedToken = request(route, LoginWithGiteaTokenRequestSchema).token;
      if (state.receivedToken !== 'test-scoped-token') return reject(route, 'unauthenticated', 'Gitea did not accept this token.');
      state.signedIn = true;
      return respond(route, LoginWithGiteaTokenResponseSchema, { user });
    }
    if (path === '/rpc/golf.v1.SessionService/Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (path === '/rpc/golf.v1.SessionService/GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user: { ...user, isInstanceAdmin: state.passwordAdmin } }) : reject(route, 'unauthenticated', 'Sign in required.');
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session expired.');
    if (path === '/rpc/golf.v1.CapabilityService/ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [
      { id: 'repositories', label: 'Repositories', state: CapabilityState.READY, reason: 'Browse and create repositories on your connected Gitea instance. Check readiness for live dependency health.' },
      { id: 'agents', label: 'Agent workflows', state: CapabilityState.DISABLED, reason: 'Agent execution is planned and is not available in this build.' },
    ] });
    if (path === '/rpc/golf.v1.RepositoryService/CreateRepository') {
      const input = state.created = request(route, CreateRepositoryRequestSchema);
      const creation = { id: '1', idempotencyKey: input.idempotencyKey, requestedName: input.name, private: input.private, state: state.rejectCreation ? RepositoryCreationState.REJECTED : RepositoryCreationState.SUCCEEDED, repositoryId: state.rejectCreation ? '' : '3' };
      if (state.rejectCreation) return respond(route, CreateRepositoryResponseSchema, { creation });
      const repository = create(RepositorySchema, { ...originalRepositories[0]!, name: input.name, description: input.description, private: input.private ?? true, id: '3', fullName: `alex/${input.name}`, htmlUrl: `https://forge.example/alex/${input.name}` });
      state.repositories.push(repository);
      return respond(route, CreateRepositoryResponseSchema, { repository, creation });
    }
    if (path === '/rpc/golf.v1.RepositoryService/ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: state.repositories });
    return reject(route, 'not_found', 'Method not found.');
  });
  return state;
}

test('sign-in handles errors, establishes a session, and never persists the token', async ({ page }) => {
  const state = await backend(page, false);
  await page.goto('/');
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue to workspace' })).toBeDisabled();
  await page.getByLabel('Provider access token').fill('wrong');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Gitea did not accept this token.');
  await page.getByLabel('Provider access token').fill('test-scoped-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 2 })).toBeVisible();
  expect(state.receivedToken).toBe('test-scoped-token');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('test-scoped-token');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('Golf password sign-in clears the password while pending, prevents duplicate attempts and clears on logout', async ({ page }) => {
  const state = await backend(page, false);
  let release!: () => void;
  state.passwordWait = new Promise<void>((resolve) => { release = resolve; });
  await page.goto('/');
  await expect(page.getByLabel('Email or username', { exact: true })).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByLabel('Provider access token')).not.toBeVisible();
  await page.getByLabel('Email or username', { exact: true }).fill('alex');
  await page.getByLabel('Password', { exact: true }).fill('private-password-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => state.passwordCalls).toBe(1);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
  await page.getByRole('form', { name: 'Golf account sign-in' }).evaluate((form: HTMLFormElement) => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(state.passwordCalls).toBe(1);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('private-password-fixture');
  release();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 2 })).toBeVisible();
  expect(state.receivedUsername).toBe('alex'); expect(state.receivedPassword).toBe('private-password-fixture');
  await expect(page.getByText('Instance administrator', { exact: true })).toHaveCount(0);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email or username', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Provider access token')).not.toBeVisible();
});

test('password failures stay generic and editable, and only the verified session exposes an administrator label', async ({ page }) => {
  const state = await backend(page, false); state.passwordDenied = true;
  await page.goto('/');
  for (const username of ['unknown-account', 'alex']) {
    await page.getByLabel('Email or username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('wrong-private-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Sign-in could not be completed. Check your Golf email or username and password and try again.');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Email or username', { exact: true })).toBeEnabled();
    await expect(page.locator('body')).not.toContainText('INTERNAL_ACCOUNT_LOOKUP_DETAIL');
  }
  state.passwordDenied = false; state.passwordAdmin = true;
  await page.getByLabel('Password', { exact: true }).fill('correct-private-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Your account', { exact: true }).click();
  await expect(page.getByText('Instance administrator', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /admin/i })).toHaveCount(0);
});

test('Golf password form stays disabled until options are known and keeps both themes usable on mobile', async ({ page }) => {
  await backend(page, false);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/golf.v1.SessionService/GetAuthenticationOptions', async (route) => { await waiting; await route.fallback(); });
  await page.goto('/');
  await expect(page.getByLabel('Email or username', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Password', { exact: true })).toBeDisabled();
  release();
  await expect(page.getByLabel('Email or username', { exact: true })).toBeEnabled();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.screenshot({ path: 'test-results/password-login-dark.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/password-login-mobile-light.png', fullPage: true });
  await page.getByLabel('Email or username', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.getByLabel('Password', { exact: true }).fill('not-stored-on-pagehide');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('password throttling and availability errors give safe actionable feedback', async ({ page }) => {
  await backend(page, false);
  let code: 'resource_exhausted' | 'unavailable' = 'resource_exhausted';
  await page.route('**/golf.v1.SessionService/LoginWithPassword', (route) => reject(route, code, 'PRIVATE_BACKEND_DIAGNOSTIC'));
  await page.goto('/');
  await page.getByLabel('Email or username', { exact: true }).fill('alex');
  for (const [value, message] of [['resource_exhausted', 'Too many sign-in attempts. Wait a few minutes and try again.'], ['unavailable', 'Sign-in is temporarily unavailable. Try again later.']] as const) {
    code = value!;
    await page.getByLabel('Password', { exact: true }).fill('private-password-fixture');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(message!);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('PRIVATE_BACKEND_DIAGNOSTIC');
  }
});

test('repository filtering, safe links, theme persistence and mobile layout', async ({ page }) => {
  const state = await backend(page);
  state.repositories.push({ ...originalRepositories[0]!, id: '9', name: 'untrusted-link', fullName: 'alex/untrusted-link', htmlUrl: 'javascript:alert(1)' });
  await page.goto('/');
  await expect(page.locator('.repository-row')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Open alex/design-system in the repository interface' })).toHaveAttribute('href', 'https://forge.example/alex/design-system');
  await expect(page.getByRole('link', { name: 'Open alex/untrusted-link in Gitea' })).toHaveCount(0);
  await page.getByLabel('Repository visibility').selectOption('public');
  await expect(page.getByRole('heading', { name: 'alex/tiny-tools' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'alex/design-system' })).toHaveCount(0);
  await page.getByLabel('Repository visibility').selectOption('all');
  await page.getByLabel('Search loaded repositories').fill('design');
  await expect(page.getByRole('heading', { name: 'alex/tiny-tools' })).toHaveCount(0);
  await page.getByLabel('Search loaded repositories').clear();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Agent execution is planned')).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-dark.png', fullPage: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.screenshot({ path: 'test-results/workspace-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'New repository' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
});

test('private creation keeps actionable errors, refreshes repositories and signs out', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository' }).click();
  await expect(page.getByLabel('Repository name')).toBeFocused();
  await page.getByLabel('Repository name').fill('next-project');
  await page.getByLabel('Description').fill('An idea worth building.');
  await expect(page.getByRole('checkbox', { name: 'Private repository' })).toBeChecked();
  state.rejectCreation = true;
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByText('Creation was rejected.', { exact: false })).toBeVisible();
  expect(state.created).toMatchObject({ name: 'next-project', description: 'An idea worth building.', private: true });
  state.rejectCreation = false;
  const rejectedKey = state.created!.idempotencyKey;
  await page.getByRole('button', { name: 'Start a new request' }).click();
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect.poll(() => state.created?.idempotencyKey).not.toBe(rejectedKey);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'alex/next-project' })).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('alex/next-project')).toHaveCount(0);
});

test('session expiry clears repository content', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'alex/design-system' })).toBeVisible();
  state.signedIn = false;
  await page.getByRole('button', { name: 'Refresh repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('alex/design-system')).toHaveCount(0);
});

test('explicit public visibility preserves the optional false value over Connect', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository' }).click();
  await page.getByLabel('Repository name').fill('public-project');
  await page.getByRole('checkbox', { name: 'Private repository' }).uncheck();
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'alex/public-project' })).toBeVisible();
  expect(state.created?.private).toBe(false);
});

test('configured OAuth shows requested permissions and navigates through the generated begin procedure', async ({ page }) => {
  const state = await backend(page, false);
  state.oauthOptions.giteaOauthEnabled = true;
  state.oauthOptions.providerLabel = 'Team Gitea';
  state.oauthOptions.scopes = ['write:user', 'write:repository', 'write:issue', 'read:organization'];
  await page.route('https://forge.example/login/oauth/authorize?**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Gitea authorization fixture</h1>' }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with provider', exact: true })).toBeVisible();
  await expect(page.getByText('Continue through your connected provider.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requested permissions' })).toBeVisible();
  for (const scope of state.oauthOptions.scopes) await expect(page.locator('.oauth-permissions code').filter({ hasText: scope })).toBeVisible();
  await expect(page.getByLabel('Provider access token')).not.toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.screenshot({ path: 'test-results/oauth-login-dark.png', fullPage: true });
  await page.locator('.token-signin summary').focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Provider access token').fill('unused-bootstrap-secret');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toMatch(/unused-bootstrap-secret|server-state|server-challenge/);
  await page.getByRole('button', { name: 'Continue with provider', exact: true }).click();
  await expect(page).toHaveURL(state.oauthUrl);
  await expect(page.getByRole('heading', { name: 'Gitea authorization fixture' })).toBeVisible();
  expect(state.beginCalls).toBe(1);
  expect(state.receivedToken).toBe('');
  expect(errors).toEqual([]);
});

test('OAuth initiation failures and unsafe destinations stay inline without navigation', async ({ page }) => {
  const state = await backend(page, false);
  state.oauthOptions.giteaOauthEnabled = true;
  state.oauthOptions.scopes = ['read:user', 'read:repository'];
  state.beginError = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with provider', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Gitea sign-in could not be started. Please try again.');
  await expect(page).toHaveURL('http://127.0.0.1:4179/');
  state.beginError = false;
  for (const url of ['javascript:window.executed=true', 'data:text/html,<h1>Bad</h1>', 'https://user:private-password@forge.example/login/oauth/authorize']) {
    state.oauthUrl = url;
    await page.getByRole('button', { name: 'Continue with provider', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Golf received an invalid sign-in address. Try again or use an access token.');
    await expect(page).toHaveURL('http://127.0.0.1:4179/');
    expect(await page.evaluate(() => 'executed' in window)).toBe(false);
    await expect(page.locator('body')).not.toContainText('private-password');
  }
  await page.locator('.token-signin summary').click();
  await page.getByLabel('Provider access token').fill('test-scoped-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 2 })).toBeVisible();
});

test('unconfigured and unavailable sign-in options keep an explicit token fallback and allow retry', async ({ page }) => {
  const state = await backend(page, false);
  state.oauthOptions.localPasswordEnabled = false;
  await page.goto('/');
  await expect(page.getByText('Golf password sign-in is not enabled for this installation.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with provider', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Provider access token')).not.toBeVisible();
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await expect(page.getByLabel('Provider access token')).toBeVisible();
  expect(state.beginCalls).toBe(0);
  state.optionsError = true;
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText('Sign-in options could not be loaded. You can still use an access token.');
  await expect(page.getByLabel('Password', { exact: true })).toBeDisabled();
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await expect(page.getByLabel('Provider access token')).toBeVisible();
  state.optionsError = false;
  state.oauthOptions.giteaOauthEnabled = true;
  state.oauthOptions.scopes = ['read:user', 'read:repository'];
  await page.getByRole('button', { name: 'Retry sign-in options' }).click();
  await expect(page.getByRole('button', { name: 'Continue with provider', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/oauth-login-mobile-light.png', fullPage: true });
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.locator('.token-signin summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Provider access token')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('OAuth callback failures show only a generic error and never interrupt an authenticated workspace', async ({ page }) => {
  const state = await backend(page, false);
  await page.goto('/?auth_error=oauth_failed&error_description=private-provider-detail&code=private-code');
  await expect(page.getByRole('alert')).toHaveText('Provider sign-in could not be completed. Please try again or use an access token.');
  await expect(page.locator('body')).not.toContainText('private-provider-detail');
  await expect(page.locator('body')).not.toContainText('private-code');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/private-provider-detail|private-code/);
  await page.goto('/?auth_error=unrecognized-provider-detail');
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  state.signedIn = true;
  await page.goto('/?auth_error=oauth_failed');
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opening optional token sign-in preserves the desktop page layout', async ({ page }) => {
  await backend(page, false);
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const story = await page.locator('.login-story').boundingBox();
  const header = await page.locator('.login-header').boundingBox();
  const footer = await page.locator('.login-footer').boundingBox();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await expect(page.getByLabel('Provider access token')).toBeVisible();
  expect(await page.locator('.login-story').boundingBox()).toEqual(story);
  expect(await page.locator('.login-header').boundingBox()).toEqual(header);
  expect(await page.locator('.login-footer').boundingBox()).toEqual(footer);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
});


test('sidebar distinguishes repositories from the capabilities anchor', async ({ page }) => {
  await backend(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const repositories = nav.getByRole('link', { name: /^Repositories/ });
  const capabilities = nav.getByRole('link', { name: 'Capabilities', exact: true });
  await expect(repositories).toHaveClass(/active/);
  await expect(capabilities).not.toHaveClass(/active/);
  await expect(capabilities).not.toHaveAttribute('aria-current', 'page');
  await capabilities.click();
  await expect(page).toHaveURL(/#capabilities$/);
  await expect(capabilities).toHaveClass(/active/);
  await expect(repositories).not.toHaveClass(/active/);
  await expect(repositories).not.toHaveAttribute('aria-current', 'page');
  await repositories.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(repositories).toHaveClass(/active/);
  await expect(capabilities).not.toHaveClass(/active/);
  await page.goBack();
  await expect(capabilities).toHaveClass(/active/);
  await expect(repositories).not.toHaveClass(/active/);
});


test('workspace puts account and one persistent dark/light toggle in the upper-right header', async ({ page }) => {
  await backend(page);
  await page.goto('/');
  const header = page.locator('.topbar');
  await header.getByLabel('Your account', { exact: true }).click();
  await expect(header.locator('.account-dropdown')).toContainText('alex');
  await header.getByLabel('Your account', { exact: true }).click();
  await expect(page.getByText('Connected to Gitea', { exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar .theme-toggle')).toHaveCount(0);
  await expect(header.locator('.theme-toggle')).toHaveCount(1);
  const initial = await page.locator('html').getAttribute('data-theme');
  const next = initial === 'dark' ? 'light' : 'dark';
  await header.getByRole('button', { name: `Switch to ${next} theme`, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  await header.getByRole('button', { name: `Switch to ${initial} theme`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', initial!);
});


test('account icon contains settings and sign-out, with keyboard dismissal and real account links', async ({ page }) => {
  await backend(page);
  await page.goto('/');
  const account = page.getByLabel('Your account', { exact: true });
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'User settings', exact: true })).not.toBeVisible();
  await account.click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).not.toBeVisible();
  await expect(account).toBeFocused();
  await account.click();
  await page.getByRole('button', { name: 'User settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'User settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings).toContainText('Alex');
  await expect(settings.getByRole('button', { name: 'Manage sessions' })).toBeVisible();
  await expect(settings.getByRole('link', { name: 'API credentials' })).toHaveAttribute('href', '/account/api-credentials');
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await expect(account).toBeFocused();
});
