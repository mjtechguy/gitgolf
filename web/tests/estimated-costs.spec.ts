import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { featureBackend } from './feature-policy-fixture';
import { respond } from './rpc';

// A Cloudflare-native installation answering /native/costs/read as cloudflare/forge/src/costs.mjs does. The fixture is that module's own
// output for a read where the Workers CPU field was refused (see the S6 entry in docs/IMPLEMENTATION_STATUS.md).
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'operations.ai-usage', 'operations.costs'];

async function costsBackend(page: Page, change: (read: Record<string, unknown>) => Record<string, unknown> = read => read) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/estimated-costs.json', import.meta.url), 'utf8'));
  const estimates: Record<string, unknown>[] = [];
  await featureBackend(page);
  await page.route('**/rpc/golf.v1.CapabilityService/ListCapabilities', route => respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => ({ id, label: id, state: 3, reason: 'Available.' })) }));
  await page.route('**/native/costs/read', route => {
    const body = route.request().postDataJSON();
    if (body.action === 'estimate') { estimates.push(body); return route.fulfill({ json: fixture.estimate }); }
    return route.fulfill({ json: change(fixture.read) });
  });
  return { fixture, estimates };
}

test('estimated costs lead with what is running now, and the scale-up form opens only on request', async ({ page }) => {
  const { estimates } = await costsBackend(page);
  await page.goto('/admin/costs');
  await expect(page.getByRole('heading', { level: 1, name: 'Estimated costs' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Instance administration' }).getByRole('link', { name: 'Estimated costs' })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'not a bill' })).toContainText('list prices as of 2026-10-15');
  await expect(page.getByRole('link', { name: 'D1', exact: true })).toHaveAttribute('href', 'https://developers.cloudflare.com/d1/platform/pricing/');
  // D1 rows written: 31.2 million so far against 50 million included, 66.7 million projected over the month.
  const d1 = page.getByRole('table', { name: 'D1 meters' });
  await expect(d1.getByRole('row', { name: /Rows written/ })).toContainText('31.2M');
  await expect(d1.getByRole('row', { name: /Rows written/ })).toContainText('$16.70');
  // The refused CPU field is not read and not $0.
  const cpu = page.getByRole('table', { name: 'Workers meters' }).getByRole('row', { name: /CPU time/ });
  await expect(cpu).toContainText('Not readable'); await expect(cpu).toContainText('unknown field'); await expect(cpu).not.toContainText('$0.00');
  await expect(page.getByRole('alert').filter({ hasText: 'Usage partly unreadable' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Configured, not priced here' })).toContainText('Workers AI');
  await expect(page.getByRole('region', { name: 'Recorded exactly by Golf' }).getByRole('link', { name: 'AI usage' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'measured unit costs' })).toContainText('D1: Rows written');
  // The what-if is closed until asked for.
  await expect(page.getByRole('form', { name: 'Estimate a scale-up' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Estimate a scale-up' }).click();
  const form = page.getByRole('form', { name: 'Estimate a scale-up' });
  await expect(form.getByLabel('Hourly rate (USD)')).toHaveValue('');
  await form.getByLabel('Agents').fill('250');
  await form.getByLabel('Agents').fill('-3');
  await expect(form.getByRole('alert')).toContainText('Enter a number from 0 to 100000.');
  await expect(form.getByRole('button', { name: 'Estimate' })).toBeDisabled();
  await form.getByLabel('Agents').fill('250');
  await form.getByLabel('Hourly rate (USD)').fill('0.4');
  await form.getByRole('radio', { name: /Landed pull requests/ }).check();
  await form.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByRole('table', { name: 'scale-up estimate' })).toContainText('Per applied write');
  expect(estimates.at(-1)).toMatchObject({ action: 'estimate', scenario: { agents: 250, basis: 'land', runnerHourlyRate: 0.4, container: { cpuBusy: 1 } } });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('form', { name: 'Estimate a scale-up' })).toHaveCount(0);
});

test('without an analytics token every usage line says why it is not read', async ({ page }) => {
  await costsBackend(page, read => ({ ...read, analytics: { state: 'unavailable', reason: 'No Account Analytics Read token is bound (enable-analytics).' },
    services: (read.services as { lines: Record<string, unknown>[] }[]).map(service => ({ ...service, state: 'unreadable', costMonthToDate: undefined, costProjected: undefined,
      lines: service.lines.map(line => ({ rate: line.rate, label: line.label, unit: line.unit, included: line.included, price: line.price, per: line.per, source: line.source, scope: '', confirmed: false, state: 'unreadable', reason: 'No Account Analytics Read token is bound (enable-analytics), so usage cannot be read.' })) })) }));
  await page.goto('/admin/costs');
  await expect(page.getByRole('note').filter({ hasText: 'Usage not read' })).toContainText('enable-analytics');
  const workers = page.getByRole('table', { name: 'Workers meters' });
  await expect(workers.getByRole('row', { name: /Requests/ })).toContainText('Not readable');
  await expect(workers).not.toContainText('$0.00');
});
