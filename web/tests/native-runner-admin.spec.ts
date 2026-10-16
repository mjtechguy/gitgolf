import { expect, test, type Page } from '@playwright/test';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// A Cloudflare-native installation answering /native/runner-admin as cloudflare/forge/src/native-runners.mjs does: at most 20 pools by
// name and the newest 100 machines, with the totals and each pool's machine count read in SQL.
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'settings.native', 'settings.pipeline-runners', 'settings.runners', 'settings.native-runners'];
const pool = (i: number) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, name: `pool-${i}`, version: 1, state: 'ACTIVE', trust_class: 'UNTRUSTED', max_parallel: 2, image_id: 'img', machine_count: i === 1 ? 100 : 1 });
const machine = (i: number) => ({ id: `m-${i}`, pool_id: pool(1).id, name: `host-${i}`, protocol: 'native', version: 1, state: 'ACTIVE', expires_at: Date.now() + 3600_000, last_seen_at: null, active_job_id: null, cleanup_state: 'CONFIRMED' });

async function runnerAdmin(page: Page, inventory: Record<string, unknown>) {
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/pipeline-runners', route => route.fulfill({ json: { scope: 'installation', scopeId: '', engines: ['forgejo-actions', 'gitlab-ci'], forgejoRunner: { version: 'v13.2.0', sha256: 'a'.repeat(64) }, instance: 'https://golf.example', runners: [], inherited: [], tokens: [] } }));
  await page.route('**/native/runner-admin', route => route.fulfill({ json: inventory }));
}

test('a cut machine list names the omitted hosts, counts every machine per pool, and leaves New pool to the pool limit', async ({ page }) => {
  await runnerAdmin(page, { pools: [pool(1), pool(2)], machines: Array.from({ length: 100 }, (_, i) => machine(130 - i)), poolCount: 2, machineCount: 130, poolLimit: 20, machineLimit: 100, truncated: true });
  await page.goto('/admin/settings/runners');
  const pools = page.getByRole('table', { name: 'native runner pools' });
  await expect(pools.getByRole('row', { name: /pool-1/ })).toContainText('100');
  await expect(page.getByText('Showing the newest 100 of 130 machines; older ones are not listed.')).toBeVisible();
  await expect(page.getByText(/through the API/)).toHaveCount(0);
  // Only the machine limit is reached: New pool stays available, enrolling another host is refused and says so.
  await expect(page.getByRole('button', { name: 'New pool' })).toBeEnabled();
  await expect(page.getByText('The workspace has 130 machines, revoked ones included, its limit of 100: enrolling another host is refused.')).toBeVisible();
  await expect(pools.getByRole('button', { name: 'Enroll host' }).first()).toBeDisabled();
});

test('New pool is disabled at the pool limit, with the reason', async ({ page }) => {
  await runnerAdmin(page, { pools: Array.from({ length: 20 }, (_, i) => ({ ...pool(i), machine_count: 0 })), machines: [], poolCount: 20, machineCount: 0, poolLimit: 20, machineLimit: 100, truncated: false });
  await page.goto('/admin/settings/runners');
  await expect(page.getByRole('button', { name: 'New pool' })).toBeDisabled();
  await expect(page.getByText('The workspace has 20 pools, its limit of 20: a new pool is refused.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'native runner pools' }).getByRole('button', { name: 'Enroll host' }).first()).toBeEnabled();
});
