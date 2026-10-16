import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';
import type { Capacity, CapacityRequest } from '../src/RunnerCapacity';

// A Cloudflare-native installation answering /native/capacity/read and /native/capacity as cloudflare/forge/src/capacity.mjs does.
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'operations.costs', 'operations.capacity'];
const now = new Date().toISOString();
const pending: CapacityRequest = { id: '7', key: 'evidence', field: 'dailyLimit', label: 'Daily evidence admissions', unit: 'a day', scope: 'installation', organization: '', confirmation: 'evidence', current: 10, requested: 40, ceiling: 50, needsDeploy: false,
  estimatedMonthlyDelta: 0.97, estimateBasis: 'Upper bound: 30 more admissions a day × 30.4 days = up to 912 more CI runs a month.', reason: 'Bench at 200 agents', requestedBy: 'bob', requestedAt: now, mine: false,
  state: 'PENDING', decidedBy: '', decidedAt: '', decisionNote: '', appliedBy: '', appliedAt: '', deploy: null };
const waiting: CapacityRequest = { ...pending, id: '6', key: 'previews', confirmation: 'previews', field: 'lifetimeSeconds', label: 'Preview lifetime', unit: 'seconds', current: 3600, requested: 7200, ceiling: 3600, needsDeploy: true,
  estimatedMonthlyDelta: null, estimateBasis: 'No cost model for this setting.', requestedBy: 'alice', mine: true, state: 'APPROVED', decidedBy: 'bob',
  deploy: { setting: 'settings.previews.ttl', value: 7200, command: 'python3 scripts/golf_cloudflare.py update DIR', steps: 'Set settings.previews.ttl to 7200 in DIR/alchemy-input.json (the installation directory), then run python3 scripts/golf_cloudflare.py update DIR; it shows the plan before it deploys.' } };
const fixture: Capacity = { generatedAt: now, schema: 'ready', editing: '', metricsPath: '/native/capacity/metrics', origin: 'https://golf.example.com', you: 'alice',
  selfHosted: { configured: true, truncated: false, onlineWindowSeconds: 300, unmatched: { queued: 3, oldestWaitSeconds: 600, byEngine: { 'forgejo-actions': 3 } },
    pools: [{ id: 'forgejo-actions:docker,ubuntu-latest', engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], registered: 4, active: 3, online: 2, running: 2, queued: 5, oldestWaitSeconds: 125, scopes: ['installation'],
      cap: 2, heldByCap: 4, heldByShares: 1, held: 5, claimable: 0 }] },
  runnerPolicies: {
    pools: { key: 'runner-pools', label: 'Runner pool caps', version: '2', value: { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 2 }] }, deploy: { pools: [] }, source: 'installation', unreadable: false,
      updatedAt: now, updatedBy: 'bob', confirmation: 'runner-pools', effect: { queued: 'Queued jobs stay queued.', inFlight: 'Running jobs are not stopped.', new: 'A runner in a capped pool gets no job.' } },
    shares: { key: 'runner-shares', label: 'Runner shares', version: '0', value: { maxRunning: 4, maxRunsPerDay: null, enforced: false }, deploy: { maxRunning: null, maxRunsPerDay: null, enforced: false }, source: 'deploy', unreadable: false,
      updatedAt: '', updatedBy: '', confirmation: 'runner-shares', effect: { queued: 'Jobs over a share stay queued.', inFlight: 'Running jobs are not stopped.', new: 'The next claim counts.' } } },
  shares: { schema: 'ready', rows: [{ scope: 'organization', id: '10', name: 'acme', limit: { maxRunning: 4, maxRunsPerDay: null }, ceiling: { maxRunning: 4, maxRunsPerDay: null }, own: null, granted: null, enforced: false, running: 4, queued: 3, held: 3, runsToday: 12 }] },
  nativePools: [{ id: 'p1', name: 'metal', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 3, activeMachines: 1, running: 0, queued: 1 }],
  containers: [{ id: 'pr-tests', label: 'PR test containers', binding: 'PRTestTask', configured: true, allocation: null, allocationReason: 'Not bound.', limit: { value: 2, inUse: 1, source: 'Golf admits at most 2.' }, running: 1, queued: 1 },
    { id: 'ssh-tasks', label: 'SSH task containers', binding: 'SSHAgentTask', configured: false, allocation: null, allocationReason: 'Not bound.', limit: { value: 0, inUse: 0, source: 'Per host.' }, running: 0, queued: 0 }],
  hosts: [{ id: 'agent-hosts', label: 'Agent hosts', hosts: 2, capacity: 6, online: 1, running: 1, queued: 0, onlineNote: 'Seen in the last minute.' }],
  settings: [{ key: 'evidence', field: 'dailyLimit', label: 'Daily evidence admissions', unit: 'a day', policyLabel: 'Daily evidence admissions', version: '3', cost: 'Per CI run, measured on this installation', allocated: true, current: 10, ceiling: 50, deployMax: 50, fixed: '', deploySetting: 'settings.evidence.daily_limit' }],
  requests: [pending, waiting], tokens: [{ id: '1', label: 'keda-golf-ci', createdBy: 'alice', createdAt: now, expiresAt: new Date(Date.now() + 86400_000).toISOString(), lastUsedAt: '', revokedAt: '', state: 'active' }] };

async function capacityBackend(page: Page, data: Capacity = fixture) {
  const writes: Record<string, unknown>[] = [], reads: Record<string, unknown>[] = [];
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/capacity/read', route => {
    const body = route.request().postDataJSON(); reads.push(body);
    if (body.action === 'preview') return route.fulfill({ json: { current: 10, requested: body.value, ceiling: 50, needsDeploy: false, estimatedMonthlyDelta: 0.97, estimateBasis: 'Upper bound: measured per CI run.', deploy: null } });
    return route.fulfill({ json: data });
  });
  await page.route('**/native/installation', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    // As capacity-policy.mjs: removing or raising the existing cap (forgejo-actions docker,ubuntu-latest: 2) widens; a new cap does not.
    const existing = body.key === 'runner-pools' && body.value.pools.find((pool: { engine: string; labels: string[] }) => pool.engine === 'forgejo-actions' && pool.labels.join(',') === 'docker,ubuntu-latest');
    const widening = body.key === 'runner-pools' ? !existing || existing.maxConcurrent > 2 : body.value.maxRunning === null || body.value.maxRunning > 4;
    if (widening && body.confirmation !== body.key) return route.fulfill({ status: 412, json: { code: 'failed_precondition', message: `Type ${body.key} to confirm it.` } });
    return route.fulfill({ json: { key: body.key, version: '3', value: body.value, widening, operationId: body.operationId, at: now } });
  });
  await page.route('**/native/capacity', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (body.action === 'approve' && !body.confirmation) return route.fulfill({ status: 412, json: { code: 'failed_precondition', message: 'Type evidence to confirm this approval.' } });
    if (body.action === 'approve') return route.fulfill({ json: { request: { ...pending, state: 'APPLIED', decidedBy: 'alice', appliedBy: 'alice' } } });
    return route.fulfill({ json: { request: { ...pending, state: 'PENDING', mine: true, requestedBy: 'alice' } } });
  });
  return { writes, reads };
}

test('runner capacity leads with the inventory; request and approval forms open only on request', async ({ page }) => {
  const { writes, reads } = await capacityBackend(page);
  await page.goto('/admin/capacity');
  await expect(page.getByRole('heading', { level: 1, name: 'Runner capacity' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Runner capacity' })).toBeVisible();
  const inventory = page.getByRole('table', { name: 'runner capacity' });
  const pool = inventory.getByRole('row', { name: /docker, ubuntu-latest/ });
  await expect(pool).toContainText('3 active of 4 registered'); await expect(pool).toContainText('2 min');
  await expect(inventory.getByRole('row', { name: /Queued with no runner/ })).toContainText('Forgejo runners: 3');
  // No container allocation is invented.
  await expect(inventory.getByRole('row', { name: /PR test containers/ })).toContainText('Allocation not known to the Worker');
  await expect(inventory.getByRole('row', { name: /SSH task containers/ })).toContainText('SSHAgentTask is not configured');
  const requests = page.getByRole('table', { name: 'capacity requests' });
  await expect(requests.getByRole('row', { name: /Daily evidence admissions/ })).toContainText('10 → 40 a day');
  await expect(requests.getByRole('row', { name: /Daily evidence admissions/ })).toContainText('+$0.97 a month');
  const mine = requests.getByRole('row', { name: /Preview lifetime/ });
  await expect(mine).toContainText('Needs a deploy'); await expect(mine).toContainText('Not estimated');
  // The requester withdraws; never approves.
  await expect(mine.getByRole('button', { name: /Approve|Apply/ })).toHaveCount(0);
  await expect(page.getByText('Deploy to raise the ceiling for preview lifetime')).toBeVisible();
  await expect(page.getByRole('form')).toHaveCount(0);

  await page.getByRole('button', { name: 'Request more capacity' }).click();
  const form = page.getByRole('form', { name: 'Request more capacity' });
  await form.getByLabel('Requested value').fill('40');
  await form.getByLabel('Why').fill('Bench at 200 agents');
  await form.getByRole('button', { name: 'Estimate cost' }).click();
  await expect(form.getByLabel('Request preview')).toContainText('+$0.97 a month');
  expect(reads.at(-1)).toMatchObject({ action: 'preview', key: 'evidence', field: 'dailyLimit', value: 40 });
  await form.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Another operations administrator approves or declines it');
  expect(writes.at(-1)).toMatchObject({ action: 'request', key: 'evidence', field: 'dailyLimit', value: 40, reason: 'Bench at 200 agents' });

  await requests.getByRole('button', { name: 'Approve Daily evidence admissions' }).click();
  const decision = page.getByRole('form', { name: 'Approve capacity request' });
  await expect(decision.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await decision.getByLabel('Type evidence to confirm').fill('evidence');
  await decision.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('Daily evidence admissions is now 40');
  expect(writes.at(-1)).toMatchObject({ action: 'approve', id: '7', expectedVersion: '3', confirmation: 'evidence' });
  expect(String(writes.at(-1)!.operationId)).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('table', { name: 'capacity metrics tokens' })).toContainText('keda-golf-ci');
});

test('a truncated inventory says which read was cut: the newest runners or the longest-waiting queued jobs', async ({ page }) => {
  await capacityBackend(page, { ...fixture, selfHosted: { ...fixture.selfHosted, truncated: true, runnersTruncated: false, jobsTruncated: true } });
  await page.goto('/admin/capacity');
  await expect(page.getByText('Only the 5,000 longest-waiting queued jobs were read; queue counts are partial.')).toBeVisible();
  await expect(page.getByText(/newest 2,000 runners/)).toHaveCount(0);
});

test('pool caps and runner shares lead with current values; Add and Edit open forms, and widening asks for the setting name', async ({ page }) => {
  const { writes } = await capacityBackend(page);
  await page.goto('/admin/capacity');
  const pool = page.getByRole('table', { name: 'runner capacity' }).getByRole('row', { name: /docker, ubuntu-latest/ });
  await expect(pool).toContainText('cap 2');
  await expect(page.getByRole('table', { name: 'pool caps' }).getByRole('row', { name: /docker, ubuntu-latest/ })).toContainText('2 running');
  await expect(page.getByLabel('Installation runner share')).toContainText('4 at once for each organization');
  await expect(page.getByRole('table', { name: 'runner shares' }).getByRole('row', { name: /acme/ })).toContainText('4 of 4');
  await expect(page.getByRole('form')).toHaveCount(0);
  // A new cap narrows: no confirmation.
  await page.getByRole('button', { name: 'Add pool cap' }).click();
  const add = page.getByRole('form', { name: 'Add pool cap' });
  await add.getByLabel('Engine').selectOption('gitlab-ci');
  await add.getByLabel('Runner labels').fill('docker, kind');
  await add.getByLabel('Running jobs at most').fill('3');
  await expect(add.getByLabel(/Type runner-pools/)).toHaveCount(0);
  await add.getByRole('button', { name: 'Save cap' }).click();
  await expect(page.getByRole('status')).toContainText('The pool cap was saved');
  expect(writes.at(-1)).toMatchObject({ action: 'update', key: 'runner-pools', expectedVersion: '2', value: { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 2 }, { engine: 'gitlab-ci', labels: ['docker', 'kind'], maxConcurrent: 3 }] } });
  expect(writes.at(-1)!.confirmation).toBeUndefined();
  // Raising a cap widens: the setting name is typed first.
  await page.getByRole('button', { name: 'Edit cap for docker, ubuntu-latest' }).click();
  const edit = page.getByRole('form', { name: 'Edit pool cap' });
  await edit.getByLabel('Running jobs at most').fill('6');
  await expect(edit.getByRole('button', { name: 'Save cap' })).toBeDisabled();
  await edit.getByLabel(/Type runner-pools/).fill('runner-pools');
  await edit.getByRole('button', { name: 'Save cap' }).click();
  await expect(page.getByRole('status')).toContainText('The pool cap was saved');
  expect(writes.at(-1)).toMatchObject({ key: 'runner-pools', confirmation: 'runner-pools', value: { pools: [{ maxConcurrent: 6 }] } });
  // The installation share: lowering saves directly; removing the limit widens.
  await page.getByRole('region', { name: 'Runner shares' }).getByRole('button', { name: 'Edit' }).click();
  const shares = page.getByRole('form', { name: 'Edit installation runner share' });
  await shares.getByLabel('Running jobs for each organization and personal repository').fill('');
  await expect(shares.getByLabel(/Type runner-shares/)).toBeVisible();
  await shares.getByLabel('Running jobs for each organization and personal repository').fill('3');
  await shares.getByLabel('Runs a day for each organization and personal repository').fill('200');
  await expect(shares.getByLabel(/Type runner-shares/)).toHaveCount(0);
  await shares.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('The installation runner share was saved');
  expect(writes.at(-1)).toMatchObject({ key: 'runner-shares', value: { maxRunning: 3, maxRunsPerDay: 200, enforced: false } });
});

test('a repository’s runner share shows what applies and what it inherits; Edit opens the form only for its administrators', async ({ page }) => {
  await featureBackend(page);
  const writes: Record<string, unknown>[] = [];
  let own: number | null = null;
  const view = () => ({ scope: 'repository', name: 'alex/demo', allocated: true, schema: 'ready', own: { maxRunning: own, maxRunsPerDay: null }, ceiling: { maxRunning: 4, maxRunsPerDay: 50 }, limit: { maxRunning: own ?? 4, maxRunsPerDay: 50 },
    granted: null, installation: { maxRunning: 4, maxRunsPerDay: 50, enforced: false }, parent: { scope: 'installation', name: 'the installation' }, version: own === null ? '0' : '1', updatedAt: '',
    usage: { running: 4, queued: 2, held: 2, runsToday: 9, parentRunning: null }, canEdit: true, canRequest: false, editReason: '', requests: [] });
  await page.route('**/native/config', route => route.fulfill({ json: { runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: true, tests: false } }));
  await page.route('**/native/pipeline-runners', route => route.fulfill({ json: { scope: 'repository', scopeId: '', engines: ['forgejo-actions', 'gitlab-ci'], forgejoRunner: { version: 'v13.2.0', sha256: 'a'.repeat(64) }, instance: 'https://golf.example', runners: [], inherited: [], tokens: [] } }));
  await page.route('**/native/capacity/shares/read', route => route.fulfill({ json: view() }));
  await page.route('**/native/capacity/shares', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (body.maxRunning > 4) return route.fulfill({ status: 400, json: { code: 'invalid_argument', message: 'Concurrent pipeline jobs can be at most the installation’s 4.' } });
    own = body.maxRunning; return route.fulfill({ json: view() });
  });
  await page.goto('/alex/demo/settings/runners');
  const current = page.getByLabel('Current runner share');
  await expect(current).toContainText('4 running jobs · 50 runs a day (UTC)');
  await expect(current).toContainText('None: the installation’s applies');
  await expect(current).toContainText('2 held by the share');
  await expect(page.getByRole('form', { name: 'Edit runner share' })).toHaveCount(0);
  await page.getByRole('region', { name: 'Runner share' }).getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('form', { name: 'Edit runner share' });
  await form.getByLabel('Running jobs').fill('5');
  await expect(form.getByRole('alert')).toHaveText('At most 4, the inherited limit.');
  await form.getByLabel('Running jobs').fill('2');
  await form.getByRole('button', { name: 'Save share' }).click();
  await expect(page.getByRole('status')).toContainText('The runner share was saved');
  expect(writes.at(-1)).toMatchObject({ action: 'set', repository: { owner: 'alex', name: 'demo' }, maxRunning: 2, maxRunsPerDay: null, expectedVersion: '0' });
  await expect(current).toContainText('2 running jobs');
});
