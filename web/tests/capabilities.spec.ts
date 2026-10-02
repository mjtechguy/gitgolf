import { expect, test } from '@playwright/test';
import { create, toJsonString } from '@bufbuild/protobuf';
import { CapabilityState, GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';

test('status separates portable agents and per-function Cloudflare state, with shared tables and denial cleanup', async ({ page }) => {
  let denied = false;
  await page.route('**/rpc/**', route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: string) => route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body });
    if (path.endsWith('/GetSession')) return reply(toJsonString(GetSessionResponseSchema, create(GetSessionResponseSchema, { user: { id: '42', login: 'alex' } })));
    if (path.endsWith('/GetAuthenticationOptions')) return reply(toJsonString(GetAuthenticationOptionsResponseSchema, create(GetAuthenticationOptionsResponseSchema, {})));
    if (path.endsWith('/ListCapabilities')) {
      if (denied) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'permission_denied', message: 'Capability access denied.' }) });
      return reply(toJsonString(ListCapabilitiesResponseSchema, create(ListCapabilitiesResponseSchema, { capabilities: [
        { id: 'repositories', label: 'Repositories', state: CapabilityState.READY, reason: 'Repository access is available.' },
        { id: 'webhooks.outbound', label: 'Slack notifications', state: CapabilityState.DISABLED, reason: 'Outbound delivery is planned.' },
        { id: 'agents.claude-code', label: 'Claude Code', state: CapabilityState.DISABLED, reason: 'Local adapter is not implemented.' },
        { id: 'agents.codex', label: 'Codex', state: CapabilityState.DISABLED, reason: 'Local adapter is not implemented.' },
        { id: 'cloudflare.r2.sources', label: 'R2 sources', state: CapabilityState.UNCONFIGURED, reason: 'Source bucket has not been configured or tested.' },
        { id: 'cloudflare.r2.artifacts', label: 'R2 artifacts', state: CapabilityState.DISABLED, reason: 'Artifact consumer is not implemented.' },
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
  await expect(agents.getByText('Claude Code', { exact: true })).toBeVisible();
  await expect(agents.getByText('Codex', { exact: true })).toBeVisible();
  await expect(agents.getByText('R2 sources', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Cloudflare is optional.', { exact: false })).toBeVisible();
  await expect(cloudflare.getByText('unconfigured', { exact: true })).toBeVisible();
  await expect(cloudflare.getByText('ready', { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search loaded Cloudflare integrations', exact: true }).fill('artifacts');
  await expect(cloudflare.getByText('R2 artifacts', { exact: true })).toBeVisible();
  await expect(cloudflare.getByText('R2 sources', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Rows per page for Coding agents', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeVisible();
  denied = true;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});
