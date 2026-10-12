import { remote } from './git.mjs';
import { agentResult, agentTerminal } from './agent-policy.mjs';

const time = () => new Date().toISOString();
export async function saveAgent(db, env, job, snapshot, value) {
  const result = agentResult(value, job.id, snapshot.agent);
  if (result.state === 'succeeded' && (job.agent_publish !== 'APPLIED' || job.agent_proposal !== result.proposalCommitId)) throw Error('Agent publication unconfirmed');
  if (result.state === 'succeeded') {
    const repo = await env.ARTIFACTS.get(job.agent_fork);
    try {
      const commit = await repo.readCommit(result.proposalCommitId);
      if (commit?.treeHash !== result.proposalTreeId || JSON.stringify(commit.parents) !== JSON.stringify([snapshot.agent.commitId])) throw Error('Agent proposal identity differs');
    } finally { repo[Symbol.dispose](); }
  }
  await db.prepare('UPDATE evidence_jobs SET agent_state=?,agent_result=?,updated_at=? WHERE id=?')
    .bind(result.state, JSON.stringify(result), time(), job.id).run();
  job.agent_state = result.state; job.agent_result = JSON.stringify(result);
  return { id: job.id, state: result.state };
}

export async function agentStep(db, env, job, snapshot, artifact, phase) {
  if (job.agent_state === 'NONE' || agentTerminal.has(job.agent_state)) return { id: job.id, state: job.agent_state };
  const task = env.agentTasks.getByName(job.id);
  if (phase === 'finish-agents') {
    const result = await task.cancel();
    if (result.state === 'ABSENT') {
      await db.prepare("UPDATE evidence_jobs SET agent_state='cancelled',updated_at=? WHERE id=?").bind(time(), job.id).run();
      job.agent_state = 'cancelled';
      return { id: job.id, state: 'cancelled' };
    }
    return saveAgent(db, env, job, snapshot, result);
  }
  if (job.agent_state === 'REQUESTED') {
    const active = await db.prepare("SELECT count(*) AS total FROM evidence_jobs WHERE (test_state='RUNNING' OR agent_state IN ('FORK_PENDING','RUNNING')) AND state='QUEUED' AND expires_at>?").bind(time()).first();
    if (active.total >= 2) {
      await db.prepare("UPDATE evidence_jobs SET state='REFUSED',updated_at=? WHERE id=?").bind(time(), job.id).run();
      return { id: job.id, state: 'REFUSED' };
    }
    const name = 'repo-' + job.id.replaceAll('-', '');
    let target;
    try { target = await env.ARTIFACTS.get(name); await target.info(); throw Error('Agent fork target already exists'); }
    catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    finally { target?.[Symbol.dispose](); }
    await db.prepare("UPDATE evidence_jobs SET agent_state='FORK_PENDING',agent_fork=?,updated_at=? WHERE id=? AND agent_state='REQUESTED'")
      .bind(name, time(), job.id).run();
    job.agent_state = 'FORK_PENDING'; job.agent_fork = name;
    // A durable dispatch fence precedes fork; retries inspect this name only.
    await artifact(repo => repo.fork(name, { readOnly: false, defaultBranchOnly: false }));
  }
  if (job.agent_state === 'FORK_PENDING') {
    const repo = await env.ARTIFACTS.get(job.agent_fork);
    try {
      const info = await repo.info();
      if (info.name !== job.agent_fork || info.remote !== remote(env, job.agent_fork) || info.readOnly !== false ||
          info.source !== `artifacts:${env.ARTIFACTS_NAMESPACE}/${snapshot.artifactName}`) throw Error('Agent fork identity changed');
      const tokens = await repo.listTokens();
      if (!Array.isArray(tokens.tokens) || tokens.total !== tokens.tokens.length || tokens.total > 100) throw Error('Ambiguous fork token inventory');
      for (const token of tokens.tokens) if (token.state === 'active' && (!token.id || await repo.revokeToken(token.id) !== true)) throw Error('Fork token revocation unconfirmed');
      const commit = await repo.readCommit(snapshot.agent.commitId);
      if (commit?.treeHash !== snapshot.agent.treeId) throw Error('Agent fork source changed');
    } finally { repo[Symbol.dispose](); }
    await db.prepare("UPDATE evidence_jobs SET agent_state='RUNNING',updated_at=? WHERE id=? AND agent_state='FORK_PENDING'").bind(time(), job.id).run();
    job.agent_state = 'RUNNING';
  }
  await task.create({ jobId: job.id, ...snapshot.agent, remote: remote(env, job.agent_fork), deadline: Date.parse(job.expires_at) });
  const result = await task.status();
  if (['preparing', 'running', 'FINALIZING', 'CLEANUP_FAILED'].includes(result.state)) return { id: job.id, state: 'RUNNING' };
  return saveAgent(db, env, job, snapshot, result);
}

export async function agentSource(repo, treeId, path) {
  let tree = treeId;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const entries = await repo.readTree(tree), entry = entries?.find(e => e.name === parts[i]);
    if (!entry || (i < parts.length - 1 ? entry.type !== 'tree' : !['blob', 'exec'].includes(entry.type))) throw Error('Approved agent path is not a regular source file');
    tree = entry.hash;
  }
  const blob = await repo.readBlob(tree);
  if (!blob || blob.size > 256 * 1024) throw Error('Approved agent source exceeds its limit');
}
