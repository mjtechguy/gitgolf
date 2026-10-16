import { expect, test, type Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListInfrastructureConnectionsResponseSchema, SaveInfrastructureConnectionRequestSchema, SaveInfrastructureConnectionResponseSchema, TestInfrastructureConnectionRequestSchema, TestInfrastructureConnectionResponseSchema, ActivateInfrastructureConnectionRequestSchema, ActivateInfrastructureConnectionResponseSchema, UserSchema, InfrastructureConnectionSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';
import { ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { portableRuntimeFixture } from './runtime-fixture';
async function backend(page: Page) {
  const state = { profiles: [create(InfrastructureConnectionSchema, { id: '12345678-1234-4234-8234-123456789abc', version: '3', label: 'Private source storage', kind: 'OBJECT_STORAGE', backend: 'RUSTFS', endpoint: 'http://rustfs:9000', region: 'us-east-1', bucket: 'golf', prefix: 'golf', pathStyle: true, allowInsecure: true, hasCredential: true, activationState: 'saved_not_active' })], writes: [] as ReturnType<typeof request<typeof SaveInfrastructureConnectionRequestSchema>>[], activations: [] as ReturnType<typeof request<typeof ActivateInfrastructureConnectionRequestSchema>>[], tests: [] as ReturnType<typeof request<typeof TestInfrastructureConnectionRequestSchema>>[], activeId: '12345678-1234-4234-8234-123456789abc', activeVersion: '2', activeConnection: undefined as ReturnType<typeof create<typeof InfrastructureConnectionSchema>> | undefined, dropped: false, denied: false };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: create(UserSchema, { id: '42', login: 'alex', isInstanceAdmin: true }) });
    if (method === 'ListInfrastructureConnections') return state.denied ? reject(route, 'permission_denied', 'Administrator session required.') : respond(route, ListInfrastructureConnectionsResponseSchema, { connections: state.profiles, activeRevision: '7', activeConnectionId: state.activeId, activeConnectionVersion: state.activeVersion, activeConnection: state.activeConnection, deploymentDefaults: [{ label: 'Golf database from deployment', kind: 'DATABASE', backend: 'POSTGRESQL', databaseRole: 'GOLF', endpoint: 'postgres:5432', activationState: 'deployment_default' }] });
    if (method === 'SaveInfrastructureConnection') {
      const input = request(route, SaveInfrastructureConnectionRequestSchema); state.writes.push(input);
      if (state.dropped) return route.abort('failed');
      if (state.denied) return reject(route, 'permission_denied', 'Administrator session revoked.');
      const profile = create(InfrastructureConnectionSchema, input.connection!); profile.id ||= '12345678-1234-4234-8234-123456789abd'; profile.version = String(Number(input.expectedVersion) + 1); profile.hasCredential = true; profile.activationState = 'saved_not_active';
      state.profiles = [...state.profiles.filter(p => p.id !== profile.id), profile];
      return respond(route, SaveInfrastructureConnectionResponseSchema, { connection: profile });
    }
    if (method === 'TestInfrastructureConnection') { state.tests.push(request(route, TestInfrastructureConnectionRequestSchema)); return respond(route, TestInfrastructureConnectionResponseSchema, { accessible: true, resultCode: 'accessible', checkedAt: '2026-10-02T12:00:00Z', qualificationScope: 'bucket_head_accessibility_only' }); }
    if (method === 'ActivateInfrastructureConnection') { const input = request(route, ActivateInfrastructureConnectionRequestSchema); state.activations.push(input); state.activeId = input.id; state.activeVersion = input.expectedVersion; return respond(route, ActivateInfrastructureConnectionResponseSchema, { connection: state.profiles.find(p => p.id === input.id), activeRevision: '8' }); }
    return reject(route, 'not_found', 'Unsupported infrastructure fixture.');
  });
  return state;
}
test('infrastructure inventory is compact, searchable and starts without settings forms', async ({ page }) => {
  const state = await backend(page);
  state.profiles.push(create(InfrastructureConnectionSchema, { id: '12345678-1234-4234-8234-123456789abf', version: '1', label: 'Remote source storage', kind: 'OBJECT_STORAGE', backend: 'S3', endpoint: 'https://s3.example', bucket: 'remote-sources', activationState: 'saved_not_active' }));
  await page.goto('/admin/settings/infrastructure');
  await expect(page.getByRole('heading', { name: 'Infrastructure connections', exact: true })).toBeVisible();
  await expect(page.locator('input:not([type=search]),textarea,select:not(.data-table-page-size):not(.data-table-page-size select)')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Current databases', exact: true }).getByText('postgres:5432')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Object-storage profiles', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search loaded Object-storage profiles', exact: true }).fill('RustFS');
  await expect(page.getByRole('table', { name: 'Object-storage profiles', exact: true }).locator('tbody tr[data-row-id]')).toHaveCount(1);
  await expect(page.getByText('Private source storage · version 2', { exact: false })).toBeVisible();
});
test('new database profile sends explicit desired configuration and password confirmation', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings/infrastructure'); await page.getByRole('button', { name: 'Add database profile', exact: true }).click();
  await page.getByLabel('Profile label', { exact: true }).fill('Remote Golf'); await page.getByLabel('Endpoint', { exact: true }).fill('db.example:5432');
  await page.getByLabel('Database password', { exact: true }).fill('private-database-password'); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation');
  await page.getByRole('button', { name: 'Save connection profile', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Live database pools remain unchanged.');
  expect(state.writes).toHaveLength(1); expect(state.writes[0]!.expectedVersion).toBe('0'); expect(state.writes[0]!.credential?.databasePassword).toBe('private-database-password'); expect(state.writes[0]!.passwordConfirmation).toBe('private-confirmation'); expect(state.writes[0]!.connection?.region).toBe(''); expect(state.writes[0]!.connection?.bucket).toBe('');
  await expect(page.getByLabel('Database password', { exact: true })).toHaveCount(0);
});
test('editing retains encrypted credentials and sends the observed version', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings/infrastructure'); await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Retain encrypted credentials', { exact: true })).toBeChecked(); await expect(page.getByLabel('Secret access key', { exact: true })).toHaveCount(0);
  await page.getByLabel('Profile label', { exact: true }).fill('Updated private storage'); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation'); await page.getByRole('button', { name: 'Save connection profile', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Object-storage profile saved'); expect(state.writes[0]!.expectedVersion).toBe('3'); expect(state.writes[0]!.retainCredential).toBe(true); expect(state.writes[0]!.credential).toBeUndefined();
});
test('test and activation have separate confirmation and immutable binding', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings/infrastructure'); await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('they do not prove write or immutability support.', { exact: false })).toBeVisible(); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation'); await page.getByRole('button', { name: 'Test connection', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Bucket accessible. Activation still requires verified source-object write and read.');
  await page.getByRole('button', { name: 'Activate', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Change future CI source storage' })).toBeVisible(); await expect(page.getByText('New runs will use this destination;', { exact: false })).toBeVisible(); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation'); await page.getByRole('button', { name: 'Verify and activate source storage', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Existing source bindings are preserved'); expect(state.tests).toHaveLength(1); expect(state.activations).toHaveLength(1); expect(state.activations[0]!.expectedVersion).toBe('3'); expect(state.activations[0]!.expectedActiveRevision).toBe('7');
});
test('unknown save clears secrets and blocks retries until explicit inspection', async ({ page }) => {
  const state = await backend(page); state.dropped = true; await page.goto('/admin/settings/infrastructure'); await page.getByRole('button', { name: 'Add database profile', exact: true }).click();
  await page.getByLabel('Profile label', { exact: true }).fill('Remote Golf'); await page.getByLabel('Endpoint', { exact: true }).fill('db.example:5432'); await page.getByLabel('Database password', { exact: true }).fill('private-database-password'); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation'); await page.getByRole('button', { name: 'Save connection profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspect current configuration' })).toBeVisible(); await expect(page.getByLabel('Database password', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add database profile', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh and inspect connections', exact: true }).click(); await expect(page.getByRole('button', { name: 'Add database profile', exact: true })).toBeEnabled(); expect(state.writes).toHaveLength(1);
});

test('administration denial removes cached private profiles and editor controls', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings/infrastructure'); await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation'); state.denied = true;
  await page.getByRole('button', { name: 'Save connection profile', exact: true }).click(); await expect(page.getByRole('alert').first()).toContainText('Administrator session');
  await expect(page.getByRole('table', { name: 'Object-storage profiles', exact: true })).toHaveCount(0); await expect(page.getByLabel('Golf administrator password', { exact: true })).toHaveCount(0); await expect(page.getByText('Private source storage', { exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});

test('object-storage Add has its own provider editor and clears cancelled secrets', async ({ page }) => {
  await backend(page); await page.goto('/admin/settings/infrastructure');
  await page.getByRole('button', { name: 'Add object-storage profile', exact: true }).click();
  await expect(page.getByLabel('Object-storage backend', { exact: true })).toHaveValue('RUSTFS');
  await expect(page.getByLabel('Database password', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Connection type', { exact: true })).toHaveCount(0);
  await page.getByLabel('Secret access key', { exact: true }).fill('private-source-key');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add object-storage profile', exact: true }).click();
  await expect(page.getByLabel('Secret access key', { exact: true })).toHaveValue('');
});
test('saved database profiles cannot activate a live pool and current storage is marked explicitly', async ({ page }) => {
  const state = await backend(page); state.activeVersion = '3';
  state.profiles.push(create(InfrastructureConnectionSchema, { id: '12345678-1234-4234-8234-123456789abe', version: '1', label: 'Remote database candidate', kind: 'DATABASE', databaseRole: 'GOLF', backend: 'POSTGRESQL', endpoint: 'db.example:5432', databaseName: 'golf' }));
  await page.goto('/admin/settings/infrastructure');
  const databases = page.getByRole('table', { name: 'Database profiles', exact: true });
  await expect(databases.getByText('Saved · cutover required', { exact: true })).toBeVisible();
  await expect(databases.getByRole('button', { name: 'Activate', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Current databases', exact: true }).getByText('Current Golf database', { exact: true })).toHaveClass(/available/);
  const storage = page.getByRole('table', { name: 'Object-storage profiles', exact: true });
  await expect(storage.getByText('Active for new CI sources', { exact: true })).toHaveClass(/available/);
  await expect(storage.getByRole('button', { name: 'Activate', exact: true })).toBeDisabled();
});
test('page hiding discards infrastructure credentials without submitting', async ({ page }) => {
  const state = await backend(page); await page.goto('/admin/settings/infrastructure');
  await page.getByRole('button', { name: 'Add database profile', exact: true }).click();
  await page.getByLabel('Database password', { exact: true }).fill('private-database-password');
  await page.getByLabel('Golf administrator password', { exact: true }).fill('private-confirmation');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('Database password', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('historical active storage uses its actual endpoint rather than latest saved settings', async ({ page }) => {
  const state = await backend(page);
  state.activeConnection = create(InfrastructureConnectionSchema, { ...state.profiles[0]!, version: '2', label: 'Original source store', endpoint: 'https://old-storage.example', bucket: 'original-sources', activationState: 'active_ci_source_storage' });
  await page.goto('/admin/settings/infrastructure');
  const active = page.getByRole('table', { name: 'Active source storage', exact: true });
  await expect(active.getByText('https://old-storage.example', { exact: true })).toBeVisible();
  await expect(active.getByText('Current CI source storage', { exact: true })).toHaveClass(/available/);
  await expect(active.getByText('http://rustfs:9000', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Object-storage profiles', exact: true }).getByText('Version 2 active · latest saved', { exact: true })).toBeVisible();
});
