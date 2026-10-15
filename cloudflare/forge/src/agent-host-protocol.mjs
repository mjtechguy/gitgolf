// The agent host protocol (docs/AGENT_HOSTS.md): POST /native/agent-host/{register,heartbeat,claim} with the host
// credential and /native/agent-host/tasks/<id>/{start,log,finish} plus Smart HTTP Git with the task token. Machine
// routes outside Access; every call checks its credential against D1, and claim and Git re-check the admission rules.
// The task route pushes through the same fenced single-ref write as /git/: one branch, create or this task's own
// fast-forward, at most 8 MiB. The same task token also reaches /mcp and /native/source/* while the task runs (api-tokens.mjs
// taskTokenActor); claim names the MCP endpoint.
import { digest, Fault, invalid, reply, uuidOK, conflict } from './common.mjs';
import { advertisedRefs, bounded, defaultBranchAdvertisement, defaultBranchRefsV2, gitRequest, gitV2Command, receiveCommand, refusedRef, refusalReport, acceptedReport, sha } from './git.mjs';
import { chargeBudget, budgetJSON, budgetText } from './agent-budgets.mjs';
import { enforceGitRules } from './repository-rules.mjs';
import { reserveRefWrite, finishRefWrite, sendRefUpdate } from './ref-writes.mjs';
import { ownerSlug } from './owners.mjs';
import { featureOff } from './feature-policy.mjs';
import { admissionRefusal, agentSchema, agentTools, byteLength, isReview, maxDuration, now, parse, random, refuse, repositoryRow, reviewSummaryBytes, scrub, targetURL, terminalStates } from './agent-hosts.mjs';

const zero = '0'.repeat(40);
const unauthenticated = message => { throw new Fault('unauthenticated', 401, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const plain = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const finishes = { succeeded: 'SUCCEEDED', no_changes: 'NO_CHANGES', failed: 'FAILED', cancelled: 'CANCELLED', timed_out: 'TIMED_OUT' };
const maxLogLines = 10_000, maxLogBytes = 512 * 1024;

async function json(request, limit) {
  if (request.method !== 'POST' || new URL(request.url).search) invalid('Use POST with a JSON body.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') invalid('Use JSON.');
  let bytes;
  try { bytes = await bounded(request.body, limit); } catch { throw new Fault('resource_exhausted', 413, `The request exceeds ${limit / 1024} KiB.`); }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Use a request object.');
  return body;
}
async function hostByCredential(db, request) {
  const match = /^Bearer (golf_agent_host_([0-9a-f-]{36})_[0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!match) unauthenticated('Agent host credential required.');
  const host = await db.prepare('SELECT * FROM agent_hosts WHERE credential_digest=?').bind(await digest(match[1])).first();
  if (!host || host.deleted || host.uuid !== match[2]) unauthenticated('Agent host credential unknown or deleted.');
  return host;
}
const tokenOf = (request, basic) => {
  const header = request.headers.get('Authorization') || '';
  if (/^bearer /i.test(header)) return header.slice(7);
  if (basic && /^basic /i.test(header)) { try { const pair = atob(header.slice(6)); return pair.slice(pair.indexOf(':') + 1); } catch { return ''; } }
  return '';
};
async function taskByToken(db, token, id) {
  const match = /^golf_agent_task_([0-9a-f-]{36})_[0-9a-f]{64}$/.exec(token || '');
  if (!match || match[1] !== id) return null;
  const task = await db.prepare('SELECT * FROM agent_tasks WHERE token_digest=?').bind(await digest(token)).first();
  return task?.id === id ? task : null;
}
// A token works while its task is claimed or running and before its deadline; finish also answers a finished task.
function live(task) {
  if (terminalStates.includes(task.state)) throw new Fault('aborted', 409, `The task already finished (${task.state}).`);
  if (task.deadline <= Date.now()) unauthenticated('The task token expired with the task deadline.');
}
const cancelled = task => Boolean(task.cancel_requested);

// The repository, its host and its requester as they are now: the task's authority on claim and on every Git request.
async function authority(db, env, task, withTools) {
  const repository = await repositoryRow(db, task.repository_id);
  if (!repository || repository.artifact_name !== task.artifact_name) return { refusal: { code: 'repository_unavailable', status: 412, message: 'The task’s repository is unavailable.' } };
  const host = await db.prepare('SELECT * FROM agent_hosts WHERE id=?').bind(task.host_id).first();
  const { results: tools } = withTools ? await db.prepare('SELECT * FROM agent_host_tools WHERE host_id=?').bind(task.host_id).all() : { results: [] };
  return { repository, host, refusal: await admissionRefusal(db, env, { repository, requesterId: task.requested_by, host, tools, tool: task.tool, targetKind: task.target_kind, skipTool: !withTools }) };
}
async function claimedTask(db, env, task, repository, token) {
  // Golf's remote MCP endpoint for the same task token (api-tokens.mjs taskTokenActor) while agent access is on for the repository.
  // A review task gets none: it may not commit or open pull requests, and the field mode tells the host to run read-only.
  const review = await isReview(db, task.id);
  const mcp = review || await featureOff(db, env, repository, 'agent-access') ? null : { url: env.PUBLIC_ORIGIN + '/mcp' };
  return { task: { id: task.id, repository: `${ownerSlug(repository, env)}/${repository.name}`, cloneUrl: `${env.PUBLIC_ORIGIN}/native/agent-host/tasks/${task.id}/git`, branch: task.branch,
    baseRef: task.base_ref, baseCommit: task.base_commit, tool: task.tool, model: task.model, prompt: task.prompt, deadline: task.deadline, token, mcp, ...(review ? { mode: 'review' } : {}),
    target: { kind: task.target_kind, number: task.target_number, title: task.target_title, url: targetURL(env, repository, task.target_kind, task.target_number) } } };
}

export async function agentHostMachine(db, env, request, url, withArtifact, providerFetch) {
  if (!await agentSchema(db)) refuse('Agent hosts need the schema 36 migration on this installation.');
  const path = url.pathname.slice('/native/agent-host/'.length);
  const taskRoute = /^tasks\/([0-9a-f-]{36})\/(start|log|finish|git\/(?:info\/refs|git-upload-pack|git-receive-pack))$/.exec(path);
  if (taskRoute?.[2].startsWith('git/')) return taskGit(db, env, request, url, taskRoute[1], taskRoute[2].slice(4), withArtifact, providerFetch);
  if (path === 'register') return reply(await register(db, await json(request, 16 * 1024)));
  if (path === 'heartbeat') return reply(await heartbeat(db, await hostByCredential(db, request), await json(request, 16 * 1024)));
  if (path === 'claim') return reply(await claim(db, env, await hostByCredential(db, request), await json(request, 4 * 1024)));
  if (!taskRoute) throw new Fault('not_found', 404, 'Unknown agent host route.');
  const [, id, action] = taskRoute;
  const body = await json(request, action === 'log' ? 160 * 1024 : 96 * 1024);
  const task = await taskByToken(db, tokenOf(request, false), id);
  if (!task) unauthenticated('Task token unknown.');
  // Each task's rate budget (agent-budgets.mjs), counted once its token is known to be the task's own.
  const refused = await chargeBudget(env, db, 'task', task.id, false);
  if (refused) return budgetJSON(refused);
  if (action === 'start') return reply(await start(db, task));
  if (action === 'log') return appendLog(db, task, body);
  return reply(await finish(db, env, task, body, withArtifact, providerFetch));
}

// ---------- host credential routes ----------
async function register(db, body) {
  const { registrationToken, name, hostVersion = '', os = '', arch = '' } = body;
  if (typeof registrationToken !== 'string' || !/^golfagentreg_[a-f0-9]{64}$/.test(registrationToken)) unauthenticated('Registration token invalid.');
  if (!plain(name, 128) || !name.trim() || !plain(hostVersion, 64) || !/^[a-z0-9_.-]{0,32}$/.test(os) || !/^[a-z0-9_.-]{0,32}$/.test(arch)) invalid('Name the host (at most 128 characters) and give its version, OS and architecture.');
  const row = await db.prepare('SELECT * FROM agent_host_registrations WHERE token_digest=?').bind(await digest(registrationToken)).first();
  if (!row || row.revoked || row.expires_at <= Date.now() || row.uses_left < 1) unauthenticated('Registration token invalid, used or expired.');
  // The token's creator must still manage its scope when the host registers.
  const manager = row.scope === 'personal' ? await db.prepare('SELECT 1 AS ok FROM users WHERE id=? AND active=1').bind(Number(row.scope_id)).first()
    : row.scope === 'organization' ? await db.prepare("SELECT 1 AS ok FROM native_owner_members m JOIN users u ON u.id=m.user_id WHERE m.owner_id=? AND m.user_id=? AND m.role='owner' AND u.active=1").bind(Number(row.scope_id), row.created_by).first()
    : await db.prepare('SELECT 1 AS ok FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1').bind(row.created_by).first();
  if (!manager) forbidden('The person who created this registration token no longer manages its scope.');
  if ((await db.prepare('SELECT COUNT(*) AS n FROM agent_hosts WHERE scope=? AND scope_id=? AND deleted=0').bind(row.scope, row.scope_id).first()).n >= 100) refuse('This scope already has 100 agent hosts.');
  const uuid = crypto.randomUUID(), credential = `golf_agent_host_${uuid}_${random()}`, time = now();
  const results = await db.batch([
    db.prepare('UPDATE agent_host_registrations SET uses_left=uses_left-1 WHERE id=? AND uses_left>0 AND revoked=0 AND expires_at>?').bind(row.id, Date.now()),
    db.prepare(`INSERT INTO agent_hosts(uuid,name,scope,scope_id,registered_by,credential_digest,host_version,os,arch,last_seen_at,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
      .bind(uuid, name.trim(), row.scope, row.scope_id, row.scope === 'personal' ? Number(row.scope_id) : row.created_by, await digest(credential), hostVersion, os, arch, time, time),
  ]);
  if (results[1].meta.changes !== 1) unauthenticated('Registration token invalid, used or expired.');
  const host = await db.prepare('SELECT id FROM agent_hosts WHERE uuid=?').bind(uuid).first();
  return { hostId: String(host.id), uuid, credential };
}

async function heartbeat(db, host, body) {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length > 8 || new Set(tools.map(item => item?.tool)).size !== tools.length ||
      tools.some(item => !item || !agentTools.includes(item.tool) || !plain(item.version ?? '', 64) || ![true, false, null].includes(item.signedIn ?? null) || !plain(item.account ?? '', 128)))
    invalid('Report up to 8 tools from codex, claude, opencode and grok with a version, signedIn true, false or null and an optional account label.');
  // golf-agent-host 0.2.0 and later report their version on each heartbeat; it decides whether the host may take review tasks.
  if (body.hostVersion !== undefined && !plain(body.hostVersion, 64)) invalid('Report the host version as text up to 64 characters.');
  const time = now();
  await db.batch([
    // A tool the host no longer reports is no longer installed there.
    db.prepare('DELETE FROM agent_host_tools WHERE host_id=? AND tool NOT IN (SELECT value FROM json_each(?))').bind(host.id, JSON.stringify(tools.map(item => item.tool))),
    ...tools.map(item => db.prepare(`INSERT INTO agent_host_tools(host_id,tool,version,signed_in,account,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(host_id,tool) DO UPDATE SET version=excluded.version,signed_in=excluded.signed_in,account=excluded.account,updated_at=excluded.updated_at`)
      .bind(host.id, item.tool, item.version ?? '', item.signedIn === null || item.signedIn === undefined ? null : item.signedIn ? 1 : 0, item.account ?? '', time)),
    db.prepare('UPDATE agent_hosts SET last_seen_at=?,host_version=COALESCE(?,host_version) WHERE id=?').bind(time, body.hostVersion ?? null, host.id),
  ]);
  const { results } = await db.prepare("SELECT id FROM agent_tasks WHERE host_id=? AND state IN ('CLAIMED','RUNNING') AND cancel_requested=1 ORDER BY created_at").bind(host.id).all();
  return { ok: true, cancel: results.map(row => row.id), state: host.state };
}

async function claim(db, env, host, body) {
  if (!uuidOK(body.claimId)) invalid('Send a UUID v4 claimId.');
  if (host.state !== 'ACTIVE') forbidden(`Rule 3 (host): agent host ${host.name} is disabled.`);
  const time = now();
  await db.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE id=?').bind(time, host.id).run();
  // A retried claim (lost response) returns the same task with a fresh token; the earlier token stops working.
  const retried = await db.prepare('SELECT * FROM agent_tasks WHERE host_id=? AND claim_id=?').bind(host.id, body.claimId).first();
  if (retried) {
    if (retried.state !== 'CLAIMED') return { task: null };
    const repository = await repositoryRow(db, retried.repository_id), token = `golf_agent_task_${retried.id}_${random()}`;
    const changed = await db.prepare("UPDATE agent_tasks SET token_digest=?,updated_at=? WHERE id=? AND state='CLAIMED' AND claim_id=?").bind(await digest(token), time, retried.id, body.claimId).run();
    return changed.meta.changes === 1 && repository ? claimedTask(db, env, retried, repository, token) : { task: null };
  }
  const busy = await db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE host_id=? AND state IN ('CLAIMED','RUNNING')").bind(host.id).first();
  if (busy.n >= host.max_concurrent) return { task: null };
  const { results: candidates } = await db.prepare("SELECT * FROM agent_tasks WHERE host_id=? AND state='QUEUED' AND cancel_requested=0 ORDER BY created_at,id LIMIT 10").bind(host.id).all();
  for (const candidate of candidates) {
    // The admission rules again, as they are now; a task that no longer qualifies fails with the rule's code.
    const { repository, refusal } = await authority(db, env, candidate, true);
    if (refusal) {
      await db.prepare("UPDATE agent_tasks SET state='FAILED',failure_reason=?,finished_at=?,updated_at=? WHERE id=? AND state='QUEUED'").bind('refused_' + refusal.code, time, time, candidate.id).run();
      continue;
    }
    const token = `golf_agent_task_${candidate.id}_${random()}`;
    const duration = Math.min(maxDuration, Math.max(60_000, candidate.deadline - Date.parse(candidate.created_at))), deadline = Date.now() + duration;
    const changed = await db.prepare("UPDATE agent_tasks SET state='CLAIMED',claim_id=?,token_digest=?,claimed_at=?,deadline=?,updated_at=? WHERE id=? AND state='QUEUED' AND cancel_requested=0")
      .bind(body.claimId, await digest(token), time, deadline, time, candidate.id).run();
    if (changed.meta.changes === 1) return claimedTask(db, env, { ...candidate, deadline }, repository, token);
  }
  return { task: null };
}

// ---------- task token routes ----------
async function start(db, task) {
  live(task);
  if (cancelled(task)) return { ok: true, cancel: true };
  if (task.state === 'CLAIMED') await db.prepare("UPDATE agent_tasks SET state='RUNNING',started_at=?,updated_at=? WHERE id=? AND state='CLAIMED'").bind(now(), now(), task.id).run();
  const fresh = await db.prepare('SELECT state,cancel_requested FROM agent_tasks WHERE id=?').bind(task.id).first();
  if (fresh.state !== 'RUNNING') throw new Fault('aborted', 409, `The task is ${fresh.state}.`);
  return { ok: true, cancel: cancelled(fresh) };
}

// offset is the number of lines already accepted; a retried chunk stores only its new lines. Past 10,000 lines or
// 512 KiB the lines are accepted and dropped, and the log is marked truncated.
async function appendLog(db, task, body) {
  live(task);
  const { offset, lines } = body;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(lines) || lines.length > 200 || lines.some(line => typeof line !== 'string')) invalid('Send an offset and up to 200 lines.');
  if (byteLength(lines.join('\n')) > 64 * 1024) throw new Fault('resource_exhausted', 413, 'A log chunk is limited to 64 KiB.');
  if (offset > task.log_lines) return reply({ code: 'aborted', message: `Lines from ${task.log_lines} are missing; resend from that offset.`, nextOffset: task.log_lines }, 409);
  const fresh = lines.slice(task.log_lines - offset).map(line => scrub(line.replace(/\r?\n$/, '')));
  if (!fresh.length) return reply({ nextOffset: task.log_lines, cancel: cancelled(task) });
  let stored = [], bytes = 0;
  if (!task.log_truncated) {
    for (const line of fresh) {
      const size = byteLength(line) + 1;
      if (task.log_lines + stored.length >= maxLogLines || task.log_bytes + bytes + size > maxLogBytes) break;
      stored.push(line); bytes += size;
    }
  }
  const truncated = task.log_truncated || stored.length < fresh.length ? 1 : 0, time = now();
  const results = await db.batch([
    db.prepare("UPDATE agent_tasks SET log_lines=log_lines+?,log_bytes=log_bytes+?,log_truncated=?,updated_at=? WHERE id=? AND log_lines=? AND state IN ('CLAIMED','RUNNING')").bind(fresh.length, bytes, truncated, time, task.id, task.log_lines),
    db.prepare('INSERT INTO agent_task_logs(task_id,seq,text) SELECT ?,?+key,value FROM json_each(?) WHERE changes()=1').bind(task.id, task.log_lines, JSON.stringify(stored)),
  ]);
  const current = await db.prepare('SELECT log_lines,cancel_requested FROM agent_tasks WHERE id=?').bind(task.id).first();
  if (results[0].meta.changes !== 1) return reply({ code: 'aborted', message: 'Another log chunk was stored first; resend from nextOffset.', nextOffset: current.log_lines }, 409);
  return reply({ nextOffset: current.log_lines, cancel: cancelled(current) });
}

async function finish(db, env, task, body, withArtifact, providerFetch) {
  if (terminalStates.includes(task.state)) return { ok: true, state: task.state };
  const { exitCode = null, commitId = '', summary = '', changedFiles = [], usage = {}, failure = '' } = body;
  // A review task's final text is the review (up to 12 KiB); it never names a commit, and nothing is verified on a branch.
  const review = await isReview(db, task.id);
  let state = finishes[body.state];
  if (!state || exitCode !== null && !Number.isSafeInteger(exitCode) || typeof commitId !== 'string' || commitId && !sha(commitId) || typeof summary !== 'string' || byteLength(summary) > (review ? reviewSummaryBytes : 4096) ||
      !Array.isArray(changedFiles) || changedFiles.length > 1000 || changedFiles.some(file => typeof file !== 'string' || !file || file.length > 1024) || typeof failure !== 'string' || failure.length > 512 ||
      !usage || typeof usage !== 'object' || Array.isArray(usage) || Object.entries(usage).some(([key, value]) => !['inputTokens', 'outputTokens', 'costUsd'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    invalid('Finish with a state, an exit code, a commit, a summary up to 4 KiB, up to 1,000 changed files, reported usage and a failure up to 512 characters.');
  if (review && commitId) invalid('A review task does not commit.');
  if (state === 'SUCCEEDED' && !commitId && !review) invalid('A succeeded task names its commit.');
  if (review && state === 'NO_CHANGES') state = 'SUCCEEDED';
  let reason = state === 'SUCCEEDED' ? '' : scrub(failure);
  if (state === 'SUCCEEDED' && !review) {
    // The proposal is the branch at commitId, with baseCommit on its first-parent chain within 50 commits.
    const repository = await repositoryRow(db, task.repository_id);
    const verified = repository?.artifact_name === task.artifact_name && await withArtifact(env, repository, async repo => {
      const refs = advertisedRefs((await gitRequest(env, repo, repository.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, providerFetch)).bytes);
      if (refs.get('refs/heads/' + task.branch) !== commitId) return false;
      for (let hash = commitId, depth = 0; sha(hash) && depth <= 50; depth++) {
        if (depth && hash === task.base_commit) return true;
        hash = (await repo.readCommit(hash))?.parents?.[0];
      }
      return false;
    });
    if (!verified) { state = 'FAILED'; reason = 'proposal_unverified'; }
  }
  const result = JSON.stringify({ summary: scrub(summary), changedFiles, usage: Object.keys(usage).length ? { ...usage, reported: true } : null });
  if (byteLength(result) > 96 * 1024) invalid('The finish report exceeds its bound.');
  const time = now();
  await db.prepare("UPDATE agent_tasks SET state=?,exit_code=?,commit_id=?,result=?,failure_reason=?,finished_at=?,updated_at=? WHERE id=? AND state IN ('CLAIMED','RUNNING')")
    .bind(state, exitCode, commitId, result, reason, time, time, task.id).run();
  return { ok: true, state: (await db.prepare('SELECT state FROM agent_tasks WHERE id=?').bind(task.id).first()).state };
}

// ---------- Smart HTTP Git for one task: Basic golf:<task token> ----------
async function taskGit(db, env, request, url, id, route, withArtifact, providerFetch) {
  const text = (message, status, headers = {}) => new Response(message + '\n', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
  const challenge = message => text(message, 401, { 'WWW-Authenticate': 'Basic realm="Golf agent task"' });
  const token = tokenOf(request, true);
  if (!token) return challenge('Task token required.');
  try {
    const task = await taskByToken(db, token, id);
    if (!task) return challenge('Task token unknown.');
    if (terminalStates.includes(task.state)) return text(`The task finished (${task.state}); its Git access ended.`, 403);
    if (task.deadline <= Date.now()) return text('The task deadline passed; its Git access ended.', 403);
    if (cancelled(task)) return text('The task was cancelled.', 403);
    const advertisement = route === 'info/refs', service = advertisement ? url.searchParams.get('service') : route;
    if (!['git-upload-pack', 'git-receive-pack'].includes(service) || (advertisement ? request.method !== 'GET' || url.search !== '?service=' + service : request.method !== 'POST' || url.search ||
        request.headers.get('Content-Type') !== `application/x-${service}-request`)) return text('Invalid Git request.', 400);
    const push = service === 'git-receive-pack';
    if (push && task.state !== 'RUNNING') return text('Pushes are accepted only while the task is RUNNING; call start first.', 403);
    if (push && await isReview(db, task.id)) return text('A review task is read-only; its token cannot push.', 403);
    // The task's rate budget: a fetch or advertisement is one request (429); a push is a write, refused in Git's own report below.
    if (advertisement || !push) { const refused = await chargeBudget(env, db, 'task', task.id, false); if (refused) return budgetText(refused); }
    const { repository, refusal } = await authority(db, env, task, false);
    if (refusal) return text(refusal.message, 403);
    let body = null;
    if (!advertisement) {
      try { body = await bounded(request.body, 8 * 1024 * 1024); }
      catch { return text('A push is limited to 8 MiB.', 413); }
      if (!push && request.headers.get('Content-Encoding') === 'gzip') body = new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      else if (request.headers.has('Content-Encoding')) return text('Unsupported Git content encoding.', 415);
    }
    // Git sends one flush packet before a large push to learn whether credentials are needed; the token was checked above.
    if (push && body?.length === 4 && new TextDecoder().decode(body) === '0000') {
      const refused = await chargeBudget(env, db, 'task', task.id, false);
      if (refused) return budgetText(refused);
      return new Response(null, { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store' } });
    }
    const protocol = !push && request.headers.get('Git-Protocol') === 'version=2' ? 'version=2' : null;
    const refsOf = async repo => advertisedRefs((await gitRequest(env, repo, repository.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, providerFetch)).bytes);
    let command;
    if (push && body) {
      try { command = receiveCommand(body); } catch { return text('Only one ordinary branch update per push is accepted.', 403); }
      const refused = await chargeBudget(env, db, 'task', task.id, true);
      if (refused) return new Response(refusalReport(command, refused.reason), { headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store', 'Retry-After': String(refused.retryAfter) } });
      if (command.ref !== 'refs/heads/' + task.branch) return text(`This task may push only refs/heads/${task.branch}.`, 403);
      if (command.next === zero) return text('This task may not delete its branch.', 403);
      if (command.old !== zero && command.old !== task.commit_id) return text('Only a new branch, or a fast-forward of the commit this task pushed before, is accepted.', 403);
      if (repository.write_pending) return text('An unresolved operation fences further changes to this repository.', 409);
      try { await enforceGitRules(db, repository, { id: task.requested_by }, command.ref); } catch (error) { if (error instanceof Fault) return text(error.message, 403); throw error; }
    }
    return await withArtifact(env, repository, async repo => {
      let operation, result, applied = !command, refused = false;
      if (command) {
        if (((await refsOf(repo)).get(command.ref) || zero) !== command.old) return text('The branch moved; fetch and push again.', 409);
        operation = crypto.randomUUID();
        // The same ref fence as /git/ pushes, admitted only while the requester still writes and the task still runs.
        if (!await reserveRefWrite(db, { id: operation, repositoryId: repository.id, userId: task.requested_by, command, time: now(), guard: {
          sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE'
              AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1)
            AND EXISTS(SELECT 1 FROM agent_tasks WHERE id=? AND token_digest=? AND state='RUNNING' AND cancel_requested=0)`,
          values: [repository.id, repository.artifact_name, task.requested_by, task.id, task.token_digest] } }))
          return text('The push was not admitted: the task or the repository changed, or another push to the branch is in flight.', 409);
      }
      const send = () => gitRequest(env, repo, repository.artifact_name, advertisement ? 'info/refs?service=' + service : service, service, body, providerFetch, protocol);
      try {
        if (!operation) result = await send();
        else {
          ({ result, applied, refused } = await sendRefUpdate({ send, command, read: async () => (await refsOf(repo)).get(command.ref) || zero }));
          if (applied && (!result || refusedRef(result.bytes, command.ref))) result = { bytes: acceptedReport(command), contentType: 'application/x-git-receive-pack-result' };
        }
      } finally {
        if (operation) await finishRefWrite(db, { id: operation, repositoryId: repository.id, applied, refused, statements: [db.prepare('UPDATE agent_tasks SET commit_id=?,updated_at=? WHERE id=?').bind(command.next, now(), task.id)] });
      }
      // An unconfirmed write keeps the branch and the repository fenced, exactly as /git/ does; a refused one is Git's own report.
      if (!applied && !refused) conflict();
      let bytes = result.bytes;
      if (service === 'git-upload-pack') {
        // A v2 advertisement carries only capabilities; HEAD is answered by ls-refs.
        if (advertisement) { if (!protocol) bytes = defaultBranchAdvertisement(bytes, repository.default_branch); }
        else if (protocol && gitV2Command(body) === 'command=ls-refs') bytes = defaultBranchRefsV2(bytes, repository.default_branch, (await refsOf(repo)).get('refs/heads/' + repository.default_branch));
      }
      return new Response(bytes, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    if (error instanceof Fault) return text(error.message, error.status);
    console.log(JSON.stringify({ event: 'golf.agent_task_git_error', message: String(error?.message || error).slice(0, 300) }));
    return text('The Git operation could not be confirmed.', 503);
  }
}
