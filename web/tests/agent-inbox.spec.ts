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
  readyToLand: [pull(7, { title: 'Fix typo in docs', decision: 'land', risk: 'low', reasons: ['every changed path is low-risk'], checks: { passed: 2, pending: 0, failed: 0 }, canLand: true }),
    pull(8, { title: 'Update guide', decision: 'waiting_checks', risk: 'low', reasons: ['required check CI is still running'], checks: { passed: 0, pending: 1, failed: 0 }, canLand: false })],
  needsPerson: [pull(9, { title: 'Move the cache manifest', risk: 'sensitive', reasons: ['sensitive paths need approval from a writer who is not the author and not an agent: deploy/cache.yaml'], sensitivePaths: ['deploy/cache.yaml'], canLand: true }),
    pull(10, { title: 'Rework retries', decision: 'blocked', reasons: ['cannot merge: merge_conflict'], conflicts: [{ path: 'src/retry.ts', reason: 'both_modified' }], mergeable: false, origin: 'person', canLand: false,
      intent: { ...summary, headCommitId: '0'.repeat(40), intent: 'Rewrites retry handling with a backoff helper.', risks: [] } })],
  landed: landing ? [{ id: '5a5a5a5a-0000-4000-8000-000000000005', pullRequestId: '906', number: 6, title: 'Bump docs', trigger: 'policy', actor: '', state: 'LANDED', method: 'squash', headCommitId: '6'.repeat(40), landedCommitId: 'c'.repeat(40), revertCommitId: '', revert: null, createdAt: at(30), updatedAt: at(29) },
    { id: '4a4a4a4a-0000-4000-8000-000000000004', pullRequestId: '905', number: 5, title: 'Tune retries', trigger: 'person', actor: 'alex', state: 'REVERTED', method: 'merge', headCommitId: '5'.repeat(40), landedCommitId: 'd'.repeat(40), revertCommitId: 'e'.repeat(40),
      revert: { state: 'applied', trigger: 'person', actor: 'sam', reason: 'Broke the cache.', conflicts: [] }, createdAt: at(90), updatedAt: at(80) },
    { id: '3a3a3a3a-0000-4000-8000-000000000003', pullRequestId: '904', number: 4, title: 'Docs links', trigger: 'policy', actor: '', state: 'LANDED', method: 'merge', headCommitId: '4'.repeat(40), landedCommitId: 'f'.repeat(40), revertCommitId: '',
      revert: { state: 'conflict', trigger: 'policy', actor: '', reason: '', conflicts: ['docs/links.md'] }, createdAt: at(120), updatedAt: at(110) }] : [],
  landingHistory: landing ? 'available' : 'unavailable',
  pulls: { state: 'evaluated', reason: '', open: 31, evaluated: 25, evaluateLimit: 25 }, truncated: { inProgress: false, pulls: true, landed: false }, summaries: { available: true, reason: '' },
  actions: { land: landing, revert: landing, reason: landing ? '' : 'This installation has no land queue yet.' } });
// The land queue's answers, shaped like land-queue.mjs: #7 lands, #9 (approval only) conflicts, anything else was refused before it was recorded.
const operation = (number: number, state: string, detail: Record<string, unknown> = {}) => ({ id: `op-${number}`, repositoryId, pullRequestId: String(900 + number), number, trigger: 'person', actorId: '17', actor: 'alex', state, method: 'merge',
  headCommitId: String(number % 10).repeat(40), baseCommitId: main, landedCommitId: state === 'LANDED' ? 'b'.repeat(40) : '', revertCommitId: '', attempts: 1, createdAt: at(0), updatedAt: at(0), detail });
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
      if (body.action === 'inbox') {
        const value = inbox(landing);
        return json(reader ? { ...value, summaries: { available: false, reason: 'Asking for an intent summary needs write or admin access to this repository.' },
          readyToLand: value.readyToLand.map(row => ({ ...row, canLand: false })), needsPerson: value.needsPerson.map(row => ({ ...row, canLand: false })),
          actions: { land: false, revert: false, reason: 'Landing and reverting need write or admin access to this repository.' } } : value);
      }
      if (body.action === 'summarize') return json({ number: body.number, pullRequestId: '909', baseCommitId: main, headCommitId: '9'.repeat(40), state: 'RUNNING', summary: null, run: { id: 'run-1', state: 'REQUESTED' } });
      if (body.action === 'summary') {
        const done = ++state.summaryReads > 1;
        return json({ number: body.number, pullRequestId: '909', baseCommitId: main, headCommitId: '9'.repeat(40), summary: done ? summary : null, run: { id: 'run-1', state: done ? 'SUCCEEDED' : 'RESERVED' }, inFlight: !done, summaries: { available: true, reason: '' } });
      }
      if (path === '/native/land' && body.action === 'revert') {
        await new Promise(resolve => setTimeout(resolve, 100));
        return json({ operation: { ...operation(6, 'REVERTED'), id: body.id, landedCommitId: 'c'.repeat(40), revertCommitId: 'a1'.repeat(20) }, phase: 'REVERTED', revert: { state: 'applied', trigger: 'person', actor: 'alex' } });
      }
      if (path === '/native/land' && body.number === 7) return json({ operation: operation(7, 'LANDED'), phase: 'LANDED' });
      if (path === '/native/land' && body.number === 9) return json({ operation: operation(9, 'NEEDS_REBASE', { reasons: ['the change conflicts with the base branch'], conflicts: [{ path: 'deploy/cache.yaml', reason: 'both_modified' }], conflictCount: 1 }), phase: 'LAND_REFUSED' });
      if (path === '/native/land') return json({ code: 'failed_precondition', message: 'The pull request head moved to 0123456789ab. Review the new head before landing.' }, 412);
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

test('with the land queue reported, a writer approves and lands a selection: one land request per pull request, each answer shown as it came', async ({ page }) => {
  const state = await backend(page, { landing: true });
  await page.goto('/alex/demo/agents');
  const ready = section(page, 'Ready to land'), person = section(page, 'Needs a person');
  // Rows the caller may land: #7 (the policy says land) and #9 (it waits only for a writer who is not the author); not #8 or #10.
  await expect(ready.getByRole('checkbox')).toHaveCount(1); await expect(person.getByRole('checkbox')).toHaveCount(1);
  await expect(ready.getByRole('button', { name: 'Land selected (0)' })).toBeDisabled();
  await ready.getByRole('checkbox', { name: 'Select #7 to land' }).check();
  await expect(ready.getByRole('button', { name: 'Land selected (1)' })).toBeEnabled();
  await person.getByRole('checkbox', { name: 'Select #9 to approve and land' }).check();
  await ready.getByRole('button', { name: 'Approve and land selected (2)' }).click();
  // Confirmation first: nothing is sent until it is confirmed.
  const confirm = page.getByRole('form', { name: 'Confirm landing' });
  await expect(confirm).toContainText('#7 Fix typo in docs'); await expect(confirm).toContainText('#9 Move the cache manifest');
  await expect(confirm).toContainText('your land request is the approval it waits for');
  expect(state.calls.filter(call => call.path === '/native/land')).toEqual([]);
  await confirm.getByLabel(/Squash/).check();
  await confirm.getByRole('button', { name: 'Land 2 now' }).click();
  const results = ready.getByRole('list', { name: 'Landing requests' });
  await expect(results.getByRole('listitem').filter({ hasText: '#7' })).toContainText('#7 Landed · Landed as bbbbbbbbbbbb.');
  await expect(results.getByRole('listitem').filter({ hasText: '#9' })).toContainText('#9 Needs a rebase · Needs a rebase: conflicts with the base branch in deploy/cache.yaml.');
  const sent = state.calls.filter(call => call.path === '/native/land');
  expect(sent.map(call => ({ ...call, idempotencyKey: undefined }))).toEqual([
    { path: '/native/land', action: 'land', repository: key, repositoryId, number: 7, headCommitId: '7'.repeat(40), method: 'squash', idempotencyKey: undefined },
    { path: '/native/land', action: 'land', repository: key, repositoryId, number: 9, headCommitId: '9'.repeat(40), method: 'squash', idempotencyKey: undefined }]);
  expect(new Set(sent.map(call => call.idempotencyKey)).size).toBe(2);
  for (const call of sent) expect(call.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // A refusal is reported with the Worker's reason, not as accepted.
  await ready.getByRole('checkbox', { name: 'Select #7 to land' }).check();
  await page.route('**/native/land', route => route.fulfill({ status: 412, contentType: 'application/json', body: JSON.stringify({ code: 'failed_precondition', message: 'The pull request head moved to 0123456789ab. Review the new head before landing.' }) }));
  await ready.getByRole('button', { name: 'Land selected (1)' }).click();
  await page.getByRole('form', { name: 'Confirm landing' }).getByRole('button', { name: 'Land 1 now' }).click();
  await expect(results).toContainText('#7 Refused · Refused: The pull request head moved to 0123456789ab.');
  const landed = section(page, 'Landed').getByRole('table', { name: 'recent landings' });
  await expect(landed.getByRole('row').filter({ hasText: 'Bump docs' })).toContainText('Policy');
  await expect(landed.getByRole('row').filter({ hasText: 'Tune retries' })).toContainText('Reverted by sam from the agentic inbox with eeeeeeeeeeee.');
  await expect(landed.getByRole('row').filter({ hasText: 'Docs links' })).toContainText('the revert conflicts with later changes');
});

test('a writer reverts a landing from the Landed section after confirming it; readers cannot', async ({ page }) => {
  const state = await backend(page, { landing: true });
  await page.goto('/alex/demo/agents');
  const landed = section(page, 'Landed');
  // Only landings still LANDED offer Revert.
  await expect(landed.getByRole('button', { name: /Revert the landing of/ })).toHaveCount(2);
  await expect(landed.getByRole('button', { name: 'Revert the landing of #5' })).toHaveCount(0);
  await landed.getByRole('button', { name: 'Revert the landing of #6' }).click();
  const form = page.getByRole('form', { name: 'Revert #6' });
  await expect(form).toContainText('Golf commits the inverse of cccccccccccc onto the current base branch, as you, through the branch write fence.');
  expect(state.calls.filter(call => call.action === 'revert')).toEqual([]);
  await form.getByLabel(/Reason/).fill('Broke the docs build.');
  await form.getByRole('button', { name: 'Revert #6' }).click();
  await expect(landed.getByRole('status')).toContainText(`Reverted #6 with ${'a1'.repeat(6)}.`);
  const [revert] = state.calls.filter(call => call.action === 'revert');
  expect({ ...revert, idempotencyKey: undefined }).toEqual({ path: '/native/land', action: 'revert', repository: key, repositoryId, id: '5a5a5a5a-0000-4000-8000-000000000005', number: 6, landedCommitId: 'c'.repeat(40), reason: 'Broke the docs build.', idempotencyKey: undefined });
  expect(revert?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  // Cancel sends nothing.
  await landed.getByRole('button', { name: 'Revert the landing of #4' }).click();
  await page.getByRole('form', { name: 'Revert #4' }).getByRole('button', { name: 'Cancel' }).click();
  expect(state.calls.filter(call => call.action === 'revert')).toHaveLength(1);
  // A reader sees why, and no Revert or selection.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await backend(page, { landing: true, reader: true });
  await page.goto('/alex/demo/agents');
  await expect(section(page, 'Landed').getByRole('button', { name: /Revert the landing/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(section(page, 'Ready to land')).toContainText('Landing and reverting need write or admin access to this repository.');
});

// AM-5 exit: the inbox in all nine layouts (three per appearance), at desktop and phone widths, nothing overflowing the page.
test.describe('the inbox in every layout', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const presets = { classic: ['primer', 'workbench', 'reader'], golf: ['refined', 'strokes', 'tiles'], flare: ['kumo', 'overview', 'console'] } as const;
  for (const [appearance, layouts] of Object.entries(presets)) for (const layout of layouts) test(`${appearance} ${layout}`, async ({ page }) => {
    await page.addInitScript(([a, l]) => { localStorage.setItem('golf.appearance', a!); localStorage.setItem(`golf.layout.${a}`, l!); localStorage.setItem('golf.theme', 'light'); }, [appearance, layout]);
    await backend(page, { landing: true });
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/alex/demo/agents');
      await expect(page.locator('html')).toHaveAttribute('data-layout', layout);
      await expect(page.getByRole('heading', { name: 'Agent inbox' })).toBeVisible();
      for (const name of ['In progress', 'Ready to land', 'Needs a person', 'Landed']) await expect(section(page, name)).toBeVisible();
      await expect(page.getByRole('group', { name: 'Inbox counts' })).toContainText('Ready to land2');
      await expect(section(page, 'Ready to land').getByRole('table', { name: 'pull requests ready to land' }).getByRole('link', { name: 'Fix typo in docs' })).toBeVisible();
      await section(page, 'Ready to land').getByRole('checkbox', { name: 'Select #7 to land' }).check();
      await section(page, 'Ready to land').getByRole('button', { name: 'Land selected (1)' }).click();
      await expect(page.getByRole('form', { name: 'Confirm landing' })).toBeVisible();
      await section(page, 'Landed').getByRole('button', { name: 'Revert the landing of #6' }).click();
      await expect(page.getByRole('form', { name: 'Revert #6' })).toBeVisible();
      // Wide tables scroll inside their own region; the page itself does not scroll sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/agent-inbox-${appearance}-${layout}-${width}.png`, fullPage: true });
    }
  });
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
