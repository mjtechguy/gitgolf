import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import {
  CreateIssueRequestSchema, CreateIssueResponseSchema, CreateIssueCommentRequestSchema, CreateIssueCommentResponseSchema,
  GetAuthenticationOptionsResponseSchema, GetIssueMutationRequestSchema, GetIssueMutationResponseSchema, GetIssueResponseSchema,
  GetRepositoryResponseSchema, GetSessionResponseSchema, IssueCommentSchema, IssueMutationKind, IssueMutationSchema, IssueMutationState,
  IssueSchema, IssueState, ListCapabilitiesResponseSchema, ListIssueCommentsRequestSchema, ListIssueCommentsResponseSchema,
  ListIssuesResponseSchema, ListRepositoriesResponseSchema, LoginWithGiteaTokenResponseSchema, LogoutResponseSchema, RepositorySchema, UserSchema,
} from '../src/gen/golf/v1/golf_pb';
import type { CreateIssueRequest, CreateIssueCommentRequest, IssueMutation } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

const user = create(UserSchema, { id: '9007199254740993', login: 'alex' });
const repository = create(RepositorySchema, { id: '9007199254740995', name: 'project', fullName: 'alex/project', private: true, empty: true });
const repoKey = { owner: 'alex', name: 'project' };
const issue = create(IssueSchema, { id: '9007199254740997', number: 12, title: 'Private discussion', body: 'PRIVATE_BODY <script>alert(1)</script>', state: IssueState.OPEN, user, createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z' });
const comment = create(IssueCommentSchema, { id: '9007199254740998', user, body: '<img src=x onerror="window.executed=true">\n[unsafe](javascript:alert(1))', createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', htmlUrl: 'javascript:alert(1)' });
const listURL = '/repositories/alex/project?view=issues';
const detailURL = `${listURL}&issue=12`;
type Failure = 'permission_denied' | 'not_found' | 'unauthenticated' | 'unavailable' | 'already_exists';

async function backend(page: Page) {
  const state = {
    user, signedIn: true, repoId: repository.id, issueId: issue.id, issue: { ...issue }, comments: [comment],
    emptyFirst: false, unknown: false, drop: false, rejected: false, missingObject: false, mismatch: false,
    creates: [] as CreateIssueRequest[], posts: [] as CreateIssueCommentRequest[], inspections: [] as string[], pages: [] as number[],
    records: new Map<string, IssueMutation>(), errors: {} as Record<string, Failure>, barrier: undefined as Promise<void> | undefined,
  };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'LoginWithGiteaToken') { state.signedIn = true; return respond(route, LoginWithGiteaTokenResponseSchema, { user: state.user }); }
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (state.errors[method]) { if (state.errors[method] === 'unauthenticated') state.signedIn = false; return reject(route, state.errors[method], method === 'CreateIssueComment' ? 'Posting requires write:issue.' : 'Discussion request unavailable or denied.'); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Sign in required.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: { ...repository, id: state.repoId } });
    if (method === 'ListIssues') return respond(route, ListIssuesResponseSchema, { issues: [state.issue] });
    if (method === 'GetIssue') return respond(route, GetIssueResponseSchema, { issue: { ...state.issue, id: state.issueId } });
    if (method === 'ListIssueComments') {
      const input = request(route, ListIssueCommentsRequestSchema);
      expect(input.repository).toMatchObject(repoKey); expect(input.repositoryId).toBe(state.repoId);
      expect(input.issueId).toBe(state.issueId); expect(input.number).toBe(12); expect(input.page?.limit).toBe(20);
      const number = input.page?.page || 1; state.pages.push(number);
      return respond(route, ListIssueCommentsResponseSchema, state.emptyFirst && number === 1 ? { page: { nextPage: 2 } } : { comments: state.comments });
    }
    if (method === 'CreateIssue' || method === 'CreateIssueComment') {
      const isComment = method === 'CreateIssueComment';
      const input = isComment ? request(route, CreateIssueCommentRequestSchema) : request(route, CreateIssueRequestSchema);
      if (isComment) state.posts.push(input as CreateIssueCommentRequest); else state.creates.push(input as CreateIssueRequest);
      const mutation = create(IssueMutationSchema, {
        id: '9007199254740999', idempotencyKey: input.idempotencyKey, repository: repoKey, repositoryId: input.repositoryId,
        kind: isComment ? IssueMutationKind.CREATE_COMMENT : IssueMutationKind.CREATE_ISSUE,
        state: state.rejected ? IssueMutationState.REJECTED : state.unknown ? IssueMutationState.OUTCOME_UNKNOWN : IssueMutationState.SUCCEEDED,
        issueId: state.issueId, number: 12, commentId: isComment ? comment.id : '', createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z',
        failureCode: state.rejected ? 'target_changed' : '',
      });
      state.records.set(input.idempotencyKey, mutation);
      if (!isComment) state.issue = { ...issue, title: (input as CreateIssueRequest).title, body: input.body };
      else state.comments = [{ ...comment, body: input.body }];
      if (state.barrier) await state.barrier;
      if (state.drop) return route.abort('failed');
      const visible = mutation.state === IssueMutationState.SUCCEEDED && !state.missingObject;
      const returned = state.mismatch ? { ...mutation, repositoryId: '9999' } : mutation;
      return isComment ? respond(route, CreateIssueCommentResponseSchema, { mutation: returned, comment: visible ? state.comments[0] : undefined }) : respond(route, CreateIssueResponseSchema, { mutation: returned, issue: visible ? state.issue : undefined });
    }
    if (method === 'GetIssueMutation') {
      const key = request(route, GetIssueMutationRequestSchema).idempotencyKey; state.inspections.push(key);
      const mutation = state.records.get(key);
      if (!mutation) return reject(route, 'not_found', 'No matching outcome record is available.');
      const visible = mutation.state === IssueMutationState.SUCCEEDED && !state.missingObject;
      return respond(route, GetIssueMutationResponseSchema, { mutation: state.mismatch ? { ...mutation, issueId: '9999' } : mutation, issue: visible && mutation.kind === IssueMutationKind.CREATE_ISSUE ? state.issue : undefined, comment: visible && mutation.kind === IssueMutationKind.CREATE_COMMENT ? state.comments[0] : undefined });
    }
    return reject(route, 'not_found', 'Unknown fixture RPC.');
  });
  return state;
}
const stored = (page: Page) => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('golf.issue-intent.')));
async function newIssue(page: Page) {
  await page.goto(listURL);
  await page.getByRole('button', { name: 'New issue', exact: true }).click();
  return page.getByRole('dialog', { name: 'New issue', exact: true });
}

test('creates a plain-text issue once with immutable target IDs and follows its typed detail link', async ({ page }) => {
  const state = await backend(page);
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('  New private discussion  ');
  const body = '  PRIVATE_DRAFT\n<img src=x onerror="window.executed=true">\t';
  await dialog.getByLabel('Description, plain text').fill(body);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await dialog.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.creates.length).toBe(1);
  expect(state.creates[0]).toMatchObject({ repository: repoKey, repositoryId: repository.id, title: 'New private discussion', body });
  expect(state.creates[0]!.idempotencyKey).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
  await expect(dialog.getByLabel('Issue title')).toBeDisabled();
  release();
  await expect(page).toHaveURL(/issues\/12$/);
  await expect(page.getByLabel('Issue body, rendered Markdown')).toContainText('PRIVATE_DRAFT');
  await expect(page.locator('.issue-body img')).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
});

test('unknown creation closes and reloads with metadata only, and resumes status without reposting', async ({ page }) => {
  const state = await backend(page); state.drop = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('PRIVATE_TITLE');
  await dialog.getByLabel('Description, plain text').fill('PRIVATE_DRAFT');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const key = state.creates[0]!.idempotencyKey;
  const rows = await stored(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]![0]).toContain(`:${user.id}:${repository.id}:new`);
  expect(JSON.parse(rows[0]![1])).toEqual({ key, kind: 'issue', repositoryId: repository.id, issueId: '', number: 0 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Resume issue request' })).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Resume issue request' }).click();
  await expect(page.getByLabel('Issue title')).toHaveValue('');
  await expect(page.getByLabel('Description, plain text')).toHaveValue('');
  expect(state.creates).toHaveLength(1); expect(state.inspections).toHaveLength(0);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page).toHaveURL(/issues\/12$/);
  expect(state.creates).toHaveLength(1); expect(state.inspections).toEqual([key]);
  expect(await stored(page)).toEqual([]);
});

test('unknown and historic success without current access do not allow a new creation request', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('Kept intent');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByText('This request may still be running, or its outcome is unknown.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  expect(state.creates).toHaveLength(1);
  state.records.get(state.creates[0]!.idempotencyKey)!.state = IssueMutationState.SUCCEEDED;
  state.missingObject = true;
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  await expect(dialog.getByText(/recorded as successful, but Golf cannot confirm current access/)).toBeVisible();
  await expect(dialog.getByLabel('Issue title')).toBeDisabled();
  expect(await stored(page)).toHaveLength(1);
});

test('rejected mutation requires an explicit new intent with a new UUID and editable form', async ({ page }) => {
  const state = await backend(page); state.rejected = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('Original title');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByText(/target changed before this write was sent/)).toBeVisible();
  const first = state.creates[0]!.idempotencyKey;
  await dialog.getByRole('button', { name: 'Start a new request' }).click();
  await expect(dialog.getByLabel('Issue title')).toBeEnabled();
  await expect(dialog.getByLabel('Issue title')).toBeFocused();
  await dialog.getByLabel('Issue title').fill('Explicit second request');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]!.idempotencyKey).not.toBe(first);
});

test('preflight validates UTF-8 byte bounds and controls before reserving a key or sending', async ({ page }) => {
  const state = await backend(page);
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('é'.repeat(128));
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('1–255 UTF-8 bytes');
  await dialog.getByLabel('Issue title').fill('Valid title');
  await dialog.getByLabel('Description, plain text').fill('é'.repeat(3001));
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('6,000 UTF-8 bytes');
  for (const text of ['before\u0000after', '\ud800']) {
    await dialog.getByLabel('Description, plain text').evaluate((input: HTMLTextAreaElement, text) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('No request was sent.');
  }
  expect(state.creates).toEqual([]); expect(await stored(page)).toEqual([]);
  await expect(dialog.getByLabel('Issue title')).toBeEnabled();
});

test('comments advance across an empty native page, render literal text and preserve typed navigation', async ({ page }) => {
  const state = await backend(page); state.emptyFirst = true;
  await page.goto(detailURL);
  await expect(page.getByRole('heading', { name: 'No comments in the loaded pages.' })).toBeVisible();
  expect(state.pages.length).toBeGreaterThan(0); expect(state.pages.every((number) => number === 1)).toBe(true);
  await page.getByRole('button', { name: 'Load more comments' }).click();
  await expect(page.getByLabel(`Comment ${comment.id}, rendered Markdown`)).toContainText('image preview unavailable');
  expect(state.pages.at(-1)).toBe(2); expect(state.pages.filter((number) => number === 2)).toHaveLength(1);
  await expect(page.locator('.issue-comment img, .issue-comment a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'All open issues' }).click();
  await expect(page).toHaveURL(/issues$/);
  await page.goBack();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toBeVisible();
});

test('posts comment exactly once, validates native result IDs and clears its persisted intent', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  const body = '  New private comment\n<img src=x onerror=alert(1)>\t';
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill(body);
  let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.locator('.issue-composer form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ repository: repoKey, repositoryId: repository.id, issueId: issue.id, number: 12, body });
  release();
  await expect(page.getByText('Comment posted.', { exact: true })).toBeVisible();
  expect(await stored(page)).toEqual([]);
  await page.getByRole('button', { name: 'Write another comment' }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeFocused();
});

test('comment lost response resumes lookup only after reload without storing body or title', async ({ page }) => {
  const state = await backend(page); state.drop = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('PRIVATE_COMMENT');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const key = state.posts[0]!.idempotencyKey;
  expect(JSON.parse((await stored(page))[0]![1])).toEqual({ key, kind: 'comment', repositoryId: repository.id, issueId: issue.id, number: 12 });
  await page.reload();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(1); expect(state.inspections).toEqual([]);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByText('Comment posted.', { exact: true })).toBeVisible();
  expect(state.inspections).toEqual([key]); expect(state.posts).toHaveLength(1);
});

test('mismatched write/status records never become success or unlock a repost', async ({ page }) => {
  const state = await backend(page); state.mismatch = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Private mismatch draft');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match this request');
  await expect(page.getByText('Comment posted.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByRole('alert')).toContainText('does not match this request');
  expect(state.posts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Start a new request' })).toHaveCount(0);
});

test('comment scope denial clears the draft and read denial removes prior discussion and controls', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('PRIVATE_DRAFT');
  state.errors.CreateIssueComment = 'permission_denied';
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('alert')).toContainText('write:issue');
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  state.errors.ListIssueComments = 'permission_denied';
  await page.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(page.getByLabel('Issue body, rendered Markdown')).toHaveCount(0);
  await expect(page.locator('.issue-comment')).toHaveCount(0);
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveCount(0);
});

test('expired session, sign-out and account switch clear pending private convenience data', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  const dialog = await newIssue(page);
  await dialog.getByLabel('Issue title').fill('PRIVATE_TITLE');
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Check request status' })).toBeEnabled();
  state.errors.GetIssueMutation = 'unauthenticated';
  await dialog.getByRole('button', { name: 'Check request status' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible();
  await expect.poll(() => stored(page)).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('golf.issue-intent.other-origin:other-user:999:new', '{"key":"stale"}'));
  delete state.errors.GetIssueMutation;
  state.user = create(UserSchema, { id: '22', login: 'other' });
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token').fill('fixture');
  await page.getByRole('button', { name: 'Continue to workspace' }).click();
  await expect(page.getByLabel('Your account', { exact: true })).toBeVisible();
  await expect.poll(() => stored(page)).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('golf.issue-intent.synthetic', '{}'));
  await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => stored(page)).toEqual([]);
});

test('target IDs namespace resumed requests and prevent reuse for a replaced repository or issue', async ({ page }) => {
  const state = await backend(page); state.unknown = true;
  await page.goto(detailURL);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Original target draft');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('button', { name: 'Check request status' })).toBeEnabled();
  state.issueId = '777';
  await page.reload();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check request status' })).toHaveCount(0);
  expect(state.inspections).toEqual([]); expect(state.posts).toHaveLength(1);
  state.repoId = '888';
  await page.reload();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
});

test('issue dialog and discussion remain keyboard usable in charcoal and light mobile layouts', async ({ page }) => {
  await backend(page);
  await page.addInitScript(() => localStorage.setItem('golf.theme', 'dark'));
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const dialog = await newIssue(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dialog.getByLabel('Issue title').focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Description, plain text')).toBeFocused();
  await page.screenshot({ path: 'test-results/issues-dialog-dark.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'New issue', exact: true })).toBeFocused();
  await page.goto(detailURL);
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/issues-mobile-light.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('discussion opens an editor only on request and closing discards the draft', async ({ page }) => {
  const state = await backend(page);
  await page.goto(detailURL);
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await page.getByLabel('Comment, plain text', { exact: true }).fill('Discard this private draft');
  await page.getByRole('button', { name: 'Close comment editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add a comment', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
  await expect(page.getByLabel('Comment, plain text', { exact: true })).toHaveValue('');
  expect(state.posts).toHaveLength(0);
});
