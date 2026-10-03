import { expect, test } from '@playwright/test';
import { create, toJsonString } from '@bufbuild/protobuf';
import { CapabilityState, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListInfrastructureConnectionsResponseSchema } from '../src/gen/golf/v1/golf_pb';

for (const isInstanceAdmin of [false, true]) test(`status setup respects administrator role (${isInstanceAdmin}) and clears denied state`, async ({ page }) => {
  let denied = false;
  await page.route('**/rpc/**', route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: string) => route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body });
    if (path.endsWith('/GetSession')) return reply(toJsonString(GetSessionResponseSchema, create(GetSessionResponseSchema, { user: { id: '42', login: 'alex', isInstanceAdmin } })));
    if (path.endsWith('/GetAuthenticationOptions')) return reply(toJsonString(GetAuthenticationOptionsResponseSchema, create(GetAuthenticationOptionsResponseSchema, {})));
    if (path.endsWith('/ListInfrastructureConnections')) return reply(toJsonString(ListInfrastructureConnectionsResponseSchema, create(ListInfrastructureConnectionsResponseSchema, {})));
    if (path.endsWith('/ListCapabilities')) {
      if (denied) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'permission_denied', message: 'Capability access denied.' }) });
      return reply(toJsonString(ListCapabilitiesResponseSchema, create(ListCapabilitiesResponseSchema, { capabilities: [
        { id: 'repositories', label: 'Repositories', state: CapabilityState.READY, reason: 'Repository access is available.' },
        { id: 'pipelines', label: 'Manual shell pipelines', state: CapabilityState.DEGRADED, reason: 'Worker is configured but unavailable.' },
        { id: 'webhooks.outbound', label: 'Slack notifications', state: CapabilityState.DISABLED, reason: 'Outbound delivery is planned.' },
        { id: 'agents.claude-code', label: 'Claude Code', state: CapabilityState.DISABLED, reason: 'Local adapter is not implemented.' },
        { id: 'agents.codex', label: 'Codex', state: CapabilityState.DISABLED, reason: 'Local adapter is not implemented.' },
        { id: 'cloudflare.r2.sources', label: 'R2 sources', state: CapabilityState.UNCONFIGURED, reason: 'Source bucket has not been configured or tested.' },
        { id: 'cloudflare.r2.artifacts', label: 'R2 artifacts', state: CapabilityState.DISABLED, reason: 'Artifact consumer is not implemented.' },
        ...Array.from({ length: 25 }, (_, i) => ({ id: `cloudflare.extra.${i}`, label: `Integration ${i}`, state: CapabilityState.DISABLED, reason: 'Not configured.' })),
      ] })));
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'not_found', message: 'Unavailable.' }) });
  });
  await page.goto('/status');
  const platform = page.getByRole('table', { name: 'Golf platform', exact: true });
  const agents = page.getByRole('table', { name: 'Coding agents', exact: true });
  const cloudflare = page.getByRole('table', { name: 'Cloudflare integrations', exact: true });
  await expect(platform.getByText('Repositories', { exact: true })).toBeVisible();
  await expect(platform.getByText('Slack notifications', { exact: true })).toBeVisible();
  await expect(platform.getByRole('link', { name: 'Manage repositories', exact: true })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Manage connections', exact: true })).toHaveCount(isInstanceAdmin ? 1 : 0);
  await expect(platform.getByRole('link', { name: 'Manage policies', exact: true })).toHaveCount(isInstanceAdmin ? 1 : 0);
  await expect(agents.getByText('Setup not available yet', { exact: true })).toHaveCount(1);
  await expect(agents.getByRole('link', { name: 'Manage Codex connection', exact: true })).toHaveAttribute('href', '/account/agents');
  await expect(agents.getByRole('link', { name: 'Manage instance accounts', exact: true })).toHaveCount(isInstanceAdmin ? 1 : 0);
  await expect(cloudflare.getByRole('link', { name: 'Configure source storage', exact: true })).toHaveCount(isInstanceAdmin ? 1 : 0);
  await expect(agents.getByText('Claude Code', { exact: true })).toBeVisible();
  await expect(agents.getByText('Codex', { exact: true })).toBeVisible();
  await expect(agents.getByText('R2 sources', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Cloudflare is optional.', { exact: false })).toBeVisible();
  await expect(cloudflare.getByText('unconfigured', { exact: true })).toBeVisible();
  await expect(cloudflare.getByText('ready', { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search loaded Cloudflare integrations', exact: true }).fill('artifacts');
  await expect(cloudflare.getByText('R2 artifacts', { exact: true })).toBeVisible();
  await expect(cloudflare.getByText('R2 sources', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Rows per page for Coding agents', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Golf platform pages' })).toHaveCount(0);
  await expect(platform.locator('.visibility.available')).toHaveText('ready');
  await expect(platform.locator('.visibility.configured')).toHaveText('configured · degraded');
  await page.getByRole('searchbox', { name: 'Search loaded Cloudflare integrations', exact: true }).fill('');
  await expect(cloudflare.locator('tbody tr[data-row-id]')).toHaveCount(27);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeVisible();
  denied = true;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Manage connections', exact: true })).toHaveCount(0);
  if (isInstanceAdmin) {
    denied = false;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByRole('link', { name: 'Manage connections', exact: true }).click();
    await expect(page).toHaveURL('/admin/settings/infrastructure');
    await expect(page.getByRole('heading', { name: 'Infrastructure connections', exact: true })).toBeVisible();
    await expect(page.getByLabel('Endpoint', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add database profile', exact: true }).click();
    await expect(page.getByLabel('Database role', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add object-storage profile', exact: true }).click();
    await page.getByLabel('Object-storage backend', { exact: true }).selectOption('R2');
    await expect(page.getByLabel('Bucket', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('link', { name: 'Back to status', exact: true }).click();
    await expect(page).toHaveURL('/status');
  }
});
