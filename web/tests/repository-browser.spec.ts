import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsRequestSchema, GetContentsResponseSchema, GetIssueRequestSchema, GetIssueResponseSchema, GetRepositoryResponseSchema,
  GetSessionResponseSchema, IssueSchema, IssueState, ListBranchesRequestSchema, ListBranchesResponseSchema, ListCapabilitiesResponseSchema,
  ListCommitsRequestSchema, ListCommitsResponseSchema, ListIssuesRequestSchema, ListIssuesResponseSchema, ListRepositoriesResponseSchema,
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
  const state = { featureHead: feature, signedIn: true, empty: false, metadataStatus: 200, sourceStatus: 200, issueStatus: 200, sourceWait: undefined as Promise<void> | undefined, methods: [] as string[], sourceRequests: [] as GetContentsRequest[] };
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
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema);
      state.sourceRequests.push(input);
      if (state.sourceWait) await state.sourceWait;
      if (state.sourceStatus !== 200) return error(state.sourceStatus, state.sourceStatus === 403 ? 'Token does not have permission to read source.' : state.sourceStatus === 404 ? 'Source not found or inaccessible.' : 'Directory exceeds the supported response limit.');
      const commitId = input.ref === 'feature/UI' ? state.featureHead : /^[a-f]{40}$/.test(input.ref) ? input.ref : head;
      const sourcePath = input.path;
      if (!sourcePath) return respond(route, GetContentsResponseSchema, { commitId, kind: SourceEntryType.DIRECTORY, entries });
      if (sourcePath === 'src') return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: SourceEntryType.DIRECTORY, entries: [{ name: 'index.ts', path: 'src/index.ts', type: SourceEntryType.FILE, sha: head, size: 40n }] });
      if (sourcePath === 'src/index.ts') return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: SourceEntryType.FILE, file: { entry: { name: 'index.ts', path: sourcePath, type: SourceEntryType.FILE, sha: head, size: 40n }, content: 'export const PRIVATE_SOURCE = true;\n' } });
      const entry = entries.find((item) => item.path === sourcePath);
      if (!entry) return error(404, 'Source not found or inaccessible.');
      const reasons: Record<string, string> = { 'binary.png': 'Binary content cannot be previewed.', 'large.txt': 'File exceeds the 256 KiB preview limit.', 'pointer.lfs': 'Git LFS content is not fetched.', link: 'Symlink targets are not followed.', module: 'Submodule repositories are not followed.', 'huge.bin': 'File exceeds the 256 KiB preview limit.' };
      return respond(route, GetContentsResponseSchema, { commitId, path: sourcePath, kind: entry.type, file: { entry, content: sourcePath === 'README.md' ? '# PRIVATE README\n<script>window.executed=true</script>\n<a href="javascript:alert(1)">Untrusted</a>\n' : sourcePath === 'empty.txt' ? '' : undefined, previewReason: reasons[sourcePath] } });
    }
    if (method === 'ListCommits') {
      const input = request(route, ListCommitsRequestSchema);
      const sha = input.ref === feature ? feature : head;
      return respond(route, ListCommitsResponseSchema, input.page?.page === 2 ? { commits: [{ sha: older, message: 'Initial repository', authorName: 'Alex', authoredAt: '2026-09-30T12:00:00Z' }] } : { commits: [{ sha, message: 'Improve keyboard navigation\n\nKeep focus visible everywhere.', authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }], page: { nextPage: 2 } });
    }
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
  await expect(page).toHaveURL(new RegExp(`ref=${head}.*path=src`));
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

test('source and issue bodies are plain text; excluded previews explain their boundaries', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=README.md`);
  await expect(page.getByLabel('Plain text preview of README.md')).toContainText('<script>window.executed=true</script>');
  await expect(page.locator('.source-preview script, .source-preview a')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  const reasons = { 'binary.png': 'Binary content cannot be previewed.', 'large.txt': 'File exceeds the 256 KiB preview limit.', 'pointer.lfs': 'Git LFS content is not fetched.', link: 'Symlink targets are not followed.', module: 'Submodule repositories are not followed.' };
  for (const [path, reason] of Object.entries(reasons)) {
    await page.goto(`/repositories/alex/design-system?ref=${head}&path=${path}`);
    await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.locator('.source-preview')).toHaveCount(0);
  }
  await page.goto('/repositories/alex/design-system?view=issues&issue=12');
  await expect(page.getByLabel('Issue body, plain text')).toContainText('<img src=x onerror="window.executed=true">');
  await expect(page.locator('.issue-body img, .issue-body a')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|Make navigation/);
});

test('commit history paginates and opens the selected immutable source commit', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?view=commits&ref=${'d'.repeat(41)}`);
  await expect(page).toHaveURL(new RegExp(`ref=${head}`));
  await page.getByText('Full commit message', { exact: true }).click();
  await expect(page.locator('.commit-message pre')).toContainText('Keep focus visible everywhere.');
  await page.getByRole('button', { name: 'Load more commits' }).click();
  await page.getByRole('link', { name: `Browse commit ${older.slice(0, 12)}` }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${older}`));
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Source' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.commit-pin')).toHaveText(older.slice(0, 12));
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
  await expect(page).toHaveURL(/view=issues&state=all&issue=12/);
  await expect(page.getByRole('heading', { name: `${issue.title} #12` })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Issue body, plain text')).toBeVisible();
  state.issueStatus = 403;
  await page.getByRole('button', { name: 'Refresh issue', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Issue browsing requires read:issue.');
  await expect(page.getByLabel('Issue body, plain text')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Source' }).click();
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
  await page.getByLabel('Gitea access token').fill('another-session-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByText('PRIVATE_SOURCE', { exact: false })).toHaveCount(0);
  state.metadataStatus = 200;
  await page.goto('/repositories/alex/design-system?view=issues&issue=12');
  await expect(page.getByLabel('Issue body, plain text')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE ISSUE', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|another-session-token/);
});

test('repository browser is keyboard reachable and fits light/dark mobile screens', async ({ page }) => {
  await backend(page);
  await page.goto(`/repositories/alex/design-system?ref=${head}&path=src/index.ts`);
  await expect(page.getByLabel('Plain text preview of index.ts')).toBeVisible();
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.screenshot({ path: 'test-results/repository-source-dark.png', fullPage: true });
  await page.locator('.branch-picker > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Load more branches' })).toBeVisible();
  await page.locator('.branch-picker > summary').focus();
  await page.keyboard.press('Enter');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repository-source-mobile-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Light theme' }).click();
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Issues' }).click();
  await page.getByRole('link', { name: issue.title }).click();
  await expect(page.getByLabel('Issue body, plain text')).toBeVisible();
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
