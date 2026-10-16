import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { CreateRepositoryRequestSchema, CreateRepositoryResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryCreationRequestSchema, GetRepositoryCreationResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, LogoutResponseSchema, RepositoryCreationState, RepositorySchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import type { CreateRepositoryRequest } from '../src/gen/golf/v1/golf_pb';
import { ListProviderConnectionsResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const prefix = 'golf.repository-creation.';
type Outcome = 'unknown' | 'succeeded' | 'rejected' | 'transport' | 'mismatch' | 'forbidden';

async function backend(page: Page) {
  const state = { signedIn: true, userId: '9007199254740993', outcome: 'unknown' as Outcome,
    statusOutcome: 'unknown' as Outcome, noAccess: false, posts: [] as CreateRepositoryRequest[],
    checks: [] as string[], listed: false, incorrectRecord: false };
  await page.route('**/rpc/**', async (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    const user = create(UserSchema, { id: state.userId, login: state.userId === '42' ? 'bob' : 'alex' });
    if (procedure === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (procedure === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : reject(route, 'unauthenticated', 'Sign in required.');
    if (procedure === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session expired.');
    if (procedure === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    // The new-repository page lists personal provider connections for connected imports; this account has none.
    if (procedure === 'ListProviderConnections') return respond(route, ListProviderConnectionsResponseSchema, {});
    const first = state.posts.at(-1);
    const repository = create(RepositorySchema, { id: '73', name: first?.name || 'project', fullName: `alex/${first?.name || 'project'}`, private: first?.private ?? true, description: first?.description || '', updatedAt: '2026-10-02T00:00:00Z' });
    if (procedure === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: state.listed ? [repository] : [] });
    if (procedure === 'CreateRepository' || procedure === 'GetRepositoryCreation') {
      const posting = procedure === 'CreateRepository';
      const input = posting ? request(route, CreateRepositoryRequestSchema) : undefined;
      if (input) state.posts.push(input);
      const key = input?.idempotencyKey || request(route, GetRepositoryCreationRequestSchema).idempotencyKey;
      if (!posting) state.checks.push(key);
      const source = input || state.posts.at(-1)!;
      const outcome = posting ? state.outcome : state.statusOutcome;
      if (outcome === 'transport') return route.abort('failed');
      if (outcome === 'mismatch') return reject(route, 'failed_precondition', 'This request key is already bound to different inputs.');
      if (outcome === 'forbidden') return reject(route, 'permission_denied', 'Creation status is not accessible.');
      const creation = { id: '9007199254740999', idempotencyKey: key,
        requestedName: state.incorrectRecord ? 'different-project' : source.name, private: source.private,
        state: outcome === 'succeeded' ? RepositoryCreationState.SUCCEEDED : outcome === 'rejected' ? RepositoryCreationState.REJECTED : RepositoryCreationState.OUTCOME_UNKNOWN,
        repositoryId: outcome === 'succeeded' ? '73' : '' };
      if (outcome === 'succeeded' && !state.noAccess) state.listed = true;
      const response = { creation, repository: outcome === 'succeeded' && !state.noAccess ? { ...repository, name: source.name, fullName: `alex/${source.name}` } : undefined };
      return posting ? respond(route, CreateRepositoryResponseSchema, response) : respond(route, GetRepositoryCreationResponseSchema, response);
    }
    return reject(route, 'not_found', 'Method not found.');
  });
  return state;
}

async function submit(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository', exact: true }).click();
  await page.getByLabel('Repository name').fill('  recovery-project  ');
  await page.getByLabel('Description').fill('Private description that must not enter storage.');
  await page.getByRole('checkbox', { name: 'Private repository' }).uncheck();
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
}

async function stored(page: Page) {
  return page.evaluate((keyPrefix) => Object.entries(sessionStorage).filter(([key]) => key.startsWith(keyPrefix)), prefix);
}

test('unknown outcome freezes one UUID and exact payload; status observation completes it', async ({ page }) => {
  const state = await backend(page);
  await submit(page);
  await expect(page.getByText('Creation may still be running', { exact: false })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.idempotencyKey).toMatch(uuid);
  expect(state.posts[0]).toMatchObject({ name: 'recovery-project', description: 'Private description that must not enter storage.', private: false });
  for (const label of ['Repository name', 'Description', 'Private repository']) await expect(page.getByLabel(label, { exact: false })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  const saved = await stored(page);
  expect(saved).toHaveLength(1);
  expect(saved[0]![0]).toContain(`${new URL(page.url()).origin}:9007199254740993`);
  expect(JSON.parse(saved[0]![1])).toEqual({ key: state.posts[0]!.idempotencyKey, name: 'recovery-project', private: false });
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]).toEqual(state.posts[0]);
  state.statusOutcome = 'succeeded';
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'alex/recovery-project' })).toBeVisible();
  expect(state.checks).toEqual([state.posts[0]!.idempotencyKey]);
  expect(await stored(page)).toEqual([]);
});

test('transport failure permits same-key retry but never editing or automatic retry', async ({ page }) => {
  const state = await backend(page); state.outcome = 'transport';
  await submit(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Creation may still be running', { exact: false })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  await expect(page.getByLabel('Repository name')).toBeDisabled();
  state.outcome = 'unknown';
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]).toEqual(state.posts[0]);
});

test('synchronous duplicate submissions reserve only one browser intent', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository', exact: true }).click();
  await page.getByLabel('Repository name').fill('single-intent');
  await page.locator('.create-dialog form').evaluate((form) => {
    const element = form as HTMLFormElement;
    element.requestSubmit();
    element.requestSubmit();
  });
  await expect(page.getByText('Creation may still be running', { exact: false })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  const saved = await stored(page);
  expect(saved).toHaveLength(1);
  expect(JSON.parse(saved[0]![1]).key).toBe(state.posts[0]!.idempotencyKey);
});

test('closing and reload resume inspection only, without description or automatic POST', async ({ page }) => {
  const state = await backend(page);
  await submit(page);
  await expect(page.getByText('Creation may still be running', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Resume repository creation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check status' })).toBeFocused();
  await expect(page.getByLabel('Description')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Resume repository creation', exact: true }).click();
  await expect(page.getByText('This resumed intent supports status checks only', { exact: false })).toBeVisible();
  expect(state.posts).toHaveLength(1); expect(state.checks).toHaveLength(0);
  await page.getByRole('button', { name: 'Check status' }).press('Enter');
  await expect.poll(() => state.checks.length).toBe(1);
  expect(state.posts).toHaveLength(1);
});

test('recorded rejection alone unlocks an explicit new intent and UUID', async ({ page }) => {
  const state = await backend(page); state.outcome = 'rejected';
  await submit(page);
  await expect(page.getByText('Creation was rejected.', { exact: false })).toBeVisible();
  const key = state.posts[0]!.idempotencyKey;
  await expect(page.getByLabel('Repository name')).toBeDisabled();
  await page.getByRole('button', { name: 'Start a new request' }).click();
  await expect(page.getByLabel('Repository name')).toBeFocused();
  await page.getByLabel('Repository name').fill('different-name');
  state.outcome = 'succeeded';
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(state.posts[1]!.idempotencyKey).toMatch(uuid);
  expect(state.posts[1]!.idempotencyKey).not.toBe(key);
  expect(state.posts[1]!.name).toBe('different-name');
});

test('key mismatch and denied status never offer a replacement or retain a prior record', async ({ page }) => {
  const state = await backend(page); state.outcome = 'mismatch';
  await submit(page);
  await expect(page.getByRole('alert')).toContainText('bound to different inputs');
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  state.statusOutcome = 'rejected';
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Creation was rejected.', { exact: false })).toBeVisible();
  state.statusOutcome = 'forbidden';
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByRole('alert')).toHaveText('Creation status is not accessible.');
  await expect(page.getByText('Creation was rejected.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  await expect(page.getByLabel('Repository name')).toBeDisabled();
});

test('success without present access is evidence only, never a repository grant', async ({ page }) => {
  const state = await backend(page); state.outcome = 'succeeded'; state.noAccess = true;
  await submit(page);
  await expect(page.getByText('Creation succeeded, but Golf cannot currently confirm access', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'alex/recovery-project' })).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repository-creation-mobile.png', fullPage: true });
});

test('a mismatched returned creation record remains uncertain', async ({ page }) => {
  const state = await backend(page); state.outcome = 'succeeded'; state.incorrectRecord = true;
  await submit(page);
  await expect(page.getByRole('alert')).toContainText('does not match this request');
  await expect(page.getByText('Creation succeeded, but', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  expect(await stored(page)).toHaveLength(1);
});

for (const transition of ['signout', 'expiry', 'account-switch'] as const) {
  test(`${transition} clears pending private creation metadata`, async ({ page }) => {
    const state = await backend(page);
    await submit(page);
    await expect(page.getByText('Creation may still be running', { exact: false })).toBeVisible();
    if (transition === 'expiry') {
      state.signedIn = false;
      await page.getByRole('button', { name: 'Check status' }).click();
    } else if (transition === 'account-switch') {
      state.userId = '42';
      await page.reload();
    } else {
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
    }
    if (transition === 'account-switch') await expect(page.getByRole('button', { name: 'New repository', exact: true })).toBeVisible();
    else await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
    await expect.poll(() => stored(page)).toEqual([]);
    await expect(page.getByText('recovery-project', { exact: true })).toHaveCount(0);
    expect(state.posts).toHaveLength(1);
  });
}

test('blocked session storage fails before any create request', async ({ page }) => {
  const state = await backend(page);
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await submit(page);
  await expect(page.getByRole('alert')).toContainText('No request was sent');
  expect(state.posts).toHaveLength(0);
  await expect(page.getByLabel('Repository name')).toBeEnabled();
});

test('invalid names and UTF-8 byte limits stay editable without reserving an intent', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New repository', exact: true }).click();
  await page.getByLabel('Repository name').fill('bad name');
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('starting with a letter or number');
  await page.getByLabel('Repository name').fill('valid-name');
  await page.getByLabel('Description').fill('é'.repeat(1001));
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('2,000 UTF-8 bytes');
  expect(state.posts).toHaveLength(0); expect(await stored(page)).toEqual([]);
  await expect(page.getByLabel('Repository name')).toBeEnabled();
  await expect(page.getByLabel('Description')).toBeEnabled();
  await page.getByLabel('Description').evaluate((node) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, 'broken '+String.fromCharCode(0xd800));
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('invalid Unicode');
  expect(state.posts).toHaveLength(0); expect(await stored(page)).toEqual([]);
  await page.getByLabel('Description').fill('é'.repeat(1000));
  await page.getByRole('button', { name: 'Create repository', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]!.description).toBe('é'.repeat(1000));
});
