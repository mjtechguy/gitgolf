import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Issue, RepositoryDetail, SourceEntry } from '../src/api';

const head = 'a'.repeat(40);
const feature = 'b'.repeat(40);
const older = 'c'.repeat(40);
const user = { id: 7, login: 'alex', full_name: 'Alex', avatar_url: '' };
const repository: RepositoryDetail = {
  id: 1, name: 'design-system', full_name: 'alex/design-system', description: 'A shared foundation for our next idea.', private: true,
  html_url: 'https://forge.example/alex/design-system', default_branch: 'main', updated_at: '2026-10-01T12:00:00Z', empty: false,
  clone_url: 'https://forge.example/alex/design-system.git', ssh_url: 'git@forge.example:alex/design-system.git',
};
const issue: Issue = { id: 1, number: 12, title: 'Make navigation keyboard accessible', body: '# PRIVATE ISSUE\n<img src=x onerror="window.executed=true">\n[Unsafe](javascript:alert(1))', state: 'open', user, comments: 3, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', html_url: 'https://forge.example/alex/design-system/issues/12' };
const closedIssue = { ...issue, id: 2, number: 13, title: 'Fix focus order', body: '', state: 'closed' };
const secondIssue = { ...issue, id: 3, number: 14, title: 'Document focus management' };
const entries: SourceEntry[] = [
  { name: 'src', path: 'src', type: 'dir', sha: head, size: 0 },
  ...['README.md', 'binary.png', 'large.txt', 'pointer.lfs', 'link', 'module'].map((name): SourceEntry => ({ name, path: name, type: name === 'link' ? 'symlink' : name === 'module' ? 'submodule' : 'file', sha: head, size: name === 'large.txt' ? 300_000 : 128 })),
];

async function backend(page: Page) {
  const state = { featureHead: feature, signedIn: true, empty: false, metadataStatus: 200, sourceStatus: 200, issueStatus: 200, sourceWait: undefined as Promise<void> | undefined, calls: [] as URL[] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    state.calls.push(url);
    const error = (status: number, message: string) => route.fulfill({ status, json: { error: { code: status === 403 ? 'scope_required' : status === 404 ? 'not_found' : 'upstream_error', message } } });
    if (path === '/api/session') {
      if (request.method() === 'POST') state.signedIn = true;
      if (request.method() === 'DELETE') { state.signedIn = false; return route.fulfill({ status: 204 }); }
      return state.signedIn ? route.fulfill({ json: { user } }) : error(401, 'Sign in required.');
    }
    if (!state.signedIn) return error(401, 'Your session expired.');
    if (path === '/api/capabilities') return route.fulfill({ json: { capabilities: [] } });
    if (path === '/api/repositories') return route.fulfill({ json: { repositories: [repository] } });
    if (path === '/api/repositories/alex/design-system') return state.metadataStatus === 200 ? route.fulfill({ json: { repository: { ...repository, empty: state.empty } } }) : error(state.metadataStatus, 'Repository not found or inaccessible.');
    if (path.endsWith('/branches')) return route.fulfill({ json: url.searchParams.get('page') === '2' ? { branches: [{ name: 'feature/UI', commit_id: feature, protected: false }] } : { branches: [{ name: 'main', commit_id: head, protected: true }], next_page: 2 } });
    if (path.endsWith('/contents')) {
      if (state.sourceWait) await state.sourceWait;
      if (state.sourceStatus !== 200) return error(state.sourceStatus, state.sourceStatus === 403 ? 'Token does not have permission to read source.' : state.sourceStatus === 404 ? 'Source not found or inaccessible.' : 'Directory exceeds the supported response limit.');
      const ref = url.searchParams.get('ref');
      const commit_id = ref === 'feature/UI' ? state.featureHead : ref && /^[a-f]{40}$/.test(ref) ? ref : head;
      const sourcePath = url.searchParams.get('path') || '';
      if (!sourcePath) return route.fulfill({ json: { commit_id, path: '', kind: 'directory', entries } });
      if (sourcePath === 'src') return route.fulfill({ json: { commit_id, path: sourcePath, kind: 'directory', entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file', sha: head, size: 40 }] } });
      if (sourcePath === 'src/index.ts') return route.fulfill({ json: { commit_id, path: sourcePath, kind: 'file', file: { name: 'index.ts', path: sourcePath, type: 'file', sha: head, size: 40, content: 'export const PRIVATE_SOURCE = true;\n' } } });
      const entry = entries.find((item) => item.path === sourcePath);
      if (!entry) return error(404, 'Source not found or inaccessible.');
      const reasons: Record<string, string> = { 'binary.png': 'Binary content cannot be previewed.', 'large.txt': 'File exceeds the 256 KiB preview limit.', 'pointer.lfs': 'Git LFS content is not fetched.', link: 'Symlink targets are not followed.', module: 'Submodule repositories are not followed.' };
      return route.fulfill({ json: { commit_id, path: sourcePath, kind: entry.type, file: { ...entry, content: sourcePath === 'README.md' ? '# PRIVATE README\n<script>window.executed=true</script>\n<a href="javascript:alert(1)">Untrusted</a>\n' : undefined, preview_reason: reasons[sourcePath] } } });
    }
    if (path.endsWith('/commits')) {
      const sha = url.searchParams.get('ref') === feature ? feature : head;
      return route.fulfill({ json: url.searchParams.get('page') === '2' ? { commits: [{ sha: older, message: 'Initial repository', author_name: 'Alex', authored_at: '2026-09-30T12:00:00Z' }] } : { commits: [{ sha, message: 'Improve keyboard navigation\n\nKeep focus visible everywhere.', author_name: 'Alex', authored_at: '2026-10-01T12:00:00Z' }], next_page: 2 } });
    }
    if (path.includes('/issues')) {
      if (state.issueStatus !== 200) return error(state.issueStatus, state.issueStatus === 403 ? 'Issue browsing requires read:issue.' : 'Issue not found or inaccessible.');
      if (path.endsWith('/issues')) {
        const selected = url.searchParams.get('state');
        return route.fulfill({ json: selected === 'closed' ? { issues: [closedIssue] } : selected === 'all' ? { issues: [issue, closedIssue, secondIssue] } : url.searchParams.get('page') === '2' ? { issues: [secondIssue] } : { issues: [issue], next_page: 2 } });
      }
      if (path.endsWith('/12')) return route.fulfill({ json: { issue } });
      if (path.endsWith('/13')) return route.fulfill({ json: { issue: closedIssue } });
      if (path.endsWith('/14')) return route.fulfill({ json: { issue: secondIssue } });
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
  expect(state.calls.filter((url) => url.pathname.endsWith('/contents') && url.searchParams.get('path')).every((url) => url.searchParams.get('ref') === head)).toBe(true);
  await page.locator('.branch-picker > summary').click();
  await page.getByRole('button', { name: 'Load more branches' }).click();
  await page.getByRole('link', { name: `feature/UI Listed at ${feature.slice(0, 12)}` }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${feature}&branch=feature%2FUI`));
  await expect(page.getByRole('link', { name: 'README.md File 128 B', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Latest branch head' }).click();
  await expect(page).toHaveURL(new RegExp(`ref=${feature}&branch=feature%2FUI`));
  expect(state.calls.some((url) => url.pathname.endsWith('/contents') && url.searchParams.get('ref') === 'feature/UI')).toBe(true);
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
  expect(state.calls.some((url) => /\/(contents|branches|commits)$/.test(url.pathname))).toBe(false);
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/repository-issue-mobile-light.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/repository-issue-light.png', fullPage: true });
});
