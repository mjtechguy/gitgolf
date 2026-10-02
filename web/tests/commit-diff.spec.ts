import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  CommitDiffBase, GetAuthenticationOptionsResponseSchema, GetCommitDiffRequestSchema, GetCommitDiffResponseSchema,
  GetContentsRequestSchema, GetContentsResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema,
  ListBranchesResponseSchema, ListCapabilitiesResponseSchema, ListCommitsRequestSchema, ListCommitsResponseSchema,
  ListRepositoriesResponseSchema, LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

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
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.repositoryDenied ? reject(route, 'not_found', 'Repository not found or inaccessible.') : respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListBranches') return respond(route, ListBranchesResponseSchema, { branches: [{ name: 'feature/UI', commitId: head }] });
    if (method === 'ListCommits') {
      state.historyRefs.push(request(route, ListCommitsRequestSchema).ref);
      return respond(route, ListCommitsResponseSchema, { commits: [{ sha: head, message, authorName: 'Alex', authoredAt: '2026-10-01T12:00:00Z' }] });
    }
    if (method === 'GetContents') {
      const input = request(route, GetContentsRequestSchema); state.sourceRefs.push(input.ref);
      return respond(route, GetContentsResponseSchema, { commitId: input.ref, kind: SourceEntryType.DIRECTORY, entries: [] });
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
  await expect(page).toHaveURL(new RegExp(`commit=${head}`));
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
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
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
  await expect(page.getByText('not merge eligibility or independently verified patch evidence', { exact: false })).toBeVisible();
  state.raw = '';
  await page.goto(diffURL(sha256));
  await expect(page.getByRole('heading', { name: 'No diff text returned' })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  expect(state.commits.at(-1)).toBe(sha256);
  await expect(page.locator('.commit-diff-metadata')).toContainText(sha256);
});

test('typed diff failures remove cached text, retries hide stale content and repository denial clears metadata', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(head));
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
  for (const failure of ['permission_denied', 'not_found', 'failed_precondition', 'resource_exhausted', 'unavailable'] as const) {
    state.failure = failure;
    await page.getByRole('button', { name: 'Refresh diff', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(`Diff unavailable: ${failure}.`);
    await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
    await expect(page.locator('.commit-diff-metadata')).toHaveCount(0);
    state.failure = undefined;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
  }
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh diff', exact: true }).click();
  await expect(page.getByText('Loading commit diff…', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  release();
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
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
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
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
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
  state.failure = 'unauthenticated';
  await page.getByRole('button', { name: 'Refresh diff' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  await expect(page.locator('.commit-diff-metadata')).toHaveCount(0);
});

test('sign-out cancels a pending diff and a fresh login cannot reuse its private response', async ({ page }) => {
  const state = await backend(page);
  await page.goto(diffURL(head));
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
  let release!: () => void;
  state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Refresh diff' }).click();
  await expect(page.getByText('Loading commit diff…')).toBeVisible();
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/GetCommitDiff'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await aborted;
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  state.barrier = undefined; state.failure = 'permission_denied'; release();
  await page.getByLabel('Gitea access token').fill('fixture-only-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Diff unavailable: permission_denied.');
  await expect(page.getByLabel('Unified diff, plain text')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('PRIVATE_DIFF');
});

test('plain text diff stays keyboard-scrollable and fits charcoal and light mobile layouts', async ({ page }) => {
  const state = await backend(page); state.raw += `+${'long line '.repeat(200)}\n`;
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(diffURL(merge));
  await expect(page.getByLabel('Unified diff, plain text')).toBeVisible();
  await expect(page.getByLabel('Commit message, plain text')).toHaveText(message);
  await expect(page.locator('.commit-diff-preview img,.commit-diff-preview a,.commit-diff-message script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.getByLabel('Unified diff, plain text').focus();
  await expect(page.getByLabel('Unified diff, plain text')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/commit-diff-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Light theme' }).click();
  await page.screenshot({ path: 'test-results/commit-diff-light-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
