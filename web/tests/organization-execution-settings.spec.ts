import { expect, test, type Page } from '@playwright/test';
import { ExecutionScope, GetExecutionPolicyResponseSchema, GetOrganizationResponseSchema, ListOrganizationExecutionValuesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

async function backend(page: Page) {
  const state = { owner: true, organizationId: '81', policyId: '81', revision: 'a'.repeat(64), held: undefined as Promise<void> | undefined, inventories: 0 };
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1);
    if (method === 'GetOrganization') return respond(route, GetOrganizationResponseSchema, { organization: { id: state.organizationId, name: 'acme' } });
    if (method === 'GetExecutionPolicy') {
      if (state.held) await state.held;
      if (!state.owner) return reject(route, 'permission_denied', 'Current organization ownership required.');
      return respond(route, GetExecutionPolicyResponseSchema, { policy: { scope: ExecutionScope.ORGANIZATION, scopeId: state.policyId, ownerId: state.policyId, canEdit: true, authorityRevision: state.revision } });
    }
    if (method === 'ListOrganizationExecutionValues') { state.inventories++; return respond(route, ListOrganizationExecutionValuesResponseSchema, { target: { organization: 'acme', organizationId: '81' }, brokerRevision: '0', maximumValues: 64, maximumSelectedRepositories: 20, consumerProfile: 'golf.repository-env.v1' }); }
    return reject(route, 'unimplemented', 'Procedure outside this route fixture.');
  });
  return state;
}
const open = (page: Page) => page.goto('/tests/fixtures/organization-execution-settings.html');
test('exact current organization owner opens shared settings with requested editors', async ({ page }) => {
  const state = await backend(page); await open(page);
  await expect(page.getByRole('table', { name: 'Organization secrets and variables', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Organization settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Secrets and variables', exact: true })).toHaveAttribute('href', '/organizations/acme/settings/secrets');
  await expect(page.getByRole('form')).toHaveCount(0); expect(state.inventories).toBeGreaterThan(0);
});
for (const kind of ['nonowner', 'replacement', 'malformed revision'] as const) test(`${kind} cannot mount private organization inventory`, async ({ page }) => {
  const state = await backend(page); if (kind === 'nonowner') state.owner = false; if (kind === 'replacement') state.policyId = '82'; if (kind === 'malformed revision') state.revision = 'invalid';
  await open(page); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('table')).toHaveCount(0); expect(state.inventories).toBe(0);
});
test('signout fences a late positive ownership observation', async ({ page }) => {
  const state = await backend(page); let release!: () => void; state.held = new Promise<void>(resolve => { release = resolve; });
  await open(page); await expect(page.getByText('Verifying organization ownership…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out fixture', exact: true }).click(); release();
  await expect(page.getByText('Signing out…', { exact: true })).toBeVisible(); await expect(page.getByRole('table')).toHaveCount(0); expect(state.inventories).toBe(0);
});
