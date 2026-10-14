import { expect, test, type Page } from '@playwright/test';
import { create, toJson } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, IssueState, ListCapabilitiesResponseSchema, ListPullRequestsResponseSchema,
  ListRepositoriesResponseSchema, WatchRepositoryResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// The agentic inbox on the Cloudflare-native runtime (docs/AGENTIC_MODE.md "Inbox and intent summaries"): /alex/demo/agents while
// agentic mode is on, against mocked /native/agent-inbox(/read), /native/agentic-mode/read and /native/land shaped like the Worker's API.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const key = { owner: 'alex', name: 'demo' }, repositoryId = '41', main = 'a'.repeat(40);
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true, cloneUrl: 'https://golf.example/alex/demo.git', updatedAt: at(600) };
const settings = (enabled: boolean) => ({ repositoryId, settings: { enabled, lowRiskPaths: ['docs/**'], sensitivePaths: ['deploy/**'], landWithoutPerson: true, requiredChecks: [], revertOnFailure: true, version: 2, updatedBy: 'alex', updatedAt: at(60) },
  feature: { allowed: true, reason: 'Agentic mode is allowed by the installation policy.', decidedBy: 'INSTALLATION' }, canEdit: true, limits: { patterns: 50, patternLength: 200, checks: 50, checkLength: 100 } });
const none = { passed: 0, pending: 0, failed: 0 };
const pull = (number: number, extra: Record<string, unknown>) => ({ number, title: `Change ${number}`, author: 'sam', pullRequestId: String(900 + number), origin: 'agent-task', headCommitId: String(number % 10).repeat(40), baseCommitId: main,
  decision: 'needs_person', risk: 'normal', reasons: [], sensitivePaths: [], conflicts: [], mergeable: true, changedPathCount: 2, checks: none, intent: null, landing: null, ...extra });
const summary = { headCommitId: '9'.repeat(40), model: '@cf/zai-org/glm-5.3', aiWritten: true, createdAt: at(0), intent: 'Moves the cache deploy manifest under deploy/ and documents it.',
  areas: ['deploy manifests', 'cache docs'], risks: ['The cache service restarts on deploy.'], confidence: 'medium', coverage: { files: 2, totalFiles: 3, bytes: 4096, limitBytes: 49152, notReadCount: 1, descriptionTruncated: false } };
const inbox = (landing: boolean) => ({ repositoryId, enabled: true, feature: { allowed: true, reason: '' }, generatedAt: at(0), limit: 50,
  inProgress: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', state: 'RUNNING', tool: 'claude', model: '', host: 'mj-laptop', requestedBy: 'alex', target: { kind: 'issue', number: 12, title: 'Retry webhook deliveries' }, branch: 'golf-agent/1a2b3c4d', createdAt: at(5), startedAt: at(4) }],
  readyToLand: [pull(7, { title: 'Fix typo in docs', decision: 'land', risk: 'low', reasons: ['every changed path is low-risk'], checks: { passed: 2, pending: 0, failed: 0 } }),
    pull(8, { title: 'Update guide', decision: 'waiting_checks', risk: 'low', reasons: ['required check CI is still running'], checks: { passed: 0, pending: 1, failed: 0 } })],
  needsPerson: [pull(9, { title: 'Move the cache manifest', risk: 'sensitive', reasons: ['sensitive paths need approval from a writer who is not the author and not an agent: deploy/cache.yaml'], sensitivePaths: ['deploy/cache.yaml'] }),
    pull(10, { title: 'Rework retries', decision: 'blocked', reasons: ['cannot merge: merge_conflict'], conflicts: [{ path: 'src/retry.ts', reason: 'both_modified' }], mergeable: false, origin: 'person',
      intent: { ...summary, headCommitId: '0'.repeat(40), intent: 'Rewrites retry handling with a backoff helper.', risks: [] } })],
  landed: landing ? [{ id: '5', pullRequestId: '906', number: 6, title: 'Bump docs', trigger: 'policy', actor: '', state: 'LANDED', method: 'squash', headCommitId: '6'.repeat(40), landedCommitId: 'c'.repeat(40), revertCommitId: '', createdAt: at(30), updatedAt: at(29) }] : [],
  landingHistory: landing ? 'available' : 'unavailable',
  pulls: { state: 'evaluated', reason: '', open: 31, evaluated: 25, evaluateLimit: 25 }, truncated: { inProgress: false, pulls: true, landed: false }, summaries: { available: true, reason: '' } });
const envelope = (flags: number, json: unknown) => { const body = Buffer.from(JSON.stringify(json)), header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); };

async function backend(page: Page, { enabled = true, inboxCapability = true, landing = false, reader = false, live = false } = {}) {
  const state = { calls: [] as Record<string, unknown>[], summaryReads: 0, cursor: 1, live };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex' } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [
      { id: 'agents.hosts', label: 'Agent hosts', state: 3, reason: 'Schema present.' }, { id: 'repository.agentic-mode', label: 'Agentic mode', state: 3, reason: 'Schema 41.' },
      ...(inboxCapability ? [{ id: 'repository.agent-inbox', label: 'Agentic inbox', state: 3, reason: 'Schema 43.' }] : []),
      ...(landing ? [{ id: 'repository.agentic-landing', label: 'Land queue', state: 3, reason: 'Test.' }] : []),
      ...(live ? [{ id: 'repository.live', label: 'Live activity stream', state: 3, reason: 'Test.' }] : [])] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'ListPullRequests') return respond(route, ListPullRequestsResponseSchema, { pullRequests: [{ id: '907', number: 7, title: 'Fix typo in docs', state: IssueState.OPEN, base: { repositoryId, ref: 'main', commitId: main }, head: { repositoryId, ref: 'topic', commitId: '7'.repeat(40) }, user: { id: '43', login: 'sam' }, createdAt: at(60), updatedAt: at(5) }], page: {} });
    if (method === 'WatchRepository' && state.live) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const input = JSON.parse(route.request().postDataBuffer()!.subarray(5).toString()), cursor = String(state.cursor);
      const event = toJson(WatchRepositoryResponseSchema, create(WatchRepositoryResponseSchema, { repositoryId, cursor, kind: input.cursor ? input.cursor === cursor ? 'heartbeat' : 'change' : 'reset', topics: input.cursor && input.cursor !== cursor ? ['pulls'] : [] }));
      return route.fulfill({ status: 200, contentType: 'application/connect+json', body: Buffer.concat([envelope(0, event), envelope(0, { repositoryId, cursor, kind: 'reconnect' }), envelope(2, {})]) });
    }
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/repository-access') return json({ role: reader ? 'read' : 'write' });
    if (path === '/native/agent-tasks') return json({ tasks: [], canAssign: false });
    if (path === '/native/agentic-mode/read') { state.calls.push({ path, ...body }); return json(settings(enabled)); }
    if (path.startsWith('/native/agent-inbox') || path === '/native/land') {
      state.calls.push({ path, ...body });
      if (body.action === 'inbox') return json({ ...inbox(landing), ...(reader ? { summaries: { available: false, reason: 'Asking for an intent summary needs write or admin access to this repository.' } } : {}) });
      if (body.action === 'summarize') return json({ number: body.number, pullRequestId: '909', baseCommitId: main, headCommitId: '9'.repeat(40), state: 'RUNNING', summary: null, run: { id: 'run-1', state: 'REQUESTED' } });
      if (body.action === 'summary') {
        const done = ++state.summaryReads > 1;
        return json({ number: body.number, pullRequestId: '909', baseCommitId: main, headCommitId: '9'.repeat(40), summary: done ? summary : null, run: { id: 'run-1', state: done ? 'SUCCEEDED' : 'RESERVED' }, inFlight: !done, summaries: { available: true, reason: '' } });
      }
      if (path === '/native/land') return json({ state: 'QUEUED' });
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('with agentic mode on, the agents page is the inbox: four sections in shared tables with links to the pull requests', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/agents');
  await expect(page.getByRole('heading', { name: 'Agent inbox' })).toBeVisible();
  const counts = page.getByRole('group', { name: 'Inbox counts' });
  await expect(counts).toContainText('In progress1'); await expect(counts).toContainText('Ready to land2'); await expect(counts).toContainText('Needs a person2'); await expect(counts).toContainText('Landing history unavailable');
  await expect(page.getByText(/Evaluated 25 of 31 open pull requests, newest first; at most 25 are evaluated per read/)).toBeVisible();
  const progress = section(page, 'In progress').getByRole('table', { name: 'agent tasks in progress' });
  await expect(progress.getByRole('row').filter({ hasText: 'Retry webhook deliveries' })).toContainText('Running');
  await expect(progress.getByRole('link', { name: '#12 Retry webhook deliveries' })).toHaveAttribute('href', '/alex/demo/issues/12');
  const ready = section(page, 'Ready to land').getByRole('table', { name: 'pull requests ready to land' });
  await expect(ready.getByRole('row').filter({ hasText: 'Fix typo in docs' })).toContainText('May land now');
  await expect(ready.getByRole('row').filter({ hasText: 'Update guide' })).toContainText('Waiting for checks');
  await expect(ready.getByRole('link', { name: '#7', exact: true })).toHaveAttribute('href', '/alex/demo/pull/7');
  const person = section(page, 'Needs a person').getByRole('table', { name: 'pull requests that need a person' });
  await expect(person.getByRole('row').filter({ hasText: 'Move the cache manifest' })).toContainText('deploy/cache.yaml');
  await expect(person.getByRole('row').filter({ hasText: 'Rework retries' })).toContainText('Blocked');
  await expect(person.getByRole('row').filter({ hasText: 'Rework retries' })).toContainText('src/retry.ts');
  // Loaded-page search is labelled honestly and filters the loaded rows.
  await section(page, 'Needs a person').getByLabel('Search loaded pull requests that need a person').fill('retries');
  await expect(person.getByRole('row')).toHaveCount(2);
  await expect(section(page, 'Landed')).toContainText('Landing history unavailable: this installation has no land queue yet.');
  // Without the land queue capability there is no batch action and nothing to select.
  await expect(page.getByRole('button', { name: /Land selected/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(section(page, 'Ready to land')).toContainText('Golf does not land pull requests from the inbox on this installation');
  expect(state.calls.filter(call => call.action === 'inbox')[0]).toEqual({ path: '/native/agent-inbox/read', action: 'inbox', repository: key, repositoryId });
});

test('Summarize intent asks Workers AI and shows the summary marked AI-written beside a link to the diff', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/agents');
  await section(page, 'Needs a person').getByRole('button', { name: 'Summarize intent of #9' }).click();
  const panel = page.getByRole('region', { name: 'Intent summary for #9' });
  await expect(panel).toContainText('AI-written');
  await expect(panel).toContainText('Moves the cache deploy manifest under deploy/ and documents it.');
  await expect(panel.getByRole('listitem').filter({ hasText: 'The cache service restarts on deploy.' })).toBeVisible();
  await expect(panel).toContainText('@cf/zai-org/glm-5.3');
  await expect(panel).toContainText('Read 2 of 3 changed files (4.0 KiB of at most 48 KiB); 1 not read');
  await expect(panel).toContainText('It never replaces the diff.');
  await expect(panel.getByRole('link', { name: 'Review the changes' })).toHaveAttribute('href', '/alex/demo/pull/9/files');
  const asked = state.calls.find(call => call.action === 'summarize')!;
  expect(asked).toMatchObject({ path: '/native/agent-inbox', action: 'summarize', repository: key, repositoryId, number: 9 });
  expect(asked.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  // A stored summary opens without asking again.
  await panel.getByRole('button', { name: 'Close' }).click();
  await section(page, 'Needs a person').getByRole('button', { name: 'Show intent summary for #10' }).click();
  await expect(page.getByRole('region', { name: 'Intent summary for #10' })).toContainText('AI-written');
  expect(state.calls.filter(call => call.action === 'summarize')).toHaveLength(1);
});

test('readers see why they cannot ask for summaries, and no Summarize button', async ({ page }) => {
  await backend(page, { reader: true });
  await page.goto('/alex/demo/agents');
  await expect(page.getByText('Intent summaries: Asking for an intent summary needs write or admin access to this repository.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Summarize intent/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show intent summary for #10' })).toBeVisible();
});

test('with the land queue reported, ready pull requests that may land can be selected and landed; recent landings are listed', async ({ page }) => {
  const state = await backend(page, { landing: true });
  await page.goto('/alex/demo/agents');
  const ready = section(page, 'Ready to land');
  await expect(ready.getByRole('checkbox')).toHaveCount(1);
  const land = ready.getByRole('button', { name: 'Land selected (0)' });
  await expect(land).toBeDisabled();
  await ready.getByRole('checkbox', { name: 'Select #7 to land' }).check();
  await ready.getByRole('button', { name: 'Land selected (1)' }).click();
  await expect(ready.getByRole('list', { name: 'Landing requests' })).toContainText('#7: accepted (queued)');
  expect(state.calls.find(call => call.path === '/native/land')).toMatchObject({ action: 'land', repository: key, repositoryId, number: 7, headCommitId: '7'.repeat(40) });
  const landed = section(page, 'Landed').getByRole('table', { name: 'recent landings' });
  await expect(landed.getByRole('row').filter({ hasText: 'Bump docs' })).toContainText('Landed');
  await expect(landed.getByRole('row').filter({ hasText: 'Bump docs' })).toContainText('Policy');
});

test('live repository activity re-reads the inbox', async ({ page }) => {
  const state = await backend(page, { live: true });
  await page.goto('/alex/demo/agents');
  await expect(page.getByRole('heading', { name: 'Agent inbox' })).toBeVisible();
  await expect.poll(() => state.calls.filter(call => call.action === 'inbox').length).toBeGreaterThan(0);
  const before = state.calls.filter(call => call.action === 'inbox').length;
  state.cursor = 2;
  await expect.poll(() => state.calls.filter(call => call.action === 'inbox').length, { timeout: 10000 }).toBeGreaterThan(before);
});

test('with agentic mode off, or before schema 43, the agents page stays the workspace view and reads no inbox', async ({ page }) => {
  let state = await backend(page, { enabled: false });
  await page.goto('/alex/demo/agents');
  await expect(page.getByRole('heading', { name: 'Agent workspace' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent tasks in this repository' })).toBeVisible();
  expect(state.calls.filter(call => call.action === 'inbox')).toEqual([]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  state = await backend(page, { inboxCapability: false });
  await page.goto('/alex/demo/agents');
  await expect(page.getByRole('heading', { name: 'Agent workspace' })).toBeVisible();
  expect(state.calls.filter(call => call.action === 'inbox' || call.path === '/native/agentic-mode/read')).toEqual([]);
});
