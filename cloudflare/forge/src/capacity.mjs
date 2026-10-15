import { Fault, reply, invalid, uuidOK, digest } from './common.mjs';
import { operationsAdmin } from './operations.mjs';
import { installationPolicies, installationSettings, installationPolicyState, applyInstallationChange, auditStatement, clientHeaders, locked } from './installation.mjs';
import { costsRead, estimate, validUnits, defaultScenario, daysPerMonth, pricesAsOf, serviceLabels } from './costs.mjs';
import { capacityTokenPattern } from './api-tokens.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';

/* Runner capacity (docs/SCALE_OUT_PLAN.md S5, docs/RUNNER_CAPACITY.md), slice 1.
 *
 * Read: what runs work for this installation and how much of it waits, per capacity source: self-hosted Forgejo and GitLab runners
 * grouped into pools (engine plus label set), native runner pools, Cloudflare containers and agent and SSH hosts. Golf never starts
 * machines; it publishes queue depth per pool (GET /native/capacity/metrics) for an autoscaler, read with a dedicated read-only token.
 *
 * Requests: an operations administrator asks for a higher value of one installation policy field, with the estimated monthly cost
 * change where an honest mapping exists. A different administrator approves or declines. Approval applies the value through
 * installation.mjs applyInstallationChange, the path /native/installation uses, so it inherits the typed confirmation, the Access
 * sign-in from the last 10 minutes for widening, the revision fence and the audit row. A value above the deploy ceiling cannot be
 * applied in the product: approval records APPROVED with the deploy step, and the request is applied once a deploy raises the ceiling. */

const runnerOnline = 5 * 60_000, hostOnline = 60_000;
const runnerLimit = 2000, jobLimit = 5000;
const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const adminOnly = 'Current workspace operations administrator sign-in required.';
const iso = ms => new Date(ms).toISOString();

// ---------- self-hosted pipeline runner pools ----------
// The claim rule (pipelines.mjs claimPipelineJob): a runner takes a QUEUED job of its engine whose every runs-on label it carries, by
// name: a Forgejo label "name:docker://image" matches by "name"; GitLab tags have no image part. Scope: an installation runner takes
// every repository, an organization runner its organization's repositories, a repository runner its own.
export const labelName = label => String(label).split(':')[0];
export const poolLabels = labels => [...new Set((Array.isArray(labels) ? labels : []).map(labelName))].sort();
export const poolId = (engine, labels) => `${engine}:${labels.join(',')}`;
export const labelsTake = (labels, runsOn) => runsOn.every(label => labels.has(labelName(label)));
export const covers = (runner, job) => runner.scope === 'installation' || runner.scope === 'repository' && Number(runner.scope_id) === job.repository_id ||
  runner.scope === 'organization' && job.owner_id !== null && Number(runner.scope_id) === job.owner_id;
const waited = (since, now) => { const at = Date.parse(since); return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null; };
const older = (a, b) => a === null ? b : b === null ? a : Math.max(a, b);

/* Pools from runner and queued job rows. A pool's queued count is the jobs its labels take, in repositories the scope of any of its
 * registered runners covers (disabled ones included: an ephemeral runner is disabled after its one job, and a pool scaled to zero still
 * needs its queue). A job several pools can take is counted in each. Unmatched: jobs no ACTIVE runner can take at all. */
export function runnerPools(runners, jobs, now = Date.now()) {
  const pools = new Map();
  for (const runner of runners) {
    const labels = poolLabels(parse(runner.labels, [])), id = poolId(runner.engine, labels);
    if (!pools.has(id)) pools.set(id, { id, engine: runner.engine, labels, registered: 0, active: 0, online: 0, running: 0, queued: 0, oldestWaitSeconds: null, scopes: new Set(), members: [] });
    const pool = pools.get(id), active = runner.state === 'ACTIVE';
    pool.registered++; pool.members.push(runner); pool.scopes.add(runner.scope);
    if (active) pool.active++;
    if (active && runner.last_seen_at && Date.parse(runner.last_seen_at) > now - runnerOnline) pool.online++;
    pool.running += Number(runner.running) || 0;
  }
  const unmatched = { queued: 0, oldestWaitSeconds: null, byEngine: {} };
  for (const job of jobs) {
    const runsOn = parse(job.runs_on, []), wait = waited(job.since, now);
    let taken = false;
    for (const pool of pools.values()) {
      if (pool.engine !== job.engine || !labelsTake(new Set(pool.labels), runsOn)) continue;
      if (pool.members.some(runner => runner.state === 'ACTIVE' && covers(runner, job))) taken = true;
      if (!pool.members.some(runner => covers(runner, job))) continue;
      pool.queued++; pool.oldestWaitSeconds = older(pool.oldestWaitSeconds, wait);
    }
    if (!taken) { unmatched.queued++; unmatched.oldestWaitSeconds = older(unmatched.oldestWaitSeconds, wait); unmatched.byEngine[job.engine] = (unmatched.byEngine[job.engine] || 0) + 1; }
  }
  const list = [...pools.values()].map(({ members, scopes, ...pool }) => ({ ...pool, scopes: [...scopes].sort() }))
    .sort((a, b) => b.queued - a.queued || a.id.localeCompare(b.id));
  return { pools: list, unmatched };
}

async function pipelineRows(db, engine = null) {
  const { results: runners } = await db.prepare(`SELECT n.id,n.engine,n.scope,n.scope_id,n.labels,n.state,n.last_seen_at,
    (SELECT count(*) FROM pipeline_jobs j WHERE j.runner_id=n.id AND j.state='RUNNING') AS running FROM pipeline_runners n WHERE n.deleted=0${engine ? ' AND n.engine=?' : ''} ORDER BY n.id DESC LIMIT ${runnerLimit + 1}`)
    .bind(...(engine ? [engine] : [])).all();
  // The claim's own filter: the job's run is current, not cancelled and still open.
  const { results: jobs } = await db.prepare(`SELECT j.id,j.engine,j.runs_on,COALESCE(j.queued_at,j.created_at) AS since,r.repository_id,o.owner_id FROM pipeline_jobs j
    JOIN pipeline_runs r ON r.id=j.run_id AND r.attempt=j.attempt LEFT JOIN repository_owners o ON o.repository_id=r.repository_id
    WHERE j.state='QUEUED'${engine ? ' AND j.engine=?' : ''} AND r.cancel_requested=0 AND r.state IN ('QUEUED','RUNNING','WAITING') ORDER BY j.id LIMIT ${jobLimit + 1}`).bind(...(engine ? [engine] : [])).all();
  return { runners: runners.slice(0, runnerLimit), jobs: jobs.slice(0, jobLimit), truncated: runners.length > runnerLimit || jobs.length > jobLimit };
}

// ---------- the other sources ----------
const count = async (db, sql, ...values) => { try { return (await db.prepare(sql).bind(...values).first())?.n ?? 0; } catch { return null; } };
const sshDigest = "(h.credential_digest LIKE 'ssh:%' OR h.credential_digest LIKE 'deleted:%:ssh:%')";

async function nativePools(db, now) {
  try {
    const { results } = await db.prepare(`SELECT p.id,p.name,p.state,p.trust_class,p.max_parallel,
      (SELECT count(*) FROM native_runner_machines m WHERE m.pool_id=p.id AND m.state='ACTIVE') AS machines,
      (SELECT count(*) FROM native_runner_machines m WHERE m.pool_id=p.id AND m.active_job_id IS NOT NULL) AS running,
      (SELECT count(*) FROM evidence_jobs e JOIN native_runner_placements pl ON pl.repository_id=e.repository_id WHERE pl.pool_id=p.id AND e.state='QUEUED' AND e.test_state='REQUESTED' AND e.expires_at>?) AS queued
      FROM native_runner_pools p ORDER BY p.name LIMIT 200`).bind(iso(now)).all();
    return results.map(row => ({ id: row.id, name: row.name, state: row.state, trustClass: row.trust_class, maxParallel: row.max_parallel, activeMachines: row.machines, running: row.running, queued: row.queued }));
  } catch { return []; }
}

// Golf's own admission limit for container tests and agent proposals (evidence.mjs, agents.mjs): a third is refused, not queued.
export const containerAdmissionLimit = 2;
const noAllocation = 'The deploy sets no Cloudflare Containers max_instances for this class and binds no instance limit into the Worker, so Golf cannot show an allocation.';
async function containers(db, env, now, ssh) {
  const time = iso(now), onContainer = "NOT EXISTS(SELECT 1 FROM native_runner_placements pl WHERE pl.repository_id=e.repository_id AND pl.pool_id IS NOT NULL)";
  const admitted = await count(db, "SELECT count(*) AS n FROM evidence_jobs WHERE (test_state='RUNNING' OR agent_state IN ('FORK_PENDING','RUNNING')) AND state='QUEUED' AND expires_at>?", time);
  const shared = { value: containerAdmissionLimit, inUse: admitted, source: `Golf admits at most ${containerAdmissionLimit} PR test and agent proposal containers at once, together (evidence.mjs); another is refused, not queued.` };
  return [
    { id: 'pr-tests', label: 'PR test containers', binding: 'PRTestTask', configured: env.TEST_EXECUTION_ENABLED === 'true', allocation: null, allocationReason: noAllocation, limit: shared,
      running: await count(db, `SELECT count(*) AS n FROM evidence_jobs e WHERE e.state='QUEUED' AND e.test_state='RUNNING' AND e.expires_at>? AND ${onContainer} AND NOT EXISTS(SELECT 1 FROM native_runner_machines m WHERE m.active_job_id=e.id)`, time),
      queued: await count(db, `SELECT count(*) AS n FROM evidence_jobs e WHERE e.state='QUEUED' AND e.test_state='REQUESTED' AND e.expires_at>? AND ${onContainer}`, time) },
    { id: 'agent-proposals', label: 'Agent proposal containers', binding: 'PRAgentTask', configured: env.AGENT_EXECUTION_ENABLED === 'true', allocation: null, allocationReason: noAllocation, limit: shared,
      running: await count(db, "SELECT count(*) AS n FROM evidence_jobs WHERE state='QUEUED' AND agent_state IN ('FORK_PENDING','RUNNING') AND expires_at>?", time),
      queued: await count(db, "SELECT count(*) AS n FROM evidence_jobs WHERE state='QUEUED' AND agent_state='REQUESTED' AND expires_at>?", time) },
    // One container per running SSH task (ssh-task.mjs); Golf dispatches at most each SSH host's max_concurrent.
    { id: 'ssh-tasks', label: 'SSH task containers', binding: 'SSHAgentTask', configured: env.SSH_HOSTS_EXECUTION === 'true', allocation: null, allocationReason: noAllocation,
      limit: { value: ssh.capacity, inUse: ssh.running, source: 'One container per running SSH task; Golf dispatches at most each SSH host’s concurrent-task limit, summed over active SSH hosts.' },
      running: ssh.running, queued: ssh.queued },
  ];
}

async function hosts(db, now) {
  const row = async ssh => {
    try {
      const value = await db.prepare(`SELECT count(*) AS hosts,COALESCE(SUM(h.max_concurrent),0) AS capacity,COALESCE(SUM(h.last_seen_at>?),0) AS online,
        (SELECT count(*) FROM agent_tasks t JOIN agent_hosts h ON h.id=t.host_id WHERE t.state IN ('CLAIMED','RUNNING') AND ${ssh ? '' : 'NOT '}${sshDigest}) AS running,
        (SELECT count(*) FROM agent_tasks t JOIN agent_hosts h ON h.id=t.host_id WHERE t.state='QUEUED' AND ${ssh ? '' : 'NOT '}${sshDigest}) AS queued
        FROM agent_hosts h WHERE h.deleted=0 AND h.state='ACTIVE' AND ${ssh ? '' : 'NOT '}${sshDigest}`).bind(iso(now - hostOnline)).first();
      return { hosts: value.hosts, capacity: value.capacity, online: ssh ? null : value.online, running: value.running, queued: value.queued };
    } catch { return { hosts: null, capacity: null, online: null, running: null, queued: null }; }
  };
  const agent = await row(false), ssh = await row(true);
  return [{ id: 'agent-hosts', label: 'Agent hosts', ...agent, onlineNote: 'Seen in the last minute.' },
    { id: 'ssh-hosts', label: 'SSH hosts', ...ssh, onlineNote: 'Golf connects when a task starts; there is no host process to be online.' }];
}

export async function capacityInventory(db, env, now = Date.now()) {
  const { runners, jobs, truncated } = await pipelineRows(db);
  const { pools, unmatched } = runnerPools(runners, jobs, now);
  const hostRows = await hosts(db, now), ssh = hostRows[1];
  return { generatedAt: iso(now),
    selfHosted: { configured: Boolean(pipelinePolicy(env)), pools, unmatched, truncated, onlineWindowSeconds: runnerOnline / 1000 },
    nativePools: await nativePools(db, now),
    containers: await containers(db, env, now, { capacity: ssh.capacity, running: ssh.running, queued: ssh.queued }),
    hosts: hostRows };
}

// ---------- requestable settings ----------
/* The capacity fields a request may raise, by installation policy. ceiling: the highest value settable now without a deploy (the policy's
 * own bounds). deployMax: how far a deploy can raise that ceiling (prepare.mjs and delivery.mjs bounds), with the deploy setting to change;
 * absent where the ceiling is fixed in code or there is no deploy allocation. cost: the cost model, where an honest one exists. */
export const requestable = {
  evidence: { dailyLimit: { label: 'Daily evidence admissions', unit: 'a day', deployMax: 50, deploySetting: 'evidence.daily_limit', cost: 'ci' } },
  previews: { lifetimeSeconds: { label: 'Preview lifetime', unit: 'seconds', deployMax: 14400, deploySetting: 'previews.ttl' },
    concurrency: { label: 'Concurrent previews', unit: 'previews', fixed: 'The installation’s preview slots are fixed in code (environments.mjs previewSlots), not by a deploy.' } },
  'agent-budgets': Object.fromEntries([['tokenRequestsPerMinute', 'API token requests a minute'], ['tokenWritesPerMinute', 'API token writes a minute'],
    ['taskRequestsPerMinute', 'Agent task requests a minute'], ['taskWritesPerMinute', 'Agent task writes a minute']].map(([field, label]) =>
    [field, { label, unit: 'a minute', fixed: 'Agent rate budgets have no deploy allocation; their bound is fixed in code (agent-budgets.mjs).' }])),
};
const spec = (key, field) => Object.hasOwn(requestable, key) && Object.hasOwn(requestable[key], field) ? requestable[key][field] : null;
const ceilingOf = (env, key, field, deploy) => installationPolicies[key].bounds(env, deploy)[field][1];
export function deployStep(key, field, value) {
  const s = spec(key, field);
  if (!s?.deploySetting) return null;
  return { setting: 'settings.' + s.deploySetting, value, command: 'python3 scripts/golf_cloudflare.py update DIR',
    steps: `Set settings.${s.deploySetting} to ${value} in DIR/alchemy-input.json (the installation directory), then run python3 scripts/golf_cloudflare.py update DIR; it shows the plan before it deploys.` };
}

async function settingViews(db, env) {
  const rows = await installationSettings(db), out = [];
  for (const [key, fields] of Object.entries(requestable)) {
    const { deploy, value } = installationPolicyState(env, key, rows?.get(key));
    for (const [field, s] of Object.entries(fields)) {
      const base = { key, field, label: s.label, unit: s.unit, policyLabel: installationPolicies[key].label, version: String(rows?.get(key)?.version || 0), cost: s.cost === 'ci' ? 'Per CI run, measured on this installation' : null };
      if (!deploy) { out.push({ ...base, allocated: false, reason: `${installationPolicies[key].label} is not allocated on this installation; allocating it needs a deploy.` }); continue; }
      out.push({ ...base, allocated: true, current: value[field], ceiling: ceilingOf(env, key, field, deploy), deployMax: s.deployMax ?? null, fixed: s.fixed || '', deploySetting: s.deploySetting ? 'settings.' + s.deploySetting : '' });
    }
  }
  return out;
}

// ---------- the cost of a request ----------
/* Daily evidence admissions map to CI runs a day: each admission is at most one CI run. The change is an upper bound (every added
 * admission used every day), priced with costs.mjs at this installation's measured cost per CI run, against the monthly allowances as if
 * this installation were the only user of the account. Container time per test run is not measured, so it is left out and named. */
export function ciCostChange(units, currentPerDay, requestedPerDay) {
  const map = validUnits(units.map(unit => ({ rate: unit.rate, perWrite: unit.perWrite ?? null, perLand: unit.perLand ?? null, perCiRun: unit.perCiRun ?? null, current: unit.current ?? null })));
  const run = perDay => estimate({ ...defaultScenario, agents: 0, prsLandedPerDay: 0, ciRunsPerDay: perDay, concurrentContainers: 0, runnerHoursPerMonth: 0, runnerHourlyRate: null }, map);
  const ci = result => result.lines.filter(line => line.basis === 'Per CI run');
  const before = ci(run(currentPerDay)), after = ci(run(requestedPerDay)), runs = round((requestedPerDay - currentPerDay) * daysPerMonth, 1);
  const priced = after.filter(line => line.state === 'estimated'), missing = after.filter(line => line.state !== 'estimated').map(line => `${serviceLabels[line.service]} ${line.label.toLowerCase()}`);
  if (!priced.length) return { delta: null, basis: `No cost per CI run is measured on this installation yet: it needs usage read with the Account Analytics Read token and CI runs in the last 7 days. Up to ${runs} more CI runs a month are not priced; container time per test run is not measured either.` };
  const sum = lines => lines.filter(line => line.state === 'estimated').reduce((total, line) => total + line.cost, 0);
  return { delta: round(sum(after) - sum(before), 2), basis: `Upper bound: ${requestedPerDay - currentPerDay} more admissions a day × ${daysPerMonth} days = up to ${runs} more CI runs a month, each at this installation’s measured cost per CI run (${priced.map(line => `${serviceLabels[line.service]} ${line.label.toLowerCase()}`).join(', ')}; last 7 days), Workers Paid list prices as of ${pricesAsOf}, against the monthly allowances as if this installation were the only user of the account. Left out: ${[...missing, 'container time per test run (not measured)'].join(', ')}.` };
}
async function costChange(db, env, providerFetch, key, field, current, requested) {
  if (spec(key, field)?.cost !== 'ci') return { delta: null, basis: 'No cost model for this setting.' };
  const costs = await costsRead(db, env, providerFetch);
  return ciCostChange(costs.units, current, requested);
}

// Validates a request against the policy's own bounds; above the ceiling, only up to what a deploy can allocate, marked needs_deploy.
function assess(env, rows, key, field, requested) {
  const s = spec(key, field);
  if (!s) invalid(`Choose a capacity setting: ${Object.entries(requestable).flatMap(([k, fields]) => Object.keys(fields).map(f => `${k}.${f}`)).join(', ')}.`);
  const policy = installationPolicies[key], { deploy, value } = installationPolicyState(env, key, rows?.get(key));
  if (!deploy) refuse(`${policy.label} is not allocated on this installation; allocating it needs a deploy.`);
  const current = value[field], ceiling = ceilingOf(env, key, field, deploy);
  if (!Number.isSafeInteger(requested)) invalid(`${s.label} must be a whole number.`);
  if (requested <= current) invalid(`Ask for more than the current ${s.label.toLowerCase()} (${current}). Lowering a value needs no request: change it on the Installation page.`);
  const candidate = { ...value, [field]: requested };
  if (requested <= ceiling) { policy.validate(env, candidate, deploy); return { current, ceiling, needsDeploy: false }; }
  if (!s.deployMax) invalid(`${s.label} cannot go above ${ceiling}. ${s.fixed}`);
  if (requested > s.deployMax) invalid(`${s.label} cannot go above ${s.deployMax}, even with a deploy.`);
  policy.validate(env, candidate, { ...deploy, [field]: requested });
  return { current, ceiling, needsDeploy: true };
}

// ---------- schema 49 ----------
let migrated = false;
export async function capacitySchema(db) {
  if (!migrated) try { migrated = Boolean((await db.prepare('PRAGMA table_info(capacity_requests)').all()).results.length); } catch { migrated = false; }
  return migrated;
}
const needSchema = async db => { if (!await capacitySchema(db)) refuse('Apply the schema 49 migration to request capacity and issue capacity metrics tokens.'); };

const requestSelect = `SELECT c.*,u.login AS requested_login,d.login AS decided_login,a.login AS applied_login FROM capacity_requests c JOIN users u ON u.id=c.requested_by
  LEFT JOIN users d ON d.id=c.decided_by LEFT JOIN users a ON a.id=c.applied_by`;
const wireRequest = (row, person) => ({ id: String(row.id), key: row.policy_key, field: row.field, label: spec(row.policy_key, row.field)?.label || `${row.policy_key}.${row.field}`,
  unit: spec(row.policy_key, row.field)?.unit || '', current: row.current_value, requested: row.requested_value, ceiling: row.ceiling, needsDeploy: Boolean(row.needs_deploy),
  estimatedMonthlyDelta: row.estimated_monthly_delta, estimateBasis: row.estimate_basis, reason: row.reason, requestedBy: row.requested_login, requestedAt: row.requested_at, mine: row.requested_by === person.id,
  state: row.state, decidedBy: row.decided_login || '', decidedAt: row.decided_at || '', decisionNote: row.decision_note, appliedBy: row.applied_login || '', appliedAt: row.applied_at || '',
  deploy: row.needs_deploy && ['PENDING', 'APPROVED'].includes(row.state) ? deployStep(row.policy_key, row.field, row.requested_value) : null });
const wireToken = (row, now) => ({ id: String(row.id), label: row.label, createdBy: row.created_login || '', createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at || '',
  revokedAt: row.revoked_at || '', state: row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= now ? 'expired' : 'active' });

// ---------- POST /native/capacity/read and /native/capacity ----------
export async function capacityAPI(db, env, person, request, body, read, providerFetch = fetch) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) forbidden(adminOnly); };
  await requireAdmin();
  if (read) {
    if (body.action === 'preview') {
      // What a request would record, without recording it: the cost change and whether it needs a deploy.
      const rows = await installationSettings(db), { current, ceiling, needsDeploy } = assess(env, rows, body.key, body.field, body.value);
      const cost = await costChange(db, env, providerFetch, body.key, body.field, current, body.value);
      await requireAdmin();
      return reply({ key: body.key, field: body.field, current, requested: body.value, ceiling, needsDeploy, estimatedMonthlyDelta: cost.delta, estimateBasis: cost.basis,
        deploy: needsDeploy ? deployStep(body.key, body.field, body.value) : null });
    }
    if (body.action !== 'read') invalid('Use the read or preview action on the read route.');
    const now = Date.now(), schema = await capacitySchema(db);
    const inventory = await capacityInventory(db, env, now), settings = await settingViews(db, env);
    const requests = schema ? (await db.prepare(requestSelect + " ORDER BY CASE c.state WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,c.id DESC LIMIT 100").all()).results.map(row => wireRequest(row, person)) : [];
    const tokens = schema ? (await db.prepare('SELECT t.*,u.login AS created_login FROM capacity_metrics_tokens t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.id DESC LIMIT 100').all()).results.map(row => wireToken(row, now)) : [];
    await requireAdmin();
    return reply({ ...inventory, settings, requests, tokens, schema: schema ? 'ready' : 'Apply the schema 49 migration to request capacity and issue capacity metrics tokens.',
      editing: locked(env) ? 'Installation policy is locked at deploy (policy_editing: false): approved requests cannot be applied in the product.' : '',
      metricsPath: '/native/capacity/metrics', origin: env.PUBLIC_ORIGIN, you: person.login });
  }
  await needSchema(db);
  const time = new Date().toISOString(), email = request.headers.get('X-Golf-Native-Access-Email');
  const admin = 'EXISTS(SELECT 1 FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1 AND u.email=?)';
  const audit = (subject, action, before, after, extra = {}) => auditStatement(db, { actor: person, actorEmail: email, scope: 'installation', scopeId: env.WORKSPACE_SLUG, subject, action, before, after, client: clientHeaders(request), ...extra });
  const note = value => { if (value === undefined || value === '') return ''; if (typeof value !== 'string' || value.length > 500 || /[\p{Cc}]/u.test(value.replace(/\n/g, ''))) invalid('Use a note of at most 500 characters.'); return value.trim(); };
  const load = async () => {
    if (typeof body.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.id)) invalid('Choose a capacity request.');
    const row = await db.prepare('SELECT * FROM capacity_requests WHERE id=?').bind(Number(body.id)).first();
    if (!row) throw new Fault('not_found', 404, 'Capacity request not found.');
    return row;
  };
  const answer = async id => reply({ request: wireRequest(await db.prepare(requestSelect + ' WHERE c.id=?').bind(Number(id)).first(), person) });

  if (body.action === 'request') {
    if (typeof body.key !== 'string' || typeof body.field !== 'string') invalid('Choose a capacity setting.');
    const reason = note(body.reason);
    if (!reason) invalid('Say why this capacity is needed.');
    const rows = await installationSettings(db), { current, ceiling, needsDeploy } = assess(env, rows, body.key, body.field, body.value);
    const cost = await costChange(db, env, providerFetch, body.key, body.field, current, body.value), subject = `${body.key}.${body.field}`;
    const [inserted] = await db.batch([
      db.prepare(`INSERT INTO capacity_requests(policy_key,field,current_value,requested_value,ceiling,needs_deploy,estimated_monthly_delta,estimate_basis,reason,requested_by,requested_at,state)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,'PENDING' WHERE ${admin} AND NOT EXISTS(SELECT 1 FROM capacity_requests WHERE policy_key=? AND field=? AND state IN ('PENDING','APPROVED'))`)
        .bind(body.key, body.field, current, body.value, ceiling, needsDeploy ? 1 : 0, cost.delta, cost.basis, reason, person.id, time, person.id, email, body.key, body.field),
      audit(subject, 'capacity_request.create', { value: current, ceiling }, { value: body.value, needsDeploy, estimatedMonthlyDelta: cost.delta }),
    ]);
    if (inserted.meta.changes !== 1) {
      await requireAdmin();
      throw new Fault('already_exists', 409, 'A request for this setting is already open. Withdraw or decide it first.');
    }
    const row = await db.prepare('SELECT id FROM capacity_requests WHERE policy_key=? AND field=? AND requested_by=? AND requested_at=? ORDER BY id DESC').bind(body.key, body.field, person.id, time).first();
    return answer(row.id);
  }
  if (body.action === 'withdraw') {
    const row = await load();
    if (row.requested_by !== person.id) forbidden('Only the administrator who made a request withdraws it.');
    if (!['PENDING', 'APPROVED'].includes(row.state)) refuse(`This request is already ${row.state.toLowerCase()}.`);
    await db.batch([
      db.prepare(`UPDATE capacity_requests SET state='WITHDRAWN',decided_by=COALESCE(decided_by,?),decided_at=COALESCE(decided_at,?) WHERE id=? AND requested_by=? AND state=? AND ${admin}`).bind(person.id, time, row.id, person.id, row.state, person.id, email),
      audit(`${row.policy_key}.${row.field}`, 'capacity_request.withdraw', { state: row.state }, { state: 'WITHDRAWN', requestId: String(row.id) }),
    ]);
    return settled(row, 'WITHDRAWN');
  }
  if (body.action === 'decline') {
    const row = await load(), why = note(body.note);
    if (row.requested_by === person.id) forbidden('Another operations administrator decides a request; you made this one.');
    if (row.state !== 'PENDING') refuse(`This request is already ${row.state.toLowerCase()}.`);
    await db.batch([
      db.prepare(`UPDATE capacity_requests SET state='DECLINED',decided_by=?,decided_at=?,decision_note=? WHERE id=? AND state='PENDING' AND requested_by<>? AND ${admin}`).bind(person.id, time, why, row.id, person.id, person.id, email),
      audit(`${row.policy_key}.${row.field}`, 'capacity_request.decline', { state: 'PENDING' }, { state: 'DECLINED', requestId: String(row.id) }),
    ]);
    return settled(row, 'DECLINED');
  }
  if (body.action === 'approve') return approve(await load(), note(body.note));
  if (body.action === 'createMetricsToken') return createToken();
  if (body.action === 'revokeMetricsToken') return revokeToken();
  invalid('Use request, withdraw, approve, decline, createMetricsToken or revokeMetricsToken.');

  async function settled(row, state) {
    const now = await db.prepare('SELECT state FROM capacity_requests WHERE id=?').bind(row.id).first();
    if (now.state !== state) { await requireAdmin(); refuse('This request changed since you read it. Refresh before deciding.'); }
    return answer(row.id);
  }

  // Approve a PENDING request, or apply an APPROVED one once a deploy has raised the ceiling. Never by the requester.
  async function approve(row, why) {
    if (row.requested_by === person.id) forbidden('Another operations administrator approves a request; you made this one.');
    if (!['PENDING', 'APPROVED'].includes(row.state)) refuse(`This request is already ${row.state.toLowerCase()}.`);
    if (body.confirmation !== row.policy_key) refuse(`Type ${row.policy_key} to confirm this approval.`);
    const key = row.policy_key, field = row.field, policy = installationPolicies[key], subject = `${key}.${field}`;
    const rows = await installationSettings(db), { deploy, value } = installationPolicyState(env, key, rows?.get(key));
    const fail = async message => {
      await db.prepare(`UPDATE capacity_requests SET state='FAILED',decided_by=COALESCE(decided_by,?),decided_at=COALESCE(decided_at,?),decision_note=? WHERE id=? AND state=?`).bind(person.id, time, message.slice(0, 500), row.id, row.state).run();
      return answer(row.id);
    };
    if (!policy || !deploy || !spec(key, field)) return fail(`${policy?.label || key} is not allocated on this installation; nothing was applied.`);
    const ceiling = ceilingOf(env, key, field, deploy), candidate = { ...value, [field]: row.requested_value };
    if (row.requested_value > ceiling) {
      // Above the deploy ceiling: recorded as approved; the value waits for a deploy that raises the ceiling.
      if (row.state === 'APPROVED') refuse(`${spec(key, field).label} is still above the deploy ceiling (${ceiling}). ${deployStep(key, field, row.requested_value)?.steps || ''}`.trim());
      await db.batch([
        db.prepare(`UPDATE capacity_requests SET state='APPROVED',needs_deploy=1,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND state='PENDING' AND requested_by<>? AND ${admin}`).bind(person.id, time, why, row.id, person.id, person.id, email),
        audit(subject, 'capacity_request.approve', { state: 'PENDING', value: value[field], ceiling }, { state: 'APPROVED', value: row.requested_value, needsDeploy: true, requestId: String(row.id) }),
      ]);
      return settled(row, 'APPROVED');
    }
    // Within the ceiling: the value must still pass the policy's own rules, or the request fails with the reason.
    try { policy.validate(env, candidate, deploy); } catch (error) { if (error instanceof Fault) return fail(error.message); throw error; }
    const operationId = body.operationId;
    if (!uuidOK(operationId)) invalid('Provide an operation ID and the version you read.');
    const receipt = await applyInstallationChange(db, env, person, request, { key, value: candidate, expectedVersion: body.expectedVersion, operationId, confirmation: body.confirmation }, {
      // Written only while this request is still undecided (or approved and waiting) and not the approver's own.
      guard: { sql: 'EXISTS(SELECT 1 FROM capacity_requests WHERE id=? AND state=? AND requested_by<>?)', values: [row.id, row.state, person.id] },
      then: [
        db.prepare(`UPDATE capacity_requests SET state='APPLIED',decided_by=COALESCE(decided_by,?),decided_at=COALESCE(decided_at,?),decision_note=CASE WHEN state='PENDING' THEN ? ELSE decision_note END,applied_by=?,applied_at=?
          WHERE id=? AND state=? AND EXISTS(SELECT 1 FROM installation_operations WHERE operation_id=? AND actor_id=?)`).bind(person.id, time, why, person.id, time, row.id, row.state, operationId, person.id),
        audit(subject, row.state === 'PENDING' ? 'capacity_request.approve' : 'capacity_request.apply', { state: row.state, value: value[field] }, { state: 'APPLIED', value: row.requested_value, requestId: String(row.id) },
          { widening: false }),
      ] });
    const after = await db.prepare(requestSelect + ' WHERE c.id=?').bind(row.id).first();
    if (after.state !== 'APPLIED') { await requireAdmin(); refuse('This request changed since you read it. Refresh before deciding.'); }
    return reply({ request: wireRequest(after, person), receipt });
  }

  async function createToken() {
    const label = body.label;
    if (typeof label !== 'string' || !label.trim() || label.trim() !== label || new TextEncoder().encode(label).length > 64 || /[\p{Cc}]/u.test(label)) invalid('Use a trimmed name up to 64 bytes, for example keda-golf-ci.');
    if (!Number.isInteger(body.lifetimeDays) || body.lifetimeDays < 1 || body.lifetimeDays > 365) invalid('Choose a lifetime from 1 to 365 days.');
    const secret = 'golf_capacity_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const hash = await digest(secret), expires = iso(Date.now() + body.lifetimeDays * 86400_000);
    const [inserted] = await db.batch([
      db.prepare(`INSERT INTO capacity_metrics_tokens(label,digest,created_by,created_at,expires_at) SELECT ?,?,?,?,? WHERE ${admin}
        AND (SELECT count(*) FROM capacity_metrics_tokens WHERE revoked_at IS NULL AND expires_at>?)<20`).bind(label, hash, person.id, time, expires, person.id, email, time),
      audit(label, 'capacity_metrics_token.create', null, { label, expiresAt: expires }),
    ]);
    if (inserted.meta.changes !== 1) { await requireAdmin(); refuse('This installation has 20 active capacity metrics tokens. Revoke unused ones and retry.'); }
    const row = await db.prepare('SELECT t.*,u.login AS created_login FROM capacity_metrics_tokens t LEFT JOIN users u ON u.id=t.created_by WHERE t.digest=?').bind(hash).first();
    return reply({ token: wireToken(row, Date.now()), secret, metricsUrl: env.PUBLIC_ORIGIN + '/native/capacity/metrics' });
  }
  async function revokeToken() {
    if (typeof body.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.id)) invalid('Choose the capacity metrics token to revoke.');
    const row = await db.prepare('SELECT * FROM capacity_metrics_tokens WHERE id=?').bind(Number(body.id)).first();
    if (!row) throw new Fault('not_found', 404, 'Capacity metrics token not found.');
    if (row.revoked_at) refuse('This token is already revoked.');
    await db.batch([
      db.prepare(`UPDATE capacity_metrics_tokens SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL AND ${admin}`).bind(time, person.id, row.id, person.id, email),
      audit(row.label, 'capacity_metrics_token.revoke', { state: 'active' }, { state: 'revoked', tokenId: String(row.id) }),
    ]);
    const now = await db.prepare('SELECT t.*,u.login AS created_login FROM capacity_metrics_tokens t LEFT JOIN users u ON u.id=t.created_by WHERE t.id=?').bind(row.id).first();
    if (!now.revoked_at) { await requireAdmin(); refuse('The token could not be revoked. Refresh and retry.'); }
    return reply({ token: wireToken(now, Date.now()) });
  }
}

// ---------- GET /native/capacity/metrics?engine=…&labels=a,b ----------
/* Queue depth for one self-hosted pool, for an autoscaler. Only a capacity metrics token (golf_capacity_…) is accepted, and it is accepted
 * nowhere else: core.mjs actor() knows no such credential, so the token reads nothing else in Golf. A label set with no registered
 * runners yet (a pool scaled to zero before its first runner) counts the jobs its labels take in every repository. */
const unauthenticated = message => { throw new Fault('unauthenticated', 401, message); };
export async function capacityMetrics(db, request, url) {
  if (request.method !== 'GET') invalid('Use GET.');
  const authorization = request.headers.get('Authorization') || '', secret = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!capacityTokenPattern.test(secret)) unauthenticated('A capacity metrics token is required (Authorization: Bearer golf_capacity_…).');
  if (!await capacitySchema(db)) refuse('Apply the schema 49 migration to read capacity metrics.');
  const now = Date.now(), token = await db.prepare('SELECT id,last_used_at FROM capacity_metrics_tokens WHERE digest=? AND revoked_at IS NULL AND expires_at>?').bind(await digest(secret), iso(now)).first();
  if (!token) unauthenticated('Valid, unexpired capacity metrics token required.');
  if ([...url.searchParams.keys()].some(name => !['engine', 'labels'].includes(name))) invalid('Use the engine and labels parameters only.');
  const engine = url.searchParams.get('engine'), text = url.searchParams.get('labels') ?? '';
  if (!['forgejo-actions', 'gitlab-ci'].includes(engine)) invalid('Use engine=forgejo-actions or engine=gitlab-ci.');
  const listed = text.split(',').map(label => label.trim()).filter(Boolean);
  if (listed.length > 32 || listed.some(label => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[\x21-\x7e]{1,200})?$/.test(label))) invalid('Labels are up to 32 comma-separated runner labels.');
  const labels = poolLabels(listed), id = poolId(engine, labels);
  const { runners, jobs, truncated } = await pipelineRows(db, engine);
  // A virtual installation-scope member stands in for a pool with no runners, so its queue is still published.
  const members = runners.filter(runner => poolId(runner.engine, poolLabels(parse(runner.labels, []))) === id);
  const pool = runnerPools(members.length ? members : [{ engine, scope: 'installation', scope_id: '', labels: JSON.stringify(labels), state: 'NONE', last_seen_at: null, running: 0 }], jobs, now).pools[0];
  if (!token.last_used_at || Date.parse(token.last_used_at) <= now - 60_000)
    try { await db.prepare('UPDATE capacity_metrics_tokens SET last_used_at=? WHERE id=?').bind(iso(now), token.id).run(); } catch { /* best effort */ }
  return Response.json({ pool: id, engine, labels, queued: pool.queued, running: pool.running, online: pool.online, oldestWaitSeconds: pool.oldestWaitSeconds ?? 0,
    registered: members.length, truncated, at: iso(now) }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
