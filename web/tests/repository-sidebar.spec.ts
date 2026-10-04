import { create, toJson } from '@bufbuild/protobuf';
import { expect, test, type Page } from '@playwright/test';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema,
  GetRepositoryOverviewRequestSchema, GetRepositoryOverviewResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema,
  ListCommitsResponseSchema, ListRepositoriesResponseSchema, LogoutResponseSchema,
  RepositoryOverviewSectionState as State, SourceEntryType, WatchRepositoryResponseSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond, resolveSourceFixture } from './rpc';

const head = 'a'.repeat(40), blob = 'b'.repeat(40), repositoryId = '9007199254740993';
const repository = { id: repositoryId, name: 'sidebar', fullName: 'alex/sidebar', defaultBranch: 'main', private: true,
  description: 'PRIVATE parent description', cloneUrl: 'https://forge.example/alex/sidebar.git', updatedAt: '2026-10-01T12:00:00Z' };
const overview = { repositoryId, repository: { owner: 'alex', name: 'sidebar' }, description: 'PRIVATE current description',
  website: 'https://example.com/developer', topics: ['developer-tools', 'private-topic'], licenseIds: ['MIT'], starsCount: '0', watchersCount: '2', forksCount: '1000',
  languages: [{ name: 'TypeScript', byteCount: '750' }, { name: 'Go', byteCount: '250' }], languagesState: State.AVAILABLE, licensesState: State.AVAILABLE };
async function fixture(page: Page) {
  const state = { signedIn: true, empty: false, denied: false, live: false, liveDenied: false, overviewError: '', held: undefined as Promise<void> | undefined,
    data: structuredClone(overview), methods: [] as string[], reads: [] as ReturnType<typeof request<typeof GetRepositoryOverviewRequestSchema>>[] };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!; state.methods.push(method);
    if (method === 'WatchRepository' && state.live) {
      const frame = (flag: number, body: unknown) => { const payload = Buffer.from(JSON.stringify(body)), header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]); };
      await new Promise(resolve => setTimeout(resolve, 150));
      if (state.liveDenied) return route.fulfill({ status: 200, contentType: 'application/connect+json', body: frame(2, { error: { code: 'permission_denied', message: 'Live repository access removed.' } }) });
      const input = JSON.parse(route.request().postDataBuffer()!.subarray(5).toString());
      const event = toJson(WatchRepositoryResponseSchema, create(WatchRepositoryResponseSchema, { repositoryId, cursor: '1', kind: input.cursor ? 'heartbeat' : 'reset' }));
      return route.fulfill({ status: 200, contentType: 'application/connect+json', body: Buffer.concat([frame(0, event), frame(0, { repositoryId, cursor: '1', kind: 'reconnect' }), frame(2, {})]) });
    }
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Session expired.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.denied ? reject(route, 'permission_denied', 'Repository inaccessible.') : respond(route, GetRepositoryResponseSchema, { repository: { ...repository, empty: state.empty } });
    if (method === 'GetRepositoryOverview') {
      state.reads.push(request(route, GetRepositoryOverviewRequestSchema)); const data = structuredClone(state.data);
      if (state.held) await state.held;
      if (state.overviewError) return reject(route, state.overviewError as 'permission_denied', 'Details unavailable.');
      return respond(route, GetRepositoryOverviewResponseSchema, data);
    }
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { repositoryId, branches: [{ name: 'main', commitId: head }] });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repositoryId, { owner: 'alex', name: 'sidebar' }, 'main', { main: head });
    if (method === 'ListCommits') { const input = request(route, ListCommitsRequestSchema); return respond(route, ListCommitsResponseSchema, { repositoryId, commitId: head, commits: [{ sha: head, message: 'Build sidebar', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }], path: input.path }); }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      if (!input.path || input.path === 'src') return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.DIRECTORY,
        entries: input.path ? [{ name: 'file.ts', path: 'src/file.ts', sha: blob, type: SourceEntryType.FILE }] : [{ name: 'README.md', path: 'README.md', sha: blob, type: SourceEntryType.FILE }, { name: 'src', path: 'src', sha: blob, type: SourceEntryType.DIRECTORY }] });
      return respond(route, GetContentsResponseSchema, { repositoryId, commitId: head, path: input.path, kind: SourceEntryType.FILE,
        file: { entry: { name: input.path.split('/').at(-1), path: input.path, sha: blob, type: SourceEntryType.FILE }, content: input.path === 'README.md' ? '# Sidebar fixture\nReadable documentation.' : 'export const value = true;' } });
    }
    return reject(route, 'unimplemented', 'Fixture procedure unavailable.');
  });
  return state;
}
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'About this repository' });

test('root About contains bounded real topics, licenses, totals and explicitly indexed languages', async ({ page }) => {
  const state = await fixture(page); await page.goto('/alex/sidebar'); const rail = sidebar(page);
  await expect(rail.getByText('PRIVATE current description', { exact: true })).toBeVisible();
  await expect(rail.getByRole('list', { name: 'Repository topics' })).toContainText('private-topic');
  await expect(rail.getByRole('list', { name: 'Repository statistics' })).toContainText('0stars');
  await expect(rail.getByRole('list', { name: 'Repository statistics' })).toContainText('1,000forks');
  await expect(rail.getByRole('region', { name: 'Licenses' })).toContainText('MIT');
  await expect(rail.getByRole('list', { name: 'Indexed language statistics' })).toContainText('TypeScript75.0%');
  await expect(rail).toContainText('not tied to this source snapshot');
  await expect(rail.getByRole('link', { name: 'example.com/developer' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(state.reads[0]).toMatchObject({ repositoryId, repository: { owner: 'alex', name: 'sidebar' } });
  await expect(rail.getByRole('heading', { name: /Contributors|Releases|Packages/ })).toHaveCount(0);
});

test('valid empty metadata does not revive the stale description or invent unknown totals', async ({ page }) => {
  const state = await fixture(page); state.data.description = ''; state.data.languages = []; state.data.licenseIds = [];
  delete (state.data as Partial<typeof overview>).watchersCount; await page.goto('/alex/sidebar');
  await expect(sidebar(page)).toContainText('No description provided.');
  await expect(sidebar(page)).not.toContainText('PRIVATE parent'); await expect(sidebar(page)).not.toContainText('watching');
  await expect(sidebar(page)).toContainText('No license identifiers reported.');
  await expect(sidebar(page)).toContainText('No classified language bytes reported.');
});

for (const stateValue of [State.UNAVAILABLE, State.ERROR]) test(`optional section ${stateValue} does not imply indexed empty success`, async ({ page }) => {
  const state = await fixture(page); state.data.languages = []; state.data.licenseIds = []; state.data.languagesState = stateValue; state.data.licensesState = stateValue;
  await page.goto('/alex/sidebar'); await expect(sidebar(page)).toContainText(stateValue === State.ERROR ? 'Language statistics could not be read.' : 'Language statistics unavailable.');
  await expect(sidebar(page)).not.toContainText('No classified language bytes');
});

const invalid: Record<string, (data: typeof overview) => void> = {
  'foreign identity': data => { data.repositoryId = '19'; },
  'foreign route': data => { data.repository.name = 'other'; },
  'noncanonical totals': data => { data.starsCount = '01'; },
  'overflow language sum': data => { data.languages = [{ name: 'Go', byteCount: '9223372036854775807' }, { name: 'C', byteCount: '1' }]; },
  'unavailable section with private data': data => { data.languagesState = State.UNAVAILABLE; },
  'duplicate topics': data => { data.topics = ['private-topic', 'private-topic']; },
  'unsafe website': data => { data.website = 'https://user:secret@example.com'; },
  'oversized UTF8 description': data => { data.description = '私'.repeat(700); },
};
for (const [name, corrupt] of Object.entries(invalid)) test(`rejects ${name} without displaying unbound metadata`, async ({ page }) => {
  const state = await fixture(page); corrupt(state.data); await page.goto('/alex/sidebar');
  await expect(sidebar(page)).toContainText('supported metadata contract');
  await expect(sidebar(page).getByRole('list', { name: 'Repository topics' })).toHaveCount(0);
  await expect(sidebar(page)).not.toContainText('PRIVATE current');
  await expect(sidebar(page)).not.toContainText('PRIVATE parent');
});

test('older deployments fall back only to already authorized basic metadata', async ({ page }) => {
  const state = await fixture(page); state.overviewError = 'unimplemented'; await page.goto('/alex/sidebar');
  await expect(sidebar(page)).toContainText('Additional repository details unavailable.');
  await expect(sidebar(page)).toContainText('PRIVATE parent description');
  await expect(sidebar(page).getByRole('list', { name: 'Repository statistics' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('heading', { name: 'Languages' })).toHaveCount(0);
});

test('empty root repositories get metadata without inventing source or refs', async ({ page }) => {
  const state = await fixture(page); state.empty = true; await page.goto('/alex/sidebar');
  await expect(page.getByRole('heading', { name: 'No commits yet.' })).toBeVisible();
  await expect(sidebar(page)).toContainText('PRIVATE current description');
  expect(state.methods.filter(method => ['GetContents', 'ResolveRepositorySource', 'ListBranches'].includes(method))).toEqual([]);
});

for (const suffix of [`/blob/${head}/src/file.ts`, `/tree/${head}/src`, '/commits', '/issues', '/pulls']) test(`no root metadata query in ${suffix}`, async ({ page }) => {
  const state = await fixture(page); await page.goto(`/alex/sidebar${suffix}`);
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true })).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0); expect(state.reads).toHaveLength(0);
});

test('explicit refresh hides old details and remains reachable in the shared live CSS state', async ({ page }) => {
  const state = await fixture(page); state.live = true; await page.goto('/alex/sidebar'); await expect(page.locator('.repository-browser')).toHaveClass(/live-connected/); await expect(sidebar(page)).toContainText('PRIVATE current description');
  const refresh = sidebar(page).getByRole('button', { name: 'Refresh repository details' }); await expect(refresh).toBeVisible();
  let release!: () => void; state.held = new Promise<void>(resolve => { release = resolve; });
  const reads = state.reads.length; await refresh.focus(); await page.keyboard.press('Enter'); await expect.poll(() => state.reads.length).toBe(reads + 1);
  await expect(sidebar(page)).not.toContainText('PRIVATE current'); await expect(sidebar(page).getByRole('list')).toHaveCount(0);
  state.overviewError = 'permission_denied'; release();
  await expect(sidebar(page)).toContainText('Details unavailable.'); await expect(sidebar(page)).not.toContainText('PRIVATE parent');
});

test('repository access revocation unmounts a held metadata read and fences its late private result', async ({ page }) => {
  const state = await fixture(page); await page.goto('/alex/sidebar'); await expect(sidebar(page)).toContainText('PRIVATE current description');
  let release!: () => void; state.held = new Promise<void>(resolve => { release = resolve; });
  const reads = state.reads.length; await sidebar(page).getByRole('button', { name: 'Refresh repository details' }).click(); await expect.poll(() => state.reads.length).toBe(reads + 1);
  state.denied = true; await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Repository inaccessible.'); release();
  await expect(sidebar(page)).toHaveCount(0); await expect(page.getByText('PRIVATE current description', { exact: true })).toHaveCount(0);
});

test('live private revocation clears nested overview data and cancels a late metadata result', async ({ page }) => {
  const state = await fixture(page); state.live = true; await page.goto('/alex/sidebar');
  await expect(page.locator('.repository-browser')).toHaveClass(/live-connected/); await expect(sidebar(page)).toContainText('PRIVATE current description');
  let release!: () => void; state.held = new Promise<void>(resolve => { release = resolve; }); const reads = state.reads.length;
  await sidebar(page).getByRole('button', { name: 'Refresh repository details' }).click(); await expect.poll(() => state.reads.length).toBe(reads + 1);
  state.liveDenied = true; await expect(page.getByRole('alert')).toContainText('Live repository access removed.'); release();
  await expect(sidebar(page)).toHaveCount(0); await expect(page.getByText('PRIVATE current description', { exact: true })).toHaveCount(0);
});

test('signout during a held read cannot restore private sidebar details or persist them in browser storage', async ({ page }) => {
  const state = await fixture(page); await page.goto('/alex/sidebar'); await expect(sidebar(page)).toContainText('PRIVATE current description');
  let release!: () => void; state.held = new Promise<void>(resolve => { release = resolve; });
  const reads = state.reads.length; await sidebar(page).getByRole('button', { name: 'Refresh repository details' }).click(); await expect.poll(() => state.reads.length).toBe(reads + 1);
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible(); release(); await expect(sidebar(page)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('PRIVATE');
});

for (const theme of ['dark', 'light']) for (const width of [390, 1280]) test(`root sidebar layout and keyboard controls at ${width}px ${theme}`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width, height: 1000 }); await page.goto('/alex/sidebar');
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await expect(sidebar(page)).toContainText('PRIVATE current description'); await expect(page.getByLabel('Rendered README.md')).toBeVisible();
  const rail = await sidebar(page).boundingBox(), toolbar = await page.locator('.repository-code-toolbar').boundingBox(), main = await page.locator('.repository-source-main').boundingBox();
  expect(rail).not.toBeNull(); expect(toolbar).not.toBeNull(); expect(main).not.toBeNull();
  if (width > 1000) { expect(Math.abs(rail!.y - toolbar!.y)).toBeLessThan(2); expect(toolbar!.x + toolbar!.width).toBeLessThan(rail!.x); }
  else { expect(rail!.y).toBeGreaterThan(main!.y + main!.height - 2); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await sidebar(page).getByRole('button', { name: 'Refresh repository details' }).focus(); expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Refresh repository details');
  expect(await sidebar(page).getByRole('heading', { name: 'About' }).evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
});
