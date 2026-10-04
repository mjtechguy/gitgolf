import { expect, test, type Page } from '@playwright/test';
import { GetSessionResponseSchema, GetRepositoryAccessResponseSchema, GetRepositoryRulesRequestSchema, GetRepositoryRulesResponseSchema, type GetRepositoryRulesResponse } from '../src/gen/golf/v1/golf_pb';
import { create, clone } from '@bufbuild/protobuf';
import { reject, request, respond } from './rpc';
const timestamp = '2026-10-04T00:00:00Z';
const initial = create(GetRepositoryRulesResponseSchema, { repositoryId: '9007199254740993', ownerId: '42', accessRevision: 'a'.repeat(64), rulesRevision: 'b'.repeat(64), branchProtections: [{ ruleName: 'release/**', priority: '-2', requiredApprovals: '9007199254740993', statusCheckContexts: ['test / matrix-a'], enableStatusCheck: true, requireSignedCommits: true, blockAdminMergeOverride: true, pushUsernames: ['alice'], protectedFilePatterns: '.github/workflows/**', createdAt: timestamp, updatedAt: timestamp }, { ruleName: 'main', priority: '10', requiredApprovals: '1', enablePush: true, createdAt: timestamp, updatedAt: timestamp }], tagProtections: [{ id: '9007199254740994', namePattern: 'v*', allowedUsernames: ['alice'], createdAt: timestamp, updatedAt: timestamp }], mergeConfiguration: { allowMergeCommits: true, allowSquashMerge: true, defaultMergeStyle: 'squash', defaultUpdateStyle: 'merge' } });
async function backend(page: Page, main = false, deniedAccess = false, canManage = false) {
 const state = { response: initial, denied: false, calls: 0, barrier: undefined as Promise<void> | undefined, reads: [] as unknown[] };
 await page.route('**/rpc/**', async route => {
  const method = route.request().url().split('/').at(-1);
  if(main && method === 'GetSession') return respond(route, GetSessionResponseSchema, {user:{id:'42',login:'alice'}});
  if(main && method === 'GetRepositoryAccess') { if(deniedAccess) return reject(route,'permission_denied','Current repository access is unavailable.'); return respond(route,GetRepositoryAccessResponseSchema,{access:{repositoryId:initial.repositoryId,ownerId:initial.ownerId,owner:{id:'42',login:'alice'},revision:initial.accessRevision,currentPermission:'owner',canManage}}); }
  expect(route.request().url()).toContain('/golf.v1.RepositoryRulesService/GetRepositoryRules'); const input = request(route, GetRepositoryRulesRequestSchema); state.reads.push(input); state.calls++;
  expect(input.repository).toMatchObject({ owner: 'alice', name: 'example' }); expect(input.repositoryId).toBe('9007199254740993'); expect(input.ownerId).toBe('42'); expect(input.expectedRevision).toBe('a'.repeat(64));
  if (state.barrier) await state.barrier;
  if (state.denied) return reject(route, 'permission_denied', 'Current rules authority is unavailable.');
  return respond(route, GetRepositoryRulesResponseSchema, state.response);
 });return state;
}
async function open(page: Page) { await page.goto('/tests/fixtures/rules.html'); await expect(page.getByRole('table', { name: 'Branch protection rules', exact: true })).toBeVisible(); }
const copy = (mutate: (r: GetRepositoryRulesResponse) => void) => { const r = clone(GetRepositoryRulesResponseSchema, initial); mutate(r); return r; };
test('read-only inventories show exact native flags, IDs and independent merge defaults', async ({ page }) => {
 const state = await backend(page); await open(page); await expect(page.getByText('9007199254740993', { exact: true })).toBeVisible(); await expect(page.getByText(/Default merge style: squash/)).toBeVisible(); await expect(page.getByText(/Protected publication and trusted approval/)).toBeVisible();
 await page.getByRole('button', { name: 'Inspect branch rule release/**' }).click(); const dialog = page.getByRole('dialog', { name: 'Branch rule release/**' }); await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Close rule details' })).toBeFocused(); await expect(dialog.getByText('test / matrix-a', { exact: true })).toBeVisible(); await expect(dialog.getByText('.github/workflows/**', { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'Inspect branch rule release/**' })).toBeFocused();
 await page.getByRole('button', { name: 'Inspect tag rule v*' }).click(); await expect(page.getByRole('dialog').getByText('9007199254740994', { exact: true })).toBeVisible(); expect(state.calls).toBe(1); await expect(page.locator('form')).toHaveCount(0);
});
test('numeric priorities sort exactly and search uses the common table', async ({ page }) => {
 const state = await backend(page); state.response = copy(r => { r.branchProtections = [{ ...r.branchProtections[0]!, ruleName: 'two', priority: '2' }, { ...r.branchProtections[0]!, ruleName: 'ten', priority: '10' }]; }); await open(page);
 const table = page.getByRole('table', { name: 'Branch protection rules' }); await table.getByRole('button', { name: 'Priority' }).click(); await expect(table.locator('tbody tr').first()).toContainText('two'); await table.getByRole('button', { name: 'Priority' }).click(); await expect(table.locator('tbody tr').first()).toContainText('ten'); await page.getByRole('searchbox', { name: 'Search loaded Branch protection rules' }).fill('two'); await expect(table.locator('tbody tr')).toHaveCount(1); expect(state.calls).toBe(1);
});
for (const kind of ['wrong repository', 'wrong owner', 'wrong revision', 'missing merge', 'duplicate branch', 'duplicate tag', 'overbound', 'bad priority', 'negative approvals', 'bad timestamp', 'unsafe text', 'unknown merge'] as const) test(`${kind} hides unverified private rules`, async ({ page }) => {
 const state = await backend(page); state.response = copy(r => { switch (kind) { case 'wrong repository': r.repositoryId = '13'; break; case 'wrong owner': r.ownerId = '43'; break; case 'wrong revision': r.accessRevision = 'c'.repeat(64); break; case 'missing merge': r.mergeConfiguration = undefined; break; case 'duplicate branch': r.branchProtections.push(r.branchProtections[0]!); break; case 'duplicate tag': r.tagProtections.push(r.tagProtections[0]!); break; case 'overbound': r.branchProtections = Array(101).fill(r.branchProtections[0]!); break; case 'bad priority': r.branchProtections[0]!.priority = '01'; break; case 'negative approvals': r.branchProtections[0]!.requiredApprovals = '-1'; break; case 'bad timestamp': r.tagProtections[0]!.createdAt = 'unknown'; break; case 'unsafe text': r.tagProtections[0]!.namePattern = 'v\u0000*'; break; case 'unknown merge': r.mergeConfiguration!.defaultMergeStyle = 'guess'; break; } }); await page.goto('/tests/fixtures/rules.html'); await expect(page.getByRole('alert')).toContainText('Repository rules could not be verified.'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByText('release/**', { exact: true })).toHaveCount(0);
});
test('empty whole arrays are honest empty inventories', async ({ page }) => {
 const state = await backend(page); state.response = copy(r => { r.branchProtections = []; r.tagProtections = []; }); await open(page); await expect(page.getByText('No branch protection rules were reported.')).toBeVisible(); await expect(page.getByText('No tag protection rules were reported.')).toBeVisible(); await expect(page.getByRole('button', { name: /Inspect .* rule/ })).toHaveCount(0);
});
test('native denial clears displayed rows and open details', async ({ page }) => {
 const state = await backend(page); await open(page); await page.getByRole('button', { name: 'Inspect branch rule release/**' }).click(); await page.keyboard.press('Escape'); state.denied = true; await page.getByRole('button', { name: 'Refresh repository rules' }).click(); await expect(page.getByRole('alert')).toHaveText('Current rules authority is unavailable.'); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
});
for (const action of ['Fixture sign out', 'Fixture target refresh'] as const) test(`${action} aborts held responses without restoring private content`, async ({ page }) => {
 const state = await backend(page); await open(page); let release!: () => void; state.barrier = new Promise<void>(r => { release = r; }); await page.getByRole('button', { name: 'Refresh repository rules' }).click(); await expect.poll(() => state.calls).toBe(2); await expect(page.getByRole('table')).toHaveCount(0); await page.getByRole('button', { name: action }).click(); release(); await expect(page.getByRole('table')).toHaveCount(0); await expect(page.getByText('release/**', { exact: true })).toHaveCount(0);
});
for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`${theme} ${width} compact tables and item details share global CSS`, async ({ page }) => {
 await page.addInitScript(t => localStorage.setItem('golf.theme', t), theme); await backend(page); await page.setViewportSize({ width, height: 1000 }); await open(page); await page.evaluate(() => document.fonts.ready); expect(await page.evaluate(() => document.fonts.check('16px Archivo'))).toBe(true); await expect(page.locator('html')).toHaveAttribute('data-theme', theme); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: `.tmp/rules-source-captures/${theme}-${width}-inventory.png` }); await page.getByRole('button', { name: 'Inspect branch rule release/**' }).click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: `.tmp/rules-source-captures/${theme}-${width}.png` });
});

 test('account switch cannot release a held previous account observation', async ({ page }) => {
  const state = await backend(page); await open(page); let release!: () => void; state.barrier = new Promise<void>(r => { release = r; }); await page.getByRole('button', { name: 'Refresh repository rules' }).click(); await expect.poll(() => state.calls).toBe(2); state.denied = true; await page.getByRole('button', { name: 'Fixture switch account' }).click(); release(); await expect(page.getByRole('alert')).toHaveText('Current rules authority is unavailable.'); await expect(page.getByRole('table')).toHaveCount(0);
 });

// The full route must use the shared contextual shell/client and allow readable
// archived/mirror observations even when current write controls are unavailable.
test('product rules route uses verified identity and one contextual settings navigation', async ({ page }) => {
 const state = await backend(page, true); await page.goto('/alice/example/settings/rules');
 await expect(page.getByRole('heading', { name: 'Rules and merge policy', exact: true })).toBeVisible();
 await expect(page.getByRole('navigation', { name: 'Repository settings', exact: true })).toHaveCount(1);
 await expect(page.getByRole('table', { name: 'Branch protection rules', exact: true })).toBeVisible();
 await expect(page.getByRole('navigation', { name: 'Repository settings', exact: true }).getByRole('link', { name: 'Rules and merge policy', exact: true })).toHaveAttribute('aria-current', 'page');
 // Main uses React development StrictMode: the aborted mount is followed by its remount read.
 expect(state.calls).toBe(2); await expect(page.getByRole('form')).toHaveCount(0);
});
test('product rules route refuses private inventory when parent access is denied', async ({ page }) => {
 const state = await backend(page, true, true); await page.goto('/alice/example/settings/rules');
 await expect(page.getByRole('alert')).toContainText('Current repository access is unavailable.');
 await expect(page.getByRole('table')).toHaveCount(0); expect(state.calls).toBe(0);
});

 test('product rules editor requires current administration and opens only on request', async ({ page }) => {
  const state = await backend(page, true, false, true); await page.goto('/alice/example/settings/rules');
  await expect(page.getByRole('heading', { name: 'Configure rules', exact: true })).toBeVisible();
  await expect(page.getByRole('form')).toHaveCount(0);
  await page.getByRole('button', {name:'Branch rule',exact:true}).click();
  await expect(page.getByLabel('Branch pattern',{exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Cancel',exact:true}).click();
  await expect(page.getByRole('form')).toHaveCount(0);
  state.denied=true; await page.getByRole('button',{name:'Refresh repository rules'}).click();
  await expect(page.getByRole('alert')).toHaveText('Current rules authority is unavailable.');
  await expect(page.getByRole('heading',{name:'Configure rules',exact:true})).toHaveCount(0);
 });
