import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { AddRepositoryDeployKeyRequestSchema, AddRepositoryDeployKeyResponseSchema, DeleteRepositoryDeployKeyRequestSchema, DeleteRepositoryDeployKeyResponseSchema, GetAuthenticationOptionsResponseSchema, GetRepositoryAccessResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema, ListRepositoryCollaboratorsResponseSchema, ListRepositoryDeployKeysRequestSchema, ListRepositoryDeployKeysResponseSchema, LogoutResponseSchema, RepositoryAccessSchema, RepositoryDeployKeySchema, UserSchema } from '../src/gen/golf/v1/golf_pb';
import { emptyRepositoryInvitations, reject, request, respond } from './rpc';
const keyText = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
const fingerprint = `SHA256:${'A'.repeat(43)}`;
const initial = create(RepositoryDeployKeySchema, { id: '9007199254740995', publicKeyId: '9007199254740996', title: 'Deployment', publicKey: keyText, fingerprint, createdAt: '2026-10-03T12:00:00Z', readOnly: true, revision: 'b'.repeat(64) });
async function backend(page: Page) {
  const state = { signedIn: true, user: create(UserSchema, { id: '17', login: 'maintainer', isInstanceAdmin: true }), access: create(RepositoryAccessSchema, { owner: { id: '9007199254740993', login: 'alex' }, ownerId: '9007199254740993', repositoryId: '9007199254740994', canManage: true, currentPermission: 'admin', revision: 'a'.repeat(64) }), keys: [initial], pages: [] as number[], writes: [] as unknown[], denied: false, malformed: false, duplicate: false, lost: false, badReceipt: false, barrier: undefined as Promise<void> | undefined };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, { localPasswordEnabled: true });
    if (method === 'Logout') { state.signedIn = false; return respond(route, LogoutResponseSchema, {}); }
    if (!state.signedIn) return reject(route, 'unauthenticated', 'Your session ended.');
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: state.user });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'ListRepositoryInvitations') return emptyRepositoryInvitations(route);
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: state.access });
    if (method === 'ListRepositoryCollaborators') return respond(route, ListRepositoryCollaboratorsResponseSchema, { collaborators: [], page: { nextPage: 0 } });
    if (method === 'ListRepositoryDeployKeys') {
      const input = request(route, ListRepositoryDeployKeysRequestSchema); expect(input.repositoryId).toBe(state.access.repositoryId); expect(input.ownerId).toBe(state.access.ownerId); expect(input.expectedRevision).toBe(state.access.revision); expect(input.page?.limit).toBe(20);
      const pageNumber = input.page?.page || 1; state.pages.push(pageNumber);
      if (state.denied) return reject(route, 'permission_denied', 'Deploy-key access denied.');
      return respond(route, ListRepositoryDeployKeysResponseSchema, { repositoryId: state.access.repositoryId, ownerId: state.access.ownerId, accessRevision: state.access.revision, keys: state.malformed ? [{ ...initial, id: '9223372036854775808' }] : state.duplicate && pageNumber > 1 ? [initial] : state.keys.slice((pageNumber - 1) * 1, pageNumber * 1), page: { nextPage: state.keys.length > pageNumber ? pageNumber + 1 : 0 } });
    }
    if (method === 'AddRepositoryDeployKey') {
      const input = request(route, AddRepositoryDeployKeyRequestSchema); state.writes.push(input); expect(input.readOnly).toBeDefined();
      const key = create(RepositoryDeployKeySchema, { ...initial, id: '9007199254740997', publicKeyId: initial.publicKeyId, title: input.title, readOnly: input.readOnly!, revision: 'c'.repeat(64) }); state.keys.push(key);
      if (state.barrier) await state.barrier;
      if (state.lost) return route.abort('failed');
      return respond(route, AddRepositoryDeployKeyResponseSchema, { repositoryId: state.badReceipt ? '18' : input.repositoryId, ownerId: input.ownerId, accessRevision: input.expectedRevision, key });
    }
    if (method === 'DeleteRepositoryDeployKey') {
      const input = request(route, DeleteRepositoryDeployKeyRequestSchema); state.writes.push(input); expect(input.keyId).toBe(initial.id); expect(input.keyId).not.toBe(initial.publicKeyId); expect(input.expectedKeyRevision).toBe(initial.revision);
      state.keys = state.keys.filter((key) => key.id !== input.keyId); if (state.lost) return route.abort('failed');
      return respond(route, DeleteRepositoryDeployKeyResponseSchema, { keyId: input.keyId, repositoryId: input.repositoryId, ownerId: input.ownerId, accessRevision: input.expectedRevision });
    }
    return reject(route, 'not_found', 'No fixture for this procedure.');
  });
  return state;
}
async function open(page: Page) { await page.goto('/alex/project/settings/access'); await expect(page.getByRole('table', { name: 'Repository deploy keys', exact: true })).toBeVisible(); }
async function editor(page: Page) { await page.getByRole('button', { name: 'Add deploy key', exact: true }).click(); const form = page.getByRole('form', { name: 'Add repository deploy key', exact: true }); await expect(form.getByLabel('Title', { exact: true })).toBeFocused(); await form.getByLabel('Title', { exact: true }).fill('Build integration'); await form.getByLabel('Public SSH key', { exact: true }).fill(`${keyText} local comment`); return form; }
test('explicit Add defaults to read-only and keeps exact native repository and public-key identities', async ({ page }) => {
  const state = await backend(page); await open(page); await expect(page.getByRole('form', { name: 'Add repository deploy key' })).toHaveCount(0);
  const form = await editor(page); await expect(form.getByLabel('Allow write access')).not.toBeChecked(); await form.getByRole('button', { name: 'Add deploy key', exact: true }).click(); await expect(page.getByText('Deploy key added.', { exact: true })).toBeVisible();
  expect(state.writes).toMatchObject([{ repositoryId: state.access.repositoryId, ownerId: state.access.ownerId, expectedRevision: state.access.revision, readOnly: true }]);
  await expect(page.getByRole('form', { name: 'Add repository deploy key' })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});
test('write access requires an explicit checkbox and the saved grant retains that choice', async ({ page }) => {
  const state = await backend(page); await open(page); const form = await editor(page); await form.getByLabel('Allow write access').check(); await expect(form.getByText(/This key can push/)).toBeVisible(); await form.getByRole('button', { name: 'Add deploy key', exact: true }).click(); await expect(page.getByText('Deploy key added.', { exact: true })).toBeVisible(); expect(state.writes).toMatchObject([{ readOnly: false }]);
  await page.getByRole('button', { name: 'Load more deploy keys', exact: true }).click(); await expect(page.getByRole('table', { name: 'Repository deploy keys' }).getByText('Read/write', { exact: true })).toBeVisible();
});
test('remove confirmation uses the association ID and supports Escape with restored focus', async ({ page }) => {
  const state = await backend(page); await open(page); const remove = page.getByRole('button', { name: 'Remove deploy key Deployment', exact: true }); await remove.click(); await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(remove).toBeFocused(); expect(state.writes).toHaveLength(0);
  await remove.click(); await page.getByRole('button', { name: 'Confirm remove deploy key', exact: true }).click(); await expect(page.getByText('Deploy key removed.', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1); await expect(page.getByRole('table', { name: 'Repository deploy keys' }).getByText('Deployment', { exact: true })).toHaveCount(0);
});
for (const kind of ['lost addition', 'lost removal', 'wrong receipt'] as const) test(`${kind} blocks fresh writes until explicit inspection without retry`, async ({ page }) => {
  const state = await backend(page); await open(page); state.lost = kind !== 'wrong receipt'; state.badReceipt = kind === 'wrong receipt';
  if (kind === 'lost removal') { await page.getByRole('button', { name: 'Remove deploy key Deployment', exact: true }).click(); await page.getByRole('button', { name: 'Confirm remove deploy key', exact: true }).click(); }
  else { const form = await editor(page); await form.getByRole('button', { name: 'Add deploy key', exact: true }).click(); }
  await expect(page.getByRole('heading', { name: 'Deploy-key change could not be confirmed', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Add deploy key', exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh deploy keys', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Deploy-key change could not be confirmed', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add deploy key', exact: true })).toBeEnabled(); expect(state.writes).toHaveLength(1);
});
test('current denial clears private rows and open editors instead of rendering stale inventory', async ({ page }) => {
  const state = await backend(page); await open(page); await editor(page); state.denied = true; await page.getByRole('button', { name: 'Refresh deploy keys', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Deploy-key access denied.'); await expect(page.getByRole('table', { name: 'Repository deploy keys' })).toHaveCount(0); await expect(page.getByRole('form', { name: 'Add repository deploy key' })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});
test('malformed IDs and duplicate associations across pages fail closed', async ({ page }) => {
  const state = await backend(page); state.malformed = true; await page.goto('/alex/project/settings/access'); await expect(page.getByRole('alert')).toHaveText('Deploy-key metadata is incomplete.'); await expect(page.getByRole('table', { name: 'Repository deploy keys' })).toHaveCount(0);
  state.malformed = false; state.keys.push(create(RepositoryDeployKeySchema, { ...initial, id: '9007199254740997', title: 'Other' })); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(page.getByRole('table', { name: 'Repository deploy keys' })).toBeVisible(); state.duplicate = true; await page.getByRole('button', { name: 'Load more deploy keys', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Deploy-key inventory changed across pages. Refresh and inspect again.'); await expect(page.getByRole('table', { name: 'Repository deploy keys' })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});
for (const kind of ['reader', 'organization', 'exceptional owner'] as const) test(`${kind} never gets deploy-key administration from a Golf global-admin role`, async ({ page }) => {
  const state = await backend(page); state.access.currentPermission = kind === 'exceptional owner' ? 'owner' : 'read'; state.access.canManage = kind === 'exceptional owner'; state.access.organizationOwned = kind === 'organization'; await page.goto('/alex/project/settings/access'); await expect(page.getByRole('heading', { name: 'Repository access', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Deploy keys', exact: true })).toHaveCount(0); expect(state.pages).toHaveLength(0); expect(state.writes).toHaveLength(0);
});
test('sign-out and late accepted writes cannot restore editor data or confirmation receipts', async ({ page }) => {
  const state = await backend(page); await open(page); const form = await editor(page); let release!: () => void; state.barrier = new Promise<void>((resolve) => { release = resolve; }); await form.getByRole('button', { name: 'Add deploy key', exact: true }).click(); await expect.poll(() => state.writes.length).toBe(1); await page.getByLabel('Your account', { exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); release(); await expect(page.getByRole('heading', { name: 'Welcome to Golf', exact: true })).toBeVisible(); await expect(page.getByRole('table', { name: 'Repository deploy keys' })).toHaveCount(0); await expect(page.getByText('Deploy key added.', { exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(1);
});
for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`${theme} ${width} shares dense table and explicit editor without page overflow`, async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem('golf.theme', value), theme); await backend(page); await page.setViewportSize({ width, height: 950 }); await open(page); await editor(page); await expect(page.locator('html')).toHaveAttribute('data-theme', theme); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: `.tmp/deploy-key-source-captures/${theme}-${width}.png`, fullPage: true }); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('button', { name: 'Add deploy key', exact: true })).toBeFocused();
});

test('obvious private keys and multiple public keys never cross the RPC boundary', async ({ page }) => {
 const state = await backend(page); await open(page); const form = await editor(page);
 for (const value of ['-----BEGIN OPENSSH PRIVATE KEY-----', `${keyText}\n${keyText}`]) { await form.getByLabel('Public SSH key', { exact: true }).fill(value); await form.getByRole('button', { name: 'Add deploy key', exact: true }).click(); await expect(form.getByRole('alert')).toHaveText('Enter a title and one OpenSSH public key. Never paste a private key.'); expect(state.writes).toHaveLength(0); }
});
