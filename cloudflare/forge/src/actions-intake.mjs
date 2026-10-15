// Trigger intake for Actions/CI pipelines: pushes (branches and tags), same-repository pull requests (opened,
// synchronize, reopened) and workflow_dispatch. A trigger is recorded durably first (pipeline_intake), then discovered
// at the exact commit: every workflow file is read, its `on:` filters are evaluated and matching workflows become runs.
// Engines other than the Forgejo Runner register a planner (RUN-C: gitlab-ci for .gitlab-ci.yml).
import { Fault } from './common.mjs';
import { ownerSlug } from './owners.mjs';
import { advertisedRefs, gitRequest, sha, validRef } from './git.mjs';
import { changedFiles as diffFiles } from './repository-diff.mjs';
import { fileIndex } from './file-index.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { createPipelineRun, refusePipelineRun, pipelineAllowed, pipelineValues } from './pipelines.mjs';
import { discoverWorkflows, parseWorkflow, matchTrigger, expandWorkflow, dispatchInputs, workflowEvents, WorkflowRefused } from './actions-workflow.mjs';

const zero = '0'.repeat(40), now = () => new Date().toISOString();
const planners = new Map();
// planner(input) → { workflowName, jobs, notes? } | { skipped } ; throws Fault(400) to refuse. See docs/NATIVE_ACTIONS_PIPELINES.md.
export function registerPipelinePlanner(engine, path, planner) { planners.set(engine, { path, planner }); }

// key makes a replayed trigger (the same mutation receipt) record nothing new.
export async function recordPipelineIntake(db, env, repositoryId, kind, payload, key) {
  if (!pipelinePolicy(env)) return null;
  const id = key || crypto.randomUUID(), time = now();
  const saved = await db.prepare("INSERT INTO pipeline_intake(id,repository_id,kind,payload,state,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?) ON CONFLICT(id) DO NOTHING").bind(id, repositoryId, kind, JSON.stringify(payload), time, time).run();
  return saved.meta.changes === 1 ? id : null;
}
// Fan-out: the Queue when bound, else after the response; the scheduled sweep retries anything left PENDING.
export async function dispatchPipelineIntake(env, id, withArtifact) {
  if (!id) return;
  if (env.PIPELINE_QUEUE) { try { await env.PIPELINE_QUEUE.send({ intake: id }); return; } catch { /* the sweep retries */ } }
  const work = processPipelineIntake(env, id, withArtifact).catch(error => console.log(JSON.stringify({ event: 'golf.pipeline_intake_failed', message: String(error?.message || error).slice(0, 300) })));
  if (env.waitUntil) env.waitUntil(work); else await work;
}

async function repositoryRow(db, id) {
  return db.prepare("SELECT r.*,o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id=? AND r.state='ACTIVE'").bind(id).first();
}
export async function repositoryRefs(env, repo, row) {
  return advertisedRefs((await gitRequest(env, repo, row.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, env.providerFetch || fetch)).bytes);
}
function repositoryEvent(env, row) {
  const full = ownerSlug(row, env) + '/' + row.name;
  return { id: row.id, name: row.name, full_name: full, owner: { login: ownerSlug(row, env) }, default_branch: row.default_branch, private: true,
    html_url: env.PUBLIC_ORIGIN + '/' + full, clone_url: env.PUBLIC_ORIGIN + '/' + full + '.git' };
}
async function readPath(repo, commitId, path) {
  const commit = await repo.readCommit(commitId);
  let hash = commit?.treeHash;
  const parts = path.split('/');
  for (let i = 0; i < parts.length && hash; i++) {
    const entry = (await repo.readTree(hash))?.find(item => item.name === parts[i]);
    if (!entry || (i < parts.length - 1 ? entry.type !== 'tree' : !['blob', 'exec'].includes(entry.type))) return null;
    hash = entry.hash;
  }
  if (!hash) return null;
  const blob = await repo.readBlob(hash);
  if (!blob || blob.size > 512 * 1024) return null;
  try { return { blobId: hash, text: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await blob.arrayBuffer())) }; } catch { return null; }
}

// One trigger at one commit → runs for every matching workflow. trigger: { event, action?, ref, commitId, beforeSha, pullNumber?, headRef?, baseRef?, actorId, trusted, inputs?, eventPayload, title, intakeId, onlyPath? }
export async function planRuns(db, env, row, repo, trigger) {
  const created = [];
  const base = { repositoryId: row.id, event: trigger.event, ref: trigger.ref, commitId: trigger.commitId, beforeSha: trigger.beforeSha || '', pullNumber: trigger.pullNumber ?? null,
    headRef: trigger.headRef || '', baseRef: trigger.baseRef || '', actorId: trigger.actorId, trusted: trigger.trusted, eventPayload: trigger.eventPayload, title: trigger.title || '', intakeId: trigger.intakeId };
  let changed = null;
  const changes = async () => {
    if (changed !== null) return changed || null;
    const from = trigger.event === 'pull_request' ? trigger.baseCommitId : trigger.beforeSha;
    try { changed = from && from !== zero && sha(from) ? (await diffFiles(repo, from, trigger.commitId)).map(change => change.file) : false; } catch { changed = false; }
    return changed || null;
  };
  const values = { variables: {} };
  try { Object.assign(values, await pipelineValues(db, env, { id: 'intake:' + trigger.intakeId, attempt: 0, repository_id: row.id, artifact_name: row.artifact_name, trusted: 0 })); } catch { /* vars stay empty */ }
  const github = { event_name: trigger.event, ref: trigger.ref, ref_name: trigger.ref.replace(/^refs\/(heads|tags)\//, ''), ref_type: trigger.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    sha: trigger.commitId, repository: ownerSlug(row, env) + '/' + row.name, repository_owner: ownerSlug(row, env), head_ref: trigger.headRef || '', base_ref: trigger.baseRef || '',
    server_url: env.PUBLIC_ORIGIN, event: trigger.eventPayload, actor: trigger.actorLogin || '', run_attempt: '1' };
  for (const file of await discoverWorkflows(repo, trigger.commitId)) {
    if (trigger.onlyPath && file.path !== trigger.onlyPath) continue;
    const identity = { ...base, engine: 'forgejo-actions', workflowPath: file.path, workflowName: file.path, workflowBlob: file.blobId };
    try {
      if (file.error) throw new WorkflowRefused(file.error);
      const root = parseWorkflow(file.source);
      identity.workflowName = typeof root.name === 'string' && root.name ? root.name.slice(0, 200) : file.path;
      let inputs = {};
      if (trigger.event === 'workflow_dispatch') inputs = dispatchInputs(root, trigger.inputs || {});
      else {
        const events = workflowEvents(root);
        if (!Object.hasOwn(events, trigger.event)) continue;
        const config = events[trigger.event] || {};
        const needsFiles = config.paths !== undefined || config['paths-ignore'] !== undefined;
        if (!matchTrigger(root, { event: trigger.event, action: trigger.action, ref: trigger.ref, baseRef: trigger.baseRef, changedFiles: needsFiles ? await changes() : null }).match) continue;
      }
      const plan = expandWorkflow(root, file.path, { github: { ...github, workflow: identity.workflowName }, inputs, vars: values.variables });
      created.push(await createPipelineRun(db, env, { ...identity, inputs, title: plan.runName || base.title, concurrency: plan.concurrency, reason: plan.notes.join(' ') }, plan.jobs));
    } catch (error) {
      if (!(error instanceof WorkflowRefused || error instanceof Fault && error.status === 400)) throw error;
      created.push(await refusePipelineRun(db, env, identity, error.message.slice(0, 2000)));
    }
  }
  for (const [engine, { path, planner }] of planners) {
    if (trigger.onlyPath && trigger.onlyPath !== path) continue;
    const file = await readPath(repo, trigger.commitId, path);
    if (!file) continue;
    const identity = { ...base, engine, workflowPath: path, workflowName: path, workflowBlob: file.blobId,
      event: trigger.event === 'pull_request' ? 'merge_request_event' : trigger.event === 'workflow_dispatch' ? 'web' : trigger.event };
    let files = null;
    try { files = await fileIndex(repo, trigger.commitId, (r, hash) => r.readTree(hash), path => path); } catch { files = null; }
    try {
      const plan = await planner({ source: file.text, readFile: async name => (await readPath(repo, trigger.commitId, name))?.text ?? null, files,
        changedFiles: trigger.event === 'push' ? await changes() : trigger.event === 'pull_request' ? await changes() : null,
        context: { event: identity.event, ref: trigger.ref, commitId: trigger.commitId, beforeSha: trigger.beforeSha || '', defaultBranch: row.default_branch,
          projectPath: ownerSlug(row, env) + '/' + row.name, pullNumber: trigger.pullNumber ?? null, headRef: trigger.headRef || '', baseRef: trigger.baseRef || '',
          variables: trigger.inputs || {}, commitMessage: trigger.commitMessage || '', origin: env.PUBLIC_ORIGIN } });
      if (plan?.skipped) continue;
      created.push(await createPipelineRun(db, env, { ...identity, workflowName: plan.workflowName || path, inputs: trigger.inputs || {}, reason: (plan.notes || []).join(' ') }, plan.jobs));
    } catch (error) {
      if (!(error instanceof Fault && error.status === 400 || error instanceof WorkflowRefused)) throw error;
      created.push(await refusePipelineRun(db, env, identity, error.message.slice(0, 2000)));
    }
  }
  return created;
}

export async function processPipelineIntake(env, id, withArtifact) {
  const db = env.DB.withSession('first-primary');
  const intake = await db.prepare('SELECT * FROM pipeline_intake WHERE id=?').bind(id).first();
  if (!intake || intake.state !== 'PENDING') return { state: intake?.state || 'MISSING' };
  const finish = (state, reason = '') => db.prepare('UPDATE pipeline_intake SET state=?,reason=?,updated_at=? WHERE id=? AND state=\'PENDING\'').bind(state, reason, now(), id).run();
  await db.prepare('UPDATE pipeline_intake SET attempts=attempts+1,updated_at=? WHERE id=?').bind(now(), id).run();
  if (intake.attempts >= 5) { await finish('REFUSED', 'Intake failed five times.'); return { state: 'REFUSED' }; }
  const row = await repositoryRow(db, intake.repository_id);
  if (!row) { await finish('REFUSED', 'Repository unavailable.'); return { state: 'REFUSED' }; }
  if (!await pipelineAllowed(db, env, row.id)) { await finish('REFUSED', 'Actions are off for this repository.'); return { state: 'REFUSED' }; }
  const payload = JSON.parse(intake.payload);
  const actor = await db.prepare('SELECT id,login FROM users WHERE id=? AND active=1').bind(payload.actorId).first();
  if (!actor) { await finish('REFUSED', 'The triggering account is inactive.'); return { state: 'REFUSED' }; }
  const runs = await withArtifact(env, row, async repo => {
    if (intake.kind === 'push') {
      if (payload.after === zero || !sha(payload.after) || !validRef(payload.ref)) return [];
      const commit = await repo.readCommit(payload.after);
      const eventPayload = { ref: payload.ref, before: payload.before, after: payload.after, created: payload.before === zero, deleted: false, forced: false,
        repository: repositoryEvent(env, row), pusher: { name: actor.login }, sender: { login: actor.login },
        head_commit: commit ? { id: payload.after, message: commit.message || '', timestamp: commit.authoredAt ? new Date(commit.authoredAt * 1000).toISOString() : now() } : null };
      const result = await planRuns(db, env, row, repo, { event: 'push', ref: payload.ref, commitId: payload.after, beforeSha: payload.before, actorId: actor.id, actorLogin: actor.login, trusted: true,
        eventPayload, title: (commit?.message || '').split('\n')[0].slice(0, 200), intakeId: id, commitMessage: commit?.message || '' });
      // A push to the head branch of open same-repository pull requests is their `synchronize`.
      if (payload.ref.startsWith('refs/heads/')) {
        const branch = payload.ref.slice(11);
        const { results } = await db.prepare("SELECT d.number FROM pull_requests p CROSS JOIN discussions d ON d.id=p.discussion_id WHERE d.repository_id=? AND d.state='OPEN' AND p.head_branch=? ORDER BY d.number LIMIT 10").bind(row.id, branch).all();
        for (const pull of results) await dispatchPipelineIntake(env, await recordPipelineIntake(db, env, row.id, 'pull_request', { number: pull.number, action: 'synchronize', headCommitId: payload.after, actorId: actor.id }), withArtifact);
      }
      return result;
    }
    if (intake.kind === 'pull_request') {
      const pull = await db.prepare("SELECT d.*,p.base_branch,p.head_branch,p.base_commit,p.head_commit,p.draft FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.number=? AND d.kind='pull'").bind(row.id, payload.number).first();
      if (!pull || pull.state !== 'OPEN') return [];
      const refs = await repositoryRefs(env, repo, row);
      const head = payload.headCommitId || refs.get('refs/heads/' + pull.head_branch), baseCommit = refs.get('refs/heads/' + pull.base_branch) || pull.base_commit;
      if (!sha(head)) return [];
      const full = ownerSlug(row, env) + '/' + row.name;
      const eventPayload = { action: payload.action, number: pull.number, repository: repositoryEvent(env, row), sender: { login: actor.login },
        pull_request: { number: pull.number, title: pull.title, body: pull.body, state: 'open', draft: Boolean(pull.draft), html_url: env.PUBLIC_ORIGIN + '/' + full + '/pulls/' + pull.number,
          head: { ref: pull.head_branch, sha: head, repo: { full_name: full } }, base: { ref: pull.base_branch, sha: baseCommit, repo: { full_name: full } }, user: { login: actor.login } } };
      return planRuns(db, env, row, repo, { event: 'pull_request', action: payload.action, ref: `refs/pull/${pull.number}/head`, commitId: head, baseCommitId: baseCommit, pullNumber: pull.number,
        headRef: pull.head_branch, baseRef: pull.base_branch, actorId: actor.id, actorLogin: actor.login, trusted: true, eventPayload, title: pull.title, intakeId: id });
    }
    return [];
  });
  await finish('DONE', runs.length ? '' : 'No workflow matched.');
  return { state: 'DONE', runs };
}

// workflow_dispatch from the Actions tab: one workflow at a branch head, with typed inputs.
export async function dispatchWorkflow(db, env, person, row, { workflowPath, ref, inputs }, withArtifact) {
  if (typeof workflowPath !== 'string' || !/^\.(github|forgejo)\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)) throw new Fault('invalid_argument', 400, 'Choose a workflow file.');
  if (typeof ref !== 'string' || !validRef('refs/heads/' + ref)) throw new Fault('invalid_argument', 400, 'Choose a branch.');
  const intakeId = crypto.randomUUID();
  return withArtifact(env, row, async repo => {
    const commitId = (await repositoryRefs(env, repo, row)).get('refs/heads/' + ref);
    if (!sha(commitId)) throw new Fault('failed_precondition', 412, 'The branch does not exist.');
    const file = await readPath(repo, commitId, workflowPath);
    if (!file) throw new Fault('failed_precondition', 412, 'The workflow file does not exist on that branch.');
    let root;
    try { root = parseWorkflow(file.text); if (!Object.hasOwn(workflowEvents(root), 'workflow_dispatch')) throw new WorkflowRefused('This workflow has no workflow_dispatch trigger.'); dispatchInputs(root, inputs || {}); }
    catch (error) { if (error instanceof WorkflowRefused) throw new Fault('failed_precondition', 412, error.message); throw error; }
    const eventPayload = { inputs: inputs || {}, ref: 'refs/heads/' + ref, repository: repositoryEvent(env, row), sender: { login: person.login }, workflow: workflowPath };
    const runs = await planRuns(db, env, row, repo, { event: 'workflow_dispatch', ref: 'refs/heads/' + ref, commitId, actorId: person.id, actorLogin: person.login, trusted: true, inputs: inputs || {},
      eventPayload, title: 'Manually run by ' + person.login, intakeId, onlyPath: workflowPath });
    if (!runs.length) throw new Fault('failed_precondition', 412, 'The workflow produced no run.');
    return runs[0];
  });
}

// The workflows of a commit as the Actions tab lists them (name, path, dispatch inputs).
export async function listWorkflows(env, row, repo, commitId) {
  const result = [];
  for (const file of await discoverWorkflows(repo, commitId)) {
    try {
      if (file.error) throw new WorkflowRefused(file.error);
      const root = parseWorkflow(file.source), events = workflowEvents(root);
      const inputs = events.workflow_dispatch?.inputs && typeof events.workflow_dispatch.inputs === 'object' ? Object.entries(events.workflow_dispatch.inputs).map(([name, spec]) => ({ name,
        description: String(spec?.description || ''), type: String(spec?.type || 'string'), required: Boolean(spec?.required), default: spec?.default === undefined ? '' : String(spec.default), options: (spec?.options || []).map(String) })) : [];
      result.push({ path: file.path, name: typeof root.name === 'string' && root.name ? root.name : file.path, events: Object.keys(events), dispatch: Object.hasOwn(events, 'workflow_dispatch'), inputs, error: '' });
    } catch (error) {
      if (!(error instanceof WorkflowRefused)) throw error;
      result.push({ path: file.path, name: file.path, events: [], dispatch: false, inputs: [], error: error.message });
    }
  }
  for (const [engine, { path }] of planners) if (await readPath(repo, commitId, path)) result.push({ path, name: path, engine, events: ['push'], dispatch: false, inputs: [], error: '' });
  return result;
}

// Scheduled safety net: retry lost intakes and advance runs whose coordinator alarm was lost.
export async function sweepPipelines(env, withArtifact, advance) {
  if (!pipelinePolicy(env)) return { intakes: 0, runs: 0 };
  const db = env.DB.withSession('first-primary');
  const { results: intakes } = await db.prepare("SELECT id FROM pipeline_intake WHERE state='PENDING' AND updated_at<? ORDER BY created_at LIMIT 10").bind(new Date(Date.now() - 60_000).toISOString()).all();
  for (const intake of intakes) { try { await processPipelineIntake(env, intake.id, withArtifact); } catch { /* next sweep */ } }
  const { results: runs } = await db.prepare("SELECT id FROM pipeline_runs WHERE state IN ('QUEUED','RUNNING','WAITING') AND updated_at<? ORDER BY id LIMIT 50").bind(new Date(Date.now() - 2 * 60_000).toISOString()).all();
  for (const run of runs) { try { await advance(run.id); } catch { /* next sweep */ } }
  return { intakes: intakes.length, runs: runs.length };
}
