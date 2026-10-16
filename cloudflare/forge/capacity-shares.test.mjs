import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle, concurrentRead } from './src/core.mjs';
import { statelessRoute } from './src/public.mjs';
import { digest } from './src/common.mjs';
import * as p from './src/pipelines.mjs';
import { memoryBucket } from './pipeline-fixture.mjs';
import { gitLabPipelinePlan } from './src/gitlab-pipeline.mjs';
import { shareLimits, runnerPoolsPolicy, runnerSharesPolicy } from './src/capacity-policy.mjs';

// Runner capacity, slice 2 (docs/RUNNER_CAPACITY.md): pool caps and organization and repository shares, enforced in the claim and at run creation.
const origin = 'https://golf.example.com';
const run = (repositoryId, extra = {}) => ({ repositoryId, engine: 'forgejo-actions', workflowPath: '.github/workflows/ci.yml', workflowName: 'CI', event: 'push', ref: 'refs/heads/main', commitId: 'c'.repeat(40), actorId: 1, trusted: true, ...extra });
const jobs = (n, runsOn = ['ubuntu-latest']) => Array.from({ length: n }, (_, i) => ({ key: 'j' + i, name: 'j' + i, needs: [], runsOn, payload: 'jobs: {}' }));

async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  // alice and bob: operations administrators. carol: owner of acme and administrator of acme/project. dave: member of acme, writer on project.
  // erin: a personal repository. frank: nobody in particular.
  sql.exec(`INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.invalid',1),(2,'bob','bob@example.invalid',1),(3,'carol','carol@example.invalid',1),(4,'dave','dave@example.invalid',1),(5,'erin','erin@example.invalid',1),(6,'frank','frank@example.invalid',1);
    INSERT INTO operations_admins(user_id) VALUES(1),(2); INSERT INTO workspaces(slug,artifact_namespace) VALUES('space','space');
    INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(10,'acme','ORGANIZATION',3); INSERT INTO native_owners(id,slug,kind,user_id,creator_id) VALUES(11,'erin','PERSONAL',5,5);
    INSERT INTO native_owner_members(owner_id,user_id,role) VALUES(10,3,'owner'),(10,4,'member');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',3,'k1','h','ACTIVE','2026-10-01T00:00:00Z'),(2,'site','','repo-2',3,'k2','h','ACTIVE','2026-10-01T00:00:00Z'),(3,'notes','','repo-3',5,'k3','h','ACTIVE','2026-10-01T00:00:00Z');
    INSERT INTO repository_owners VALUES(1,10),(2,10),(3,11);
    INSERT INTO grants(repository_id,user_id,role) VALUES(1,3,'admin'),(1,4,'write'),(2,3,'admin'),(3,5,'admin')`);
  const statement = query => { const s = sql.prepare(query); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: { changes: s.run(...args).changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement,
    async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); } catch (error) { sql.exec('ROLLBACK'); throw error; } return out; } };
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'space', ARTIFACTS_NAMESPACE: 'space', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: memoryBucket() };
  const signedIn = () => ({ 'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)) });
  const call = async (who, path, body, headers = {}) => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
      ...(who ? { 'X-Golf-Native-Access-Email': who + '@example.invalid' } : {}), ...headers }, body: JSON.stringify(body) }), env);
    return { status: response.status, value: await response.json().catch(() => null) };
  };
  const policy = async (who, key, value, extra = {}, headers = {}) => {
    const version = String(sql.prepare('SELECT version FROM installation_settings WHERE key=?').get(key)?.version || 0);
    return call(who, '/native/installation', { action: 'update', key, value, expectedVersion: version, operationId: crypto.randomUUID(), ...extra }, headers);
  };
  let runnerId = 100;
  const runner = (labels, engine = 'forgejo-actions', scope = ['installation', '']) => {
    const id = runnerId++;
    sql.prepare("INSERT INTO pipeline_runners(id,uuid,engine,scope,scope_id,name,labels,token_digest,state,created_by,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,'ACTIVE',1,'t',?)")
      .run(id, 'u' + id, engine, scope[0], scope[1], 'r' + id, JSON.stringify(labels), 'd' + id, new Date().toISOString());
    return sql.prepare('SELECT * FROM pipeline_runners WHERE id=?').get(id);
  };
  const running = (where = '1=1') => sql.prepare(`SELECT count(*) AS n FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id WHERE j.state='RUNNING' AND ${where}`).get().n;
  const audit = () => sql.prepare('SELECT action,scope,scope_id,subject,actor_id,before,after,widening,client FROM installation_audit ORDER BY id').all();
  return { sql, env, call, policy, signedIn, runner, running, audit, claim: r => p.claimPipelineJob(DB, env, r), create: (repo, n, runsOn, extra) => p.createPipelineRun(DB, env, run(repo, extra), jobs(n, runsOn)) };
}

test('the two runner policies validate, normalise and widen as the installation model requires', () => {
  const env = { PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {} };
  assert.deepEqual(runnerPoolsPolicy.deploy(env), { pools: [] });
  assert.equal(runnerPoolsPolicy.deploy({}), null);
  // A pool is slice 1's: engine plus sorted label names; an image part is dropped.
  assert.deepEqual(runnerPoolsPolicy.validate(env, { pools: [{ engine: 'gitlab-ci', labels: ['docker'], maxConcurrent: 3 }, { engine: 'forgejo-actions', labels: ['ubuntu-latest:docker://node:20', 'docker'], maxConcurrent: 2 }] }),
    { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 2 }, { engine: 'gitlab-ci', labels: ['docker'], maxConcurrent: 3 }] });
  for (const bad of [{ pools: [{ engine: 'jenkins', labels: [], maxConcurrent: 1 }] }, { pools: [{ engine: 'gitlab-ci', labels: [], maxConcurrent: 0 }] }, { pools: [{ engine: 'gitlab-ci', labels: [], maxConcurrent: 1001 }] },
    { pools: [{ engine: 'gitlab-ci', labels: ['a'], maxConcurrent: 1 }, { engine: 'gitlab-ci', labels: ['a:x'], maxConcurrent: 2 }] }, { pools: [], extra: 1 }])
    assert.throws(() => runnerPoolsPolicy.validate(env, bad), /pool|cap|List/);
  const cap = n => ({ pools: [{ engine: 'gitlab-ci', labels: ['a'], maxConcurrent: n }] });
  assert.equal(runnerPoolsPolicy.widening(cap(2), cap(1)), false); assert.equal(runnerPoolsPolicy.widening({ pools: [] }, cap(5)), false);
  assert.equal(runnerPoolsPolicy.widening(cap(2), cap(3)), true); assert.equal(runnerPoolsPolicy.widening(cap(2), { pools: [] }), true);
  const share = (maxRunning, maxRunsPerDay = null, enforced = false) => ({ maxRunning, maxRunsPerDay, enforced });
  assert.deepEqual(runnerSharesPolicy.deploy(env), share(null));
  assert.throws(() => runnerSharesPolicy.validate(env, share(0)), /Concurrent pipeline jobs/); assert.throws(() => runnerSharesPolicy.validate(env, { maxRunning: 1 }), /Set concurrent/);
  assert.equal(runnerSharesPolicy.widening(share(null), share(4)), false); assert.equal(runnerSharesPolicy.widening(share(4), share(null)), true);
  assert.equal(runnerSharesPolicy.widening(share(4, 10), share(4, 20)), true); assert.equal(runnerSharesPolicy.widening(share(4), share(4, null, true)), true);
  assert.equal(runnerSharesPolicy.widening(share(4, null, true), share(4)), false);
  // The hierarchy: the organization narrows the installation, the repository narrows the organization; a grant only ever raises.
  const limits = shareLimits(share(4, 100), { max_running: 3, max_runs_per_day: null, granted_running: null, granted_runs_per_day: null }, { max_running: 5, max_runs_per_day: 7 }, true);
  assert.deepEqual([limits.organization.limit, limits.repository.ceiling, limits.repository.limit], [{ maxRunning: 3, maxRunsPerDay: 100 }, { maxRunning: 3, maxRunsPerDay: 100 }, { maxRunning: 3, maxRunsPerDay: 7 }]);
  assert.equal(shareLimits(share(4), { granted_running: 8, max_running: null }, null, true).organization.ceiling.maxRunning, 8);
  assert.equal(shareLimits(share(10), { granted_running: 8, max_running: null }, null, true).organization.ceiling.maxRunning, 10);
  assert.equal(shareLimits(share(null), { granted_running: 8, max_running: 2 }, null, true).organization.limit.maxRunning, 2);
  // Enforced: the installation's value applies, whatever the organization saved; personal repositories get the installation's directly.
  assert.equal(shareLimits(share(4, null, true), { max_running: 1 }, null, true).organization.limit.maxRunning, 4);
  assert.deepEqual(shareLimits(share(4), null, { max_running: 2 }, false), { organization: null, repository: { ceiling: { maxRunning: 4, maxRunsPerDay: null }, limit: { maxRunning: 2, maxRunsPerDay: null } } });
});

test('a pool cap stops claims at the limit, atomically under concurrent claims, and narrowing applies at once while widening is confirmed', async t => {
  const f = await fixture(t);
  // Three runners in one pool (images differ, label names match), one in another pool.
  const pool = [f.runner(['ubuntu-latest:docker://node:20', 'docker']), f.runner(['docker', 'ubuntu-latest:docker://node:22']), f.runner(['ubuntu-latest', 'docker'])], other = f.runner(['ubuntu-latest']);
  await f.create(1, 6);
  // A new cap only narrows: saved at once, without typed confirmation or a recent sign-in.
  const saved = await f.policy('alice', 'runner-pools', { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 2 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); assert.equal(saved.value.widening, false);
  // Six claims at once by the capped pool's three runners: exactly two start. Each claim reads the pool below its cap before any UPDATE
  // runs, so only the count inside the UPDATE keeps it from overshooting.
  const claims = await Promise.all([...pool, ...pool].map(r => f.claim(r)));
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(f.running('j.runner_id IN (100,101,102)'), 2);
  assert.equal(await f.claim(pool[2]), null);
  // Another pool is not capped by it.
  assert.ok(await f.claim(other));
  // The GitLab and Forgejo protocols see exactly what an empty queue gives: no job (GitLab answers 204, Forgejo an empty task).
  // A finished job frees a slot.
  await p.finishPipelineJob(f.env.DB, f.env, claims.find(Boolean).job, { result: 'success' });
  assert.ok(await f.claim(pool[0]));
  assert.equal(await f.claim(pool[1]), null);
  // A runner relabelled into the pool (Forgejo Declare) is counted at once: the pool is matched by label names in SQL.
  f.sql.prepare("UPDATE pipeline_runners SET labels=? WHERE id=?").run(JSON.stringify(['docker:docker://x', 'ubuntu-latest']), other.id);
  assert.equal(await f.claim(f.sql.prepare('SELECT * FROM pipeline_runners WHERE id=?').get(other.id)), null);
  // Raising the cap widens: typed confirmation, then an Access sign-in from the last 10 minutes; then the pool takes more.
  const raise = { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 5 }] };
  assert.match((await f.policy('alice', 'runner-pools', raise)).value.message, /Type runner-pools/);
  assert.match((await f.policy('alice', 'runner-pools', raise, { confirmation: 'runner-pools' })).value.message, /last 10 minutes/);
  assert.equal((await f.policy('alice', 'runner-pools', raise, { confirmation: 'runner-pools' }, f.signedIn())).status, 200);
  assert.ok(await f.claim(pool[1]));
  // Removing the cap widens too; a non-administrator cannot change it at all.
  assert.match((await f.policy('alice', 'runner-pools', { pools: [] })).value.message, /Type runner-pools/);
  assert.equal((await f.policy('carol', 'runner-pools', { pools: [] }, { confirmation: 'runner-pools' }, f.signedIn())).status, 403);
  assert.ok(f.audit().some(row => row.action === 'update' && row.subject === 'runner-pools' && row.widening === 1));
});

test('a GitLab runner in a pool at its cap is answered 204, as for an empty queue', async t => {
  const f = await fixture(t);
  const { token: registration } = await p.createRegistrationToken(f.env.DB, f.env, { id: 1 }, { engine: 'gitlab-ci', scope: 'installation', scopeId: '', labels: ['docker'], ttlHours: 1, uses: 2 });
  const one = await p.registerPipelineRunner(f.env.DB, f.env, { engine: 'gitlab-ci', registrationToken: registration, name: 'g1', labels: ['docker'] });
  const two = await p.registerPipelineRunner(f.env.DB, f.env, { engine: 'gitlab-ci', registrationToken: registration, name: 'g2', labels: ['docker'] });
  const planned = await gitLabPipelinePlan({ source: 'one:\n  tags: [docker]\n  script: echo 1\ntwo:\n  tags: [docker]\n  script: echo 2\n', readFile: async () => null, files: null, changedFiles: null,
    context: { event: 'push', ref: 'refs/heads/main', commitId: 'c'.repeat(40), beforeSha: 'b'.repeat(40), defaultBranch: 'main', projectPath: 'acme/project', origin } });
  await p.createPipelineRun(f.env.DB, f.env, run(1, { engine: 'gitlab-ci', workflowPath: '.gitlab-ci.yml' }), planned.jobs);
  await f.policy('alice', 'runner-pools', { pools: [{ engine: 'gitlab-ci', labels: ['docker'], maxConcurrent: 1 }] });
  const request = token => handle(new Request(origin + '/api/v4/jobs/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, info: { version: '18.5.0', executor: 'docker' } }) }), f.env);
  assert.equal((await request(one.token)).status, 201);
  assert.equal((await request(two.token)).status, 204);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM pipeline_jobs WHERE state='QUEUED'").get().n, 1);
});

test('shares skip blocked jobs: a runner takes the next eligible job, even behind more than a page of held ones, and concurrent claims never overshoot', async t => {
  const f = await fixture(t);
  const runners = [f.runner(['ubuntu-latest']), f.runner(['ubuntu-latest']), f.runner(['ubuntu-latest'])];
  // Each organization (all its repositories together) and each personal repository: one running job.
  assert.equal((await f.policy('alice', 'runner-shares', { maxRunning: 1, maxRunsPerDay: null, enforced: false })).status, 200);
  await f.create(1, 60); await f.create(2, 2); await f.create(3, 2);
  // Three at once: one from acme (two repositories, one share), one from erin's personal repository, nothing more.
  const claims = await Promise.all(runners.map(r => f.claim(r)));
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(f.running('r.repository_id IN (1,2)'), 1); assert.equal(f.running('r.repository_id=3'), 1);
  // 61 acme jobs wait ahead of nothing else now; a fourth personal repository job behind them all is still found.
  f.sql.exec("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(4,'later','','repo-4',5,'k4','h','ACTIVE','t'); INSERT INTO repository_owners VALUES(4,11)");
  await f.create(4, 1);
  const next = await f.claim(runners[2]);
  assert.equal(next.run.repository_id, 4);
  assert.equal(await f.claim(runners[2]), null);
  // An organization's own narrower share and a repository's: acme allows 3, its project 2.
  assert.match((await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: null, enforced: false })).value.message, /Type runner-shares/);
  assert.equal((await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: null, enforced: false }, { confirmation: 'runner-shares' }, f.signedIn())).status, 200);
  const share = (who, body) => f.call(who, '/native/capacity/shares', { action: 'set', expectedVersion: '0', maxRunsPerDay: null, ...body });
  assert.equal((await share('carol', { organization: 'acme', maxRunning: 3 })).status, 200);
  assert.equal((await share('carol', { repository: { owner: 'acme', name: 'project' }, repositoryId: '1', maxRunning: 2 })).status, 200);
  const more = [];
  for (let i = 0; i < 6; i++) { const r = f.runner(['ubuntu-latest']); more.push(await f.claim(r)); }
  // project: 2 running (its share), acme: 3 (project 2 + site 1), erin's two repositories: 4 is the installation's per personal repository.
  assert.equal(f.running('r.repository_id=1'), 2); assert.equal(f.running('r.repository_id IN (1,2)'), 3);
  assert.equal(f.running('r.repository_id=3'), 2);
});

test('organization and repository shares narrow their parent, are refused above it, and only owners and administrators change them', async t => {
  const f = await fixture(t);
  const read = (who, target, headers) => f.call(who, '/native/capacity/shares/read', { action: 'read', ...target }, headers);
  const set = (who, target, values, headers) => f.call(who, '/native/capacity/shares', { action: 'set', expectedVersion: '0', maxRunsPerDay: null, ...target, ...values }, headers);
  const acme = { organization: 'acme' }, project = { repository: { owner: 'acme', name: 'project' }, repositoryId: '1' }, notes = { repository: { owner: 'erin', name: 'notes' }, repositoryId: '3' };
  await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: 50, enforced: false });
  // Reading: members and people with repository access; nobody else.
  const shown = await read('dave', acme);
  assert.equal(shown.status, 200, JSON.stringify(shown.value));
  assert.deepEqual([shown.value.ceiling, shown.value.limit, shown.value.own, shown.value.canEdit, shown.value.canRequest], [{ maxRunning: 4, maxRunsPerDay: 50 }, { maxRunning: 4, maxRunsPerDay: 50 }, { maxRunning: null, maxRunsPerDay: null }, false, false]);
  assert.match(shown.value.editReason, /Only organization owners/);
  assert.equal((await read('frank', acme)).status, 403);
  assert.equal((await read('frank', project)).status, 404); // a repository you cannot see stays hidden
  assert.equal((await read('dave', project)).value.canEdit, false);
  // Changing: the organization's owner, the repository's administrators. Not members, writers, other administrators or tokens.
  assert.equal((await set('dave', acme, { maxRunning: 2 })).status, 403);
  assert.equal((await set('alice', acme, { maxRunning: 2 })).status, 403);
  assert.equal((await set('dave', project, { maxRunning: 2 })).status, 403);
  f.sql.prepare('INSERT INTO credentials(digest,user_id,expires_at,revoked) VALUES(?,3,?,0)').run(await digest('golf_native_' + 'a'.repeat(43)), Math.floor(Date.now() / 1000) + 3600);
  assert.equal((await set('', acme, { maxRunning: 2 }, { Authorization: 'Bearer golf_native_' + 'a'.repeat(43) })).status, 403);
  // At or below the parent; above it is refused with the parent named.
  assert.match((await set('carol', acme, { maxRunning: 5 })).value.message, /at most the installation’s 4/);
  assert.equal((await set('carol', acme, { maxRunning: 0 })).status, 400);
  const org = await set('carol', acme, { maxRunning: 3, maxRunsPerDay: 20 });
  assert.equal(org.status, 200, JSON.stringify(org.value));
  assert.deepEqual([org.value.limit, org.value.version], [{ maxRunning: 3, maxRunsPerDay: 20 }, '1']);
  assert.equal((await set('carol', acme, { maxRunning: 2 })).status, 412); // stale version
  assert.match((await set('carol', project, { maxRunning: 4 })).value.message, /at most the organization acme’s 3/);
  const repo = await set('carol', project, { maxRunning: 2 });
  assert.deepEqual([repo.value.ceiling.maxRunning, repo.value.limit.maxRunning, repo.value.parent.name], [3, 2, 'acme']);
  // A personal repository's parent is the installation.
  assert.match((await set('erin', notes, { maxRunning: 5 })).value.message, /at most the installation’s 4/);
  assert.equal((await set('erin', notes, { maxRunning: 4 })).status, 200);
  // Narrowing the installation applies at once to values saved above it.
  await f.policy('alice', 'runner-shares', { maxRunning: 1, maxRunsPerDay: 50, enforced: false });
  assert.deepEqual([(await read('carol', acme)).value.limit.maxRunning, (await read('carol', project)).value.limit.maxRunning, (await read('erin', notes)).value.limit.maxRunning], [1, 1, 1]);
  // Enforced: the installation's value applies everywhere and lower scopes cannot set their own.
  await f.policy('alice', 'runner-shares', { maxRunning: 2, maxRunsPerDay: 50, enforced: true }, { confirmation: 'runner-shares' }, f.signedIn());
  const enforced = await read('carol', acme);
  assert.deepEqual([enforced.value.limit.maxRunning, enforced.value.canEdit], [2, false]); assert.match(enforced.value.editReason, /enforces/);
  assert.equal((await set('carol', acme, { maxRunning: 1 }, {})).status, 412);
  // Every change is audited at its own scope; refused attempts are recorded as denied.
  const rows = f.audit().filter(row => row.action === 'capacity_share.update');
  assert.ok(rows.some(row => row.scope === 'organization' && row.scope_id === '10' && row.actor_id === 3 && JSON.parse(row.client).outcome === undefined));
  assert.ok(rows.some(row => row.scope === 'repository' && row.scope_id === '1'));
  assert.ok(rows.some(row => row.actor_id === 4 && JSON.parse(row.client).outcome === 'denied'));
});

test('an organization owner requests a higher share; a different operations administrator approves it with the organization typed', async t => {
  const f = await fixture(t);
  await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: null, enforced: false });
  const ask = (who, body) => f.call(who, '/native/capacity/shares', { action: 'request', organization: 'acme', field: 'maxRunning', reason: 'Release week', ...body });
  assert.equal((await ask('dave', { value: 8 })).status, 403);
  assert.match((await ask('carol', { value: 4 })).value.message, /more than the organization’s ceiling of 4/);
  assert.match((await ask('carol', { field: 'maxRunsPerDay', value: 40 })).value.message, /sets no limit/);
  const asked = await ask('carol', { value: 8 });
  assert.equal(asked.status, 200, JSON.stringify(asked.value));
  assert.deepEqual(asked.value.requests.map(r => [r.state, r.current, r.requested, r.mine]), [['PENDING', 4, 8, true]]);
  assert.equal((await ask('carol', { value: 9 })).status, 409);
  // The administrators see it on the Runner capacity page, labelled with the organization and the name to type.
  const listed = (await f.call('alice', '/native/capacity/read', { action: 'read' })).value.requests[0];
  assert.deepEqual([listed.scope, listed.organization, listed.confirmation, listed.label, listed.estimatedMonthlyDelta], ['organization', 'acme', 'acme', 'Runner share of acme: concurrent pipeline jobs', null]);
  assert.match(listed.estimateBasis, /No cost model for runner shares/);
  // Only an operations administrator decides, with the organization's name typed and a recent sign-in, since a grant widens.
  const approve = (who, extra = {}, headers = f.signedIn()) => f.call(who, '/native/capacity', { action: 'approve', id: listed.id, confirmation: 'acme', ...extra }, headers);
  assert.equal((await approve('carol')).status, 403);
  assert.match((await approve('alice', { confirmation: 'evidence' })).value.message, /Type acme/);
  assert.match((await approve('alice', {}, {})).value.message, /last 10 minutes/);
  const approved = await approve('alice', { note: 'For the release' });
  assert.equal(approved.status, 200, JSON.stringify(approved.value));
  assert.deepEqual([approved.value.request.state, approved.value.request.decidedBy, approved.value.request.appliedBy], ['APPLIED', 'alice', 'alice']);
  assert.equal(f.sql.prepare("SELECT granted_running FROM capacity_shares WHERE scope='organization' AND scope_id=10").get().granted_running, 8);
  // The organization's ceiling is now 8; its owner may set up to that.
  const now = (await f.call('carol', '/native/capacity/shares/read', { action: 'read', organization: 'acme' })).value;
  assert.deepEqual([now.ceiling.maxRunning, now.limit.maxRunning, now.granted.maxRunning], [8, 8, 8]);
  assert.equal((await f.call('carol', '/native/capacity/shares', { action: 'set', organization: 'acme', maxRunning: 6, maxRunsPerDay: null, expectedVersion: now.version })).status, 200);
  // Two people: an owner who is also an administrator cannot approve their own request; the requester withdraws it instead.
  f.sql.exec("INSERT INTO native_owner_members(owner_id,user_id,role) VALUES(10,1,'owner')");
  await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: 10, enforced: false }, { confirmation: 'runner-shares' }, f.signedIn());
  const own = await f.call('alice', '/native/capacity/shares', { action: 'request', organization: 'acme', field: 'maxRunsPerDay', value: 30, reason: 'More runs' });
  const mine = own.value.requests.find(r => r.field === 'maxRunsPerDay');
  assert.equal((await f.call('alice', '/native/capacity', { action: 'approve', id: mine.id, confirmation: 'acme' }, f.signedIn())).status, 403);
  assert.equal((await f.call('carol', '/native/capacity/shares', { action: 'withdraw', organization: 'acme', id: mine.id })).status, 403);
  const withdrawn = await f.call('alice', '/native/capacity/shares', { action: 'withdraw', organization: 'acme', id: mine.id });
  assert.equal(withdrawn.value.requests.find(r => r.id === mine.id).state, 'WITHDRAWN');
  const rows = f.audit().map(row => [row.action, row.scope, row.actor_id]);
  for (const expected of [['capacity_request.create', 'organization', 3], ['capacity_request.approve', 'organization', 1], ['capacity_request.withdraw', 'organization', 1]])
    assert.ok(rows.some(row => JSON.stringify(row) === JSON.stringify(expected)), JSON.stringify(expected));
});

test('a run over its daily share is recorded refused, with the reason; refused runs are not counted', async t => {
  const f = await fixture(t);
  await f.policy('alice', 'runner-shares', { maxRunning: null, maxRunsPerDay: 2, enforced: false });
  assert.equal((await f.create(1, 1)).refused, undefined);
  assert.equal((await f.create(2, 1)).refused, undefined);
  // acme's two repositories share the organization's two runs a day; erin's personal repository has its own two.
  const third = await f.create(1, 1, undefined, { intakeId: 'i3' });
  assert.equal(third.refused, true);
  const row = f.sql.prepare('SELECT state,reason FROM pipeline_runs WHERE id=?').get(third.runId);
  assert.equal(row.state, 'REFUSED'); assert.match(row.reason, /Daily run share reached: The organization acme may start 2 pipeline runs a day \(UTC\) and 2 started today/);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pipeline_jobs WHERE run_id=?').get(third.runId).n, 0);
  // The intake replays to the same refused run.
  assert.equal((await f.create(1, 1, undefined, { intakeId: 'i3' })).runId, third.runId);
  assert.equal((await f.create(3, 1)).refused, undefined);
  // A repository's own daily share within its organization's.
  await f.policy('alice', 'runner-shares', { maxRunning: null, maxRunsPerDay: 10, enforced: false }, { confirmation: 'runner-shares' }, f.signedIn());
  assert.equal((await f.call('carol', '/native/capacity/shares', { action: 'set', repository: { owner: 'acme', name: 'site' }, repositoryId: '2', maxRunning: null, maxRunsPerDay: 1, expectedVersion: '0' })).status, 200);
  assert.match(f.sql.prepare('SELECT reason FROM pipeline_runs WHERE id=?').get((await f.create(2, 1)).runId).reason, /This repository may start 1 pipeline run a day/);
  assert.equal((await f.create(1, 1)).refused, undefined);
});

test('the inventory shows each pool’s cap and what it holds, each share’s use, and the metric reports held work apart from claimable work', async t => {
  const f = await fixture(t);
  const a = f.runner(['ubuntu-latest', 'docker']), b = f.runner(['ubuntu-latest', 'docker']);
  await f.policy('alice', 'runner-pools', { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 1 }] });
  await f.create(3, 3);
  assert.ok(await f.claim(a)); assert.equal(await f.claim(b), null);
  let value = (await f.call('alice', '/native/capacity/read', { action: 'read' })).value;
  let pool = value.selfHosted.pools.find(item => item.id === 'forgejo-actions:docker,ubuntu-latest');
  assert.deepEqual([pool.cap, pool.running, pool.queued, pool.heldByCap, pool.held, pool.claimable], [1, 1, 2, 2, 2, 0]);
  assert.deepEqual(value.runnerPolicies.pools.value, { pools: [{ engine: 'forgejo-actions', labels: ['docker', 'ubuntu-latest'], maxConcurrent: 1 }] });
  assert.equal(value.runnerPolicies.shares.source, 'deploy');
  // Shares: acme at its share holds its queued jobs; the pool's cap is lifted, so the pool's held work is the share's.
  await f.policy('alice', 'runner-pools', { pools: [] }, { confirmation: 'runner-pools' }, f.signedIn());
  await f.policy('alice', 'runner-shares', { maxRunning: 1, maxRunsPerDay: 5, enforced: false });
  await f.create(1, 3);
  assert.ok(await f.claim(b));
  value = (await f.call('alice', '/native/capacity/read', { action: 'read' })).value;
  pool = value.selfHosted.pools.find(item => item.id === 'forgejo-actions:docker,ubuntu-latest');
  // erin/notes: 1 running of 1, 2 queued and held; acme: 1 running of 1, 2 queued and held.
  assert.deepEqual([pool.cap, pool.running, pool.queued, pool.heldByShares, pool.heldByCap, pool.claimable], [null, 2, 4, 4, 0, 0]);
  const rows = Object.fromEntries(value.shares.rows.map(row => [`${row.scope}:${row.name}`, row]));
  assert.deepEqual([rows['organization:acme'].running, rows['organization:acme'].limit.maxRunning, rows['organization:acme'].queued, rows['organization:acme'].held, rows['organization:acme'].runsToday], [1, 1, 2, 2, 1]);
  assert.deepEqual([rows['repository:erin/notes'].running, rows['repository:erin/notes'].held, rows['repository:erin/notes'].runsToday], [1, 2, 1]);
  assert.equal(rows['repository:acme/project'].held, 2);
  // The metric: queued keeps its meaning; held and claimable are new.
  const token = (await f.call('alice', '/native/capacity', { action: 'createMetricsToken', label: 'keda', lifetimeDays: 30 })).value.secret;
  const metric = await (await handle(new Request(origin + '/native/capacity/metrics?engine=forgejo-actions&labels=ubuntu-latest,docker', { headers: { Authorization: 'Bearer ' + token } }), f.env)).json();
  assert.deepEqual([metric.queued, metric.running, metric.held, metric.claimable, metric.cap], [4, 2, 4, 0, null]);
  // A finished job frees acme's share: its held jobs become claimable.
  await p.finishPipelineJob(f.env.DB, f.env, f.sql.prepare("SELECT * FROM pipeline_jobs j WHERE state='RUNNING' AND run_id IN (SELECT id FROM pipeline_runs WHERE repository_id=1)").get(), { result: 'success' });
  const after = await (await handle(new Request(origin + '/native/capacity/metrics?engine=forgejo-actions&labels=ubuntu-latest,docker', { headers: { Authorization: 'Bearer ' + token } }), f.env)).json();
  assert.deepEqual([after.queued, after.held, after.claimable], [4, 2, 2]);
});

test('the shares read overlaps other requests in the stateless Worker; changes stay in the Workspace', () => {
  const route = (path, method = 'POST') => statelessRoute(new Request(origin + path, { method }));
  assert.equal(route('/native/capacity/shares/read'), 'read'); assert.equal(route('/native/capacity/shares'), null);
  assert.equal(concurrentRead(new Request(origin + '/native/capacity/shares/read', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + '/native/capacity/shares', { method: 'POST' })), false);
});

test('a pool cap counts and limits installation runners only: runners a repository registers itself never use it up', async t => {
  const f = await fixture(t);
  const installation = f.runner(['ubuntu-latest']), own = f.runner(['ubuntu-latest'], 'forgejo-actions', ['repository', '3']);
  await f.create(3, 2); await f.create(1, 1);
  assert.equal((await f.policy('alice', 'runner-pools', { pools: [{ engine: 'forgejo-actions', labels: ['ubuntu-latest'], maxConcurrent: 1 }] })).status, 200);
  // erin's own runner runs both of her jobs: it is not capped, and they do not count against the installation's pool.
  assert.ok(await f.claim(own)); assert.ok(await f.claim(own));
  // The installation's runner still takes acme/project's job.
  const claimed = await f.claim(installation);
  assert.ok(claimed); assert.equal(f.running('r.repository_id=1'), 1);
});

test('a repository read of its share shows the organization-wide running count to the repository administrators only', async t => {
  const f = await fixture(t);
  await f.policy('alice', 'runner-shares', { maxRunning: 4, maxRunsPerDay: 50, enforced: false });
  const project = { repository: { owner: 'acme', name: 'project' }, repositoryId: '1' };
  const read = who => f.call(who, '/native/capacity/shares/read', { action: 'read', ...project });
  assert.equal(typeof (await read('carol')).value.usage.parentRunning, 'number');
  assert.equal((await read('dave')).value.usage.parentRunning, null);
});
