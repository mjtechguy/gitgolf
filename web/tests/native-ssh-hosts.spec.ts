import { expect, test, type Page } from '@playwright/test';
import { GetAuthenticationOptionsResponseSchema, GetSessionResponseSchema, ListCapabilitiesResponseSchema } from '../src/gen/golf/v1/golf_pb';
import { reject, respond } from './rpc';

// SSH hosts on the Cloudflare-native runtime (docs/SSH_HOSTS.md): the inventory under Settings → Agent hosts, Add SSH host, Golf's key
// to install, a connection test, the explicit host key confirmation and the honest unavailable state, against a mocked /native/ssh-hosts.
const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRMAdyeKR8mZT0OP3jfTN0ZIUBksTbcmzR6xy1iD7sh golf-ssh-host-1a2b3c4d';
const fingerprint = 'SHA256:F3K/q8z3vZ6xybxm9ahmCtQ5TmLyRYs2OcbA+TDFf5s';
const reachesReady = { direct: { available: true, reason: '' }, tailscale: { available: true, reason: '' }, 'cloudflare-tunnel': { available: true, reason: '' },
  'workers-vpc': { available: false, reason: 'Needs a Workers VPC network binding named SSH_VPC_NETWORK on this Worker.' } };
const probe = (extra: Record<string, unknown> = {}) => ({ state: 'NONE', startedAt: '', finishedAt: '', offered: null as null | { key: string; type: string; fingerprint: string }, matched: null, authenticated: null, os: '', arch: '', toolCount: 0, error: '', ...extra });
const host = (extra: Record<string, unknown> = {}) => ({ id: '9', uuid: '1a2b3c4d-0000-4000-8000-000000000009', name: 'gpu-box', scope: 'personal', scopeId: '17', state: 'ACTIVE', online: false, lastSeenAt: '',
  shareSignins: false, allowedUsers: [], allowedRepositories: [], enabledTools: ['codex', 'claude', 'opencode', 'grok'], maxConcurrent: 1, hostVersion: 'ssh', os: '', arch: '', tools: [], activeTasks: 0, version: 1,
  kind: 'ssh', address: 'gpu.example.net', port: 22, user: 'golf-agent', workDirectory: '', reach: 'direct', reachAvailable: true, reachReason: '', tailscale: null, tunnel: null,
  publicKey, keyFingerprint: 'SHA256:1O1ZhxMHUNGvTxERxXv4yXox/IFqNXLBn5aB7d4hWYM', hostKey: { pinned: false, fingerprint: '', type: '', pinnedAt: '', pinnedBy: '' }, probe: probe(),
  ready: false, readyReason: 'Test the connection and confirm the host key fingerprint before assigning tasks.', ...extra });

async function backend(page: Page, { ready = true } = {}) {
  const state = { hosts: [] as ReturnType<typeof host>[], calls: [] as Record<string, unknown>[], lists: 0 };
  await page.route('**/rpc/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex', isInstanceAdmin: true } });
    if (method === 'GetAuthenticationOptions') return respond(route, GetAuthenticationOptionsResponseSchema, {});
    if (method === 'ListCapabilities') return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'agents.hosts', label: 'Agent hosts', state: 3, reason: 'Schema present.' },
      { id: 'agents.ssh-hosts', label: 'Coding agents on SSH hosts', state: ready ? 3 : 2, reason: ready ? 'Ready.' : 'SSH hosts are unavailable on this installation: it needs the SSHAgentTask Durable Object with its SSH container (SSH_HOSTS_EXECUTION).' }] });
    return reject(route, 'unimplemented', 'Fixture procedure not supplied.');
  });
  await page.route('**/native/**', async route => {
    const path = new URL(route.request().url()).pathname, body = (route.request().postDataJSON() || {}) as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/native/config') return json({ runtimeProfile: 'cloudflare-native', workspace: 'alex', pipelines: false, evidence: false, tests: false, agents: false, advice: false, previews: false, apps: false });
    if (path === '/native/agent-hosts') return json({ hosts: [], tokens: [], canManage: true });
    if (path !== '/native/ssh-hosts') return json({ code: 'unimplemented', message: 'Fixture route not supplied.' }, 501);
    state.calls.push(body);
    const find = () => state.hosts.find(h => h.id === body.id)!;
    if (body.action === 'list') {
      // A running test reports on the next read: the first time with the offered key, once pinned with tools.
      for (const h of state.hosts) if (h.probe.state === 'RUNNING') Object.assign(h, h.hostKey.pinned
        ? { probe: probe({ state: 'SUCCEEDED', finishedAt: at(0), offered: { key: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint }, matched: true, authenticated: true, os: 'linux', arch: 'amd64', toolCount: 1 }),
          online: true, ready: true, readyReason: '', os: 'linux', arch: 'amd64', tools: [{ tool: 'claude', version: '2.1.5', signedIn: true, account: 'claude.ai' }] }
        : { probe: probe({ state: 'SUCCEEDED', finishedAt: at(0), offered: { key: 'ssh-ed25519 AAAA', type: 'ssh-ed25519', fingerprint } }) });
      return json({ hosts: state.hosts, canManage: true, reaches: ready ? reachesReady : Object.fromEntries(Object.keys(reachesReady).map(reach => [reach, { available: false, reason: 'Needs the SSHAgentTask Durable Object.' }])),
        capability: { id: 'agents.ssh-hosts', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_UNCONFIGURED', reason: ready ? 'Ready.' : 'SSH hosts are unavailable on this installation: it needs the SSHAgentTask Durable Object with its SSH container (SSH_HOSTS_EXECUTION).' } });
    }
    if (body.action === 'create') {
      const created = host({ name: body.name, address: body.address, port: body.port, user: body.user, reach: body.reach,
        ...(body.reach === 'tailscale' ? { tailscale: { tags: (body.tailscale as { tags: string[] }).tags, ephemeral: true, authKeySet: true } } : {}) });
      state.hosts.push(created);
      return json({ host: created, publicKey, authorizedKey: 'restrict ' + publicKey, installCommand: `umask 077 && mkdir -p ~/.ssh && printf '%s\\n' 'restrict ${publicKey}' >> ~/.ssh/authorized_keys` });
    }
    if (body.action === 'test') { Object.assign(find(), { probe: probe({ state: 'RUNNING', startedAt: at(0) }) }); return json({ host: find() }); }
    if (body.action === 'trustHostKey') {
      const h = find();
      if (body.fingerprint !== h.probe.offered?.fingerprint) return json({ code: 'failed_precondition', message: 'That fingerprint is not the one the latest connection test was offered.' }, 412);
      Object.assign(h, { hostKey: { pinned: true, fingerprint, type: 'ssh-ed25519', pinnedAt: at(0), pinnedBy: 'alex' }, version: h.version + 1 });
      return json({ host: h });
    }
    return json({ code: 'unimplemented', message: 'Fixture action not supplied.' }, 501);
  });
  return state;
}
const sshTable = (page: Page) => page.getByRole('table', { name: 'SSH hosts' });

test('SSH hosts lead with the inventory; Add opens the form, shows Golf’s key once, and the host key is pinned only after review', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/agents');
  await expect(page.getByRole('heading', { name: 'SSH hosts' })).toBeVisible();
  await expect(sshTable(page)).toContainText('No SSH hosts yet');
  await expect(page.getByRole('form', { name: 'Add SSH host' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add SSH host' }).click();
  const form = page.getByRole('form', { name: 'Add SSH host' });
  await form.getByLabel('Name').fill('gpu-box');
  await form.getByLabel('Address').fill('gpu.example.net');
  await form.getByLabel('Account').fill('golf-agent');
  await expect(form.getByRole('option', { name: 'Workers VPC (unavailable)' })).toHaveAttribute('disabled', '');
  await form.getByRole('button', { name: 'Add SSH host' }).click();
  await expect.poll(() => state.calls.find(call => call.action === 'create')).toMatchObject({ scope: 'personal', name: 'gpu-box', address: 'gpu.example.net', port: 22, user: 'golf-agent', reach: 'direct', enabledTools: ['codex', 'claude', 'opencode', 'grok'] });
  const install = page.getByRole('region', { name: 'Install Golf’s key' });
  await expect(install).toContainText('restrict ' + publicKey);
  await install.getByRole('button', { name: 'Test connection' }).click();
  await expect.poll(() => state.calls.filter(call => call.action === 'test').length).toBe(1);
  const row = sshTable(page).getByRole('row').filter({ hasText: 'gpu-box' });
  await expect(row).toContainText('golf-agent@gpu.example.net:22');
  await page.getByRole('button', { name: 'Refresh SSH hosts' }).click();
  await expect(row).toContainText('Host key to confirm');
  await row.getByRole('button', { name: 'Review the host key of gpu-box' }).click();
  const review = page.getByRole('region', { name: 'Host key of gpu-box' });
  await expect(review).toContainText(fingerprint);
  await expect(review).toContainText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
  await review.getByRole('button', { name: 'Trust this host key' }).click();
  await expect.poll(() => state.calls.find(call => call.action === 'trustHostKey')).toMatchObject({ id: '9', fingerprint });
  await expect.poll(() => state.calls.filter(call => call.action === 'test').length).toBe(2);
  await page.getByRole('button', { name: 'Refresh SSH hosts' }).click();
  await expect(row).toContainText('Ready');
  await expect(row).toContainText(fingerprint.slice(0, 18));
  await expect(row.getByTitle(fingerprint)).toBeVisible();
  await expect(row).toContainText('Claude Code');
  await expect(row).toContainText('Confirmed by alex');
});

test('the reach decides the fields: Tailscale asks for an auth key and tags, sent once and never shown again', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/account/agents');
  await page.getByRole('button', { name: 'Add SSH host' }).click();
  const form = page.getByRole('form', { name: 'Add SSH host' });
  await expect(form.getByLabel('Tailscale auth key')).toHaveCount(0);
  await form.getByLabel('Reach').selectOption('tailscale');
  await expect(form).toContainText('ephemeral node');
  await form.getByLabel('Name').fill('lab');
  await form.getByLabel('Address').fill('lab.tail1234.ts.net');
  await form.getByLabel('Account').fill('agent');
  await form.getByLabel('Tailscale auth key').fill('tskey-auth-k1234567890-SECRET');
  await form.getByLabel('Tags').fill('tag:golf-agent, tag:lab');
  await form.getByRole('checkbox', { name: /Grok/ }).uncheck();
  await form.getByRole('button', { name: 'Add SSH host' }).click();
  await expect.poll(() => state.calls.find(call => call.action === 'create')).toMatchObject({ reach: 'tailscale', tailscale: { authKey: 'tskey-auth-k1234567890-SECRET', tags: ['tag:golf-agent', 'tag:lab'] }, enabledTools: ['codex', 'claude', 'opencode'] });
  await page.getByRole('button', { name: 'Done' }).click();
  const row = sshTable(page).getByRole('row').filter({ hasText: 'lab' });
  await expect(row).toContainText('Tailscale');
  await expect(row).toContainText('tag:golf-agent, tag:lab');
  await expect(page.locator('body')).not.toContainText('SECRET');
});

test('without the SSH container allocation the page says why and Add is off', async ({ page }) => {
  await backend(page, { ready: false });
  await page.goto('/account/agents');
  await expect(page.getByRole('heading', { name: 'SSH hosts' })).toBeVisible();
  await expect(page.getByText('SSH hosts are unavailable on this installation: it needs the SSHAgentTask Durable Object')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add SSH host' })).toBeDisabled();
});
