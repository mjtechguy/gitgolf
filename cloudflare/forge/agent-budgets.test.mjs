// Rate budgets for API tokens and agent tasks (AM-6, docs/AGENT_ACCESS.md): the window counter, the 'agent-budgets'
// installation policy, and the refusal each caller sees: Git's own report for a push, 429 for a fetch, a tool error for MCP,
// 429 JSON for the Source API and the task routes. People are never counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFixture, bearer, basic, origin, repository, feature, zero } from './agent-access-fixture.mjs';
import { tokens } from './object-fixture.mjs';
import { digest } from './src/core.mjs';
import { AgentBudgets, budgetDefaults, budgetPolicy } from './src/agent-budgets.mjs';
import { packetLine } from './src/git.mjs';

const limits = (requests, writes) => ({ requests, writes });
function clock(start = 1_000_000) { const c = { t: start, now: () => c.t }; return c; }

test('a fixed one-minute window per key: requests and writes counted apart, Retry-After until the window closes', () => {
  const c = clock(), b = new AgentBudgets({ now: c.now });
  for (let i = 0; i < 3; i++) assert.equal(b.charge('token', '1', i === 0, limits(3, 1)), null);
  c.t += 12_000;
  const over = b.charge('token', '1', false, limits(3, 1));
  assert.deepEqual({ ...over }, { kind: 'token', budget: 'requests', limit: 3, retryAfter: 48,
    message: 'API token budget: 3 requests per minute reached; retry in 48 s.', reason: 'budget: 3 requests per minute for this api token reached; retry in 48 s' });
  // A refused request counts against nothing.
  assert.deepEqual(b.usage('token', '1'), { requests: 3, writes: 1, resetsInSeconds: 48 });
  // The window closes 60 s after it opened; the next request opens a new one.
  c.t += 47_500;
  assert.equal(b.charge('token', '1', false, limits(3, 1)).retryAfter, 1);
  c.t += 500;
  assert.equal(b.charge('token', '1', true, limits(3, 1)), null);
  assert.deepEqual(b.usage('token', '1'), { requests: 1, writes: 1, resetsInSeconds: 60 });
  // Writes have their own budget inside the request budget; a refused write leaves the request count alone.
  const write = b.charge('token', '1', true, limits(3, 1));
  assert.equal(write.budget, 'writes'); assert.equal(write.message, 'API token budget: 1 writes per minute reached; retry in 60 s.');
  assert.equal(b.charge('token', '1', false, limits(3, 1)), null);
  assert.deepEqual(b.usage('token', '1'), { requests: 2, writes: 1, resetsInSeconds: 60 });
  // Task messages name the task.
  b.charge('task', 't', true, limits(5, 1));
  assert.equal(b.charge('task', 't', true, limits(5, 1)).message, 'Agent task budget: 1 writes per minute reached; retry in 60 s.');
  // No limits (budgets off): counted, never refused.
  for (let i = 0; i < 10; i++) assert.equal(b.charge('token', 'off', true, null), null);
  assert.deepEqual(b.usage('token', 'off'), { requests: 10, writes: 10, resetsInSeconds: 60 });
  c.t += 60_000;
  assert.deepEqual(b.usage('token', 'off'), { requests: 0, writes: 0, resetsInSeconds: 0 });
});

test('keys are independent across ids and kinds; idle keys are evicted after two minutes and memory is capped', () => {
  const c = clock(), b = new AgentBudgets({ now: c.now, cap: 3 });
  assert.equal(b.charge('token', '1', false, limits(1, 1)), null);
  assert.equal(b.charge('token', '1', false, limits(1, 1)).budget, 'requests');
  assert.equal(b.charge('token', '2', false, limits(1, 1)), null);
  assert.equal(b.charge('task', '1', false, limits(1, 1)), null);
  assert.equal(b.size, 3);
  // At the cap, the least recently used key is forgotten first (its window restarts).
  c.t += 1000; b.charge('token', '1', false, null);
  b.charge('task', 'x', false, null);
  assert.equal(b.size, 3); assert.equal(b.usage('token', '2').requests, 0); assert.equal(b.usage('token', '1').requests, 2);
  // Idle for two minutes: swept on the next charge.
  c.t += 120_000;
  b.charge('token', '9', false, null);
  assert.equal(b.size, 1);
  // A larger population stays bounded by the default cap.
  const big = new AgentBudgets({ now: c.now });
  for (let i = 0; i < 10_050; i++) big.charge('token', String(i), false, null);
  assert.equal(big.size, 10_000); assert.equal(big.usage('token', '0').requests, 0); assert.equal(big.usage('token', '10049').requests, 1);
});

// The access fixture with a counter like the Workspace's and a settable clock.
async function budgets(t, value) {
  const f = await accessFixture(t), c = clock(Date.now());
  f.env.agentBudgets = new AgentBudgets({ now: c.now });
  if (value) f.sql.prepare("INSERT INTO installation_settings(key,value,version,updated_by,updated_at) VALUES('agent-budgets',?,1,1,'t')").run(JSON.stringify({ ...budgetDefaults, ...value }));
  return { ...f, clock: c };
}

test('Git: a fetch over budget is 429 text with Retry-After; a push over its write budget is refused in Git’s own report', async t => {
  const f = await budgets(t, { tokenRequestsPerMinute: 3, tokenWritesPerMinute: 1 });
  const reader = (await f.create({ permission: 'read' })).secret;
  for (let i = 0; i < 3; i++) assert.equal((await f.git(basic(reader), 'info/refs?service=git-upload-pack')).status, 200);
  f.clock.t += 20_000;
  const fetch = await f.git(basic(reader), 'info/refs?service=git-upload-pack');
  assert.equal(fetch.status, 429); assert.equal(fetch.headers.get('Retry-After'), '40'); assert.match(fetch.headers.get('Content-Type'), /^text\/plain/);
  assert.equal(await fetch.text(), 'API token budget: 3 requests per minute reached; retry in 40 s.\n');
  // The next window admits again.
  f.clock.t += 40_000;
  assert.equal((await f.git(basic(reader), 'info/refs?service=git-upload-pack')).status, 200);
  // Pushes: the first write lands, the second is "! [remote rejected] … (budget: …)" before anything reaches the provider.
  const writer = (await f.create({ branchPattern: 'agent/*' }, 'bob')).secret;
  assert.equal((await f.push(basic(writer), 'refs/heads/agent/one')).status, 200);
  const refused = await f.push(basic(writer), 'refs/heads/agent/two');
  assert.equal(refused.status, 200); assert.equal(refused.headers.get('Retry-After'), '60');
  assert.match(Buffer.from(await refused.arrayBuffer()).toString(), /ng refs\/heads\/agent\/two budget: 1 writes per minute for this api token reached; retry in 60 s/);
  assert.deepEqual(f.pushes.map(p => p.ref), ['refs/heads/agent/one']);
  // The probe Git sends before a large push is a request, not a write; the refused push counted against nothing.
  const probe = await f.git(basic(writer), 'git-receive-pack', { method: 'POST', type: 'git-receive-pack', body: Buffer.from('0000') });
  assert.equal(probe.status, 200);
  assert.deepEqual(f.env.agentBudgets.usage('token', (await f.session({ action: 'list' }, 'bob')).tokens[0].id), { requests: 2, writes: 1, resetsInSeconds: 60 });
});

test('MCP: over budget is a tool error (HTTP 200, isError) naming the budget; one write tool call is one write', async t => {
  const f = await budgets(t, { tokenRequestsPerMinute: 4, tokenWritesPerMinute: 1 });
  const { secret, token } = await f.create({});
  // create_branch calls the Source API internally; that call is not charged again.
  const created = await f.mcp(secret, 'tools/call', { name: 'create_branch', arguments: { ...repository, branch: 'agent/budget', from: 'feature' } });
  assert.equal(created.result.isError, undefined, JSON.stringify(created));
  assert.deepEqual(f.env.agentBudgets.usage('token', token.id), { requests: 1, writes: 1, resetsInSeconds: 60 });
  const write = await f.mcp(secret, 'tools/call', { name: 'comment', arguments: { ...repository, number: 12, body: 'hi' } }, 7);
  assert.equal(write.status, 200); assert.equal(write.id, 7); assert.equal(write.headers.get('Retry-After'), '60');
  assert.deepEqual(write.result, { isError: true, content: [{ type: 'text', text: 'API token budget: 1 writes per minute reached; retry in 60 s.' }] });
  // Reads still pass until the request budget is spent; notifications are not counted.
  assert.equal((await f.mcp(secret, 'tools/call', { name: 'repo_overview', arguments: repository })).result.isError, undefined);
  assert.equal((await f.mcp(secret, 'notifications/initialized', undefined, null)).status, 202);
  assert.equal((await f.mcp(secret, 'ping', undefined, 'p')).status, 200);
  assert.equal((await f.mcp(secret, 'tools/list', undefined, 9)).result.tools.length > 0, true);
  const over = await f.mcp(secret, 'ping', undefined, 'q');
  assert.equal(over.status, 200); assert.equal(over.id, 'q'); assert.equal(over.result.content[0].text, 'API token budget: 4 requests per minute reached; retry in 60 s.');
  assert.deepEqual(f.env.agentBudgets.usage('token', token.id), { requests: 4, writes: 1, resetsInSeconds: 60 });
});

test('Source API: 429 JSON {code, message, retryAfter}; commit and branch are writes, files and tree are requests', async t => {
  const f = await budgets(t, { tokenRequestsPerMinute: 3, tokenWritesPerMinute: 1 });
  const { secret, token } = await f.create({});
  assert.equal((await f.rpc('/native/source/tree', { repository, repositoryId: '1', commitId: feature }, secret)).status !== 429, true);
  assert.equal((await f.rpc('/native/source/branch', { repository, repositoryId: '1', branch: 'agent/x', action: 'create', from: 'feature' }, secret)).status, 200);
  const write = await f.rpc('/native/source/commit', { repository, repositoryId: '1' }, secret);
  assert.equal(write.status, 429); assert.equal(write.headers.get('Retry-After'), '60');
  assert.deepEqual({ code: write.code, message: write.message, retryAfter: write.retryAfter }, { code: 'resource_exhausted', message: 'API token budget: 1 writes per minute reached; retry in 60 s.', retryAfter: 60 });
  assert.equal((await f.rpc('/native/source/files', { repository, repositoryId: '1', commitId: feature, paths: ['hello.txt'] }, secret)).status !== 429, true);
  const read = await f.rpc('/native/source/tree', { repository, repositoryId: '1', commitId: feature }, secret);
  assert.equal(read.status, 429); assert.equal(read.message, 'API token budget: 3 requests per minute reached; retry in 60 s.');
  assert.deepEqual(f.env.agentBudgets.usage('token', token.id), { requests: 3, writes: 1, resetsInSeconds: 60 });
});

test('people are never counted: browser sessions, native credentials and Git credentials pass at any rate', async t => {
  const f = await budgets(t, { tokenRequestsPerMinute: 1, tokenWritesPerMinute: 1, taskRequestsPerMinute: 1, taskWritesPerMinute: 1 });
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.session({ action: 'list' })).status, 200);
    assert.equal((await f.mcp(tokens.admin, 'ping', undefined, i)).status, 200);
    assert.equal((await f.mcp(tokens.admin, 'ping', undefined, i)).result.isError, undefined);
    assert.equal((await f.rpc('/native/source/tree', { repository, repositoryId: '1', commitId: feature }, tokens.admin)).status !== 429, true);
    assert.equal((await f.git(bearer(tokens.admin), 'info/refs?service=git-upload-pack')).status !== 429, true);
  }
  assert.equal(f.env.agentBudgets.size, 0);
});

test('agent task tokens: JSON routes answer 429 JSON, task Git fetches 429 and task pushes Git’s own report', async t => {
  const f = await budgets(t, { taskRequestsPerMinute: 3, taskWritesPerMinute: 1 });
  f.sql.exec(`INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,created_at,last_seen_at) VALUES(1,'${crypto.randomUUID()}','box','personal','1',1,'host-digest','t','t')`);
  const task = async (id, branch) => {
    const token = `golf_agent_task_${id}_${'f'.repeat(64)}`;
    f.sql.prepare(`INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,token_digest,deadline,idempotency_key,created_at,updated_at)
      VALUES(?,1,?,1,'claude',1,'issue',12,'main',?,?,'p','RUNNING',?,?,?,'t','t')`).run(id, 'repo-' + 'b'.repeat(32), 'a'.repeat(40), branch, await digest(token), Date.now() + 3_600_000, id);
    return token;
  };
  const machine = (id, action, token, body) => f.dispatch(new Request(`${origin}/native/agent-host/tasks/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }));
  const taskGit = (id, token, route, init = {}) => f.dispatch(new Request(`${origin}/native/agent-host/tasks/${id}/git/${route}`, { ...init, headers: { Authorization: 'Basic ' + btoa('golf:' + token), ...init.headers } }));
  const one = crypto.randomUUID(), first = await task(one, 'golf-agent/one');
  for (let i = 0; i < 3; i++) assert.equal((await machine(one, 'log', first, { offset: i, lines: ['line ' + i] })).status, 200);
  const log = await machine(one, 'log', first, { offset: 3, lines: ['more'] });
  assert.equal(log.status, 429); assert.equal(log.headers.get('Retry-After'), '60');
  assert.deepEqual(await log.json(), { code: 'resource_exhausted', message: 'Agent task budget: 3 requests per minute reached; retry in 60 s.', retryAfter: 60 });
  const fetch = await taskGit(one, first, 'info/refs?service=git-upload-pack');
  assert.equal(fetch.status, 429); assert.equal(await fetch.text(), 'Agent task budget: 3 requests per minute reached; retry in 60 s.\n');
  // An unknown token is refused before anything is counted.
  assert.equal((await machine(one, 'log', `golf_agent_task_${one}_${'0'.repeat(64)}`, { offset: 0, lines: [] })).status, 401);
  // Another task has its own budget: one push lands, the next is refused in Git's report.
  const two = crypto.randomUUID(), second = await task(two, 'golf-agent/two');
  const push = (next, old) => taskGit(two, second, 'git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([packetLine(`${old} ${next} refs/heads/golf-agent/two\0report-status side-band-64k agent=git/2.43.0\n`), Buffer.from('0000PACK0000')]) });
  const landed = await push(feature, zero);
  assert.equal(landed.status, 200, await landed.clone().text());
  const refused = await push('c'.repeat(40), feature);
  assert.equal(refused.status, 200); assert.equal(refused.headers.get('Retry-After'), '60');
  assert.match(Buffer.from(await refused.arrayBuffer()).toString(), /ng refs\/heads\/golf-agent\/two budget: 1 writes per minute for this agent task reached; retry in 60 s/);
  assert.deepEqual(f.pushes.map(p => p.ref), ['refs/heads/golf-agent/two']);
  assert.deepEqual(f.env.agentBudgets.usage('task', two), { requests: 1, writes: 1, resetsInSeconds: 60 });
});

test('the token list shows each token’s current window and the budget in force', async t => {
  const f = await budgets(t, { tokenRequestsPerMinute: 50, tokenWritesPerMinute: 5 });
  const { secret, token } = await f.create({ permission: 'read' });
  await f.mcp(secret, 'ping'); await f.mcp(secret, 'ping');
  const list = await f.session({ action: 'list' });
  assert.deepEqual(list.budget, { enabled: true, requestsPerMinute: 50, writesPerMinute: 5 });
  assert.deepEqual(list.tokens.find(t => t.id === token.id).usage, { requests: 2, writes: 0, resetsInSeconds: 60 });
  // Where nothing counts (no Workspace counter), the list says so with null and no usage.
  delete f.env.agentBudgets;
  const bare = await f.session({ action: 'list' });
  assert.equal(bare.budget, null); assert.equal(bare.tokens[0].usage, undefined);
});

// The installation setting: defaults, validation, widening, audit and the Workspace's cached read.
const admin = (f, body, headers = {}) => f.dispatch(new Request(origin + '/native/installation' + (body.action === 'read' ? '/read' : ''), { method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': 'alice@example.invalid', ...headers } })).then(async r => ({ status: r.status, ...await r.json() }));

test('installation policy: defaults, bounds 1 to 100,000, widening needs confirmation, every change audited and applied at once', async t => {
  const f = await budgets(t);
  f.sql.exec('INSERT INTO operations_admins(user_id) VALUES(1)');
  let reads = 0;
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = query => { if (query.includes("key='agent-budgets'")) reads++; return prepare(query); };
  assert.deepEqual(await budgetPolicy(f.env, f.env.DB), budgetDefaults);
  assert.deepEqual(budgetDefaults, { enabled: true, tokenRequestsPerMinute: 600, tokenWritesPerMinute: 60, taskRequestsPerMinute: 600, taskWritesPerMinute: 120 });
  const overview = await admin(f, { action: 'read' });
  const item = overview.groups.flatMap(group => group.items).find(item => item.id === 'agent-budgets');
  assert.equal(item.state, 'configured'); assert.equal(item.policy.version, '0'); assert.equal(item.policy.source, 'deploy');
  assert.deepEqual(item.policy.value, budgetDefaults); assert.deepEqual(item.policy.bounds.tokenWritesPerMinute, [1, 100000]);
  assert.deepEqual(item.values.map(v => v.value), ['On', '600 requests and 60 writes a minute', '600 requests and 120 writes a minute']);
  const update = (value, extra = {}, headers = {}) => admin(f, { action: 'update', key: 'agent-budgets', value, expectedVersion: '0', operationId: crypto.randomUUID(), ...extra }, headers);
  for (const bad of [{ ...budgetDefaults, tokenWritesPerMinute: 0 }, { ...budgetDefaults, taskRequestsPerMinute: 100001 }, { ...budgetDefaults, tokenRequestsPerMinute: 1.5 }, { ...budgetDefaults, enabled: 'yes' }, { ...budgetDefaults, extra: 1 }, { enabled: true }]) {
    const refused = await update(bad);
    assert.equal(refused.status, 400, JSON.stringify(bad)); assert.equal(refused.message, 'Choose on or off and four whole numbers from 1 to 100,000 a minute.');
  }
  // Narrowing saves at once; the Workspace's cached policy is dropped by the save, so the next token request uses it.
  const { secret } = await f.create({});
  await f.mcp(secret, 'ping');
  const readsBefore = reads;
  await f.mcp(secret, 'ping');
  assert.equal(reads, readsBefore, 'the policy is cached between requests');
  const narrowed = await update({ ...budgetDefaults, tokenRequestsPerMinute: 2 });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed)); assert.equal(narrowed.widening, false); assert.equal(narrowed.version, '1');
  assert.equal((await f.mcp(secret, 'ping')).result.content[0].text, 'API token budget: 2 requests per minute reached; retry in 60 s.');
  // Raising a limit or turning budgets off widens: typed confirmation and a recent Access sign-in.
  const raise = { ...budgetDefaults, tokenRequestsPerMinute: 5000 };
  const unconfirmed = await update(raise, { expectedVersion: '1' });
  assert.equal(unconfirmed.status, 412); assert.match(unconfirmed.message, /widens agent rate budgets\. Type agent-budgets/);
  const stale = await update(raise, { expectedVersion: '1', confirmation: 'agent-budgets' });
  assert.equal(stale.status, 412); assert.match(stale.message, /last 10 minutes/);
  const recent = { 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000) - 30), 'X-Golf-Native-Access-Colo': 'LHR', 'X-Golf-Native-Access-Country': 'GB' };
  const off = await update({ ...budgetDefaults, enabled: false }, { expectedVersion: '1', confirmation: 'agent-budgets' }, recent);
  assert.equal(off.status, 200); assert.equal(off.widening, true);
  for (let i = 0; i < 3; i++) assert.equal((await f.mcp(secret, 'ping')).result.isError, undefined);
  const audit = f.sql.prepare("SELECT subject,action,before,after,widening,client FROM installation_audit WHERE subject='agent-budgets' ORDER BY id").all();
  assert.deepEqual(audit.map(row => [row.action, row.widening, JSON.parse(row.after).tokenRequestsPerMinute, JSON.parse(row.after).enabled]), [['update', 0, 2, true], ['update', 1, 600, false]]);
  assert.deepEqual(JSON.parse(audit[0].before), budgetDefaults); assert.deepEqual(JSON.parse(audit[1].client), { colo: 'LHR', country: 'GB' });
  const after = (await admin(f, { action: 'read' })).groups.flatMap(group => group.items).find(item => item.id === 'agent-budgets');
  assert.equal(after.policy.source, 'installation'); assert.equal(after.values[0].value, 'Off (counted, never refused)');
  assert.ok((await admin(f, { action: 'read' })).recent.some(entry => entry.subject === 'agent-budgets'));
  // An unreadable stored value, or a locked installation, uses the defaults.
  f.sql.exec("UPDATE installation_settings SET value='{\"enabled\":1}' WHERE key='agent-budgets'");
  f.env.agentBudgets.invalidate();
  assert.deepEqual(await budgetPolicy(f.env, f.env.DB), budgetDefaults);
  f.sql.exec(`UPDATE installation_settings SET value='${JSON.stringify({ ...budgetDefaults, taskWritesPerMinute: 7 })}' WHERE key='agent-budgets'`);
  // Without an invalidation, a change made elsewhere applies within a minute.
  assert.deepEqual(await budgetPolicy(f.env, f.env.DB), budgetDefaults);
  f.clock.t += 60_000;
  assert.equal((await budgetPolicy(f.env, f.env.DB)).taskWritesPerMinute, 7);
  f.env.INSTALLATION_POLICY_EDITING = 'false'; f.env.agentBudgets.invalidate();
  assert.deepEqual(await budgetPolicy(f.env, f.env.DB), budgetDefaults);
});
