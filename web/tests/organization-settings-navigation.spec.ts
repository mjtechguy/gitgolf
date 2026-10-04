import { expect, test } from '@playwright/test';
import { ExecutionScope, GetExecutionPolicyResponseSchema, GetOrganizationResponseSchema, GetSessionResponseSchema, ListOrganizationExecutionValuesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

test('only the active organization settings page lights up its navigation', async ({ page }) => {
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '42', login: 'alice' } });
    if (method === 'GetOrganization') return respond(route, GetOrganizationResponseSchema, { organization: { id: '81', name: 'acme' } });
    if (method === 'GetExecutionPolicy') return respond(route, GetExecutionPolicyResponseSchema, { policy: { scope: ExecutionScope.ORGANIZATION, scopeId: '81', ownerId: '81', canEdit: true, authorityRevision: 'a'.repeat(64) } });
    if (method === 'ListOrganizationExecutionValues') return respond(route, ListOrganizationExecutionValuesResponseSchema, { target: { organization: 'acme', organizationId: '81' }, brokerRevision: '0', maximumValues: 64, maximumSelectedRepositories: 20, consumerProfile: 'golf.repository-env.v1' });
    return reject(route, 'unimplemented', 'Outside the navigation fixture.');
  });
  await page.goto('/organizations/acme/settings/secrets');
  const navigation = page.getByRole('navigation', { name: 'Organization settings', exact: true });
  await expect(navigation.getByRole('link', { name: 'Secrets and variables', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(navigation.getByRole('link', { name: 'Members and teams', exact: true })).not.toHaveAttribute('aria-current', 'page');
});
