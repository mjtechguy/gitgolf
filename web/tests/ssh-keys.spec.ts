import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { create } from '@bufbuild/protobuf';
import { AddSSHKeyRequestSchema, AddSSHKeyResponseSchema, DeleteSSHKeyRequestSchema, DeleteSSHKeyResponseSchema,
  GetSessionResponseSchema, ListSSHKeysResponseSchema, ListCapabilitiesResponseSchema, ListRepositoriesResponseSchema,
  LogoutResponseSchema, SSHKeySchema } from '../src/gen/golf/v1/golf_pb';
import { reject, request, respond } from './rpc';

async function backend(page: Page) {
  const state = { adds: 0, removed: [] as string[], lost: false, denied: false,
    keys: [create(SSHKeySchema, { id: '9007199254740993', title: 'My laptop', publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:fixture', createdAt: '2026-10-02T12:00:00Z', lastUsedAt: '2026-10-02T12:00:00Z' })] };
  await page.route('**/rpc/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id:'42', login:'alex' } });
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, {});
    if (method === 'ListRepositories') return respond(route, ListRepositoriesResponseSchema, {});
    if (method === 'Logout') return respond(route, LogoutResponseSchema, {});
    if (method === 'ListSSHKeys') {
      if (state.denied) return reject(route, 'permission_denied', 'Access denied.');
      return respond(route, ListSSHKeysResponseSchema, { keys:state.keys, page:{} });
    }
    if (method === 'AddSSHKey') {
      state.adds++;
      const input = request(route, AddSSHKeyRequestSchema);
      const key = create(SSHKeySchema, { ...state.keys[0]!, id:'9007199254740994', title:input.title, publicKey:input.publicKey });
      state.keys.unshift(key);
      if (state.lost) return route.abort('failed');
      return respond(route, AddSSHKeyResponseSchema, { key });
    }
    if (method === 'DeleteSSHKey') {
      const id = request(route, DeleteSSHKeyRequestSchema).keyId;
      state.removed.push(id); state.keys = state.keys.filter((key) => key.id !== id);
      return respond(route, DeleteSSHKeyResponseSchema, {});
    }
    return reject(route, 'not_found', 'Unknown fixture method.');
  });
  return state;
}

async function open(page: Page) {
  await page.goto('/account/ssh-keys');
  await expect(page.getByRole('heading', { name:'My laptop', exact:true })).toBeVisible();
  await expect(page.locator('.topbar')).toContainText('SSH keys');
}

test('key removal preserves exact IDs and requires confirmation', async ({ page }) => {
  const state = await backend(page); await open(page);
  await page.getByRole('button', { name:'Remove My laptop', exact:true }).click();
  await page.getByRole('button', { name:'Cancel', exact:true }).click();
  expect(state.removed).toEqual([]);
  await page.getByRole('button', { name:'Remove My laptop', exact:true }).click();
  await page.getByRole('button', { name:'Confirm remove key', exact:true }).click();
  await expect(page.getByRole('status')).toHaveText('SSH key removed.');
  expect(state.removed).toEqual(['9007199254740993']);
  await expect(page.getByRole('heading', { name:'My laptop', exact:true })).toHaveCount(0);
});

test('a lost addition never retries automatically and requires refreshing the real result', async ({ page }) => {
  const state = await backend(page); state.lost = true; await open(page);
  await page.getByLabel('Key title', { exact:true }).fill('New laptop');
  await page.getByLabel('Public key', { exact:true }).fill('ssh-ed25519 AAAA');
  await page.getByRole('button', { name:'Add SSH key', exact:true }).click();
  await expect(page.getByRole('alert').filter({ hasText:'may already have completed' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Add SSH key', exact:true })).toBeDisabled();
  expect(state.adds).toBe(1);
  await page.getByRole('button', { name:'Refresh SSH keys', exact:true }).click();
  await expect(page.getByRole('heading', { name:'New laptop', exact:true })).toBeVisible();
  await expect(page.getByRole('button', { name:'Add SSH key', exact:true })).toBeEnabled();
  expect(state.adds).toBe(1);
});

test('permission failure hides cached keys and disables writes', async ({ page }) => {
  const state = await backend(page); await open(page); state.denied = true;
  await page.getByRole('button', { name:'Refresh SSH keys', exact:true }).click();
  await expect(page.getByRole('alert')).toHaveText('Access denied.');
  await expect(page.getByRole('heading', { name:'My laptop', exact:true })).toHaveCount(0);
  await expect(page.getByRole('button', { name:'Add SSH key', exact:true })).toBeDisabled();
});
