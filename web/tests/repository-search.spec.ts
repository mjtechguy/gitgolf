import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { GetSessionResponseSchema, GetAuthenticationOptionsResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { respond, reject } from './rpc';
import { featureBackend } from './feature-policy-fixture';

// Review screenshots against mocked native responses: GOLF_AI_SHOTS=/output/directory npx playwright test repository-search
const shots = process.env.GOLF_AI_SHOTS;
const C = '4be1c0de'.padEnd(40, 'a'), T = '9f00ba11'.padEnd(40, 'b');
const reason = 'Signed-in readers can search one repository by meaning: default-branch code (up to 2,000 files) and issue and pull request titles and descriptions. Access is checked on every search; results show the indexed commit, and newer pushes appear after reindexing.';
type Index = Record<string, unknown> | null;
const ready = (patch: Record<string, unknown> = {}) => ({ state: 'READY', served: true, model: '@cf/qwen/qwen3-embedding-0.6b', dimensions: 1024, commitId: C, indexedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  files: 214, chunks: 1318, skipped: 9, verified: true, error: '', updatedAt: new Date().toISOString(), ...patch });
const results = [
  { kind: 'code', score: 0.83, path: 'src/cache/lru.ts', startLine: 41, endLine: 100, excerpt: { startLine: 52, lines: ['  // Evict the least recently read entry once the cache is over budget.', '  evict(): void {', '    while (this.bytes > this.budget) {', '      const oldest = this.order.shift();', '      if (!oldest) return;', '      this.bytes -= this.entries.get(oldest)?.size ?? 0;', '      this.entries.delete(oldest);', '    }', '  }'] } },
  { kind: 'issue', score: 0.79, number: 18, title: 'Cache eviction drops entries that were just read', state: 'OPEN', startLine: 1, endLine: 5, excerpt: { startLine: 1, lines: ['Cache eviction drops entries that were just read', '', 'After a push the warm tree cache evicts entries that were read a moment ago.'] } },
  { kind: 'code', score: 0.71, path: 'src/cache/policy.ts', startLine: 1, endLine: 38, excerpt: { startLine: 9, lines: ['export const evictionPolicy = {', "  order: 'least-recently-read',", '  budgetBytes: 8 * 1024 * 1024,', '};'] } },
  { kind: 'pull', score: 0.66, number: 21, title: 'Bound the tree cache by bytes', state: 'CLOSED', startLine: 1, endLine: 4, excerpt: { startLine: 1, lines: ['Bound the tree cache by bytes', '', 'Replaces the entry count with a byte budget and evicts by last read.'] } },
];

async function backend(page: Page, { index = ready() as Index, canManage = false, capability = 4, available = true, filtered = 0, empty = false }: { index?: Index; canManage?: boolean; capability?: number; available?: boolean; filtered?: number; empty?: boolean } = {}) {
  const state = { index, actions: [] as string[], queries: [] as string[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '42', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'repository.semantic-search', label: 'Semantic search', state: capability, reason: capability === 1 ? 'Semantic search needs a Vectorize index, which the operator has not bound to this installation.' : reason }] });
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() as Record<string, string>;
    const status = () => ({ repositoryId: '11', available, reason: available ? '' : 'Semantic search is turned off for this repository by the repository policy.', notice: 'Semantic matches by meaning; exact text search is not available.', canManage, index: state.index });
    if (path === '/native/search/read' && body.action === 'status') return route.fulfill({ json: status() });
    if (path === '/native/search/read' && body.action === 'query') { state.queries.push(String(body.query)); return route.fulfill({ json: { ...status(), query: body.query, results: empty ? [] : results, filtered } }); }
    if (path === '/native/search') {
      state.actions.push(String(body.action));
      state.index = body.action === 'index' ? { ...(state.index || ready({ served: false, commitId: '', indexedAt: '', files: 0, chunks: 0, skipped: 0, verified: false })), state: 'PENDING', targetCommitId: '', targetModel: '', pending: 0, total: 0, progress: 0 } : { ...state.index, state: 'REMOVING', served: false };
      return route.fulfill({ json: status() });
    }
    return route.fulfill({ status: 501, json: { code: 'unimplemented', message: 'Fixture route not supplied.' } });
  });
  return state;
}
const page$ = (page: Page) => page.getByRole('region', { name: 'Search alex/edge-api' });
async function look(page: Page, appearance: string, layout: string, theme: string, width: number) {
  await page.addInitScript(([a, l, t]) => { localStorage.setItem('golf.appearance', a!); localStorage.setItem(`golf.layout.${a}`, l!); localStorage.setItem('golf.theme', t!); }, [appearance, layout, theme]);
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
}
async function shot(page: Page, name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true, animations: 'disabled' });
}

test('a reader searches by meaning: results grouped by code and discussions, excerpts marked, the indexed commit shown', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/edge-api/search?q=how%20are%20cache%20entries%20evicted');
  const region = page$(page);
  await expect(region.getByRole('heading', { level: 1, name: 'Search alex/edge-api' })).toBeVisible({ timeout: 20_000 });
  await expect(region.getByRole('status').filter({ hasText: 'matches' })).toHaveText('4 matches for “how are cache entries evicted”');
  const band = region.getByLabel('Search index', { exact: true });
  await expect(band).toContainText('Ready'); await expect(band).toContainText(C.slice(0, 12)); await expect(band).toContainText('1,318'); await expect(band).toContainText('9 skipped');
  const code = region.getByRole('region', { name: 'Code' });
  await expect(code.getByRole('listitem')).toHaveCount(2);
  await expect(code.getByRole('link', { name: 'src/cache/lru.ts' })).toHaveAttribute('href', new RegExp(`/alex/edge-api/blob/${C}/src/cache/lru\\.ts`));
  await expect(code.getByText('Lines 41–100')).toBeVisible();
  await expect(code.locator('mark').first()).toHaveText(/^(evict|cache)/i);
  const discussions = region.getByRole('region', { name: 'Issues and pull requests' });
  await expect(discussions.getByRole('link', { name: /Cache eviction drops entries that were just read #18/ })).toHaveAttribute('href', /\/alex\/edge-api\/issues\/18$/);
  await expect(discussions.getByRole('link', { name: /Bound the tree cache by bytes #21/ })).toHaveAttribute('href', /\/alex\/edge-api\/pull\/21$/);
  await expect(region.getByText('Semantic matches by meaning; exact text search is not available.', { exact: false })).toBeVisible();
  await expect(region).toContainText('excerpts are read from the repository now, not from the index');
  await expect(region.getByRole('button', { name: 'Build index' })).toHaveCount(0);
  // A new search navigates; each search is asked for once.
  await region.getByRole('searchbox', { name: 'Search by meaning' }).fill('byte budget');
  await region.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/alex\/edge-api\/search\?q=byte\+budget$|q=byte%20budget$/);
  await expect.poll(() => state.queries).toEqual(['how are cache entries evicted', 'byte budget']);
  await region.getByRole('searchbox', { name: 'Search by meaning' }).fill('a');
  await region.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveText('Search for at least 2 characters.');
});

test('hidden results are counted and no matches says so', async ({ page }) => {
  await backend(page, { filtered: 2, empty: true });
  await page.goto('/alex/edge-api/search?q=quantum%20flux');
  await expect(page$(page).getByRole('status').filter({ hasText: 'No matches' })).toHaveText('No matches for “quantum flux” · 2 hidden because the source changed, was removed or is not available to you');
});

test('an unindexed repository: readers are told who can build it; an administrator builds it', async ({ page }) => {
  await backend(page, { index: null });
  await page.goto('/alex/edge-api/search');
  await expect(page$(page).getByRole('heading', { name: 'This repository is not indexed yet' })).toBeVisible();
  await expect(page$(page)).toContainText('A repository administrator can build the index.');
  await expect(page$(page).getByRole('searchbox', { name: 'Search by meaning' })).toBeDisabled();
  await page.unrouteAll();
  const state = await backend(page, { index: null, canManage: true });
  await page.reload();
  await page$(page).getByRole('button', { name: 'Build index' }).click();
  await expect.poll(() => state.actions).toEqual(['index']);
  await expect(page$(page).getByLabel('Search index', { exact: true })).toContainText('Queued');
  await expect(page$(page).getByRole('heading', { name: 'Building the first index' })).toBeVisible();
});

test('a rebuild shows its progress while the previous index keeps answering', async ({ page }) => {
  await backend(page, { canManage: true, index: ready({ state: 'INDEXING', targetCommitId: T, targetModel: '@cf/baai/bge-m3', pending: 120, total: 200, progress: 40 }) });
  await page.goto('/alex/edge-api/search?q=cache');
  const region = page$(page);
  await expect(region.getByLabel('Search index', { exact: true })).toContainText('Indexing 40%');
  await expect(region.getByLabel('Search index', { exact: true })).toContainText('Building ' + T.slice(0, 12));
  await expect(region.getByRole('progressbar', { name: 'Indexing progress' })).toHaveAttribute('value', '40');
  await expect(region).toContainText('80 of 200 files and discussions embedded; searches use the previous index until this finishes.');
  await expect(region.getByRole('region', { name: 'Code' })).toBeVisible();
  await expect(region.getByRole('button', { name: 'Rebuild index' })).toHaveCount(0);
});

test('a failed build explains why; removal asks first and stops searches', async ({ page }) => {
  const state = await backend(page, { canManage: true, index: ready({ state: 'FAILED', error: "@cf/qwen/qwen3-embedding-0.6b returns 1024-dimension vectors but this installation's Vectorize index has 768. Re-create the index with enable-search --dimensions 1024, deploy, then build the index again." }) });
  await page.goto('/alex/edge-api/search');
  const region = page$(page);
  await expect(region.getByRole('alert')).toContainText('enable-search --dimensions 1024');
  await region.getByRole('button', { name: 'Remove index' }).click();
  const confirm = region.getByRole('alertdialog', { name: "Remove this repository's search index?" });
  await expect(confirm).toContainText('deletes its 1,318 vectors from Vectorize');
  await confirm.getByRole('button', { name: 'Keep index' }).click();
  await expect(confirm).toHaveCount(0); expect(state.actions).toEqual([]);
  await region.getByRole('button', { name: 'Remove index' }).click();
  await region.getByRole('alertdialog').getByRole('button', { name: 'Remove index' }).click();
  await expect.poll(() => state.actions).toEqual(['remove']);
  await expect(region.getByLabel('Search index', { exact: true })).toContainText('Removing');
});

test('unavailable: the installation reason, or the repository policy that turned it off', async ({ page }) => {
  await backend(page, { capability: 1 });
  await page.goto('/alex/edge-api/search');
  await expect(page.getByRole('heading', { name: 'Semantic search is not available here' })).toBeVisible();
  await expect(page.getByText('Semantic search needs a Vectorize index, which the operator has not bound to this installation.')).toBeVisible();
  await page.unrouteAll();
  await backend(page, { available: false });
  await page.reload();
  await expect(page$(page).getByRole('note')).toHaveText('Semantic search is turned off for this repository by the repository policy.');
  await expect(page$(page).getByRole('searchbox', { name: 'Search by meaning' })).toBeDisabled();
});

test('the repository header offers the search field only when the installation offers search', async ({ page }) => {
  await featureBackend(page);
  await page.goto('/alex/demo');
  await expect(page.getByRole('link', { name: /^Pull requests/ }).first()).toBeVisible();
  await expect(page.getByRole('search', { name: 'Search this repository by meaning' })).toHaveCount(0);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'repository.semantic-search', label: 'Semantic search', state: 3, reason }, { id: 'settings.repository-general', label: 'General', state: 3, reason: 'Available.' }] }));
  await page.reload();
  const field = page.getByRole('search', { name: 'Search this repository by meaning' });
  await field.getByRole('searchbox').fill('where is the deploy command');
  await field.getByRole('searchbox').press('Enter');
  await expect(page).toHaveURL(/\/alex\/demo\/search\?q=where/);
});

for (const [appearance, layout, theme] of [['flare', 'console', 'dark'], ['classic', 'primer', 'light'], ['golf', 'tiles', 'dark']] as const) for (const width of [1440, 390]) {
  test(`search screens in ${appearance} ${layout} ${theme} at ${width}`, async ({ page }) => {
    test.skip(!shots, 'Set GOLF_AI_SHOTS to write review screenshots.');
    const name = `${appearance}-${layout}-${theme}-${width}`;
    await look(page, appearance, layout, theme, width);
    await backend(page, { canManage: true });
    await page.goto('/alex/edge-api/search?q=how%20are%20cache%20entries%20evicted');
    // The first page of each look waits for the dev server's lazy chunks.
    await expect(page$(page).getByRole('region', { name: 'Code' })).toBeVisible({ timeout: 20_000 });
    await shot(page, `${name}-results`);
    await page.unrouteAll();
    await backend(page, { canManage: true, index: ready({ state: 'INDEXING', targetCommitId: T, targetModel: '@cf/baai/bge-m3', pending: 120, total: 200, progress: 40 }) });
    await page.goto('/alex/edge-api/search');
    await expect(page$(page).getByLabel('Search index', { exact: true })).toContainText('Indexing 40%');
    await shot(page, `${name}-indexing`);
    await page.unrouteAll();
    await backend(page, { index: null });
    await page.goto('/alex/edge-api/search');
    await expect(page$(page).getByRole('heading', { name: 'This repository is not indexed yet' })).toBeVisible();
    await shot(page, `${name}-not-indexed`);
    if (width === 1440) {
      await page.unrouteAll();
      await featureBackend(page);
      await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'repository.semantic-search', label: 'Semantic search', state: 3, reason }, { id: 'settings.repository-general', label: 'General', state: 3, reason: 'Available.' }] }));
      await page.goto('/alex/demo');
      await expect(page.getByRole('search', { name: 'Search this repository by meaning' })).toBeVisible();
      await shot(page, `${name}-header-field`);
    }
  });
}
