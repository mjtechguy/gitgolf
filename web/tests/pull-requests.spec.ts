import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  GetAuthenticationOptionsResponseSchema, GetContentsResponseSchema, GetPullRequestRequestSchema, GetPullRequestResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, IssueState, ListCapabilitiesResponseSchema, ListPullRequestReviewsRequestSchema,
  ListPullRequestReviewsResponseSchema, ListPullRequestsRequestSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema,
  LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, PullRequestReviewSchema, PullRequestReviewState, PullRequestSchema, PullRequestRefSchema,
  RepositorySchema, SourceEntryType, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const user = create(UserSchema, { id: '9007199254740993', login: 'alex', fullName: 'Alex' });
const repository = create(RepositorySchema, { id: '9007199254740993', name: 'design-system', fullName: 'alex/design-system', private: true, defaultBranch: 'main', description: 'A private repository.', htmlUrl: 'https://forge.example/alex/design-system' });
const pull = create(PullRequestSchema, { id: '9007199254740994', number: 12, title: 'Make every control keyboard accessible', body: '# PRIVATE PULL\n<img src=x onerror="window.executed=true">\n[Unsafe](javascript:alert(1))', state: IssueState.OPEN, user, draft: true,
  createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', htmlUrl: 'https://forge.example/alex/design-system/pulls/12',
  base: { repositoryId: repository.id, label: 'alex:main', ref: 'main', commitId: base },
  head: { repositoryId: '9007199254740995', label: 'contributor:feature/keyboard', ref: 'feature/keyboard', commitId: head },
});
const closed = create(PullRequestSchema, { ...pull, id: '9007199254740996', number: 13, title: 'Ship focus indicators', state: IssueState.CLOSED, draft: false, merged: true, mergedAt: '2026-10-02T13:00:00Z', mergeCommitId: merged });
const snapshot = create(PullRequestSchema, { ...pull, id: '9007199254740997', number: 14, title: 'Retained contribution', user: undefined, htmlUrl: 'javascript:alert(1)', draft: false, head: create(PullRequestRefSchema, { repositoryId: '', label: 'Deleted source', ref: 'refs/pull/14/head', commitId: head, retainedSnapshot: true }) });
const review = create(PullRequestReviewSchema, { id: '9007199254740998', user, body: 'PRIVATE REVIEW\n<script>window.executed=true</script>\n[Link](javascript:alert(1))', state: PullRequestReviewState.APPROVED, commitId: head, stale: true, dismissed: true, official: true, submittedAt: '2026-10-01T14:00:00Z', updatedAt: '2026-10-02T14:00:00Z', htmlUrl: 'https://forge.example/alex/design-system/pulls/12#review' });
const pending = create(PullRequestReviewSchema, { ...review, id: '9007199254740999', user: undefined, body: '', state: PullRequestReviewState.PENDING, stale: false, dismissed: false, official: false, htmlUrl: 'javascript:alert(1)' });

async function backend(page: Page) {
  const state = { signedIn: true, metadataStatus: 200, listStatus: 200, detailStatus: 200, reviewStatus: 200, empty: false,
    reviewWait: undefined as Promise<void> | undefined, detailWait: undefined as Promise<void> | undefined,
    methods: [] as string[], pages: [] as number[], reviewPages: [] as number[], states: [] as IssueState[], numbers: [] as number[] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    state.methods.push(method);
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['connect-protocol-version']).toBe('1');
    const error = (status: number, message: string) => reject(route, status === 401 ? 'unauthenticated' : status === 403 ? 'permission_denied' : status === 404 ? 'not_found' : 'unavailable', message);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { providerLabel: 'Gitea' });
    if (method === 'GetSession') return state.signedIn ? respond(route, GetSessionResponseSchema, { user }) : error(401, 'Sign in required.');
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return error(401, 'Your session expired.');
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { capabilities: [] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return state.metadataStatus === 200 ? respond(route, GetRepositoryResponseSchema, { repository: { ...repository, empty: state.empty } }) : error(state.metadataStatus, 'Repository not found or inaccessible.');
    if (method === 'GetContents') return respond(route, GetContentsResponseSchema, { kind: SourceEntryType.DIRECTORY, commitId: base, entries: [] });
    if (method === 'ListPullRequests') {
      const input = request(route, ListPullRequestsRequestSchema);
      expect(input.repository).toMatchObject({ owner: 'alex', name: 'design-system' });
      state.pages.push(input.page?.page || 0); state.states.push(input.state);
      if (state.listStatus !== 200) return error(state.listStatus, 'Pull requests not found or inaccessible.');
      const listed = { ...pull, head: create(PullRequestRefSchema, { ...pull.head!, retainedSnapshot: true }) };
      return respond(route, ListPullRequestsResponseSchema, state.empty ? {} : input.state === IssueState.CLOSED ? { pullRequests: [closed] } : input.state === IssueState.ALL ? { pullRequests: [listed, closed, snapshot] } : input.page?.page === 2 ? { pullRequests: [listed, snapshot] } : { pullRequests: [listed], page: { nextPage: 2 } });
    }
    if (method === 'GetPullRequest') {
      const input = request(route, GetPullRequestRequestSchema); state.numbers.push(input.number);
      if (state.detailWait) await state.detailWait;
      if (state.detailStatus !== 200) return error(state.detailStatus, 'Pull request not found or inaccessible.');
      const result = [pull, closed, snapshot].find((item) => item.number === input.number);
      return result ? respond(route, GetPullRequestResponseSchema, { pullRequest: result }) : error(404, 'Pull request not found or inaccessible.');
    }
    if (method === 'ListPullRequestReviews') {
      const input = request(route, ListPullRequestReviewsRequestSchema); state.reviewPages.push(input.page?.page || 0);
      if (state.reviewWait) await state.reviewWait;
      if (state.reviewStatus !== 200) return error(state.reviewStatus, 'Reviews not found or inaccessible.');
      // Native pending filtering can leave an empty page with a continuation.
      return respond(route, ListPullRequestReviewsResponseSchema, input.page?.page === 3 ? { reviews: [review, pending] } : input.page?.page === 2 ? { reviews: [review], page: { nextPage: 3 } } : { reviews: [], page: { nextPage: 2 } });
    }
    return error(404, 'Unsupported fixture operation.');
  });
  return state;
}

async function visibleReview(page: Page) {
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more reviews' }).click();
  await expect(page.getByLabel(`Review ${review.id} body, plain text`)).toBeVisible();
}

test('pull navigation paginates and filters native states with canonical detail URLs, reload and history', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/');
  expect(state.methods).not.toContain('ListPullRequests');
  await page.goto('/repositories/alex/design-system?view=pulls');
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveText('Pull requests');
  await expect(page.locator('.pull-list')).toContainText('Retained PR snapshot');
  await page.getByRole('button', { name: 'Load more pull requests' }).click();
  await expect(page.locator('.pull-list>li')).toHaveCount(2);
  expect([...new Set(state.pages)]).toEqual([1, 2]);
  await page.getByLabel('Pull request state').selectOption('closed');
  await expect(page.getByRole('link', { name: closed.title })).toBeVisible();
  await expect(page.locator('.pull-list')).toContainText('Merged');
  await expect(page.getByRole('link', { name: pull.title })).toHaveCount(0);
  await page.getByLabel('Pull request state').selectOption('all');
  await page.getByRole('link', { name: pull.title }).click();
  await expect(page).toHaveURL(/view=pulls&state=all&pull=12$/);
  await expect(page.getByRole('heading', { name: `${pull.title} #12` })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  await page.getByRole('link', { name: 'All pull requests', exact: true }).click();
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  expect(state.states).toContain(IssueState.CLOSED);
  expect(state.states).toContain(IssueState.ALL);
  expect(state.methods).not.toContain('ListIssues');
  expect(state.methods).not.toContain('ListBranches');
});

test('detail preserves exact refs and IDs; review pagination retains empty pages and shows only native flags and plain text', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await expect(page.getByLabel('Pull request body, plain text')).toContainText('<img src=x onerror="window.executed=true">');
  await expect(page.getByRole('region', { name: 'Base metadata' })).toContainText(repository.id);
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('9007199254740995');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText(head);
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('feature/keyboard');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Provider observation');
  await expect(page.getByRole('heading', { name: 'No visible reviews in the loaded pages.' })).toBeVisible();
  await visibleReview(page);
  await page.getByRole('button', { name: 'Load more reviews' }).click();
  await expect(page.locator('.pull-review-list>li')).toHaveCount(2);
  expect([...new Set(state.reviewPages)]).toEqual([1, 2, 3]);
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await expect(page.getByText('Pending', { exact: true })).toBeVisible();
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('Marked staleYes');
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('DismissedYes');
  await expect(page.locator('.pull-review-list>li').first().locator('dl')).toContainText('OfficialYes');
  await expect(page.getByRole('heading', { name: 'Deleted or unavailable author' })).toBeVisible();
  await expect(page.locator('.issue-body script,.issue-body img,.issue-body a')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  await expect(page.getByRole('button', { name: /^(merge|approve|request changes)$/i })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|9007199254740995/);
});

test('retained or deleted source metadata and merged records never imply a live source or current approval', async ({ page }) => {
  await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=14');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Retained PR snapshot');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('refs/pull/14/head');
  await expect(page.getByRole('region', { name: 'Head metadata' })).toContainText('Repository IDUnavailable');
  await expect(page.getByText('Deleted or unavailable author opened this pull request', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open original', exact: true })).toHaveCount(0);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=13');
  await expect(page.locator('.pull-merge-record')).toContainText(merged);
  await expect(page.locator('.pull-detail .pull-state')).toHaveText('Merged');
  await expect(page.getByText('protected integration remains unavailable.', { exact: false })).toBeVisible();
});

test('review and detail denials remove cached private content throughout retry and parent access rechecks', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await visibleReview(page);
  state.reviewStatus = 403;
  await page.getByRole('button', { name: 'Refresh reviews' }).click();
  await expect(page.getByRole('alert')).toHaveText('Reviews not found or inaccessible.');
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  let release!: () => void;
  state.reviewWait = new Promise<void>((resolve) => { release = resolve; });
  state.reviewStatus = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  release(); state.reviewWait = undefined;
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel(`Review ${review.id} body, plain text`)).toBeVisible();
  state.detailStatus = 404;
  await page.getByRole('button', { name: 'Refresh pull request', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull request not found or inaccessible.');
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Reviews', exact: true })).toHaveCount(0);
  state.metadataStatus = 404;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('alert')).toHaveText('Repository not found or inaccessible.');
  await expect(page.getByRole('navigation', { name: 'Repository', exact: true })).toHaveCount(0);
});

test('expired sessions and logout discard pull and review data, including navigation after a new login', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await visibleReview(page);
  state.signedIn = false;
  await page.getByRole('button', { name: 'Refresh reviews' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  state.detailStatus = 404;
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token').fill('second-session-token');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull request not found or inaccessible.');
  await expect(page.getByText('PRIVATE REVIEW', { exact: false })).toHaveCount(0);
  state.detailStatus = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect(page.getByText('PRIVATE PULL', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE|second-session-token/);
});

test('list failures hide earlier pages and empty repositories still support pull browsing', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/repositories/alex/design-system?view=pulls');
  await expect(page.getByRole('link', { name: pull.title })).toBeVisible();
  state.listStatus = 403;
  await page.getByRole('button', { name: 'Load more pull requests' }).click();
  await expect(page.getByRole('alert')).toHaveText('Pull requests not found or inaccessible.');
  await expect(page.getByRole('link', { name: pull.title })).toHaveCount(0);
  state.listStatus = 200; state.empty = true;
  await page.getByRole('button', { name: 'Refresh repository access' }).click();
  await expect(page.getByRole('heading', { name: 'No open pull requests.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No commits yet.' })).toHaveCount(0);
  expect(state.methods).not.toContain('ListBranches');
});

test('invalid pull numbers are rejected before RPC and changing tabs clears the pull search', async ({ page }) => {
  const state = await backend(page);
  for (const number of ['0', '-1', '01', '1.5', '1e2', '2147483648', 'not-a-number']) {
    await page.goto('/repositories/alex/design-system?view=pulls&pull=' + number);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
  expect(state.methods).not.toContain('GetPullRequest');
  await page.goto('/repositories/alex/design-system?view=pulls&pull=12');
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  await page.getByRole('navigation', { name: 'Repository', exact: true }).getByRole('link', { name: 'Source', exact: true }).click();
  await expect(page).not.toHaveURL(/pull=/);
  await expect(page.getByRole('heading', { name: 'Source', exact: true })).toBeVisible();
});

test('pull browsing is keyboard accessible and fits charcoal and light mobile layouts', async ({ page }) => {
  await backend(page);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/repositories/alex/design-system?view=pulls');
  await page.getByRole('link', { name: pull.title }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Pull request body, plain text')).toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await page.getByRole('button', { name: 'Load more reviews' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(`Review ${review.id} body, plain text`)).toBeVisible();
  await page.screenshot({ path: 'test-results/pull-request-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/pull-request-mobile-dark.png', fullPage: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/pull-request-mobile-light.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/pull-request-light.png', fullPage: true });
  await expect(page.locator('.repository-tabs [aria-current="page"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
