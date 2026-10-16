// Contribution graphs and AI impact (docs/AGENTS_AND_AUTOMATIONS_PLAN.md, "Contribution graphs and AI impact", CG-1 and CG-2).
// Counts, not claims: every number here is something Golf recorded happening. Nothing estimates time saved or productivity.
//
// Writes. Every contribution enters the contribution_events ledger under a key naming its source, then the daily rollup in the same
// batch, so a retried write or a repeated sweep counts nothing twice. Three kinds of writer feed it:
//  - at the event: after a collaboration mutation or a merge (recordDiscussion), when an agent task finishes (recordAgentTask), and
//    after a confirmed write to a default branch (recordRefWrite, which only marks the repository's Git walk as due);
//  - the maintenance sweep (sweepContributions), which reads discussion events, finished agent tasks and agent proposals since its
//    cursor with the same keys, so anything a writer missed (a landing by policy, a merge settled later) is counted once;
//  - the Git walk, which reads first-parent history of each default branch through Artifacts in bounded, resumable batches.
// Reads. A viewer sees counts only for repositories they can read; a person may show the rest as anonymous counts. The AI impact page
// is for operations administrators and holds installation-wide anonymous aggregates only: no repository or person names.
import { Fault, reply, invalid } from './common.mjs';
import { ownerJoin, ownerColumns, ownerSlug } from './owners.mjs';
import { featureColumns, publicAllowed, effectiveFeatures } from './feature-policy.mjs';
import { operationsAdmin } from './operations.mjs';
import { sha } from './git.mjs';

export const contributionKinds = ['commit', 'pull_opened', 'pull_merged', 'review', 'issue_opened', 'issue_closed', 'comment', 'proposal_created', 'proposal_accepted'];
// 'token': done through an API token (an agent or automation outside Golf; Golf reports the token, not what was behind it).
export const aiTiers = ['agent', 'token', 'assisted', 'declared', 'none'];
// Per maintenance pass: rows read from each D1 source, repositories walked and commits read from each, Artifacts commit reads outside
// the batched log, and repositories enrolled for their first walk.
export const contributionLimits = { events: 500, tasks: 200, evidence: 200, repositories: 3, commits: 200, reads: 40, enroll: 20 };
// Rows younger than this are left to their writers and the next pass, so a batch that commits a moment late is not skipped.
const lagMs = 120_000;
// Evidence agent proposals finish within minutes; one an hour old that has not succeeded is not counted.
const evidenceLagMs = 3600_000;
const dayMs = 86400_000;
const agenticEmail = 'agentic@golf.invalid';
const iso = time => new Date(time).toISOString();
const dayOf = time => iso(time).slice(0, 10);
const dayOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// ---------- attribution ----------
// A Co-Authored-By trailer naming a known AI tool: declared by the author, shown separately, never counted as verified.
const aiNames = /\b(claude|copilot|codex|chatgpt|gemini|aider|devin|grok|opencode|windsurf|codeium|cursor ?agent)\b/i;
const aiDomains = /@(?:[a-z0-9-]+\.)*(?:anthropic\.com|openai\.com|cursor\.com|cursor\.sh|x\.ai|aider\.chat|cognition\.ai|devin\.ai|codeium\.com|windsurf\.com|opencode\.ai)>?\s*$/i;
export function declaredAI(message) {
  for (const line of String(message || '').split('\n')) {
    const trailer = /^co-authored-by:\s*(.+)$/i.exec(line.trim());
    if (trailer && (aiNames.test(trailer[1]) || aiDomains.test(trailer[1]) || /copilot@users\.noreply\.github\.com/i.test(trailer[1]))) return true;
  }
  return false;
}

// ---------- the ledger ----------
const insertEvents = 'INSERT OR IGNORE INTO contribution_events(key,day,actor_id,repository_id,kind,ai_tier,pending)';
// New ledger rows (pending=1) are added to the rollup, merges mark their repository's Git walk as due, and pending is cleared: one batch.
function settle(db, time) {
  return [
    db.prepare(`INSERT INTO contribution_days(actor_id,day,repository_id,kind,ai_tier,count)
      SELECT actor_id,day,repository_id,kind,ai_tier,count(*) FROM contribution_events WHERE pending=1 AND actor_id>=0 GROUP BY actor_id,day,repository_id,kind,ai_tier
      ON CONFLICT(actor_id,day,repository_id,kind,ai_tier) DO UPDATE SET count=count+excluded.count`),
    db.prepare(`INSERT INTO contribution_git(repository_id,pending,updated_at) SELECT DISTINCT repository_id,1,? FROM contribution_events WHERE pending=1 AND kind='pull_merged'
      ON CONFLICT(repository_id) DO UPDATE SET pending=1`).bind(time),
    db.prepare('UPDATE contribution_events SET pending=0 WHERE pending=1'),
  ];
}
// Discussion events: issues and pull requests opened, issues closed, comments, reviews and merges. A pull request opened from an agent
// task is Golf's (agent) and one opened through an API token is the token tier; a merge of either by a person is AI-assisted, and a
// merge by the agentic mode policy is Golf's.
const policyLanded = "EXISTS(SELECT 1 FROM land_operations l WHERE l.pull_request_id=p.id AND l.trigger='policy' AND l.state IN ('LANDED','REVERTED'))";
const discussionSource = `FROM discussion_events e JOIN discussions d ON d.id=e.discussion_id LEFT JOIN pull_requests p ON p.discussion_id=d.id
  LEFT JOIN pull_request_origins o ON o.pull_request_id=p.id`;
const discussionEvents = where => `${insertEvents} SELECT key,day,actor_id,repository_id,kind,ai_tier,1 FROM (
    SELECT CASE e.kind WHEN 'opened' THEN 'opened:'||d.id WHEN 'merge_pull' THEN 'merged:'||d.id ELSE 'event:'||e.id END AS key,
      substr(e.created_at,1,10) AS day,e.actor_id,d.repository_id,
      CASE WHEN e.kind='opened' THEN CASE d.kind WHEN 'issue' THEN 'issue_opened' ELSE 'pull_opened' END
        WHEN e.kind='close' AND d.kind='issue' THEN 'issue_closed' WHEN e.kind='comment' THEN 'comment'
        WHEN e.kind IN ('review_approved','review_comment','review_request_changes') THEN 'review' WHEN e.kind='merge_pull' THEN 'pull_merged' END AS kind,
      CASE WHEN d.kind!='pull' THEN 'none' WHEN e.kind='merge_pull' AND ${policyLanded} THEN 'agent' WHEN e.kind='merge_pull' AND o.kind IN ('agent-task','api-token') THEN 'assisted'
        WHEN e.kind='opened' AND o.kind='agent-task' THEN 'agent' WHEN e.kind='opened' AND o.kind='api-token' THEN 'token' ELSE 'none' END AS ai_tier
    ${discussionSource} WHERE ${where})
  WHERE kind IS NOT NULL AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
// An agent task's proposal merged: accepted, by a person (assisted) or by the policy (agent).
const acceptedProposals = where => `${insertEvents} SELECT 'accepted:'||d.id,substr(e.created_at,1,10),e.actor_id,d.repository_id,'proposal_accepted',
    CASE WHEN ${policyLanded} THEN 'agent' ELSE 'assisted' END,1
  ${discussionSource} WHERE e.kind='merge_pull' AND o.kind='agent-task' AND substr(e.created_at,1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ${where}`;
// A finished agent task: a review task is a review by Golf's agent, any other with a commit is a proposal; requested_by ran it.
const agentTasks = where => `${insertEvents} SELECT 'task:'||t.id,substr(t.finished_at,1,10),t.requested_by,t.repository_id,
    CASE WHEN EXISTS(SELECT 1 FROM agent_task_reviews r WHERE r.task_id=t.id) THEN 'review' ELSE 'proposal_created' END,'agent',1
  FROM agent_tasks t WHERE t.state='SUCCEEDED' AND t.finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
    AND (t.commit_id!='' OR EXISTS(SELECT 1 FROM agent_task_reviews r WHERE r.task_id=t.id)) AND ${where}`;
const evidenceProposals = where => `${insertEvents} SELECT 'evidence:'||j.id,substr(j.created_at,1,10),j.user_id,j.repository_id,'proposal_created','agent',1
  FROM evidence_jobs j WHERE j.agent_state='succeeded' AND j.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND ${where}`;

async function ledger(db, statements, time = iso(Date.now())) {
  return db.batch([...statements, ...settle(db, time)]);
}
// Writers on request paths never fail the request: without the migration, or on any error, the sweep counts it later.
async function quietly(env, work) {
  const run = work().catch(error => console.log(JSON.stringify({ event: 'golf.contribution_write_failed', message: String(error?.message || error).slice(0, 160) })));
  if (env?.waitUntil) env.waitUntil(run); else await run;
}

// After a collaboration mutation or a merge: the last day of events on that issue or pull request. Cheap (one discussion's events,
// by index) and idempotent; called in the Workspace after the response is decided.
export function recordDiscussion(db, env, repositoryId, number) {
  if (!Number.isSafeInteger(Number(repositoryId)) || !Number.isInteger(number) || number < 1) return Promise.resolve();
  return quietly(env, () => {
    const where = 'e.discussion_id=(SELECT id FROM discussions WHERE repository_id=? AND number=?) AND e.created_at>=?', since = iso(Date.now() - dayMs);
    return ledger(db, [db.prepare(discussionEvents(where)).bind(Number(repositoryId), number, since), db.prepare(acceptedProposals(where)).bind(Number(repositoryId), number, since)]);
  });
}
// When an agent task finishes.
export function recordAgentTask(db, env, taskId) {
  if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/.test(taskId)) return Promise.resolve();
  return quietly(env, () => ledger(db, [db.prepare(agentTasks('t.id=?')).bind(taskId)]));
}
// After a confirmed ref write (push, Source API commit or branch, agent task push, maintenance settlement): a write to the default branch
// marks the repository's Git walk as due. One small upsert; the commits are read later, in the maintenance stage.
export async function recordRefWrite(db, operationId) {
  try {
    await db.prepare(`INSERT INTO contribution_git(repository_id,pending,updated_at)
      SELECT g.repository_id,1,? FROM git_operations g JOIN repositories r ON r.id=g.repository_id WHERE g.id=? AND g.state='APPLIED' AND g.ref='refs/heads/'||r.default_branch
      ON CONFLICT(repository_id) DO UPDATE SET pending=1`).bind(iso(Date.now()), operationId).run();
  } catch { /* Without schema 53 nothing is counted; the daily check finds the branch moved. */ }
}

// ---------- the maintenance sweep ----------
async function cursor(db, source) {
  const row = await db.prepare('SELECT position FROM contribution_cursors WHERE source=?').bind(source).first();
  try { const [at, id] = JSON.parse(row?.position || '["",""]'); return { at: String(at), id: String(id) }; } catch { return { at: '', id: '' }; }
}
const moveCursor = (db, source, at, id, time) => db.prepare(`INSERT INTO contribution_cursors(source,position,updated_at) VALUES(?,?,?)
  ON CONFLICT(source) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`).bind(source, JSON.stringify([at, id]), time);

// One keyset page of a D1 source: rows after the cursor and older than the lag, the page's last (time, id), then one ledger batch for
// exactly that page with the cursor moved in the same batch.
async function sweepSource(db, { source, table, alias, time, id, limit, before, write }) {
  const position = await cursor(db, source), now = iso(Date.now());
  const after = `(${alias}.${time}>? OR ${alias}.${time}=? AND ${alias}.${id}>?) AND ${alias}.${time}<?`;
  const { results } = await db.prepare(`SELECT ${alias}.${time} AS at,${alias}.${id} AS id FROM ${table} ${alias} WHERE ${after} AND ${alias}.${time} IS NOT NULL
    ORDER BY ${alias}.${time},${alias}.${id} LIMIT ?`).bind(position.at, position.at, position.id, before, limit).all();
  if (!results.length) return 0;
  const last = results.at(-1), lastAt = String(last.at), lastId = String(last.id);
  const page = `${after} AND (${alias}.${time}<? OR ${alias}.${time}=? AND ${alias}.${id}<=?)`, values = [position.at, position.at, position.id, before, lastAt, lastAt, lastId];
  await ledger(db, [...write(page, values), moveCursor(db, source, lastAt, lastId, now)], now);
  return results.length;
}

// Maintenance (the read-index stage): D1 sources, then Git walks. Paced: a new installation fills in over a few cycles.
export async function sweepContributions(env, withArtifact, limits = contributionLimits) {
  const db = env.DB.withSession('first-primary');
  if (!(await db.prepare('PRAGMA table_info(contribution_days)').all()).results.length) return { processed: 0 };
  const now = Date.now(), before = iso(now - lagMs);
  let processed = 0;
  processed += await sweepSource(db, { source: 'discussion-events', table: 'discussion_events', alias: 'e', time: 'created_at', id: 'id', limit: limits.events, before,
    write: (where, values) => [db.prepare(discussionEvents(where)).bind(...values), db.prepare(acceptedProposals(where)).bind(...values)] });
  processed += await sweepSource(db, { source: 'agent-tasks', table: 'agent_tasks', alias: 't', time: 'finished_at', id: 'id', limit: limits.tasks, before,
    write: (where, values) => [db.prepare(agentTasks(where)).bind(...values)] });
  processed += await sweepSource(db, { source: 'evidence-proposals', table: 'evidence_jobs', alias: 'j', time: 'created_at', id: 'id', limit: limits.evidence, before: iso(now - evidenceLagMs),
    write: (where, values) => [db.prepare(evidenceProposals(where)).bind(...values)] });
  processed += await walkRepositories(env, db, withArtifact, limits);
  return { processed };
}

// ---------- Git history ----------
// Enrol repositories without a walk (their whole history is due), and re-check each walked repository daily in case a signal was lost.
async function walkRepositories(env, db, withArtifact, limits) {
  const time = iso(Date.now());
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO contribution_git(repository_id,pending,updated_at) SELECT r.id,1,? FROM repositories r WHERE r.state='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM contribution_git c WHERE c.repository_id=r.id) ORDER BY r.id LIMIT ?`).bind(time, limits.enroll),
    db.prepare(`UPDATE contribution_git SET pending=1 WHERE pending=0 AND next_commit='' AND (checked_at IS NULL OR checked_at<?)`).bind(iso(Date.now() - dayMs)),
  ]);
  const { results } = await db.prepare(`SELECT c.repository_id,c.next_commit,c.pending,r.id,r.name,r.artifact_name,r.default_branch FROM contribution_git c JOIN repositories r ON r.id=c.repository_id
    WHERE r.state='ACTIVE' AND (c.next_commit!='' OR c.pending=1) ORDER BY c.updated_at,c.repository_id LIMIT ?`).bind(limits.repositories).all();
  let processed = 0;
  for (const row of results) {
    try { processed += await walk(env, db, withArtifact, row, limits); }
    catch (error) {
      console.log(JSON.stringify({ event: 'golf.contribution_walk_failed', repository: String(row.id), message: String(error?.message || error).slice(0, 160) }));
      // Still due (a walk from the tip cleared its signal before reading), after other repositories.
      await db.prepare("UPDATE contribution_git SET pending=CASE WHEN next_commit='' THEN 1 ELSE pending END,updated_at=? WHERE repository_id=?").bind(iso(Date.now()), row.id).run();
    }
  }
  return processed;
}

// One bounded step of one repository's walk: from where it stopped, or from the tip when the branch moved, along first parents, until a
// commit already counted, the root, or the batch bound. The walk position and the counts commit together.
async function walk(env, db, withArtifact, row, limits) {
  const time = iso(Date.now()), fresh = !row.next_commit;
  // Clear the signal before reading the tip: a push after this read sets it again and gets its own walk.
  if (fresh) await db.prepare('UPDATE contribution_git SET pending=0,checked_at=? WHERE repository_id=?').bind(time, row.id).run();
  const { chain, next } = await withArtifact(env, row, async repo => {
    // A walk from the tip reads a short page first: usually only a few commits are new. A longer history continues next pass in full batches.
    const start = fresh ? row.default_branch : row.next_commit, bound = fresh ? Math.min(20, limits.commits) : limits.commits;
    // An empty repository logs nothing; a provider failure throws and leaves the walk due.
    const history = await repo.log({ ref: start, limit: bound + 1 });
    const known = new Map((Array.isArray(history) ? history : []).filter(commit => sha(commit?.hash)).map(commit => [commit.hash, commit]));
    const chain = [], seen = new Set();
    let at = fresh ? history?.[0]?.hash : row.next_commit, reads = 0;
    while (sha(at) && chain.length < bound && !seen.has(at)) {
      let commit = known.get(at);
      if (!commit) { if (reads >= limits.reads) break; reads++; commit = await repo.readCommit(at); }
      if (!commit || commit.hash !== at || !Array.isArray(commit.parents)) break;
      seen.add(at); chain.push(commit); at = commit.parents[0];
    }
    return { chain, next: sha(at) ? at : '' };
  });
  // Stop at the first commit already counted: the rest of the history is too.
  const keys = chain.map(commit => `commit:${row.id}:${commit.hash}`), counted = new Set();
  for (let offset = 0; offset < keys.length; offset += 90) {
    const part = keys.slice(offset, offset + 90);
    for (const found of (await db.prepare(`SELECT key FROM contribution_events WHERE key IN (${part.map(() => '?').join()})`).bind(...part).all()).results) counted.add(found.key);
  }
  const stop = keys.findIndex(key => counted.has(key)), uncounted = stop === -1 ? chain : chain.slice(0, stop);
  const rest = stop === -1 ? next : '';
  const events = await attribute(env, db, row, uncounted);
  const statements = [];
  for (let offset = 0; offset < events.length; offset += 14) {
    const part = events.slice(offset, offset + 14);
    statements.push(db.prepare(`${insertEvents} VALUES ${part.map(() => '(?,?,?,?,?,?,1)').join()}`).bind(...part.flatMap(event => [event.key, event.day, event.actor, row.id, 'commit', event.tier])));
  }
  statements.push(db.prepare('UPDATE contribution_git SET next_commit=?,walked=walked+?,updated_at=? WHERE repository_id=?').bind(rest, uncounted.length, time, row.id));
  await ledger(db, statements, time);
  return uncounted.length;
}

// Who wrote each commit and how AI was involved. The author email names the account (or Golf's own noreply address for its merges);
// Golf's agentic identity is Golf itself; a commit an agent task produced is Golf's agent; a pull request merge commit takes the merge's
// tier; a Co-Authored-By trailer naming an AI tool is declared.
async function attribute(env, db, row, commits) {
  if (!commits.length) return [];
  const host = new URL(env.PUBLIC_ORIGIN).hostname.toLowerCase(), emails = new Map(), logins = new Map(), agents = new Set(), merges = new Map();
  const email = commit => String(commit.author?.email || '').trim().toLowerCase();
  const noreply = value => value.endsWith(`@users.noreply.${host}`) ? value.slice(0, -`@users.noreply.${host}`.length) : '';
  const wanted = [...new Set(commits.map(email).filter(Boolean))], hashes = commits.map(commit => commit.hash);
  const chunks = (list, size = 90) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
  for (const part of chunks(wanted)) {
    for (const user of (await db.prepare(`SELECT id,lower(email) AS email FROM users WHERE active=1 AND lower(email) IN (${part.map(() => '?').join()})`).bind(...part).all()).results) emails.set(user.email, user.id);
  }
  const names = wanted.map(noreply).filter(Boolean);
  for (const part of chunks(names)) {
    for (const user of (await db.prepare(`SELECT id,login FROM users WHERE active=1 AND login IN (${part.map(() => '?').join()})`).bind(...part).all()).results) logins.set(user.login, user.id);
  }
  for (const part of chunks(hashes, 80)) {
    for (const task of (await db.prepare(`SELECT commit_id FROM agent_tasks WHERE repository_id=? AND commit_id IN (${part.map(() => '?').join()})`).bind(row.id, ...part).all()).results) agents.add(task.commit_id);
    for (const merge of (await db.prepare(`SELECT m.merge_commit_id,o.kind AS origin,${policyLanded} AS policy FROM pull_merge_operations m JOIN pull_requests p ON p.id=m.pull_request_id
        LEFT JOIN pull_request_origins o ON o.pull_request_id=p.id WHERE m.repository_id=? AND m.phase='SUCCEEDED' AND m.merge_commit_id IN (${part.map(() => '?').join()})`).bind(row.id, ...part).all()).results)
      merges.set(merge.merge_commit_id, merge.policy ? 'agent' : merge.origin === 'agent-task' || merge.origin === 'api-token' ? 'assisted' : '');
  }
  return commits.map(commit => {
    const address = email(commit), golf = address === agenticEmail;
    const actor = golf ? 0 : emails.get(address) ?? logins.get(noreply(address)) ?? -1;
    const tier = golf || agents.has(commit.hash) || merges.get(commit.hash) === 'agent' ? 'agent' : merges.get(commit.hash) === 'assisted' ? 'assisted' : declaredAI(commit.message) ? 'declared' : 'none';
    const seconds = Number.isSafeInteger(commit.authoredAt) ? commit.authoredAt : Number.isSafeInteger(commit.committedAt) ? commit.committedAt : Math.floor(Date.now() / 1000);
    return { key: `commit:${row.id}:${commit.hash}`, day: dayOf(seconds * 1000), actor, tier };
  });
}

// ---------- reads ----------
// The last 53 weeks (from the Sunday 52 weeks before this week's, through today), or one calendar year.
export function contributionRange(year, now = Date.now()) {
  const today = dayOf(now), current = new Date(now).getUTCFullYear();
  if (year !== undefined && year !== null) {
    if (!Number.isInteger(year) || year < 2005 || year > current) invalid('Choose a year from 2005 to this year.');
    return { from: `${year}-01-01`, to: year === current ? today : `${year}-12-31`, year };
  }
  const end = Date.parse(today + 'T00:00:00Z'), sunday = end - new Date(end).getUTCDay() * dayMs;
  return { from: dayOf(sunday - 52 * 7 * dayMs), to: today, year: null };
}
const nextDay = day => dayOf(Date.parse(day + 'T00:00:00Z') + dayMs);
async function installationOff(db) {
  try { return (await db.prepare("SELECT 1 AS off FROM feature_policies WHERE scope='installation' AND scope_id='' AND feature='contribution-graphs' AND mode='DISABLED'").first())?.off === 1; }
  catch { return false; }
}
const offView = { state: 'off', reason: 'Contribution graphs are turned off for every repository by the installation policy. The counts are kept; turning them back on shows them again.' };

// Each repository the viewer's counts touch: whether the viewer can read it, and whether its contribution-graphs feature is on.
async function repositoryAccess(db, env, viewer, ids) {
  const access = new Map(), list = [...ids];
  for (let offset = 0; offset < list.length; offset += 90) {
    const part = list.slice(offset, offset + 90);
    const { results } = await db.prepare(`SELECT r.id,r.name,r.state,${ownerColumns},(SELECT g.role FROM grants g WHERE g.repository_id=r.id AND g.user_id=?) AS role,
        COALESCE((SELECT v.is_public FROM repository_visibility v WHERE v.repository_id=r.id),0) AND ${publicAllowed} AS is_public,${featureColumns}
      FROM repositories r ${ownerJoin} WHERE r.id IN (${part.map(() => '?').join()})`).bind(viewer.id, ...part).all();
    for (const row of results) {
      const readable = row.state === 'ACTIVE' && Boolean(row.role || env.PUBLIC_REPOSITORIES === 'true' && row.is_public);
      access.set(row.id, { readable, enabled: effectiveFeatures(env, row).get('contribution-graphs')?.effective !== false, fullName: `${ownerSlug(row, env)}/${row.name}` });
    }
  }
  return access;
}
const emptyCounts = () => Object.fromEntries(contributionKinds.map(kind => [kind, 0]));
const emptyTiers = () => Object.fromEntries(aiTiers.map(tier => [tier, 0]));
// Streaks over days with human contributions: the longest in the range, and the current one ending today (or yesterday, before today's first).
function streaks(days, range) {
  const active = new Set(days.filter(day => day.human > 0).map(day => day.day));
  let longest = 0, run = 0;
  for (let at = Date.parse(range.from + 'T00:00:00Z'); at <= Date.parse(range.to + 'T00:00:00Z'); at += dayMs) { run = active.has(dayOf(at)) ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0, at = Date.parse(range.to + 'T00:00:00Z');
  if (!active.has(range.to)) at -= dayMs;
  while (at >= Date.parse(range.from + 'T00:00:00Z') && active.has(dayOf(at))) { current++; at -= dayMs; }
  return { longest, current };
}

async function personView(db, env, viewer, body) {
  if (typeof body.owner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(body.owner)) invalid('Name a person by their profile name.');
  const range = contributionRange(body.year);
  if (await installationOff(db)) return offView;
  const columns = 'u.id,u.login,COALESCE(p.full_name,u.full_name) AS full_name,s.show_private,s.version';
  const joins = 'LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN contribution_settings s ON s.user_id=u.id';
  const target = await db.prepare(`SELECT ${columns} FROM native_owners n JOIN users u ON u.id=n.user_id ${joins} WHERE n.slug=? AND n.kind='PERSONAL' AND u.active=1`).bind(body.owner).first()
    || await db.prepare(`SELECT ${columns} FROM users u ${joins} WHERE u.login=? AND u.active=1 AND NOT EXISTS(SELECT 1 FROM native_owners n WHERE n.slug=u.login AND n.kind='ORGANIZATION')`).bind(body.owner).first();
  if (!target) throw new Fault('not_found', 404, 'No person has this profile.');
  const self = target.id === viewer.id, showPrivate = target.show_private === 1;
  const [{ results: rows }, { results: yearRows }] = await Promise.all([
    db.prepare('SELECT day,repository_id,kind,ai_tier,count FROM contribution_days WHERE actor_id=? AND day>=? AND day<=?').bind(target.id, range.from, range.to).all(),
    db.prepare('SELECT substr(day,1,4) AS year,repository_id FROM contribution_days WHERE actor_id=? GROUP BY year,repository_id').bind(target.id).all(),
  ]);
  const access = await repositoryAccess(db, env, viewer, new Set([...rows, ...yearRows].map(row => row.repository_id)));
  // Readable repositories are named; the rest count anonymously for the person themself, or for visitors when the person chose to show them.
  const shown = id => { const repo = access.get(id); return !repo?.enabled ? null : repo.readable ? repo : self || showPrivate ? 'private' : null; };
  const days = new Map(), repositories = new Map(), totals = { human: 0, ai: 0, kinds: emptyCounts(), agentKinds: emptyCounts(), tiers: emptyTiers(), private: 0 };
  for (const row of rows) {
    const where = shown(row.repository_id);
    if (!where || !contributionKinds.includes(row.kind) || !aiTiers.includes(row.ai_tier) || !dayOK(row.day)) continue;
    const entry = days.get(row.day) || { day: row.day, human: 0, ai: 0, kinds: emptyCounts(), agentKinds: emptyCounts(), tiers: emptyTiers(), repositories: new Map(), private: 0 };
    // The person's own activity: everything but what Golf's agents or an API token did under their name.
    const human = row.ai_tier !== 'agent' && row.ai_tier !== 'token', count = row.count;
    entry.tiers[row.ai_tier] += count; totals.tiers[row.ai_tier] += count;
    if (human) { entry.human += count; entry.kinds[row.kind] += count; totals.human += count; totals.kinds[row.kind] += count; }
    else { entry.agentKinds[row.kind] += count; totals.agentKinds[row.kind] += count; }
    if (row.ai_tier !== 'none') { entry.ai += count; totals.ai += count; }
    if (where === 'private') { if (human) { entry.private += count; totals.private += count; } }
    else {
      const repo = entry.repositories.get(where.fullName) || { fullName: where.fullName, human: 0, ai: 0 };
      if (human) repo.human += count; if (row.ai_tier !== 'none') repo.ai += count;
      entry.repositories.set(where.fullName, repo);
      const sum = repositories.get(where.fullName) || { fullName: where.fullName, human: 0, ai: 0 };
      if (human) sum.human += count; if (row.ai_tier !== 'none') sum.ai += count;
      repositories.set(where.fullName, sum);
    }
    days.set(row.day, entry);
  }
  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(day => ({ ...day, repositories: [...day.repositories.values()].sort((a, b) => b.human - a.human || a.fullName.localeCompare(b.fullName)) }));
  const current = new Date().getUTCFullYear(), years = new Set([current]);
  for (const row of yearRows) if (shown(row.repository_id) && /^\d{4}$/.test(row.year)) years.add(Number(row.year));
  return { state: 'on', person: { login: target.login, name: target.full_name || '' }, range, years: [...years].sort((a, b) => b - a), days: list, totals,
    streaks: streaks(list, range), repositories: [...repositories.values()].sort((a, b) => b.human - a.human || a.fullName.localeCompare(b.fullName)).slice(0, 10),
    privateCounts: { included: self || showPrivate, human: totals.private },
    settings: self ? { showPrivate, version: target.version || 0, canEdit: true } : { showPrivate, canEdit: false } };
}

// Repositories whose contribution-graphs feature a policy turned off, excluded from installation aggregates.
async function excludedRepositories(db, env) {
  const { results } = await db.prepare(`SELECT r.id,${ownerColumns},${featureColumns} FROM repositories r ${ownerJoin} WHERE r.state='ACTIVE'`).all();
  return results.filter(row => effectiveFeatures(env, row).get('contribution-graphs')?.effective === false).map(row => row.id);
}
const tokens = column => `COALESCE(json_extract(${column},'$.total_tokens'),COALESCE(json_extract(${column},'$.input_tokens'),json_extract(${column},'$.prompt_tokens'),json_extract(${column},'$.inputTokens'),0)+COALESCE(json_extract(${column},'$.output_tokens'),json_extract(${column},'$.completion_tokens'),json_extract(${column},'$.outputTokens'),0))`;
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

async function impactView(db, env, body) {
  const range = contributionRange(body.year);
  if (await installationOff(db)) return offView;
  const excluded = await excludedRepositories(db, env);
  if (excluded.length > 90) return { state: 'unavailable', reason: 'More than 90 repositories have contribution graphs turned off, so installation aggregates cannot exclude them here.' };
  const scope = column => excluded.length ? ` AND ${column} NOT IN (${excluded.map(() => '?').join()})` : '';
  const start = range.from, end = nextDay(range.to), unreadable = [];
  const read = async (source, sql, values) => {
    try { return (await db.prepare(sql).bind(...values, ...excluded).all()).results; }
    catch { unreadable.push(source); return []; }
  };
  const [days, tasks, origins, evidence, advice, runs, landing, automations, merges] = await Promise.all([
    read('contributions', `SELECT day,kind,ai_tier,SUM(count) AS count FROM contribution_days WHERE day>=? AND day<=?${scope('repository_id')} GROUP BY day,kind,ai_tier`, [range.from, range.to]),
    read('agent-tasks', `SELECT CASE WHEN EXISTS(SELECT 1 FROM agent_task_reviews r WHERE r.task_id=t.id) THEN 'review' ELSE 'change' END AS purpose,t.tool,t.state,count(*) AS count,
        SUM(json_extract(t.result,'$.usage.costUsd') IS NOT NULL) AS costed,SUM(COALESCE(json_extract(t.result,'$.usage.costUsd'),0)) AS cost,
        SUM(json_extract(t.result,'$.usage.reported') IS NOT NULL) AS reported,SUM(${tokens("json_extract(t.result,'$.usage')")}) AS tokens
      FROM agent_tasks t WHERE t.created_at>=? AND t.created_at<?${scope('t.repository_id')} GROUP BY purpose,t.tool,t.state`, [start, end]),
    read('pull-request-origins', `SELECT o.kind,count(*) AS opened,SUM(EXISTS(SELECT 1 FROM pull_merge_operations m WHERE m.pull_request_id=o.pull_request_id AND m.phase='SUCCEEDED')) AS merged
      FROM pull_request_origins o JOIN pull_requests p ON p.id=o.pull_request_id JOIN discussions d ON d.id=p.discussion_id WHERE o.created_at>=? AND o.created_at<?${scope('d.repository_id')} GROUP BY o.kind`, [start, end]),
    read('evidence-proposals', `SELECT agent_state AS state,count(*) AS count,SUM(COALESCE(json_extract(agent_result,'$.tokens'),0)) AS tokens FROM evidence_jobs
      WHERE agent_state!='NONE' AND created_at>=? AND created_at<?${scope('repository_id')} GROUP BY agent_state`, [start, end]),
    read('review-advice', `SELECT advice_state AS state,count(*) AS count FROM evidence_jobs WHERE advice_state!='NONE' AND created_at>=? AND created_at<?${scope('repository_id')} GROUP BY advice_state`, [start, end]),
    read('ai-runs', `SELECT kind,state,count(*) AS count,SUM(${tokens('usage')}) AS tokens FROM ai_runs WHERE created_at>=? AND created_at<?${scope('repository_id')} GROUP BY kind,state`, [start, end]),
    read('land-operations', `SELECT trigger,state,count(*) AS count FROM land_operations WHERE created_at>=? AND created_at<?${scope('repository_id')} GROUP BY trigger,state`, [start, end]),
    read('automation-runs', `SELECT state,count(*) AS count,SUM(json_extract(usage,'$.costUsd') IS NOT NULL) AS costed,SUM(COALESCE(json_extract(usage,'$.costUsd'),0)) AS cost,SUM(${tokens('usage')}) AS tokens
      FROM automation_runs WHERE created_at>=? AND created_at<?${scope('COALESCE(repository_id,0)')} GROUP BY state`, [start, end]),
    read('merges', `SELECT d.created_at AS opened,m.updated_at AS merged,o.kind AS origin,${policyLanded} AS policy FROM pull_merge_operations m JOIN pull_requests p ON p.id=m.pull_request_id
      JOIN discussions d ON d.id=p.discussion_id LEFT JOIN pull_request_origins o ON o.pull_request_id=p.id WHERE m.phase='SUCCEEDED' AND m.updated_at>=? AND m.updated_at<?${scope('m.repository_id')} LIMIT 20000`, [start, end]),
  ]);
  const heat = new Map(), kinds = Object.fromEntries(contributionKinds.map(kind => [kind, emptyTiers()]));
  for (const row of days) {
    if (!dayOK(row.day) || !aiTiers.includes(row.ai_tier) || !contributionKinds.includes(row.kind)) continue;
    const entry = heat.get(row.day) || { day: row.day, ...emptyTiers() };
    entry[row.ai_tier] += row.count; heat.set(row.day, entry); kinds[row.kind][row.ai_tier] += row.count;
  }
  const sum = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
  const fromTasks = origins.find(row => row.kind === 'agent-task') || { opened: 0, merged: 0 };
  const hours = (row) => (Date.parse(row.merged) - Date.parse(row.opened)) / 3600_000;
  const timed = merges.filter(row => Number.isFinite(hours(row)) && hours(row) >= 0);
  const group = rows => ({ count: rows.length, medianHours: median(rows.map(hours)) });
  const involved = row => row.policy || row.origin === 'agent-task' || row.origin === 'api-token';
  const costRows = [...tasks, ...automations];
  return { state: 'on', range, generatedAt: iso(Date.now()), unreadable, excludedRepositories: excluded.length,
    heatmap: [...heat.values()].sort((a, b) => a.day.localeCompare(b.day)), kinds,
    agentTasks: tasks.map(row => ({ purpose: row.purpose, tool: row.tool, state: row.state, count: row.count, tokens: row.tokens || 0, reported: row.reported || 0, costed: row.costed || 0, costUsd: row.cost || 0 })),
    proposals: { fromTasks: { opened: fromTasks.opened || 0, merged: fromTasks.merged || 0 }, origins: origins.map(row => ({ kind: row.kind, opened: row.opened, merged: row.merged || 0 })),
      evidence: evidence.map(row => ({ state: row.state, count: row.count, tokens: row.tokens || 0 })) },
    reviewAdvice: advice.map(row => ({ state: row.state, count: row.count })),
    aiRuns: runs.map(row => ({ kind: row.kind, state: row.state, count: row.count, tokens: row.tokens || 0 })),
    landing: landing.map(row => ({ trigger: row.trigger, state: row.state, count: row.count })),
    automations: automations.map(row => ({ state: row.state, count: row.count, tokens: row.tokens || 0, costed: row.costed || 0, costUsd: row.cost || 0 })),
    costs: { reportedUsd: Math.round(sum(costRows, row => row.cost) * 100) / 100, reportingRuns: sum(costRows, row => row.costed), runs: sum(costRows, row => row.count) },
    comparison: { label: 'Time from opening to merge, by how the pull request was opened. A comparison of what happened, not a measured effect of AI.',
      aiInvolved: group(timed.filter(involved)), other: group(timed.filter(row => !involved(row))), truncated: merges.length >= 20000 } };
}

async function saveSettings(db, person, request, body) {
  if (request.headers.has('Authorization') || !request.headers.get('X-Golf-Native-Access-Email')) throw new Fault('permission_denied', 403, 'Change your contribution settings while signed in.');
  if (typeof body.showPrivate !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) invalid('Choose whether to show private contributions, with the version you saw.');
  const time = iso(Date.now());
  const [created, updated] = await db.batch([
    db.prepare('INSERT INTO contribution_settings(user_id,show_private,version,updated_at) SELECT ?,?,1,? WHERE ?=0 AND NOT EXISTS(SELECT 1 FROM contribution_settings WHERE user_id=?)')
      .bind(person.id, Number(body.showPrivate), time, body.expectedVersion, person.id),
    db.prepare('UPDATE contribution_settings SET show_private=?,version=version+1,updated_at=? WHERE user_id=? AND version=? AND ?>0').bind(Number(body.showPrivate), time, person.id, body.expectedVersion, body.expectedVersion),
  ]);
  if (created.meta.changes + updated.meta.changes !== 1) throw new Fault('failed_precondition', 412, 'Your contribution settings changed. Refresh before editing.');
  const row = await db.prepare('SELECT show_private,version FROM contribution_settings WHERE user_id=?').bind(person.id).first();
  return { settings: { showPrivate: row.show_private === 1, version: row.version, canEdit: true } };
}

// `/native/contributions/read` { action: 'person', owner, year? } for any signed-in person, { action: 'impact', year? } for operations
// administrators (checked before and after the reads); `/native/contributions` { action: 'settings', showPrivate, expectedVersion }.
export async function contributionsAPI(db, env, person, request, body, read) {
  if (person.anonymous) throw new Fault('permission_denied', 403, 'Sign in to see contribution graphs.');
  try { await db.prepare('SELECT 1 FROM contribution_days LIMIT 1').first(); }
  catch { throw new Fault('failed_precondition', 412, 'Apply the schema 53 migration to record contributions.'); }
  if (!read) {
    if (body.action !== 'settings') invalid('This route only changes contribution settings.');
    return reply(await saveSettings(db, person, request, body));
  }
  if (body.action === 'person') return reply(await personView(db, env, person, body));
  if (body.action === 'impact') {
    const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
    await requireAdmin();
    const result = await impactView(db, env, body);
    await requireAdmin();
    return reply(result);
  }
  invalid('Use the person or impact action.');
}
