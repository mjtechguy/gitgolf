import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle, concurrentRead } from './src/core.mjs';
import { machineTokenRoute } from './src/api-tokens.mjs';
import { runnerPools, labelName, poolLabels, ciCostChange, requestable } from './src/capacity.mjs';

const origin = 'https://golf.example.com';
const ago = seconds => new Date(Date.now() - seconds * 1000).toISOString();

async function fixture(t, extra = {}) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.invalid',1),(2,'bob','bob@example.invalid',1),(3,'carol','carol@example.invalid',1);
    INSERT INTO operations_admins(user_id) VALUES(1),(2); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','space');
    INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(10,'acme','ORGANIZATION',1);
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'k1','h','ACTIVE','2026-10-01T00:00:00Z'),(2,'other','','repo-2',1,'k2','h','ACTIVE','2026-10-01T00:00:00Z');
    INSERT INTO repository_owners VALUES(1,10)`);
  const statement = query => { const s = sql.prepare(query); let args = [];
    return { query, bind(...values) { args = values; return this; }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: { changes: s.run(...args).changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement,
    async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); } catch (error) { sql.exec('ROLLBACK'); throw error; } return out; } };
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'space', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '10',
    PREVIEW_ORIGIN: 'https://previews.example.net', PREVIEW_PATH: 'public', PREVIEW_TTL: '3600', PREVIEW_ACCESS_AUD: 'preview-aud',
    PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {}, TEST_EXECUTION_ENABLED: 'true', ...extra };
  const call = async (who, path, body, headers = {}) => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
      ...(who ? { 'X-Golf-Native-Access-Email': who + '@example.invalid' } : {}), ...headers }, body: JSON.stringify(body) }), env);
    return { status: response.status, value: await response.json() };
  };
  const signedIn = { 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)) };
  const metrics = async (secret, query) => {
    const response = await handle(new Request(origin + '/native/capacity/metrics' + query, { headers: secret ? { Authorization: 'Bearer ' + secret } : {} }), env);
    return { status: response.status, value: await response.json() };
  };
  const audit = () => sql.prepare("SELECT action,subject,actor_id,before,after,client FROM installation_audit ORDER BY id").all();
  return { sql, env, call, signedIn, metrics, audit };
}

// Runners and queued jobs as the claim sees them; pipelines.mjs claimPipelineJob is the rule.
function seedPipelines(sql) {
  const runner = sql.prepare("INSERT INTO pipeline_runners(id,uuid,engine,scope,scope_id,name,labels,token_digest,state,created_by,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,1,'2026-10-01T00:00:00Z',?)");
  runner.run(1, 'u1', 'forgejo-actions', 'installation', '', 'k8s-a', JSON.stringify(['ubuntu-latest:docker://node:20', 'docker']), 'd1', 'ACTIVE', ago(30));
  runner.run(2, 'u2', 'forgejo-actions', 'installation', '', 'k8s-b', JSON.stringify(['docker', 'ubuntu-latest:docker://other:1']), 'd2', 'ACTIVE', ago(3600));
  runner.run(3, 'u3', 'gitlab-ci', 'repository', '2', 'gl', JSON.stringify(['docker']), 'd3', 'ACTIVE', ago(10));
  runner.run(4, 'u4', 'forgejo-actions', 'organization', '10', 'gpu-1', JSON.stringify(['gpu']), 'd4', 'DISABLED', ago(10));
  const run = sql.prepare("INSERT INTO pipeline_runs(id,repository_id,artifact_name,engine,number,workflow_path,workflow_name,event,ref,commit_id,actor_id,trusted,state,created_at,updated_at) VALUES(?,?,?,?,?,'.forgejo/workflows/ci.yml','ci','push','refs/heads/main','c',1,1,?,'t','t')");
  run.run(1, 1, 'repo-1', 'forgejo-actions', 1, 'RUNNING'); run.run(2, 2, 'repo-2', 'forgejo-actions', 1, 'QUEUED'); run.run(3, 1, 'repo-1', 'gitlab-ci', 1, 'QUEUED');
  run.run(4, 2, 'repo-2', 'gitlab-ci', 1, 'QUEUED'); run.run(5, 1, 'repo-1', 'forgejo-actions', 2, 'CANCELLED');
  const job = sql.prepare("INSERT INTO pipeline_jobs(run_id,attempt,engine,job_key,name,runs_on,payload,state,runner_id,created_at,queued_at,updated_at) VALUES(?,1,?,?,?,?,'x',?,?,'t',?,'t')");
  job.run(1, 'forgejo-actions', 'build', 'build', JSON.stringify(['ubuntu-latest']), 'QUEUED', null, ago(120));
  job.run(1, 'forgejo-actions', 'image', 'image', JSON.stringify(['ubuntu-latest:docker://x:1', 'docker']), 'QUEUED', null, ago(30));
  job.run(1, 'forgejo-actions', 'train', 'train', JSON.stringify(['gpu']), 'QUEUED', null, ago(600));
  job.run(1, 'forgejo-actions', 'running', 'running', JSON.stringify(['docker']), 'RUNNING', 1, ago(900));
  job.run(2, 'forgejo-actions', 'train', 'train', JSON.stringify(['gpu']), 'QUEUED', null, ago(60));
  job.run(2, 'forgejo-actions', 'win', 'win', JSON.stringify(['windows']), 'QUEUED', null, ago(5));
  job.run(3, 'gitlab-ci', 'test', 'test', JSON.stringify(['docker']), 'QUEUED', null, ago(40));
  job.run(4, 'gitlab-ci', 'lint', 'lint', '[]', 'QUEUED', null, ago(20));
  // A cancelled run's queued job is never claimed, so it is not counted.
  job.run(5, 'forgejo-actions', 'stale', 'stale', JSON.stringify(['docker']), 'QUEUED', null, ago(9000));
}

test('pools group runners by engine and label names; queued jobs match the claim rule by labels and scope', async t => {
  assert.equal(labelName('ubuntu-latest:docker://node:20'), 'ubuntu-latest');
  assert.deepEqual(poolLabels(['ubuntu-latest:docker://a', 'docker', 'ubuntu-latest:docker://b']), ['docker', 'ubuntu-latest']);
  const f = await fixture(t); seedPipelines(f.sql);
  const { status, value } = await f.call('alice', '/native/capacity/read', { action: 'read' });
  assert.equal(status, 200, JSON.stringify(value));
  const pools = Object.fromEntries(value.selfHosted.pools.map(pool => [pool.id, pool]));
  // Two runners whose images differ share one pool: matching is by label name.
  const k8s = pools['forgejo-actions:docker,ubuntu-latest'];
  assert.deepEqual({ registered: k8s.registered, active: k8s.active, online: k8s.online, running: k8s.running, queued: k8s.queued }, { registered: 2, active: 2, online: 1, running: 1, queued: 2 });
  assert.ok(k8s.oldestWaitSeconds >= 119 && k8s.oldestWaitSeconds <= 125, String(k8s.oldestWaitSeconds));
  // The organization pool's only runner is disabled: the job in its organization is its queue, and no active runner can take it.
  const gpu = pools['forgejo-actions:gpu'];
  assert.deepEqual({ active: gpu.active, queued: gpu.queued }, { active: 0, queued: 1 });
  // A repository runner takes its own repository's jobs only; an untagged GitLab job runs on any tagged runner, as the claim allows.
  assert.equal(pools['gitlab-ci:docker'].queued, 1);
  // Unmatched: both gpu jobs (no active gpu runner), windows, and the GitLab job in another repository.
  assert.deepEqual(value.selfHosted.unmatched.byEngine, { 'forgejo-actions': 3, 'gitlab-ci': 1 });
  assert.equal(value.selfHosted.unmatched.queued, 4);
  assert.ok(value.selfHosted.unmatched.oldestWaitSeconds >= 599);
  assert.equal(value.selfHosted.configured, true);
  // The pure function agrees on a hand-made pool.
  const { pools: [only], unmatched } = runnerPools([{ engine: 'gitlab-ci', scope: 'installation', scope_id: '', labels: '["a","b"]', state: 'ACTIVE', last_seen_at: ago(1), running: 2 }],
    [{ engine: 'gitlab-ci', runs_on: '["a"]', since: ago(10), repository_id: 1, owner_id: null }, { engine: 'gitlab-ci', runs_on: '["c"]', since: ago(10), repository_id: 1, owner_id: null },
      { engine: 'forgejo-actions', runs_on: '["a"]', since: ago(10), repository_id: 1, owner_id: null }]);
  assert.deepEqual({ queued: only.queued, running: only.running, online: only.online, unmatched: unmatched.queued }, { queued: 1, running: 2, online: 1, unmatched: 2 });
});

test('the capacity inventory is for operations administrators, read in the stateless Worker, and reports every source honestly', async t => {
  const f = await fixture(t);
  assert.equal(concurrentRead(new Request(origin + '/native/capacity/read', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + '/native/capacity', { method: 'POST' })), false);
  assert.equal((await f.call('carol', '/native/capacity/read', { action: 'read' })).status, 403);
  assert.equal((await f.call('', '/native/capacity/read', { action: 'read' })).status, 401);
  assert.equal((await f.call('carol', '/native/capacity', { action: 'request', key: 'evidence', field: 'dailyLimit', value: 20, reason: 'x' })).status, 403);
  // A denied read is in the audit log.
  assert.ok(f.audit().some(row => row.action === 'installation.access_denied' && row.subject === 'runner capacity'));
  f.sql.exec(`INSERT INTO native_runner_pools VALUES('p1','metal',1,'ACTIVE','UNTRUSTED',3,'img','t');
    INSERT INTO native_runner_machines(id,pool_id,name,version,state,sponsor_id,credential_digest,expires_at,created_at) VALUES('m1','p1','one',1,'ACTIVE',1,'c1',9999999999,'t'),('m2','p1','two',1,'REVOKED',1,'c2',9999999999,'t');
    INSERT INTO native_runner_placements VALUES(2,'p1',1,1,'t');
    INSERT INTO agent_hosts(id,uuid,name,scope,scope_id,registered_by,credential_digest,max_concurrent,last_seen_at,created_at) VALUES(1,'h1','laptop','installation','',1,'x1',2,'${ago(5)}','t'),(2,'h2','box','installation','',1,'ssh:abc',3,NULL,'t'),(3,'h3','old','installation','',1,'x3',4,'${ago(500)}','t');
    INSERT INTO agent_tasks(id,repository_id,artifact_name,host_id,tool,requested_by,target_kind,target_number,base_ref,base_commit,branch,prompt,state,deadline,idempotency_key,created_at,updated_at)
      VALUES('t1',1,'repo-1',1,'codex',1,'issue',1,'main','c','b','p','RUNNING',0,'i1','t','t'),('t2',1,'repo-1',2,'codex',1,'issue',1,'main','c','b','p','QUEUED',0,'i2','t','t'),('t3',1,'repo-1',2,'codex',1,'issue',1,'main','c','b','p','CLAIMED',0,'i3','t','t')`);
  const later = new Date(Date.now() + 3600_000).toISOString(), evidence = f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,agent_state,created_at,updated_at,expires_at) VALUES(?,?,1,?,'h','{}','NONE',?,?,'t','t',?)");
  evidence.run('e1', 1, 'o1', 'RUNNING', 'NONE', later); evidence.run('e2', 1, 'o2', 'REQUESTED', 'NONE', later); evidence.run('e3', 2, 'o3', 'REQUESTED', 'NONE', later); evidence.run('e4', 1, 'o4', 'NONE', 'REQUESTED', later);
  const { value } = await f.call('alice', '/native/capacity/read', { action: 'read' });
  assert.deepEqual(value.nativePools.map(pool => [pool.name, pool.maxParallel, pool.activeMachines, pool.running, pool.queued]), [['metal', 3, 1, 0, 1]]);
  const containers = Object.fromEntries(value.containers.map(row => [row.id, row]));
  // No container allocation is bound into the Worker: none is invented.
  for (const row of value.containers) { assert.equal(row.allocation, null); assert.match(row.allocationReason, /max_instances/); }
  assert.deepEqual([containers['pr-tests'].running, containers['pr-tests'].queued, containers['pr-tests'].limit.value, containers['pr-tests'].limit.inUse], [1, 1, 2, 1]);
  assert.deepEqual([containers['agent-proposals'].configured, containers['agent-proposals'].queued], [false, 1]);
  assert.deepEqual([containers['ssh-tasks'].running, containers['ssh-tasks'].queued, containers['ssh-tasks'].limit.value], [1, 1, 3]);
  const hosts = Object.fromEntries(value.hosts.map(row => [row.id, row]));
  assert.deepEqual([hosts['agent-hosts'].hosts, hosts['agent-hosts'].capacity, hosts['agent-hosts'].online, hosts['agent-hosts'].running, hosts['agent-hosts'].queued], [2, 6, 1, 1, 0]);
  assert.deepEqual([hosts['ssh-hosts'].hosts, hosts['ssh-hosts'].capacity, hosts['ssh-hosts'].online, hosts['ssh-hosts'].running], [1, 3, null, 1]);
  const settings = Object.fromEntries(value.settings.map(row => [`${row.key}.${row.field}`, row]));
  assert.deepEqual([settings['evidence.dailyLimit'].current, settings['evidence.dailyLimit'].ceiling, settings['evidence.dailyLimit'].deployMax], [10, 10, 50]);
  assert.deepEqual([settings['previews.concurrency'].ceiling, settings['previews.concurrency'].deployMax], [4, null]);
  assert.equal(value.schema, 'ready');
});

test('a capacity metrics token reads queue depth for one pool, expires, is revoked, and reads nothing else', async t => {
  const f = await fixture(t); seedPipelines(f.sql);
  assert.equal((await f.call('alice', '/native/capacity', { action: 'createMetricsToken', label: 'keda golf-ci', lifetimeDays: 400 })).status, 400);
  const created = await f.call('alice', '/native/capacity', { action: 'createMetricsToken', label: 'keda-golf-ci', lifetimeDays: 30 });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const secret = created.value.secret;
  assert.match(secret, /^golf_capacity_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.value.metricsUrl, origin + '/native/capacity/metrics');
  // Only a digest is stored.
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM capacity_metrics_tokens WHERE digest LIKE ?').get('golf_%').n, 0);
  const listed = (await f.call('alice', '/native/capacity/read', { action: 'read' })).value.tokens;
  assert.deepEqual(listed.map(token => [token.label, token.state, token.createdBy]), [['keda-golf-ci', 'active', 'alice']]); assert.ok(!JSON.stringify(listed).includes(secret));
  // The public Worker lets the token past Access on this route only.
  assert.equal(machineTokenRoute('/native/capacity/metrics', 'Bearer ' + secret), true);
  for (const path of ['/native/capacity/read', '/native/capacity', '/mcp', '/native/source/tree', '/git/acme/project.git/info/refs']) assert.equal(machineTokenRoute(path, 'Bearer ' + secret), false, path);
  assert.equal(machineTokenRoute('/native/capacity/metrics', 'Bearer golf_pat_' + 'a'.repeat(43)), false);
  const read = await f.metrics(secret, '?engine=forgejo-actions&labels=ubuntu-latest:docker://node:20,docker');
  assert.equal(read.status, 200, JSON.stringify(read.value));
  assert.equal(read.value.pool, 'forgejo-actions:docker,ubuntu-latest');
  assert.deepEqual([read.value.queued, read.value.running, read.value.online, read.value.registered], [2, 1, 1, 2]);
  assert.ok(read.value.oldestWaitSeconds >= 119); assert.ok(Date.parse(read.value.at) > 0);
  // A label set with no runners yet still publishes its queue, so an autoscaler can start from zero.
  const windows = await f.metrics(secret, '?engine=forgejo-actions&labels=windows');
  assert.deepEqual([windows.value.queued, windows.value.running, windows.value.online, windows.value.registered], [1, 0, 0, 0]);
  assert.equal((await f.metrics(secret, '?engine=jenkins&labels=a')).status, 400);
  assert.equal((await f.metrics(secret, '?engine=gitlab-ci&labels=a&extra=1')).status, 400);
  assert.ok(f.sql.prepare('SELECT last_used_at FROM capacity_metrics_tokens').get().last_used_at);
  // It reads nothing else: every other route treats it as no credential at all.
  assert.equal((await f.call('', '/native/capacity/read', { action: 'read' }, { Authorization: 'Bearer ' + secret })).status, 401);
  assert.equal((await f.call('', '/rpc/golf.v1.RepositoryService/ListRepositories', {}, { Authorization: 'Bearer ' + secret })).status, 401);
  assert.equal((await f.call('', '/native/source/tree', { repository: { owner: 'acme', name: 'project' } }, { Authorization: 'Bearer ' + secret })).status, 401);
  assert.equal((await f.metrics('', '?engine=forgejo-actions&labels=docker')).status, 401);
  assert.equal((await f.metrics('golf_capacity_' + 'x'.repeat(43), '?engine=forgejo-actions&labels=docker')).status, 401);
  // Expiry.
  f.sql.prepare('UPDATE capacity_metrics_tokens SET expires_at=?').run(ago(1));
  assert.equal((await f.metrics(secret, '?engine=forgejo-actions&labels=docker')).status, 401);
  f.sql.prepare('UPDATE capacity_metrics_tokens SET expires_at=?').run(new Date(Date.now() + 86400_000).toISOString());
  assert.equal((await f.metrics(secret, '?engine=forgejo-actions&labels=docker')).status, 200);
  // Revocation, audited with the label and never the secret.
  const id = created.value.token.id;
  assert.equal((await f.call('carol', '/native/capacity', { action: 'revokeMetricsToken', id })).status, 403);
  const revoked = await f.call('bob', '/native/capacity', { action: 'revokeMetricsToken', id });
  assert.equal(revoked.value.token.state, 'revoked');
  assert.equal((await f.metrics(secret, '?engine=forgejo-actions&labels=docker')).status, 401);
  assert.equal((await f.call('bob', '/native/capacity', { action: 'revokeMetricsToken', id })).status, 412);
  const rows = f.audit().filter(row => row.action.startsWith('capacity_metrics_token.'));
  // Carol's refused attempt is recorded as denied.
  assert.deepEqual(rows.map(row => [row.action, row.subject, row.actor_id, JSON.parse(row.client).outcome || 'success']),
    [['capacity_metrics_token.create', 'keda-golf-ci', 1, 'success'], ['capacity_metrics_token.revoke', 'keda-golf-ci', 3, 'denied'], ['capacity_metrics_token.revoke', 'keda-golf-ci', 2, 'success']]);
  assert.ok(!JSON.stringify(f.audit()).includes(secret));
});

test('the cost of more daily admissions is priced per measured CI run, an upper bound; without a measurement it is not invented', () => {
  const units = [{ rate: 'r2.class-a', perCiRun: 1000 }, { rate: 'r2.class-b', perCiRun: 5000 }, { rate: 'queues.operations', perCiRun: 100 }, { rate: 'workers.requests', perWrite: 3, perLand: null }];
  // 40 a day for a month: 1,216 runs × 1,000 Class A = 1.216 M, 216,000 over the 1 M allowance at $4.50 a million; 10 a day stays inside it.
  const change = ciCostChange(units, 10, 40);
  assert.equal(change.delta, 0.97);
  assert.match(change.basis, /Upper bound: 30 more admissions a day × 30.4 days = up to 912 more CI runs a month/);
  assert.match(change.basis, /container time per test run \(not measured\)/);
  const none = ciCostChange([{ rate: 'r2.class-a', perCiRun: null }], 10, 40);
  assert.equal(none.delta, null); assert.match(none.basis, /No cost per CI run is measured/);
  assert.deepEqual(Object.keys(requestable).sort(), ['agent-budgets', 'evidence', 'previews']);
});

test('capacity requests: validated by the policy, needs_deploy above the ceiling, two people, applied through installation policy, audited', async t => {
  const f = await fixture(t);
  const request = (who, body) => f.call(who, '/native/capacity', { action: 'request', reason: 'Bench at 200 agents', ...body });
  // Validation: a known setting, a whole number above the current value, within what a deploy can allocate.
  assert.equal((await request('alice', { key: 'webhooks', field: 'dailyLimit', value: 10 })).status, 400);
  assert.equal((await request('alice', { key: 'evidence', field: 'dailyLimit', value: 5 })).status, 400);
  assert.equal((await request('alice', { key: 'evidence', field: 'dailyLimit', value: 10.5 })).status, 400);
  assert.match((await request('alice', { key: 'evidence', field: 'dailyLimit', value: 51 })).value.message, /cannot go above 50, even with a deploy/);
  assert.match((await request('alice', { key: 'previews', field: 'concurrency', value: 5 })).value.message, /fixed in code/);
  assert.equal((await f.call('alice', '/native/capacity', { action: 'request', key: 'evidence', field: 'dailyLimit', value: 8 })).status, 400);
  assert.equal((await f.call('alice', '/native/capacity/read', { action: 'preview', key: 'evidence', field: 'dailyLimit', value: 30 })).value.needsDeploy, true);

  // Within the ceiling: the preview lowers it first; then a request.
  await f.call('alice', '/native/installation', { action: 'update', key: 'evidence', expectedVersion: '0', operationId: crypto.randomUUID(), value: { dailyLimit: 4 } });
  const asked = await request('alice', { key: 'evidence', field: 'dailyLimit', value: 8 });
  assert.equal(asked.status, 200, JSON.stringify(asked.value));
  const r = asked.value.request;
  assert.deepEqual([r.current, r.requested, r.ceiling, r.needsDeploy, r.state, r.requestedBy, r.mine], [4, 8, 10, false, 'PENDING', 'alice', true]);
  // No analytics token: the cost change is not estimated, and says why.
  assert.equal(r.estimatedMonthlyDelta, null); assert.match(r.estimateBasis, /No cost per CI run is measured/);
  assert.equal((await request('bob', { key: 'evidence', field: 'dailyLimit', value: 9 })).status, 409);
  const preview = await request('alice', { key: 'previews', field: 'lifetimeSeconds', value: 1800 });
  assert.equal(preview.status, 400); // 3600 is the deploy lifetime and the current value
  const budgets = await request('bob', { key: 'agent-budgets', field: 'tokenWritesPerMinute', value: 120 });
  assert.equal(budgets.value.request.estimatedMonthlyDelta, null); assert.equal(budgets.value.request.estimateBasis, 'No cost model for this setting.');

  // Two people: the requester never approves or declines.
  const approve = (who, id, extra = {}, headers = f.signedIn) => f.call(who, '/native/capacity', { action: 'approve', id, operationId: crypto.randomUUID(), expectedVersion: '1', confirmation: 'evidence', ...extra }, headers);
  assert.equal((await approve('alice', r.id)).status, 403);
  assert.equal((await f.call('alice', '/native/capacity', { action: 'decline', id: r.id })).status, 403);
  assert.equal((await f.call('carol', '/native/capacity', { action: 'approve', id: r.id })).status, 403);
  // Approval inherits the installation rules: the typed confirmation, then an Access sign-in from the last 10 minutes for widening.
  assert.match((await approve('bob', r.id, { confirmation: '' })).value.message, /Type evidence/);
  assert.match((await approve('bob', r.id, {}, {})).value.message, /last 10 minutes/);
  assert.match((await approve('bob', r.id, {}, { 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000) - 900) })).value.message, /last 10 minutes/);
  assert.equal((await approve('bob', r.id, { expectedVersion: '0' })).status, 412); // stale version
  assert.equal(f.sql.prepare("SELECT state FROM capacity_requests WHERE id=?").get(Number(r.id)).state, 'PENDING');
  const applied = await approve('bob', r.id, { note: 'For the bench' });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.deepEqual([applied.value.request.state, applied.value.request.decidedBy, applied.value.request.appliedBy, applied.value.receipt.widening], ['APPLIED', 'bob', 'bob', true]);
  assert.deepEqual(JSON.parse(f.sql.prepare("SELECT value FROM installation_settings WHERE key='evidence'").get().value), { dailyLimit: 8 });
  assert.equal((await approve('bob', r.id, { expectedVersion: '2' })).status, 412);

  // Above the ceiling: approval records APPROVED with the deploy step; nothing is applied.
  const big = (await request('alice', { key: 'evidence', field: 'dailyLimit', value: 25 })).value.request;
  assert.deepEqual([big.needsDeploy, big.ceiling, big.deploy.setting], [true, 10, 'settings.evidence.daily_limit']);
  assert.match(big.deploy.steps, /golf_cloudflare\.py update DIR/);
  const waiting = await approve('bob', big.id, { expectedVersion: '2' });
  assert.equal(waiting.status, 200, JSON.stringify(waiting.value));
  assert.equal(waiting.value.request.state, 'APPROVED'); assert.ok(waiting.value.request.deploy);
  assert.deepEqual(JSON.parse(f.sql.prepare("SELECT value FROM installation_settings WHERE key='evidence'").get().value), { dailyLimit: 8 });
  assert.match((await approve('bob', big.id, { expectedVersion: '2' })).value.message, /still above the deploy ceiling/);
  // A deploy raises the ceiling; a second administrator then applies it through the same path.
  f.env.EVIDENCE_DAILY_LIMIT = '30';
  assert.equal((await approve('alice', big.id, { expectedVersion: '2' })).status, 403);
  const late = await approve('bob', big.id, { expectedVersion: '2' });
  assert.equal(late.value.request.state, 'APPLIED', JSON.stringify(late.value));
  assert.deepEqual(JSON.parse(f.sql.prepare("SELECT value FROM installation_settings WHERE key='evidence'").get().value), { dailyLimit: 25 });

  // Withdraw (the requester only) and decline (another administrator).
  assert.equal((await f.call('alice', '/native/capacity', { action: 'withdraw', id: budgets.value.request.id })).status, 403);
  assert.equal((await f.call('bob', '/native/capacity', { action: 'withdraw', id: budgets.value.request.id })).value.request.state, 'WITHDRAWN');
  const again = (await request('bob', { key: 'agent-budgets', field: 'tokenWritesPerMinute', value: 90 })).value.request;
  const declined = await f.call('alice', '/native/capacity', { action: 'decline', id: again.id, note: 'Not yet' });
  assert.deepEqual([declined.value.request.state, declined.value.request.decisionNote, declined.value.request.decidedBy], ['DECLINED', 'Not yet', 'alice']);
  assert.equal((await f.call('alice', '/native/capacity', { action: 'decline', id: again.id })).status, 412);

  // Pending first in the inventory.
  const third = (await request('alice', { key: 'agent-budgets', field: 'taskWritesPerMinute', value: 500 })).value.request;
  const listed = (await f.call('bob', '/native/capacity/read', { action: 'read' })).value.requests;
  assert.equal(listed[0].id, third.id); assert.equal(listed[0].mine, false);

  // Every action is audited, and the applied value has its installation policy row.
  const rows = f.audit().map(row => [row.action, row.subject, row.actor_id]);
  for (const expected of [['capacity_request.create', 'evidence.dailyLimit', 1], ['capacity_request.approve', 'evidence.dailyLimit', 2], ['capacity_request.apply', 'evidence.dailyLimit', 2],
    ['capacity_request.withdraw', 'agent-budgets.tokenWritesPerMinute', 2], ['capacity_request.decline', 'agent-budgets.tokenWritesPerMinute', 1], ['update', 'evidence', 2]])
    assert.ok(rows.some(row => JSON.stringify(row) === JSON.stringify(expected)), JSON.stringify(expected));
  // Refused attempts by the requester are recorded as denied.
  assert.ok(f.audit().some(row => row.action === 'capacity_request.approve' && row.actor_id === 1 && JSON.parse(row.client).outcome === 'denied'));
  const approval = f.audit().find(row => row.action === 'capacity_request.approve' && row.actor_id === 2);
  assert.deepEqual(JSON.parse(approval.after), { state: 'APPLIED', value: 8, requestId: r.id });
});

test('an approval that can no longer apply fails with the reason, and a locked installation applies nothing', async t => {
  const f = await fixture(t);
  const r = (await f.call('alice', '/native/capacity', { action: 'request', key: 'previews', field: 'lifetimeSeconds', value: 7200, reason: 'Longer reviews' })).value.request;
  assert.equal(r.needsDeploy, true);
  // The previews allocation is removed by a later deploy: nothing to apply.
  delete f.env.PREVIEW_ORIGIN;
  const failed = await f.call('bob', '/native/capacity', { action: 'approve', id: r.id, operationId: crypto.randomUUID(), expectedVersion: '0', confirmation: 'previews' }, f.signedIn);
  assert.equal(failed.value.request.state, 'FAILED'); assert.match(failed.value.request.decisionNote, /not allocated/);
  assert.ok(f.audit().some(row => row.action === 'capacity_request.approve' && JSON.parse(row.client).outcome === 'refused'));
  f.env.INSTALLATION_POLICY_EDITING = 'false';
  const locked = (await f.call('alice', '/native/capacity', { action: 'request', key: 'evidence', field: 'dailyLimit', value: 20, reason: 'More CI' }));
  // Locked: the deploy value applies, so asking above it needs a deploy.
  assert.equal(locked.value.request.needsDeploy, true);
  assert.match((await f.call('alice', '/native/capacity/read', { action: 'read' })).value.editing, /locked at deploy/);
});
