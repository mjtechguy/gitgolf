// Automations (docs/AUTOMATIONS.md, agents plan phase 2): definitions at repository, organization or installation scope; events,
// schedules and "Run now" that queue runs; and the runs themselves, started and finished in the workspace write queue.
//
// - Definitions: POST /native/automations (create, update, setEnabled, killSwitch, delete, run) and /native/automations/read (list, get,
//   instructions, runs). Repository administrators, organization owners and operations administrators manage their scope. Every
//   automation is created off and acts as the person who last saved or enabled it (a manual run acts as the person who pressed it);
//   that person's access, the `automations` feature policy and the automation's limits are checked again when each run starts.
// - Events: emitAutomationEvent(env, event) is called where Golf records them (core.mjs, source-api.mjs, pipelines.mjs). It queues
//   one run per matching automation, keyed by a dedupe key, and asks the workspace to process the queue (env.automationsQueued).
//   Schedules are due rows swept by the maintenance alarm (Cron Triggers do not fire on this account). What automations write never
//   emits events, so one automation's output never triggers another.
// - Runs: processAutomations (workspace queue) starts queued runs through their tool (automation-tools/) and applies finished work;
//   inferAutomationRuns (outside the queue) makes the one engine call of runs on a registry engine. Output is untrusted: model and
//   agent text is neutralized before it is written, labelled as automation output, and an automation never merges anything.
import { Fault, invalid, deny, uuidOK, digest } from './common.mjs';
import { operationsAdmin } from './operations.mjs';
import { featureOff, featureColumns } from './feature-policy.mjs';
import { ownerSlug, ownerColumns, ownerJoin } from './owners.mjs';
import { globError, globMatch } from './land-policy.mjs';
import { agentTasksAPI, terminalStates, parse, scrub } from './agent-hosts.mjs';
import { collaboration } from './collaboration.mjs';
import { createAiRun } from './ai-workflow.mjs';
import { neutralize } from './ai.mjs';
import { comparison, changedFiles } from './repository-diff.mjs';
import { readJobLog } from './pipelines.mjs';
import { searchAPI, searchUnallocated } from './search.mjs';
import { agenticSettings } from './agentic-mode.mjs';
import { automationEngines, engineAllowed, isCLI, engineChat, enginesRegistered, usageOf } from './automation-engines.mjs';
import { automationTools, toolCatalogue } from './automation-tools/index.mjs';
import { clipBytes, byteLength, tailBytes } from './automation-tools/text.mjs';

export const automationEvents = ['pull_request.opened', 'pull_request.updated', 'pull_request.review_requested', 'issue.opened', 'pipeline.failed', 'push'];
export const automationOutputs = ['comment', 'review', 'labels', 'issue', 'draft-pr', 'report'];
export const automationLimits = { perDay: [1, 500], concurrency: [1, 10], maxOpenPRs: [0, 50], dedupeWindow: [0, 10080] };
export const automationBounds = { perScope: 100, instructions: 4000, versions: 200, filters: 20, repositories: 100, scheduleMin: 15, scheduleMax: 10080,
  queuedHours: 24, aiMinutes: 20, inferMinutes: 15, taskHours: 3, startPerPass: 10, advancePerPass: 20, inferPerPass: 5, scheduledRepositories: 50 };
export const placeNotes = {
  cloud: 'Coding CLIs in cloud sandboxes arrive in phase 3 of the agents plan; choose an agent host.',
  'ssh-host': 'SSH hosts are not available on this installation yet; choose an agent host.',
};
const scopes = ['repository', 'organization', 'installation'];
const now = () => new Date().toISOString();
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const plain = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const nameOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
const idOK = value => /^[1-9][0-9]{0,15}$/.test(String(value ?? ''));
// A stable UUID v4 from a seed: a retried step reuses the operation key of its first attempt.
async function stableKey(seed) {
  const h = await digest(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Schema 46; an installation that has not migrated says so instead of failing a query.
let migrated = false;
export async function automationSchema(db) {
  if (!migrated) { try { migrated = Boolean((await db.prepare('PRAGMA table_info(automation_runs)').all()).results.length); } catch { migrated = false; } }
  return migrated;
}
export async function automationCapability(db) {
  const ready = await automationSchema(db);
  return { id: 'automations', label: 'Automations', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: ready ? 'Repository administrators, organization owners and operations administrators can point built-in tools (PR reviewer, issue triage, Issue → PR, CI fixer) or their own instructions at events, schedules or a manual run. Output is a private review draft, a comment, labels, an issue, a report or a draft pull request a person publishes; automations never merge. Model engines run the installation model selection; coding CLIs run on agent hosts. Cloud sandboxes arrive in phase 3.'
      : 'Apply the schema 46 migration to use automations.' };
}

// ---------- the stored definition ----------
function stored(a) {
  const trigger = parse(a.trigger, { events: [] }), target = parse(a.target, {}), limits = parse(a.limits, {}), output = parse(a.output, {}), approvals = parse(a.approvals, {});
  return { trigger: { events: trigger.events || [], ...(trigger.schedule ? { schedule: trigger.schedule } : {}) }, target: { repositories: target.repositories || [], branches: target.branches || [], paths: target.paths || [] },
    limits: { perDay: limits.perDay ?? 20, concurrency: limits.concurrency ?? 1, maxOpenPRs: limits.maxOpenPRs ?? 0, dedupeWindow: limits.dedupeWindow ?? 0 },
    output: output.kinds || [], approvals: { draftOnly: true, allowLanding: Boolean(approvals.allowLanding) } };
}
const repositoryJoin = 'LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id';
async function repositoryNames(db, env, ids) {
  if (!ids.length) return new Map();
  const { results } = await db.prepare(`SELECT r.id,r.name,o.slug AS owner_slug FROM repositories r ${repositoryJoin} WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids.map(Number))).all();
  return new Map(results.map(row => [String(row.id), `${ownerSlug(row, env)}/${row.name}`]));
}

// What a scope may hold and who may change it. Repository: administrators manage, writers read. Organization: owners manage, members
// read. Installation: operations administrators.
async function resolveScope(db, env, person, request, body, deps) {
  if (!scopes.includes(body.scope)) invalid('Choose repository, organization or installation scope.');
  if (body.scope === 'repository') {
    const row = await deps.repository();
    if (body.repositoryId !== String(row.id) || row.role === 'public') deny();
    return { scope: 'repository', scopeId: String(row.id), row, name: `${ownerSlug(row, env)}/${row.name}`, manage: row.role === 'admin', read: ['write', 'admin'].includes(row.role),
      denied: 'Repository administrators manage this repository’s automations.' };
  }
  if (body.scope === 'organization') {
    if (typeof body.organization !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.organization)) invalid('Name the organization.');
    const org = await db.prepare("SELECT id,slug FROM native_owners WHERE slug=? AND kind='ORGANIZATION'").bind(body.organization).first();
    if (!org) forbidden('Organization owners manage organization automations.');
    const member = await db.prepare('SELECT role FROM native_owner_members WHERE owner_id=? AND user_id=?').bind(org.id, person.id).first();
    return { scope: 'organization', scopeId: String(org.id), name: org.slug, manage: member?.role === 'owner', read: Boolean(member), denied: 'Organization owners manage organization automations.' };
  }
  const admin = await operationsAdmin(db, person, request);
  return { scope: 'installation', scopeId: '', name: '', manage: admin, read: admin, denied: 'Current workspace operations administrator sign-in required.' };
}

// Target repositories of an organization or installation automation, by owner/name; a repository automation targets itself.
async function targetRepositories(db, env, scope, names) {
  if (scope.scope === 'repository') { if (names.length) invalid('A repository automation targets its own repository.'); return []; }
  if (names.length > automationBounds.repositories || names.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) || new Set(names).size !== names.length)
    invalid(`List up to ${automationBounds.repositories} repositories as owner/name, or none for every repository in scope.`);
  if (!names.length) return [];
  const { results } = await db.prepare(`SELECT r.id,r.name,o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repositories r ${repositoryJoin} WHERE r.state='ACTIVE' AND r.name IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(names.map(name => name.split('/')[1]))).all();
  return names.map(name => {
    const row = results.find(item => `${ownerSlug(item, env)}/${item.name}` === name);
    if (!row) invalid(`No repository ${name}.`);
    if (scope.scope === 'organization' && !(row.owner_kind === 'ORGANIZATION' && String(row.owner_id) === scope.scopeId)) invalid(`${name} is not a repository of this organization.`);
    return String(row.id);
  });
}
function patterns(value, what) {
  if (!Array.isArray(value) || value.length > automationBounds.filters || new Set(value).size !== value.length) invalid(`List up to ${automationBounds.filters} distinct ${what} patterns.`);
  for (const pattern of value) { const error = typeof pattern === 'string' ? globError(pattern) : 'Use text patterns.'; if (error) invalid(`${what[0].toUpperCase() + what.slice(1)} pattern ${JSON.stringify(String(pattern).slice(0, 60))}: ${error}`); }
  return value;
}

// The complete definition after a create or update: the body's fields over the current ones (or the tool's defaults).
async function definition(db, env, person, scope, body, tool, current) {
  const has = key => Object.hasOwn(body, key);
  const name = has('name') ? body.name : current.name;
  if (!plain(name, 100)) invalid('Name the automation in up to 100 characters.');
  const trigger = has('trigger') ? body.trigger : current.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger) || Object.keys(trigger).some(key => !['events', 'schedule'].includes(key))) invalid('A trigger names events and an optional schedule.');
  const events = trigger.events ?? [];
  if (!Array.isArray(events) || new Set(events).size !== events.length || events.some(event => !tool.events.includes(event))) invalid(`${tool.label} runs on ${tool.events.join(', ')}.`);
  let schedule = null;
  if (trigger.schedule !== undefined && trigger.schedule !== null) {
    if (!tool.schedule) invalid(`${tool.label} does not run on a schedule.`);
    const every = trigger.schedule?.everyMinutes;
    if (typeof trigger.schedule !== 'object' || Object.keys(trigger.schedule).join() !== 'everyMinutes' || !Number.isInteger(every) || every < automationBounds.scheduleMin || every > automationBounds.scheduleMax)
      invalid(`Schedule a run every ${automationBounds.scheduleMin} to ${automationBounds.scheduleMax.toLocaleString('en')} minutes.`);
    schedule = { everyMinutes: every };
  }
  const target = has('target') ? body.target : current.target;
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['repositories', 'branches', 'paths'].includes(key))) invalid('A target lists repositories, branches and paths.');
  const repositories = await targetRepositories(db, env, scope, target.repositories ?? []), branches = patterns(target.branches ?? [], 'branch'), paths = patterns(target.paths ?? [], 'path');
  const engine = has('engine') ? body.engine : current.engine;
  if (typeof engine !== 'string' || !engine) invalid('Choose an engine.');
  if (tool.engines === 'model' && isCLI(engine)) invalid(`${tool.label} runs on a model engine, not a coding CLI.`);
  if (tool.engines === 'cli' && !isCLI(engine)) invalid(`${tool.label} runs a coding CLI (codex, claude, opencode or grok) on an agent host.`);
  if (!await engineAllowed(db, env, person, { scope: scope.scope, scopeId: scope.scopeId }, engine))
    refuse(enginesRegistered() ? `Engine ${engine} is not available in this scope.` : 'Until the engines registry is part of this installation, choose the installation model selection (default) or a coding CLI.');
  const place = has('place') ? body.place : current.place;
  let hostId = '';
  if (isCLI(engine)) {
    if (place === 'cloud' || place === 'ssh-host') refuse(placeNotes[place]);
    if (place !== 'agent-host') invalid('Choose where the coding CLI runs.');
    hostId = String(has('hostId') ? body.hostId ?? '' : current.hostId);
    if (!idOK(hostId)) invalid('Choose the agent host.');
    if (!await db.prepare("SELECT 1 AS ok FROM agent_hosts WHERE id=? AND deleted=0 AND state='ACTIVE'").bind(Number(hostId)).first()) refuse('That agent host is not available.');
  } else if (place !== 'cloud') invalid('A model engine runs in the cloud; agent hosts run coding CLIs.');
  const output = has('output') ? body.output : current.output;
  const allowed = tool.id === 'custom' ? (isCLI(engine) ? ['draft-pr'] : ['comment', 'issue', 'report']) : tool.outputs;
  if (!Array.isArray(output) || !output.length || new Set(output).size !== output.length || output.some(kind => !allowed.includes(kind))) invalid(`Choose outputs from ${allowed.join(', ')}.`);
  const limitsIn = has('limits') ? body.limits : {};
  if (!limitsIn || typeof limitsIn !== 'object' || Array.isArray(limitsIn) || Object.keys(limitsIn).some(key => !Object.hasOwn(automationLimits, key))) invalid('Limits are perDay, concurrency, maxOpenPRs and dedupeWindow.');
  const limits = { ...current.limits, ...limitsIn };
  for (const [key, [min, max]] of Object.entries(automationLimits)) if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) invalid(`${key} is a whole number from ${min} to ${max}.`);
  const opens = output.includes('draft-pr');
  if (opens && limits.maxOpenPRs < 1) invalid('Allow at least one open draft pull request.');
  const approvalsIn = has('approvals') ? body.approvals : current.approvals;
  if (!approvalsIn || typeof approvalsIn !== 'object' || Object.keys(approvalsIn).some(key => !['draftOnly', 'allowLanding'].includes(key)) || approvalsIn.draftOnly === false ||
      approvalsIn.allowLanding !== undefined && typeof approvalsIn.allowLanding !== 'boolean') invalid('Automations open draft pull requests only; allowLanding may let agentic mode decide.');
  if (approvalsIn.allowLanding && !opens) invalid('allowLanding applies only to automations that open draft pull requests.');
  const instructions = has('instructions') ? body.instructions : current.instructions;
  if (typeof instructions !== 'string' || byteLength(instructions) > automationBounds.instructions || instructions.includes('\0')) invalid(`Instructions are text up to ${automationBounds.instructions} bytes.`);
  return { name, trigger: { events, ...(schedule ? { schedule } : {}) }, target: { repositories, branches, paths }, engine, place: isCLI(engine) ? place : 'cloud', hostId,
    output, limits: opens ? limits : { ...limits, maxOpenPRs: 0 }, approvals: { draftOnly: true, allowLanding: Boolean(approvalsIn.allowLanding) }, instructions };
}

// ---------- views ----------
async function automationViews(db, env, rows) {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map(a => a.id)), today = now().slice(0, 10);
  const people = new Map((await db.prepare('SELECT id,login FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(rows.flatMap(a => [a.owner_id, a.created_by, a.updated_by]))])).all()).results.map(u => [u.id, u.login]));
  const { results: counts } = await db.prepare(`SELECT automation_id,sum(started_at>=?) AS today,sum(state='RUNNING') AS running,sum(state='QUEUED') AS queued FROM automation_runs WHERE automation_id IN (SELECT value FROM json_each(?)) GROUP BY automation_id`).bind(today, ids).all();
  const { results: last } = await db.prepare(`SELECT r.automation_id,r.state,r.reason,r.created_at FROM automation_runs r WHERE r.automation_id IN (SELECT value FROM json_each(?)) AND r.rowid=(SELECT x.rowid FROM automation_runs x WHERE x.automation_id=r.automation_id ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)`).bind(ids).all();
  const hosts = new Map((await db.prepare('SELECT id,name FROM agent_hosts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.filter(a => a.host_id).map(a => Number(a.host_id)))).all()).results.map(h => [String(h.id), h.name]));
  const names = await repositoryNames(db, env, [...new Set(rows.flatMap(a => [...stored(a).target.repositories, ...(a.scope === 'repository' ? [a.scope_id] : [])]))]);
  const orgs = new Map((await db.prepare("SELECT id,slug FROM native_owners WHERE kind='ORGANIZATION' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(rows.filter(a => a.scope === 'organization').map(a => Number(a.scope_id)))).all()).results.map(o => [String(o.id), o.slug]));
  return rows.map(a => {
    const s = stored(a), count = counts.find(row => row.automation_id === a.id), latest = last.find(row => row.automation_id === a.id), tool = automationTools[a.tool];
    return { id: a.id, scope: a.scope, scopeId: a.scope_id, scopeName: a.scope === 'repository' ? names.get(a.scope_id) || '' : a.scope === 'organization' ? orgs.get(a.scope_id) || '' : '',
      tool: a.tool, toolLabel: tool?.label || a.tool, name: a.name, enabled: Boolean(a.enabled), killSwitch: Boolean(a.kill_switch), trigger: s.trigger,
      target: { repositories: s.target.repositories.map(id => names.get(String(id))).filter(Boolean), branches: s.target.branches, paths: s.target.paths },
      engine: a.engine, place: a.place, hostId: a.host_id, hostName: hosts.get(a.host_id) || '', output: s.output, limits: s.limits, approvals: s.approvals,
      instructionsVersion: a.instructions_version, version: a.version, owner: { id: String(a.owner_id), login: people.get(a.owner_id) || '' },
      createdBy: people.get(a.created_by) || '', updatedBy: people.get(a.updated_by) || '', createdAt: a.created_at, updatedAt: a.updated_at,
      nextRunAt: a.next_run_at ? new Date(a.next_run_at).toISOString() : '',
      stats: { today: count?.today || 0, running: count?.running || 0, queued: count?.queued || 0, last: latest ? { state: latest.state, reason: latest.reason, at: latest.created_at } : null } };
  });
}
// Outputs are references and bounded, already-neutralized text; ids of other rows become links the UI can follow.
function outputsView(env, repositoryName, outputs) {
  const base = repositoryName ? `${env.PUBLIC_ORIGIN}/${repositoryName}` : '';
  const { engineOutput, ...shown } = outputs;
  return { ...shown, ...(base && shown.pullNumber ? { pullUrl: `${base}/pull/${shown.pullNumber}` } : {}), ...(base && shown.issueNumber ? { issueUrl: `${base}/issues/${shown.issueNumber}` } : {}) };
}
async function runViews(db, env, rows) {
  if (!rows.length) return [];
  const names = await repositoryNames(db, env, [...new Set(rows.map(r => r.repository_id).filter(Boolean).map(String))]);
  const people = new Map((await db.prepare('SELECT id,login FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(rows.map(r => r.requested_by).filter(Boolean))])).all()).results.map(u => [u.id, u.login]));
  return rows.map(r => {
    const repository = names.get(String(r.repository_id)) || '', usage = parse(r.usage, {});
    return { id: r.id, automationId: r.automation_id, automationName: r.automation_name || '', tool: r.tool || '', repository, trigger: r.trigger,
      target: { kind: r.target_kind, number: r.target_number, commit: r.target_commit, url: repository && r.target_number && ['issue', 'pull_request'].includes(r.target_kind) ? `${env.PUBLIC_ORIGIN}/${repository}/${r.target_kind === 'issue' ? 'issues' : 'pull'}/${r.target_number}` : '' },
      state: r.state, phase: r.phase, reason: r.reason, engine: r.engine, place: r.place, instructionsVersion: r.instructions_version, requestedBy: r.requested_by ? people.get(r.requested_by) || '' : '',
      usage: Object.keys(usage).length ? usage : null, outputs: outputsView(env, repository, parse(r.outputs, {})), createdAt: r.created_at, startedAt: r.started_at || '', finishedAt: r.finished_at || '' };
  });
}
const runSelect = 'SELECT r.*,a.name AS automation_name,a.tool FROM automation_runs r JOIN automations a ON a.id=r.automation_id';

// ---------- the API ----------
const readActions = ['list', 'get', 'instructions', 'runs'], writeActions = ['create', 'update', 'setEnabled', 'killSwitch', 'delete', 'run'];
export async function automationsAPI(db, env, person, request, body, read, deps) {
  if (!await automationSchema(db)) refuse('Automations need the schema 46 migration on this installation.');
  const action = body.action;
  if (!readActions.includes(action) && !writeActions.includes(action)) invalid('Unknown automation operation.');
  if (read !== readActions.includes(action)) invalid(read ? 'This route only reads automations.' : 'This route only changes automations.');
  const scope = await resolveScope(db, env, person, request, body, deps);
  if (!(read ? scope.read : scope.manage)) forbidden(scope.denied);
  const load = async () => {
    const a = typeof body.id === 'string' && uuidOK(body.id) ? await db.prepare('SELECT * FROM automations WHERE id=? AND deleted=0').bind(body.id).first() : null;
    if (!a || a.scope !== scope.scope || a.scope_id !== scope.scopeId) deny();
    return a;
  };
  const feature = scope.row ? await featureOff(db, env, scope.row, 'automations') : null;

  if (action === 'list') {
    const { results } = await db.prepare('SELECT * FROM automations WHERE scope=? AND scope_id=? AND deleted=0 ORDER BY name,created_at LIMIT ?').bind(scope.scope, scope.scopeId, automationBounds.perScope).all();
    // A repository also lists the organization and installation automations that reach it, read-only.
    let inherited = [];
    if (scope.row) {
      const { results: wider } = await db.prepare("SELECT * FROM automations WHERE deleted=0 AND (scope='installation' OR scope='organization' AND scope_id=?) ORDER BY scope,name LIMIT 100")
        .bind(scope.row.owner_kind === 'ORGANIZATION' ? String(scope.row.owner_id) : '-').all();
      inherited = wider.filter(a => { const repos = stored(a).target.repositories; return !repos.length || repos.includes(scope.scopeId); });
    }
    const hostsSQL = "SELECT id,name,scope FROM agent_hosts WHERE deleted=0 AND state='ACTIVE' AND (scope='installation' OR scope='organization' AND scope_id=? OR scope='personal' AND scope_id=?) ORDER BY name,id LIMIT 100";
    const orgId = scope.scope === 'organization' ? scope.scopeId : scope.row?.owner_kind === 'ORGANIZATION' ? String(scope.row.owner_id) : '-';
    const { results: hosts } = scope.manage ? await db.prepare(hostsSQL).bind(orgId, String(person.id)).all() : { results: [] };
    return { scope: { scope: scope.scope, scopeId: scope.scopeId, name: scope.name }, canManage: scope.manage, featureOn: !feature, featureReason: feature?.reason || '',
      automations: await automationViews(db, env, results), inherited: await automationViews(db, env, inherited), tools: toolCatalogue(),
      engines: await automationEngines(db, env, person, { scope: scope.scope, scopeId: scope.scopeId }), enginesRegistered: enginesRegistered(),
      hosts: hosts.map(h => ({ id: String(h.id), name: h.name, scope: h.scope })), places: { 'agent-host': '', ...placeNotes } };
  }
  if (action === 'runs') {
    if (body.automationId !== undefined && !uuidOK(body.automationId)) invalid('Choose an automation.');
    // A repository sees every run on it, its own automations' and inherited ones; wider scopes see their automations' runs.
    const filter = body.automationId ? ' AND r.automation_id=?' : '', values = body.automationId ? [body.automationId] : [];
    const { results } = scope.row
      ? await db.prepare(`${runSelect} WHERE r.repository_id=?${filter} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 51`).bind(scope.row.id, ...values).all()
      : await db.prepare(`${runSelect} WHERE a.scope=? AND a.scope_id=?${filter} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 51`).bind(scope.scope, scope.scopeId, ...values).all();
    return { runs: await runViews(db, env, results.slice(0, 50)), truncated: results.length > 50 };
  }
  if (action === 'get' || action === 'instructions') {
    const a = await load();
    if (action === 'instructions') {
      if (!Number.isInteger(body.version) || body.version < 1) invalid('Choose an instructions version.');
      const version = await db.prepare('SELECT i.*,u.login FROM automation_instructions i LEFT JOIN users u ON u.id=i.created_by WHERE i.automation_id=? AND i.version=?').bind(a.id, body.version).first();
      if (!version) deny();
      return { version: version.version, text: version.text, createdBy: version.login || '', createdAt: version.created_at, current: version.version === a.instructions_version };
    }
    const { results: versions } = await db.prepare('SELECT i.version,i.created_at,u.login FROM automation_instructions i LEFT JOIN users u ON u.id=i.created_by WHERE i.automation_id=? ORDER BY i.version DESC LIMIT 200').bind(a.id).all();
    const text = (await db.prepare('SELECT text FROM automation_instructions WHERE automation_id=? AND version=?').bind(a.id, a.instructions_version).first())?.text ?? '';
    return { automation: { ...(await automationViews(db, env, [a]))[0], instructions: text },
      instructionVersions: versions.map(v => ({ version: v.version, createdBy: v.login || '', createdAt: v.created_at, current: v.version === a.instructions_version })) };
  }

  // ---------- changes ----------
  if (feature && ['create', 'run'].includes(action) || feature && action === 'setEnabled' && body.enabled === true) refuse(feature.reason);
  const time = now();
  if (action === 'create') {
    const tool = automationTools[body.tool];
    if (!tool) invalid('Choose a built-in tool or custom.');
    if (!Object.keys(body).every(key => ['action', 'scope', 'repository', 'repositoryId', 'organization', 'tool', 'name', 'trigger', 'target', 'engine', 'place', 'hostId', 'instructions', 'output', 'limits', 'approvals'].includes(key))) invalid('Unknown field.');
    if ((await db.prepare('SELECT count(*) AS n FROM automations WHERE scope=? AND scope_id=? AND deleted=0').bind(scope.scope, scope.scopeId).first()).n >= automationBounds.perScope) refuse(`This scope already has ${automationBounds.perScope} automations.`);
    // Copying a built-in: every field the request leaves out is the tool's default.
    const d = await definition(db, env, person, scope, body, tool, { name: tool.defaults.name, trigger: { events: tool.defaults.events }, target: { repositories: [], branches: [], paths: [] },
      engine: tool.engines === 'cli' ? '' : 'default', place: tool.engines === 'cli' ? 'agent-host' : 'cloud', hostId: '', output: tool.defaults.output, limits: tool.defaults.limits,
      approvals: { draftOnly: true, allowLanding: false }, instructions: tool.defaults.instructions });
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO automations(id,scope,scope_id,owner_id,tool,name,enabled,kill_switch,trigger,target,engine,place,host_id,instructions_version,output,limits,approvals,version,next_run_at,deleted,created_by,updated_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,0,0,?,?,?,?,?,1,?,?,?,1,NULL,0,?,?,?,?)`).bind(id, scope.scope, scope.scopeId, person.id, tool.id, d.name, JSON.stringify(d.trigger), JSON.stringify(d.target), d.engine, d.place, d.hostId,
        JSON.stringify({ kinds: d.output }), JSON.stringify(d.limits), JSON.stringify(d.approvals), person.id, person.id, time, time),
      db.prepare('INSERT INTO automation_instructions(automation_id,version,text,created_by,created_at) VALUES(?,1,?,?,?)').bind(id, d.instructions, person.id, time),
    ]);
    return { automation: (await automationViews(db, env, [await db.prepare('SELECT * FROM automations WHERE id=?').bind(id).first()]))[0] };
  }
  const a = await load(), tool = automationTools[a.tool];
  if (action === 'update') {
    if (!Object.keys(body).every(key => ['action', 'scope', 'repository', 'repositoryId', 'organization', 'id', 'expectedVersion', 'name', 'trigger', 'target', 'engine', 'place', 'hostId', 'instructions', 'output', 'limits', 'approvals'].includes(key))) invalid('Unknown field.');
    if (body.expectedVersion !== a.version) refuse('The automation changed; refresh before saving.');
    const s = stored(a), names = await repositoryNames(db, env, s.target.repositories);
    const currentText = (await db.prepare('SELECT text FROM automation_instructions WHERE automation_id=? AND version=?').bind(a.id, a.instructions_version).first())?.text ?? '';
    const d = await definition(db, env, person, scope, body, tool, { name: a.name, trigger: s.trigger, target: { ...s.target, repositories: s.target.repositories.map(id => names.get(String(id))).filter(Boolean) },
      engine: a.engine, place: a.place, hostId: a.host_id, output: s.output, limits: s.limits, approvals: s.approvals, instructions: currentText });
    const newText = d.instructions !== currentText, version = newText ? (await db.prepare('SELECT COALESCE(max(version),0)+1 AS v FROM automation_instructions WHERE automation_id=?').bind(a.id).first()).v : a.instructions_version;
    if (version > automationBounds.versions) refuse(`This automation has ${automationBounds.versions} instruction versions; copy it to keep editing.`);
    // A schedule change restarts its clock from now; the person who saves becomes the person it acts as.
    const scheduleChanged = JSON.stringify(d.trigger.schedule || null) !== JSON.stringify(s.trigger.schedule || null);
    const next = !d.trigger.schedule ? null : scheduleChanged || !a.next_run_at ? Date.now() + d.trigger.schedule.everyMinutes * 60_000 : a.next_run_at;
    const statements = [db.prepare(`UPDATE automations SET name=?,trigger=?,target=?,engine=?,place=?,host_id=?,instructions_version=?,output=?,limits=?,approvals=?,owner_id=?,updated_by=?,updated_at=?,
      next_run_at=CASE WHEN enabled=1 THEN ? ELSE NULL END,version=version+1 WHERE id=? AND version=? AND deleted=0`)
      .bind(d.name, JSON.stringify(d.trigger), JSON.stringify(d.target), d.engine, d.place, d.hostId, version, JSON.stringify({ kinds: d.output }), JSON.stringify(d.limits), JSON.stringify(d.approvals), person.id, person.id, time, next, a.id, a.version)];
    if (newText) statements.push(db.prepare('INSERT INTO automation_instructions(automation_id,version,text,created_by,created_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(a.id, version, d.instructions, person.id, time));
    const [changed] = await db.batch(statements);
    if (changed.meta.changes !== 1) refuse('The automation changed; refresh before saving.');
    return { automation: (await automationViews(db, env, [await db.prepare('SELECT * FROM automations WHERE id=?').bind(a.id).first()]))[0] };
  }
  if (action === 'setEnabled') {
    if (typeof body.enabled !== 'boolean') invalid('Choose on or off.');
    if (body.expectedVersion !== a.version) refuse('The automation changed; refresh before saving.');
    const s = stored(a);
    if (body.enabled && !s.trigger.events.length && !s.trigger.schedule) refuse('Choose at least one event or a schedule before turning this automation on; Run now works while it is off.');
    const changed = await db.prepare('UPDATE automations SET enabled=?,owner_id=CASE WHEN ? THEN ? ELSE owner_id END,next_run_at=?,updated_by=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND deleted=0')
      .bind(body.enabled ? 1 : 0, body.enabled ? 1 : 0, person.id, body.enabled && s.trigger.schedule ? Date.now() + s.trigger.schedule.everyMinutes * 60_000 : null, person.id, time, a.id, a.version).run();
    if (changed.meta.changes !== 1) refuse('The automation changed; refresh before saving.');
    if (!body.enabled) await db.prepare("UPDATE automation_runs SET state='SKIPPED',reason='The automation was turned off before this run started.',finished_at=?,updated_at=? WHERE automation_id=? AND state='QUEUED' AND trigger!='manual'").bind(time, time, a.id).run();
    return { automation: (await automationViews(db, env, [await db.prepare('SELECT * FROM automations WHERE id=?').bind(a.id).first()]))[0] };
  }
  if (action === 'killSwitch' || action === 'delete') {
    // An emergency stop needs no version: queued runs are skipped, running agent tasks are told to stop, and work in flight is discarded.
    if (action === 'killSwitch' && typeof body.engaged !== 'boolean') invalid('Engage or release the kill switch.');
    const stop = action === 'delete' || body.engaged;
    await db.prepare(action === 'delete' ? 'UPDATE automations SET deleted=1,enabled=0,next_run_at=NULL,updated_by=?,updated_at=?,version=version+1 WHERE id=?' : 'UPDATE automations SET kill_switch=?,updated_by=?,updated_at=?,version=version+1 WHERE id=?')
      .bind(...(action === 'delete' ? [] : [body.engaged ? 1 : 0]), person.id, time, a.id).run();
    if (stop) await stopRuns(db, a.id, action === 'delete' ? 'The automation was deleted.' : 'The kill switch was engaged.');
    if (action === 'delete') return { ok: true };
    return { automation: (await automationViews(db, env, [await db.prepare('SELECT * FROM automations WHERE id=?').bind(a.id).first()]))[0] };
  }
  // Run now: acts as the person who pressed it, while the automation is on or off (not while its kill switch is engaged).
  if (a.kill_switch) refuse('The kill switch is engaged; release it before running this automation.');
  const target = body.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) invalid('Choose what to run on.');
  let row = scope.row;
  if (!row) {
    if (!nameOK(target.repository?.owner) || !nameOK(target.repository?.name)) invalid('Choose a repository as owner/name.');
    row = await db.prepare(`SELECT r.*,${ownerColumns} FROM repositories r ${ownerJoin} WHERE r.name=? AND r.state='ACTIVE'`).bind(target.repository.name).first();
    if (!row || ownerSlug(row, env) !== target.repository.owner) invalid(`No repository ${target.repository.owner}/${target.repository.name}.`);
    if (!inScope(a, row)) invalid('That repository is outside this automation’s target.');
  }
  const kinds = [...new Set([...tool.targets, ...(tool.schedule ? ['repository'] : [])])];
  if (!kinds.includes(target.kind)) invalid(`${tool.label} runs on ${kinds.map(kind => kind.replace('_', ' ')).join(' or ')}.`);
  let subject;
  if (target.kind === 'pipeline_run') {
    if (!idOK(target.runId)) invalid('Choose an Actions run.');
    const run = await db.prepare('SELECT id,commit_id FROM pipeline_runs WHERE id=? AND repository_id=?').bind(Number(target.runId), row.id).first();
    if (!run) invalid('This repository has no such Actions run.');
    subject = { type: 'manual', kind: 'pipeline_run', number: run.id, runId: run.id, commit: run.commit_id };
  } else if (target.kind === 'repository') subject = { type: 'manual', kind: 'repository' };
  else {
    if (!Number.isSafeInteger(target.number) || target.number < 1) invalid('Choose an issue or pull request number.');
    if (!await db.prepare('SELECT 1 AS ok FROM discussions WHERE repository_id=? AND number=? AND kind=?').bind(row.id, target.number, target.kind === 'issue' ? 'issue' : 'pull').first())
      invalid(`This repository has no ${target.kind === 'issue' ? 'issue' : 'pull request'} #${target.number}.`);
    subject = { type: 'manual', kind: target.kind, number: target.number };
  }
  const id = await insertRun(db, a, row.id, subject, `${a.id}:manual:${crypto.randomUUID()}`, person.id);
  env.automationsQueued?.();
  const [view] = await runViews(db, env, [await db.prepare(`${runSelect} WHERE r.id=?`).bind(id).first()]);
  return { run: view };
}

async function stopRuns(db, automationId, reason) {
  const time = now();
  const { results: running } = await db.prepare("SELECT id,outputs FROM automation_runs WHERE automation_id=? AND state='RUNNING'").bind(automationId).all();
  const tasks = running.map(r => parse(r.outputs, {}).agentTaskId).filter(Boolean);
  await db.batch([
    db.prepare("UPDATE automation_runs SET state='SKIPPED',reason=?,finished_at=?,updated_at=? WHERE automation_id=? AND state='QUEUED'").bind(reason, time, time, automationId),
    db.prepare("UPDATE automation_runs SET state='FAILED',phase='',input=NULL,reason=?,finished_at=?,updated_at=? WHERE automation_id=? AND state='RUNNING'").bind(reason + ' Work in flight was discarded.', time, time, automationId),
    ...(tasks.length ? [db.prepare("UPDATE agent_tasks SET state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE state END,failure_reason=CASE WHEN state='QUEUED' THEN 'cancelled' ELSE failure_reason END,finished_at=CASE WHEN state='QUEUED' THEN ? ELSE finished_at END,cancel_requested=1,updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('QUEUED','CLAIMED','RUNNING')").bind(time, time, JSON.stringify(tasks))] : []),
  ]);
}

// ---------- events ----------
// Whether an automation reaches a repository: its scope, then its repository list.
function inScope(a, repo) {
  if (a.scope === 'repository') return a.scope_id === String(repo.id);
  if (a.scope === 'organization' && !(repo.owner_kind === 'ORGANIZATION' && String(repo.owner_id) === a.scope_id)) return false;
  const repos = stored(a).target.repositories;
  return !repos.length || repos.includes(String(repo.id));
}
const branchOK = (branches, branch) => !branches.length || typeof branch === 'string' && branches.some(pattern => globMatch(pattern, branch));
async function insertRun(db, a, repositoryId, subject, key, requestedBy = null) {
  const id = crypto.randomUUID(), time = now();
  const event = Object.fromEntries(Object.entries({ type: subject.type, ref: subject.ref, before: subject.before, after: subject.after, runId: subject.runId, actorId: subject.actorId, baseBranch: subject.baseBranch }).filter(([, value]) => value !== undefined && value !== null));
  const saved = await db.prepare(`INSERT INTO automation_runs(id,automation_id,repository_id,trigger,event,target_kind,target_number,target_commit,state,engine,place,instructions_version,requested_by,dedupe_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`).bind(id, a.id, Number(repositoryId), subject.type, JSON.stringify(event), subject.kind || '', subject.number ?? null,
    subject.commit || subject.headCommit || subject.after || '', a.engine, a.place, a.instructions_version, requestedBy, key, time, time).run();
  return saved.meta.changes === 1 ? id : null;
}
const dedupeKey = (a, tool, subject) => {
  const window = stored(a).limits.dedupeWindow;
  return `${a.id}:${tool.dedupe(subject)}${window ? ':' + Math.floor(Date.now() / (window * 60_000)) : ''}`;
};

// event: { type: issue.opened | pull_request.opened | pull_request.review_requested | push | pipeline.failed, repositoryId, actorId?,
//   number?, headCommit?, ref?, before?, after?, runId?, commit?, pullNumber? }. Queues runs; never throws into the caller.
export async function emitAutomationEvent(env, event) {
  const db = env.DB.withSession('first-primary');
  if (!await automationSchema(db)) return 0;
  const repo = await db.prepare(`SELECT r.id,r.name,r.default_branch,${ownerColumns} FROM repositories r ${ownerJoin} WHERE r.id=? AND r.state='ACTIVE'`).bind(Number(event.repositoryId)).first();
  if (!repo) return 0;
  const { results } = await db.prepare("SELECT * FROM automations WHERE deleted=0 AND enabled=1 AND kill_switch=0 AND (scope='installation' OR scope='organization' AND scope_id=? OR scope='repository' AND scope_id=?) LIMIT 300")
    .bind(repo.owner_kind === 'ORGANIZATION' ? String(repo.owner_id) : '-', String(repo.id)).all();
  const candidates = results.filter(a => inScope(a, repo) && automationTools[a.tool]);
  if (!candidates.length || await featureOff(db, env, repo.id, 'automations')) return 0;
  // The subjects one event stands for: a push to the head branch of open pull requests is also their pull_request.updated.
  const subjects = [];
  if (event.type === 'push') {
    const branch = String(event.ref || '').startsWith('refs/heads/') ? event.ref.slice(11) : null;
    subjects.push({ type: 'push', kind: 'commit', ref: event.ref, before: event.before, after: event.after, branch, actorId: event.actorId });
    if (branch && candidates.some(a => stored(a).trigger.events.includes('pull_request.updated'))) {
      const { results: pulls } = await db.prepare("SELECT d.number,p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.state='OPEN' AND p.head_branch=? ORDER BY d.number LIMIT 10").bind(repo.id, branch).all();
      for (const pull of pulls) subjects.push({ type: 'pull_request.updated', kind: 'pull_request', number: pull.number, headCommit: event.after, branch: pull.base_branch, baseBranch: pull.base_branch, actorId: event.actorId });
    }
  } else if (event.type === 'pipeline.failed') {
    const run = await db.prepare('SELECT ref,head_ref,base_ref,pull_number FROM pipeline_runs WHERE id=?').bind(Number(event.runId)).first();
    const ref = run?.pull_number ? String(run.head_ref || '') : String(run?.ref || event.ref || '');
    subjects.push({ type: 'pipeline.failed', kind: 'pipeline_run', number: Number(event.runId), runId: Number(event.runId), commit: event.commit, ref, branch: ref.replace(/^refs\/heads\//, '') || null });
  } else if (['pull_request.opened', 'pull_request.review_requested'].includes(event.type)) {
    const pull = await db.prepare("SELECT p.base_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.number=? AND d.kind='pull'").bind(repo.id, event.number).first();
    if (pull) subjects.push({ type: event.type, kind: 'pull_request', number: event.number, headCommit: event.headCommit || '', branch: pull.base_branch, baseBranch: pull.base_branch, actorId: event.actorId });
  } else if (event.type === 'issue.opened') subjects.push({ type: 'issue.opened', kind: 'issue', number: event.number, branch: null, actorId: event.actorId });
  let queued = 0;
  for (const a of candidates) {
    const s = stored(a), tool = automationTools[a.tool];
    for (const subject of subjects) {
      if (!s.trigger.events.includes(subject.type)) continue;
      // Branch patterns: the base branch of a pull request, the pushed branch, the branch an Actions run ran on. Issues have none.
      if (subject.kind !== 'issue' && !branchOK(s.target.branches, subject.branch)) continue;
      if (await insertRun(db, a, repo.id, subject, dedupeKey(a, tool, subject))) queued++;
    }
  }
  if (queued) env.automationsQueued?.();
  return queued;
}
// For the places events are recorded: after the response where the runtime allows it, never failing the caller.
export function automationEvent(env, event) {
  const work = emitAutomationEvent(env, event).catch(error => console.log(JSON.stringify({ event: 'golf.automation_event_failed', type: event?.type, message: String(error?.message || error).slice(0, 200) })));
  if (env.waitUntil) { env.waitUntil(work); return Promise.resolve(); }
  return work;
}

// ---------- maintenance: due schedules, runs that never started, waits that never ended ----------
export async function sweepAutomations(env) {
  const db = env.DB.withSession('first-primary');
  if (!await automationSchema(db)) return { processed: 0, pending: 0 };
  const time = now(), at = Date.now();
  let processed = 0;
  const { results: due } = await db.prepare('SELECT * FROM automations WHERE deleted=0 AND enabled=1 AND kill_switch=0 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 20').bind(at).all();
  for (const a of due) {
    const s = stored(a), tool = automationTools[a.tool];
    if (!s.trigger.schedule || !tool) { await db.prepare('UPDATE automations SET next_run_at=NULL WHERE id=?').bind(a.id).run(); continue; }
    // One run per target repository per due slot; the slot is the time it was due, so a retried sweep queues nothing new.
    const repos = await scheduledRepositories(db, a);
    for (const repositoryId of repos) if (await insertRun(db, a, repositoryId, { type: 'schedule', kind: 'repository' }, `${a.id}:schedule:${repositoryId}:${a.next_run_at}`)) processed++;
    const every = s.trigger.schedule.everyMinutes * 60_000;
    await db.prepare('UPDATE automations SET next_run_at=? WHERE id=? AND next_run_at=?').bind(Math.max(at, a.next_run_at) + every, a.id, a.next_run_at).run();
  }
  const queuedBefore = new Date(at - automationBounds.queuedHours * 3600_000).toISOString(), aiBefore = new Date(at - automationBounds.aiMinutes * 60_000).toISOString(),
    inferBefore = new Date(at - automationBounds.inferMinutes * 60_000).toISOString(), taskBefore = new Date(at - automationBounds.taskHours * 3600_000).toISOString();
  const [expired, ai, infer, tasks] = await db.batch([
    db.prepare("UPDATE automation_runs SET state='SKIPPED',reason='The run did not start within a day.',finished_at=?,updated_at=? WHERE state='QUEUED' AND created_at<?").bind(time, time, queuedBefore),
    db.prepare("UPDATE automation_runs SET state='FAILED',phase='',input=NULL,reason='The AI run did not finish within 20 minutes.',finished_at=?,updated_at=? WHERE state='RUNNING' AND phase IN ('start','wait-ai') AND updated_at<?").bind(time, time, aiBefore),
    db.prepare("UPDATE automation_runs SET state='FAILED',phase='',input=NULL,reason='The engine did not answer within 15 minutes.',finished_at=?,updated_at=? WHERE state='RUNNING' AND phase IN ('infer','inferring','apply') AND updated_at<?").bind(time, time, inferBefore),
    db.prepare("UPDATE automation_runs SET state='FAILED',phase='',reason='The agent task did not finish within 3 hours.',finished_at=?,updated_at=? WHERE state='RUNNING' AND phase='wait-task' AND updated_at<?").bind(time, time, taskBefore),
  ]);
  processed += expired.meta.changes + ai.meta.changes + infer.meta.changes + tasks.meta.changes;
  const pending = (await db.prepare("SELECT count(*) AS n FROM automation_runs WHERE state='QUEUED' OR state='RUNNING' AND phase IN ('wait-ai','wait-task','infer','apply')").first()).n;
  return { processed, pending };
}
async function scheduledRepositories(db, a) {
  if (a.scope === 'repository') return [Number(a.scope_id)];
  const listed = stored(a).target.repositories;
  if (listed.length) return listed.slice(0, automationBounds.scheduledRepositories).map(Number);
  const { results } = a.scope === 'organization'
    ? await db.prepare("SELECT r.id FROM repositories r JOIN repository_owners ro ON ro.repository_id=r.id WHERE ro.owner_id=? AND r.state='ACTIVE' ORDER BY r.id LIMIT ?").bind(Number(a.scope_id), automationBounds.scheduledRepositories).all()
    : await db.prepare("SELECT id FROM repositories WHERE state='ACTIVE' ORDER BY id LIMIT ?").bind(automationBounds.scheduledRepositories).all();
  return results.map(row => row.id);
}

// ---------- runs, in the workspace queue ----------
async function actorOf(db, id) {
  return db.prepare(`SELECT u.id,u.login,u.email,u.active,u.can_create,COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name FROM users u
    LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id=? AND u.active=1`).bind(Number(id)).first();
}
// The repository as the acting person holds it now, with the columns authorizedRepository reads (role, owner, fences, policy).
async function repositoryFor(db, env, repositoryId, userId) {
  const row = await db.prepare(`SELECT r.*,g.role,${ownerColumns},COALESCE(o.id,w.id) AS workspace_id,(SELECT k.operation_id FROM git_ref_unknown k WHERE k.repository_id=r.id LIMIT 1) AS unknown_write,
    COALESCE(v.version,0) AS access_version,${featureColumns} FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN workspaces w ON w.artifact_namespace=? ${ownerJoin}
    LEFT JOIN repository_access_versions v ON v.repository_id=r.id WHERE r.id=? AND g.user_id=? AND r.state='ACTIVE'`).bind(env.ARTIFACTS_NAMESPACE, Number(repositoryId), Number(userId)).first();
  if (row) { row.repository_write_pending = row.write_pending; row.write_pending ||= row.unknown_write || null; }
  return row;
}
const failure = (error, fallback) => error instanceof Fault ? clipBytes(error.message, 500) : `${fallback}: ${clipBytes(String(error?.message || error), 300)}`;
async function finishRun(db, run, state, reason, extra = {}) {
  const time = now(), outputs = { ...parse(run.outputs, {}), ...(extra.outputs || {}) };
  delete outputs.engineOutput;
  await db.prepare("UPDATE automation_runs SET state=?,phase='',reason=?,outputs=?,usage=CASE WHEN ? IS NULL THEN usage ELSE ? END,input=NULL,started_at=COALESCE(started_at,?),finished_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','RUNNING')")
    .bind(state, clipBytes(reason || '', 1000), JSON.stringify(outputs), extra.usage ? JSON.stringify(extra.usage) : null, extra.usage ? JSON.stringify(extra.usage) : null, time, time, time, run.id).run();
  return state;
}
const header = (a, tool) => `> Automation **${neutralize(a.name)}** (${tool.label}) wrote this. It is automated and unverified: check it before relying on it.`;

// What a tool may read and write while a run is started or applied. Every write acts as `person` through the existing contracts
// (collaboration, agent tasks, AI runs), so the same authority, fences and receipts apply as for a person in the UI.
function runContext(db, env, deps, a, run, person, row) {
  const tool = automationTools[a.tool], key = { owner: ownerSlug(row, env), name: row.name }, artifact = action => deps.withArtifact(env, row, action);
  const s = stored(a), event = parse(run.event, {});
  const discussion = async (kind, number) => {
    const d = await db.prepare('SELECT id FROM discussions WHERE repository_id=? AND number=? AND kind=?').bind(row.id, number, kind === 'issue' ? 'issue' : 'pull').first();
    if (!d) refuse(`This repository has no ${kind === 'issue' ? 'issue' : 'pull request'} #${number}.`);
    return d;
  };
  const ctx = {
    db, env, automation: a, tool, run, event, person, row, artifact, outputs: s.output, engine: a.engine, cli: isCLI(a.engine), repositoryName: `${key.owner}/${key.name}`,
    instructions: '',
    pull: async number => (await collaboration(db, env, person, 'GetPullRequest', { repository: key, number }, row, artifact)).pullRequest,
    issue: async number => (await collaboration(db, env, person, 'GetIssue', { repository: key, number }, row, artifact)).issue,
    // body is untrusted text (model or agent output, repository text): neutralized here. verbatim is a code fence the caller built.
    async comment({ kind, number, body, verbatim = '' }) {
      const d = await discussion(kind, number);
      const text = clipBytes(`${header(a, tool)}\n\n${neutralize(body)}${verbatim ? '\n\n' + verbatim : ''}`, 12000);
      const result = await collaboration(db, env, person, 'CreateIssueComment', { repository: key, repositoryId: String(row.id), number, issueId: String(d.id), pullRequest: kind === 'pull_request',
        body: text, idempotencyKey: await stableKey(`${run.id}:comment:${kind}:${number}`) }, row, artifact);
      return result.comment.id;
    },
    async createIssue({ title, body, verbatim = '' }) {
      const clean = String(title).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 190) || a.name;
      const result = await collaboration(db, env, person, 'CreateIssue', { repository: key, repositoryId: String(row.id), title: clean,
        body: clipBytes(`${header(a, tool)}\n\n${neutralize(body)}${verbatim ? '\n\n' + verbatim : ''}`, 12000), idempotencyKey: await stableKey(`${run.id}:issue`) }, row, artifact);
      return result.mutation.number;
    },
    async addLabel(issue, labelId) {
      const current = issue.metadata.labels.map(label => label.id), next = [...new Set([...current, labelId])].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1);
      await collaboration(db, env, person, 'UpdateIssue', { repository: key, repositoryId: String(row.id), number: issue.number, issueId: issue.id, expectedRevision: issue.revision,
        labels: { expectedLabelIds: [...current].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1), labelIds: next }, idempotencyKey: await stableKey(`${run.id}:labels`) }, row, artifact);
    },
    async aiRun(kind, target, input) {
      if (input !== undefined) await db.prepare('UPDATE automation_runs SET input=?,updated_at=? WHERE id=?').bind(JSON.stringify(input), now(), run.id).run();
      return createAiRun(db, env, person, row, { kind, target, idempotencyKey: run.id });
    },
    async assignAgent({ kind, number, instructions }) {
      if (a.place !== 'agent-host') refuse(placeNotes[a.place] || 'Choose an agent host for this automation.');
      const { task } = await agentTasksAPI(db, env, person, row, null, { action: 'create', repository: key, repositoryId: String(row.id), target: { kind, number }, hostId: a.host_id, tool: a.engine,
        model: '', instructions: clipBytes(instructions, 4096), idempotencyKey: run.id }, () => deps.readRefs(row));
      return task;
    },
    taskSummary: task => parse(task.result, {}).summary || '',
    // The proposal branch of a finished task becomes a pull request: a draft, unless the automation allows landing and agentic mode is on.
    async openProposal(task, { title, body }) {
      const refs = await deps.readRefs(row), base = task.base_ref.slice(11);
      if (refs.get('refs/heads/' + task.branch) !== task.commit_id) refuse(`The proposal branch ${task.branch} no longer points at the agent's commit.`);
      if (!refs.get(task.base_ref)) refuse(`The base branch ${base} no longer exists.`);
      const ready = s.approvals.allowLanding && (await agenticSettings(db, row))?.enabled === true;
      const result = await collaboration(db, env, person, 'CreatePullRequest', { repository: key, repositoryId: String(row.id), sourceRepositoryId: String(row.id), sourceRepository: key,
        title: String(title).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 190) || 'Draft from an automation', body: clipBytes(`${header(a, tool)}\n\n${neutralize(body)}`, 12000),
        baseBranch: base, headBranch: task.branch, baseCommitId: refs.get(task.base_ref), headCommitId: task.commit_id, draft: !ready, agentTaskId: task.id,
        idempotencyKey: await stableKey(`${run.id}:pull`) }, row, artifact);
      return result.mutation.number;
    },
    // Possible duplicates from the repository's semantic index, read as the acting person; null when search is not available.
    async similarIssues(text, exclude) {
      if (searchUnallocated(env) || await featureOff(db, env, row, 'semantic-search')) return null;
      try {
        const query = String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
        if (query.length < 2) return [];
        const response = await searchAPI(db, env, person, row, artifact, { action: 'query', query }, deps.readTree), value = await response.json();
        if (!response.ok || !value.index?.served) return null;
        const seen = new Set();
        return value.results.filter(item => item.kind === 'issue' && item.number !== exclude && item.score >= 0.82 && !seen.has(item.number) && seen.add(item.number)).slice(0, 3).map(item => ({ number: item.number, title: item.title, score: item.score }));
      } catch { return null; }
    },
    // A failed Actions run and the masked tail of each failed job's log (stored masked; Golf credentials masked again here).
    async pipelineFailure(runId) {
      const pipeline = await db.prepare('SELECT * FROM pipeline_runs WHERE id=? AND repository_id=?').bind(runId, row.id).first();
      if (!pipeline) return null;
      const { results } = await db.prepare("SELECT * FROM pipeline_jobs WHERE run_id=? AND attempt=? AND state='FAILURE' ORDER BY id LIMIT 3").bind(pipeline.id, pipeline.attempt).all();
      const jobs = [];
      for (const job of results) {
        let log = '';
        try { log = scrub(tailBytes((await readJobLog(db, env, job, { fromLine: Math.max(0, job.log_lines - 80), limit: 64 * 1024 })).text, 1200)); } catch { log = ''; }
        jobs.push({ name: job.name, reason: job.failure_reason || '', log });
      }
      return { run: pipeline, jobs };
    },
    async openPulls(limit) {
      const { results } = await db.prepare("SELECT d.number,p.head_branch FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.state='OPEN' ORDER BY d.number DESC LIMIT ?").bind(row.id, limit).all();
      const refs = results.length ? await deps.readRefs(row) : new Map();
      return results.map(pull => ({ number: pull.number, headCommit: refs.get('refs/heads/' + pull.head_branch) || '' })).filter(pull => pull.headCommit);
    },
    // The newest open pull request whose head is this branch of the repository, or null.
    async openPullForBranch(branch) {
      return (await db.prepare("SELECT d.number FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.state='OPEN' AND p.head_branch=? ORDER BY d.number DESC LIMIT 1").bind(row.id, branch).first())?.number ?? null;
    },
    async unlabelledIssues(limit) {
      return (await db.prepare("SELECT d.number FROM discussions d WHERE d.repository_id=? AND d.kind='issue' AND d.state='OPEN' AND NOT EXISTS(SELECT 1 FROM discussion_labels l WHERE l.discussion_id=d.id) ORDER BY d.number DESC LIMIT ?").bind(row.id, limit).all()).results;
    },
    async openWork(limit) {
      const list = kind => db.prepare("SELECT number,title FROM discussions WHERE repository_id=? AND kind=? AND state='OPEN' ORDER BY number DESC LIMIT ?").bind(row.id, kind, limit).all();
      return { issues: (await list('issue')).results, pulls: (await list('pull')).results };
    },
    // A scheduled run queues one run per item; the item's own key dedupes it against event runs.
    async enqueue({ trigger, kind, number, commit, key: part }) {
      const window = s.limits.dedupeWindow;
      return Boolean(await insertRun(db, a, row.id, { type: trigger, kind, number, headCommit: commit }, `${a.id}:${part}${window ? ':' + Math.floor(Date.now() / (window * 60_000)) : ''}`));
    },
  };
  return ctx;
}

// Paths filter: the files a pull request or push changes must match one pattern. Other events have no paths.
async function pathsMatch(ctx, paths) {
  if (!paths.length || !['pull_request', 'commit'].includes(ctx.run.target_kind)) return true;
  let files;
  if (ctx.run.target_kind === 'pull_request') {
    const pull = await ctx.pull(ctx.run.target_number);
    files = await ctx.artifact(async repo => changedFiles(repo, (await comparison(repo, pull.base.commitId, pull.head.commitId)).mergeBase, pull.head.commitId));
  } else {
    const before = ctx.event.before && !/^0+$/.test(ctx.event.before) ? ctx.event.before : null;
    files = await ctx.artifact(repo => changedFiles(repo, before, ctx.run.target_commit));
  }
  return files.some(file => paths.some(pattern => globMatch(pattern, file.path || file.file || file)));
}

async function startRun(db, env, deps, run) {
  const a = await db.prepare('SELECT * FROM automations WHERE id=?').bind(run.automation_id).first(), tool = a && automationTools[a.tool];
  if (!a || a.deleted || !tool) return finishRun(db, run, 'SKIPPED', 'The automation was deleted.');
  if (a.kill_switch) return finishRun(db, run, 'SKIPPED', 'The kill switch is engaged.');
  if (!a.enabled && run.trigger !== 'manual') return finishRun(db, run, 'SKIPPED', 'The automation is turned off.');
  const actorId = run.requested_by || a.owner_id, person = await actorOf(db, actorId), row = person && await repositoryFor(db, env, run.repository_id, actorId);
  if (!person) return finishRun(db, run, 'REFUSED', 'The account this automation acts as is no longer active.');
  if (!row) return finishRun(db, run, 'REFUSED', `${person.login} no longer has access to this repository, and this automation acts as ${person.login}.`);
  const off = await featureOff(db, env, row, 'automations');
  if (off) return finishRun(db, run, 'REFUSED', off.reason);
  const s = stored(a), today = now().slice(0, 10);
  if ((await db.prepare('SELECT count(*) AS n FROM automation_runs WHERE automation_id=? AND started_at>=?').bind(a.id, today).first()).n >= s.limits.perDay)
    return finishRun(db, run, 'SKIPPED', `The daily budget of ${s.limits.perDay} run${s.limits.perDay === 1 ? '' : 's'} is used.`);
  // Concurrency: the run waits in the queue for a later pass.
  if ((await db.prepare("SELECT count(*) AS n FROM automation_runs WHERE automation_id=? AND state='RUNNING'").bind(a.id).first()).n >= s.limits.concurrency) return 'DEFERRED';
  if (s.output.includes('draft-pr')) {
    const open = await db.prepare(`SELECT count(*) AS n FROM automation_runs r JOIN discussions d ON d.repository_id=r.repository_id AND d.kind='pull' AND d.number=json_extract(r.outputs,'$.pullNumber')
      WHERE r.automation_id=? AND d.state='OPEN'`).bind(a.id).first();
    if (open.n >= s.limits.maxOpenPRs) return finishRun(db, run, 'SKIPPED', `${open.n} draft pull request${open.n === 1 ? '' : 's'} from this automation ${open.n === 1 ? 'is' : 'are'} open (limit ${s.limits.maxOpenPRs}).`);
  }
  const time = now();
  if ((await db.prepare("UPDATE automation_runs SET state='RUNNING',phase='start',engine=?,place=?,instructions_version=?,started_at=?,updated_at=? WHERE id=? AND state='QUEUED'")
    .bind(a.engine, a.place, a.instructions_version, time, time, run.id).run()).meta.changes !== 1) return 'RACED';
  run = { ...run, state: 'RUNNING', phase: 'start' };
  const ctx = runContext(db, env, deps, a, run, person, row);
  ctx.instructions = (await db.prepare('SELECT text FROM automation_instructions WHERE automation_id=? AND version=?').bind(a.id, a.instructions_version).first())?.text ?? '';
  let result;
  try {
    if (!await pathsMatch(ctx, s.target.paths)) return finishRun(db, run, 'SKIPPED', 'No changed file matches the path patterns.');
    // A whole-repository run (a schedule, or Run now on a repository) plans its own items; custom automations run on it directly.
    if (run.target_kind === 'repository') {
      const planned = tool.scheduled ? await tool.scheduled(ctx) : { reason: `${tool.label} has nothing to do for a whole repository.` };
      if (!planned.run) return finishRun(db, run, 'SUCCEEDED', planned.reason);
    }
    result = await tool.start(ctx);
  } catch (error) {
    if (!(error instanceof Fault)) console.log(JSON.stringify({ event: 'golf.automation_start_failed', tool: a.tool, message: String(error?.message || error).slice(0, 200) }));
    return finishRun(db, run, error instanceof Fault && [403, 404, 412].includes(error.status) ? 'REFUSED' : 'FAILED', failure(error, 'The run could not start'));
  }
  const outputs = { ...(result.outputs || {}) };
  if (result.skip) return finishRun(db, run, 'SKIPPED', result.skip, { outputs });
  if (result.refuse) return finishRun(db, run, 'REFUSED', result.refuse, { outputs });
  if (result.wait === 'ai') {
    outputs.aiRunId = result.aiRun.id;
    if (['REFUSED', 'UNKNOWN'].includes(result.aiRun.state)) return finishRun(db, run, 'FAILED', result.aiRun.refusal || 'The AI run could not start.', { outputs });
    await db.prepare("UPDATE automation_runs SET phase='wait-ai',outputs=?,updated_at=? WHERE id=? AND state='RUNNING'").bind(JSON.stringify(outputs), now(), run.id).run();
    return 'RUNNING';
  }
  if (result.wait === 'task') {
    outputs.agentTaskId = result.task.id;
    await db.prepare("UPDATE automation_runs SET phase='wait-task',outputs=?,updated_at=? WHERE id=? AND state='RUNNING'").bind(JSON.stringify(outputs), now(), run.id).run();
    return 'RUNNING';
  }
  if (result.infer) {
    const input = JSON.stringify(result.infer);
    if (byteLength(input) > 128 * 1024) return finishRun(db, run, 'FAILED', 'The engine input exceeds 128 KiB.');
    await db.prepare("UPDATE automation_runs SET phase='infer',input=?,outputs=?,updated_at=? WHERE id=? AND state='RUNNING'").bind(input, JSON.stringify(outputs), now(), run.id).run();
    return 'INFER';
  }
  return finishRun(db, run, 'SUCCEEDED', result.reason || 'Done.', { outputs });
}

// A run whose work finished elsewhere (an AI run, an agent task, an engine answer) applies it now, as its person holds the repository now.
async function advanceRun(db, env, deps, run) {
  const outputs = parse(run.outputs, {});
  let result, usage;
  if (run.phase === 'wait-ai') {
    const ai = outputs.aiRunId && await db.prepare('SELECT state,output,usage,refusal FROM ai_runs WHERE id=?').bind(outputs.aiRunId).first();
    if (!ai) return finishRun(db, run, 'FAILED', 'The AI run is missing.');
    if (['REFUSED', 'UNKNOWN'].includes(ai.state)) return finishRun(db, run, 'FAILED', ai.refusal || 'The AI run’s outcome is unknown; nothing was applied.');
    if (ai.state !== 'SUCCEEDED') return 'WAITING';
    result = { output: JSON.parse(ai.output) }; usage = usageOf(parse(ai.usage, {}));
  } else if (run.phase === 'wait-task') {
    const task = outputs.agentTaskId && await db.prepare('SELECT * FROM agent_tasks WHERE id=?').bind(outputs.agentTaskId).first();
    if (!task) return finishRun(db, run, 'FAILED', 'The agent task is missing.');
    if (!terminalStates.includes(task.state)) return 'WAITING';
    result = { task }; usage = usageOf(parse(task.result, {}).usage);
  } else if (run.phase === 'apply') {
    if (!outputs.engineOutput) return finishRun(db, run, 'FAILED', 'The engine answer is missing.');
    result = { output: outputs.engineOutput }; usage = parse(run.usage, {});
  } else return 'WAITING';
  const a = await db.prepare('SELECT * FROM automations WHERE id=?').bind(run.automation_id).first(), tool = a && automationTools[a.tool];
  if (!a || a.deleted || a.kill_switch) return finishRun(db, run, 'SKIPPED', a?.kill_switch ? 'The kill switch was engaged; the result was discarded.' : 'The automation was deleted; the result was discarded.', { usage });
  const actorId = run.requested_by || a.owner_id, person = await actorOf(db, actorId), row = person && await repositoryFor(db, env, run.repository_id, actorId);
  if (!row) return finishRun(db, run, 'REFUSED', 'The person this automation acts as lost access to this repository; the result was discarded.', { usage });
  const off = await featureOff(db, env, row, 'automations');
  if (off) return finishRun(db, run, 'REFUSED', off.reason + ' The result was discarded.', { usage });
  // Claim the apply step so that a retried pass does not post twice; operation keys make each write idempotent besides.
  if ((await db.prepare("UPDATE automation_runs SET phase='applying',updated_at=? WHERE id=? AND state='RUNNING' AND phase=?").bind(now(), run.id, run.phase).run()).meta.changes !== 1) return 'RACED';
  const ctx = runContext(db, env, deps, a, run, person, row);
  try {
    const applied = await tool.apply(ctx, result);
    if (applied.failed) return finishRun(db, run, 'FAILED', applied.failed, { outputs: applied.outputs, usage });
    return finishRun(db, run, 'SUCCEEDED', applied.reason || 'Done.', { outputs: applied.outputs, usage });
  } catch (error) {
    if (!(error instanceof Fault)) console.log(JSON.stringify({ event: 'golf.automation_apply_failed', tool: a.tool, message: String(error?.message || error).slice(0, 200) }));
    return finishRun(db, run, 'FAILED', failure(error, 'The result could not be applied'), { usage });
  }
}

// One pass in the workspace queue: start queued runs (oldest first) and apply finished work. Returns how many runs need an engine call.
export async function processAutomations(env, deps) {
  const db = env.DB.withSession('first-primary');
  if (!await automationSchema(db)) return { started: 0, advanced: 0, infer: 0 };
  let started = 0, advanced = 0;
  const repositories = new Set();
  const { results: queued } = await db.prepare("SELECT * FROM automation_runs WHERE state='QUEUED' ORDER BY created_at,rowid LIMIT ?").bind(automationBounds.startPerPass).all();
  for (const run of queued) if (!['DEFERRED', 'RACED'].includes(await startRun(db, env, deps, run))) { started++; repositories.add(run.repository_id); }
  const { results: waiting } = await db.prepare("SELECT * FROM automation_runs WHERE state='RUNNING' AND phase IN ('wait-ai','wait-task','apply') ORDER BY updated_at,rowid LIMIT ?").bind(automationBounds.advancePerPass).all();
  for (const run of waiting) if (!['WAITING', 'RACED'].includes(await advanceRun(db, env, deps, run))) { advanced++; repositories.add(run.repository_id); }
  const infer = (await db.prepare("SELECT count(*) AS n FROM automation_runs WHERE state='RUNNING' AND phase='infer'").first()).n;
  // The repositories whose pages may show something new (a comment, labels, a draft pull request, a run's state).
  return { started, advanced, infer, repositories: [...repositories].filter(Boolean) };
}

// Outside the queue: one engine call per run on a registry engine; the answer is stored and applied by the next pass.
export async function inferAutomationRuns(env) {
  const db = env.DB.withSession('first-primary');
  if (!await automationSchema(db)) return { inferred: 0 };
  const { results } = await db.prepare(`SELECT r.*,a.tool,a.engine AS automation_engine,a.owner_id FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.state='RUNNING' AND r.phase='infer' ORDER BY r.updated_at LIMIT ?`).bind(automationBounds.inferPerPass).all();
  let inferred = 0;
  for (const run of results) {
    if ((await db.prepare("UPDATE automation_runs SET phase='inferring',updated_at=? WHERE id=? AND state='RUNNING' AND phase='infer'").bind(now(), run.id).run()).meta.changes !== 1) continue;
    const tool = automationTools[run.tool];
    try {
      const input = JSON.parse(run.input), actorId = run.requested_by || run.owner_id, person = await actorOf(db, actorId);
      const repository = await db.prepare(`SELECT r.*,${ownerColumns} FROM repositories r ${ownerJoin} WHERE r.id=?`).bind(run.repository_id).first();
      if (!person || !repository) throw new Fault('failed_precondition', 412, 'The person or repository of this run is no longer available.');
      const { messages, options } = tool.engineRequest(input);
      const answer = await engineChat(db, env, { person, repository, useCase: tool.useCase, engine: run.engine || run.automation_engine }, messages, options);
      const output = tool.engineParse(answer.text, input), outputs = { ...parse(run.outputs, {}), engineOutput: output };
      if (byteLength(JSON.stringify(outputs)) > 64 * 1024) throw Error('The engine answer exceeds 64 KiB.');
      await db.prepare("UPDATE automation_runs SET phase='apply',input=NULL,outputs=?,usage=?,updated_at=? WHERE id=? AND state='RUNNING' AND phase='inferring'").bind(JSON.stringify(outputs), JSON.stringify(answer.usage || {}), now(), run.id).run();
      inferred++;
    } catch (error) {
      await finishRun(db, run, 'FAILED', failure(error, 'The engine call failed'));
    }
  }
  return { inferred };
}
