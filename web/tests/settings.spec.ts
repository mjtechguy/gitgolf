import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetRepositorySettingsResponseSchema, UpdateRepositorySettingsRequestSchema, UpdateRepositorySettingsResponseSchema, GetOrganizationResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, RepositorySettingsSchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page, admin = true) {
  const state = { user: create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex', isInstanceAdmin: admin }), settings: create(RepositorySettingsSchema, { repositoryId: '9007199254740997', ownerId: '9007199254740993', description: 'Original description', defaultBranch: 'main', hasIssues: true, hasWiki: false, hasPullRequests: true, canEdit: admin, revision: 'original-revision' }), writes: [] as unknown[], dropped: false, denied: false, barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'GetOrganization') return state.denied ? reject(route, 'not_found', 'Organization unavailable.') : respond(route, GetOrganizationResponseSchema, { organization: { id: '21', name: 'team', fullName: 'Team' } });
    if (method === 'GetRepositorySettings') return state.denied ? reject(route, 'permission_denied', 'Repository settings access denied.') : respond(route, GetRepositorySettingsResponseSchema, { settings: state.settings });
    if (method === 'UpdateRepositorySettings') {
      const input = request(route, UpdateRepositorySettingsRequestSchema);
      state.writes.push(input);
      if (input.description !== undefined) state.settings.description = input.description;
      if (input.hasWiki !== undefined) state.settings.hasWiki = input.hasWiki;
      state.settings.revision = 'updated-revision';
      if (state.barrier) await state.barrier;
      if (state.dropped) return route.abort('failed');
      return respond(route, UpdateRepositorySettingsResponseSchema, { settings: state.settings });
    }
    return reject(route, 'not_found', 'Unsupported settings fixture.');
  });
  return state;
}

test('personal coverage distinguishes supported settings from missing enforcement and searches all displayed rows', async ({ page }) => {
  await backend(page);
  await page.goto('/account/settings');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.locator('input:not([type=search]),textarea,select')).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Personal settings', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(11);
  await page.getByRole('searchbox', { name: 'Search loaded Personal settings', exact: true }).fill('MFA');
  await expect(table.getByText('Passwords, recovery and MFA', { exact: true })).toBeVisible();
  await expect(table.getByText('Not configurable yet', { exact: true })).toBeVisible();
  await expect(table.getByRole('button')).toHaveCount(3);
});

test('repository general editor cancels drafts and sends exact IDs/revision with only changed values', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('Original description', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toBeFocused();
  await page.getByLabel('Description', { exact: true }).fill('Cancelled draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Original description');
  await page.getByLabel('Description', { exact: true }).fill('<b>Literal description</b>');
  await page.getByLabel('Wiki', { exact: true }).selectOption('true');
  await page.getByRole('button', { name: 'Save repository settings', exact: true }).click();
  await expect(page.getByText('Repository settings saved.', { exact: true })).toBeVisible();
  await expect(page.getByText('<b>Literal description</b>', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ repository: { owner: 'alex', name: 'demo' }, repositoryId: '9007199254740997', ownerId: '9007199254740993', expectedRevision: 'original-revision', description: '<b>Literal description</b>', hasWiki: true }]);
  expect((state.writes[0] as Record<string, unknown>).hasIssues).toBeUndefined();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('duplicate settings submissions dispatch once and navigation discards a late receipt', async ({ page }) => {
  const state = await backend(page);
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.goto('/repositories/alex/demo/settings');
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('One dispatch');
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Repositories', exact: false }).click();
  release();
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('One dispatch', { exact: true })).toBeVisible();
  await expect(page.getByText('Repository settings saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Description', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('lost settings response blocks retry until current values are inspected and denial clears private values', async ({ page }) => {
  const state = await backend(page);
  state.dropped = true;
  await page.goto('/repositories/alex/demo/settings');
  await page.getByRole('button', { name: 'Edit general settings', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Applied without receipt');
  await page.getByRole('button', { name: 'Save repository settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save could not be confirmed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Inspect current repository settings', exact: true }).click();
  await expect(page.getByText('Applied without receipt', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  state.denied = true;
  await page.getByRole('button', { name: 'Refresh repository settings', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository settings access denied.');
  await expect(page.getByText('Applied without receipt', { exact: true })).toHaveCount(0);
});

test('read-only repository users get no edit action and non-admin instance settings deny access', async ({ page }) => {
  await backend(page, false);
  await page.goto('/repositories/alex/demo/settings');
  await expect(page.getByText('Original description', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit general settings', exact: true })).toHaveCount(0);
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Instance settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Instance settings', exact: true })).toHaveCount(0);
});

test('organization settings require membership, distinguish planned policy and fit mobile without global overflow', async ({ page }) => {
  const state = await backend(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/organizations/team/settings');
  await expect(page.getByRole('heading', { name: 'Organization settings', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Organization settings', exact: true });
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(10);
  await expect(table.getByText('CI, workflows and fork trust', { exact: true })).toBeVisible();
  await expect(page.locator('input:not([type=search]),textarea,select')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  state.denied = true;
  await page.reload();
  await expect(page.getByRole('table', { name: 'Organization settings', exact: true })).toHaveCount(0);
});
