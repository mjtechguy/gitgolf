import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetRepositoryResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// Automations on the Cloudflare-native runtime (docs/AUTOMATIONS.md): repository, organization and installation settings against mocked
// /native/automations and /native/automations/read shaped like the Worker's API. Run output is untrusted and must stay plain text.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const key = { owner: 'alex', name: 'demo' }, repositoryId = '41';
const repository = { id: repositoryId, name: 'demo', fullName: 'alex/demo', defaultBranch: 'main', private: true, issuesEnabled: true, pullRequestsEnabled: true, cloneUrl: 'https://golf.example/alex/demo.git', updatedAt: at(600) };
const limits = (perDay: number, concurrency: number, maxOpenPRs: number) => ({ perDay, concurrency, maxOpenPRs, dedupeWindow: 0 });
const tools = [
  { id: 'pr-reviewer', label: 'PR reviewer', description: 'Reviews pull requests when they open or change.', engines: 'model', schedule: true, events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested'],
    outputs: ['review', 'comment'], opensPullRequests: false, defaults: { name: 'PR reviewer', events: ['pull_request.opened', 'pull_request.updated'], output: ['review'], limits: limits(50, 2, 0), instructions: '' } },
  { id: 'issue-triage', label: 'Issue triage', description: 'Triages new issues.', engines: 'model', schedule: true, events: ['issue.opened'], outputs: ['labels', 'comment'], opensPullRequests: false,
    defaults: { name: 'Issue triage', events: ['issue.opened'], output: ['comment'], limits: limits(100, 2, 0), instructions: '' } },
  { id: 'issue-to-pr', label: 'Issue → PR', description: 'Turns new issues into draft pull requests on your agent host.', engines: 'cli', schedule: false, events: ['issue.opened'], outputs: ['draft-pr', 'comment'], opensPullRequests: true,
    defaults: { name: 'Issue → PR', events: ['issue.opened'], output: ['draft-pr'], limits: limits(10, 1, 3), instructions: '' } },
  { id: 'ci-fixer', label: 'CI fixer', description: 'Proposes a fix when an Actions run fails.', engines: 'cli', schedule: false, events: ['pipeline.failed'], outputs: ['draft-pr', 'issue', 'comment'], opensPullRequests: true,
    defaults: { name: 'CI fixer', events: ['pipeline.failed'], output: ['draft-pr', 'issue'], limits: limits(10, 1, 3), instructions: '' } },
  { id: 'custom', label: 'Custom automation', description: 'Your own instructions on the events you choose.', engines: 'any', schedule: true,
    events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested', 'issue.opened', 'pipeline.failed', 'push'], outputs: ['comment', 'issue', 'report', 'draft-pr'], opensPullRequests: true,
    defaults: { name: 'Custom automation', events: [], output: ['report'], limits: limits(20, 1, 3), instructions: '' } },
];
const engines = [{ id: 'default', kind: 'model', label: 'Installation model selection (Workers AI)', detail: 'Runs the model chosen for this use in AI model selection.' },
  { id: 'codex', kind: 'cli', label: 'Codex', detail: 'A coding CLI on an agent host you choose.' }, { id: 'claude', kind: 'cli', label: 'Claude Code', detail: 'A coding CLI on an agent host you choose.' }];
const places = { 'agent-host': '', cloud: 'Coding CLIs in cloud sandboxes arrive in phase 3 of the agents plan; choose an agent host.', 'ssh-host': 'SSH hosts are not available on this installation yet; choose an agent host.' };
type Automation = Record<string, unknown> & { id: string; name: string; version: number; enabled: boolean; killSwitch: boolean };
const automation = (extra: Partial<Automation> & Record<string, unknown> = {}): Automation => ({ id: '0b6f3f5e-1111-4aaa-8bbb-000000000001', scope: 'repository', scopeId: repositoryId, scopeName: 'alex/demo',
  tool: 'pr-reviewer', toolLabel: 'PR reviewer', name: 'PR reviewer', enabled: false, killSwitch: false, trigger: { events: ['pull_request.opened', 'pull_request.updated'] },
  target: { repositories: [], branches: ['main'], paths: [] }, engine: 'default', place: 'cloud', hostId: '', hostName: '', output: ['review'], limits: limits(50, 2, 0),
  approvals: { draftOnly: true, allowLanding: false }, instructionsVersion: 2, version: 4, owner: { id: '17', login: 'alex' }, createdBy: 'alex', updatedBy: 'alex', createdAt: at(3000), updatedAt: at(60), nextRunAt: '',
  stats: { today: 3, running: 0, queued: 1, last: { state: 'FAILED', reason: 'The model returned no text.', at: at(5) } }, ...extra });
const inherited = automation({ id: '0b6f3f5e-1111-4aaa-8bbb-000000000009', scope: 'organization', scopeId: '81', scopeName: 'acme', tool: 'issue-triage', toolLabel: 'Issue triage', name: 'Org triage', enabled: true,
  trigger: { events: ['issue.opened'] }, output: ['comment'], owner: { id: '50', login: 'riley' }, stats: { today: 0, running: 0, queued: 0, last: null } });
const runs = [
  { id: 'r1', automationId: automation().id, automationName: 'PR reviewer', tool: 'pr-reviewer', repository: 'alex/demo', trigger: 'pull_request.opened', target: { kind: 'pull_request', number: 7, commit: 'd'.repeat(40), url: 'https://golf.example/alex/demo/pull/7' },
    state: 'SUCCEEDED', phase: 'DONE', reason: 'Review draft saved for its owner.', engine: 'default', place: 'cloud', instructionsVersion: 2, requestedBy: '', usage: { inputTokens: 1200, outputTokens: 300, reported: true },
    outputs: { aiRunId: 'ai-1', review: { summary: 'Looks fine **mostly**.', findings: [{ path: 'src/a.ts', line: 3, severity: 'warning', title: 'Unchecked error', evidence: '<img src=x onerror="window.__pwned=2">', suggestion: 'Handle it.' }],
      markdown: '## Review\n[click me](javascript:window.__pwned=3)' } }, createdAt: at(30), startedAt: at(29), finishedAt: at(28) },
  { id: 'r2', automationId: 'c-1', automationName: 'Nightly report', tool: 'custom', repository: 'alex/demo', trigger: 'schedule', target: { kind: 'repository', number: null, commit: '', url: '' },
    state: 'SUCCEEDED', phase: 'DONE', reason: 'Report kept on the run.', engine: 'default', place: 'cloud', instructionsVersion: 1, requestedBy: '', usage: null,
    outputs: { report: '<script>window.__pwned = 1</script>\n[docs](https://evil.example)' }, createdAt: at(20), startedAt: at(20), finishedAt: at(19) },
  { id: 'r3', automationId: 'c-2', automationName: 'Issue → PR', tool: 'issue-to-pr', repository: 'alex/demo', trigger: 'manual', target: { kind: 'issue', number: 12, commit: '', url: '' },
    state: 'SUCCEEDED', phase: 'DONE', reason: 'Opened draft pull request #13.', engine: 'codex', place: 'agent-host', instructionsVersion: 1, requestedBy: 'alex', usage: { reported: false },
    outputs: { agentTaskId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', pullNumber: 13, pullUrl: 'https://golf.example/alex/demo/pull/13' }, createdAt: at(10), startedAt: at(10), finishedAt: at(2) },
  { id: 'r4', automationId: automation().id, automationName: 'PR reviewer', tool: 'pr-reviewer', repository: 'alex/demo', trigger: 'pull_request.updated', target: { kind: 'pull_request', number: 8, commit: 'e'.repeat(40), url: '' },
    state: 'REFUSED', phase: 'DONE', reason: 'The kill switch was engaged.', engine: 'default', place: 'cloud', instructionsVersion: 2, requestedBy: '', usage: null, outputs: {}, createdAt: at(1), startedAt: '', finishedAt: at(1) },
];

async function backend(page: Page, { capability = true, canManage = true, featureOn = true, list = [automation()] as Automation[], inheritedTruncated = false } = {}) {
  const state = { automations: list.map(a => ({ ...a })), runs: [...runs] as Record<string, unknown>[], calls: [] as Record<string, unknown>[] };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.repository-general', label: 'General', state: 3, reason: 'Test.' },
      { id: 'repository.agentic-mode', label: 'Agentic mode', state: 3, reason: 'Schema 41.' }, { id: 'automations', label: 'Automations', state: capability ? 3 : 1, reason: capability ? 'Schema 46.' : 'Apply the schema 46 migration to use automations.' }] });
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, { repositories: [repository] });
    if (method === 'GetRepository') return respond(route, GetRepositoryResponseSchema, { repository });
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/repository-access') return json({ role: canManage ? 'admin' : 'write' });
    if (path === '/native/automations/read' || path === '/native/automations') {
      state.calls.push({ path, ...body });
      const find = () => state.automations.find(a => a.id === body.id)!;
      const scopeName = body.scope === 'repository' ? 'alex/demo' : body.scope === 'organization' ? String(body.organization) : '';
      if (body.action === 'list') return json({ scope: { scope: body.scope, scopeId: body.scope === 'repository' ? repositoryId : body.scope === 'organization' ? '81' : '', name: scopeName }, canManage, featureOn,
        featureReason: featureOn ? '' : 'Automations are turned off for this repository by the organization policy.', automations: state.automations.map(a => ({ ...a, scope: body.scope, scopeName })),
        inherited: body.scope === 'repository' ? [inherited] : [], inheritedTruncated, tools, engines, enginesRegistered: false, hosts: canManage ? [{ id: '5', name: 'mj-laptop', scope: 'personal' }, { id: '6', name: 'team-runner', scope: 'organization' }] : [], places });
      if (body.action === 'runs') return json({ runs: state.runs, truncated: false });
      if (body.action === 'get') return json({ automation: { ...find(), instructions: 'Focus on security.' }, instructionVersions: [{ version: 2, createdBy: 'alex', createdAt: at(60), current: true }, { version: 1, createdBy: 'sam', createdAt: at(3000), current: false }] });
      if (body.action === 'instructions') return json({ version: body.version, text: body.version === 1 ? 'Be brief.\n<b>Only</b> blockers.' : 'Focus on security.', createdBy: body.version === 1 ? 'sam' : 'alex', createdAt: at(3000), current: body.version === 2 });
      if (body.action === 'create') { const created = automation({ id: '0b6f3f5e-1111-4aaa-8bbb-000000000002', tool: body.tool, toolLabel: tools.find(t => t.id === body.tool)!.label, name: String(body.name), version: 1, stats: { today: 0, running: 0, queued: 0, last: null } });
        state.automations.push(created); return json({ automation: created }); }
      if (body.action === 'update') { const a = find(); if (body.expectedVersion !== a.version) return json({ code: 'failed_precondition', message: 'The automation changed; refresh before saving.' }, 412);
        Object.assign(a, { name: body.name, version: a.version + 1, instructionsVersion: 3 }); return json({ automation: a }); }
      if (body.action === 'setEnabled') { const a = find(); Object.assign(a, { enabled: body.enabled, version: a.version + 1 }); return json({ automation: a }); }
      if (body.action === 'killSwitch') { const a = find(); Object.assign(a, { killSwitch: body.engaged, version: a.version + 1 }); return json({ automation: a }); }
      if (body.action === 'delete') { state.automations = state.automations.filter(a => a.id !== body.id); return json({ ok: true }); }
      if (body.action === 'run') { const run = { ...runs[0], id: 'r9', state: 'QUEUED', reason: '', trigger: 'manual', requestedBy: 'alex', outputs: {}, usage: null, createdAt: at(0), startedAt: '', finishedAt: '' };
        state.runs.unshift(run); return json({ run }); }
    }
    return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
  });
  return state;
}
const inventory = (page: Page) => page.getByRole('table', { name: 'automations', exact: true });
const runsTable = (page: Page) => page.getByRole('table', { name: 'automation runs', exact: true });
const writes = (state: { calls: Record<string, unknown>[] }) => state.calls.filter(call => call.path === '/native/automations');

test('repository Settings → Automations leads with the inventory, inherited automations and recent runs', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  await expect(page.getByRole('heading', { level: 1, name: 'Automations' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Repository settings' }).getByRole('link', { name: 'Automations' })).toHaveAttribute('aria-current', 'page');
  const row = inventory(page).getByRole('row').filter({ hasText: 'PR reviewer' });
  await expect(row).toContainText('Pull request opened, Pull request updated');
  await expect(row).toContainText('Branches: main');
  await expect(row).toContainText('Installation model selection (Workers AI)');
  await expect(row).toContainText('Private review draft');
  await expect(row).toContainText('alex');
  await expect(row).toContainText('3 of 50');
  await expect(row).toContainText('Failed');
  await expect(row).toContainText('The model returned no text.');
  await expect(row.getByRole('switch', { name: 'Automatic runs for PR reviewer' })).not.toBeChecked();
  await expect(page.getByText('Search and sorting cover all reported entries.').first()).toBeVisible();
  // Nothing opens until asked.
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'inherited automations', exact: true })).toContainText('Organization acme');
  await expect(page.getByRole('table', { name: 'inherited automations', exact: true }).locator('tbody').getByRole('button')).toHaveCount(0);
  await expect(page.getByText('others that reach this repository are not shown')).toHaveCount(0);
  await expect(runsTable(page)).toContainText('The kill switch was engaged.');
  await expect(runsTable(page).getByRole('row').filter({ hasText: 'Review draft saved' })).toContainText('1,200 in · 300 out');
  await expect(runsTable(page).getByRole('row').filter({ hasText: 'Nightly report' })).toContainText('Not reported');
  await expect(runsTable(page).getByRole('row').filter({ hasText: 'Opened draft pull request #13.' })).toContainText('Not reported');
  await expect(runsTable(page).getByRole('row').filter({ hasText: 'The kill switch was engaged.' })).toContainText('Refused');
  await expect(page.getByText('The 50 most recent runs on this repository are loaded')).toBeVisible();
  expect(state.calls.find(call => call.action === 'list')).toEqual({ path: '/native/automations/read', action: 'list', scope: 'repository', repository: key, repositoryId });
  expect(writes(state)).toEqual([]);
});

test('a full page of inherited automations says the others that reach this repository are not shown', async ({ page }) => {
  await backend(page, { inheritedTruncated: true });
  await page.goto('/alex/demo/settings/automations');
  await expect(page.getByRole('table', { name: 'inherited automations', exact: true })).toContainText('Organization acme');
  await expect(page.getByText('Only the first 1 by scope and name are listed; others that reach this repository are not shown.')).toBeVisible();
});

test('New automation copies a built-in tool: the form is prefilled from its defaults and creates with the expected body', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await expect(page.getByRole('radio')).toHaveCount(5);
  await page.getByRole('radio', { name: /^Issue → PR/ }).check();
  const form = page.getByRole('form', { name: 'New Issue → PR automation' });
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Issue → PR');
  await expect(form.getByRole('checkbox', { name: /^Issue opened/ })).toBeChecked();
  await expect(form.getByRole('combobox', { name: /^Engine/ })).toHaveValue('codex');
  await expect(form.getByRole('combobox', { name: /^Engine/ }).locator('option')).toHaveText(['Codex', 'Claude Code']);
  await expect(form.getByRole('radio', { name: /^Cloud/ })).toBeDisabled();
  await expect(form.getByRole('radio', { name: /^Cloud/ })).toHaveAccessibleName(/cloud sandboxes arrive in phase 3/);
  await expect(form.getByRole('radio', { name: /^SSH host/ })).toBeDisabled();
  await expect(form.getByRole('combobox', { name: /^Agent host/ })).toHaveValue('5');
  // Repository scope targets itself: no repository list.
  await expect(form.getByLabel('Repositories', { exact: true })).toHaveCount(0);
  await form.getByLabel('Paths', { exact: true }).fill('src/**\n\n docs/** ');
  await form.getByRole('combobox', { name: /^Agent host/ }).selectOption('6');
  await expect(form.getByLabel('Open draft pull requests at most')).toHaveValue('3');
  await form.getByRole('checkbox', { name: /Let agentic mode decide/ }).check();
  await form.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('status')).toContainText('Issue → PR was created. It is off');
  await expect(form).toHaveCount(0);
  expect(writes(state)).toEqual([{ path: '/native/automations', action: 'create', scope: 'repository', repository: key, repositoryId, tool: 'issue-to-pr', name: 'Issue → PR',
    trigger: { events: ['issue.opened'] }, target: { branches: [], paths: ['src/**', 'docs/**'] }, engine: 'codex', place: 'agent-host', hostId: '6', instructions: '', output: ['draft-pr'],
    limits: { perDay: 10, concurrency: 1, maxOpenPRs: 3, dedupeWindow: 0 }, approvals: { allowLanding: true } }]);
});

test('a scheduled built-in sends its schedule; Cancel closes the form without a request', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByRole('radio', { name: /^PR reviewer/ }).check();
  let form = page.getByRole('form', { name: 'New PR reviewer automation' });
  await expect(form.getByRole('combobox', { name: /^Engine/ }).locator('option')).toHaveText(['Installation model selection (Workers AI)']);
  await expect(form.getByText('Model engines run in the cloud')).toBeVisible();
  await expect(form.getByRole('checkbox', { name: /^Let agentic mode decide/ })).toHaveCount(0);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByRole('radio', { name: /^PR reviewer/ }).check();
  form = page.getByRole('form', { name: 'New PR reviewer automation' });
  await form.getByRole('checkbox', { name: /^Review requested/ }).check();
  await form.getByRole('checkbox', { name: 'Also run on a schedule' }).check();
  await form.getByLabel('Every (minutes)').fill('60');
  await form.getByRole('checkbox', { name: /^Comment/ }).check();
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Flag missing tests.');
  await form.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('status')).toContainText('PR reviewer was created');
  expect(writes(state)).toEqual([expect.objectContaining({ action: 'create', tool: 'pr-reviewer', trigger: { events: ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested'], schedule: { everyMinutes: 60 } },
    engine: 'default', place: 'cloud', hostId: '', output: ['review', 'comment'], instructions: 'Flag missing tests.', approvals: { allowLanding: false } })]);
});

test('the enable toggle, the kill switch and delete send their actions', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  const row = () => inventory(page).getByRole('row').filter({ hasText: 'PR reviewer' });
  await row().getByRole('switch', { name: 'Automatic runs for PR reviewer' }).check();
  await expect(page.getByRole('status')).toContainText('PR reviewer is on. It now acts as you.');
  await expect(row()).toContainText('On');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('emergency stop'); void dialog.accept(); });
  await row().getByRole('button', { name: 'Engage the kill switch of PR reviewer' }).click();
  await expect(row()).toContainText('Kill switch engaged');
  await expect(row().getByRole('button', { name: 'Run PR reviewer now' })).toBeDisabled();
  await row().getByRole('button', { name: 'Release the kill switch of PR reviewer' }).click();
  await expect(row().getByRole('button', { name: 'Engage the kill switch of PR reviewer' })).toBeVisible();
  page.once('dialog', dialog => void dialog.dismiss());
  await row().getByRole('button', { name: 'Delete PR reviewer' }).click();
  page.once('dialog', dialog => void dialog.accept());
  await row().getByRole('button', { name: 'Delete PR reviewer' }).click();
  await expect(inventory(page)).toContainText('No automations here yet');
  const id = automation().id;
  expect(writes(state).map(({ path: _p, scope: _s, repository: _r, repositoryId: _i, ...call }) => call)).toEqual([
    { action: 'setEnabled', id, expectedVersion: 4, enabled: true }, { action: 'killSwitch', id, engaged: true }, { action: 'killSwitch', id, engaged: false }, { action: 'delete', id }]);
});

test('Edit opens the saved definition with its instruction history; an older version can be viewed and reused', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  await inventory(page).getByRole('button', { name: 'Edit PR reviewer' }).click();
  const form = page.getByRole('form', { name: 'Edit PR reviewer' });
  await expect(form.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Focus on security.');
  await expect(form.getByRole('textbox', { name: 'Branches', exact: true })).toHaveValue('main');
  await expect(form).toContainText('Saving makes you the person this automation acts as (now alex)');
  await form.getByText('Instruction history (2 versions)').click();
  const versions = form.getByRole('table', { name: 'instruction versions', exact: true });
  await expect(versions).toContainText('Version 2 · current');
  await expect(versions).toContainText('sam');
  await versions.getByRole('button', { name: 'View version 1' }).click();
  const old = form.getByRole('group', { name: 'Instructions version 1' });
  await expect(old).toContainText('Be brief.\n<b>Only</b> blockers.');
  await old.getByRole('button', { name: 'Use this version' }).click();
  await expect(form.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Be brief.\n<b>Only</b> blockers.');
  await form.getByRole('button', { name: 'Save automation' }).click();
  await expect(page.getByRole('status')).toContainText('PR reviewer was saved');
  expect(state.calls.find(call => call.action === 'instructions')).toMatchObject({ id: automation().id, version: 1 });
  expect(writes(state)).toEqual([{ path: '/native/automations', action: 'update', scope: 'repository', repository: key, repositoryId, id: automation().id, expectedVersion: 4, name: 'PR reviewer',
    trigger: { events: ['pull_request.opened', 'pull_request.updated'] }, target: { branches: ['main'], paths: [] }, engine: 'default', place: 'cloud', hostId: '',
    instructions: 'Be brief.\n<b>Only</b> blockers.', output: ['review'], limits: limits(50, 2, 0), approvals: { allowLanding: false } }]);
});

test('Run now asks for the target and queues one run', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/alex/demo/settings/automations');
  await inventory(page).getByRole('button', { name: 'Run PR reviewer now' }).click();
  const form = page.getByRole('form', { name: 'Run PR reviewer now' });
  await expect(form.getByRole('combobox', { name: /^Run on/ }).locator('option')).toHaveText(['Pull request', 'The repository (open work)']);
  await form.getByLabel('Pull request number').fill('7');
  await form.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('status')).toContainText('PR reviewer was queued on alex/demo');
  await expect(runsTable(page).getByRole('row').filter({ hasText: 'Queued' })).toContainText('by alex');
  expect(writes(state)).toEqual([{ path: '/native/automations', action: 'run', scope: 'repository', repository: key, repositoryId, id: automation().id, target: { kind: 'pull_request', number: 7 } }]);
});

test('run output is automated and unverified, and shown as plain text only', async ({ page }) => {
  await backend(page);
  await page.goto('/alex/demo/settings/automations');
  const report = runsTable(page).getByRole('row').filter({ hasText: 'Nightly report' });
  await report.getByText('Details').click();
  await expect(report.getByText('Automated, unverified')).toBeVisible();
  await expect(report.getByRole('group', { name: 'Output of Nightly report' })).toContainText('<script>window.__pwned = 1</script>\n[docs](https://evil.example)');
  await expect(report.getByRole('link')).toHaveCount(0);
  const review = runsTable(page).getByRole('row').filter({ hasText: 'Review draft saved' });
  await review.getByText('Details').click();
  await expect(review).toContainText('Looks fine **mostly**.');
  await expect(review).toContainText('warning: Unchecked error');
  await expect(review).toContainText('<img src=x onerror="window.__pwned=2">');
  await review.getByText('Review text (shown as plain text)').click();
  await expect(review).toContainText('## Review\n[click me](javascript:window.__pwned=3)');
  await expect(review.getByRole('link', { name: 'click me' })).toHaveCount(0);
  await expect(page.locator('main img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // References become links Golf builds itself, never ones taken from the text.
  const opened = runsTable(page).getByRole('row').filter({ hasText: 'Opened draft pull request #13.' });
  await expect(opened.getByRole('link', { name: '#13' })).toHaveAttribute('href', /\/alex\/demo\/pull/);
  await expect(opened.getByRole('link', { name: 'Issue #12' })).toHaveAttribute('href', /\/alex\/demo\/issues/);
});

test('people who cannot manage see the inventory and runs read-only', async ({ page }) => {
  const state = await backend(page, { canManage: false });
  await page.goto('/alex/demo/settings/automations');
  await expect(inventory(page)).toContainText('PR reviewer');
  await expect(page.getByRole('button', { name: 'New automation' })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(inventory(page).locator('tbody').getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Repository administrators manage these automations.')).toBeVisible();
  await expect(runsTable(page)).toContainText('Nightly report');
  expect(writes(state)).toEqual([]);
});

test('a feature policy that turned automations off is explained and blocks new work', async ({ page }) => {
  await backend(page, { featureOn: false });
  await page.goto('/alex/demo/settings/automations');
  await expect(page.getByRole('note').filter({ hasText: 'Automations are turned off for this repository by the organization policy.' })).toContainText('Saved automations are kept and do not run');
  await expect(page.getByRole('button', { name: 'New automation' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Automatic runs for PR reviewer' })).toBeDisabled();
  await expect(inventory(page).getByRole('button', { name: 'Run PR reviewer now' })).toBeDisabled();
  await expect(inventory(page).getByRole('button', { name: 'Delete PR reviewer' })).toBeEnabled();
});

test('without the automations capability the page is not available and nothing is read', async ({ page }) => {
  const state = await backend(page, { capability: false });
  await page.goto('/alex/demo/settings/automations');
  await expect(page.getByText('Not available on this installation', { exact: true })).toBeVisible();
  await expect(page.getByText('Apply the schema 46 migration to use automations.')).toBeVisible();
  expect(state.calls).toEqual([]);
});

test('organization settings and the admin page use the same inventory at their own scope', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/organizations/acme/settings/automations');
  await expect(page.getByRole('navigation', { name: 'Organization settings' }).getByRole('link', { name: 'Automations' })).toHaveAttribute('aria-current', 'page');
  await expect(inventory(page)).toContainText('PR reviewer');
  expect(state.calls.find(call => call.action === 'list')).toEqual({ path: '/native/automations/read', action: 'list', scope: 'organization', organization: 'acme' });
  await expect(runsTable(page).getByRole('columnheader', { name: 'Repository' })).toBeVisible();
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByRole('radio', { name: /^Issue triage/ }).check();
  await expect(page.getByRole('form', { name: 'New Issue triage automation' }).getByLabel('Repositories', { exact: true })).toBeVisible();
  await page.getByRole('form', { name: 'New Issue triage automation' }).getByRole('button', { name: 'Cancel' }).click();
  await inventory(page).getByRole('button', { name: 'Run PR reviewer now' }).click();
  const form = page.getByRole('form', { name: 'Run PR reviewer now' });
  await form.getByLabel('Repository', { exact: true }).fill('acme/api');
  await form.getByLabel('Pull request number').fill('3');
  await form.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('status')).toContainText('was queued');
  expect(writes(state).at(-1)).toEqual({ path: '/native/automations', action: 'run', scope: 'organization', organization: 'acme', id: automation().id, target: { repository: { owner: 'acme', name: 'api' }, kind: 'pull_request', number: 3 } });
  await page.goto('/admin/automations');
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Automations' })).toHaveAttribute('aria-current', 'page');
  await expect(inventory(page)).toContainText('PR reviewer');
  expect(state.calls.some(call => call.action === 'list' && call.scope === 'installation' && Object.keys(call).length === 3)).toBe(true);
});
