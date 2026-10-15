import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';
import type { Capacity, CapacityRequest } from '../src/RunnerCapacity';

// A Cloudflare-native installation answering /native/capacity/read and /native/capacity as cloudflare/forge/src/capacity.mjs does.
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'operations.costs', 'operations.capacity'];
const now = new Date().toISOString();
const pending: CapacityRequest = { id: '7', key: 'evidence', field: 'dailyLimit', label: 'Daily evidence admissions', unit: 'a day', current: 10, requested: 40, ceiling: 50, needsDeploy: false,
  estimatedMonthlyDelta: 0.97, estimateBasis: 'Upper bound: 30 more admissions a day × 30.4 days = up to 912 more CI runs a month.', reason: 'Bench at 200 agents', requestedBy: 'bob', requestedAt: now, mine: false,
  state: 'PENDING', decidedBy: '', decidedAt: '', decisionNote: '', appliedBy: '', appliedAt: '', deploy: null };
const waiting: CapacityRequest = { ...pending, id: '6', key: 'previews', field: 'lifetimeSeconds', label: 'Preview lifetime', unit: 'seconds', current: 3600, requested: 7200, ceiling: 3600, needsDeploy: true,
  estimatedMonthlyDelta: null, estimateBasis: 'No cost model for this setting.', requestedBy: 'alice', mine: true, state: 'APPROVED', decidedBy: 'bob',
  deploy: { setting: 'settings.previews.ttl', value: 7200, command: 'python3 scripts/golf_cloudflare.py update DIR', steps: 'Set settings.previews.ttl to 7200 in DIR/alchemy-input.json (the installation directory), then run python3 scripts/golf_cloudflare.py update DIR; it shows the plan before it deploys.' } };
const fixture: Capacity = { generatedAt: now, schema: 'ready', editing: '', metricsPath: '/native/capacity/metrics', origin: 'https://golf.example.com', you: 'alice',
  selfHosted: { configured: true, truncated: false, onlineWindowSeconds: 300, unmatched: { queued: 3, oldestWaitSeconds: 600, byEngine: { 'forgejo-actions': 3 } },
    pools: [{ id: 'forgejo-actions:docker,ubuntu-latest', engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], registered: 4, active: 3, online: 2, running: 2, queued: 5, oldestWaitSeconds: 125, scopes: ['installation'] }] },
  nativePools: [{ id: 'p1', name: 'metal', state: 'ACTIVE', trustClass: 'UNTRUSTED', maxParallel: 3, activeMachines: 1, running: 0, queued: 1 }],
  containers: [{ id: 'pr-tests', label: 'PR test containers', binding: 'PRTestTask', configured: true, allocation: null, allocationReason: 'Not bound.', limit: { value: 2, inUse: 1, source: 'Golf admits at most 2.' }, running: 1, queued: 1 },
    { id: 'ssh-tasks', label: 'SSH task containers', binding: 'SSHAgentTask', configured: false, allocation: null, allocationReason: 'Not bound.', limit: { value: 0, inUse: 0, source: 'Per host.' }, running: 0, queued: 0 }],
  hosts: [{ id: 'agent-hosts', label: 'Agent hosts', hosts: 2, capacity: 6, online: 1, running: 1, queued: 0, onlineNote: 'Seen in the last minute.' }],
  settings: [{ key: 'evidence', field: 'dailyLimit', label: 'Daily evidence admissions', unit: 'a day', policyLabel: 'Daily evidence admissions', version: '3', cost: 'Per CI run, measured on this installation', allocated: true, current: 10, ceiling: 50, deployMax: 50, fixed: '', deploySetting: 'settings.evidence.daily_limit' }],
  requests: [pending, waiting], tokens: [{ id: '1', label: 'keda-golf-ci', createdBy: 'alice', createdAt: now, expiresAt: new Date(Date.now() + 86400_000).toISOString(), lastUsedAt: '', revokedAt: '', state: 'active' }] };

async function capacityBackend(page: Page) {
  const writes: Record<string, unknown>[] = [], reads: Record<string, unknown>[] = [];
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/capacity/read', route => {
    const body = route.request().postDataJSON(); reads.push(body);
    if (body.action === 'preview') return route.fulfill({ json: { current: 10, requested: body.value, ceiling: 50, needsDeploy: false, estimatedMonthlyDelta: 0.97, estimateBasis: 'Upper bound: measured per CI run.', deploy: null } });
    return route.fulfill({ json: fixture });
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
