import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { handle, digest, concurrentRead } from './src/core.mjs';
import { withInstallationPolicy, installationOverlay, auditStatement } from './src/installation.mjs';
import { drainEmail } from './src/email.mjs';
import { anonymousLimit } from './src/rate-limit.mjs';

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
  assert.equal(data.workspace, 'workspace'); assert.equal(data.publicOrigin, origin); assert.equal(data.schema, 53); assert.equal(data.release, 'development');
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
  assert.equal((await (await f.call('owner@example.invalid', {}, {}, '/native/diagnostics')).json()).schema, 53);
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

const allocate = env => Object.assign(env, { EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'workflow', EVIDENCE_DAILY_LIMIT: '20',
  PREVIEW_ORIGIN: 'https://previews.golf.example.com', PREVIEW_PATH: 'site', PREVIEW_ACCESS_AUD: 'preview-audience', PREVIEW_TTL: '3600', ANONYMOUS_READ_LIMIT: '120/60' });
const recent = () => ({ 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000) - 30), 'X-Golf-Native-Access-Colo': 'LHR', 'X-Golf-Native-Access-Country': 'GB' });
const update = (f, key, value, extra = {}, headers = {}, email = 'owner@example.invalid') => f.call(email, headers, { action: 'update', key, value, expectedVersion: '0', operationId: crypto.randomUUID(), ...extra }, '/native/installation');
const json = async response => ({ status: response.status, body: await response.json() });

test('narrowing saves with a receipt and an audit row in one batch; replays return the receipt and stale versions are refused', async t => {
  const f = await fixture(t); allocate(f.env);
  const operationId = crypto.randomUUID(), body = { action: 'update', key: 'webhooks', value: { origins: ['https://ci.example.org'], dailyLimit: 100 }, expectedVersion: '0', operationId };
  const saved = await json(await f.call('owner@example.invalid', {}, body, '/native/installation'));
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.version, '1'); assert.equal(saved.body.widening, false);
  assert.deepEqual(await json(await f.call('owner@example.invalid', {}, body, '/native/installation')), saved);
  assert.equal((await f.call('owner@example.invalid', {}, { ...body, value: { origins: ['https://ci.example.org'], dailyLimit: 99 } }, '/native/installation')).status, 409);
  assert.equal((await update(f, 'webhooks', { origins: ['https://ci.example.org'], dailyLimit: 50 })).status, 412);
  assert.equal((await update(f, 'webhooks', { origins: ['https://ci.example.org'], dailyLimit: 50 }, { expectedVersion: '1' })).status, 200);
  const audit = f.sql.prepare('SELECT * FROM installation_audit ORDER BY id').all();
  assert.equal(audit.length, 2); assert.equal(audit[0].subject, 'webhooks'); assert.equal(audit[0].actor_email, 'owner@example.invalid'); assert.equal(audit[0].widening, 0);
  assert.deepEqual(JSON.parse(audit[0].before).origins, ['https://hooks.example.net', 'https://ci.example.org']);
  const read = (await json(await f.call())).body, hooks = read.groups.flatMap(group => group.items).find(item => item.id === 'webhooks');
  assert.equal(hooks.policy.version, '2'); assert.equal(hooks.policy.source, 'installation'); assert.equal(hooks.values[0].value, 'https://ci.example.org');
  assert.deepEqual(hooks.policy.deploy.origins, ['https://hooks.example.net', 'https://ci.example.org']); assert.equal(read.recent.length, 2); assert.equal(read.editing.enabled, true);
  const audited = (await json(await f.call('owner@example.invalid', {}, { action: 'audit' }))).body; assert.equal(audited.entries.length, 2); assert.equal(audited.entries[0].actor, 'owner');
  const capabilities = (await json(await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).body.capabilities;
  assert.equal(capabilities.find(c => c.id === 'settings.installation-audit').state, 'CAPABILITY_STATE_READY');
});

test('widening needs the typed key and an Access sign-in from the last 10 minutes, and records where from', async t => {
  const f = await fixture(t); allocate(f.env);
  const wider = { origins: ['https://hooks.example.net', 'https://ci.example.org', 'https://new.example.com'], dailyLimit: 300 };
  assert.match((await json(await update(f, 'webhooks', wider, {}, recent()))).body.message, /Type webhooks to confirm/);
  assert.match((await json(await update(f, 'webhooks', wider, { confirmation: 'webhooks' }))).body.message, /last 10 minutes/);
  assert.equal((await update(f, 'webhooks', wider, { confirmation: 'webhooks' }, { 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000) - 601) })).status, 412);
  const saved = await json(await update(f, 'webhooks', wider, { confirmation: 'webhooks' }, recent()));
  assert.equal(saved.status, 200); assert.equal(saved.body.widening, true);
  const row = f.sql.prepare('SELECT * FROM installation_audit').get(); assert.equal(row.widening, 1); assert.deepEqual(JSON.parse(row.client), { colo: 'LHR', country: 'GB' });
  // Turning rate limiting off and raising a limit widen; lowering and turning features off do not.
  assert.equal((await update(f, 'rate-limit', { enabled: false })).status, 412);
  assert.equal((await update(f, 'rate-limit', { enabled: false }, { confirmation: 'rate-limit' }, recent())).status, 200);
  assert.equal((await update(f, 'email', { enabled: false, dailyLimit: 10 })).status, 200);
  assert.equal((await update(f, 'email', { enabled: true, dailyLimit: 10 }, { expectedVersion: '1' })).status, 412);
  assert.equal((await update(f, 'evidence', { dailyLimit: 5 })).status, 200);
  assert.equal((await update(f, 'evidence', { dailyLimit: 6 }, { expectedVersion: '1', confirmation: 'evidence' }, recent())).status, 200);
});

test('every bound is enforced and private, own and provider origins are refused', async t => {
  const f = await fixture(t); allocate(f.env);
  const origins = list => ({ origins: list, dailyLimit: 10 });
  for (const value of [origins([]), origins(Array.from({ length: 33 }, (_, i) => `https://h${i}.example.com`)), origins(['https://a.example.com', 'https://a.example.com']),
    ...['http://hooks.example.com', 'https://localhost', 'https://hooks.internal', 'https://printer.local', 'https://10.0.0.1', 'https://[::1]', 'https://hooks.example.com:8443', 'https://hooks.example.com/path',
      'https://user@hooks.example.com', 'https://golf.example.com', 'https://api.golf.example.com', 'https://previews.golf.example.com', 'https://app.previews.golf.example.com',
      'https://team.cloudflareaccess.com', 'https://0123.artifacts.cloudflare.net', 'https://router.home.arpa'].map(origin => origins([origin])),
    { origins: ['https://hooks.example.com'], dailyLimit: 0 }, { origins: ['https://hooks.example.com'], dailyLimit: 5001 }, { origins: ['https://hooks.example.com'], dailyLimit: 1.5 },
    { origins: ['https://hooks.example.com'] }, { origins: ['https://hooks.example.com'], dailyLimit: 10, extra: true }])
    assert.equal((await update(f, 'webhooks', value, { confirmation: 'webhooks' }, recent())).status, 400, JSON.stringify(value));
  for (const [key, value] of [['email', { enabled: true, dailyLimit: 5001 }], ['email', { enabled: 'yes', dailyLimit: 5 }], ['previews', { lifetimeSeconds: 3601, concurrency: 1 }], ['previews', { lifetimeSeconds: 59, concurrency: 1 }],
    ['previews', { lifetimeSeconds: 600, concurrency: 5 }], ['previews', { lifetimeSeconds: 600, concurrency: 0 }], ['evidence', { dailyLimit: 21 }], ['evidence', { dailyLimit: 0 }], ['rate-limit', { enabled: 1 }]])
    assert.equal((await update(f, key, value, { confirmation: key }, recent())).status, 400, key + JSON.stringify(value));
  assert.equal((await update(f, 'previews', { lifetimeSeconds: 3600, concurrency: 4 })).status, 200);
  assert.equal((await update(f, 'apps', { enabled: false })).status, 400);
  assert.match((await json(await update(f, 'agents', { enabled: false }))).body.message, /not allocated/);
  assert.equal((await update(f, 'webhooks', origins(['https://hooks.example.com']), { operationId: 'not-a-uuid' })).status, 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM installation_audit').get().n, 1);
});

test('only a current operations administrator signed in through Access can change policy, and a deploy lock refuses and ignores edits', async t => {
  const f = await fixture(t); allocate(f.env);
  const token = 'golf_native_' + 'c'.repeat(43), value = { origins: ['https://ci.example.org'], dailyLimit: 10 };
  f.sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), 1, Math.floor(Date.now() / 1000) + 100);
  assert.equal((await update(f, 'webhooks', value, {}, { Authorization: 'Bearer ' + token }, '')).status, 403);
  assert.equal((await update(f, 'webhooks', value, {}, { Authorization: 'Bearer ' + token })).status, 403);
  assert.equal((await update(f, 'webhooks', value, {}, { 'CF-Access-Client-Id': 'service', 'CF-Access-Client-Secret': 'secret' })).status, 403);
  assert.equal((await update(f, 'webhooks', value, {}, {}, 'creator@example.invalid')).status, 403);
  // Revoked between the check and the write: the fenced batch writes nothing.
  f.revokeOn('SELECT * FROM installation_operations');
  assert.equal((await update(f, 'webhooks', value)).status, 403);
  // No change and no change row; each refusal is recorded by the dispatch hook as denied.
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM installation_settings').get().n, 0); assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM installation_audit WHERE action='update'").get().n, 0);
  assert.deepEqual(f.sql.prepare("SELECT action,subject,json_extract(client,'$.outcome') AS outcome,json_extract(client,'$.via') AS via FROM installation_audit ORDER BY id").all().map(row => Object.values(row)),
    [['installation_policy.update', 'webhooks', 'denied', 'token'], ['installation_policy.update', 'webhooks', 'denied', 'token'], ['installation_policy.update', 'webhooks', 'denied', 'service'], ['installation_policy.update', 'webhooks', 'denied', 'person'], ['installation_policy.update', 'webhooks', 'denied', 'person']]);
  f.sql.exec('UPDATE operations_admins SET active=1');
  assert.equal((await update(f, 'webhooks', value)).status, 200);
  f.env.INSTALLATION_POLICY_EDITING = 'false';
  assert.match((await json(await update(f, 'webhooks', value, { expectedVersion: '1' }))).body.message, /locked at deploy/);
  const read = (await json(await f.call())).body; assert.equal(read.editing.enabled, false);
  assert.equal(read.groups.flatMap(group => group.items).find(item => item.id === 'webhooks').values[0].value, 'https://hooks.example.net\nhttps://ci.example.org');
  assert.deepEqual(installationOverlay(f.env, new Map([['webhooks', { value: JSON.stringify(value) }]])), { installationOff: [], installationSchema: true });
});

test('the audit log is append-only and the helper writes only after the change it records', async t => {
  const f = await fixture(t);
  await f.env.DB.batch([f.env.DB.prepare("UPDATE users SET login='renamed' WHERE id=99"), auditStatement(f.env.DB, { actor: { id: 1 }, scope: 'repository', scopeId: '7', subject: 'issues', action: 'update', before: true, after: false })]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM installation_audit').get().n, 0);
  await f.env.DB.batch([f.env.DB.prepare("UPDATE users SET login='owner' WHERE id=1"), auditStatement(f.env.DB, { actor: { id: 1 }, actorEmail: 'owner@example.invalid', scope: 'repository', scopeId: '7', subject: 'issues', action: 'update', before: true, after: false })]);
  const row = f.sql.prepare('SELECT * FROM installation_audit').get(); assert.equal(row.scope, 'repository'); assert.equal(row.after, 'false');
  assert.throws(() => f.sql.exec("UPDATE installation_audit SET action='forged'"), /append-only/);
  assert.throws(() => f.sql.exec('DELETE FROM installation_audit'), /append-only/);
  assert.equal(f.sql.prepare('SELECT action FROM installation_audit').get().action, 'update');
});

test('effective policy reaches its points of use: capabilities, the email drain, previews, admissions and the anonymous limiter', async t => {
  const f = await fixture(t); allocate(f.env);
  assert.equal((await update(f, 'email', { enabled: false, dailyLimit: 200 })).status, 200);
  const capabilities = (await json(await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).body.capabilities;
  assert.equal(capabilities.find(c => c.id === 'repository.email-notifications').state, 'CAPABILITY_STATE_DISABLED');
  assert.match(capabilities.find(c => c.id === 'repository.email-notifications').reason, /turned email notifications off/);
  assert.match((await json(await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.EmailNotificationService/GetOwnEmailNotifications'))).body.message, /turned off for this installation/);
  f.sql.exec('PRAGMA foreign_keys=OFF');
  const time = new Date().toISOString(), lease = new Date(Date.now() + 30000).toISOString();
  for (const state of ['queued', 'retrying', 'sending'])
    f.sql.prepare("INSERT INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,state,lease,lease_until,next_attempt_at,created_at) VALUES(?,'s',1,1,1,0,?,'issues',?,?,?,?,?)").run(state, 'e' + state, state, state === 'sending' ? 'lease' : null, state === 'sending' ? lease : null, time, time);
  let sent = 0; f.env.EMAIL.send = async () => { sent++; return { messageId: 'x' }; };
  assert.deepEqual(await drainEmail(await withInstallationPolicy(f.env)), { processed: 2, pending: 1 }); assert.equal(sent, 0);
  assert.deepEqual(f.sql.prepare('SELECT id,state,failure_code FROM email_deliveries ORDER BY id').all().map(row => ({ ...row })), [
    { id: 'queued', state: 'cancelled', failure_code: 'disabled_by_installation' }, { id: 'retrying', state: 'cancelled', failure_code: 'disabled_by_installation' }, { id: 'sending', state: 'sending', failure_code: '' }]);
  assert.equal((await update(f, 'previews', { lifetimeSeconds: 600, concurrency: 1 })).status, 200);
  const effective = await withInstallationPolicy(f.env);
  assert.equal(effective.PREVIEW_TTL, '600'); assert.equal(effective.PREVIEW_SLOTS, '1'); assert.equal(f.env.PREVIEW_TTL, '3600');
  assert.equal((await update(f, 'evidence', { dailyLimit: 3 })).status, 200); assert.equal((await withInstallationPolicy(f.env)).EVIDENCE_DAILY_LIMIT, '3');
  // The anonymous limiter reads policy only for a refused request; turned off, the refusal is withdrawn.
  const request = new Request(origin + '/git/owner/project.git/info/refs?service=git-upload-pack');
  f.env.ANONYMOUS_READS = { limit: async () => ({ success: false }) };
  assert.equal((await anonymousLimit(request, f.env, null))?.status, 429);
  assert.equal((await update(f, 'rate-limit', { enabled: false }, { confirmation: 'rate-limit' }, recent())).status, 200);
  assert.equal(await anonymousLimit(request, f.env, null), null);
  const dashboard = (await json(await f.call('owner@example.invalid', {}, {}, '/rpc/golf.v1.OperationsService/GetOperationsDashboard'))).body;
  assert.match(dashboard.services.find(row => row.id === 'rate-limit').detail, /turned the installed anonymous request limit off/);
});
