import { repositoryRefs, recordPipelineIntake, dispatchPipelineIntake } from './actions-intake.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { refusedRef } from './git.mjs';
import { recordRefWrite } from './contributions.mjs';

// The branch-level push fence (schema 37), shared by /git/ pushes, agent task pushes and the Source API. A pull request merge reserves
// its repository through repositories.write_pending, which keeps merges, rules, settings and reviews ordered; a branch write waits for
// it only when it writes the merge's base or the head of the pull request being merged. Other branches are independent in Git: with
// agents landing all the time, a repository-wide wait starved them (half of all pushes and Source API commits refused at ~110 agents).
// A write_pending that is not a known merge still holds every branch.
const zero = '0'.repeat(40);
export const mergeHoldsRef = `EXISTS(SELECT 1 FROM repositories mr LEFT JOIN git_operations mg ON mg.id=mr.write_pending
  LEFT JOIN pull_merge_operations mm ON mm.git_operation_id=mg.id LEFT JOIN pull_requests mp ON mp.id=mm.pull_request_id
  WHERE mr.id=? AND mr.write_pending IS NOT NULL AND (mm.git_operation_id IS NULL OR mg.ref=? OR 'refs/heads/'||mp.head_branch=?))`;
export const mergeHoldsValues = (repositoryId, ref) => [repositoryId, ref, ref];
export async function mergeHolds(db, repositoryId, ref) {
  return Boolean(await db.prepare(`SELECT 1 AS held WHERE ${mergeHoldsRef}`).bind(...mergeHoldsValues(repositoryId, ref)).first());
}

// The journal row and its ref fence commit together, under the caller's authority guard ({sql, values}: grant, versions, credential)
// evaluated in the same INSERT. False when not admitted: a held repository, an unsettled write to the same ref or a changed authority.
export async function reserveRefWrite(db, { id, repositoryId, userId, command, guard, time = new Date().toISOString() }) {
  try {
    const [, fenced] = await db.batch([
      db.prepare(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) SELECT ?,?,?,?,?,?,'DISPATCHED',?
        WHERE NOT ${mergeHoldsRef}
        AND NOT EXISTS(SELECT 1 FROM git_ref_writes WHERE repository_id=? AND ref=? AND outcome IS NULL) AND ${guard.sql}`)
        .bind(id, repositoryId, userId, command.ref, command.old, command.next, time, ...mergeHoldsValues(repositoryId, command.ref), repositoryId, command.ref, ...guard.values),
      db.prepare('INSERT INTO git_ref_writes(operation_id,repository_id,ref) SELECT ?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM git_operations WHERE id=?)')
        .bind(id, repositoryId, command.ref, id),
    ]);
    return fenced.meta.changes === 1;
  } catch (error) {
    // Two reservations racing past the check meet the unique index; the loser is an ordinary conflict.
    if (/UNIQUE constraint failed/.test(String(error?.message))) return false;
    throw error;
  }
}

// Why a reservation was not admitted: a merge (or legacy write) holding this ref, an unsettled write to the same ref, or neither
// (the caller's authority changed).
export async function refWriteBlocker(db, repositoryId, ref) {
  const state = await db.prepare(`SELECT ${mergeHoldsRef} AS held,EXISTS(SELECT 1 FROM git_ref_writes WHERE repository_id=? AND ref=? AND outcome IS NULL) AS busy`)
    .bind(...mergeHoldsValues(repositoryId, ref), repositoryId, ref).first();
  return state?.held ? 'repository' : state?.busy ? 'branch' : '';
}

// Sends one fenced ref update and reads the ref back. The provider can fail an update that runs alongside others in the same repository
// without reporting it refused; while the ref still holds the old commit the same compare-and-swap is sent again (a copy that did land
// is refused by its stale old value and then reads back as applied). Returns {result, applied, refused, retried}; rethrows the last
// provider error when the outcome stays unknown.
export async function sendRefUpdate({ send, read, command, attempts = 5, pause = attempt => new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt)) }) {
  let result, failure;
  for (let attempt = 0; ; attempt++) {
    result = undefined; failure = undefined;
    try { result = await send(); } catch (error) { failure = error; }
    let observed;
    try { observed = await read(); } catch (error) { failure ??= error; break; }
    if (observed === command.next) return { result, applied: true, refused: false, retried: attempt };
    if (result && refusedRef(result.bytes, command.ref)) return { result, applied: false, refused: true, retried: attempt };
    console.log(JSON.stringify({ event: 'golf.ref_update_unconfirmed', attempt: attempt + 1, moved: observed !== command.old, reason: failure ? String(failure.message).slice(0, 160) : 'no ref status' }));
    if (observed !== command.old || attempt + 1 >= attempts) break;
    await pause(attempt);
  }
  if (failure) throw failure;
  return { result, applied: false, refused: false, retried: attempts - 1 };
}

// Confirmed by reading the ref back: APPLIED (the state transition the webhook and email triggers observe) and the fence released, with
// the caller's own statements. Refused (the provider reported `ng` and the ref does not hold the new commit): NOT_APPLIED at once, so a
// lost race costs the client a retry, not the repository. Unknown: the ref alone stays fenced until settleRefWrites.
export async function finishRefWrite(db, { id, repositoryId, applied, refused = false, ciState = 'NONE', statements = [] }) {
  if (!applied && refused) {
    await db.prepare("UPDATE git_ref_writes SET outcome='NOT_APPLIED',settled_at=? WHERE operation_id=? AND outcome IS NULL").bind(new Date().toISOString(), id).run();
    return;
  }
  // Unknown: only this ref stays fenced (its row keeps outcome NULL) until settleRefWrites; other branches are independent in Git, and a
  // merge onto this one is kept out by the git_ref_writes_fence trigger. git_ref_unknown keeps rule, settings and merge changes waiting.
  if (!applied) {
    try { await db.prepare('INSERT OR IGNORE INTO git_ref_unknown(operation_id,repository_id,created_at) VALUES(?,?,?)').bind(id, repositoryId, new Date().toISOString()).run(); } catch { /* the ref fence holds */ }
    return;
  }
  await db.batch([
    db.prepare("UPDATE git_operations SET state='APPLIED',ci_state=? WHERE id=? AND state='DISPATCHED'").bind(ciState, id),
    db.prepare('DELETE FROM git_ref_writes WHERE operation_id=?').bind(id),
    db.prepare('UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=?').bind(repositoryId, id),
    ...statements,
  ]);
  // Contribution graphs: a write to the default branch makes its Git walk due (never fails the write).
  await recordRefWrite(db, id);
}

// Maintenance: a write still fencing its ref or its repository two minutes on, outside a pull request merge (which settles itself), is
// settled by reading the ref: APPLIED when it holds new_sha, else NOT_APPLIED. Each settlement is audited; at most `limit` per sweep.
export async function settleRefWrites(env, withArtifact, limit = 20) {
  const db = env.DB.withSession('first-primary');
  if (!(await db.prepare('PRAGMA table_info(git_ref_writes)').all()).results.length) return { processed: 0 };
  const { results } = await db.prepare(`SELECT g.id,g.repository_id,g.user_id,g.ref,g.old_sha,g.new_sha,r.artifact_name,
      (SELECT t.id FROM agent_tasks t WHERE t.repository_id=g.repository_id AND t.requested_by=g.user_id AND 'refs/heads/'||t.branch=g.ref LIMIT 1) AS task_id
    FROM git_operations g JOIN repositories r ON r.id=g.repository_id LEFT JOIN git_ref_writes w ON w.operation_id=g.id
    WHERE g.state='DISPATCHED' AND g.created_at<? AND r.state='ACTIVE' AND (w.operation_id IS NOT NULL AND w.outcome IS NULL OR r.write_pending=g.id)
      AND NOT EXISTS(SELECT 1 FROM pull_merge_operations m WHERE m.git_operation_id=g.id) ORDER BY g.created_at,g.id LIMIT ?`)
    .bind(new Date(Date.now() - 120_000).toISOString(), limit).all();
  let processed = 0;
  for (const op of results) {
    let observed;
    try { observed = (await withArtifact(env, op, repo => repositoryRefs(env, repo, op))).get(op.ref) || zero; }
    catch { console.log(JSON.stringify({ event: 'golf.ref_write_settle_unavailable', operation: op.id })); continue; }
    const applied = observed === op.new_sha, outcome = applied ? 'APPLIED' : 'NOT_APPLIED', time = new Date().toISOString();
    const [settled] = await db.batch([
      applied ? db.prepare("UPDATE git_operations SET state='APPLIED' WHERE id=? AND state='DISPATCHED'").bind(op.id)
        : db.prepare(`INSERT INTO git_ref_writes(operation_id,repository_id,ref,outcome,settled_at) SELECT ?,?,?,'NOT_APPLIED',? WHERE EXISTS(SELECT 1 FROM git_operations WHERE id=? AND state='DISPATCHED')
          ON CONFLICT(operation_id) DO UPDATE SET outcome='NOT_APPLIED',settled_at=excluded.settled_at WHERE outcome IS NULL`).bind(op.id, op.repository_id, op.ref, time, op.id),
      db.prepare(`INSERT OR IGNORE INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client)
        SELECT ?,0,'','repository',?,?,'git_write.settle',NULL,?,0,?,? WHERE changes()=1`).bind(time, String(op.repository_id), op.ref,
        JSON.stringify({ operationId: op.id, outcome, commitId: op.new_sha.slice(0, 12) }), 'audit:git_write.settle:0:' + op.id, JSON.stringify({ via: 'maintenance', outcome: 'success' })),
      ...(applied ? [db.prepare('DELETE FROM git_ref_writes WHERE operation_id=?').bind(op.id)] : []),
      db.prepare('UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=?').bind(op.repository_id, op.id),
      db.prepare('DELETE FROM git_ref_unknown WHERE operation_id=?').bind(op.id),
      ...(applied && op.task_id ? [db.prepare("UPDATE agent_tasks SET commit_id=?,updated_at=? WHERE id=? AND state='RUNNING'").bind(op.new_sha, time, op.task_id)] : []),
    ]);
    if (settled.meta.changes !== 1) continue;
    processed++;
    if (applied) await recordRefWrite(db, op.id);
    console.log(JSON.stringify({ event: 'golf.ref_write_settled', operation: op.id, outcome }));
    // A task branch records no pipeline intake, as its live push does not.
    if (applied && !op.task_id && pipelinePolicy(env) && op.new_sha !== zero) {
      try { await dispatchPipelineIntake(env, await recordPipelineIntake(db, env, op.repository_id, 'push', { ref: op.ref, before: op.old_sha, after: op.new_sha, actorId: op.user_id, operationId: op.id }, 'push:' + op.id), withArtifact); }
      catch { console.log(JSON.stringify({ event: 'golf.pipeline_intake_record_failed' })); }
    }
  }
  return { processed };
}
