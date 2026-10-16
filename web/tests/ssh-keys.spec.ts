import { portableRuntimeFixture } from './runtime-fixture';
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
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, portableRuntimeFixture);
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
    return reject(route, 'unimplemented', 'Unknown fixture method.');
  });
  return state;
}

async function open(page: Page) {
  await page.goto('/account/ssh-keys');
  await expect(page.getByRole('cell', { name:'My laptop Account Git access', exact:true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'SSH keys', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account settings', exact: true }).getByRole('link', { name: 'SSH keys', exact: true })).toHaveAttribute('aria-current', 'page');
}

test('key removal preserves exact IDs and requires confirmation', async ({ page }) => {
  const state = await backend(page); await open(page);
  await page.getByRole('button', { name:'Remove My laptop', exact:true }).click();
  await page.getByRole('button', { name:'Cancel', exact:true }).click();
  expect(state.removed).toEqual([]);
  await page.getByRole('button', { name:'Remove My laptop', exact:true }).click();
  await page.getByRole('button', { name:'Confirm remove key', exact:true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^SSH key removed\.$/ })).toHaveText('SSH key removed.');
  expect(state.removed).toEqual(['9007199254740993']);
  await expect(page.getByRole('cell', { name:'My laptop Account Git access', exact:true })).toHaveCount(0);
});

test('a lost addition never retries automatically and requires refreshing the real result', async ({ page }) => {
  const state = await backend(page); state.lost = true; await open(page);
  await page.getByRole('button', { name:'New SSH key', exact:true }).click();
  await page.getByLabel('Key title', { exact:true }).fill('New laptop');
  await page.getByLabel('Public key', { exact:true }).fill('ssh-ed25519 AAAA');
  await page.getByRole('button', { name:'Add SSH key', exact:true }).click();
  await expect(page.getByRole('alert').filter({ hasText:'may already have completed' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Add SSH key', exact:true })).toBeDisabled();
  expect(state.adds).toBe(1);
  await page.getByRole('button', { name:'Refresh SSH keys', exact:true }).click();
  await expect(page.getByRole('cell', { name:'New laptop Account Git access', exact:true })).toBeVisible();
  await expect(page.getByRole('button', { name:'Add SSH key', exact:true })).toBeEnabled();
  expect(state.adds).toBe(1);
});

test('permission failure hides cached keys and disables writes', async ({ page }) => {
  const state = await backend(page); await open(page); state.denied = true;
  await page.getByRole('button', { name:'Refresh SSH keys', exact:true }).click();
  await expect(page.getByRole('alert')).toHaveText('Access denied.');
  await expect(page.getByRole('cell', { name:'My laptop Account Git access', exact:true })).toHaveCount(0);
  await expect(page.getByRole('button', { name:'New SSH key', exact:true })).toBeDisabled();
});


test('SSH inventory opens an explicit editor and cancellation discards its values', async ({ page }) => {
  const state = await backend(page); await open(page);
  await expect(page.getByLabel('Key title', { exact:true })).toHaveCount(0);
  const add = page.getByRole('button', { name:'New SSH key', exact:true });
  await add.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Key title', { exact:true })).toBeFocused();
  await page.getByLabel('Key title', { exact:true }).fill('Cancelled key');
  await page.getByLabel('Public key', { exact:true }).fill('ssh-ed25519 AAAA');
  await page.getByRole('button', { name:'Cancel', exact:true }).click();
  await expect(page.getByLabel('Key title', { exact:true })).toHaveCount(0);
  await expect(add).toBeFocused(); expect(state.adds).toBe(0);
  await add.click();
  await expect(page.getByLabel('Key title', { exact:true })).toHaveValue('');
  await expect(page.getByLabel('Public key', { exact:true })).toHaveValue('');
  await page.getByLabel('Key title', { exact:true }).fill('New laptop');
  await page.getByLabel('Public key', { exact:true }).fill('-----BEGIN OPENSSH PRIVATE KEY-----');
  await page.getByRole('button', { name:'Add SSH key', exact:true }).click();
  await expect(page.getByRole('alert')).toContainText('Paste one OpenSSH public key');
  expect(state.adds).toBe(0);
  await page.getByLabel('Public key', { exact:true }).fill('ssh-ed25519 AAAA');
  await page.getByRole('button', { name:'Add SSH key', exact:true }).click();
  await expect(page.getByRole('cell', { name:'New laptop Account Git access', exact:true })).toBeVisible();
  await expect(page.getByLabel('Key title', { exact:true })).toHaveCount(0);
  expect(state.adds).toBe(1);
});


test('shared SSH inventory searches and sorts loaded rows without requesting private data', async ({ page }) => {
  const state = await backend(page);
  state.keys.push(create(SSHKeySchema, { ...state.keys[0]!, id:'9007199254740994', title:'Alpha device', fingerprint:'SHA256:another' }));
  await open(page);
  const table = page.getByRole('table', { name:'SSH keys', exact:true });
  await table.getByRole('button', { name:'Key', exact:true }).click();
  await expect(table.locator('tbody tr[data-row-id]').first()).toHaveAttribute('data-row-id','9007199254740994');
  await expect(table.getByRole('columnheader', { name:'Key', exact:true })).toHaveAttribute('aria-sort','ascending');
  await table.getByRole('button', { name:'Key', exact:true }).click();
  await expect(table.locator('tbody tr[data-row-id]').first()).toHaveAttribute('data-row-id','9007199254740993');
  await page.getByRole('searchbox', { name:'Search loaded SSH keys', exact:true }).fill('ALPHA');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(1);
  await expect(table.getByRole('cell', { name:'Alpha device Account Git access', exact:true })).toBeVisible();
  await expect(page.getByText('1 of 2 loaded', { exact:true })).toBeVisible();
  await page.getByRole('searchbox', { name:'Search loaded SSH keys', exact:true }).fill('not-found');
  await expect(table).toContainText('No loaded entries match your search.');
  await expect(table.locator('tbody tr[data-row-id]')).toHaveCount(0);
  expect(state.removed).toEqual([]); expect(state.adds).toBe(0);
  await page.setViewportSize({ width:320, height:760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
