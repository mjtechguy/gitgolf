import { portableRuntimeFixture } from './runtime-fixture';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  CommitDiffBase, GetAuthenticationOptionsResponseSchema, GetCommitDiffRequestSchema, GetCommitDiffResponseSchema,
  GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema,
  ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema, ListCommitsResponseSchema,
  ListRepositoriesResponseSchema, LoginWithPasswordResponseSchema, LogoutResponseSchema, RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { resolveSourceFixture, reject, request, respond } from './rpc';

const head = 'a'.repeat(40), parent = 'b'.repeat(40), root = 'c'.repeat(40), merge = 'd'.repeat(40), otherParent = 'e'.repeat(40), sha256 = '1'.repeat(64);
const raw = 'diff --git a/世界.txt b/世界.txt\nindex 1111111..2222222 100644\n--- a/世界.txt\n+++ b/世界.txt\n@@ -1 +1,3 @@\n-old\n+PRIVATE_DIFF\n+<img src=x onerror="window.executed=true">\n+[unsafe](javascript:alert(1))\nBinary files a/logo.bin and b/logo.bin differ\n';
const message = 'Improve navigation\n\n<script>window.executed=true</script>';
const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const repository = create(RepositorySchema, { id: '9007199254740993', name: 'design-system', fullName: 'alex/design-system', private: true, defaultBranch: 'main' });
type Failure = 'permission_denied' | 'not_found' | 'unauthenticated' | 'resource_exhausted' | 'failed_precondition' | 'unavailable';
const diffURL = (id: string) => `/repositories/alex/design-system?view=commits&commit=${id}`;

async function backend(page: Page) {
  const state = { signedIn: true, raw, bytes: undefined as number | undefined, returnedID: undefined as string | undefined, failure: undefined as Failure | undefined,
    repositoryDenied: false, barrier: undefined as Promise<void> | undefined, commits: [] as string[], historyRefs: [] as string[], sourceRefs: [] as string[] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'LoginWithPassword') { state.signedIn = true; return respond(route, LoginWithPasswordResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'GetRepositoryStar') return reject(route, 'unimplemented', 'Stars are outside this commit fixture.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.repositoryDenied ? reject(route, 'not_found', 'Repository not found or inaccessible.') : respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'feature/UI', commitId: head }] });
    if (method === 'ListCommits') {
      state.historyRefs.push(request(route, ListCommitsRequestSchema).ref);
      return respond(route, ListCommitsResponseSchema, { commits: [{ sha: head, message, authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] });
    }
    if (method === 'ResolveRepositorySource') return resolveSourceFixture(route, repository.id, { owner: 'alex', name: 'design-system' }, 'main', { main: head });
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema); state.sourceRefs.push(input.ref);
      return respond(route, GetContentsResponseSchema, { repositoryId: repository.id, commitId: input.ref, kind: SourceEntryType.DIRECTORY, entries: [] });
    }
    if (method === 'GetCommitDiff') {
      const input = request(route, GetCommitDiffRequestSchema);
      expect(input.repository).toMatchObject({ owner: 'alex', name: 'design-system' });
      expect(route.request().headers()['connect-protocol-version']).toBe('1');
      state.commits.push(input.commitId);
      const text = input.commitId === root ? `commit ${root}\nAuthor: Alex <alex@example.test>\n\n    Initial repository\n\n${state.raw}` : state.raw;
      const firstParent = input.commitId.length === 64 ? '2'.repeat(64) : parent;
      const response = create(GetCommitDiffResponseSchema, { commit: { sha: state.returnedID || input.commitId, message, authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' },
        base: input.commitId === root ? CommitDiffBase.ROOT : CommitDiffBase.FIRST_PARENT, baseCommitId: input.commitId === root ? '' : firstParent,
        parentCommitIds: input.commitId === root ? [] : input.commitId === merge ? [parent, otherParent] : [firstParent], rawDiff: text,
        byteSize: state.bytes ?? new TextEncoder().encode(text).byteLength });
      if (state.barrier) await state.barrier;
      if (state.failure) { if (state.failure === 'unauthenticated') state.signedIn = false; return reject(route, state.failure, `Diff unavailable: ${state.failure}.`); }
      return respond(route, GetCommitDiffResponseSchema, response);
    }
    return reject(route, 'not_found', 'Unsupported fixture operation.');
  });
  return state;
}

test('commit history opens an exact diff and preserves branch context, reload, back and source links', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=commits&ref=feature%2FUI&branch=feature%2FUI');
  await expect(page).toHaveURL(new RegExp(`ref=${head}`));
  await page.getByRole('link', { name: `View diff ${head.slice(0, 12)}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`commit/${head}`));
  await expect(page.getByLabel('Unified diff, plain text')).toHaveText(raw);
  await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Commits');
  await expect(page.locator('.branch-picker')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveText(raw);
  expect(state.commits.every((id) => id === head)).toBe(true);
  await page.getByRole('link', { name: 'Back to commit history', exact: true }).click();
  const historyURL = new URL(page.url());
  expect(historyURL.searchParams.get('ref')).toBe(head);
  expect(historyURL.searchParams.get('branch')).toBe('feature/UI');
  expect(historyURL.searchParams.has('commit')).toBe(false);
  await page.goBack();
  await expect(page.locator('.diff-workspace')).toBeVisible();
  await page.getByRole('link', { name: 'Browse this commit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This directory is empty.' })).toBeVisible();
  expect(state.sourceRefs.at(-1)).toBe(head);
  expect(new URL(page.url()).searchParams.has('commit')).toBe(false);
});

test('native root headers, first-parent merges, binary markers, empty text and 64-digit IDs stay explicit', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(root));
  await expect(page.getByText('Root commit · no parent', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toContainText(`commit ${root}\nAuthor: Alex <alex@example.test>`);
  await expect(page.getByLabel('Unified diff, plain text')).toContainText('Binary files a/logo.bin and b/logo.bin differ');
  await page.goto(diffURL(merge));
  await expect(page.getByText('Merge commit: only the first-parent comparison is shown.', { exact: true })).toBeVisible();
  await expect(page.locator('.commit-diff-metadata')).toContainText(otherParent);
  await expect(page.getByText('not merge eligibility or independently verified patch evidence', { exact: false })).toHaveCount(0);
  await expect(page.locator('.commit-diff-metadata')).toContainText('Text diffs are limited to 512 KiB.');
  state.raw = '';
  await page.goto(diffURL(sha256));
  await expect(page.getByRole('heading', { name: 'No diff text returned' })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  expect(state.commits.at(-1)).toBe(sha256);
  await expect(page.locator('.commit-diff-metadata')).toContainText(sha256);
});

for(const theme of ['dark','light'])for(const width of [1440,390])test(`commit diff keeps preview details on request in ${theme} ${width}px`,async({page})=>{
 const state=await backend(page);state.raw=filePatch('src/main.ts');await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);await page.goto(diffURL(head));
 const details=page.locator('.commit-diff-metadata details');await expect(details).not.toHaveAttribute('open','');await expect(page.locator('.diff-lines')).toBeVisible();
 await expect(page.getByText('not merge eligibility or independently verified patch evidence',{exact:false})).toHaveCount(0);await expect(page.getByText('Text diffs are limited to 512 KiB.',{exact:false})).toBeHidden();await expect(page.locator('.browser-panel > .panel-footnote')).toHaveCount(0);
 const summary=details.getByText('Commit details',{exact:true});await summary.focus();await page.keyboard.press('Enter');await expect(details).toContainText(`${new TextEncoder().encode(state.raw).byteLength} bytes`);await expect(details).toContainText('Binary files show metadata instead of a text preview.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await summary.press('Enter');await expect(page.getByText('Text diffs are limited to 512 KiB.',{exact:false})).toBeHidden();
 await page.screenshot({path:test.info().outputPath(`diff-cleanup-${theme}-${width}.png`),fullPage:true});
});

test('typed diff failures remove cached text, retries hide stale content and repository denial clears metadata', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(head));
  await expect(page.locator('.diff-workspace')).toBeVisible();
  for (const failure of ['permission_denied', 'not_found', 'failed_precondition', 'resource_exhausted', 'unavailable'] as const) {
    state.failure = failure;
    await page.getByRole('button', { name: 'Refresh diff', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(`Diff unavailable: ${failure}.`);
    await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
    await expect(page.locator('.commit-diff-metadata')).toHaveCount(0);
    state.failure = undefined;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('.diff-workspace')).toBeVisible();
  }
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh diff', exact: true }).click();
  await expect(page.getByText('Loading commit diff…', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  release();
  await expect(page.locator('.diff-workspace')).toBeVisible();
  state.repositoryDenied = true;
  await page.getByRole('button', { name: 'Refresh repository access', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  await expect(page.locator('.commit-diff-metadata')).toHaveCount(0);
});

test('render bounds accept exactly 512 KiB and refuse oversized, mis-sized or wrong-commit responses', async ({ page }) => {
  const state = await backend(page);
  state.raw = 'x'.repeat(512 * 1024);
  await page.goto(diffURL(head));
  await expect(page.locator('.diff-workspace')).toBeVisible();
  expect(await page.getByLabel('Unified diff, plain text').evaluate((element) => element.textContent?.length)).toBe(512 * 1024);
  state.raw += 'x';
  await page.getByRole('button', { name: 'Refresh diff' }).click();
  await expect(page.getByRole('alert')).toContainText('supported text bounds');
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  state.raw = raw; state.bytes = raw.length; // Multibyte UTF-8 is not a character count.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toContainText('supported text bounds');
  state.bytes = undefined; state.returnedID = parent;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toContainText('does not identify the requested commit');
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
});

test('expired sessions remove diff data and return to sign-in', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(head));
  await expect(page.locator('.diff-workspace')).toBeVisible();
  state.failure = 'unauthenticated';
  await page.getByRole('button', { name: 'Refresh diff' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  await expect(page.locator('.commit-diff-metadata')).toHaveCount(0);
});

test('sign-out cancels a pending diff and a fresh login cannot reuse its private response', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(head));
  await expect(page.locator('.diff-workspace')).toBeVisible();
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh diff' }).click();
  await expect(page.getByText('Loading commit diff…')).toBeVisible();
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/GetCommitDiff'));
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await aborted;
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.barrier = undefined; state.failure = 'permission_denied'; release();
  await page.getByLabel('Email or username', { exact: true }).fill('fixture-account'); await page.getByLabel('Password', { exact: true }).fill('fixture-only-token'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Diff unavailable: permission_denied.');
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('PRIVATE_DIFF');
});

test('plain text diff stays keyboard-scrollable and fits charcoal and light mobile layouts', async ({ page }) => {
  const state = await backend(page); state.raw += `+${'long line '.repeat(200)}\n`;
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(diffURL(merge));
  await expect(page.locator('.diff-workspace')).toBeVisible();
  await expect(page.getByLabel('Commit message, plain text')).toHaveText(message);
  await expect(page.locator('.commit-diff-preview img,.commit-diff-preview a,.commit-diff-message script')).toHaveCount(0);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.getByText('Raw diff', {exact:true}).click();
  await page.getByLabel('Unified diff, plain text').focus();
  await expect(page.getByLabel('Unified diff, plain text')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/commit-diff-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.screenshot({ path: 'test-results/commit-diff-light-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('large multi-file comparisons retain full native output without an unbounded structured DOM', async({page})=>{
 const state=await backend(page);
 state.raw=Array.from({length:501},(_,index)=>`diff --git a/file${index} b/file${index}\nnew file mode 100644\n--- /dev/null\n+++ b/file${index}\n@@ -0,0 +1 @@\n+new\n`).join('');
 await page.goto(diffURL(head));
 await expect(page.getByText('This comparison exceeds the structured preview limit of 500 files or 12,000 rows. The complete bounded native text remains available.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);
 await expect(page.locator('.diff-file')).toHaveCount(0);
});

const filePatch=(path:string,content='const value = 1;')=>`diff --git ${JSON.stringify('a/'+path)} ${JSON.stringify('b/'+path)}\n--- /dev/null\n+++ ${JSON.stringify('b/'+path)}\n@@ -0,0 +1 @@\n+${content}\n`;
const multiPatch=()=>filePatch('src/alpha.ts')+filePatch('src/nested/alpha.ts')+filePatch('docs/README.md','# Documentation')+filePatch('__proto__/constructor.ts')+`diff --git a/old-name b/new-name\nsimilarity index 100%\nrename from old-name\nrename to new-name\ndiff --git a/removed.txt b/removed.txt\n--- a/removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\ndiff --git a/images/logo.bin b/images/logo.bin\nBinary files a/images/logo.bin and b/images/logo.bin differ\n`;

test('changed-file tree preserves native identities, nested folders, renames, deletion and literal special names',async({page})=>{
 const state=await backend(page);state.raw=multiPatch();await page.goto(diffURL(head));
 const nav=page.getByRole('navigation',{name:'Changed file navigation'});
 await expect(nav.getByRole('link')).toHaveCount(7);
 await expect(page.getByLabel('Folder __proto__',{exact:true})).toBeVisible();
 await expect(nav.getByRole('link',{name:'src/alpha.ts',exact:true})).toHaveText('alpha.ts');
 const folder=page.getByLabel('Folder src',{exact:true});await folder.focus();await page.keyboard.press('Enter');
 await expect(nav.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toBeHidden();
 await page.keyboard.press('Enter');await expect(nav.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toBeVisible();
 await nav.getByRole('link',{name:'src/nested/alpha.ts',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-1$`));
 await expect(nav.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toHaveAttribute('aria-current','location');
 await page.getByLabel('Filter changed files').fill('old-name');
 await expect(nav.getByRole('link',{name:'new-name',exact:true})).toBeVisible();
 await expect(page.locator('.diff-file')).toHaveCount(1);
 await expect(page.getByRole('status').filter({hasText:'Showing 1 of 7 changed files'})).toBeVisible();
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await expect(page.getByRole('link',{name:'removed.txt',exact:true})).toHaveAttribute('href',`#diff-${head}-file-5`);
 await expect(page.getByText('Binary content changed. No text preview is available.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('constructor.ts');
});

test('file-type and Viewed filters cover only loaded native entries without changing file anchors or raw output',async({page})=>{
 const state=await backend(page);state.raw=multiPatch();await page.goto(diffURL(head));
 await page.getByLabel('File filter',{exact:true}).click();await page.getByLabel('.ts',{exact:true}).uncheck();
 await expect(page.locator('.diff-file')).toHaveCount(4);
 await expect(page.getByRole('status').filter({hasText:'Showing 4 of 7 changed files'})).toBeVisible();
 await page.getByLabel('.ts',{exact:true}).check();await page.getByLabel('Viewed files visibility').selectOption('unviewed');
 await page.getByLabel('File filter',{exact:true}).press('Escape');
 const selected=page.locator(`#diff-${head}-file-1`);await selected.getByLabel('Viewed',{exact:true}).click();
 await expect(page.locator('.diff-file')).toHaveCount(6);await expect(page.getByText('1/7 viewed this session',{exact:true})).toBeVisible();
 await page.getByLabel('File filter',{exact:true}).click();await page.getByLabel('Viewed files visibility').selectOption('viewed');
 await expect(page.locator('.diff-file')).toHaveCount(1);await expect(page.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toHaveAttribute('href',`#diff-${head}-file-1`);
 await page.getByRole('button',{name:'Reset file filters',exact:true}).click();await page.getByLabel('File filter',{exact:true}).press('Escape');
 await expect(page.locator('.diff-file')).toHaveCount(7);await expect(selected.getByLabel('Viewed',{exact:true})).toBeChecked();
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);
 await page.reload();await expect(page.getByText('0/7 viewed this session',{exact:true})).toBeVisible();
});

test('reopening a Viewed or collapsed patch from its header or file tree retains review progress',async({page})=>{
 const state=await backend(page);state.raw=multiPatch();await page.goto(diffURL(head));
 const file=page.locator(`#diff-${head}-file-1`),nav=page.getByRole('navigation',{name:'Changed file navigation'}),link=nav.getByRole('link',{name:'src/nested/alpha.ts',exact:true});
 await file.getByLabel('Viewed',{exact:true}).check();await expect(file.getByLabel('Changes in src/nested/alpha.ts',{exact:true})).toHaveCount(0);
 await file.getByRole('button',{name:'Expand src/nested/alpha.ts',exact:true}).click();
 await expect(file.getByLabel('Changes in src/nested/alpha.ts',{exact:true})).toBeVisible();await expect(file.getByLabel('Viewed',{exact:true})).toBeChecked();
 await file.getByRole('button',{name:'Collapse src/nested/alpha.ts',exact:true}).click();
 await link.focus();await page.keyboard.press('Enter');await expect(file.getByLabel('Changes in src/nested/alpha.ts',{exact:true})).toBeVisible();await expect(file.getByLabel('Viewed',{exact:true})).toBeChecked();
 await file.getByRole('button',{name:'Collapse src/nested/alpha.ts',exact:true}).click();
 await link.click();await expect(file.getByLabel('Changes in src/nested/alpha.ts',{exact:true})).toBeVisible();
 await expect(page.getByText('1/7 viewed this session',{exact:true})).toBeVisible();await expect(link).toHaveAttribute('aria-current','location');
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);expect(new Set(state.commits)).toEqual(new Set([head]));
});

const rangePatch='diff --git a/src/range.ts b/src/range.ts\n--- a/src/range.ts\n+++ b/src/range.ts\n@@ -1,4 +1,4 @@\n first\n-old second\n+new second\n third\n fourth\n@@ -10 +10 @@\n-old tenth\n+new tenth\n';

test('diff line ranges retain exact side, file and comparison through shift clicks and history',async({page})=>{
 const state=await backend(page);state.raw=rangePatch+filePatch('src/other.ts');await page.goto(diffURL(head));
 const file=page.locator(`#diff-${head}-file-0`),line=(side:string,number:number)=>file.locator(`#diff-${head}-file-0-${side}${number}`);
 await line('R',1).click();await line('R',3).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-R1-R3$`));
 await expect(file.locator('.diff-row-selected')).toHaveCount(3);await expect(file.locator('.diff-row-selected .diff-code code')).toHaveText(['first','new second','third']);
 await expect(file.locator('.diff-line-selected a')).toHaveCount(3);await expect(file.locator('.diff-line-selected a[aria-current="location"]')).toHaveCount(3);
 await page.getByRole('button',{name:'Split',exact:true}).click();await expect(file.locator('.diff-code.diff-line-selected')).toHaveCount(3);await expect(file.locator('.diff-code.diff-line-selected')).toHaveText(['first','new second','third']);
 const addedColors=await file.locator('.diff-code.diff-line-selected').evaluateAll(cells=>cells.map(cell=>getComputedStyle(cell).backgroundColor));expect(new Set(addedColors).size).toBe(1);expect(await file.locator('.diff-code.add:not(.diff-line-selected)').evaluate(cell=>getComputedStyle(cell).backgroundColor)).not.toBe(addedColors[0]);
 await line('L',4).click();await line('L',2).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-L2-L4$`));await expect(file.locator('.diff-code.diff-line-selected')).toHaveText(['old second','third','fourth']);
 const deletedColors=await file.locator('.diff-code.diff-line-selected').evaluateAll(cells=>cells.map(cell=>getComputedStyle(cell).backgroundColor));expect(new Set(deletedColors).size).toBe(1);expect(await file.locator('.diff-code.delete:not(.diff-line-selected)').evaluate(cell=>getComputedStyle(cell).backgroundColor)).not.toBe(deletedColors[0]);
 await page.goBack();await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-L4$`));await expect(file.locator('.diff-code.diff-line-selected')).toHaveText('fourth');
 await page.evaluate(hash=>window.location.hash=hash,`#diff-${head}-file-0-L1`);await line('L',3).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-L1-L3$`));await expect(file.locator('.diff-code.diff-line-selected')).toHaveText(['first','old second','third']);
 await line('R',4).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-R4$`));
 await line('R',10).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-0-R10$`));await expect(file.locator('.diff-code.diff-line-selected')).toHaveText('new tenth');
 await page.locator(`#diff-${head}-file-1-R1`).click({modifiers:['Shift']});await expect(page).toHaveURL(new RegExp(`#diff-${head}-file-1-R1$`));await expect(file.locator('.diff-code.diff-line-selected')).toHaveCount(0);
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);expect(new Set(state.commits)).toEqual(new Set([head]));expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('src/range.ts');
});

test('a reused diff component never carries a Shift pivot across snapshot or native text changes',async({page})=>{
 await backend(page);await page.goto(diffURL(head));
 await page.evaluate(async patch=>{
  const urls=['/node_modules/.vite/deps/react.js','/node_modules/.vite/deps/react-dom_client.js','/src/DiffViewer.tsx'];
  const [react,dom,workspace]=await Promise.all(urls.map(url=>import(url)));const host=document.createElement('div');host.setAttribute('data-diff-harness','');document.body.append(host);const root=dom.default.createRoot(host);
  const render=(snapshotId:string,text:string)=>root.render(react.default.createElement(workspace.DiffViewer,{snapshotId,text}));(window as unknown as {renderDiff:typeof render}).renderDiff=render;render('harness-a',patch);
 },rangePatch);
 const harness=page.locator('[data-diff-harness]'),line=(prefix:string,number:number)=>harness.locator(`#diff-${prefix}-file-0-L${number}`);
 await line('harness-a',4).click();await line('harness-a',2).click({modifiers:['Shift']});await expect(page).toHaveURL(/#diff-harness-a-file-0-L2-L4$/);
 await page.evaluate(patch=>(window as unknown as {renderDiff:(id:string,text:string)=>void}).renderDiff('harness-b',patch),rangePatch);
 await line('harness-b',1).click({modifiers:['Shift']});await expect(page).toHaveURL(/#diff-harness-b-file-0-L1$/);
 await line('harness-b',4).click();await line('harness-b',2).click({modifiers:['Shift']});await expect(page).toHaveURL(/#diff-harness-b-file-0-L2-L4$/);
 await page.evaluate(patch=>(window as unknown as {renderDiff:(id:string,text:string)=>void}).renderDiff('harness-b',patch),rangePatch.replace('old second','different native bytes'));
 await expect(harness).toContainText('different native bytes');await line('harness-b',1).click({modifiers:['Shift']});await expect(page).toHaveURL(/#diff-harness-b-file-0-L1-L2$/);await expect(harness.locator('.diff-row-selected')).toHaveCount(2);
});

for(const theme of ['dark','light'])for(const width of [1440,320])test(`direct diff range links highlight whole displayed rows in ${theme} ${width}px`,async({page})=>{
 const state=await backend(page);state.raw=rangePatch;await page.setViewportSize({width,height:900});await page.addInitScript(theme=>localStorage.setItem('golf.theme',theme),theme);
 await page.goto(diffURL(head)+`#diff-${head}-file-0-R2-R4`);const file=page.locator(`#diff-${head}-file-0`);
 await expect(file.locator('.diff-row-selected')).toHaveCount(3);await expect(file.locator('.diff-line-selected a')).toHaveText(['2','3','4']);
 const colors=await file.locator('.diff-row-selected > .diff-code').evaluateAll(rows=>rows.map(row=>getComputedStyle(row).backgroundColor));expect(new Set(colors).size).toBe(1);expect(colors[0]).not.toBe('rgba(0, 0, 0, 0)');
 for(const bad of [`#diff-${parent}-file-0-R2-R4`,`#diff-${head}-file-0-L2-R4`,`#diff-${head}-file-0-R3-R10`,`#diff-${head}-file-0-R0`,`#diff-${head}-file-99-R1`]){
  await page.evaluate(hash=>window.location.hash=hash,bad);await expect(file.locator('.diff-line-selected,.diff-row-selected')).toHaveCount(0);
 }
 await page.evaluate(hash=>window.location.hash=hash,`#diff-${head}-file-0-L1-L3`);await expect(file.locator('.diff-row-selected')).toHaveCount(3);await expect(file.locator('.diff-line-selected a')).toHaveText(['1','2','3']);
 await page.getByRole('button',{name:'Split',exact:true}).click();const splitColors=await file.locator('.diff-code.diff-line-selected').evaluateAll(cells=>cells.map(cell=>getComputedStyle(cell).backgroundColor));expect(new Set(splitColors).size).toBe(1);
 expect(await file.locator('.diff-code.delete:not(.diff-line-selected)').evaluate(cell=>getComputedStyle(cell).backgroundColor)).not.toBe(splitColors[0]);
 await page.evaluate(hash=>window.location.hash=hash,`#diff-${head}-file-0-R1-R3`);const newColors=await file.locator('.diff-code.diff-line-selected').evaluateAll(cells=>cells.map(cell=>getComputedStyle(cell).backgroundColor));expect(new Set(newColors).size).toBe(1);expect(await file.locator('.diff-code.add:not(.diff-line-selected)').evaluate(cell=>getComputedStyle(cell).backgroundColor)).not.toBe(newColors[0]);
 await page.getByRole('button',{name:'Unified',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath(`diff-range-${theme}-${width}.png`),fullPage:true});
});

test('display preferences persist only booleans while private filters and Viewed reset on a new comparison',async({page})=>{
 const state=await backend(page);state.raw=filePatch('private/customer-secret.ts');await page.goto(diffURL(head));
 await page.getByRole('button',{name:'Split',exact:true}).click();await page.getByLabel('Diff settings',{exact:true}).click();
 await page.getByLabel('Wrap lines',{exact:true}).check();await page.getByLabel('Syntax colours',{exact:true}).uncheck();
 await page.getByLabel('Diff settings',{exact:true}).press('Escape');await expect(page.getByLabel('Diff settings',{exact:true})).toBeFocused();
 await page.getByLabel('Viewed',{exact:true}).check();await page.getByLabel('Filter changed files').fill('customer-secret');
 await page.getByRole('button',{name:'Hide file tree',exact:true}).click();
 await page.reload();await expect(page.getByRole('button',{name:'Show file tree',exact:true})).toBeVisible();
 await expect(page.locator('.diff-lines')).toHaveClass(/split/);await expect(page.locator('.diff-workspace')).toHaveClass(/wrap-lines/);
 await expect(page.getByText('0/1 viewed this session',{exact:true})).toBeVisible();await expect(page.getByText('Loaded comparison',{exact:true})).toBeVisible();
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('golf.diff-display.v1')!));expect(stored).toEqual({split:true,wrap:true,syntax:false,tree:false});
 expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('customer-secret');
 await page.goto(diffURL(merge));await expect(page.getByRole('button',{name:'Show file tree',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Show file tree',exact:true}).click();await expect(page.getByLabel('Filter changed files')).toHaveValue('');
 await expect(page.locator('.diff-code .hljs-keyword')).toHaveCount(0);
});

test('syntax colours preserve literal text and independent old/new hunk context in unified and split views',async({page})=>{
 const state=await backend(page);state.raw=`diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-/*\n+const image = "<img src=x onerror=window.executed=true>";\n context token\n`;
 await page.goto(diffURL(head));await expect(page.locator('.diff-code .hljs-keyword')).toContainText('const');
 await expect(page.locator('.diff-code code')).toHaveText(['/*','const image = "<img src=x onerror=window.executed=true>";','context token']);
 await expect(page.locator('.diff-code img,.diff-code script,.diff-code a')).toHaveCount(0);expect(await page.evaluate(()=>('executed' in window))).toBe(false);
 await page.getByRole('button',{name:'Split',exact:true}).click();
 const contexts=page.locator('.diff-lines tbody tr:last-child .diff-code');
 await expect(contexts).toHaveCount(2);await expect(contexts.nth(0).locator('.hljs-comment')).toHaveText('context token');
 await expect(contexts.nth(1).locator('.hljs-comment')).toHaveCount(0);await expect(contexts).toHaveText(['context token','context token']);
 await page.getByLabel('Diff settings',{exact:true}).click();await page.getByLabel('Syntax colours',{exact:true}).uncheck();
 await expect(page.locator('.diff-code [class^="hljs-"]')).toHaveCount(0);await expect(contexts).toHaveText(['context token','context token']);
 await expect(page.locator(`#diff-${head}-file-0-R2`)).toHaveAttribute('href',`#diff-${head}-file-0-R2`);
 await expect(page.locator(`#diff-${head}-file-0-L2`)).toHaveAttribute('href',`#diff-${head}-file-0-L2`);
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);
});

test('folder navigation reveals a selected line inside collapsed folders without moving the selected commit',async({page})=>{
 const state=await backend(page);state.raw=multiPatch();await page.goto(diffURL(head));
 await page.locator(`#diff-${head}-file-0`).getByLabel('Viewed',{exact:true}).check();
 const folder=page.getByLabel('Folder src',{exact:true});await folder.click();
 await expect(page.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toBeHidden();
 await page.locator(`#diff-${head}-file-1-R1`).click();
 await expect(page.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'src/nested/alpha.ts',exact:true})).toHaveAttribute('aria-current','location');
 await expect(page.getByText('1/7 viewed this session',{exact:true})).toBeVisible();
 expect(state.commits.length).toBeGreaterThan(0);expect(new Set(state.commits)).toEqual(new Set([head]));
});

test('deep and duplicate native paths remain bounded, independently navigable and readable on mobile in both themes',async({page})=>{
 const state=await backend(page);const path=Array.from({length:80},(_,i)=>'nested'+i).join('/')+'/世界.ts';
 state.raw=filePatch(path,'const value = "世界";')+filePatch('duplicate.ts')+filePatch('duplicate.ts','const other = 2;');
 await page.goto(diffURL(head));const nav=page.getByRole('navigation',{name:'Changed file navigation'});
 await expect(nav.getByRole('link')).toHaveCount(3);await expect(nav.getByRole('link',{name:'duplicate.ts',exact:true})).toHaveCount(2);
 await expect(nav.locator('.diff-directory')).toHaveCount(1);await nav.getByRole('link',{name:path,exact:true}).click();
 for(const theme of ['dark','light']) {
  await page.evaluate(value=>document.documentElement.setAttribute('data-theme',value),theme);await page.setViewportSize({width:320,height:760});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('Diff settings',{exact:true}).click();await page.getByLabel('Wrap lines',{exact:true}).check();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByLabel('Wrap lines',{exact:true})).toBeInViewport();await page.getByLabel('Diff settings',{exact:true}).press('Escape');
  await page.screenshot({path:`test-results/diff-tree-${theme}-mobile.png`,fullPage:true});
 }
 await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);
});

test('prototype-named unknown files retain literal source without breaking the diff workspace',async({page})=>{
 const state=await backend(page);state.raw=filePatch('constructor','<img src=x onerror=window.executed=true>')+filePatch('__proto__','const value = 1;');
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(diffURL(head));
 await expect(page.locator('.diff-file')).toHaveCount(2);await expect(page.locator('.diff-code code')).toHaveText(['<img src=x onerror=window.executed=true>','const value = 1;']);
 await expect(page.locator('.diff-code [class^=hljs],.diff-code img')).toHaveCount(0);await expect(page.getByLabel('Unified diff, plain text')).toHaveText(state.raw);expect(errors).toEqual([]);
});


for (const theme of ['dark', 'light']) for (const width of [320, 390]) {
 test(`mobile ${theme} ${width}px opens code before the optional tree and preserves a chosen display`, async ({ page }) => {
  const state = await backend(page); state.raw = filePatch('example.ts'); await page.setViewportSize({ width, height: 900 });
  await page.goto(diffURL(head)); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const toggle = page.getByRole('button', { name: 'Show file tree', exact: true });
  await expect(toggle).toBeVisible(); await expect(page.locator('.diff-files')).toHaveCount(0);
  await expect(page.locator('.diff-lines')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const first = await page.locator('.diff-lines').first().boundingBox(); expect(first!.y).toBeLessThan(900);
  for (const control of ['Show file tree', 'Unified', 'Split']) {
   const target = page.getByRole('button', { name: control, exact: true });
   expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `test-results/diff-density-${theme}-${width}.png` });
  await toggle.click(); await expect(page.getByLabel('Filter changed files', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Hide file tree', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(page.getByLabel('Filter changed files', { exact: true })).toBeVisible();
  const toolbar = page.locator('.diff-toolbar'); await expect(toolbar.locator('.diff-controls')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1920);
  await page.screenshot({ path: `test-results/diff-density-${theme}-${width}-wide.png` });
 });
}
