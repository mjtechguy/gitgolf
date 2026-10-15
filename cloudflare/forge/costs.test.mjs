import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle, concurrentRead } from './src/core.mjs';
import { rates, priced, billable, monthPeriod, runningLine, serviceTotal, measuredUnits, estimate, validScenario, validUnits, defaultScenario, readUsage, r2Operations, pricesAsOf, probes } from './src/costs.mjs';

const origin = 'https://golf.example.com', account = 'c'.repeat(32), database = '0b2b7c1e-1111-4222-8333-444455556666';
const rate = id => rates.find(item => item.id === id);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.invalid',1),(2,'bob','bob@example.invalid',1);
    INSERT INTO operations_admins(user_id) VALUES(1); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','cost-space');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'key','hash','ACTIVE','2026-10-01T00:00:00Z');
    INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write')`);
  const statement = query => { const s = sql.prepare(query); let args = [];
    return { query, bind(...values) { args = values; return this; }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: { changes: s.run(...args).changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCOUNT_ID: account, ARTIFACTS_NAMESPACE: 'cost-space', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    OPERATIONS_WORKER: 'golf-test', OPERATIONS_DATABASE_ID: database, OPERATIONS_BUCKETS: 'golf-test,golf-test-pipelines',
    ARTIFACTS: { async get() { throw Error('No Git here'); } }, EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence' };
  const call = async (body, { who = 'alice', provider } = {}) => {
    const response = await handle(new Request(origin + '/native/costs/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid',
      'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)) }, body: JSON.stringify(body) }), env, provider);
    return { status: response.status, value: await response.json() };
  };
  return { sql, env, call };
}

// A GraphQL stand-in answering each dataset as the Analytics API would, with month-to-date and window aliases.
const datasets = {
  workersInvocationsAdaptive: query => [{ dimensions: { scriptName: 'golf-test' }, sum: query.includes('cpuTimeUs') ? { cpuTimeUs: 6e9 } : { requests: 2_000_000 } }],
  durableObjectsInvocationsAdaptiveGroups: () => [{ sum: { requests: 3_000_000 } }],
  durableObjectsPeriodicGroups: () => [{ sum: { activeTime: 1e12 } }],
  d1AnalyticsAdaptiveGroups: () => [{ sum: { rowsRead: 1e9, rowsWritten: 60e6 } }],
  d1StorageAdaptiveGroups: () => [{ max: { databaseSizeBytes: 2e9 } }],
  r2OperationsAdaptiveGroups: () => [{ dimensions: { actionType: 'PutObject', bucketName: 'golf-test' }, sum: { requests: 1500 } }, { dimensions: { actionType: 'GetObject', bucketName: 'golf-test-pipelines' }, sum: { requests: 4000 } },
    { dimensions: { actionType: 'DeleteObject', bucketName: 'golf-test' }, sum: { requests: 900 } }, { dimensions: { actionType: 'PutObject', bucketName: 'someone-else' }, sum: { requests: 1e9 } }],
  r2StorageAdaptiveGroups: () => [{ dimensions: { bucketName: 'golf-test' }, max: { payloadSize: 3e9, metadataSize: 1e6 } }, { dimensions: { bucketName: 'someone-else' }, max: { payloadSize: 9e12, metadataSize: 0 } }],
  queueMessageOperationsAdaptiveGroups: () => [{ sum: { billableOperations: 30_000 } }],
  artifactsEventsAdaptiveGroups: () => [{ count: 25_000 }],
};
function analytics({ refuse = [], seen = [] } = {}) {
  return async (url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql'); assert.equal(init.redirect, 'manual'); assert.match(init.headers.Authorization, /^Bearer t{40}$/);
    const { query } = JSON.parse(init.body); assert.ok(query.includes(`accountTag: "${account}"`));
    const name = Object.keys(datasets).find(key => query.includes(key + '(')); seen.push(name);
    if (refuse.some(item => query.includes(item))) return json({ data: null, errors: [{ message: `unknown field "${refuse.find(item => query.includes(item))}"` }] });
    const rows = datasets[name](query), aliases = query.includes('now:') ? { now: rows } : { mtd: rows, win: rows };
    return json({ data: { viewer: { accounts: [aliases] } }, errors: null });
  };
}

test('price math subtracts included allowances, projects the month and never counts what was not read', () => {
  assert.equal(billable(rate('workers.requests'), 4e6), 0);
  assert.equal(priced(rate('workers.requests'), 25e6), 4.5);
  assert.equal(priced(rate('d1.rows-written'), 60e6), 10);
  assert.equal(priced(rate('artifacts.operations'), 30_000), 3);
  assert.equal(priced(rate('containers.cpu'), 375 * 60 + 1000), 0.02);
  const period = monthPeriod(Date.parse('2026-10-11T00:00:00Z'));
  assert.deepEqual([period.start, period.end, period.days, period.elapsedDays], ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 31, 10]);
  // 10 days for 20 million requests: 62 million projected over 31 days.
  const line = runningLine(rate('workers.requests'), { state: 'observed', value: 20e6 }, period);
  assert.equal(line.billableMonthToDate, 10e6); assert.equal(line.costMonthToDate, 3); assert.equal(line.projected, 62e6); assert.equal(line.costProjected, 15.6);
  // Storage is a level: the current size for the whole month, accrued with the days passed.
  const storage = runningLine(rate('d1.storage'), { state: 'observed', value: 7 }, period);
  assert.equal(storage.billableProjected, 2); assert.equal(storage.costProjected, 1.5); assert.equal(storage.costMonthToDate, round(1.5 * 10 / 31));
  // Artifacts are billed from 14 October: nothing before that, and the projection covers the billed days only.
  assert.equal(runningLine(rate('artifacts.operations'), { state: 'observed', value: 5 }, period).state, 'not-billed');
  const late = runningLine(rate('artifacts.operations'), { state: 'observed', value: 20_000 }, monthPeriod(Date.parse('2026-10-24T00:00:00Z')));
  assert.equal(late.projected, 36_000); assert.match(late.note, /Billed from 2026-10-14/);
  const unread = runningLine(rate('do.rows-read'), { state: 'degraded', reason: 'The analytics API did not answer within 5 seconds.' }, period);
  assert.equal(unread.state, 'degraded'); assert.equal(unread.costMonthToDate, undefined); assert.equal(unread.costProjected, undefined);
  assert.deepEqual(serviceTotal([line, unread]), { state: 'partial', missing: ['SQLite rows read'], costMonthToDate: 3, costProjected: 15.6 });
  assert.deepEqual(serviceTotal([unread]), { state: 'unreadable', missing: ['SQLite rows read'] });
});
const round = value => Math.round(value * 1e6) / 1e6;

test('unit costs come from measured usage divided by Golf’s own counts, and the what-if prices them', () => {
  const units = measuredUnits({ 'workers.requests': 1000, 'd1.rows-written': 500, 'r2.class-a': 40, 'd1.storage': 0.5 }, { writes: 100, landed: 20, ciRuns: 8 });
  const unit = id => units.find(item => item.rate === id);
  assert.deepEqual([unit('workers.requests').perWrite, unit('workers.requests').perLand], [10, 50]);
  assert.equal(unit('d1.rows-written').perWrite, 5);
  assert.equal(unit('r2.class-a').perCiRun, 5);
  assert.equal(unit('d1.storage').current, 0.5);
  // Not read, or nothing to divide by: no unit, never zero.
  assert.equal(unit('do.requests').perWrite, null);
  assert.equal(measuredUnits({ 'workers.requests': 1000 }, { writes: 0, landed: null, ciRuns: 0 })[0].perWrite, null);
  const scenario = validScenario({ ...defaultScenario, agents: 10, writesPerAgentPerMinute: 1, activeHoursPerDay: 10, ciRunsPerDay: 10, concurrentContainers: 1, runnerHoursPerMonth: 40, runnerHourlyRate: null });
  const result = estimate(scenario, validUnits(units.map(({ rate, perWrite, perLand, perCiRun, current }) => ({ rate, perWrite, perLand, perCiRun, current }))));
  const writes = 10 * 1 * 60 * 10 * 30.4;
  assert.equal(result.drivers.writesPerMonth, writes);
  const line = id => result.lines.find(item => item.rate === id);
  assert.equal(line('workers.requests').usage, writes * 10); assert.equal(line('workers.requests').cost, priced(rate('workers.requests'), writes * 10));
  assert.equal(line('d1.rows-written').cost, priced(rate('d1.rows-written'), writes * 5));
  assert.equal(line('r2.class-a').usage, 5 * 10 * 30.4);
  assert.equal(line('do.requests').state, 'not-estimated'); assert.equal(line('do.requests').cost, undefined);
  assert.equal(line('workers.subscription').cost, 5);
  // standard-1 around the clock: 0.5 vCPU busy, 4 GiB, 8 GB.
  const seconds = 24 * 30.4 * 3600;
  assert.equal(line('containers.cpu').usage, round(seconds * 0.5)); assert.equal(line('containers.memory').cost, priced(rate('containers.memory'), seconds * 4));
  assert.equal(line('runners.hours').state, 'not-priced'); assert.match(line('runners.hours').reason, /outside Cloudflare/);
  assert.ok(result.missing.includes('Durable Objects: Requests'));
  assert.equal(result.total, round(result.lines.filter(item => item.state === 'estimated').reduce((sum, item) => sum + item.cost, 0)));
  // Scaling by landed pull requests uses the per-landing units, and an entered runner rate is priced.
  const landed = estimate(validScenario({ ...defaultScenario, basis: 'land', prsLandedPerDay: 100, runnerHoursPerMonth: 40, runnerHourlyRate: 0.5 }), validUnits([{ rate: 'workers.requests', perWrite: 10, perLand: 50 }]));
  assert.equal(landed.lines.find(item => item.rate === 'workers.requests').usage, 50 * 100 * 30.4);
  assert.equal(landed.lines.find(item => item.rate === 'runners.hours').cost, 20);
  assert.throws(() => validScenario({ ...defaultScenario, agents: -1 }), /Agents must be a number/);
  assert.throws(() => validScenario({ ...defaultScenario, basis: 'magic' }), /applied writes or by landed/);
  assert.throws(() => validUnits([{ rate: 'workers.subscription', perWrite: 1 }]), /Unknown or repeated/);
});

test('usage reads degrade per service: no token, refused token, timeout and a refused field', async t => {
  const f = await fixture(t), period = monthPeriod(Date.parse('2026-10-15T12:00:00Z')), window = { start: '2026-10-08T00:00:00.000Z', end: period.now };
  const none = await readUsage(f.env, period, window, async () => assert.fail('No token, no call'));
  assert.equal(none.state, 'unavailable'); assert.match(none.reason, /No Account Analytics Read token/);
  assert.equal(none.results.get('workers.requests').state, 'unreadable');
  f.env.OPERATIONS_ANALYTICS_TOKEN = { async get() { return 't'.repeat(40); } };
  const refused = await readUsage(f.env, period, window, async () => json({ success: false, errors: [{ message: 'Authentication error' }] }, 403));
  assert.equal(refused.state, 'degraded'); assert.match(refused.reason, /token was refused \(HTTP 403\)\. It needs Account Analytics Read/);
  assert.ok([...refused.results.values()].every(item => item.state === 'degraded' && !item.values));
  const permission = await readUsage(f.env, period, window, async () => json({ data: null, errors: [{ message: 'not authorized for this account: ' + 'x'.repeat(40) }] }));
  assert.match(permission.reason, /lacks permission for this dataset: not authorized for this account: \[withheld\]/);
  const timeout = await readUsage(f.env, period, window, async () => { throw Object.assign(Error('x'), { name: 'TimeoutError' }); });
  assert.equal(timeout.results.get('d1.rows-read').reason, 'The analytics API did not answer within 5 seconds.');
  // An unconfirmed field fails only its own rate; the rest is read.
  const seen = [], partial = await readUsage(f.env, period, window, analytics({ refuse: ['cpuTimeUs'], seen }));
  assert.equal(partial.state, 'partial'); assert.match(partial.results.get('workers.cpu').reason, /refused the query: unknown field "cpuTimeUs"/);
  assert.equal(partial.results.get('workers.requests').values.mtd, 2_000_000);
  assert.equal(partial.results.get('do.duration').values.mtd, 1e6 * 0.128);
  assert.equal(partial.results.get('d1.storage').values.mtd, 2);
  assert.equal(partial.results.get('r2.class-a').values.mtd, 1500); assert.equal(partial.results.get('r2.class-b').values.mtd, 4000);
  assert.equal(partial.results.get('r2.storage').values.mtd, 3.001);
  assert.equal(partial.results.get('artifacts.operations').values.mtd, 25_000);
  assert.equal(seen.length, 10);
  // An empty Workers dataset while the installation serves requests is not zero.
  const empty = await readUsage(f.env, period, window, async (url, init) => JSON.parse(init.body).query.includes('workersInvocationsAdaptive(')
    ? json({ data: { viewer: { accounts: [{ mtd: [], win: [] }] } } }) : analytics()(url, init));
  assert.match(empty.results.get('workers.requests').reason, /returned no rows although this installation is serving requests/);
  // Without the database id, D1 storage is not read, and D1 rows are read for the whole account.
  delete f.env.OPERATIONS_DATABASE_ID;
  const accountWide = await readUsage(f.env, period, window, analytics());
  assert.equal(accountWide.results.get('d1.storage').state, 'not-configured'); assert.equal(accountWide.results.get('d1.rows-read').scope, 'account');
  assert.match(r2Operations([{ dimensions: { actionType: 'PutBucketMagic', bucketName: 'b' }, sum: { requests: 2 } }], []).note, /Priced as Class A/);
  // Without bound buckets the query groups the account by action only: rows carry no bucket name.
  assert.deepEqual(r2Operations([{ dimensions: { actionType: 'GetObject' }, sum: { requests: 3 } }, { dimensions: { actionType: 'PutObject' }, sum: { requests: 1 } }], []), { 'r2.class-a': 1, 'r2.class-b': 3 });
  const r2Env = { ACCOUNT_ID: 'a'.repeat(32), EVIDENCE_BUCKET: {}, OPERATIONS_WORKER: 'golf' }, r2Period = monthPeriod(Date.parse('2026-10-15T12:00:00Z')), r2Window = { start: '2026-10-08T12:00:00Z', end: '2026-10-15T12:00:00Z' };
  const r2Query = buckets => probes({ ...r2Env, OPERATIONS_BUCKETS: buckets }, r2Period, r2Window).find(probe => probe.id === 'r2').query();
  assert.match(r2Query('golf-evidence'), /bucketName_in: \["golf-evidence"\]/); assert.doesNotMatch(r2Query(''), /bucketName/);
});

test('estimated costs are for operations administrators only, read as a concurrent read', async t => {
  const f = await fixture(t);
  assert.equal(concurrentRead(new Request(origin + '/native/costs/read', { method: 'POST' })), true);
  assert.equal((await f.call({ action: 'read' }, { who: 'bob' })).status, 403);
  assert.equal((await f.call({ action: 'estimate', scenario: defaultScenario, units: [] }, { who: 'bob' })).status, 403);
  assert.equal((await f.call({ action: 'delete' })).status, 400);
  const now = new Date().toISOString();
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES('w1',1,1,'refs/heads/main','a','b','APPLIED',?),('w2',1,1,'refs/heads/main','b','c','DISPATCHED',?)").run(now, now);
  // No token: every usage line says why it is not read; the subscription and Golf's counts are still there.
  const read = (await f.call({ action: 'read' })).value;
  assert.equal(read.pricesAsOf, pricesAsOf); assert.equal(read.analytics.state, 'unavailable');
  assert.equal(read.counts.month.writes, 1); assert.equal(read.counts.window.writes, 1);
  const workers = read.services.find(item => item.id === 'workers');
  assert.equal(workers.state, 'unreadable'); assert.equal(workers.costProjected, undefined);
  assert.ok(workers.lines.every(line => line.costMonthToDate === undefined && /No Account Analytics Read token/.test(line.reason)));
  assert.equal(read.totals.costProjected, 5); assert.ok(read.totals.missing.includes('Workers: Requests'));
  assert.equal(read.unpriced.length, 0);
  // With a token, the same read prices what it could read.
  f.env.OPERATIONS_ANALYTICS_TOKEN = { async get() { return 't'.repeat(40); } };
  const observed = (await f.call({ action: 'read' }, { provider: analytics() })).value;
  assert.equal(observed.analytics.state, 'observed');
  const d1 = observed.services.find(item => item.id === 'd1');
  assert.equal(d1.state, 'observed'); assert.equal(d1.lines.find(line => line.rate === 'd1.rows-written').costMonthToDate, 10);
  assert.equal(observed.services.find(item => item.id === 'do').state, 'partial');
  assert.equal(observed.units.find(item => item.rate === 'd1.rows-written').perWrite, 60e6);
  const estimated = (await f.call({ action: 'estimate', scenario: defaultScenario, units: observed.units.map(({ rate, perWrite, perLand, perCiRun, current }) => ({ rate, perWrite, perLand, perCiRun, current })) })).value;
  assert.equal(estimated.pricesAsOf, pricesAsOf); assert.ok(estimated.total > 5);
  assert.equal((await f.call({ action: 'estimate', scenario: { ...defaultScenario, activeHoursPerDay: 25 }, units: [] })).status, 400);
});
