import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetRepositoryImageResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetIssueRequestSchema, GetIssueResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, IssueSchema, IssueState, ListBranchesRequestSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema,
  ListCommitsRequestSchema, ListCommitsResponseSchema, ListTagsRequestSchema, ListTagsResponseSchema, ListIssueCommentsResponseSchema, ListIssuesRequestSchema, ListIssuesResponseSchema, ListRepositoriesResponseSchema,
  LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, RepositorySchema, SourceEntrySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import type { GetContentsRequest } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const head = 'a'.repeat(40);
const feature = 'b'.repeat(40);
const older = 'c'.repeat(40);
const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const repository = create(RepositorySchema, {
  id: '9007199254740993', name: 'design-system', fullName: 'alex/design-system', description: 'A shared foundation for our next idea.', private: true,
  htmlUrl: 'https://forge.example/alex/design-system', defaultBranch: 'main', updatedAt: '2026-10-01T12:00:00Z', empty: false,
  cloneUrl: 'https://forge.example/alex/design-system.git', sshUrl: 'git@forge.example:alex/design-system.git',
});
const issue = create(IssueSchema, { id: '9007199254740993', number: 12, title: 'Make navigation keyboard accessible', body: '# PRIVATE ISSUE\n<img src=x onerror="window.executed=true">\n[Unsafe](javascript:alert(1))', state: IssueState.OPEN, user, comments: 3, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', htmlUrl: 'https://forge.example/alex/design-system/issues/12' });
const closedIssue = create(IssueSchema, { ...issue, id: '9007199254740994', number: 13, title: 'Fix focus order', body: '', state: IssueState.CLOSED });
const secondIssue = create(IssueSchema, { ...issue, id: '9007199254740995', number: 14, title: 'Document focus management' });
const entries = [
  create(SourceEntrySchema, { name: 'src', path: 'src', type: SourceEntryType.DIRECTORY, sha: head }),
  ...['README.md', 'binary.png', 'large.txt', 'pointer.lfs', 'link', 'module', 'empty.txt', 'huge.bin'].map((name) => create(SourceEntrySchema, { name, path: name, type: name === 'link' ? SourceEntryType.SYMLINK : name === 'module' ? SourceEntryType.SUBMODULE : SourceEntryType.FILE, sha: head, size: name === 'huge.bin' ? 18446744073709551615n : name === 'large.txt' ? 300_000n : name === 'empty.txt' ? 0n : 128n })),
];

async function backend(page: Page) {
  const state = { readme: '# PRIVATE README\n<script>window.executed=true</script>\n<a href="javascript:alert(1)">Untrusted</a>\n', featureHead: feature, signedIn: true, empty: false, metadataStatus: 200, sourceStatus: 200, sourceText:'export const PRIVATE_SOURCE = true;\n',historyBinding:true, historyStatus:200,historyRequests:[] as ReturnType<typeof request<typeof ListCommitsRequestSchema>>[], issueStatus: 200, sourceWait: undefined as Promise<void> | undefined, methods: [] as string[], sourceRequests: [] as GetContentsRequest[] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.methods.push(method);
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['connect-protocol-version']).toBe('1');
    const error = (status: number, message: string) => reject(route, status === 401 ? 'unauthenticated' : status === 403 ? 'permission_denied' : status === 404 ? 'not_found' : status === 502 ? 'resource_exhausted' : 'unavailable', message);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { providerLabel: 'Gitea' });
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : error(401, 'Sign in required.');
    if (!state.signedIn) return error(401, 'Your session expired.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.metadataStatus === 200 ? respond(route, GetRepositoryResponseSchema, { repository: { ...repository, empty: state.empty } }) : error(state.metadataStatus, 'Repository not found or inaccessible.');
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, request(route, ListBranchesRequestSchema).page?.page === 2 ? { branches: [{ name: 'feature/UI', commitId: feature }] } : { branches: [{ name: 'main', commitId: head, protected: true }], page: { nextPage: 2 } });
    if(method==='GetRepositoryImage') return respond(route,GetRepositoryImageResponseSchema,{mediaType:'image/svg+xml',content:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><path fill="green" d="M0 0h100v30H0z"/><script>window.executed=true</script><image href="https://tracker.invalid/pixel"/></svg>')});
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      state.sourceRequests.push(input);
      if (state.sourceWait) await state.sourceWait;
      if (state.sourceStatus !== 200) return error(state.sourceStatus, state.sourceStatus === 403 ? 'Token does not have permission to read source.' : state.sourceStatus === 404 ? 'Source not found or inaccessible.' : 'Directory exceeds the supported response limit.');
      const commitId = input.ref === 'feature/UI' ? state.featureHead : /^[a-f]{40}$/.test(input.ref) ? input.ref : head;
      const sourcePath = input.path;
      if (!sourcePath) return respond(route, GetContentsResponseSchema, { commitId, kind: SourceEntryType.DIRECTORY, entries });
      if (sourcePath === 'src') return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: SourceEntryType.DIRECTORY, entries: [{ name: 'index.ts', path: 'src/index.ts', type: SourceEntryType.FILE, sha: head, size: 40n }] });
      if (sourcePath === 'src/index.ts') return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: SourceEntryType.FILE, file: { entry: { name: 'index.ts', path: sourcePath, type: SourceEntryType.FILE, sha: head, size: 40n }, content: state.sourceText } });
      const entry = entries.find((item) => item.path === sourcePath);
      if (!entry) return error(404, 'Source not found or inaccessible.');
      const reasons: Record<string, string> = { 'binary.png': 'Binary content cannot be previewed.', 'large.txt': 'File exceeds the 256 KiB preview limit.', 'pointer.lfs': 'Git LFS content is not fetched.', link: 'Symlink targets are not followed.', module: 'Submodule repositories are not followed.', 'huge.bin': 'File exceeds the 256 KiB preview limit.' };
      return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: entry.type, file: { entry, content: sourcePath === 'README.md' ? state.readme : sourcePath === 'empty.txt' ? '' : undefined, previewReason: reasons[sourcePath] } });
    }
    if (method === 'ListCommits') {
      const input = request(route, ListCommitsRequestSchema);
      if (!input.path && input.repositoryId && input.page?.limit === 1) return respond(route, ListCommitsResponseSchema, { repositoryId: input.repositoryId, commitId: input.ref, commits: [{ sha: input.ref, message: 'Improve keyboard navigation', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] });
      if(input.path){state.historyRequests.push(input);if(state.historyStatus!==200)return error(state.historyStatus,'History not found or inaccessible.');return respond(route,ListCommitsResponseSchema,{path:state.historyBinding?input.path:'another.txt',commitId:input.ref,repositoryId:input.repositoryId,commits:[{sha:head,message:'Exact file change',authorName:'Alex',authoredAt:'2026-10-01T12:00:00Z'}]});}
      const sha = input.ref === feature ? feature : head;
      return respond(route, ListCommitsResponseSchema, input.page?.page === 2 ? { commits: [{ sha: older, message: 'Initial repository', authorName: 'Alex', authoredAt: '2026-09-30T12:00:00Z' }] } : { commits: [{ sha, message: 'Improve keyboard navigation\n\nKeep focus visible everywhere.', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }], page: { nextPage: 2 } });
    }
    if (method === 'ListIssueComments') return respond(route, ListIssueCommentsResponseSchema, {});
    if (method === 'ListIssues' || method === 'GetIssue') {
      if (state.issueStatus !== 200) return error(state.issueStatus, state.issueStatus === 403 ? 'Issue browsing requires read:issue.' : 'Issue not found or inaccessible.');
      if (method === 'ListIssues') {
        const input = request(route, ListIssuesRequestSchema);
        return respond(route, ListIssuesResponseSchema, input.state === IssueState.CLOSED ? { issues: [closedIssue] } : input.state === IssueState.ALL ? { issues: [issue, closedIssue, secondIssue] } : input.page?.page === 2 ? { issues: [secondIssue] } : { issues: [issue], page: { nextPage: 2 } });
      }
      const number = request(route, GetIssueRequestSchema).number;
      if (number === 12) return respond(route, GetIssueResponseSchema, { issue });
      if (number === 13) return respond(route, GetIssueResponseSchema, { issue: closedIssue });
      if (number === 14) return respond(route, GetIssueResponseSchema, { issue: secondIssue });
      return error(404, 'Issue not found or inaccessible.');
    }
    return error(404, 'Repository not found or inaccessible.');
  });
  return state;
}

test('repository navigation pins snapshots, paginates branches, supports slash refs, back/forward and reload', async ({ page }) => {
  const state = await backend(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'alex/design-system', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${head}`));
  await page.getByRole('link', { name: 'src Directory', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`tree/${head}/src`));
  await page.getByRole('link', { name: 'index.ts File 40 B', exact: true }).click();
  await expect(page.getByLabel('Plain text preview of index.ts')).toContainText('PRIVATE_SOURCE');
  await page.goBack();
  await expect(page.getByRole('link', { name: 'index.ts File 40 B', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
  expect(state.sourceRequests.filter((input) => input.path).every((input) => input.ref === head)).toBe(true);
  await page.locator('.branch-picker > summary').click();
  await page.getByRole('button', { name: 'Load more branches' }).click();
  await page.getByRole('link', { name: `feature/UI Listed at ${feature.slice(0, 12)}` }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${feature}&branch=feature%2FUI`));
  await expect(page.getByRole('link', { name: 'README.md File 128 B', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Latest branch head' }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${feature}&branch=feature%2FUI`));
  expect(state.sourceRequests.some((input) => input.ref === 'feature/UI')).toBe(true);
  state.featureHead = older;
  await page.locator('.branch-picker > summary').click();
  await page.getByRole('link', { name: `feature/UI Listed at ${feature.slice(0, 12)}` }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${older}&branch=feature%2FUI`));
  expect(errors).toEqual([]);
});

test('source and issues render safe Markdown; excluded previews explain their boundaries', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=README.md`);
  await expect(page.getByLabel('Rendered README.md')).toContainText('PRIVATE README');
  await expect(page.locator('.markdown-body script, .markdown-body a')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  const reasons = { 'binary.png': 'Binary content cannot be previewed.', 'large.txt': 'File exceeds the 256 KiB preview limit.', 'pointer.lfs': 'Git LFS content is not fetched.', link: 'Symlink targets are not followed.', module: 'Submodule repositories are not followed.' };
  for (const [path, reason] of Object.entries(reasons)) {
    await page.goto(`/repositories/alex/design-system?ref=${head}&path=${path}`);
    await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.locator('.source-preview')).toHaveCount(0);
  }
  await page.goto('/repositories/alex/design-system?view=issues&issue=12');
  await expect(page.getByLabel('Issue body, rendered Markdown')).toContainText('image preview unavailable');
  await expect(page.locator('.markdown-body img, .markdown-body a')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|Make navigation/);
});

test('commit history paginates and opens the selected immutable source commit', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?view=commits&ref=${'d'.repeat(41)}`);
  await expect(page).toHaveURL(new RegExp(`ref=${head}`));
  await page.getByRole('button', { name: `Full commit message ${head.slice(0, 12)}`, exact: true }).click();
  await expect(page.locator('.commit-message pre')).toContainText('Keep focus visible everywhere.');
  await page.getByRole('button', { name: 'Load more commits' }).click();
  await page.getByRole('link', { name: `Browse commit ${older.slice(0, 12)}` }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${older}`));
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Code' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.commit-pin')).toHaveText(older.slice(0, 12));
});

test.describe('compact commit history', () => {
  test.use({ timezoneId: 'UTC' });
  test('date groups preserve native order across pagination and expose literal message and SHA controls', async ({ page }) => {
    await backend(page);
    const fourth = 'f'.repeat(40);
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } }));
    await page.route('**/rpc/golf.v1.RepositoryService/ListCommits', async route => {
      const next = request(route, ListCommitsRequestSchema).page?.page === 2;
      const second = { sha: feature, message: 'Second', authorName: 'Alex', authoredAt: '2026-10-01T19:00:00Z' };
      return respond(route, ListCommitsResponseSchema, next ? { commits: [second,
        { sha: older, message: 'Earlier date', authorName: 'Alex', authoredAt: '2026-09-30T12:00:00Z' },
        { sha: fourth, message: 'Later author date in native order', authorName: 'Alex', authoredAt: '2026-10-01T13:00:00Z' },
      ] } : { commits: [{ sha: head, message: 'First\n\n<script>private literal message</script>', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }, second], page: { nextPage: 2 } });
    });
    await page.goto('/alex/design-system/commits');
    await expect(page.locator('.commit-date-group')).toHaveCount(1);
    await page.getByRole('button', { name: `Full commit message ${head.slice(0, 12)}` }).click();
    await expect(page.locator('.commit-message pre')).toHaveText('First\n\n<script>private literal message</script>');
    await expect(page.locator('.commit-message script')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: `Full commit message ${head.slice(0, 12)}` })).toBeFocused();
    await expect(page.locator('.commit-message pre')).toBeHidden();
    await page.getByRole('button', { name: `Copy full SHA ${head.slice(0, 12)}` }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(head);
    await page.getByRole('button', { name: 'Load more commits' }).click();
    await expect(page.locator('.commit-date-group')).toHaveCount(3);
    await expect(page.locator('.commit-list h4')).toHaveText(['First', 'Second', 'Earlier date', 'Later author date in native order']);
    await expect(page.locator('.commit-date-group>h3')).toHaveText(['Authored on Oct 1, 2026', 'Authored on Sep 30, 2026', 'Authored on Oct 1, 2026']);
    expect(await page.locator('.commit-list>li').first().evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(90);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator('.repository-tabs [aria-current="page"]').evaluate(e => { const r = e.getBoundingClientRect(); const n = e.parentElement!.getBoundingClientRect(); return r.left >= n.left && r.right <= n.right; })).toBe(true);
    await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Issues', exact: true }).focus();
    await page.keyboard.press('Tab');
    const nav = page.getByRole('navigation', { name: 'Repository', exact: true });
    expect(await nav.evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(65);
    await expect(nav.getByRole('link', { name: 'Pull requests' })).toBeFocused();
    await expect.poll(() => nav.getByRole('link', { name: 'Pull requests' }).evaluate(e => { const r = e.getBoundingClientRect(); const n = e.parentElement!.getBoundingClientRect(); return r.left >= n.left && r.right <= n.right; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test('commit diff routes reject aliases and noncanonical IDs before repository requests', async ({ page }) => {
  const state = await backend(page);
  for (const commit of ['', 'main', 'refs/heads/main', 'a'.repeat(12), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(40), 'g'.repeat(40), ` ${head}`, `${head} `]) {
    await page.goto(`/repositories/alex/design-system?view=commits&commit=${encodeURIComponent(commit)}`);
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  }
  expect(state.methods).not.toContain('GetRepository');
  expect(state.methods).not.toContain('GetCommitDiff');
});

test('issues support state filters, pagination, deep-linked detail and isolated scope errors', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=issues');
  await page.getByRole('button', { name: 'Load more issues' }).click();
  await expect(page.getByRole('link', { name: secondIssue.title })).toBeVisible();
  await page.getByLabel('Issue state').selectOption('closed');
  await expect(page.getByRole('link', { name: closedIssue.title })).toBeVisible();
  await expect(page.getByRole('link', { name: issue.title })).toHaveCount(0);
  await page.getByLabel('Issue state').selectOption('all');
  await page.getByRole('link', { name: issue.title }).click();
  await expect(page).toHaveURL(/issues\/12\?state=all/);
  await expect(page.getByRole('heading', { name: `${issue.title} #12` })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
  state.issueStatus = 403;
  await page.getByRole('button', { name: 'Refresh issue', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Issue browsing requires read:issue.');
  await expect(page.getByLabel('Issue body, rendered Markdown')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Code' }).click();
  await expect(page.getByRole('link', { name: 'README.md File 128 B', exact: true })).toBeVisible();
});

test('empty repositories are normal, source bounds are visible, and missing repositories reveal no stale data', async ({ page }) => {
  const state = await backend(page);
  state.empty = true;
  await page.goto('/repositories/alex/design-system');
  await expect(page.getByRole('heading', { name: 'No commits yet.' })).toBeVisible();
  expect(state.methods.some((method) => ['GetContents', 'ListBranches', 'ListCommits'].includes(method))).toBe(false);
  state.empty = false;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('link', { name: 'README.md File 128 B', exact: true })).toBeVisible();
  state.sourceStatus = 502;
  await page.getByRole('button', { name: 'Refresh source' }).click();
  await expect(page.getByRole('alert')).toHaveText('Directory exceeds the supported response limit.');
  await expect(page.getByRole('link', { name: 'README.md File 128 B', exact: true })).toHaveCount(0);
  state.metadataStatus = 404;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByText(repository.description, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(0);
});

test('permission denial hides cached source through retries; expiry and sign-out clear every private panel', async ({ page }) => {
  const state = await backend(page);
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=src/index.ts`);
  await expect(page.getByLabel('Plain text preview of index.ts')).toContainText('PRIVATE_SOURCE');
  state.sourceStatus = 403;
  await page.getByRole('button', { name: 'Refresh source' }).click();
  await expect(page.getByRole('alert')).toHaveText('Token does not have permission to read source.');
  await expect(page.getByText('export const PRIVATE_SOURCE = true;', { exact: false })).toHaveCount(0);
  let release!: () => void;
  state.sourceWait = new Promise<void>((resolve) => { release = resolve; });
  state.sourceStatus = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Plain text preview of index.ts')).toHaveCount(0);
  release();
  await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
  state.sourceWait = undefined;
  state.signedIn = false;
  await page.getByRole('button', { name: 'Refresh source' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE_SOURCE', { exact: false })).toHaveCount(0);
  state.metadataStatus = 404;
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token').fill('another-session-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByText('PRIVATE_SOURCE', { exact: false })).toHaveCount(0);
  state.metadataStatus = 200;
  await page.goto('/repositories/alex/design-system?view=issues&issue=12');
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE ISSUE', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|another-session-token/);
});

test('repository browser is keyboard reachable and fits light/dark mobile screens', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=src/index.ts`);
  await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.screenshot({ path: 'test-results/repository-source-dark.png', fullPage: true });
  await page.locator('.branch-picker > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Load more branches' })).toBeVisible();
  await page.locator('.branch-picker > summary').focus();
  await page.keyboard.press('Enter');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repository-source-mobile-dark.png', fullPage: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Issues' }).click();
  await page.getByRole('link', { name: issue.title }).click();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
  await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Issues');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repository-issue-mobile-light.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/repository-issue-light.png', fullPage: true });
});

test('protobuf preserves empty previews and uint64 sizes while typed routes preserve numeric refs', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?ref=1234&branch=1234&path=empty.txt');
  await expect(page.getByLabel('Plain text preview of empty.txt')).toHaveText('(Empty text file)');
  expect(state.sourceRequests[0]?.ref).toBe('1234');
  await expect(page.locator('.branch-picker > summary')).toContainText('1234');
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=huge.bin`);
  await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
  await expect(page.locator('.file-meta [title="18446744073709551615 bytes"]')).toHaveText('16.0 EiB');
  await expect(page.locator('.source-preview')).toHaveCount(0);
  await page.goto('/repositories/alex/design-system?view=issues&issue=4294967296');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(state.methods).not.toContain('GetIssue');
});

test('repository branding keeps loaded fonts, legible text and reflow at 320px and 200%-equivalent width', async ({ page }) => {
  await backend(page);
  // 640 CSS px models a 1280px desktop viewport at 200% browser zoom;
  // pinch/page-scale emulation does not exercise layout reflow.
  for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light']) {
      await page.goto(`/repositories/alex/design-system?ref=${head}&path=src/index.ts`);
      await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true }).click();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Archivo');
      expect(await page.evaluate(() => [...document.fonts].some((font) => font.family.includes('Archivo') && font.status === 'loaded'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('link', { name: 'Golf home', exact: true })).toBeVisible();
      expect(await page.locator('.repository-tabs a').first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13);
      await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Issues', exact: true }).click();
      await page.getByRole('link', { name: issue.title, exact: true }).click();
      await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
      expect(await page.getByLabel('Issue body, rendered Markdown').evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
      await page.getByLabel('Comment, plain text', { exact: true }).focus();
      await page.keyboard.type('Keyboard accessible draft');
      await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeEnabled();
      await page.getByRole('link', { name: 'All open issues', exact: true }).click();
      await page.getByRole('button', { name: 'New issue', exact: true }).click();
      const dialog = page.getByRole('region', { name: 'New issue', exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().width <= innerWidth)).toBe(true);
      await dialog.getByLabel('Issue title', { exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Write', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Preview Markdown', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByLabel('Description, plain text', { exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
      await expect(page.getByRole('button', { name: 'New issue', exact: true })).toBeVisible();
    }
  }
});


test('README renders GFM, highlights code, pins relative links and blocks active content in both themes',async({page})=>{
 const state=await backend(page);
 state.readme='# Golf example\n\n| Name | Value |\n| --- | --- |\n| Mode | local |\n\n- [x] Ready\n\n```javascript\nconst answer = 42;\n```\n\n[Source](src/index.ts)\n[Unsafe](javascript:alert(1))\n![Tracker](https://tracker.invalid/pixel)\n<script>window.executed=true</script>';
 const requests:string[]=[];page.on('request',r=>{if(r.url().includes('tracker.invalid'))requests.push(r.url());});
 await page.setViewportSize({width:390,height:844});
 await page.goto('/repositories/alex/design-system');
 const readme=page.getByRole('region',{name:'Repository README'});
 await expect(readme.getByRole('heading',{name:'Golf example'})).toBeVisible();
 await expect(readme.getByRole('table')).toContainText('local');
 await expect(readme.getByRole('checkbox')).toBeChecked();await expect(readme.getByRole('checkbox')).toBeDisabled();
 await expect(readme.locator('.hljs-keyword')).toHaveText('const');
 await expect(readme.getByRole('link',{name:'Source',exact:true})).toHaveAttribute('href',`/alex/design-system/tree/${head}/src/index.ts`);
 await expect(readme.getByRole('link',{name:'Unsafe'})).toHaveCount(0);await expect(readme.locator('img,script,iframe')).toHaveCount(0);expect(requests).toEqual([]);
 expect(await page.evaluate(()=> 'executed' in window)).toBe(false);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);}
 await readme.getByRole('button',{name:'Source',exact:true}).click();
  await expect(readme.getByLabel('Source of README.md',{exact:true})).toContainText('# Golf example');
});

 test('HTML logos, heading anchors and image bytes render safely without external browser requests',async({page})=>{
 const state=await backend(page);state.readme='<div align="center"><img src="logo.svg" alt="Example logo" height="150"></div>\n\n# Example\n\n## Install\n\n[Jump](#install)\n\n## Install\n';
 const external:string[]=[];page.on('request',r=>{if(r.url().includes('tracker.invalid'))external.push(r.url());});
 await page.goto(`/alex/design-system/tree/${head}`);
 const readme=page.getByRole('region',{name:'Repository README'});
 await expect(readme.getByRole('img',{name:'Example logo'})).toBeVisible();
 await expect(readme.getByRole('img',{name:'Example logo'})).toHaveAttribute('height','150');
 expect((await readme.getByRole('img',{name:'Example logo'}).boundingBox())?.height).toBe(150);
 await expect(readme.locator('.markdown-align-center')).toBeVisible();
 await expect(readme.locator('#user-content-install')).toBeVisible();await expect(readme.locator('#user-content-install-1')).toBeVisible();
 await expect(readme.getByRole('link',{name:'Jump'})).toHaveAttribute('href','#user-content-install');
 await expect(readme.locator('script,[onerror],iframe')).toHaveCount(0);expect(external).toEqual([]);expect(await page.evaluate(()=> 'executed' in window)).toBe(false);
 await expect(page.getByRole('navigation',{name:'Breadcrumb'})).toContainText('alex');
 });


test('compact work lists share loaded search and sorting without inventing server filters', async ({ page }) => {
 const state = await backend(page);
 await page.goto('/alex/design-system/issues');
 await page.getByRole('button',{name:'Load more issues'}).click();
 await expect(page.locator('.issue-list>li')).toHaveCount(2);
 const before=state.methods.filter(m=>m==='ListIssues').length;
 await page.getByRole('searchbox',{name:'Search loaded issues'}).fill('management');
 await expect(page.locator('.issue-list>li')).toHaveCount(1);
 await expect(page.locator('.issue-list')).toContainText('Document focus management');
 await page.getByRole('searchbox',{name:'Search loaded issues'}).fill('');
 await page.getByLabel('Sort loaded issues').selectOption('title');
 await expect(page.locator('.issue-list>li').first()).toContainText('Document focus management');
 expect(state.methods.filter(m=>m==='ListIssues').length).toBe(before);
 });

test('branch search is loaded-only, preserves pagination and dismisses with keyboard focus', async ({ page }) => {
 const state = await backend(page);
 await page.goto('/alex/design-system');
 const trigger = page.locator('.branch-picker > summary');
 await trigger.click();
 const search = page.getByRole('searchbox', {name:'Search loaded branches'});
 await search.fill('feature');
 await expect(page.getByText('No loaded branches match your search.')).toBeVisible();
 const before = state.methods.filter(m => m === 'ListBranches').length;
 await page.getByRole('button', {name:'Load more branches'}).click();
 await expect(page.locator('.branch-options li')).toHaveCount(1);
 await expect(page.locator('.branch-options li')).toContainText('feature/UI');
 expect(state.methods.filter(m => m === 'ListBranches').length).toBe(before + 1);
 await search.press('Escape');
 await expect(trigger).toBeFocused();
 await expect(search).toBeHidden();
 await trigger.click();
 await expect(search).toHaveValue('');
 await expect(page.locator('.branch-options li')).toHaveCount(2);
});

test('clone protocol and shared source copy use exact text and handle unavailable clipboard', async ({ page }) => {
 const state = await backend(page);
 state.readme = '```sh\nprintf "<literal>"\n```';
 await page.addInitScript(() => { Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as unknown as {copied:string}).copied=text;}}}); });
 await page.goto('/alex/design-system');
 await page.locator('.clone-picker > summary').click();
 await expect(page.getByLabel('HTTPS clone URL',{exact:true})).toHaveValue(repository.cloneUrl);
 await page.getByRole('button',{name:'Copy HTTPS clone URL'}).click();
 expect(await page.evaluate(() => (window as unknown as {copied:string}).copied)).toBe(repository.cloneUrl);
 await page.getByRole('button',{name:'SSH',exact:true}).click();
 await expect(page.getByLabel('SSH clone URL',{exact:true})).toHaveValue(repository.sshUrl);
 await page.getByRole('button',{name:'Copy SSH clone URL'}).click();
 expect(await page.evaluate(() => (window as unknown as {copied:string}).copied)).toBe(repository.sshUrl);
 await page.getByRole('button',{name:'SSH',exact:true}).press('Escape');
 await expect(page.locator('.clone-picker > summary')).toBeFocused();
 await page.getByRole('button',{name:'Copy code block'}).click();
 expect(await page.evaluate(() => (window as unknown as {copied:string}).copied)).toBe('printf "<literal>"\n');
 await page.goto(`/alex/design-system/blob/${head}/empty.txt`);
 await page.getByRole('button',{name:'Copy source of empty.txt'}).click();
 expect(await page.evaluate(() => (window as unknown as {copied:string}).copied)).toBe('');
 await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
 await page.getByRole('button',{name:'Copy source of empty.txt'}).click();
 await expect(page.getByRole('status').filter({hasText:'Copy unavailable.'})).toBeAttached();
});

for(const theme of ['dark','light'])for(const width of [1280,390])test(`source lines/actions and literal path history ${theme} ${width}`,async({page,context})=>{
 const state=await backend(page);state.sourceText='export const PRIVATE_SOURCE = "<script>window.executed=true</script>";\r\n\r\n/* a multiline\r\n   comment */\r\n';
 await context.grantPermissions(['clipboard-read','clipboard-write']);await page.setViewportSize({width,height:900});await page.goto(`/alex/design-system/blob/${head}/src/index.ts#L2-L4`);
 const toggle=page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true});if(await toggle.count())await toggle.click();
 await expect(page.locator('.numbered-source tr')).toHaveCount(4);await expect(page.locator('.source-line-selected')).toHaveCount(3);await expect(page.locator('.source-code-text script,.source-code-text img')).toHaveCount(0);
 expect(await page.evaluate(()=>Boolean((window as typeof window & {executed?:boolean}).executed))).toBe(false);
 await expect(page.locator('#L3 .hljs-comment')).toContainText('/* a multiline');await expect(page.locator('#L4 .hljs-comment')).toContainText('comment */');
 await page.getByRole('link',{name:'Line 1',exact:true}).click();await page.getByRole('link',{name:'Line 3',exact:true}).click({modifiers:['Shift']});await expect(page).toHaveURL(/#L1-L3$/);await expect(page.locator('.source-line-selected')).toHaveCount(3);
 await page.getByRole('link',{name:'Line 4',exact:true}).click();await page.getByRole('link',{name:'Line 2',exact:true}).click({modifiers:['Shift']});await expect(page).toHaveURL(/#L2-L4$/);await page.getByRole('link',{name:'Line 3',exact:true}).click({modifiers:['Shift']});await expect(page).toHaveURL(/#L3-L4$/);await page.getByRole('link',{name:'Line 1',exact:true}).click();await page.getByRole('link',{name:'Line 3',exact:true}).click({modifiers:['Shift']});
 await page.getByLabel('Source actions',{exact:true}).click();const bounds=await page.locator('.source-action-options').boundingBox();expect(bounds).toBeTruthy();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
 await page.getByLabel('Copy source permalink',{exact:true}).click();const link=await page.evaluate(()=>navigator.clipboard.readText());expect(new URL(link).pathname).toBe(`/alex/design-system/blob/${head}/src/index.ts`);expect(new URL(link).hash).toBe('#L1-L3');
 await page.getByLabel('Copy repository path',{exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('src/index.ts');
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download text',exact:true}).click();const download=await downloading;expect(download.suggestedFilename()).toBe('index.ts');const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(chunk);expect(Buffer.concat(chunks).toString('utf8')).toBe(state.sourceText);
 await page.getByLabel('Source actions',{exact:true}).press('Escape');await expect(page.getByLabel('Source actions',{exact:true})).toBeFocused();await expect(page.locator('.source-action-menu')).not.toHaveAttribute('open','');
 await page.getByRole('link',{name:'History',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/commits/${head}/src/index.ts`));await expect(page.getByRole('link',{name:'Exact file change',exact:true})).toBeVisible();expect(state.historyRequests.at(-1)?.path).toBe('src/index.ts');expect(state.historyRequests.at(-1)?.repositoryId).toBe(repository.id);expect(state.historyRequests.at(-1)?.ref).toBe(head);await expect(page.locator('.branch-picker')).toHaveCount(0);
 await page.reload();await expect(page.getByRole('link',{name:'Exact file change',exact:true})).toBeVisible();await page.getByRole('link',{name:'Back to source',exact:true}).click();await expect(page.locator('.numbered-source tr')).toHaveCount(4);
 await page.getByRole('link',{name:'History',exact:true}).click();await page.getByRole('navigation',{name:'Repository',exact:true}).getByRole('link',{name:'Commits',exact:true}).click();await expect(page.getByRole('link',{name:'Improve keyboard navigation',exact:true})).toBeVisible();expect(new URL(page.url()).pathname).toBe('/alex/design-system/commits');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('path history rejects mismatched binding and denied source hides its actions',async({page})=>{
 const state=await backend(page);state.historyBinding=false;await page.goto(`/alex/design-system/commits/${head}/src/index.ts`);await expect(page.getByRole('alert')).toContainText('returned history does not match');await expect(page.getByRole('link',{name:'Exact file change',exact:true})).toHaveCount(0);
 state.historyBinding=true;state.historyStatus=404;await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('alert')).toContainText('History not found');state.sourceStatus=403;await page.goto(`/alex/design-system/blob/${head}/src/index.ts`);await expect(page.getByRole('alert')).toContainText('permission');await expect(page.getByLabel('Source actions',{exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'History',exact:true})).toHaveCount(0);
});

test('invalid line fragments and empty/large preview limits',async({page})=>{
 const state=await backend(page);state.sourceText='one\ntwo\n';await page.goto(`/alex/design-system/blob/${head}/src/index.ts#L1-L999`);await expect(page.locator('.numbered-source tr')).toHaveCount(2);await expect(page.locator('.source-line-selected')).toHaveCount(0);
 state.sourceText='\n'.repeat(12001);await page.getByLabel('Refresh source',{exact:true}).click();await expect(page.locator('.code-preview')).toBeVisible();await expect(page.locator('.numbered-source')).toHaveCount(0);
 await page.goto(`/alex/design-system/blob/${head}/empty.txt`);await expect(page.getByLabel('Plain text preview of empty.txt')).toContainText('(Empty text file)');await page.getByLabel('Source actions',{exact:true}).click();await expect(page.getByRole('button',{name:'Download text',exact:true})).toBeEnabled();await page.goto(`/alex/design-system/blob/${head}/binary.png`);await page.getByLabel('Source actions',{exact:true}).click();await expect(page.getByRole('button',{name:'Download text',exact:true})).toBeDisabled();
});

for (const width of [320, 1280, 1920]) for (const theme of ['dark', 'light']) test(`Code latest commit and native tags fit bounded workspace at ${width}px ${theme}`, async ({ page }) => {
  await backend(page);
  const tagReads: ReturnType<typeof request<typeof ListTagsRequestSchema>>[] = [];
  await page.route('**/rpc/golf.v1.RepositoryService/ListTags', async route => {
    const input = request(route, ListTagsRequestSchema); tagReads.push(input);
    return respond(route, ListTagsResponseSchema, { repositoryId: repository.id, totalCount: '2',
      tags: input.page?.page === 2 ? [{ name: 'release/2.0', commitId: older, id: feature }] : [{ name: 'v1.0', commitId: feature, id: older }],
      page: input.page?.page === 2 ? undefined : { nextPage: 2 } });
  });
  await page.setViewportSize({ width, height: 1000 }); await page.goto(`/alex/design-system/tree/${head}?branch=main`);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; localStorage.setItem('golf.theme', value); }, theme);
  const banner = page.getByLabel('Latest commit', { exact: true });
  await expect(banner).toContainText('Alex'); await expect(banner.getByRole('link', { name: 'Improve keyboard navigation', exact: true })).toBeVisible();
  await expect(banner.locator('time')).toHaveAttribute('datetime', '2026-10-01T12:00:00Z');
  await expect(banner.locator('time')).toHaveAttribute('title', /2026/);
  expect(tagReads).toHaveLength(0);
  const tags = page.locator('.ref-controls>.ref-inventory-button').filter({ hasText: 'Tags' });
  await expect(tags).toHaveText('Tags'); await tags.click();
  await expect(page.getByRole('link', { name: /v1.0 Listed at/ })).toBeVisible();
  expect(tagReads[0]).toMatchObject({ repository: { owner: 'alex', name: 'design-system' }, repositoryId: repository.id, page: { page: 1 } });
  await expect(tags).toHaveText('2 Tags');
  await page.getByRole('button', { name: 'Load more tags', exact: true }).click();
  await page.getByRole('link', { name: /release\/2.0 Listed at/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tree/${older}`));
  expect(new URL(page.url()).searchParams.get('tag')).toBe('release/2.0');
  expect(new URL(page.url()).searchParams.get('branch')).toBeNull();
  await expect(page.locator('.branch-picker>summary')).toHaveText('release/2.0');
  await expect(page.getByRole('button', { name: 'Latest branch head', exact: true })).toHaveCount(0);
  await expect(banner.locator('.latest-commit-sha')).toHaveAttribute('title', older);
  await page.reload(); await expect(page.locator('.branch-picker>summary')).toHaveText('release/2.0');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const main = await page.locator('main').boundingBox();
  expect(main!.width).toBe(Math.min(width, 1440)); expect(main!.x).toBe((width - main!.width) / 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({ path: `test-results/repository-code-summary-${theme}-${width}.png` });
});

for (const invalid of ['repository', 'snapshot', 'sha', 'empty', 'date', 'denied']) test(`latest commit banner refuses ${invalid} evidence`, async ({ page }) => {
  await backend(page);
  await page.route('**/rpc/golf.v1.RepositoryService/ListCommits', async route => {
    const input = request(route, ListCommitsRequestSchema);
    if (input.path || input.page?.limit !== 1) return route.fallback();
    if (invalid === 'denied') return reject(route, 'permission_denied', 'Not authorized.');
    return respond(route, ListCommitsResponseSchema, { repositoryId: invalid === 'repository' ? '7' : input.repositoryId,
      commitId: invalid === 'snapshot' ? feature : input.ref, commits: invalid === 'empty' ? [] : [{ sha: invalid === 'sha' ? feature : input.ref,
        message: 'PRIVATE mismatched commit', authorName: 'PRIVATE author', authoredAt: invalid === 'date' ? 'invalid' : '2026-10-01T12:00:00Z' }] });
  });
  await page.goto(`/alex/design-system/tree/${head}`);
  await expect(page.getByLabel('Latest commit', { exact: true })).toHaveText('Latest commit unavailable');
  await expect(page.getByLabel('Latest commit', { exact: true })).not.toContainText('PRIVATE');
  await expect(page.getByLabel('Latest commit', { exact: true }).getByRole('link')).toHaveCount(0);
});

test('tag inventory rejects wrong identity and never substitutes loaded-page count for native total', async ({ page }) => {
  await backend(page); let bad = true;
  await page.route('**/rpc/golf.v1.RepositoryService/ListTags', async route => respond(route, ListTagsResponseSchema, {
    repositoryId: bad ? '7' : repository.id, tags: [{ name: 'PRIVATE tag', commitId: feature, id: older }],
  }));
  await page.goto(`/alex/design-system/tree/${head}`);
  const tags = page.locator('.ref-controls>.ref-inventory-button').filter({ hasText: 'Tags' });
  await tags.click(); await expect(page.getByRole('alert')).toContainText('do not match');
  await expect(page.locator('.branch-picker>.branch-options')).not.toContainText('PRIVATE tag');
  bad = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('link', { name: /PRIVATE tag Listed at/ })).toBeVisible();
  await expect(tags).toHaveText('Tags');
  await page.locator('.branch-picker>summary').press('Escape'); await expect(page.locator('.branch-picker>summary')).toBeFocused();
});
