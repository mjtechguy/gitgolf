import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { publicFetch, statelessRoute } from './src/public.mjs';
import { handle } from './src/core.mjs';
import { anonymousLimit, clientKey, rateLimitBindings, rateLimitPolicy, rateLimitService } from './src/rate-limit.mjs';

const origin = 'https://golf.example.com';
function fixture(bindings = {}, limit = 10) {
  const counts = new Map(), keys = [], forwarded = [];
  const limiter = { async limit(options) { assert.deepEqual(Object.keys(options), ['key']); keys.push(options.key); counts.set(options.key, (counts.get(options.key) || 0) + 1); return { success: counts.get(options.key) <= limit }; } };
  const env = { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCESS_AUD: 'aud', PUBLIC_REPOSITORIES: 'true', ANONYMOUS_READS: limiter, ANONYMOUS_READ_LIMIT: limit + '/60', ...bindings };
  const samples = [], pending = [];
  const workspace = { idFromName: name => name, get: () => ({ async fetch(request) { forwarded.push(new URL(request.url).pathname); return Response.json({ forwarded: true }); }, async recordPerformance(sample) { samples.push(sample.status); } }) };
  const send = (path, { method = 'POST', headers = {}, address = '203.0.113.7', access } = {}) => publicFetch(new Request(origin + path, { method, headers: { ...(address ? { 'CF-Connecting-IP': address } : {}),
    ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) }), env,
    { exports: { Workspace: workspace }, waitUntil: promise => pending.push(promise), ...(access ? { access: { aud: 'aud', async getIdentity() { return { email: 'reader@example.com' }; } } } : {}) });
  return { env, keys, forwarded, send, samples, settled: () => Promise.all(pending) };
}
const read = '/rpc/golf.v1.RepositoryService/GetContents', clone = '/git/alice/project.git/git-upload-pack', refs = '/git/alice/project.git/info/refs?service=git-upload-pack';

test('anonymous public reads and clones over the limit are refused before the workspace', async () => {
  const f = fixture(), admitted = Array.from({ length: 10 }, (_, i) => i % 2 ? '/native/discover' : read);
  for (const path of admitted) assert.equal((await f.send(path)).status, 200);
  const refused = await f.send(read);
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('Retry-After'), '60'); assert.equal(refused.headers.get('Cache-Control'), 'no-store'); assert.equal(refused.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await refused.json(), { code: 'resource_exhausted', message: 'Too many anonymous requests from this network. Retry after 60 seconds; signed-in and credentialed requests are not limited.' });
  for (const [path, method, headers] of [[clone, 'POST', { 'Content-Type': 'application/x-git-upload-pack-request' }], [refs, 'GET', {}]]) {
    const git = await f.send(path, { method, headers });
    assert.equal(git.status, 429); assert.equal(git.headers.get('Content-Type'), 'text/plain; charset=utf-8'); assert.match(await git.text(), /^Too many anonymous requests from this network\./);
  }
  assert.deepEqual(f.forwarded, admitted); assert.deepEqual(f.keys, Array(13).fill('203.0.113.7'));
  // Another client keeps its own count; an IPv6 client is counted by its /64.
  assert.equal((await f.send(read, { address: '203.0.113.8' })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await f.send(read, { address: '2001:db8:1:2::' + (i + 1) })).status, 200);
  for (const [address, status] of [['2001:db8:1:2:aaaa:bbbb:cccc:dddd', 429], ['2001:db8:1:3::1', 200]]) assert.equal((await f.send(read, { address })).status, status, address);
  assert.deepEqual(f.keys.slice(14), [...Array(11).fill('2001:db8:1:2::/64'), '2001:db8:1:3::/64']);
});

test('a refused request leaves no trace in the workspace, even with performance history on', async () => {
  const f = fixture({ OPERATIONS_OBSERVABILITY: 'true' });
  for (let i = 0; i < 10; i++) assert.equal((await f.send(read)).status, 200);
  for (let i = 0; i < 5; i++) { const refused = await f.send(read); assert.equal(refused.status, 429); assert.equal(refused.headers.get('X-Golf-Rate-Limited'), 'anonymous'); }
  await f.settled();
  assert.deepEqual(f.samples, Array(10).fill(200)); assert.equal(f.forwarded.length, 10);
});

test('credentialed, signed-in and runner requests are never counted', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.equal((await f.send(read)).status, 200);
  assert.equal((await f.send(read)).status, 429);
  const before = f.keys.length, admitted = [];
  for (const [path, options] of [
    [read, { headers: { Authorization: 'Bearer golf_native_' + 'a'.repeat(43) } }], [read, { headers: { Authorization: 'Bearer golf_git_' + 'a'.repeat(43) } }],
    [clone, { headers: { Authorization: 'Basic ' + btoa('alice:golf_git_secret'), 'Content-Type': 'application/x-git-upload-pack-request' } }], [refs, { method: 'GET', headers: { Authorization: 'Basic ' + btoa('alice:secret') } }],
    [read, { access: true }], ['/native/discover', { access: true }],
    ['/api/v4/jobs/request', {}], ['/api/v4/jobs/1/git/info/refs?service=git-upload-pack', { method: 'GET' }], ['/native/runner-machine/claim', { headers: { Authorization: 'Bearer golf_runner_x' } }], ['/native/runner-machine/claim', {}],
  ]) {
    // Clones are served by the Worker itself (scale-out S1); without a database in this stub they answer 503, never 429.
    for (let i = 0; i < 3; i++) assert.equal((await f.send(path, options)).status, statelessRoute(new Request(origin + path, { method: options.method || 'POST' })) === 'read' ? 503 : 200, path);
    if (!path.startsWith('/git/')) admitted.push(path.split('?')[0]);
  }
  assert.equal(f.keys.length, before); assert.deepEqual(f.forwarded.slice(10), admitted.flatMap(path => [path, path, path]));
  // Requests outside the anonymous read contract reach the workspace as before; it refuses them itself.
  for (const [path, method] of [['/rpc/golf.v1.SessionService/GetSession', 'POST'], ['/rpc/golf.v1.RepositoryService/CreateRepository', 'POST'], ['/rpc/golf.v1.DiscussionCollaborationService/ListIssueTemplates', 'POST']])
    assert.equal((await f.send(path, { method })).status, 200, path);
  // Pushes are served by the Worker itself (scale-out S2) and refuse an anonymous caller there; no database in this stub.
  for (const [path, method] of [['/git/alice/project.git/git-receive-pack', 'POST'], ['/git/alice/project.git/info/refs?service=git-receive-pack', 'GET']]) assert.equal((await f.send(path, { method })).status, 503, path);
  assert.equal(f.keys.length, before);
});

test('an absent binding, a private installation or a failing limiter leaves requests unchanged', async () => {
  for (const bindings of [{ ANONYMOUS_READS: undefined, ANONYMOUS_READ_LIMIT: undefined }, { ANONYMOUS_READS: undefined }, { ANONYMOUS_READ_LIMIT: undefined }, { ANONYMOUS_READ_LIMIT: '5/30' }, { ANONYMOUS_READ_LIMIT: '20000/60' }]) {
    const f = fixture(bindings);
    assert.equal(rateLimitPolicy(f.env), null); assert.equal(await anonymousLimit(new Request(origin + read, { method: 'POST' }), f.env, null), null);
    for (let i = 0; i < 12; i++) for (const [path, method, status] of [[read, 'POST', 200], [clone, 'POST', 503], [refs, 'GET', 503]]) assert.equal((await f.send(path, { method })).status, status);
    assert.equal(f.forwarded.length, 12); assert.deepEqual(f.keys, []);
  }
  // Without public repositories Access refuses anonymous requests first and nothing is counted.
  const closed = fixture({ PUBLIC_REPOSITORIES: 'false' });
  assert.equal((await closed.send(read)).status, 401); assert.equal((await closed.send(read, { access: true })).status, 200); assert.deepEqual(closed.keys, []);
  const failing = fixture({ ANONYMOUS_READS: { async limit() { throw Error('limiter unavailable'); } } });
  for (let i = 0; i < 3; i++) assert.equal((await failing.send(read)).status, 200);
  assert.equal(failing.forwarded.length, 3);
  const unknown = fixture();
  assert.equal((await unknown.send(read, { address: '' })).status, 200); assert.deepEqual(unknown.keys, ['unknown']);
});

test('the build accepts only an explicit bounded limit and names one client network', () => {
  assert.deepEqual(rateLimitBindings({}), {});
  assert.deepEqual(rateLimitBindings({ anonymous_rate_limit: { namespace: '1001', limit: 300, period: 60 } }), {
    ANONYMOUS_READS: { type: 'rate-limit', namespace: '1001', simple: { limit: 300, period: 60 } }, ANONYMOUS_READ_LIMIT: { type: 'text', value: '300/60' } });
  for (const value of [null, [], 'on', {}, { namespace: 1001, limit: 300, period: 60 }, { namespace: '0', limit: 300, period: 60 }, { namespace: '2147483648', limit: 300, period: 60 }, { namespace: '-1', limit: 300, period: 60 },
    { namespace: '1001', limit: 9, period: 60 }, { namespace: '1001', limit: 10001, period: 60 }, { namespace: '1001', limit: 1.5, period: 60 }, { namespace: '1001', limit: '300', period: 60 },
    { namespace: '1001', limit: 300, period: 30 }, { namespace: '1001', limit: 300 }, { namespace: '1001', limit: 300, period: 60, key: 'user' }]) assert.throws(() => rateLimitBindings({ anonymous_rate_limit: value }), /Anonymous rate limit/);
  for (const [address, key] of [['203.0.113.7', '203.0.113.7'], ['2001:DB8:0:1:2:3:4:5', '2001:db8:0:1::/64'], ['2001:db8::1', '2001:db8:0:0::/64'], ['::1', '0:0:0:0::/64'], ['2001:db8:1:2::', '2001:db8:1:2::/64'], [null, 'unknown']]) assert.equal(clientKey(address), key);
});

test('operations lists the limit with its approximate, per-location scope', async t => {
  const limiter = { async limit() { return { success: true }; } };
  assert.deepEqual(rateLimitService({ PUBLIC_REPOSITORIES: 'true', ANONYMOUS_READS: limiter, ANONYMOUS_READ_LIMIT: '300/60' }), { id: 'rate-limit', label: 'Rate limiting · anonymous public reads', state: 'configured', source: 'Installed binding / policy',
    detail: 'About 300 anonymous public read or clone requests per 60 seconds for each client network at each Cloudflare location. Counts are approximate and are not shared between locations. Signed-in, credentialed and runner requests are never counted. Refusals are not recorded here.' });
  assert.match(rateLimitService({ PUBLIC_REPOSITORIES: 'true' }).detail, /^No anonymous request limit is installed/);
  assert.match(rateLimitService({}).detail, /^Public repositories are not enabled/);
  assert.match(rateLimitService({ ANONYMOUS_READS: limiter, ANONYMOUS_READ_LIMIT: '300/60' }).detail, /^A limit is installed, but public repositories are not enabled/);
  for (const env of [{ PUBLIC_REPOSITORIES: 'true' }, {}, { ANONYMOUS_READS: limiter, ANONYMOUS_READ_LIMIT: '300/60' }]) assert.equal(rateLimitService(env).state, 'disabled');
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,email,can_create) VALUES(1,'owner','owner@example.invalid',1); INSERT INTO operations_admins(user_id) VALUES(1)");
  const DB = { withSession() { return this; }, async batch(statements) { return Promise.all(statements.map(statement => statement.all())); }, prepare(query) { const statement = sql.prepare(query); let values = []; return {
    bind(...args) { values = args; return this; }, async first() { return statement.get(...values) || null; }, async all() { return { results: statement.all(...values) }; } }; } };
  const dashboard = async bindings => (await (await handle(new Request(origin + '/rpc/golf.v1.OperationsService/GetOperationsDashboard', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': 'owner@example.invalid' }, body: '{}' }), { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'workspace', ...bindings })).json()).services;
  const rows = await dashboard({ PUBLIC_REPOSITORIES: 'true', ANONYMOUS_READS: limiter, ANONYMOUS_READ_LIMIT: '120/10' });
  assert.equal(rows.filter(row => row.id === 'rate-limit').length, 1); assert.equal(rows.find(row => row.id === 'rate-limit').state, 'configured'); assert.match(rows.find(row => row.id === 'rate-limit').detail, /^About 120 anonymous public read or clone requests per 10 seconds/);
  assert.equal((await dashboard({})).find(row => row.id === 'rate-limit').state, 'disabled');
});
