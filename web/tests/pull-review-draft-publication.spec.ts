import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clone, create } from '@bufbuild/protobuf';
import { createHash } from 'node:crypto';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, GetRepositoryResponseSchema, GetPullRequestResponseSchema, GetPullRequestDiffResponseSchema, GetPullRequestReviewDraftResponseSchema, GetPullRequestInlineReviewMutationResponseSchema, PublishPullRequestReviewDraftRequestSchema, PublishPullRequestReviewDraftResponseSchema, PullInlineReviewMutationSchema, PullInlineReviewPhase, PullRequestSchema, PullRequestReviewState, PullReviewDraftSchema, IssueState, LogoutResponseSchema } from '../src/gen/golf/v1/golf_pb';
import type { PublishPullRequestReviewDraftRequest, PullInlineReviewMutation } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { portableRuntimeFixture } from './runtime-fixture';

const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40), revision = 'd'.repeat(64);
const user = { id: '9007199254740993', login: 'reader' }, repo = { id: '9007199254740994', name: 'sample', fullName: 'owner/sample', private: true, defaultBranch: 'main' };
const target = { repository: { owner: 'owner', name: 'sample' }, repositoryId: repo.id, pullRequestId: '9007199254740995', number: 3 };
const diff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n';
const digest = createHash('sha256').update(diff).digest('hex');
const draftId = '11111111-1111-4111-8111-111111111111', comparisonId = '22222222-2222-4222-8222-222222222222';
const storedKey = `golf.private-review-publication.v1:${user.id}:${repo.id}:${target.pullRequestId}`;
const original = create(PullRequestSchema, { id: target.pullRequestId, number: 3, title: 'Saved publication fixture', revision, mergeBaseCommitId: merge, state: IssueState.OPEN, user: { id: '9', login: 'author' }, base: { repositoryId: repo.id, commitId: base, ref: 'main' }, head: { repositoryId: repo.id, commitId: head, ref: 'feature' } });
const saved = create(PullReviewDraftSchema, { id: draftId, target, userId: user.id, version: '3', comparison: { id: comparisonId, capture: { selection: { ...target, baseCommitId: base, headCommitId: head }, expectedPullRevision: revision, mergeBaseCommitId: merge, diffSha256: digest }, parserVersion: 'golf-review-diff-v1', rawDiff: diff, byteSize: Buffer.byteLength(diff) }, summary: 'PRIVATE saved summary', entries: [{ id: '33333333-3333-4333-8333-333333333333', coordinate: { fileIndex: 0, hunkIndex: 0, side: 2, line: 1, path: 'src/app.ts' }, body: 'PRIVATE saved comment' }], createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:01:00Z' });
async function backend(page: Page) {
  const s = { pull: clone(PullRequestSchema, original), draft: clone(PullReviewDraftSchema, saved), text: diff, signedIn: true, deny: false, lost: false, missing: false, wrong: '', phase: PullInlineReviewPhase.SUCCEEDED, posts: [] as PublishPullRequestReviewDraftRequest[], reads: 0, held: undefined as Promise<void> | undefined, mutation: undefined as PullInlineReviewMutation | undefined };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'GetSession') return s.signedIn ? respond(route, GetSessionResponseSchema, { user }) : reject(route, 'unauthenticated', 'Signed out.');
    if (method === 'Logout') { s.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository: repo });
    if (method === 'GetPullRequest') return respond(route, GetPullRequestResponseSchema, { pullRequest: s.pull });
    if (method === 'GetPullRequestDiff') return respond(route, GetPullRequestDiffResponseSchema, { repositoryId: repo.id, pullRequestId: target.pullRequestId, baseCommitId: s.pull.base!.commitId, headCommitId: s.pull.head!.commitId, mergeBaseCommitId: s.pull.mergeBaseCommitId, rawDiff: s.text, byteSize: Buffer.byteLength(s.text) });
    if (method === 'GetPullRequestReviewDraft') return respond(route, GetPullRequestReviewDraftResponseSchema, { draft: s.draft, currentVersion: s.draft.version, targetGeneration: '7' });
    if (method === 'PublishPullRequestReviewDraft') {
      const input = request(route, PublishPullRequestReviewDraftRequestSchema); s.posts.push(input);
      s.mutation = create(PullInlineReviewMutationSchema, { operationId: input.operationId, target: input.target, draftId: input.draftId, acceptedVersion: input.expectedVersion, acceptedTargetGeneration: input.expectedTargetGeneration, comparisonId: input.comparisonId, decision: input.decision, phase: s.phase, observedReviewId: s.phase === PullInlineReviewPhase.SUCCEEDED ? '9007199254740996' : '', verifiedCommentIds: s.phase === PullInlineReviewPhase.SUCCEEDED ? ['9007199254740997'] : [], baseTipCommitId: base, mergeBaseCommitId: merge, headCommitId: head, diffSha256: digest, createdAt: '2026-10-03T12:02:00Z', updatedAt: '2026-10-03T12:02:00Z' });
      if (s.held) await s.held;
      if (s.deny) return reject(route, 'permission_denied', 'Publication authority revoked.');
      if (s.lost) return reject(route, 'unavailable', 'Publication acknowledgement lost.');
      const shown = clone(PullInlineReviewMutationSchema, s.mutation);
      if (s.wrong === 'version') shown.acceptedVersion = '03';
      if (s.wrong === 'generation') shown.acceptedTargetGeneration = '8';
      if (s.wrong === 'target') shown.target!.pullRequestId = '99';
      if (s.wrong === 'operation') shown.operationId = comparisonId;
      if (s.wrong === 'comparison') shown.comparisonId = draftId;
      if (s.wrong === 'head') shown.headCommitId = 'e'.repeat(40);
      if (s.wrong === 'digest') shown.diffSha256 = 'f'.repeat(64);
      if (s.wrong === 'children') shown.verifiedCommentIds = [];
      if (s.wrong === 'unsafe-id') shown.verifiedCommentIds = ['9223372036854775808'];
      return respond(route, PublishPullRequestReviewDraftResponseSchema, { mutation: shown });
    }
    if (method === 'GetPullRequestInlineReviewMutation') {
      s.reads++; if (s.held) await s.held;
      if (s.deny) return reject(route, 'permission_denied', 'Publication authority revoked.');
      if (s.missing || !s.mutation) return reject(route, 'not_found', 'Publication status is absent.');
      return respond(route, GetPullRequestInlineReviewMutationResponseSchema, { mutation: s.mutation });
    }
    return reject(route, 'unimplemented', 'Fixture operation unavailable.');
  }); return s;
}
const publication = (page: Page) => page.getByRole('region', { name: 'Saved review publication', exact: true });
const workspace = (page: Page) => page.getByRole('region', { name: 'Private review draft', exact: true });
async function open(page: Page) { await page.goto('/owner/sample/pull/3/files'); await page.getByRole('button', { name: 'Private draft', exact: true }).click(); await expect(workspace(page).getByText('Version 3 · Saved privately in Golf', { exact: true })).toBeVisible(); }
async function prepare(page: Page) { await workspace(page).getByRole('button', { name: 'Publish saved review', exact: true }).click(); await expect(publication(page).getByRole('group', { name: 'Saved review decision' })).toBeVisible(); }
async function publish(page: Page) { await publication(page).getByRole('button', { name: 'Publish saved comment', exact: true }).click(); }

test('explicit saved preview and once-only request never include working content', async ({ page }) => {
  const s = await backend(page); await open(page); expect(s.posts).toHaveLength(0); await expect(publication(page)).toHaveCount(0);
  await workspace(page).getByRole('button', { name: 'Edit private draft summary', exact: true }).click(); await workspace(page).getByRole('textbox', { name: 'Private draft summary, Markdown', exact: true }).fill('PRIVATE unsent notes'); await workspace(page).getByRole('button', { name: 'Keep summary', exact: true }).click();
  await prepare(page); await expect(publication(page)).toContainText('unsaved working notes remain separate'); await publication(page).getByText('Original saved review and comparison', { exact: true }).click(); await expect(publication(page)).toContainText('PRIVATE saved summary'); await expect(publication(page)).not.toContainText('PRIVATE unsent notes');
  await publish(page); await expect(publication(page)).toContainText('Published and independently verified'); expect(s.posts).toHaveLength(1); expect(s.posts[0]).toMatchObject({ target, draftId, expectedVersion: '3', expectedTargetGeneration: '7', comparisonId, decision: PullRequestReviewState.COMMENT });
  expect(Object.keys(s.posts[0]!).sort()).toEqual(['$typeName','comparisonId','decision','draftId','expectedTargetGeneration','expectedVersion','operationId','target']); await expect(workspace(page)).toContainText('PRIVATE unsent notes');
  const storage = await page.evaluate(key => sessionStorage.getItem(key), storedKey); expect(storage).toContain(s.posts[0]!.operationId); for (const privateValue of ['PRIVATE', 'src/app.ts', head, merge, digest]) expect(storage).not.toContain(privateValue);
  await publication(page).getByRole('button', { name: 'Check publication status' }).click(); await expect.poll(() => s.reads).toBeGreaterThan(0); expect(s.posts).toHaveLength(1); await expect(publication(page).getByRole('button', { name: /Prepare another/ })).toHaveCount(0);
});

test('lost acknowledgement reload reads original operation without repost or replacement', async ({ page }) => {
  const s = await backend(page); s.lost = true; await open(page); await prepare(page); await publish(page); await expect(publication(page).getByRole('alert')).toContainText('acknowledgement lost'); await page.reload(); await page.getByRole('button', { name: 'Private draft', exact: true }).click(); await expect(publication(page)).toContainText('Published and independently verified'); expect(s.posts).toHaveLength(1); expect(s.reads).toBeGreaterThan(0); await expect(publication(page).getByRole('button', { name: 'Publish saved comment', exact: true })).toHaveCount(0);
});

for (const phase of [PullInlineReviewPhase.RESERVED, PullInlineReviewPhase.DISPATCH_UNKNOWN]) test(`phase ${PullInlineReviewPhase[phase]} allows inspection only across reload`, async ({ page }) => {
  const s = await backend(page); s.phase = phase; await open(page); await prepare(page); await publish(page); await expect(publication(page)).toContainText(phase === PullInlineReviewPhase.RESERVED ? 'Reserved.' : 'outcome is unknown'); await page.reload(); await page.getByRole('button', { name: 'Private draft', exact: true }).click(); await expect(publication(page).getByRole('button', { name: 'Check publication status' })).toBeVisible(); await publication(page).getByRole('button', { name: 'Check publication status' }).click(); expect(s.posts).toHaveLength(1); await expect(publication(page).getByRole('button', { name: /Prepare another/ })).toHaveCount(0);
});

test('only exact rejected receipt permits a fresh explicit prepare action', async ({ page }) => {
  const s = await backend(page); s.phase = PullInlineReviewPhase.REJECTED; await open(page); await prepare(page); await publish(page); await expect(publication(page)).toContainText('Rejected before native dispatch'); const key = s.posts[0]!.operationId; await publication(page).getByRole('button', { name: 'Prepare another saved review attempt' }).click(); expect(s.posts).toHaveLength(1); await prepare(page); s.phase = PullInlineReviewPhase.SUCCEEDED; await publish(page); await expect(publication(page)).toContainText('Published and independently verified'); expect(s.posts).toHaveLength(2); expect(s.posts[1]!.operationId).not.toBe(key);
});

for (const wrong of ['version','generation','target','operation','comparison','head','digest','children','unsafe-id']) test(`mismatched ${wrong} receipt remains unresolved without a new key`, async ({ page }) => {
  const s = await backend(page); s.wrong = wrong; await open(page); await prepare(page); await publish(page); await expect(publication(page).getByRole('alert')).toBeVisible(); await expect(publication(page)).not.toContainText('Published and independently verified'); expect(s.posts).toHaveLength(1); await expect(publication(page).getByRole('button', { name: /Prepare another/ })).toHaveCount(0);
});

test('status404 clears private content but preserves operation identity and never proves rejection', async ({ page }) => {
  const s = await backend(page); s.lost = true; await open(page); await prepare(page); await publish(page); await expect(publication(page).getByRole('alert')).toContainText('acknowledgement lost'); s.missing = true; await publication(page).getByRole('button', { name: 'Check publication status' }).click(); await expect(workspace(page)).toContainText('Private text and source were cleared'); await expect(workspace(page)).not.toContainText('PRIVATE saved'); expect(await page.evaluate(key => sessionStorage.getItem(key), storedKey)).toContain(s.posts[0]!.operationId); expect(s.posts).toHaveLength(1); await expect(publication(page).getByRole('button', { name: /Prepare another/ })).toHaveCount(0);
});

test('authority denial clears frozen saved preview and receipt metadata', async ({ page }) => {
  const s = await backend(page); await open(page); await prepare(page); await publish(page); await expect(publication(page)).toContainText('Published and independently verified'); s.deny = true; await publication(page).getByRole('button', { name: 'Check publication status' }).click(); await expect(workspace(page)).toContainText('Private text and source were cleared'); await expect(workspace(page)).not.toContainText('PRIVATE saved'); await expect(publication(page)).not.toContainText(head); await expect(publication(page)).not.toContainText('9007199254740997'); expect(s.posts).toHaveLength(1);
});

for (const condition of ['self','draft','closed','earlier']) test(`current ${condition} observation gates native decisions and dispatch`, async ({ page }) => {
  const s = await backend(page); if (condition === 'self') s.pull.user = { ...s.pull.user!, id: user.id }; if (condition === 'draft') s.pull.draft = true; if (condition === 'closed') s.pull.state = IssueState.CLOSED; if (condition === 'earlier') s.pull.head!.commitId = 'e'.repeat(40);
  await open(page); await prepare(page); await expect(publication(page).getByRole('radio', { name: 'Approve', exact: true })).toHaveCount(0); if (condition !== 'self') await expect(publication(page).getByRole('button', { name: 'Publish saved comment', exact: true })).toBeDisabled(); expect(s.posts).toHaveLength(0);
});

test('empty saved summary can approve but cannot send a comment', async ({ page }) => {
  const s = await backend(page); s.draft.summary = ''; await open(page); await prepare(page); await publish(page); await expect(publication(page).getByRole('alert')).toContainText('Only approval permits'); expect(s.posts).toHaveLength(0); await publication(page).getByRole('radio', { name: 'Approve', exact: true }).check(); await publication(page).getByRole('button', { name: 'Publish saved approval', exact: true }).click(); await expect(publication(page)).toContainText('Published and independently verified'); expect(s.posts[0]!.decision).toBe(PullRequestReviewState.APPROVED);
});

for (const theme of ['dark','light']) for (const width of [390,1280]) test(`publication ${theme} ${width}px uses compact reusable controls without overflow`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.addInitScript(value => localStorage.setItem('golf.theme', value), theme); const s = await backend(page); await open(page); await prepare(page); await expect(page.locator('html')).toHaveAttribute('data-theme', theme); await publication(page).getByText('Original saved review and comparison', { exact: true }).click(); await expect(publication(page).getByRole('button', { name: 'Publish saved comment', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); const panelBox=await publication(page).boundingBox(), workspaceBox=await workspace(page).boundingBox(); expect(Math.abs(panelBox!.x-workspaceBox!.x)).toBeLessThanOrEqual(1); expect(Math.abs(panelBox!.width-workspaceBox!.width)).toBeLessThanOrEqual(1); expect(s.posts).toHaveLength(0); await page.screenshot({ path: test.info().outputPath(`saved-publication-${theme}-${width}.png`), fullPage: true });
});


test('a new saved version cannot silently replace the open publication preview', async ({ page }) => {
  const s = await backend(page); await open(page); await prepare(page); s.draft.version = '4'; s.draft.summary = 'PRIVATE changed on another device'; await workspace(page).getByRole('button', { name: 'Reopen saved private draft', exact: true }).click(); await expect(workspace(page)).toContainText('Version 4'); await expect(publication(page)).toContainText('The saved version changed.'); await expect(publication(page).getByRole('button', { name: 'Publish saved comment', exact: true })).toBeDisabled(); await publication(page).getByText('Original saved review and comparison', { exact: true }).click(); await expect(publication(page)).toContainText('PRIVATE saved summary'); await expect(publication(page)).not.toContainText('changed on another device'); expect(s.posts).toHaveLength(0);
});

test('concurrent repeated submit events reserve only one browser operation', async ({ page }) => {
  const s = await backend(page); let release!: () => void; s.held = new Promise<void>(resolve => { release = resolve; }); await open(page); await prepare(page); await publication(page).locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await expect.poll(() => s.posts.length).toBe(1); release(); await expect(publication(page)).toContainText('Published and independently verified'); expect(s.posts).toHaveLength(1);
});

test('late native acknowledgement cannot restore private content after sign out', async ({ page }) => {
  const s = await backend(page); let release!: () => void; s.held = new Promise<void>(resolve => { release = resolve; }); await open(page); await prepare(page); await publish(page); await expect.poll(() => s.posts.length).toBe(1); await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Welcome to Golf' })).toBeVisible(); release(); await expect(page.getByText('PRIVATE saved summary', { exact: true })).toHaveCount(0); await expect(publication(page)).toHaveCount(0); expect(s.posts).toHaveLength(1); expect(await page.evaluate(key => sessionStorage.getItem(key), storedKey)).toContain(s.posts[0]!.operationId);
});

test('corrupt stored operation metadata blocks replacement rather than guessing absence', async ({ page }) => {
  const s = await backend(page); await page.addInitScript(({ key }) => sessionStorage.setItem(key, JSON.stringify({ operationId: 'invalid' })), { key: storedKey }); await open(page); await expect(publication(page).getByRole('alert')).toContainText('Stored publication identity is invalid'); await expect(publication(page).getByRole('button', { name: 'Publish saved comment' })).toHaveCount(0); expect(s.posts).toHaveLength(0);
});


test('changed current head cannot replace an unresolved historical operation after reload', async ({ page }) => {
  const s = await backend(page); s.phase = PullInlineReviewPhase.DISPATCH_UNKNOWN; await open(page); await prepare(page); await publish(page); await expect(publication(page)).toContainText('outcome is unknown'); const operation = s.posts[0]!.operationId; s.pull.head!.commitId = 'e'.repeat(40); s.pull.revision = 'f'.repeat(64); await page.reload(); await page.getByRole('button', { name: 'Private draft', exact: true }).click(); await expect(workspace(page)).toContainText('Earlier snapshot'); await expect(publication(page)).toContainText(operation); await expect(publication(page).getByRole('button', { name: 'Publish saved comment', exact: true })).toHaveCount(0); await publication(page).getByRole('button', { name: 'Check publication status' }).click(); expect(s.posts).toHaveLength(1); expect(await page.evaluate(key => sessionStorage.getItem(key), storedKey)).toContain(operation);
});


for (const condition of ['renamed', 'deleted']) test(`known ${condition} coordinates remain private without reserving a publication operation`, async ({ page }) => {
  const s = await backend(page); s.text = condition === 'renamed' ? 'diff --git a/src/old.ts b/src/app.ts\nrename from src/old.ts\nrename to src/app.ts\n--- a/src/old.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n' : 'diff --git a/src/app.ts b/src/app.ts\ndeleted file mode 100644\n--- a/src/app.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'; s.draft.comparison!.rawDiff = s.text; s.draft.comparison!.byteSize = Buffer.byteLength(s.text); s.draft.comparison!.capture!.diffSha256 = createHash('sha256').update(s.text).digest('hex'); s.draft.entries[0]!.coordinate!.side = condition === 'deleted' ? 1 : 2; await open(page); await prepare(page); await publish(page); await expect(publication(page).getByRole('alert')).toContainText('unsupported renamed or deleted file comments'); expect(s.posts).toHaveLength(0); expect(await page.evaluate(key => sessionStorage.getItem(key), storedKey)).toBeNull(); await expect(workspace(page)).toContainText('PRIVATE saved comment');
});
