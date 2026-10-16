import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { CreatePullRequestRequestSchema, CreatePullRequestResponseSchema, GetAuthenticationOptionsResponseSchema, GetIssueResponseSchema, GetPullRequestResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema,
  IssueState, ListCapabilitiesResponseSchema, ListIssueCommentsResponseSchema, ListPullRequestReviewsResponseSchema, ListPullRequestsResponseSchema, ListRepositoriesResponseSchema, RepositorySourceRefKind, RepositorySourceResolution,
  ResolveRepositorySourceRequestSchema, ResolveRepositorySourceResponseSchema, GetPullRequestDiscussionResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { GetRepositoryFeaturesResponseSchema, FeatureDecider } from '../src/gen/golf/v1/feature_policy_pb';
import { reject, request, respond } from './rpc';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

// Agent hosts on the Cloudflare-native runtime (docs/AGENT_HOSTS.md): host settings at three scopes, "Assign to agent" and the task panel
// on issues and pull requests, against mocked /native/agent-hosts and /native/agent-tasks shaped like the contract's user API.
// GOLF_AGENT_SHOTS=/tmp/golf-ui-review/agent-shots writes review screenshots.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const key = { owner: 'alex', name: 'demo' }, repositoryId = '41', main = 'a'.repeat(40), head = 'c'.repeat(40), prHead = 'd'.repeat(40);
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true, cloneUrl: 'https://golf.example/alex/demo.git', updatedAt: at(600) };
const issue = { id: '301', number: 12, title: 'Retry webhook deliveries with backoff', body: 'Failed deliveries are dropped after one try.', state: IssueState.OPEN, user: { id: '17', login: 'alex' }, createdAt: at(300), updatedAt: at(60), comments: 2 };
const pull = { id: '901', number: 7, title: 'Cache repository reads per commit', body: 'Reads of the same commit share one cached tree.', revision: 'e'.repeat(64), state: IssueState.OPEN,
  base: { repositoryId, ref: 'main', commitId: main }, head: { repositoryId, ref: 'feature/cache', commitId: prHead }, user: { id: '43', login: 'sam' }, createdAt: at(900), updatedAt: at(100) };

type Host = Record<string, unknown> & { id: string; name: string; version: number };
const hosts = (): Host[] => [
  { id: '1', uuid: 'h-1', name: 'mj-laptop', scope: 'personal', scopeId: '17', state: 'ACTIVE', online: true, lastSeenAt: at(0), shareSignins: false, allowedUsers: [], allowedRepositories: [],
    enabledTools: ['codex', 'claude', 'opencode', 'grok'], maxConcurrent: 2, hostVersion: '0.1.0', os: 'linux', arch: 'amd64', activeTasks: 1, version: 3,
    tools: [{ tool: 'codex', version: '0.48.0', signedIn: true, account: '' }, { tool: 'claude', version: '2.1.3', signedIn: null, account: '' }, { tool: 'opencode', version: '0.15.2', signedIn: false, account: '' }] },
  { id: '2', uuid: 'h-2', name: 'build-box', scope: 'personal', scopeId: '17', state: 'DISABLED', online: false, lastSeenAt: at(140), shareSignins: true, allowedUsers: ['sam'], allowedRepositories: ['alex/demo'],
    enabledTools: ['grok'], maxConcurrent: 1, hostVersion: '0.1.0', os: 'darwin', arch: 'arm64', activeTasks: 0, version: 1, tools: [{ tool: 'grok', version: '1.0.4', signedIn: true, account: '' }] },
];
const available = { featureOn: true, reason: '', hosts: [
  { id: '1', name: 'mj-laptop', scope: 'personal', online: true, tools: [{ tool: 'codex', version: '0.48.0', signedIn: true, usable: true, reason: '' }, { tool: 'claude', version: '2.1.3', signedIn: null, usable: true, reason: '' },
    { tool: 'opencode', version: '0.15.2', signedIn: false, usable: false, reason: 'OpenCode is not signed in on this host.' }] },
  { id: '3', name: 'team-runner', scope: 'organization', online: false, tools: [{ tool: 'grok', version: '1.0.4', signedIn: true, usable: false, reason: 'This host does not share sign-ins; only the person who registered it may run tools.' }] }] };
const taskId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const task = (extra: Record<string, unknown> = {}) => ({ id: taskId, state: 'QUEUED', tool: 'codex', model: '', host: { id: '1', name: 'mj-laptop' }, requestedBy: { id: '17', login: 'alex' }, target: { kind: 'issue', number: 12, title: issue.title },
  branch: 'golf-agent/1a2b3c4d', baseRef: 'refs/heads/main', baseCommit: main, commitId: '', changedFiles: [], summary: '', usage: null, exitCode: null, failureReason: '',
  createdAt: at(0), startedAt: null, finishedAt: null, logLines: 0, ...extra });
const failed = task({ id: '9f8e7d6c-0000-4000-8000-000000000001', state: 'FAILED', tool: 'claude', branch: 'golf-agent/9f8e7d6c', failureReason: 'proposal_unverified', exitCode: 0, createdAt: at(90), startedAt: at(89), finishedAt: at(80), logLines: 2 });
const log = ['golf-agent-host 0.1.0: cloned alex/demo at aaaaaaa into golf-agent/1a2b3c4d', '$ codex exec --full-auto', 'Reading src/webhooks/deliver.ts', 'Added exponential backoff with jitter to deliver()', 'Ran npm test: 42 passed', 'Committed 3 files'];
const succeeded = { state: 'SUCCEEDED', commitId: head, changedFiles: ['src/webhooks/deliver.ts', 'src/webhooks/deliver.test.ts', 'docs/WEBHOOKS.md'], startedAt: at(1), finishedAt: at(0), exitCode: 0,
  summary: 'Retries failed deliveries up to **5 times** with exponential backoff and jitter.', usage: { inputTokens: 48210, outputTokens: 3120, costUsd: 0.41 }, logLines: log.length };

async function backend(page: Page, { refuse = false, finish = true, role = 'admin', tasks = [failed] as Record<string, unknown>[], refuseCancel = false, resync = false, agentsOff = false } = {}) {
  const state = { hosts: hosts(), tokens: [{ id: 'reg-7', expiresAt: new Date(now + 3600_000).toISOString(), usesLeft: 1 }], tasks: [...tasks], calls: [] as Record<string, unknown>[], prs: [] as unknown[], offsets: new Map<string, number>() };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'agents.hosts', label: 'Agent hosts', state: 3, reason: 'Schema present.' }, { id: 'settings.installation-audit', label: 'Audit', state: 3, reason: 'Test.' }, ...(agentsOff ? [{ id: 'settings.feature-policy', label: 'Feature policies', state: 3, reason: 'Test.' }] : [])] });
    if (method === 'GetRepositoryFeatures') return respond(route, GetRepositoryFeaturesResponseSchema, { repositoryId, features: [{ feature: 'agents', label: 'Agent proposals', effective: false, decidedBy: FeatureDecider.REPOSITORY, reason: 'Agent proposals are turned off for this repository by the repository policy.' }, { feature: 'agent-hosts', label: 'Coding agents on your machines', effective: true, decidedBy: FeatureDecider.REPOSITORY, reason: 'On.' }] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    if (method === 'GetIssue') return respond(route, GetIssueResponseSchema, { issue });
    if (method === 'ListIssueComments') return respond(route, ListIssueCommentsResponseSchema, {});
    if (method === 'GetPullRequest') return respond(route, GetPullRequestResponseSchema, { pullRequest: pull });
    if (method === 'GetPullRequestDiscussion') return respond(route, GetPullRequestDiscussionResponseSchema, { issue: { id: '101', number: 7, title: pull.title, state: IssueState.OPEN } });
    if (method === 'ListPullRequests') return respond(route, ListPullRequestsResponseSchema, { pullRequests: [pull], page: {} });
    if (method === 'ListPullRequestReviews') return respond(route, ListPullRequestReviewsResponseSchema, {});
    if (method === 'ResolveRepositorySource') {
      const input = request(route, ResolveRepositorySourceRequestSchema), name = input.selector?.name || '', commits: Record<string, string> = { main, 'feature/cache': prHead, 'golf-agent/1a2b3c4d': head };
      if (!commits[name]) return reject(route, 'not_found', 'No such branch.');
      return respond(route, ResolveRepositorySourceResponseSchema, { repositoryId, repository: key, resolution: RepositorySourceResolution.RESOLVED, selection: { kind: RepositorySourceRefKind.BRANCH, name, commitId: commits[name] } });
    }
    if (method === 'CreatePullRequest') {
      // The agent task panel adds agentTaskId (agentic mode), which the generated request type does not carry.
      const { agentTaskId, ...raw } = route.request().postDataJSON() as Record<string, unknown>;
      const input = fromJson(CreatePullRequestRequestSchema, raw as JsonValue); state.prs.push({ ...input, agentTaskId });
      return respond(route, CreatePullRequestResponseSchema, { pullRequest: { id: '950', number: 13, title: input.title, state: IssueState.OPEN, base: { repositoryId, ref: input.baseBranch, commitId: input.baseCommitId }, head: { repositoryId, ref: input.headBranch, commitId: input.headCommitId } } });
    }
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/repository-access') return json({ role });
    if (path === '/native/agent-hosts') {
      state.calls.push({ path, ...body });
      if (body.action === 'list') return json({ hosts: body.scope === 'personal' ? state.hosts : state.hosts.map(h => ({ ...h, id: `${body.scope}-${h.id}`, scope: body.scope })), tokens: state.tokens, canManage: true });
      if (body.action === 'createToken') { const token = 'golfagentreg_' + 'f'.repeat(64); state.tokens.push({ id: 'reg-8', expiresAt: new Date(now + Number(body.ttlHours) * 3600_000).toISOString(), usesLeft: Number(body.uses) });
        return json({ token, commands: [`GOLF_AGENT_REGISTRATION_TOKEN=${token} golf-agent-host register --origin https://golf.example --name "$(hostname)" --state ~/.golf-agent-host`, 'golf-agent-host run --state ~/.golf-agent-host'] }); }
      if (body.action === 'revokeToken') { state.tokens = state.tokens.filter(t => t.id !== body.id); return json({ ok: true }); }
      if (body.action === 'update') {
        const host = state.hosts.find(h => h.id === body.id)!;
        if (body.expectedVersion !== host.version) return json({ code: 'conflict', message: 'The host changed. Refresh before editing.' }, 409);
        const { action: _a, id: _i, expectedVersion: _e, ...changes } = body; Object.assign(host, changes, { version: host.version + 1 }); return json({ host });
      }
      if (body.action === 'delete') { state.hosts = state.hosts.filter(h => h.id !== body.id); return json({ ok: true }); }
    }
    if (path === '/native/agent-tasks') {
      state.calls.push({ path, ...body });
      const find = () => state.tasks.find(t => t.id === body.id)!;
      if (body.action === 'available') return json(available);
      if (body.action === 'list') { const target = body.target as { kind: string; number: number } | undefined;
        return json({ canAssign: role !== 'read', tasks: state.tasks.filter(t => !target || (t.target as { kind: string; number: number }).kind === target.kind && (t.target as { number: number }).number === target.number) }); }
      if (body.action === 'create') {
        if (refuse) return json({ code: 'failed_precondition', message: 'Refused: mj-laptop does not allow alex/demo (allowed repositories).' }, 412);
        const created = task({ tool: body.tool, host: { id: body.hostId, name: 'mj-laptop' }, model: body.model || '', target: body.target }); state.tasks.unshift(created); return json({ task: created });
      }
      if (body.action === 'get') return json({ task: find() });
      if (body.action === 'cancel' && refuseCancel) return json({ code: 'permission_denied', message: 'Only the requester, repository administrators and the host’s managers can cancel this task.' }, 403);
      if (body.action === 'cancel') { const t = find(); Object.assign(t, { cancelRequested: true }); setTimeout(() => Object.assign(t, { state: 'CANCELLED', failureReason: '', finishedAt: new Date().toISOString() }), 1500); return json({ task: t }); }
      if (body.action === 'log') {
        const t = find(), offset = Number(body.offset);
        if (t.id === failed.id) return json({ lines: offset ? [] : ['$ claude -p', 'Pushed golf-agent/9f8e7d6c'], nextOffset: 2, complete: true, truncated: false });
        // Two lines per poll while running; the task finishes once the host has sent everything.
        if (t.state === 'QUEUED') Object.assign(t, { state: 'RUNNING', startedAt: new Date().toISOString() });
        // An offset past what the Worker stored is answered with 409 and the offset to resync to.
        if (resync && offset === 0 && !state.offsets.get('skewed')) { state.offsets.set('skewed', 1); return json({ lines: log.slice(0, 2), nextOffset: 4, complete: false, truncated: false }); }
        if (resync && offset > Number(t.logLines) + 2) return json({ code: 'conflict', message: 'Offset past the stored log.', nextOffset: 2 }, 409);
        const lines = t.state === 'CANCELLED' ? [] : log.slice(offset, offset + 2), next = offset + lines.length;
        if (finish && next >= log.length && t.state === 'RUNNING') Object.assign(t, succeeded, { finishedAt: new Date().toISOString() });
        Object.assign(t, { logLines: Math.max(Number(t.logLines), next) });
        return json({ lines, nextOffset: next, complete: !['QUEUED', 'CLAIMED', 'RUNNING'].includes(String(t.state)) && next >= Number(t.logLines), truncated: false });
      }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}
const hostsTable = (page: Page) => page.getByRole('table', { name: 'agent hosts' });
const tasksPanel = (page: Page) => page.locator('section.agent-tasks');

test('personal hosts lead with the inventory, and New host shows the exact commands once with the open token listed', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/agents');
  await expect(page.getByRole('heading', { name: 'Agent hosts', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account settings' }).getByRole('link', { name: 'Agent hosts' })).toHaveAttribute('aria-current', 'page');
  const laptop = hostsTable(page).getByRole('row').filter({ hasText: 'mj-laptop' });
  await expect(laptop).toContainText('Online'); await expect(laptop).toContainText('Codex 0.48.0 signed in'); await expect(laptop).toContainText('Claude Code 2.1.3 sign-in unknown');
  await expect(laptop).toContainText('OpenCode 0.15.2 not signed in'); await expect(laptop).toContainText('Only you'); await expect(laptop).toContainText('1 of 2');
  const box = hostsTable(page).getByRole('row').filter({ hasText: 'build-box' });
  await expect(box).toContainText('Offline'); await expect(box).toContainText('Disabled'); await expect(box).toContainText('Shared with 1 user, using your sign-ins');
  await expect(page.getByRole('form', { name: 'New agent host' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'agent host registration tokens' })).toContainText('reg-7');
  await page.getByRole('button', { name: 'New host' }).click();
  const form = page.getByRole('form', { name: 'New agent host' });
  await form.getByLabel('Token lifetime in hours').fill('4'); await form.getByLabel('Hosts this token may register').fill('2');
  await form.getByRole('button', { name: 'Create registration token' }).click();
  const connect = page.getByRole('region', { name: 'Connect the host' });
  await expect(connect).toContainText('golf-agent-host register --origin https://golf.example'); await expect(connect).toContainText('golf-agent-host run --state ~/.golf-agent-host');
  expect(state.calls.find(c => c.action === 'createToken')).toMatchObject({ scope: 'personal', ttlHours: 4, uses: 2 });
  await expect(page.getByRole('table', { name: 'agent host registration tokens' })).toContainText('reg-8');
  await connect.getByRole('button', { name: 'Done' }).click(); await expect(connect).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke token reg-7' }).click();
  await expect(page.getByRole('table', { name: 'agent host registration tokens' })).not.toContainText('reg-7');
  const revoke = state.calls.find(c => c.action === 'revokeToken')!; expect(revoke).toMatchObject({ id: 'reg-7' }); expect(revoke.scope).toBeUndefined();
});

test('editing a host explains shared sign-ins and saves sharing with the version it read; delete asks first', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/agents');
  await hostsTable(page).getByRole('button', { name: 'Edit mj-laptop' }).click();
  const form = page.getByRole('form', { name: 'Edit mj-laptop' });
  await expect(form).toContainText('those tasks run under your own signed-in subscriptions');
  await form.getByLabel('Share sign-ins with allowed users').check();
  await form.getByLabel('Allowed users', { exact: true }).fill('sam, riley');
  await form.getByLabel('Grok').uncheck();
  await form.getByLabel('Tasks at once').fill('3');
  await form.getByRole('button', { name: 'Save host' }).click();
  await expect(form).toHaveCount(0);
  expect(state.calls.find(c => c.action === 'update')).toMatchObject({ id: '1', expectedVersion: 3, shareSignins: true, allowedUsers: ['sam', 'riley'], allowedRepositories: [], enabledTools: ['codex', 'claude', 'opencode'], maxConcurrent: 3, name: 'mj-laptop', state: 'ACTIVE' });
  await expect(hostsTable(page).getByRole('row').filter({ hasText: 'mj-laptop' })).toContainText('Shared with 2 users, using your sign-ins');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Delete agent host build-box?'); void dialog.accept(); });
  await hostsTable(page).getByRole('button', { name: 'Delete build-box' }).click();
  await expect(hostsTable(page)).not.toContainText('build-box');
  expect(state.calls.find(c => c.action === 'delete')).toMatchObject({ id: '2' });
});

test('organization settings and the admin page use the same inventory at their own scope', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/organizations/acme/settings');
  await page.getByRole('navigation', { name: 'Organization settings' }).getByRole('link', { name: 'Agent hosts' }).click();
  await expect(page).toHaveURL(/\/organizations\/acme\/settings\/agents$/);
  await expect(hostsTable(page)).toContainText('mj-laptop');
  expect(state.calls.find(c => c.action === 'list' && c.scope === 'organization')).toMatchObject({ organization: 'acme' });
  await hostsTable(page).getByRole('button', { name: 'Edit mj-laptop' }).click();
  await expect(page.getByRole('form', { name: 'Edit mj-laptop' })).toContainText('run under the signed-in subscriptions of the host’s owner');
  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { name: 'Agent hosts', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Agent hosts' })).toHaveAttribute('aria-current', 'page');
  await expect(hostsTable(page)).toContainText('Installation');
  expect(state.calls.some(c => c.action === 'list' && c.scope === 'installation')).toBe(true);
});

test('assigning an issue shows unusable tools disabled with their reason, streams the live log to a proposal and opens the pull request', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/issues/12');
  await expect(page.getByRole('heading', { name: 'Retry webhook deliveries with backoff #12' })).toBeVisible();
  await expect(tasksPanel(page).getByRole('table', { name: 'agent tasks' })).toContainText('Claude Code on mj-laptop');
  await tasksPanel(page).getByRole('button', { name: 'Assign to agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign to agent' });
  await expect(dialog.getByRole('radio', { name: /Codex/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /Claude Code/ })).toBeEnabled();
  await expect(dialog.getByText('2.1.3 · sign-in unknown')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /OpenCode/ })).toBeDisabled();
  await expect(dialog.getByText('OpenCode is not signed in on this host.')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Grok/ })).toBeDisabled();
  await expect(dialog.getByText('only the person who registered it may run tools')).toBeVisible();
  await dialog.getByLabel('Instructions').fill('Keep the public API unchanged.');
  // The prompt bound and what it cuts first (agent-hosts.mjs buildPrompt).
  await expect(dialog.getByText('in a prompt of at most 32 KiB. When they do not fit, Golf shortens the description first, then leaves out the oldest of those comments')).toBeVisible();
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const create = state.calls.find(c => c.action === 'create')!;
  expect(create).toMatchObject({ repository: key, repositoryId, target: { kind: 'issue', number: 12 }, hostId: '1', tool: 'codex', instructions: 'Keep the public API unchanged.' });
  expect(String(create.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
  const detail = page.getByRole('region', { name: `Agent task ${taskId}` });
  const logView = detail.getByRole('log', { name: 'Agent task log' });
  await expect(logView).toContainText('Reading src/webhooks/deliver.ts');
  await expect(logView).toContainText('Committed 3 files');
  // Stored lines are scrubbed (agent-hosts.mjs scrub), and the footnote says so.
  await expect(detail).toContainText('Golf stores each line with NUL bytes removed and anything shaped like a Golf credential');
  await expect(detail).not.toContainText('does not filter');
  await expect(detail).toContainText('Proposal ready');
  await expect(detail).toContainText('3 changed files');
  await expect(detail.getByLabel('Reported summary, rendered Markdown')).toContainText('Retries failed deliveries up to 5 times');
  await expect(detail).toContainText('Usage as reported by Codex: 48,210 input tokens · 3,120 output tokens · $0.41');
  // The log stops polling once the task is finished and the log complete.
  const logReads = () => state.calls.filter(c => c.action === 'log' && c.id === taskId).length, settled = logReads();
  await page.waitForTimeout(2000); expect(logReads()).toBeLessThanOrEqual(settled + 1);
  await detail.getByRole('button', { name: 'Open pull request' }).click();
  const form = detail.getByRole('form', { name: 'Open pull request' });
  await expect(form.getByLabel('Pull request title')).toHaveValue('Retry webhook deliveries with backoff');
  await form.getByRole('button', { name: 'Create pull request' }).click();
  await expect(detail.getByRole('link', { name: '#13' })).toHaveAttribute('href', '/alex/demo/pull/13');
  expect(state.prs[0]).toMatchObject({ baseBranch: 'main', headBranch: 'golf-agent/1a2b3c4d', baseCommitId: main, headCommitId: head, repositoryId, sourceRepositoryId: repositoryId, agentTaskId: taskId });
});

test('a failed task shows why, and a refused assignment shows the server’s reason', async ({ page }) => {
  const refusedAtClaim = task({ id: '8192a3b4-0000-4000-8000-000000000008', state: 'FAILED', tool: 'grok', failureReason: 'refused_tool_signed_out', createdAt: at(200), finishedAt: at(199) });
  await backend(page, { refuse: true, tasks: [failed, refusedAtClaim] });
  await page.goto('/alex/demo/issues/12');
  await tasksPanel(page).getByRole('button', { name: 'Claude Code on mj-laptop' }).click();
  const detail = page.getByRole('region', { name: `Agent task ${failed.id}` });
  await expect(detail.getByRole('alert')).toContainText('could not verify on the task branch');
  await expect(detail.getByRole('log', { name: 'Agent task log' })).toContainText('Pushed golf-agent/9f8e7d6c');
  await expect(detail.getByRole('button', { name: 'Open pull request' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
  await tasksPanel(page).getByRole('button', { name: 'Grok on mj-laptop' }).click();
  await expect(page.getByRole('region', { name: `Agent task ${refusedAtClaim.id}` }).getByRole('alert')).toHaveText('Refused when the host claimed it: the tool is not signed in on the host.');
  await tasksPanel(page).getByRole('button', { name: 'Assign to agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign to agent' });
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Refused: mj-laptop does not allow alex/demo (allowed repositories).');
});

test('a running pull request task can be cancelled, and its proposal targets the pull request’s head branch', async ({ page }) => {
  const running = task({ id: '2b3c4d5e-0000-4000-8000-000000000002', state: 'RUNNING', startedAt: at(2), target: { kind: 'pull_request', number: 7 }, baseRef: 'refs/heads/feature/cache', baseCommit: prHead, branch: 'golf-agent/2b3c4d5e' });
  const state = await backend(page, { finish: false, tasks: [running] });
  await page.goto('/alex/demo/pull/7');
  await tasksPanel(page).getByRole('button', { name: 'Codex on mj-laptop' }).click();
  const detail = page.getByRole('region', { name: `Agent task ${running.id}` });
  await expect(detail.getByRole('log', { name: 'Agent task log' })).toContainText('Reading src/webhooks/deliver.ts');
  await expect(detail).toContainText('from feature/cache');
  await detail.getByRole('button', { name: 'Cancel task' }).click();
  await expect(detail).toContainText('Cancellation requested');
  expect(state.calls.find(c => c.action === 'cancel')).toMatchObject({ id: running.id, repositoryId });
  await expect(detail).toContainText('The task was cancelled. Nothing was proposed.');
  await expect(detail.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
});

test('the Agent workspace tab lists the repository’s agent tasks with links to their issue or pull request', async ({ page }) => {
  await backend(page, { tasks: [failed, task({ id: '3c4d5e6f-0000-4000-8000-000000000003', ...succeeded, target: { kind: 'pull_request', number: 7 }, branch: 'golf-agent/3c4d5e6f' })] });
  await page.goto('/alex/demo/agents');
  const panel = page.locator('section.agent-tasks');
  await expect(panel.getByRole('heading', { name: 'Agent tasks in this repository' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Pull request #7' })).toHaveAttribute('href', '/alex/demo/pull/7');
  await expect(panel.getByRole('link', { name: 'Issue #12' })).toHaveAttribute('href', '/alex/demo/issues/12');
  await expect(panel.getByRole('button', { name: 'Assign to agent' })).toHaveCount(0);
});

test('readers see existing tasks but cannot assign or cancel', async ({ page }) => {
  await backend(page, { role: 'read' });
  await page.goto('/alex/demo/issues/12');
  await expect(tasksPanel(page).getByRole('table', { name: 'agent tasks' })).toBeVisible();
  await expect(tasksPanel(page).getByRole('button', { name: 'Assign to agent' })).toHaveCount(0);
});

test('a refused cancel shows the server’s reason', async ({ page }) => {
  const running = task({ id: '4d5e6f70-0000-4000-8000-000000000004', state: 'RUNNING', startedAt: at(2), requestedBy: { id: '99', login: 'riley' } });
  await backend(page, { finish: false, tasks: [running], refuseCancel: true });
  await page.goto('/alex/demo/issues/12');
  await tasksPanel(page).getByRole('button', { name: 'Codex on mj-laptop' }).click();
  const detail = page.getByRole('region', { name: `Agent task ${running.id}` });
  await detail.getByRole('button', { name: 'Cancel task' }).click();
  await expect(detail.getByRole('alert')).toContainText('Only the requester, repository administrators and the host’s managers can cancel this task.');
});

test('writers who did not request a task are not offered Cancel; the requester is', async ({ page }) => {
  const other = task({ id: '5e6f7081-0000-4000-8000-000000000005', state: 'RUNNING', startedAt: at(2), requestedBy: { id: '99', login: 'riley' } });
  const own = task({ id: '6f708192-0000-4000-8000-000000000006', state: 'RUNNING', startedAt: at(2), tool: 'claude' });
  await backend(page, { finish: false, role: 'write', tasks: [other, own] });
  await page.goto('/alex/demo/issues/12');
  await tasksPanel(page).getByRole('button', { name: 'Codex on mj-laptop' }).click();
  await expect(page.getByRole('region', { name: `Agent task ${other.id}` }).getByRole('log')).toContainText('Reading src');
  await expect(page.getByRole('region', { name: `Agent task ${other.id}` }).getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
  await tasksPanel(page).getByRole('button', { name: 'Claude Code on mj-laptop' }).click();
  await expect(page.getByRole('region', { name: `Agent task ${own.id}` }).getByRole('button', { name: 'Cancel task' })).toBeVisible();
});

test('a log offset past the stored lines resyncs to the offset the Worker returns without repeating lines', async ({ page }) => {
  const running = task({ id: '708192a3-0000-4000-8000-000000000007', state: 'RUNNING', startedAt: at(2) });
  await backend(page, { tasks: [running], resync: true });
  await page.goto('/alex/demo/issues/12');
  await tasksPanel(page).getByRole('button', { name: 'Codex on mj-laptop' }).click();
  const logView = page.getByRole('region', { name: `Agent task ${running.id}` }).getByRole('log', { name: 'Agent task log' });
  await expect(logView).toContainText('Committed 3 files', { timeout: 15_000 });
  await expect(logView.getByRole('listitem')).toHaveCount(log.length);
  await expect(page.getByRole('region', { name: `Agent task ${running.id}` }).getByRole('alert')).toHaveCount(0);
});

test('the Agent workspace tab stays when agent proposals are off but agent hosts are on', async ({ page }) => {
  await backend(page, { agentsOff: true });
  await page.goto('/alex/demo/issues/12');
  await page.getByRole('link', { name: 'Agent workspace' }).click();
  await expect(page).toHaveURL(/\/alex\/demo\/agents$/);
  await expect(page.getByRole('heading', { name: 'Agent tasks in this repository' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /turned off/ })).toHaveCount(0);
});

const directory = process.env.GOLF_AGENT_SHOTS;
const looks = [['dark', 'flare', 'console', 'dark', 1440, 900], ['light', 'classic', 'primer', 'light', 1440, 900], ['dark-390', 'flare', 'console', 'dark', 390, 844], ['light-390', 'classic', 'primer', 'light', 390, 844]] as const;
for (const [look, appearance, layout, theme, width, height] of looks) test(`agent hosts screenshots in ${look}`, async ({ page }) => {
  test.skip(!directory, 'Set GOLF_AGENT_SHOTS to write review screenshots.');
  test.setTimeout(180_000);
  await mkdir(directory!, { recursive: true });
  await page.setViewportSize({ width, height });
  await page.addInitScript(([a, l, t]: [string, string, string]) => { localStorage.setItem('golf.appearance', a); localStorage.setItem('golf.layout.' + a, l); localStorage.setItem('golf.theme', t); }, [appearance, layout, theme] as [string, string, string]);
  await backend(page);
  const shot = async (name: string, full = true) => {
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${directory}/${look}-${name}.png`, fullPage: full, animations: 'disabled' });
  };
  await page.goto('/account/agents');
  await expect(hostsTable(page)).toContainText('mj-laptop');
  await shot('hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  await page.getByRole('form', { name: 'New agent host' }).getByRole('button', { name: 'Create registration token' }).click();
  await expect(page.getByRole('region', { name: 'Connect the host' })).toBeVisible();
  await shot('new-host');
  await page.getByRole('button', { name: 'Done' }).click();
  await hostsTable(page).getByRole('button', { name: 'Edit mj-laptop' }).click();
  await page.getByRole('form', { name: 'Edit mj-laptop' }).scrollIntoViewIfNeeded();
  await shot('edit-host');
  await page.goto('/alex/demo/issues/12');
  await tasksPanel(page).getByRole('button', { name: 'Assign to agent' }).click();
  await expect(page.getByRole('dialog', { name: 'Assign to agent' }).getByRole('radio', { name: /Codex/ })).toBeChecked();
  await shot('assign-dialog', false);
  await page.getByRole('dialog', { name: 'Assign to agent' }).getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByRole('region', { name: `Agent task ${taskId}` })).toContainText('Proposal ready', { timeout: 20_000 });
  await shot('task-succeeded');
  await tasksPanel(page).getByRole('button', { name: 'Claude Code on mj-laptop' }).click();
  await expect(page.getByRole('region', { name: `Agent task ${failed.id}` }).getByRole('log')).toContainText('Pushed golf-agent/9f8e7d6c');
  await shot('task-failed');
  await page.goto('/alex/demo/agents');
  await expect(page.getByRole('heading', { name: 'Agent tasks in this repository' })).toBeVisible();
  await shot('repository-tab');
});
