import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema,
  ListCommitsResponseSchema, ListRepositoriesResponseSchema, LogoutResponseSchema, RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const ref = 'a'.repeat(40), latest = 'b'.repeat(40), repositoryId = '9007199254740993';
type Invalid = 'path' | 'ref' | 'repository' | 'sha' | 'empty' | 'multiple' | 'date' | 'denied';

async function fixture(page: Page, count = 1) {
  const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
  const repository = create(RepositorySchema, { id: repositoryId, name: 'entry-history', fullName: 'alex/entry-history', private: true, defaultBranch: 'main', htmlUrl: 'https://forge.example/alex/entry-history' });
  const entries = Array.from({ length: count }, (_, i) => ({ name: `row-${String(i).padStart(3, '0')}.ts`, path: `row-${String(i).padStart(3, '0')}.ts`, type: SourceEntryType.FILE, sha: ref, size: 10n }));
  const state = { user, signedIn: true, hold: false, titlePrefix: 'PRIVATE', invalid: undefined as Invalid | undefined,
    calls: [] as ReturnType<typeof request<typeof ListCommitsRequestSchema>>[], held: [] as (() => void)[], active: 0, peak: 0 };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user: state.user }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'main', commitId: ref }] });
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      return respond(route, GetContentsResponseSchema, { commitId: ref, path: input.path, kind: SourceEntryType.DIRECTORY, entries });
    }
    if (method === 'ListCommits') {
      const input = request(route, ListCommitsRequestSchema); state.calls.push(input); state.active++; state.peak = Math.max(state.peak, state.active);
      const commit = { sha: state.invalid === 'sha' ? 'not-an-object-id' : latest, message: `${state.titlePrefix} ${state.user.login}: ${input.path}\n\nFull commit body`, authorName: 'Alex', authoredAt: state.invalid === 'date' ? 'invalid' : '2026-10-01T12:00:00Z' };
      const result = { path: state.invalid === 'path' ? 'wrong.ts' : input.path, commitId: state.invalid === 'ref' ? latest : input.ref, repositoryId: state.invalid === 'repository' ? '7' : input.repositoryId, commits: state.invalid === 'empty' ? [] : state.invalid === 'multiple' ? [commit, { ...commit, sha: 'c'.repeat(40) }] : [commit] };
      try {
        if (state.hold) await new Promise<void>(resolve => state.held.push(resolve));
        if (state.invalid === 'denied') return await reject(route, 'permission_denied', 'Not authorized.');
        return await respond(route, ListCommitsResponseSchema, result);
      } finally { state.active--; }
    }
    return reject(route, 'unimplemented', 'Fixture does not implement this procedure.');
  });
  return state;
}

const entry = (page: Page, path = 'row-000.ts') => page.getByLabel(`Latest change for ${path}`, { exact: true });

test('directory changes bind each visible path to the exact repository/snapshot and link the native latest commit', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE alex: row-000.ts');
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({ repository: { owner: 'alex', name: 'entry-history' }, path: 'row-000.ts', ref, repositoryId, page: { page: 1, limit: 1 } });
  await expect(entry(page).locator('time')).toHaveAttribute('datetime', '2026-10-01T12:00:00Z');
  await entry(page).getByRole('link').focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/commit/${latest}`));
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('PRIVATE');
});

test('1000-row directory does not eagerly request offscreen history and permits only three active row reads', async ({ page }) => {
  const state = await fixture(page, 1000); state.hold = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect.poll(() => state.calls.length).toBe(3);
  expect(state.active).toBe(3); expect(state.peak).toBe(3);
  expect(state.calls.some(call => call.path === 'row-050.ts')).toBe(false);
  state.hold = false; state.held.splice(0).forEach(release => release());
  await expect(entry(page).getByRole('link')).toBeVisible();
  await expect.poll(() => state.active).toBe(0);
  expect(state.calls.length).toBeLessThan(40); expect(state.peak).toBeLessThanOrEqual(3);
  await entry(page, 'row-050.ts').scrollIntoViewIfNeeded();
  await expect(entry(page, 'row-050.ts').getByRole('link')).toHaveText('PRIVATE alex: row-050.ts');
  expect(state.calls.some(call => call.path === 'row-999.ts')).toBe(false);
});

test('scrolling away cancels inflight and queued row reads before newly visible rows are fetched', async ({ page }) => {
  const state = await fixture(page, 1000); state.hold = true;
  const canceled: string[] = [];
  page.on('requestfailed', req => { if (req.url().endsWith('/ListCommits')) canceled.push(req.postDataJSON().path); });
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect.poll(() => state.calls.length).toBe(3);
  await entry(page, 'row-980.ts').scrollIntoViewIfNeeded();
  await expect.poll(() => canceled.length).toBeGreaterThan(0);
  await expect.poll(() => state.calls.some(call => Number(call.path.slice(4, 7)) >= 970)).toBe(true);
  // These original visible rows were queued behind the three held requests.
  expect(state.calls.some(call => call.path === 'row-005.ts')).toBe(false);
  state.hold = false; state.held.splice(0).forEach(release => release());
  await expect(entry(page, 'row-980.ts').getByRole('link')).toHaveText('PRIVATE alex: row-980.ts');
  await expect(entry(page)).toHaveText('Latest change not loaded');
});

for (const invalid of ['path', 'ref', 'repository', 'sha', 'empty', 'multiple', 'date', 'denied'] as Invalid[]) {
  test(`directory latest change refuses ${invalid} evidence`, async ({ page }) => {
    const state = await fixture(page); state.invalid = invalid;
    await page.goto(`/alex/entry-history/tree/${ref}`);
    await expect(entry(page)).toHaveText('Latest change unavailable');
    await expect(entry(page).getByRole('link')).toHaveCount(0);
    await expect(page.locator('.source-tree')).not.toContainText('PRIVATE');
  });
}

test('sign-out cancels queued/inflight changes and a new account cannot receive the old result', async ({ page }) => {
  const state = await fixture(page, 1000); state.hold = true;
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect.poll(() => state.calls.length).toBe(3);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.hold = false; state.held.splice(0).forEach(release => release());
  await expect(page.locator('.source-entry-commit')).toHaveCount(0);
  state.user = create(UserSchema, { id: '9007199254740994', login: 'sam', fullName: 'Sam' }); state.signedIn = true;
  await page.reload();
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE sam: row-000.ts');
  await expect(page.locator('main')).not.toContainText('PRIVATE alex');
});

for (const theme of ['light', 'dark']) test(`directory change metadata fits mobile ${theme} and escapes commit text`, async ({ page }) => {
  const state = await fixture(page, 2); state.titlePrefix = '<img src=x onerror="window.executed=true">';
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/alex/entry-history/tree/${ref}`);
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await expect(entry(page).getByRole('link')).toBeVisible();
  await expect(entry(page).getByRole('link')).toContainText('<img src=x');
  await expect(entry(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { executed?: boolean }).executed)).toBeUndefined();
  await expect(entry(page).locator('time')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
