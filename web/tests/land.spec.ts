import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetPullRequestDiscussionResponseSchema, GetPullRequestResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, IssueState,
  ListCapabilitiesResponseSchema, ListIssueCommentsResponseSchema, ListPullRequestReviewsResponseSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// Landing through agentic mode (docs/AGENTIC_MODE.md, AM-4 items 4 and 5): the Land button and latest land operation in the pull
// request's Landing panel, and Settings → Agentic mode → Recent landings, against mocked /native/land and /native/land/read.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const key = { owner: 'alex', name: 'demo' }, repositoryId = '41', main = 'a'.repeat(40), prHead = 'd'.repeat(40);
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true, cloneUrl: 'https://golf.example/alex/demo.git', updatedAt: at(600) };
const pull = { id: '901', number: 7, title: 'Document the cache', body: 'Docs only.', revision: 'e'.repeat(64), state: IssueState.OPEN,
  base: { repositoryId, ref: 'main', commitId: main }, head: { repositoryId, ref: 'docs/cache', commitId: prHead }, user: { id: '43', login: 'sam' }, createdAt: at(900), updatedAt: at(100) };
const settings = { enabled: true, lowRiskPaths: ['docs/**'], sensitivePaths: ['deploy/**'], landWithoutPerson: true, requiredChecks: [], revertOnFailure: true, version: 3, updatedBy: 'alex', updatedAt: at(60) };
const evaluation = (canLand: boolean) => ({ repositoryId, number: 7, headCommitId: prHead, baseCommitId: main, mergeBaseCommitId: main, enabled: true, origin: 'agent-task', changedPathCount: 1, canLand,
  evaluation: canLand ? { decision: 'land', risk: 'low', reasons: ['every changed path is low-risk, landing without a person is on and every required check passed (opened by an agent)'], matched: { low: ['docs/cache.md'], sensitive: [] } }
    : { decision: 'blocked', risk: 'low', reasons: ['cannot merge: merge_conflict'], matched: { low: ['docs/cache.md'], sensitive: [] } },
  checks: [{ name: 'CI', kind: 'pipeline', state: 'success' }], mergeable: { ok: canLand, reason: canLand ? '' : 'merge_conflict' }, evaluatedAt: at(0) });
const op = (changes: Record<string, unknown>) => ({ id: crypto.randomUUID(), repositoryId, pullRequestId: '901', number: 7, trigger: 'person', actorId: '17', actor: 'alex', state: 'LANDED', method: 'merge',
  headCommitId: prHead, baseCommitId: main, landedCommitId: 'f'.repeat(40), revertCommitId: '', attempts: 1, detail: {}, createdAt: at(5), updatedAt: at(5), ...changes });

async function backend(page: Page, { landing = true, canLand = true, operations = [] as ReturnType<typeof op>[], refuse = '' } = {}) {
  const state = { operations: [...operations], calls: [] as Record<string, unknown>[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.repository-general', label: 'General', state: 3, reason: 'Test.' },
      { id: 'repository.agentic-mode', label: 'Agentic mode', state: 3, reason: 'Schema 41.' }, ...(landing ? [{ id: 'repository.agentic-landing', label: 'Agentic landing', state: 3, reason: 'Schema 42.' }] : [])] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'GetPullRequest') return respond(route, GetPullRequestResponseSchema, { pullRequest: pull });
    if (method === 'GetPullRequestDiscussion') return respond(route, GetPullRequestDiscussionResponseSchema, { issue: { id: '101', number: 7, title: pull.title, state: IssueState.OPEN } });
    if (method === 'ListPullRequests') return respond(route, ListPullRequestsResponseSchema, { pullRequests: [pull], page: {} });
    if (method === 'ListPullRequestReviews') return respond(route, ListPullRequestReviewsResponseSchema, {});
    if (method === 'ListIssueComments') return respond(route, ListIssueCommentsResponseSchema, {});
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/repository-access') return json({ role: 'admin' });
    if (path === '/native/agentic-mode/read') {
      if (body.action === 'get') return json({ repositoryId, settings, canEdit: true, limits: { patterns: 50, patternLength: 200, checks: 50, checkLength: 100 }, feature: { allowed: true, reason: '', decidedBy: 'INSTALLATION' } });
      if (body.action === 'evaluate') return json(evaluation(canLand));
    }
    if (path === '/native/land/read' || path === '/native/land') {
      state.calls.push({ path, ...body });
      if (body.action === 'list') { const all = state.operations.filter(o => body.number === undefined || o.number === body.number), limit = Number(body.limit) || 20; return json({ repositoryId, operations: all.slice(0, limit), limit: body.limit, more: all.length > limit }); }
      if (body.action === 'land') {
        if (refuse) return json({ code: 'failed_precondition', message: refuse }, 412);
        const landed = op({ method: body.method, createdAt: at(0), updatedAt: at(0) });
        state.operations.unshift(landed);
        return json({ operation: landed, phase: 'LANDED' });
      }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}

test('a writer the policy allows lands from the Landing panel after confirming merge or squash', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/pull/7');
  const landing = page.getByRole('region', { name: 'Landing' });
  await expect(landing).toContainText('May land now');
  await expect(landing).toContainText('Low-risk changes land on their own once their required checks pass.');
  // The confirmation opens only on request.
  await expect(landing.getByRole('form', { name: 'Land pull request' })).toHaveCount(0);
  await landing.getByRole('button', { name: 'Land', exact: true }).click();
  const form = landing.getByRole('form', { name: 'Land pull request' });
  await expect(form.getByRole('radio', { name: /Merge/ })).toBeChecked();
  await form.getByRole('radio', { name: /Squash/ }).check();
  await form.getByRole('button', { name: 'Land now' }).click();
  await expect(landing.getByRole('status').filter({ hasText: 'Landed.' })).toBeVisible();
  const call = state.calls.find(c => c.action === 'land')!;
  expect(call).toMatchObject({ path: '/native/land', action: 'land', repository: key, repositoryId, number: 7, headCommitId: prHead, method: 'squash' });
  expect(call.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await expect(landing.getByLabel('Latest landing')).toContainText('Landed');
  await expect(landing.getByLabel('Latest landing')).toContainText('by alex');
  await expect(landing.getByLabel('Latest landing')).toContainText('Waiting for the required checks on the base branch.');
});

test('a refused land keeps the form open with the reason; Cancel closes it', async ({ page }) => {
  await backend(page, { refuse: 'Required checks have not passed yet: required check CI is still running.' });
  await page.goto('/alex/demo/pull/7');
  const landing = page.getByRole('region', { name: 'Landing' });
  await landing.getByRole('button', { name: 'Land', exact: true }).click();
  const form = landing.getByRole('form', { name: 'Land pull request' });
  await form.getByRole('button', { name: 'Land now' }).click();
  await expect(form.getByRole('alert')).toContainText('required check CI is still running');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(landing.getByRole('form', { name: 'Land pull request' })).toHaveCount(0);
});

test('without permission to land there is no Land button; the latest operation explains a conflict', async ({ page }) => {
  await backend(page, { canLand: false, operations: [op({ trigger: 'policy', actor: '', actorId: '0', state: 'NEEDS_REBASE', landedCommitId: '',
    detail: { reasons: ['the change conflicts with the base branch'], conflicts: [{ path: 'docs/cache.md', reason: 'both_modified' }], conflictCount: 1, commented: true } })] });
  await page.goto('/alex/demo/pull/7');
  const landing = page.getByRole('region', { name: 'Landing' });
  await expect(landing).toContainText('Blocked');
  await expect(landing.getByLabel('Latest landing')).toContainText('Needs a rebase');
  await expect(landing.getByLabel('Latest landing')).toContainText('by Golf (agentic mode)');
  await expect(landing.getByLabel('Latest landing')).toContainText('Conflicts with the base branch in docs/cache.md.');
  await expect(landing.getByRole('button', { name: 'Land', exact: true })).toHaveCount(0);
});

test('an installation before schema 42 shows the evaluation but no Land button and no landings', async ({ page }) => {
  const state = await backend(page, { landing: false });
  await page.goto('/alex/demo/pull/7');
  const landing = page.getByRole('region', { name: 'Landing' });
  await expect(landing).toContainText('May land now');
  await expect(landing.getByRole('button', { name: 'Land', exact: true })).toHaveCount(0);
  await page.goto('/alex/demo/settings/agentic-mode');
  await expect(page.getByRole('region', { name: 'Current setting' })).toContainText('Agentic modeOn');
  await expect(page.getByRole('region', { name: 'Recent landings', exact: true })).toHaveCount(0);
  expect(state.calls).toEqual([]);
});

test('Settings → Agentic mode lists recent landings in the shared table, including reverts by Golf', async ({ page }) => {
  const state = await backend(page, { operations: [
    op({ number: 9, trigger: 'policy', actor: '', actorId: '0', state: 'REVERTED', revertCommitId: 'c'.repeat(40), detail: { postLand: { verdict: 'failed', checks: ['CI'], action: 'revert' } }, updatedAt: at(2) }),
    op({ number: 7, state: 'LANDED', detail: { postLand: { verdict: 'passed', checks: ['CI'] } }, updatedAt: at(30) }),
    op({ number: 5, trigger: 'person', actor: 'sam', state: 'BLOCKED', landedCommitId: '', detail: { reasons: ['the base branch is locked by a branch rule'] }, updatedAt: at(90) }),
  ] });
  await page.goto('/alex/demo/settings/agentic-mode');
  const current = page.getByRole('region', { name: 'Current setting' });
  await expect(current).toContainText('Revert on failureOn — a change Golf landed on its own is reverted');
  const recent = page.getByRole('region', { name: 'Recent landings', exact: true });
  await expect(recent).toContainText('All 3 land operations are loaded, most recently updated first.');
  const table = recent.getByRole('table', { name: 'Recent landings' });
  await expect(table.getByRole('row').filter({ hasText: '#9' })).toContainText('Reverted');
  await expect(table.getByRole('row').filter({ hasText: '#9' })).toContainText('Golf (agentic mode)');
  await expect(table.getByRole('row').filter({ hasText: '#9' })).toContainText('Reverted automatically with cccccccccccc: required checks failed after landing (CI).');
  await expect(table.getByRole('row').filter({ hasText: '#7' })).toContainText('Required checks passed on the base branch.');
  await expect(table.getByRole('row').filter({ hasText: '#5' })).toContainText('the base branch is locked by a branch rule');
  await expect(table.getByRole('link', { name: '#9' })).toHaveAttribute('href', /\/alex\/demo\/pull\/9/);
  expect(state.calls.find(c => c.action === 'list')).toEqual({ path: '/native/land/read', action: 'list', repository: key, repositoryId, limit: 50 });
  await recent.getByRole('searchbox').fill('sam');
  await expect(table.getByRole('row')).toHaveCount(2);
});

test('Recent landings says older land operations are omitted only when the list is full', async ({ page }) => {
  await backend(page, { operations: Array.from({ length: 51 }, (_, i) => op({ number: i + 1, updatedAt: at(i) })) });
  await page.goto('/alex/demo/settings/agentic-mode');
  const recent = page.getByRole('region', { name: 'Recent landings', exact: true });
  await expect(recent).toContainText('The 50 most recently updated land operations are loaded; older ones are not, and search and sorting cover only these.');
  await expect(recent.getByText('most recently updated first')).toHaveCount(0);
});
