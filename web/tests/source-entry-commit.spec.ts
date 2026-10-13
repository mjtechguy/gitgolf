import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema,
  ListCommitsResponseSchema, ListRepositoriesResponseSchema, LogoutResponseSchema, RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, reject, request, respond } from './rpc';

const ref = 'a'.repeat(40), latest = 'b'.repeat(40), repositoryId = '9007199254740993';
type Projection = { sha: string; message: string; authorName: string; authoredAt: string };
type Invalid = 'path' | 'ref' | 'repository' | 'sha' | 'empty' | 'multiple' | 'date' | 'denied';

async function fixture(page: Page, count = 1, showByDefault = true) {
  if (showByDefault) await page.addInitScript(() => localStorage.setItem('golf.source.latestChanges', 'show'));
  const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
  const repository = create(RepositorySchema, { id: repositoryId, name: 'entry-history', fullName: 'alex/entry-history', private: true, defaultBranch: 'main', htmlUrl: 'https://forge.example/alex/entry-history' });
  const entries = Array.from({ length: count }, (_, i) => ({ name: `row-${String(i).padStart(3, '0')}.ts`, path: `row-${String(i).padStart(3, '0')}.ts`, type: SourceEntryType.FILE, sha: ref, size: 10n }));
  const state = { user, signedIn: true, hold: false, titlePrefix: 'PRIVATE', invalid: undefined as Invalid | undefined,
    calls: [] as ReturnType<typeof request<typeof ListCommitsRequestSchema>>[], held: [] as (() => void)[], active: 0, peak: 0, projections: {} as Record<string, Projection>, sourceInputs: [] as ReturnType<typeof request<typeof GetContentsRequestSchema>>[], sourceWait: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user: state.user }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'main', commitId: ref }] });
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repositoryId, { owner: 'alex', name: 'entry-history' }, 'main', { main: ref });
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema); state.sourceInputs.push(input);
      if(state.sourceWait) await state.sourceWait;
      return respond(route, GetContentsResponseSchema, { repositoryId: repositoryId, commitId: ref, path: input.path, kind: SourceEntryType.DIRECTORY, entries:entries.map(entry=>({...entry,latestChange:state.projections[entry.path]})) });
    }
    if (method === 'ListCommits') {
      const input = request(route, ListCommitsRequestSchema);
      if (!input.path) return respond(route, ListCommitsResponseSchema, { repositoryId: input.repositoryId, commitId: input.ref, commits: [{ sha: input.ref, message: 'Latest repository commit', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] });
      state.calls.push(input); state.active++; state.peak = Math.max(state.peak, state.active);
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

test('directory renders files before optional latest-change reads', async ({ page }) => {
  const state = await fixture(page, 32, false);
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(page.locator('.source-tree>li')).toHaveCount(32);
  await expect(page.locator('.source-entry-commit')).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
  await page.getByRole('button', {name:'Show latest changes'}).click();
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE alex: row-000.ts');
  expect(state.calls.length).toBeGreaterThan(0);
  await page.getByRole('button', {name:'Hide latest changes'}).click();
  await expect(page.locator('.source-entry-commit')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', {name:'Show latest changes'})).toBeVisible();
});

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


for (const theme of ['dark', 'light']) for (const width of [320, 390, 1280, 1920, 2560]) {
  test(`repository work surface stays centered and bounds long filenames at ${width}px ${theme}`, async ({ page }) => {
    // This measures the standard arrangement; layout-presets.spec.ts covers panes.
    await page.addInitScript(() => localStorage.setItem('golf.layout.golf', 'refined'));
    await fixture(page);
    const path = 'a-very-long-literal-filename-' + 'detail-'.repeat(27) + '.ts';
    await page.route('**/rpc/golf.v1.RepositoryService/GetContents', async route => respond(route, GetContentsResponseSchema, { repositoryId: repositoryId,
      commitId: ref, path: '', kind: SourceEntryType.DIRECTORY,
      entries: [{ name: path, path, type: SourceEntryType.FILE, sha: ref, size: 10n }],
    }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/alex/entry-history/tree/${ref}`);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(entry(page, path).getByRole('link')).toBeVisible();
    const sourceLink = page.locator('.source-tree>li>a');
    await expect(sourceLink).toHaveAttribute('title', path);
    await expect(sourceLink).toHaveAccessibleName(`${path} File 10 B`);
    const measurements = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const row = document.querySelector('.source-tree>li')!;
      const link = row.querySelector('a')!;
      const name = row.querySelector('.source-name')!;
      return { pageWidth: document.documentElement.scrollWidth, main: main.getBoundingClientRect().width,
        row: row.getBoundingClientRect().height, firstRow: row.getBoundingClientRect().top,
        target: link.getBoundingClientRect().height, bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        nameFont: parseFloat(getComputedStyle(name).fontSize), ellipsis: getComputedStyle(name).textOverflow };
    });
    expect(measurements.pageWidth).toBe(width);
    expect(measurements.main).toBe(Math.min(width, 1440));
    const centered = await page.locator('main').boundingBox();
    expect(centered!.x).toBe((width - measurements.main) / 2);
    expect(measurements.bodyFont).toBeGreaterThanOrEqual(14);
    expect(measurements.nameFont).toBeGreaterThanOrEqual(14);
    expect(measurements.ellipsis).toBe('ellipsis');
    if (width > 720) { expect(measurements.row).toBeLessThanOrEqual(44); expect(measurements.firstRow).toBeLessThan(330); }
    else expect(measurements.target).toBeGreaterThanOrEqual(44);
    await expect(entry(page, path).locator('time')).toBeVisible();
    await sourceLink.focus(); await expect(sourceLink).toBeFocused();
    await page.screenshot({ path: `test-results/repository-density-${theme}-${width}.png` });
  });
}

// Date-only cases deliberately leave density fixtures unchanged.
async function datedSource(page: Page, authoredAt: string) {
  await fixture(page);
  await page.clock.setFixedTime(new Date('2026-10-03T12:00:00Z'));
  await page.route('**/rpc/golf.v1.RepositoryService/ListCommits', async route => {
    const input = request(route, ListCommitsRequestSchema);
    return respond(route, ListCommitsResponseSchema, {
      path: input.path, commitId: input.ref, repositoryId: input.repositoryId,
      commits: [{ sha: latest, message: 'Exact latest change', authorName: 'Alex', authoredAt }],
    });
  });
}

for (const [seconds, label] of [
  [-2, 'just now'], [2, 'in a moment'], [-15, '15 seconds ago'], [-75, '1 minute ago'],
  [-7200, '2 hours ago'], [-172800, '2 days ago'], [-5184000, '2 months ago'],
  [-34560000, '1 year ago'], [172800, 'in 2 days'],
] as const) test(`source edit time renders ${label} with exact timestamp and tooltip`, async ({ page }) => {
  const authoredAt = new Date(Date.parse('2026-10-03T12:00:00Z') + seconds * 1000).toISOString();
  await datedSource(page, authoredAt);
  await page.goto(`/alex/entry-history/tree/${ref}`);
  const time = entry(page).locator('time');
  await expect(time).toHaveText(label);
  await expect(time).toHaveAttribute('datetime', authoredAt);
  await expect(time).toHaveAttribute('title', await page.evaluate(value => new Date(value).toLocaleString(), authoredAt));
  await expect(entry(page).locator('.source-entry-commit-date')).toHaveText(label);
  await expect(entry(page).locator('.source-entry-commit-author')).toHaveCount(0);
});

test('commit history keeps absolute dates by default', async ({ page }) => {
  const authoredAt = '2026-10-01T12:00:00Z';
  await datedSource(page, authoredAt);
  await page.goto(`/alex/entry-history/commits?ref=${ref}`);
  const time = page.locator('.commit-list time');
  await expect(time).toHaveText(await page.evaluate(value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), authoredAt));
  await expect(time).toHaveAttribute('datetime', authoredAt);
  await expect(time).toHaveAttribute('title', await page.evaluate(value => new Date(value).toLocaleString(), authoredAt));
});

test('invalid commit dates retain the unavailable fallback without inventing a relative age', async ({ page }) => {
  await datedSource(page, 'invalid');
  await page.goto(`/alex/entry-history/commits?ref=${ref}`);
  await expect(page.locator('.commit-list')).toContainText('Date unavailable');
  await expect(page.locator('.commit-list time')).toHaveCount(0);
});

// Accepted exact row observations remain mounted even when they are offscreen.
// The surrounding repository/session gate separately revalidates current access.
test('repeated scrolling preserves the accepted row DOM and performs no duplicate exact history read', async ({ page }) => {
  const state = await fixture(page, 1000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/alex/entry-history/tree/${ref}`);
  const link = entry(page).getByRole('link');
  await expect(link).toHaveText('PRIVATE alex: row-000.ts');
  await link.evaluate(element => { (window as Window & { acceptedRow?: Element }).acceptedRow = element; });
  const exactCalls = () => state.calls.filter(call => call.path === 'row-000.ts').length;
  expect(exactCalls()).toBe(1);
  for (let iteration = 0; iteration < 3; iteration++) {
    await entry(page, 'row-050.ts').scrollIntoViewIfNeeded();
    await expect(entry(page, 'row-050.ts').getByRole('link')).toHaveText('PRIVATE alex: row-050.ts');
    expect(await page.evaluate(() => (window as Window & { acceptedRow?: Element }).acceptedRow?.isConnected)).toBe(true);
    await entry(page).scrollIntoViewIfNeeded();
    await expect(link).toHaveText('PRIVATE alex: row-000.ts');
    expect(await link.evaluate(element => element === (window as Window & { acceptedRow?: Element }).acceptedRow)).toBe(true);
    expect(exactCalls()).toBe(1);
  }
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(link).toHaveText('PRIVATE alex: row-000.ts');
  expect(exactCalls()).toBe(1);
});

test('terminal row authority denial remains unavailable across viewport reentry without retrying', async ({ page }) => {
  const state = await fixture(page, 1000); state.invalid = 'denied';
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(entry(page)).toHaveText('Latest change unavailable');
  const calls = state.calls.filter(call => call.path === 'row-000.ts').length;
  await entry(page, 'row-050.ts').scrollIntoViewIfNeeded();
  await expect(entry(page, 'row-050.ts')).toHaveText('Latest change unavailable');
  await entry(page).scrollIntoViewIfNeeded();
  await expect(entry(page)).toHaveText('Latest change unavailable');
  await expect(entry(page).getByRole('link')).toHaveCount(0);
  expect(state.calls.filter(call => call.path === 'row-000.ts').length).toBe(calls);
});

test('changing the selected immutable commit clears old row content and admits a fresh bound observation', async ({ page }) => {
  const state = await fixture(page); const nextRef = 'c'.repeat(40);
  await page.route('**/rpc/golf.v1.RepositoryService/GetContents', route => {
    const input = request(route, GetContentsRequestSchema);
    if (![ref, nextRef].includes(input.ref)) return reject(route, 'not_found', 'Unknown source fixture.');
    return respond(route, GetContentsResponseSchema, { repositoryId, commitId: input.ref, path: input.path, kind: SourceEntryType.DIRECTORY,
      entries: [{ name: 'row-000.ts', path: 'row-000.ts', type: SourceEntryType.FILE, sha: input.ref, size: 10n }] });
  });
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE alex: row-000.ts');
  state.hold = true; state.titlePrefix = 'NEXT SNAPSHOT';
  await page.goto(`/alex/entry-history/tree/${nextRef}`);
  await expect.poll(() => state.calls.some(call => call.ref === nextRef)).toBe(true);
  await expect(page.locator('.source-tree')).not.toContainText('PRIVATE alex');
  await expect(entry(page).getByRole('link')).toHaveCount(0);
  state.hold = false; state.held.splice(0).forEach(release => release());
  await expect(entry(page).getByRole('link')).toHaveText('NEXT SNAPSHOT alex: row-000.ts');
  expect(state.calls.filter(call => call.ref === ref)).toHaveLength(1);
  expect(state.calls.filter(call => call.ref === nextRef)).toHaveLength(1);
});

const projected = (message = 'PRIVATE selected-head change'): Projection => ({ sha: ref, message, authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' });

test('cold 16-row selected-head projection eliminates all path-history requests', async ({ page }) => {
  const state = await fixture(page, 16);
  for(let i=0;i<16;i++) state.projections[`row-${String(i).padStart(3,'0')}.ts`] = projected();
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE selected-head change');
  await entry(page,'row-015.ts').scrollIntoViewIfNeeded();
  await expect(entry(page,'row-015.ts').getByRole('link')).toHaveText('PRIVATE selected-head change');
  expect(state.calls).toHaveLength(0);
  expect(state.sourceInputs.filter(input=>input.path==='').every(input=>input.includeLatestChanges)).toBe(true);
  expect(state.sourceInputs.filter(input=>input.path==='').length).toBeGreaterThan(0);
});

test('partial projection uses literal-path fallback only for unmatched current entries', async ({ page }) => {
  const state=await fixture(page,2); state.projections['row-000.ts']=projected();
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(entry(page).getByRole('link')).toHaveText('PRIVATE selected-head change');
  await expect(entry(page,'row-001.ts').getByRole('link')).toHaveText('PRIVATE alex: row-001.ts');
  expect(state.calls.map(call=>call.path)).toEqual(['row-001.ts']);
});

for(const bad of ['head','date','name','message'] as const) test(`invalid ${bad} projection refuses the whole private source receipt without history probes`,async({page})=>{
  const state=await fixture(page); const value=projected();
  if(bad==='head')value.sha=latest;
  if(bad==='date')value.authoredAt='yesterday';
  if(bad==='name')value.authorName='bad\u0000name';
  if(bad==='message')value.message='bad\u0000message';
  state.projections['row-000.ts']=value;
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect(page.getByRole('alert')).toContainText('latest change does not identify');
  await expect(page.locator('.source-tree')).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
});

test('late projected source after logout cannot reveal private change text',async({page})=>{
  const state=await fixture(page);state.projections['row-000.ts']=projected();
  let release!:()=>void;state.sourceWait=new Promise<void>(resolve=>release=resolve);
  await page.goto(`/alex/entry-history/tree/${ref}`);
  await expect.poll(()=>state.sourceInputs.length).toBeGreaterThan(0);
  await page.getByLabel('Your account',{exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Welcome to Golf'})).toBeVisible();
  release();await expect(page.locator('body')).not.toContainText('PRIVATE selected-head change');
  expect(state.calls).toHaveLength(0);
});

test('file responses cannot smuggle a directory projection into source metadata',async({page})=>{
  await fixture(page);
  await page.route('**/rpc/golf.v1.RepositoryService/GetContents',route=>{
    const input=request(route,GetContentsRequestSchema);
    return respond(route,GetContentsResponseSchema,{repositoryId,commitId:ref,path:input.path,kind:SourceEntryType.FILE,file:{entry:{name:'row-000.ts',path:input.path,type:SourceEntryType.FILE,sha:ref,size:3n,latestChange:projected()},content:'PRIVATE'}});
  });
  await page.goto(`/alex/entry-history/blob/${ref}/row-000.ts`);
  await expect(page.getByRole('alert')).toContainText('only supported for directory entries');
  await expect(page.getByLabel('Plain text preview of row-000.ts')).toHaveCount(0);
});

for(const theme of ['dark','light']) test(`projected selected-head changes preserve escaping and mobile density ${theme}`,async({page})=>{
  const state=await fixture(page);state.projections['row-000.ts']=projected('<img src=x onerror="window.executed=true">');
  await page.setViewportSize({width:390,height:844});await page.goto(`/alex/entry-history/tree/${ref}`);
  await page.evaluate(t=>{document.documentElement.dataset.theme=t},theme);
  await expect(entry(page).getByRole('link')).toHaveText('<img src=x onerror="window.executed=true">');
  await expect(entry(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(()=>Boolean((window as Window&{executed?:boolean}).executed))).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  expect(state.calls).toHaveLength(0);
});

// Mount the real shared row with deliberately invalid props. Repository-level
// guards otherwise refuse these inputs before a row can be reached.
async function mountProjectedRow(page:Page, target:Partial<{userId:string;repositoryId:string;commitId:string;path:string}>={}) {
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await page.evaluate(async ({target,ref,repositoryId,latestChange})=>{
    const main=await (await fetch('/src/main.tsx')).text();
    const url=(module:string)=>{
      const imports=Array.from(main.matchAll(/from ["']([^"']+)["']/g),match=>match[1]!);
      const found=imports.find(value=>value.includes(`/deps/${module}.js`));
      if(!found)throw new Error(`Missing test runtime module ${module}`);return found;
    };
    const [ReactModule,domModule,query,routerAPI,component,routerModule]=await Promise.all([
      import(url('react')),import(url('react-dom_client')),import(url('@tanstack_react-query')),import(url('@tanstack_react-router')),
      import('/src/SourceEntryCommit.tsx' as string),import('/src/router.tsx' as string),
    ]);
    const React=ReactModule.default||ReactModule,dom=domModule.default||domModule;
    const node=document.createElement('div');node.className='projected-row-harness';(document.querySelector('main')||document.body).prepend(node);
    const root=dom.createRoot(node),client=new query.QueryClient();
    const props={userId:'17',repositoryId,commitId:ref,path:'row-000.ts',location:{owner:'alex',name:'entry-history',view:'source',ref,path:''},latestChange,...target};
    const render=(changes:typeof target={})=>{
      Object.assign(props,changes);
      root.render(React.createElement(query.QueryClientProvider,{client},React.createElement(routerAPI.RouterContextProvider,{router:routerModule.router},React.createElement(component.SourceEntryCommit,props))));
    };
    (window as Window&{renderProjectedRow?:(changes:typeof target)=>void}).renderProjectedRow=render;
    render();
  },{target,ref,repositoryId,latestChange:projected()});
}

for(const [label,target] of [
 ['missing actor',{userId:''}],['zero actor',{userId:'0'}],['noncanonical actor',{userId:'017'}],
 ['missing repository',{repositoryId:''}],['overflow repository',{repositoryId:'9223372036854775808'}],
 ['empty path',{path:''}],['traversal path',{path:'../secret'}],['invalid UTF-16 path',{path:'bad\ud800'}],['backslash path',{path:'src\\secret'}],
] as const) test(`projected row refuses ${label} before rendering or requesting history`,async({page})=>{
 const state=await fixture(page);await mountProjectedRow(page,target);
 await expect(page.locator('.projected-row-harness')).toHaveText('Latest change unavailable');
 await expect(page.locator('.projected-row-harness').getByRole('link')).toHaveCount(0);
 expect(state.calls).toHaveLength(0);
});

test('projected row clears its private observation on invalid identity and changed source head',async({page})=>{
 const state=await fixture(page);await mountProjectedRow(page);
 await expect(page.locator('.projected-row-harness').getByRole('link')).toHaveText('PRIVATE selected-head change');
 await page.evaluate(()=> (window as unknown as Window&{renderProjectedRow:(changes:{userId:string})=>void}).renderProjectedRow({userId:'0'}));
 await expect(page.locator('.projected-row-harness')).toHaveText('Latest change unavailable');expect(state.calls).toHaveLength(0);
 state.invalid='denied';
 await page.evaluate(head=>(window as unknown as Window&{renderProjectedRow:(changes:{userId:string;commitId:string})=>void}).renderProjectedRow({userId:'17',commitId:head}),latest);
 await page.locator('.projected-row-harness').scrollIntoViewIfNeeded();
 await expect(page.locator('.projected-row-harness')).toHaveText('Latest change unavailable');
 await expect(page.locator('.projected-row-harness')).not.toContainText('PRIVATE');
 expect(state.calls).toHaveLength(1);expect(state.calls[0]).toMatchObject({repositoryId,ref:latest,path:'row-000.ts'});
});
