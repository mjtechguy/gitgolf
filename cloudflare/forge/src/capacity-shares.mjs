import { Fault, reply, invalid, deny } from './common.mjs';
import { installationPolicyState, auditStatement, clientHeaders } from './installation.mjs';
import { settingsAuthority } from './repository-settings.mjs';
import { capFor, poolLabels, poolId, shareFields, shareBounds, shareLabels, shareColumns, shareLimits, wider } from './capacity-policy.mjs';

/* Runner capacity, slice 2 (docs/RUNNER_CAPACITY.md): pool caps and organization and repository shares, enforced where work starts.
 *
 * Claim (pipelines.mjs claimPipelineJob). D1 runs one statement at a time, so a count inside the claim's own conditional UPDATE is atomic:
 * - a pool cap adds "fewer than N RUNNING jobs held by runners of this pool" to the UPDATE; the pool is matched in SQL by the runner's
 *   label names (json_each), so a runner registered or relabelled meanwhile is counted too. A runner of a pool at its cap gets no job;
 * - a share adds "fewer than N RUNNING jobs in this repository" and "… in this organization" to the UPDATE. Repositories and organizations
 *   already at their share are excluded from the candidate query, so a runner takes the next eligible job instead of stalling behind them.
 * Run creation (createPipelineRun): the daily share is a count in the run's conditional INSERT; a run over it is recorded REFUSED with the
 * reason, as other refused runs are.
 *
 * Shares API (POST /native/capacity/shares and /native/capacity/shares/read): an organization's or repository's own value, at or below its
 * parent's; organization owners ask for more than the installation's through a capacity request an operations administrator approves. */

const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const parse = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const human = request => !request.headers.has('Authorization') && !request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret') && Boolean(request.headers.get('X-Golf-Native-Access-Email'));
const pipelineEngines = "('forgejo-actions','gitlab-ci')";
export const dayStart = (now = Date.now()) => new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
export const sharesMigration = 'Apply the schema 52 migration to set organization and repository runner shares.';

// ---------- reads ----------
// The two installation policies, as they apply now. A value is null where Actions pipelines are not allocated.
export async function runnerPolicies(db, env) {
  let rows = [];
  try { ({ results: rows } = await db.prepare("SELECT key,value,version FROM installation_settings WHERE key IN ('runner-pools','runner-shares')").all()); } catch { rows = []; }
  const state = key => installationPolicyState(env, key, rows.find(row => row.key === key));
  return { pools: state('runner-pools').value, shares: state('runner-shares').value, rows };
}
// capacity_shares rows by 'scope:id'; requested ids without a row map to null, so they are not read again. null before schema 52.
export async function shareRows(db, repositories = [], organizations = [], into = new Map()) {
  const repos = repositories.filter(id => !into.has('repository:' + id)), orgs = organizations.filter(id => id !== null && !into.has('organization:' + id));
  if (!repos.length && !orgs.length) return into;
  let results;
  try {
    ({ results } = await db.prepare(`SELECT * FROM capacity_shares WHERE scope='repository' AND scope_id IN (SELECT value FROM json_each(?)) OR scope='organization' AND scope_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(repos.map(Number)), JSON.stringify(orgs.map(Number))).all());
  } catch { results = []; }
  for (const id of repos) into.set('repository:' + id, null);
  for (const id of orgs) into.set('organization:' + id, null);
  for (const row of results) into.set(`${row.scope}:${row.scope_id}`, row);
  return into;
}
const anyOwn = async (db, column) => { try { return Boolean(await db.prepare(`SELECT 1 AS own FROM capacity_shares WHERE ${column} IS NOT NULL LIMIT 1`).first()); } catch { return false; } };

// RUNNING pipeline jobs per repository, with the repository's organization.
const runningSQL = `SELECT r.repository_id,CASE WHEN o.kind='ORGANIZATION' THEN o.id END AS organization_id,count(*) AS n FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id
  LEFT JOIN repository_owners ro ON ro.repository_id=r.repository_id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE j.engine IN ${pipelineEngines} AND j.state='RUNNING' GROUP BY r.repository_id`;
const repositoryRunning = `SELECT count(*) FROM pipeline_jobs x JOIN pipeline_runs y ON y.id=x.run_id WHERE x.engine IN ${pipelineEngines} AND x.state='RUNNING' AND y.repository_id=?`;
const organizationRunning = `SELECT count(*) FROM pipeline_jobs x JOIN pipeline_runs y ON y.id=x.run_id WHERE x.engine IN ${pipelineEngines} AND x.state='RUNNING' AND y.repository_id IN (SELECT repository_id FROM repository_owners WHERE owner_id=?)`;
// A pool in SQL: the runner's label names (the part before ':') are exactly this set.
const labelNameSQL = "CASE WHEN instr(e.value,':')>0 THEN substr(e.value,1,instr(e.value,':')-1) ELSE e.value END";
export function poolRunning(engine, labels) {
  const same = labels.length ? `NOT EXISTS(SELECT 1 FROM json_each(n.labels) e WHERE ${labelNameSQL} NOT IN (SELECT value FROM json_each(?))) AND (SELECT count(DISTINCT ${labelNameSQL}) FROM json_each(n.labels) e)=?` : 'json_array_length(n.labels)=0';
  return { sql: `SELECT count(*) FROM pipeline_jobs x JOIN pipeline_runners n ON n.id=x.runner_id WHERE x.engine=? AND x.state='RUNNING' AND n.engine=? AND ${same}`,
    values: [engine, engine, ...(labels.length ? [JSON.stringify(labels), labels.length] : [])] };
}

/* Running shares as they stand: running counts, the rows that apply to them, and which repositories and organizations are at their share.
 * null when no running share applies anywhere (no installation value and no organization or repository value). */
export async function runningShares(db, installation) {
  if (!installation || installation.maxRunning === null && !await anyOwn(db, 'max_running')) return null;
  const { results } = await db.prepare(runningSQL).all();
  const repositories = new Map(), organizations = new Map();
  for (const row of results) {
    repositories.set(row.repository_id, row);
    if (row.organization_id !== null) organizations.set(row.organization_id, (organizations.get(row.organization_id) || 0) + row.n);
  }
  const state = { installation, rows: await shareRows(db, [...repositories.keys()], [...organizations.keys()]), repositories, organizations, blockedRepositories: new Set(), blockedOrganizations: new Set() };
  for (const [id, n] of organizations) { const limit = limitsFor(state, null, id).organization.limit.maxRunning; if (limit !== null && n >= limit) state.blockedOrganizations.add(id); }
  for (const [id, row] of repositories) { const limit = limitsFor(state, id, row.organization_id).repository.limit.maxRunning; if (limit !== null && row.n >= limit) state.blockedRepositories.add(id); }
  return state;
}
export const limitsFor = (state, repositoryId, organizationId) => shareLimits(state.installation, organizationId === null ? null : state.rows.get('organization:' + organizationId), repositoryId === null ? null : state.rows.get('repository:' + repositoryId), organizationId !== null);
const held = (state, job) => Boolean(state) && (state.blockedRepositories.has(job.repository_id) || job.organization_id !== null && job.organization_id !== undefined && state.blockedOrganizations.has(job.organization_id));

// ---------- the claim ----------
// What a claim by this runner must respect, or null when nothing applies (the claim is then exactly as before).
export async function claimPlan(db, env, runner) {
  const policies = await runnerPolicies(db, env), labels = poolLabels(parse(runner.labels, []));
  const cap = capFor(policies.pools, runner.engine, labels), shares = await runningShares(db, policies.shares);
  return cap === null && !shares ? null : { cap, engine: runner.engine, labels, shares };
}
// A runner of a pool at its cap gets no job.
export async function poolFull(db, plan) {
  if (plan?.cap === null || plan?.cap === undefined) return false;
  const pool = poolRunning(plan.engine, plan.labels);
  return (await db.prepare(`SELECT (${pool.sql}) AS n`).bind(...pool.values).first()).n >= plan.cap;
}
// Added to the candidate query: skip repositories and organizations at their running share, and name each candidate's organization.
export function claimFilter(plan) {
  if (!plan?.shares) return { columns: '', sql: '', values: [] };
  const sql = [], values = [], repositories = [...plan.shares.blockedRepositories], organizations = [...plan.shares.blockedOrganizations];
  if (repositories.length) { sql.push(' AND r.repository_id NOT IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(repositories)); }
  if (organizations.length) { sql.push(' AND r.repository_id NOT IN (SELECT repository_id FROM repository_owners WHERE owner_id IN (SELECT value FROM json_each(?)))'); values.push(JSON.stringify(organizations)); }
  return { columns: ",(SELECT o.id FROM repository_owners ro JOIN native_owners o ON o.id=ro.owner_id WHERE ro.repository_id=r.repository_id AND o.kind='ORGANIZATION') AS share_organization",
    sql: sql.join(''), values };
}
export const claimSkipped = (plan, candidate) => Boolean(plan?.shares) && held(plan.shares, { repository_id: candidate.repository_id, organization_id: candidate.share_organization ?? null });
// ANDed into the claim's conditional UPDATE, so the counts and the claim are one statement.
export async function claimGuard(db, plan, candidate) {
  if (!plan) return { sql: '', values: [] };
  const sql = [], values = [];
  if (plan.cap !== null) { const pool = poolRunning(plan.engine, plan.labels); sql.push(` AND (${pool.sql})<?`); values.push(...pool.values, plan.cap); }
  if (plan.shares) {
    const organization = candidate.share_organization ?? null;
    await shareRows(db, [candidate.repository_id], [organization], plan.shares.rows);
    const limits = limitsFor(plan.shares, candidate.repository_id, organization);
    const outer = limits.organization?.limit.maxRunning ?? null, inner = limits.repository.limit.maxRunning;
    if (outer !== null) { sql.push(` AND (${organizationRunning})<?`); values.push(organization, outer); }
    // A repository limit at or above its organization's is implied by the organization's count.
    if (inner !== null && !(outer !== null && inner >= outer)) { sql.push(` AND (${repositoryRunning})<?`); values.push(candidate.repository_id, inner); }
  }
  return { sql: sql.join(''), values };
}
// After a guarded claim changed nothing: 'pool' when the pool reached its cap (the claim ends); otherwise the candidate's repository and
// organization are rechecked, and one at its share is skipped for the rest of this claim.
export async function claimMissed(db, plan, candidate) {
  if (!plan) return null;
  if (await poolFull(db, plan)) return 'pool';
  if (!plan.shares) return null;
  const organization = candidate.share_organization ?? null, limits = limitsFor(plan.shares, candidate.repository_id, organization);
  const count = async (sql, id) => (await db.prepare(`SELECT (${sql}) AS n`).bind(id).first()).n;
  if (organization !== null && limits.organization.limit.maxRunning !== null && await count(organizationRunning, organization) >= limits.organization.limit.maxRunning) plan.shares.blockedOrganizations.add(organization);
  if (limits.repository.limit.maxRunning !== null && await count(repositoryRunning, candidate.repository_id) >= limits.repository.limit.maxRunning) plan.shares.blockedRepositories.add(candidate.repository_id);
  return 'share';
}

// ---------- run creation: the daily share ----------
const runsToday = scope => `SELECT count(*) FROM pipeline_runs WHERE ${scope === 'organization' ? 'repository_id IN (SELECT repository_id FROM repository_owners WHERE owner_id=?)' : 'repository_id=?'} AND created_at>=? AND state<>'REFUSED'`;
/* { sql, values } for the run's conditional INSERT, and reason() for a refused run; null when no daily share applies. Runs started today
 * (UTC, refused ones not counted) must stay below each daily share that applies. A re-run is the same run and is not counted again. */
export async function dailyRunGuard(db, env, repositoryId) {
  const { shares: installation } = await runnerPolicies(db, env);
  if (!installation || installation.maxRunsPerDay === null && !await anyOwn(db, 'max_runs_per_day')) return null;
  const owner = await db.prepare("SELECT o.id,o.slug FROM repository_owners ro JOIN native_owners o ON o.id=ro.owner_id WHERE ro.repository_id=? AND o.kind='ORGANIZATION'").bind(repositoryId).first();
  const rows = await shareRows(db, [repositoryId], [owner?.id ?? null]);
  const limits = limitsFor({ installation, rows }, repositoryId, owner?.id ?? null), day = dayStart();
  const outer = limits.organization?.limit.maxRunsPerDay ?? null, inner = limits.repository.limit.maxRunsPerDay, checks = [];
  if (outer !== null) checks.push({ scope: 'organization', id: owner.id, limit: outer, name: `The organization ${owner.slug}` });
  if (inner !== null && !(outer !== null && inner >= outer)) checks.push({ scope: 'repository', id: repositoryId, limit: inner, name: 'This repository' });
  if (!checks.length) return null;
  return { sql: checks.map(check => `(${runsToday(check.scope)})<?`).join(' AND '), values: checks.flatMap(check => [check.id, day, check.limit]),
    async reason() {
      for (const check of checks) {
        const n = (await db.prepare(`SELECT (${runsToday(check.scope)}) AS n`).bind(check.id, day).first()).n;
        if (n >= check.limit) return `Daily run share reached: ${check.name} may start ${check.limit} pipeline run${check.limit === 1 ? '' : 's'} a day (UTC) and ${n} started today. This run was not started; push again or re-run tomorrow, or ask an owner for a higher share.`;
      }
      return 'Daily run share reached: this run was not started. Try again tomorrow, or ask an owner for a higher share.';
    } };
}

// ---------- inventory and the autoscaler metric ----------
/* Which queued jobs a share holds, for runnerPools: jobs carry repository_id and organization_id. Also the per-scope rows for the
 * capacity page (named: true): every organization and repository with a share of its own, a grant, or running, queued or started work
 * under a share that applies. */
export async function shareInventory(db, env, jobs, { named = false, now = Date.now() } = {}) {
  const policies = await runnerPolicies(db, env), installation = policies.shares;
  const state = await runningShares(db, installation);
  const heldBy = job => held(state, job);
  if (!named) return { policies, heldBy, rows: [] };
  let own = [];
  try { ({ results: own } = await db.prepare('SELECT * FROM capacity_shares ORDER BY scope,scope_id LIMIT 1000').all()); } catch { own = null; }
  if (!installation) return { policies, heldBy, rows: [], schema: own !== null };
  const rows = state?.rows || new Map();
  for (const row of own || []) rows.set(`${row.scope}:${row.scope_id}`, row);
  const queued = { repository: new Map(), organization: new Map() }, add = (map, id) => map.set(id, (map.get(id) || 0) + 1);
  for (const job of jobs) { add(queued.repository, job.repository_id); if (job.organization_id !== null && job.organization_id !== undefined) add(queued.organization, job.organization_id); }
  const perDay = installation.maxRunsPerDay !== null || (own || []).some(row => row.max_runs_per_day !== null || row.granted_runs_per_day !== null);
  const started = new Map();
  if (perDay) for (const row of (await db.prepare("SELECT repository_id,count(*) AS n FROM pipeline_runs WHERE created_at>=? AND state<>'REFUSED' GROUP BY repository_id").bind(dayStart(now)).all()).results) started.set(row.repository_id, row.n);
  const repositoryIds = new Set([...queued.repository.keys(), ...(state?.repositories.keys() || []), ...started.keys(), ...(own || []).filter(row => row.scope === 'repository').map(row => row.scope_id)]);
  const { results: repositoryRows } = repositoryIds.size ? await db.prepare(`SELECT r.id,r.name,o.slug,CASE WHEN o.kind='ORGANIZATION' THEN o.id END AS organization_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id
    LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id IN (SELECT value FROM json_each(?)) AND r.state='ACTIVE'`).bind(JSON.stringify([...repositoryIds])).all() : { results: [] };
  const repositories = new Map(repositoryRows.map(row => [row.id, row]));
  const organizationIds = new Set([...queued.organization.keys(), ...(state?.organizations.keys() || []), ...repositoryRows.filter(row => row.organization_id !== null && started.has(row.id)).map(row => row.organization_id), ...(own || []).filter(row => row.scope === 'organization').map(row => row.scope_id)]);
  const { results: orgs } = organizationIds.size ? await db.prepare("SELECT id,slug FROM native_owners WHERE kind='ORGANIZATION' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...organizationIds])).all() : { results: [] };
  await shareRows(db, [...repositories.keys()], orgs.map(org => org.id), rows);
  const context = { installation, rows }, out = [];
  for (const org of orgs) {
    const { organization: limits } = limitsFor(context, null, org.id), row = rows.get('organization:' + org.id);
    const runs = repositoryRows.filter(repository => repository.organization_id === org.id).reduce((sum, repository) => sum + (started.get(repository.id) || 0), 0);
    out.push(scopeRow('organization', org.id, org.slug, limits, row, state?.organizations.get(org.id) || 0, queued.organization.get(org.id) || 0, runs, Boolean(state?.blockedOrganizations.has(org.id)), installation));
  }
  for (const repository of repositories.values()) {
    const { repository: limits } = limitsFor(context, repository.id, repository.organization_id), row = rows.get('repository:' + repository.id);
    const atOrganization = repository.organization_id !== null && Boolean(state?.blockedOrganizations.has(repository.organization_id));
    out.push(scopeRow('repository', repository.id, `${repository.slug || env.WORKSPACE_SLUG}/${repository.name}`, limits, row, state?.repositories.get(repository.id)?.n || 0, queued.repository.get(repository.id) || 0,
      started.get(repository.id) || 0, Boolean(state?.blockedRepositories.has(repository.id)) || atOrganization, installation));
  }
  return { policies, heldBy, schema: own !== null, rows: out.filter(item => item.own || item.granted || item.limit.maxRunning !== null || item.limit.maxRunsPerDay !== null)
    .sort((a, b) => b.held - a.held || b.running - a.running || a.name.localeCompare(b.name)).slice(0, 200) };
}
function scopeRow(scope, id, name, limits, row, running, queued, runsToday, blocked, installation) {
  const [ownRunning, grantRunning] = shareColumns.maxRunning, [ownDaily, grantDaily] = shareColumns.maxRunsPerDay;
  const own = row && (row[ownRunning] !== null || row[ownDaily] !== null) ? { maxRunning: row[ownRunning], maxRunsPerDay: row[ownDaily] } : null;
  const granted = row && (row[grantRunning] !== null || row[grantDaily] !== null) ? { maxRunning: row[grantRunning], maxRunsPerDay: row[grantDaily] } : null;
  return { scope, id: String(id), name, limit: limits.limit, ceiling: limits.ceiling, own, granted, enforced: installation.enforced, running, queued, held: blocked ? queued : 0, runsToday };
}

// ---------- POST /native/capacity/shares and /native/capacity/shares/read ----------
const slugPattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
const note = value => { if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\p{Cc}]/u.test(value.replace(/\n/g, ''))) invalid('Say why, in at most 500 characters.'); return value.trim(); };
const ownerSQL = "EXISTS(SELECT 1 FROM native_owner_members m JOIN users u ON u.id=m.user_id WHERE m.owner_id=? AND m.user_id=? AND m.role='owner' AND u.active=1)";
export const shareRequestKey = organizationId => 'organization:' + organizationId;
export const shareRequestOrganization = key => /^organization:([1-9][0-9]{0,15})$/.exec(key || '')?.[1] ?? null;
const noCost = 'No cost model for runner shares: self-hosted runner machines are not billed through Cloudflare, and Golf does not measure what they cost.';

/* body: { action, organization } or { action, repository: { owner, name }, repositoryId }. Reading: organization members, or anyone with
 * access to the repository. Changing: organization owners, or repository administrators, under a verified Access sign-in, never a token. */
export async function capacitySharesAPI(db, env, person, request, body, read, authorizeRepository) {
  const target = await resolve();
  const policies = await runnerPolicies(db, env), installation = policies.shares;
  if (read) {
    if (body.action !== 'read') invalid('Use the read action on the read route.');
    return reply(await view());
  }
  if (!installation) refuse('Actions pipelines are not allocated on this installation; there is no runner capacity to share.');
  if (!await tableReady()) refuse(sharesMigration);
  if (!human(request)) forbidden('Runner shares change only under a verified Access sign-in; tokens never change them.');
  if (body.action === 'set') return set();
  if (body.action === 'request') return ask();
  if (body.action === 'withdraw') return withdraw();
  invalid('Use set, request or withdraw.');

  async function resolve() {
    if (body.organization !== undefined) {
      if (typeof body.organization !== 'string' || !slugPattern.test(body.organization) || body.repository !== undefined) invalid('Choose an organization.');
      const row = await db.prepare("SELECT o.id,o.slug,m.role FROM native_owners o LEFT JOIN native_owner_members m ON m.owner_id=o.id AND m.user_id=? WHERE o.slug=? AND o.kind='ORGANIZATION'").bind(person.id, body.organization).first();
      if (!row?.role) forbidden('Organization members read its runner share.');
      return { scope: 'organization', id: row.id, name: row.slug, organization: { id: row.id, slug: row.slug }, repositoryId: null, owner: row.role === 'owner',
        authority: { sql: ownerSQL, values: [row.id, person.id] } };
    }
    const row = await authorizeRepository();
    if (row.role === 'public' || body.repositoryId !== String(row.id)) deny();
    const organization = row.owner_kind === 'ORGANIZATION' ? { id: row.owner_id, slug: row.owner_slug } : null;
    return { scope: 'repository', id: row.id, name: `${row.owner_slug || env.WORKSPACE_SLUG}/${row.name}`, organization, repositoryId: row.id, owner: row.role === 'admin', authority: settingsAuthority(person, row) };
  }
  async function tableReady() { try { await db.prepare('SELECT 1 FROM capacity_shares LIMIT 1').all(); return true; } catch { return false; } }

  async function view() {
    if (!installation) return { scope: target.scope, name: target.name, allocated: false, reason: 'Actions pipelines are not allocated on this installation; there is no runner capacity to share.' };
    const schema = await tableReady();
    const rows = await shareRows(db, target.repositoryId ? [target.repositoryId] : [], [target.organization?.id ?? null]);
    const limits = limitsFor({ installation, rows }, target.repositoryId, target.organization?.id ?? null);
    const mine = target.scope === 'organization' ? limits.organization : limits.repository, row = rows.get(`${target.scope}:${target.id}`) || null;
    const where = target.scope === 'organization' ? 'r.repository_id IN (SELECT repository_id FROM repository_owners WHERE owner_id=?)' : 'r.repository_id=?';
    const counts = await db.prepare(`SELECT SUM(j.state='RUNNING') AS running,SUM(j.state='QUEUED' AND r.attempt=j.attempt AND r.cancel_requested=0 AND r.state IN ('QUEUED','RUNNING','WAITING')) AS queued
      FROM pipeline_jobs j JOIN pipeline_runs r ON r.id=j.run_id WHERE j.engine IN ${pipelineEngines} AND j.state IN ('RUNNING','QUEUED') AND ${where}`).bind(target.id).first();
    const started = (await db.prepare(`SELECT (${runsToday(target.scope)}) AS n`).bind(target.id, dayStart()).first()).n;
    // A repository's jobs also wait while its organization is at its share.
    const parentRunning = target.scope === 'repository' && target.organization ? (await db.prepare(`SELECT (${organizationRunning}) AS n`).bind(target.organization.id).first()).n : null;
    const running = counts?.running || 0, queued = counts?.queued || 0;
    const blocked = mine.limit.maxRunning !== null && running >= mine.limit.maxRunning || parentRunning !== null && limits.organization.limit.maxRunning !== null && parentRunning >= limits.organization.limit.maxRunning;
    const requests = target.scope === 'organization' ? (await db.prepare(`SELECT c.id,c.field,c.current_value,c.requested_value,c.reason,c.state,c.requested_at,c.decision_note,u.login AS requested_by,c.requested_by=? AS mine FROM capacity_requests c JOIN users u ON u.id=c.requested_by
      WHERE c.policy_key=? ORDER BY c.id DESC LIMIT 20`).bind(person.id, shareRequestKey(target.id)).all()).results.map(item => ({ id: String(item.id), field: item.field, label: shareLabels[item.field] || item.field, current: item.current_value,
      requested: item.requested_value, reason: item.reason, state: item.state, requestedAt: item.requested_at, requestedBy: item.requested_by, mine: Boolean(item.mine), decisionNote: item.decision_note })) : [];
    const [ownRunning, grantRunning] = shareColumns.maxRunning, [ownDaily, grantDaily] = shareColumns.maxRunsPerDay;
    return { scope: target.scope, name: target.name, allocated: true, schema: schema ? 'ready' : sharesMigration,
      own: { maxRunning: row?.[ownRunning] ?? null, maxRunsPerDay: row?.[ownDaily] ?? null }, ceiling: mine.ceiling, limit: mine.limit,
      granted: target.scope === 'organization' ? { maxRunning: row?.[grantRunning] ?? null, maxRunsPerDay: row?.[grantDaily] ?? null } : null,
      installation, parent: target.scope === 'repository' && target.organization ? { scope: 'organization', name: target.organization.slug } : { scope: 'installation', name: 'the installation' },
      version: String(row?.version || 0), updatedAt: row?.updated_at || '', bounds: shareBounds,
      usage: { running, queued, held: blocked ? queued : 0, runsToday: started, parentRunning },
      canEdit: target.owner && human(request) && !installation.enforced && schema, canRequest: target.scope === 'organization' && target.owner && human(request) && schema && shareFields.some(field => mine.ceiling[field] !== null),
      editReason: installation.enforced ? 'The installation enforces its runner share; organizations and repositories cannot set their own.' : !schema ? sharesMigration : !target.owner ? (target.scope === 'organization' ? 'Only organization owners change its runner share.' : 'Only repository administrators change its runner share.') : '',
      requests };
  }

  async function set() {
    if (Object.keys(body).some(key => !['action', 'organization', 'repository', 'repositoryId', 'maxRunning', 'maxRunsPerDay', 'expectedVersion'].includes(key)) || typeof body.expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(body.expectedVersion))
      invalid('Send both values (empty for none) and the version you read.');
    if (!target.owner) forbidden(target.scope === 'organization' ? 'Only organization owners change its runner share.' : 'Only repository administrators change its runner share.');
    if (installation.enforced) refuse('The installation enforces its runner share; organizations and repositories cannot set their own.');
    const rows = await shareRows(db, target.repositoryId ? [target.repositoryId] : [], [target.organization?.id ?? null]);
    const limits = limitsFor({ installation, rows }, target.repositoryId, target.organization?.id ?? null), mine = target.scope === 'organization' ? limits.organization : limits.repository;
    const parent = target.scope === 'repository' && target.organization ? `the organization ${target.organization.slug}’s` : 'the installation’s';
    const after = {};
    for (const field of shareFields) {
      const value = body[field] ?? null, [min, max] = shareBounds[field];
      if (value !== null && !(Number.isInteger(value) && value >= min && value <= max)) invalid(`${shareLabels[field]} is empty (inherit) or a whole number from ${min} to ${max}.`);
      if (value !== null && mine.ceiling[field] !== null && value > mine.ceiling[field])
        invalid(`${shareLabels[field]} can be at most ${parent} ${mine.ceiling[field]}.${target.scope === 'organization' ? ' Request more from the installation’s administrators.' : ''}`);
      after[field] = value;
    }
    const row = rows.get(`${target.scope}:${target.id}`), [ownRunning] = shareColumns.maxRunning, [ownDaily] = shareColumns.maxRunsPerDay;
    const before = { maxRunning: row?.[ownRunning] ?? null, maxRunsPerDay: row?.[ownDaily] ?? null }, version = Number(body.expectedVersion);
    if (shareFields.every(field => before[field] === after[field])) invalid('Change at least one value.');
    if ((row?.version || 0) !== version) refuse('This runner share changed since you read it. Refresh before editing.');
    const time = new Date().toISOString(), email = request.headers.get('X-Golf-Native-Access-Email');
    // One batch: the version-fenced write under the editor's current authority, then its audit row only if it applied.
    const [saved] = await db.batch([
      db.prepare(`INSERT INTO capacity_shares(scope,scope_id,max_running,max_runs_per_day,version,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${target.authority.sql}
        AND COALESCE((SELECT version FROM capacity_shares WHERE scope=? AND scope_id=?),0)=?
        ON CONFLICT(scope,scope_id) DO UPDATE SET max_running=excluded.max_running,max_runs_per_day=excluded.max_runs_per_day,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE capacity_shares.version=?`)
        .bind(target.scope, target.id, after.maxRunning, after.maxRunsPerDay, version + 1, person.id, time, ...target.authority.values, target.scope, target.id, version, version),
      auditStatement(db, { actor: person, actorEmail: email, scope: target.scope, scopeId: String(target.id), subject: 'runner-share', action: 'capacity_share.update', before, after,
        widening: shareFields.some(field => wider(before[field] ?? mine.ceiling[field], after[field] ?? mine.ceiling[field])), client: clientHeaders(request) }),
    ]);
    if (saved.meta.changes !== 1) refuse('This runner share or your access changed. Refresh before editing.');
    return reply(await view());
  }

  // An organization owner asks for more than the installation's share; a different operations administrator approves (capacity.mjs).
  async function ask() {
    if (target.scope !== 'organization') invalid('Organizations request a higher runner share; a repository sets its own within its organization’s.');
    if (!target.owner) forbidden('Only organization owners request a higher runner share.');
    if (Object.keys(body).some(key => !['action', 'organization', 'field', 'value', 'reason'].includes(key)) || !shareFields.includes(body.field)) invalid(`Choose ${shareFields.join(' or ')}.`);
    const reason = note(body.reason), [min, max] = shareBounds[body.field];
    if (!Number.isInteger(body.value) || body.value < min || body.value > max) invalid(`${shareLabels[body.field]} is a whole number from ${min} to ${max}.`);
    const rows = await shareRows(db, [], [target.id]), ceiling = limitsFor({ installation, rows }, null, target.id).organization.ceiling[body.field];
    if (ceiling === null) refuse(`The installation sets no limit on ${shareLabels[body.field].toLowerCase()}; there is nothing to raise.`);
    if (body.value <= ceiling) invalid(`Ask for more than the organization’s ceiling of ${ceiling}. Up to it, change the organization’s share yourself.`);
    const time = new Date().toISOString(), email = request.headers.get('X-Golf-Native-Access-Email'), key = shareRequestKey(target.id);
    const [inserted] = await db.batch([
      db.prepare(`INSERT INTO capacity_requests(policy_key,field,current_value,requested_value,ceiling,needs_deploy,estimated_monthly_delta,estimate_basis,reason,requested_by,requested_at,state)
        SELECT ?,?,?,?,?,0,NULL,?,?,?,?,'PENDING' WHERE ${ownerSQL} AND NOT EXISTS(SELECT 1 FROM capacity_requests WHERE policy_key=? AND field=? AND state IN ('PENDING','APPROVED'))`)
        .bind(key, body.field, ceiling, body.value, ceiling, noCost, reason, person.id, time, target.id, person.id, key, body.field),
      auditStatement(db, { actor: person, actorEmail: email, scope: 'organization', scopeId: String(target.id), subject: `${key}.${body.field}`, action: 'capacity_request.create', before: { value: ceiling }, after: { value: body.value }, client: clientHeaders(request) }),
    ]);
    if (inserted.meta.changes !== 1) throw new Fault('already_exists', 409, 'A request for this share is already open. Withdraw it or wait for the decision.');
    return reply(await view());
  }

  async function withdraw() {
    if (target.scope !== 'organization' || typeof body.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.id)) invalid('Choose the organization’s capacity request.');
    const row = await db.prepare('SELECT * FROM capacity_requests WHERE id=? AND policy_key=?').bind(Number(body.id), shareRequestKey(target.id)).first();
    if (!row) throw new Fault('not_found', 404, 'Capacity request not found.');
    if (row.requested_by !== person.id) forbidden('Only the owner who made a request withdraws it.');
    if (!['PENDING', 'APPROVED'].includes(row.state)) refuse(`This request is already ${row.state.toLowerCase()}.`);
    const [changed] = await db.batch([
      db.prepare("UPDATE capacity_requests SET state='WITHDRAWN',decided_by=COALESCE(decided_by,?),decided_at=COALESCE(decided_at,?) WHERE id=? AND requested_by=? AND state=?").bind(person.id, new Date().toISOString(), row.id, person.id, row.state),
      auditStatement(db, { actor: person, actorEmail: request.headers.get('X-Golf-Native-Access-Email'), scope: 'organization', scopeId: String(target.id), subject: `${row.policy_key}.${row.field}`, action: 'capacity_request.withdraw',
        before: { state: row.state }, after: { state: 'WITHDRAWN', requestId: String(row.id) }, client: clientHeaders(request) }),
    ]);
    if (changed.meta.changes !== 1) refuse('This request changed since you read it. Refresh first.');
    return reply(await view());
  }
}

/* Approving an organization's request (capacity.mjs approve): a different operations administrator types the organization's name, with an
 * Access sign-in from the last 10 minutes, since a grant widens. One batch: the request becomes APPLIED only while it is still PENDING and
 * not the approver's own, the grant is written only then, and the audit row only after the grant. */
export async function approveShareRequest(db, env, person, request, row, { confirmation, note: why, admin }) {
  const organizationId = Number(shareRequestOrganization(row.policy_key));
  const organization = await db.prepare("SELECT id,slug FROM native_owners WHERE id=? AND kind='ORGANIZATION'").bind(organizationId).first();
  if (!shareFields.includes(row.field)) invalid('This request names no runner share.');
  if (!organization) return { failed: 'The organization no longer exists; nothing was applied.' };
  try { await db.prepare('SELECT 1 FROM capacity_shares LIMIT 1').all(); } catch { refuse(sharesMigration); }
  if (row.state !== 'PENDING') refuse(`This request is already ${row.state.toLowerCase()}.`);
  if (confirmation !== organization.slug) refuse(`Type ${organization.slug} to confirm this approval.`);
  const issued = Number(request.headers.get('X-Golf-Native-Access-Issued-At'));
  if (!Number.isInteger(issued) || Date.now() / 1000 - issued > 600) refuse('Raising a runner share needs an Access sign-in from the last 10 minutes. Sign out of Access, sign in again and retry.');
  const [, granted] = shareColumns[row.field], time = new Date().toISOString(), email = request.headers.get('X-Golf-Native-Access-Email');
  await db.batch([
    db.prepare(`UPDATE capacity_requests SET state='APPLIED',decided_by=?,decided_at=?,decision_note=?,applied_by=?,applied_at=? WHERE id=? AND state='PENDING' AND requested_by<>? AND ${admin.sql}`)
      .bind(person.id, time, why, person.id, time, row.id, person.id, ...admin.values),
    db.prepare(`INSERT INTO capacity_shares(scope,scope_id,${granted},version,updated_by,updated_at) SELECT 'organization',?,?,1,?,? WHERE changes()=1
      ON CONFLICT(scope,scope_id) DO UPDATE SET ${granted}=excluded.${granted},version=capacity_shares.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(organization.id, row.requested_value, person.id, time),
    auditStatement(db, { actor: person, actorEmail: email, scope: 'organization', scopeId: String(organization.id), subject: `${row.policy_key}.${row.field}`, action: 'capacity_request.approve',
      before: { state: 'PENDING', value: row.current_value }, after: { state: 'APPLIED', value: row.requested_value, organization: organization.slug, requestId: String(row.id) }, widening: true, client: clientHeaders(request) }),
  ]);
  return { failed: null };
}
