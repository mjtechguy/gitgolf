// API tokens (docs/AGENT_ACCESS.md, AM-3): lifecycle and hashing, expiry/revocation/identity invalidation, scope on repositories,
// permission and the push branch pattern, the routes a golf_pat_ reaches, and the public Worker's Access bypass for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessFixture, bearer, basic, origin, repository, feature, base } from './agent-access-fixture.mjs';
import { tokens } from './object-fixture.mjs';
import { handle } from './src/core.mjs';
import { publicFetch } from './src/public.mjs';
import { branchAllowed, machineTokenRoute } from './src/api-tokens.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const pattern = /^golf_pat_[A-Za-z0-9_-]{43}$/;

test('a token is shown once, stored as SHA-256, listed and revoked from a browser session only, and every change is audited', async t => {
  const f = await accessFixture(t);
  const created = await f.create({ label: 'claude on laptop', permission: 'read', repositories: ['1'] });
  assert.match(created.secret, pattern); assert.equal(created.mcpUrl, origin + '/mcp');
  assert.deepEqual(created.token.repositories, [{ id: '1', fullName: 'alice/project' }]);
  const row = f.sql.prepare('SELECT * FROM api_tokens WHERE id=?').get(Number(created.token.id));
  assert.equal(row.digest, sha256(created.secret)); assert.ok(!JSON.stringify(row).includes(created.secret.slice(9)));
  assert.equal(row.expires_at - row.created_at, 24 * 3600);
  const list = await f.session({ action: 'list' });
  assert.equal(list.status, 200); assert.equal(list.active, 1); assert.equal(list.limit, 50);
  assert.deepEqual(list.tokens.map(t => [t.label, t.permission, t.state, t.lastUsedAt]), [['claude on laptop', 'read', 'active', '']]);
  assert.ok(!JSON.stringify(list).includes(created.secret));
  // Only a signed-in browser manages tokens: no Authorization header of any kind, the exact Origin, the Access identity.
  assert.equal((await f.session({ action: 'list' }, 'alice', { Authorization: bearer(tokens.admin) })).status, 403);
  assert.equal((await f.session({ action: 'list' }, 'alice', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.rpc('/native/api-tokens', { action: 'list' }, tokens.admin)).status, 403);
  assert.equal((await f.rpc('/native/api-tokens', { action: 'list' }, created.secret)).status, 401);
  // Validation names the rule.
  const refuse = async (body, who) => { const value = await f.session({ action: 'create', label: 'x', permission: 'write', lifetimeHours: 24, ...body }, who); return [value.status, value.message]; };
  assert.deepEqual(await refuse({ lifetimeHours: 2161 }), [400, 'Choose a lifetime from 1 hour to 90 days.']);
  assert.deepEqual(await refuse({ lifetimeHours: 0 }), [400, 'Choose a lifetime from 1 hour to 90 days.']);
  assert.deepEqual(await refuse({ permission: 'read', branchPattern: 'agent/*' }), [400, 'A branch pattern limits writes; it applies only to write tokens.']);
  for (const bad of ['agent/**', '/agent', 'a..b', '.hidden/*', 'x.lock']) assert.equal((await refuse({ branchPattern: bad }))[0], 400, bad);
  assert.deepEqual(await refuse({ repositories: ['1'] }, 'dave'), [400, 'Choose repositories you can access.']);
  assert.deepEqual(await refuse({ label: ' padded' }), [400, 'Use a trimmed name up to 64 bytes.']);
  assert.deepEqual(await refuse({ secret: 'x' }), [400, 'Unknown field.']);
  // Revocation is immediate and owner-only.
  assert.equal((await f.session({ action: 'revoke', id: created.token.id }, 'bob')).status, 404);
  assert.equal((await f.mcp(created.secret, 'ping')).status, 200);
  const revoked = await f.session({ action: 'revoke', id: created.token.id });
  assert.deepEqual([revoked.status, revoked.id, revoked.revoked], [200, created.token.id, true]);
  assert.equal((await f.mcp(created.secret, 'ping')).status, 401);
  assert.equal((await f.session({ action: 'list' })).tokens[0].state, 'revoked');
  const audit = f.sql.prepare("SELECT action,subject,after,client FROM installation_audit WHERE action LIKE 'api_token.%' ORDER BY id").all();
  assert.deepEqual(audit.map(row => [row.action, row.subject, JSON.parse(row.client).outcome]).slice(0, 2), [['api_token.create', 'claude on laptop', 'success'], ['api_token.revoke', 'claude on laptop', 'denied']]);
  assert.ok(audit.some(row => row.action === 'api_token.revoke' && JSON.parse(row.client).outcome === 'success'));
  assert.deepEqual(JSON.parse(audit[0].after), { label: 'claude on laptop', permission: 'read', repositories: 1, lifetimeHours: 24 });
  assert.ok(audit.every(row => !JSON.stringify(row).includes(created.secret.slice(9))));
});

test('fifty active tokens per account; expiry and an identity change stop a token at once, and use is recorded at most once a minute', async t => {
  const f = await accessFixture(t);
  for (let i = 0; i < 50; i++) await f.create({ label: 'bulk ' + i }, 'carol');
  const over = await f.session({ action: 'create', label: 'one more', permission: 'read', lifetimeHours: 1 }, 'carol');
  assert.equal(over.status, 412); assert.match(over.message, /50 active API tokens/);
  const { secret, token } = await f.create({ permission: 'read' });
  assert.equal((await f.mcp(secret, 'ping')).status, 200);
  const used = f.sql.prepare('SELECT last_used_at FROM api_tokens WHERE id=?').get(Number(token.id)).last_used_at;
  assert.ok(Math.abs(used - Date.now() / 1000) < 5);
  f.sql.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(used - 30, Number(token.id));
  await f.mcp(secret, 'ping');
  assert.equal(f.sql.prepare('SELECT last_used_at FROM api_tokens WHERE id=?').get(Number(token.id)).last_used_at, used - 30);
  // Expired.
  const now = Math.floor(Date.now() / 1000);
  f.sql.prepare('UPDATE api_tokens SET created_at=?,expires_at=? WHERE id=?').run(now - 7200, now - 1, Number(token.id));
  assert.equal((await f.mcp(secret, 'ping')).status, 401);
  assert.equal((await f.session({ action: 'list' })).tokens[0].state, 'expired');
  // Changing the account (here its email) bumps the identity version: every token of the account stops.
  const second = await f.create({ permission: 'read' });
  assert.equal((await f.mcp(second.secret, 'ping')).status, 200);
  f.sql.exec("UPDATE users SET email='alice2@example.invalid' WHERE id=1");
  assert.equal((await f.mcp(second.secret, 'ping')).status, 401);
  assert.equal((await f.session({ action: 'list' }, 'alice2')).tokens[0].state, 'invalidated');
  // A deactivated account's tokens stop too.
  const bob = await f.create({ permission: 'read' }, 'bob');
  f.sql.exec('UPDATE users SET active=0 WHERE id=2');
  assert.equal((await f.mcp(bob.secret, 'ping')).status, 401);
});

test('scope: repositories, read-only tokens and the write branch pattern on Git, capped by the current grant', async t => {
  const f = await accessFixture(t);
  const writer = (await f.create({ repositories: ['1'], branchPattern: 'agent/*' }, 'bob')).secret;
  // Git clients send Basic with any user name; Bearer works too.
  for (const authorization of [basic(writer), basic(writer, 'golf'), bearer(writer)]) assert.equal((await f.git(authorization, 'info/refs?service=git-upload-pack')).status, 200);
  // A repository outside the token's list is refused and audited; a grant the account lacks stays hidden as before.
  const outside = await f.git(basic(writer), 'info/refs?service=git-upload-pack', { repo: 'tooling' });
  assert.equal(outside.status, 403); assert.equal((await outside.json()).message, 'This API token does not cover this repository.');
  const denied = f.sql.prepare("SELECT scope,scope_id,subject,after,client FROM installation_audit WHERE action='api_token.use_denied'").all();
  assert.equal(denied.length, 1); assert.deepEqual([denied[0].scope, denied[0].scope_id, denied[0].subject, JSON.parse(denied[0].after).reason], ['repository', '2', 'alice/tooling', 'repository']);
  assert.equal(JSON.parse(denied[0].client).via, 'api_token');
  // The branch pattern: agent/* only. Main and tags are refused before anything reaches the provider.
  const main = await f.push(basic(writer), 'refs/heads/main', feature, base);
  assert.equal(main.status, 403); assert.match((await main.json()).message, /branches matching agent\/\*/);
  assert.equal((await f.push(basic(writer), 'refs/tags/v1')).status, 403);
  assert.equal(f.pushes.length, 0);
  const ok = await f.push(basic(writer), 'refs/heads/agent/new');
  assert.equal(ok.status, 200); assert.deepEqual(f.pushes.map(p => p.ref), ['refs/heads/agent/new']);
  assert.equal(f.refs.get('repo-' + 'b'.repeat(32)).get('refs/heads/agent/new'), feature);
  assert.deepEqual(f.sql.prepare("SELECT ref,user_id,state FROM git_operations").all().map(r => [r.ref, r.user_id, r.state]), [['refs/heads/agent/new', 2, 'APPLIED']]);
  // A read token cannot push or even ask for the receive-pack advertisement.
  const reader = (await f.create({ permission: 'read' }, 'bob')).secret;
  assert.equal((await f.git(basic(reader), 'info/refs?service=git-receive-pack')).status, 403);
  assert.equal((await f.push(basic(reader), 'refs/heads/agent/two')).status, 403);
  // A write token never exceeds the account's grant: carol reads repository 1.
  const capped = (await f.create({ repositories: ['1'] }, 'carol')).secret;
  assert.equal((await f.git(basic(capped), 'info/refs?service=git-upload-pack')).status, 200);
  assert.equal((await f.push(basic(capped), 'refs/heads/agent/three')).status, 404);
  // The reservation re-checks the token: revoked between admission and the write, the push is not journaled.
  const late = await f.create({}, 'bob');
  f.hooks.opened = () => { f.sql.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), Number(late.token.id)); };
  const raced = await f.push(basic(late.secret), 'refs/heads/agent/raced');
  assert.equal(raced.status, 412); assert.equal(f.pushes.length, 1);
  assert.equal(branchAllowed('agent/*', 'refs/heads/agent/x'), true); assert.equal(branchAllowed('agent/*', 'refs/heads/agentx'), false);
  assert.equal(branchAllowed('release', 'refs/heads/release'), true); assert.equal(branchAllowed('release', 'refs/heads/release-2'), false);
  assert.equal(branchAllowed('', 'refs/tags/v1'), true); assert.equal(branchAllowed('*', 'refs/tags/v1'), false);
});

test('golf_pat_ is refused on browser, account and repository RPC routes; only the MCP tools reach their allowlist, and not from outside', async t => {
  const f = await accessFixture(t);
  const { secret } = await f.create();
  for (const path of ['/rpc/golf.v1.RepositoryService/GetRepository', '/rpc/golf.v1.RepositoryService/ListRepositories', '/rpc/golf.v1.SessionService/GetSession', '/native/agent-hosts', '/native/api-tokens', '/native/config', '/rpc/golf.v1.RepositoryService/CreatePullRequest']) {
    const value = await f.rpc(path, { repository }, secret);
    assert.equal(value.status, 401, path); assert.equal(value.message, 'API tokens are accepted only on /mcp, /native/source/ and /git/.');
  }
  // No header, query or body marks a request internal: only the environment flag set by the MCP endpoint does.
  const spoofed = await f.dispatch(new Request(origin + '/rpc/golf.v1.RepositoryService/GetRepository', { method: 'POST', body: JSON.stringify({ repository, mcpInternal: true }),
    headers: { Authorization: bearer(secret), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-MCP-Internal': 'true', 'X-Mcp-Internal': '1' } }));
  assert.equal(spoofed.status, 401);
  // Basic carries a token only for Git.
  assert.equal((await f.mcp(null, 'ping', undefined, 1, { Authorization: basic(secret) })).status, 401);
  // With the flag (as mcp.mjs sets it): the allowlisted read works, a route outside the list does not, a read token cannot write.
  const internal = (path, body, token, flag = true) => handle(new Request(origin + path, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: bearer(token), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' } }),
    { ...f.env, ...(flag ? { mcpInternal: true } : {}) }, f.providerFetch);
  assert.equal((await internal('/rpc/golf.v1.RepositoryService/GetRepository', { repository }, secret)).status, 200);
  assert.equal((await internal('/rpc/golf.v1.RepositoryService/GetRepository', { repository }, secret, false)).status, 401);
  assert.equal((await internal('/rpc/golf.v1.RepositoryService/ListRepositories', {}, secret)).status, 401);
  assert.equal((await internal('/native/api-tokens', { action: 'list' }, secret)).status, 401);
  // A truthy non-boolean environment value is not the flag.
  assert.equal((await handle(new Request(origin + '/rpc/golf.v1.RepositoryService/GetRepository', { method: 'POST', body: JSON.stringify({ repository }), headers: { Authorization: bearer(secret), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' } }),
    { ...f.env, mcpInternal: 'true' }, f.providerFetch)).status, 401);
  const reader = (await f.create({ permission: 'read' })).secret;
  const write = await internal('/rpc/golf.v1.RepositoryService/CreateIssueComment', { repository, repositoryId: '1', number: 12, issueId: '1', body: 'x', idempotencyKey: crypto.randomUUID() }, reader);
  assert.equal(write.status, 403); assert.equal((await write.json()).message, 'This API token is read-only.');
});

test('repository feature policy and capability: agent-access off refuses token calls but not people', async t => {
  const f = await accessFixture(t);
  const { secret } = await f.create();
  const capability = async () => (await f.rpc('/rpc/golf.v1.CapabilityService/ListCapabilities', {}, tokens.admin)).capabilities.find(c => c.id === 'agents.mcp');
  assert.equal((await capability()).state, 'CAPABILITY_STATE_READY');
  assert.equal((await f.git(basic(secret), 'info/refs?service=git-upload-pack')).status, 200);
  f.sql.exec("INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) VALUES('installation','','agent-access','DISABLED',1,1,'t')");
  const off = await f.git(basic(secret), 'info/refs?service=git-upload-pack');
  assert.equal(off.status, 412); assert.match((await off.json()).message, /API tokens and MCP are turned off/);
  assert.equal((await capability()).state, 'CAPABILITY_STATE_DISABLED');
  assert.equal((await f.git(bearer(tokens.admin), 'info/refs?service=git-upload-pack')).status, 200);
});

test('the public Worker lets a golf_pat_ through Access only on /mcp, /native/source/* and /git/*, without cookies or an Access identity', async () => {
  const secret = 'golf_pat_' + 'A'.repeat(43), forwarded = [];
  const env = { PUBLIC_ORIGIN: origin, ACCESS_AUD: 'aud', WORKSPACE_SLUG: 'alice', ASSETS: { fetch() { throw Error('No asset dispatch'); } } };
  const ctx = { exports: { Workspace: { idFromName: key => key, get: () => ({ fetch: async request => {
    forwarded.push([new URL(request.url).pathname, request.headers.get('Authorization'), request.headers.get('X-Golf-Native-Access-Email'), request.headers.get('Cookie')]);
    return new Response('workspace');
  } }) } } };
  const send = (path, authorization, method = 'POST') => publicFetch(new Request(origin + path, { method, headers: { ...(authorization ? { Authorization: authorization } : {}),
    Cookie: 'CF_Authorization=forged; other=1', 'X-Golf-Native-Access-Email': 'forged@example.com' }, ...(method === 'POST' ? { body: '{}' } : {}) }), env, ctx);
  for (const [path, authorization] of [['/mcp', bearer(secret)], ['/native/source/files', bearer(secret)]]) assert.equal(await (await send(path, authorization)).text(), 'workspace', path);
  assert.deepEqual(forwarded.map(row => row[0]), ['/mcp', '/native/source/files']);
  // Git and Source API writes pass Access the same way and are served by the Worker itself (scale-out S1, S2); this stub has no database.
  for (const [path, authorization, method] of [['/git/alice/project.git/info/refs?service=git-upload-pack', basic(secret), 'GET'], ['/git/alice/project.git/info/refs?service=git-receive-pack', basic(secret), 'GET'],
    ['/git/alice/project.git/git-receive-pack', bearer(secret)], ['/native/source/commit', bearer(secret)]]) assert.equal((await send(path, authorization, method)).status, 503, path);
  assert.ok(forwarded.every(row => row[2] === null && row[3] === null));
  // Everything else still needs Access: no token, another credential, Basic outside Git, or a token on another route.
  for (const [path, authorization] of [['/mcp', ''], ['/mcp', bearer('golf_native_' + 'a'.repeat(43))], ['/mcp', basic(secret)], ['/native/source/commit', basic(secret)], ['/native/api-tokens', bearer(secret)],
    ['/rpc/golf.v1.RepositoryService/GetRepository', bearer(secret)], ['/', bearer(secret)], ['/mcp', 'Bearer golf_pat_short']]) assert.equal((await send(path, authorization)).status, 401, path + ' ' + authorization);
  assert.equal(forwarded.length, 2);
  assert.equal(machineTokenRoute('/git/alice/project.git/other', bearer(secret)), false);
});
