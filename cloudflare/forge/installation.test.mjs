import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { handle, digest, concurrentRead } from './src/core.mjs';

const origin = 'https://golf.example.com', storeId = 'f'.repeat(32), audience = 'access-audience-tag-0123456789';
async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,email,can_create) VALUES(1,'owner','owner@example.invalid',1),(2,'creator','creator@example.invalid',1); INSERT INTO operations_admins(user_id) VALUES(1)");
  let revokeOn = '';
  const statement = (query) => { const s = sql.prepare(query); let args = []; const after = () => { if (revokeOn && query.includes(revokeOn)) { revokeOn = ''; sql.exec('UPDATE operations_admins SET active=0'); } };
    return { query, bind(...values) { args = values; return this; }, async first() { const r = s.get(...args) || null; after(); return r; }, async all() { const results = s.all(...args); after(); return { results }; },
      async run() { const r = s.run(...args); after(); return { meta: { changes: r.changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement, async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(/^\s*(SELECT|PRAGMA)/i.test(s.query) ? { ...(await s.all()), meta: { changes: 0 } } : { results: [], ...(await s.run()) }); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'workspace', ACCOUNT_ID: 'a'.repeat(32), ACCESS_AUD: audience, ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    WEBHOOK_POLICY: JSON.stringify({ origins: ['https://hooks.example.net', 'https://ci.example.org'], dailyLimit: 300 }), WEBHOOK_KEY: { get() {} },
    EMAIL_POLICY: JSON.stringify({ sender: 'golf@mail.example.com', dailyLimit: 200 }), EMAIL: { send() {} }, EXECUTION_VALUE_KEY: { get() {} },
    APP_POLICY: JSON.stringify({ namespace: 'apps', entry: 'app/main.mjs', migration: 'app/schema.sql', ttl: 600, zone: 'b'.repeat(32), gateway: 'gate', outbound: 'out', secret: { store: storeId, name: 'APP_SECRET_NAME' } }),
    PUBLIC_REPOSITORIES: 'true', ANONYMOUS_READ_LIMIT: 'nonsense', ANONYMOUS_READS: { limit() {} } };
  const call = (email = 'owner@example.invalid', headers = {}, body = { action: 'read' }, path = '/native/installation/read') => handle(new Request(origin + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(email ? { 'X-Golf-Native-Access-Email': email } : {}), ...headers }, body: JSON.stringify(body) }), env);
  return { sql, env, call, revokeOn(text) { revokeOn = text; } };
}

test('the installation overview is for current operations administrators signed in through Access only', async t => {
  const f = await fixture(t);
  assert.equal(concurrentRead(new Request(origin + '/native/installation/read', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + '/native/installation', { method: 'POST' })), false);
  assert.equal((await f.call('creator@example.invalid')).status, 403);
  assert.equal((await f.call('outsider@example.invalid')).status, 401);
  assert.equal((await f.call('')).status, 401);
  assert.equal((await f.call('owner@example.invalid', { 'CF-Access-Client-Id': 'service-token', 'CF-Access-Client-Secret': 'x' })).status, 403);
  const token = 'golf_native_' + 'b'.repeat(43);
  f.sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), 1, Math.floor(Date.now() / 1000) + 100);
  assert.equal((await f.call('', { Authorization: 'Bearer ' + token })).status, 403);
  assert.equal((await f.call('owner@example.invalid', {}, { action: 'read' }, '/native/installation')).status, 400);
  f.revokeOn('FROM webhook_daily');
  const revoked = await f.call();
  assert.equal(revoked.status, 403); assert.ok(!Object.hasOwn(await revoked.json(), 'groups'));
});

test('the overview reports held values and today’s use, never secret references or the Access audience', async t => {
  const f = await fixture(t), today = new Date().toISOString().slice(0, 10);
  f.sql.prepare('INSERT INTO webhook_daily(day,attempts) VALUES(?,17)').run(today);
  const response = await f.call(); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json(), text = JSON.stringify(data), find = id => data.groups.flatMap(group => group.items).find(item => item.id === id);
  assert.equal(data.workspace, 'workspace'); assert.equal(data.publicOrigin, origin); assert.equal(data.schema, 29); assert.equal(data.release, 'development');
  assert.deepEqual(data.groups.map(group => group.id), ['installation', 'automation', 'integrations', 'operations']);
  const hooks = find('webhooks'); assert.equal(hooks.state, 'configured'); assert.equal(hooks.capability, 'settings.repository-webhooks');
  assert.deepEqual(hooks.values[0], { label: 'Approved origins', value: 'https://hooks.example.net\nhttps://ci.example.org' });
  assert.equal(hooks.values[1].usage, '17 of 300 used today'); assert.deepEqual(hooks.change, { settingsKey: 'webhooks', alchemy: 'enable-webhooks --origin' });
  assert.equal(find('email').values[0].value, 'golf@mail.example.com'); assert.equal(find('email').values[1].usage, '0 of 200 used today');
  assert.equal(find('rate-limit').state, 'refused'); assert.equal(find('apps').state, 'refused'); assert.equal(find('evidence').state, 'unallocated');
  assert.equal(find('access').values[1].value, 'Configured (not shown)'); assert.equal(find('secrets').values[0].value, 'Bound (value never shown)');
  for (const secret of [audience, storeId, 'APP_SECRET_NAME', 'owner@example.invalid']) assert.ok(!text.includes(secret), secret);
});

test('diagnostics and the operations dashboard read the same schema and name the Secrets Store and Email Service bindings', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.call('owner@example.invalid', {}, {}, '/native/diagnostics')).json()).schema, 29);
  delete f.env.WEBHOOK_KEY; delete f.env.APP_POLICY;
  const data = await (await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.OperationsService/GetOperationsDashboard')).json();
  assert.equal(data.services.find(row => row.id === 'secrets').state, 'configured');
  assert.equal(data.services.find(row => row.id === 'email').state, 'configured');
  f.sql.prepare("INSERT INTO email_acceptance(sender,delivery_id,accepted_at) VALUES('golf@mail.example.com','d','2026-10-14T10:00:00.000Z')").run();
  const observed = (await (await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.OperationsService/GetOperationsDashboard')).json()).services.find(row => row.id === 'email');
  assert.equal(observed.state, 'observed'); assert.equal(observed.checkedAt, '2026-10-14T10:00:00.000Z');
  const capabilities = (await (await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.CapabilityService/ListCapabilities')).json()).capabilities;
  for (const id of ['settings.execution', 'settings.organization-creation', 'settings.agents-admin']) { const row = capabilities.find(c => c.id === id); assert.equal(row.state, 'CAPABILITY_STATE_DISABLED'); assert.match(row.reason, /Cloudflare native has no/); }
  assert.match(capabilities.find(c => c.id === 'settings.native').reason, /Secret values are never shown/);
});
