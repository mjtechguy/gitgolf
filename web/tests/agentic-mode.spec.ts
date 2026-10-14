import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetPullRequestDiscussionResponseSchema, GetPullRequestResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, IssueState,
  ListCapabilitiesResponseSchema, ListIssueCommentsResponseSchema, ListPullRequestReviewsResponseSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// Agentic mode on the Cloudflare-native runtime (docs/AGENTIC_MODE.md): repository Settings → Agentic mode and the read-only Landing
// panel on a pull request, against mocked /native/agentic-mode and /native/agentic-mode/read shaped like the Worker's API.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const key = { owner: 'alex', name: 'demo' }, repositoryId = '41', main = 'a'.repeat(40), prHead = 'd'.repeat(40);
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true, cloneUrl: 'https://golf.example/alex/demo.git', updatedAt: at(600) };
const pull = { id: '901', number: 7, title: 'Deploy the cache layer', body: 'Adds the cache and its deploy manifest.', revision: 'e'.repeat(64), state: IssueState.OPEN,
  base: { repositoryId, ref: 'main', commitId: main }, head: { repositoryId, ref: 'feature/cache', commitId: prHead }, user: { id: '43', login: 'sam' }, createdAt: at(900), updatedAt: at(100) };
const defaults = { enabled: false, lowRiskPaths: ['docs/**', '**/*.md'], sensitivePaths: ['.github/**', '.forgejo/**', '.gitlab-ci.yml', 'deploy/**', '**/CODEOWNERS'], landWithoutPerson: false, requiredChecks: [], revertOnFailure: true, version: 0, updatedBy: '', updatedAt: '' };
const limits = { patterns: 50, patternLength: 200, checks: 50, checkLength: 100 };
const evaluation = { repositoryId, number: 7, headCommitId: prHead, baseCommitId: main, mergeBaseCommitId: main, enabled: true, origin: 'agent-task', changedPathCount: 3,
  evaluation: { decision: 'needs_person', risk: 'sensitive', reasons: ['sensitive paths need approval from a writer who is not the author and not an agent: deploy/cache.yaml', 'required check CI is still running'], matched: { low: ['docs/cache.md'], sensitive: ['deploy/cache.yaml'] } },
  checks: [{ name: 'CI', kind: 'pipeline', state: 'pending' }], mergeable: { ok: true, reason: '' }, evaluatedAt: at(0) };

async function backend(page: Page, { capability = true, enabled = false, allowed = true, canEdit = true, refuse = '' } = {}) {
  const state = { settings: { ...defaults, enabled }, calls: [] as Record<string, unknown>[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.repository-general', label: 'General', state: 3, reason: 'Test.' },
      ...(capability ? [{ id: 'repository.agentic-mode', label: 'Agentic mode', state: 3, reason: 'Schema 41.' }] : [{ id: 'repository.agentic-mode', label: 'Agentic mode', state: 1, reason: 'Apply the schema 41 migration to use agentic mode.' }])] });
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
    const current = () => ({ repositoryId, settings: state.settings, canEdit, limits,
      feature: allowed ? { allowed: true, reason: 'Agentic mode is allowed by the installation policy.', decidedBy: 'INSTALLATION' } : { allowed: false, reason: 'Agentic mode is turned off for this repository by the installation policy.', decidedBy: 'INSTALLATION' } });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/repository-access') return json({ role: canEdit ? 'admin' : 'read' });
    if (path === '/native/agentic-mode/read' || path === '/native/agentic-mode') {
      state.calls.push({ path, ...body });
      if (body.action === 'get') return json(current());
      if (body.action === 'evaluate') return json(evaluation);
      if (body.action === 'set') {
        if (refuse) return json({ code: 'invalid_argument', message: refuse }, 400);
        const { action: _a, repository: _r, repositoryId: _i, expectedVersion: _e, ...changes } = body;
        state.settings = { ...state.settings, ...changes, version: state.settings.version + 1, updatedBy: 'alex', updatedAt: at(0) } as typeof state.settings;
        return json(current());
      }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}

test('the setting leads with its current values and path rules; Edit opens the form and saves every field with the version read', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/agentic-mode');
  await expect(page.getByRole('heading', { level: 1, name: 'Agentic mode' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Repository settings' }).getByRole('link', { name: 'Agentic mode' })).toHaveAttribute('aria-current', 'page');
  const current = page.getByRole('region', { name: 'Current setting' });
  await expect(current).toContainText('Agentic modeOff');
  await expect(current).toContainText('Land without a personOff');
  await expect(current).toContainText('Every pipeline that runs on the head commit');
  await expect(current).toContainText('Never: these are the defaults');
  await expect(current).toContainText('does not land pull requests on its own yet');
  const rules = page.getByRole('table', { name: 'Agentic mode path rules' });
  await expect(rules.getByRole('row').filter({ hasText: 'docs/**' })).toContainText('Low-risk');
  await expect(rules.getByRole('row').filter({ hasText: 'deploy/**' })).toContainText('Sensitive');
  // The form opens only on request.
  await expect(page.getByRole('form', { name: 'Edit agentic mode' })).toHaveCount(0);
  await current.getByRole('button', { name: 'Edit agentic mode' }).click();
  const form = page.getByRole('form', { name: 'Edit agentic mode' });
  await form.getByRole('checkbox', { name: /^Agentic mode/ }).check();
  await expect(form.getByRole('note')).toHaveCount(0);
  await form.getByRole('checkbox', { name: /Land without a person/ }).check();
  await expect(form.getByRole('note')).toContainText('needs no review once its required checks pass');
  await form.getByLabel('Low-risk paths').fill('docs/**\n**/*.md\n  **/*_test.go  \n');
  await form.getByLabel('Required checks').fill('CI\nlint / eslint');
  await form.getByRole('checkbox', { name: /Revert on failure/ }).uncheck();
  await form.getByRole('button', { name: 'Save agentic mode' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Agentic mode saved.' })).toBeVisible();
  expect(state.calls.find(call => call.action === 'set')).toEqual({ path: '/native/agentic-mode', action: 'set', repository: key, repositoryId, expectedVersion: 0, enabled: true,
    lowRiskPaths: ['docs/**', '**/*.md', '**/*_test.go'], sensitivePaths: defaults.sensitivePaths, landWithoutPerson: true, requiredChecks: ['CI', 'lint / eslint'], revertOnFailure: false });
  await expect(page.getByRole('form', { name: 'Edit agentic mode' })).toHaveCount(0);
  await expect(current).toContainText('Agentic modeOn');
  await expect(current).toContainText('Land without a personOn');
  await expect(current).toContainText('CI, lint / eslint');
  await expect(current).toContainText('alex');
  await expect(rules.getByRole('row').filter({ hasText: '**/*_test.go' })).toContainText('Low-risk');
});

test('a refused save keeps the form open with the server’s reason; Cancel returns to the current values', async ({ page }) => {
  await backend(page, { refuse: 'Low-risk paths: /docs — Patterns are relative to the repository root: no leading or trailing slash.' });
  await page.goto('/alex/demo/settings/agentic-mode');
  await page.getByRole('button', { name: 'Edit agentic mode' }).click();
  const form = page.getByRole('form', { name: 'Edit agentic mode' });
  await form.getByLabel('Low-risk paths').fill('/docs');
  await form.getByRole('button', { name: 'Save agentic mode' }).click();
  await expect(form.getByRole('alert')).toContainText('no leading or trailing slash');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('form', { name: 'Edit agentic mode' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current setting' })).toContainText('Agentic modeOff');
});

test('a policy that turns agentic mode off is named, and readers see the values without Edit', async ({ page }) => {
  await backend(page, { allowed: false, canEdit: false });
  await page.goto('/alex/demo/settings/agentic-mode');
  const current = page.getByRole('region', { name: 'Current setting' });
  await expect(current.getByRole('note')).toContainText('turned off for this repository by the installation policy');
  await expect(current).toContainText('Agentic modeOff');
  await expect(current.getByRole('button', { name: 'Edit agentic mode' })).toHaveCount(0);
});

test('an installation without the schema says so instead of opening the page', async ({ page }) => {
  await backend(page, { capability: false });
  await page.goto('/alex/demo/settings/agentic-mode');
  await expect(page.getByText('Apply the schema 41 migration to use agentic mode.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current setting' })).toHaveCount(0);
});

test('the pull request shows the landing evaluation only while agentic mode is on', async ({ page }) => {
  const state = await backend(page, { enabled: true });
  await page.goto('/alex/demo/pull/7');
  const landing = page.getByRole('region', { name: 'Landing' });
  await expect(landing).toContainText('Needs a person');
  await expect(landing).toContainText('Sensitive');
  await expect(landing.getByRole('listitem').filter({ hasText: 'required check CI is still running' })).toBeVisible();
  await expect(landing.locator('.pull-landing-paths')).toHaveText('deploy/cache.yaml');
  await expect(landing).toContainText('3 changed paths, opened by an agent task.');
  expect(state.calls.filter(call => call.action === 'evaluate')).toEqual([{ path: '/native/agentic-mode/read', action: 'evaluate', repository: key, repositoryId, number: 7 }]);
  await landing.getByRole('button', { name: 'Refresh landing evaluation' }).click();
  await expect.poll(() => state.calls.filter(call => call.action === 'evaluate').length).toBe(2);
});

test('with agentic mode off the pull request has no landing panel and evaluates nothing', async ({ page }) => {
  const state = await backend(page, { enabled: false });
  await page.goto('/alex/demo/pull/7');
  await expect(page.getByRole('heading', { name: /Deploy the cache layer/ })).toBeVisible();
  await expect.poll(() => state.calls.filter(call => call.action === 'get').length).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Landing' })).toHaveCount(0);
  expect(state.calls.filter(call => call.action === 'evaluate')).toEqual([]);
});
