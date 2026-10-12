import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GetRepositoryAccessResponseSchema, GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, SourceEntryType } from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, reject, request, respond } from './rpc';

const commit = 'a'.repeat(40);
async function backend(page: Page) {
  const state = { reads: [] as { path: string; ref: string }[], wrongCommit: false, malformedEntry: false, deniedFolder: false, repositoryId: '123', rootFile: 'PRIVATE_ROOT.ts' };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '123', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { id: state.repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: state.repositoryId } });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'main', commitId: commit }] });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, state.repositoryId, { owner: 'alex', name: 'demo' }, 'main', { main: commit });
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      state.reads.push({ path: input.path, ref: input.ref });
      const directory = input.path === '' || input.path === 'src' || input.path === 'untouched';
      if (input.path === 'src' && state.deniedFolder) return reject(route, 'permission_denied', 'Source access was removed.');
      const entries = !input.path ? [
        { name: 'src', path: 'src', type: SourceEntryType.DIRECTORY, sha: commit },
        { name: 'untouched', path: 'untouched', type: SourceEntryType.DIRECTORY, sha: commit },
        { name: state.rootFile, path: state.rootFile, type: SourceEntryType.FILE, sha: commit },
      ] : input.path === 'src' ? [{ name: '<literal> & file.ts', path: 'src/<literal> & file.ts', type: SourceEntryType.FILE, sha: commit }] : [{ name: 'UNLOADED_SECRET.ts', path: 'untouched/UNLOADED_SECRET.ts', type: SourceEntryType.FILE, sha: commit }];
      if (!input.path && state.malformedEntry) entries.push({ name: '..', path: '../outside', type: SourceEntryType.FILE, sha: commit });
      return respond(route, GetContentsResponseSchema, { repositoryId: state.repositoryId, commitId: !input.path && state.wrongCommit ? 'b'.repeat(40) : commit, path: input.path, kind: directory ? SourceEntryType.DIRECTORY : SourceEntryType.FILE,
        entries: directory ? entries : [], file: directory ? undefined : { entry: { name: input.path.split('/').at(-1), path: input.path, type: SourceEntryType.FILE, sha: commit, size: 20n }, content: 'export const demo = 1;' } });
    }
    return reject(route, 'unimplemented', 'Fixture procedure is unavailable: ' + method);
  });
  return state;
}

const navigator = (page: Page) => page.getByRole('navigation', { name: 'Repository files', exact: true });
test('lazy file tree expands only requested folders, uses exact pinned links and literal names', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/alex/demo/blob/${commit}/PRIVATE_ROOT.ts`);
  await expect(navigator(page).getByRole('link', { name: 'PRIVATE_ROOT.ts', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(state.reads.some(read => read.path === 'src' || read.path === 'untouched')).toBe(false);
  await navigator(page).getByRole('button', { name: 'Expand src', exact: true }).focus();
  await page.keyboard.press('Space');
  const source = navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true });
  await expect(source).toBeVisible();
  const href = await source.getAttribute('href');
  expect(decodeURIComponent(href!)).toContain(`/blob/${commit}/src/<literal> & file.ts`);
  expect(state.reads.filter(read => read.path === 'src').every(read => read.ref === commit)).toBe(true);
  expect(state.reads.some(read => read.path === 'untouched')).toBe(false);
  await source.click();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Plain text preview of <literal> & file.ts')).toContainText('export const demo');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE_ROOT|<literal>|src/);
});

test('filter covers expanded loaded entries without repository search or hidden folder reads', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/alex/demo/blob/${commit}/PRIVATE_ROOT.ts`);
  const filter = navigator(page).getByRole('searchbox', { name: 'Filter expanded folder entries' });
  await filter.fill('UNLOADED');
  await expect(navigator(page).getByText('No loaded entries match.', { exact: true })).toBeVisible();
  expect(state.reads.some(read => read.path === 'untouched')).toBe(false);
  await filter.fill('');
  await navigator(page).getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toBeVisible();
  await filter.fill('literal');
  await expect(navigator(page).getByRole('link', { name: 'src/<literal> & file.ts', exact: true })).toBeVisible();
  await filter.fill('');
  await navigator(page).getByRole('button', { name: 'Collapse src', exact: true }).click();
  await filter.fill('literal');
  await expect(navigator(page).getByText('No loaded entries match.', { exact: true })).toBeVisible();
});

test('deep file entry opens its ancestor and reload stays pinned', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/alex/demo/blob/${commit}/src/%3Cliteral%3E%20%26%20file.ts`);
  await expect(navigator(page).getByRole('button', { name: 'Collapse src', exact: true })).toBeVisible();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(state.reads.every(read => read.ref === commit)).toBe(true);
});

test('opening a directory selects and expands its own contents', async ({ page }) => {
  await backend(page);
  await page.goto(`/alex/demo/tree/${commit}/src`);
  await expect(navigator(page).getByRole('link', { name: 'src', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigator(page).getByRole('button', { name: 'Collapse src', exact: true })).toBeVisible();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toBeVisible();
});

test('deep traversal stops at32 levels and offers ordinary pinned directory navigation', async ({ page }) => {
  await backend(page);
  const directories = Array.from({ length: 34 }, (_, index) => `d${index + 1}`);
  const filePath = `${directories.join('/')}/deep.ts`;
  const reads: string[] = [];
  await page.route('**/rpc/golf.v1.RepositoryService/GetContents', route => {
    const input = request(route, GetContentsRequestSchema);
    reads.push(input.path);
    if (input.path === filePath) return respond(route, GetContentsResponseSchema, { repositoryId: '123', commitId: commit, path: filePath, kind: SourceEntryType.FILE, file: { entry: { name: 'deep.ts', path: filePath, type: SourceEntryType.FILE, sha: commit, size: 1n }, content: 'x' } });
    const level = input.path ? input.path.split('/').length : 0;
    const next = directories[level];
    return respond(route, GetContentsResponseSchema, { repositoryId: '123', commitId: commit, path: input.path, kind: SourceEntryType.DIRECTORY, entries: [{ name: next, path: [...directories.slice(0, level), next].join('/'), type: SourceEntryType.DIRECTORY, sha: commit }] });
  });
  await page.goto(`/alex/demo/blob/${commit}/${filePath}`);
  const nextPath = directories.slice(0, 33).join('/');
  await navigator(page).getByRole('button', { name: `Expand ${nextPath}`, exact: true }).click();
  await expect(navigator(page).getByRole('status')).toContainText('32 levels');
  await expect(navigator(page).getByRole('link', { name: 'd33', exact: true })).toHaveAttribute('href', new RegExp(`/tree/${commit}/${nextPath}`));
  expect(reads.filter(path => path !== filePath).every(path => !path || path.split('/').length <= 32)).toBe(true);
});

for (const failure of ['wrongCommit', 'malformedEntry', 'deniedFolder'] as const) test(`invalid or denied folder removes all private tree entries: ${failure}`, async ({ page }) => {
  const state = await backend(page);
  state[failure] = true;
  await page.goto(`/alex/demo/blob/${commit}/PRIVATE_ROOT.ts`);
  if (failure === 'deniedFolder') await navigator(page).getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(navigator(page).getByRole('alert')).toBeVisible();
  await expect(navigator(page).getByRole('link', { name: 'PRIVATE_ROOT.ts', exact: true })).toHaveCount(0);
  await expect(navigator(page).getByRole('button', { name: /Expand|Collapse/ })).toHaveCount(0);
  state[failure] = false;
  await navigator(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(navigator(page).getByRole('link', { name: 'PRIVATE_ROOT.ts', exact: true })).toBeVisible();
});

test('changing native repository identity discards expanded folders and filters', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/alex/demo/blob/${commit}/PRIVATE_ROOT.ts`);
  await navigator(page).getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(navigator(page).getByRole('link', { name: '<literal> & file.ts', exact: true })).toBeVisible();
  await navigator(page).getByRole('searchbox').fill('PRIVATE_ROOT');
  state.repositoryId = '124';
  state.rootFile = 'NEW_PRIVATE.ts';
  await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click();
  await expect(navigator(page).getByRole('searchbox')).toHaveValue('');
  await expect(navigator(page).getByRole('button', { name: 'Expand src', exact: true })).toBeVisible();
  await expect(navigator(page).getByRole('link', { name: 'NEW_PRIVATE.ts', exact: true })).toBeVisible();
  await expect(navigator(page).getByRole('link', { name: 'PRIVATE_ROOT.ts', exact: true })).toHaveCount(0);
});

for (const theme of ['dark', 'light']) test(`mobile file navigation collapses and has readable keyboard controls: ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(theme => localStorage.setItem('golf-theme', theme), theme);
  const state = await backend(page);
  await page.goto(`/alex/demo/blob/${commit}/PRIVATE_ROOT.ts`);
  const panel = page.locator('.source-navigator');
  await expect(panel).toBeVisible();
  await expect(navigator(page)).toHaveCount(0);
  expect(state.reads.some(read => read.path === '')).toBe(false);
  await panel.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(navigator(page).getByRole('link', { name: 'PRIVATE_ROOT.ts', exact: true })).toBeVisible();
  expect((await navigator(page).getByRole('button', { name: 'Expand src', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator('summary').click();
  await expect(navigator(page)).toHaveCount(0);
});
