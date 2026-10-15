import { ownerSlug } from './owners.mjs';
import { digest, uuidOK, Fault, deny, invalid, conflict } from './common.mjs';
import { gitRequest, packetLine, receiveCommand, receiveStatus, refusedRef, sessionRefused, sha, validRef, GitProviderError } from './git.mjs';
import { inventory, pullReviewContext } from './collaboration.mjs';
import { comparison } from './repository-diff.mjs';
import { discussionEvent } from './discussion-engagement.mjs';
import { enforceGitRules } from './repository-rules.mjs';
import { commitObject, packObjects, join, GitTreeError } from './git-objects.mjs';
import { mergeTrees } from './tree-merge.mjs';

export const pullMergeMethods = new Set(['SubmitStandardPullMerge', 'GetStandardPullMergeOperation']);
const encoder = new TextEncoder();
const idOK = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const nameOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
const writable = row => ['write', 'admin'].includes(row.role);
const unresolved = "phase IN ('RESERVED','DISPATCH_UNKNOWN')";
const columns = 'actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,detail,git_operation_id,created_at,updated_at';

// Exact Git object bytes: the commit ID is SHA-1 over "commit <size>\0" and this body.
export const mergeCommit = ({ tree, parents, name, email, time, message }) => commitObject({ tree, parents, author: { name, email, time }, message });
// Pack v2 holding one undeltified commit.
export const commitPack = body => packObjects([{ type: 'commit', body }]);
// One receive-pack command; report-status is the only capability requested, so the reply has no side-band.
export const receiveRequest = (old, next, ref, pack) => join(packetLine(`${old} ${next} ${ref}\0 report-status`), encoder.encode('0000'), pack);

// The push fence: current writer grant, identity and access generations, and a live credential for bearer callers.
function authority(person, row, idle = true) {
  return { sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
      LEFT JOIN repository_access_versions a ON a.repository_id=r.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' ${idle ? 'AND r.write_pending IS NULL' : ''} AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1
      AND COALESCE(a.version,0)=? AND COALESCE(v.version,0)=?
      AND (?='' OR EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=u.id AND revoked=0 AND expires_at>CAST(strftime('%s','now') AS INTEGER))))`,
    values: [row.id, row.artifact_name, person.id, row.access_version || 0, person.identity_version || 0, person.credential_digest || '', person.credential_digest || ''] };
}

// Responses and the journal list at most this many conflicting paths, with the full count beside them.
export const conflictLimit = 50;

// The commit a merge of head into base would write: its tree, the new tree and blob objects and its parents, or why not.
// A head that already contains the base keeps the head tree. Diverged branches get a three-way merge against their single
// merge base (bounded ancestry read; tree-merge.mjs merges by path, then text files line by line); lines or paths both
// sides changed differently are conflicts.
// A squash has the same tree and the base as its only parent.
export async function mergePlan(repo, base, head, method = 'merge') {
  if (base === head) return { blocker: 'nothing_to_merge' };
  let mergeBase;
  try { mergeBase = (await comparison(repo, base, head)).mergeBase; }
  catch (error) { if (!(error instanceof Fault)) throw error; return { blocker: 'ancestry_unproven' }; }
  if (mergeBase === head) return { blocker: 'nothing_to_merge' };
  const parents = method === 'squash' ? [base] : [base, head];
  const commits = await Promise.all([...new Set([mergeBase, base, head])].map(hash => repo.readCommit(hash)));
  const trees = new Map(commits.map(commit => [commit?.hash, commit?.treeHash]));
  if ([mergeBase, base, head].some(hash => !sha(trees.get(hash)))) throw Error('Invalid merge commit graph');
  if (mergeBase === base) return { blocker: '', mergeBase, tree: trees.get(head), objects: [], parents };
  let merged;
  try { merged = await mergeTrees(repo, trees.get(mergeBase), trees.get(base), trees.get(head)); }
  catch (error) { if (!(error instanceof GitTreeError)) throw error; merged = { treeId: null, conflicts: [{ path: error.path, reason: error.code }] }; }
  if (!merged.treeId) return { blocker: 'merge_conflict', conflicts: merged.conflicts.slice(0, conflictLimit).map(({ path, reason }) => ({ path, reason })), conflictCount: merged.conflicts.length };
  return { blocker: '', mergeBase, tree: merged.treeId, objects: merged.objects, parents };
}

// Everything a native merge request would currently refuse, then the merge itself; `blocker` is '' when it may proceed.
export async function mergeBlocker(db, row, d, current, repo, method) {
  if (d.state !== 'OPEN') return { blocker: 'pull_request_not_open' };
  if (d.draft) return { blocker: 'pull_request_draft' };
  if (current.base.retainedSnapshot || current.head.retainedSnapshot) return { blocker: 'branch_unavailable' };
  if (row.write_pending || await db.prepare(`SELECT 1 FROM pull_merge_operations WHERE pull_request_id=? AND ${unresolved}`).bind(d.pull_id).first()) return { blocker: 'write_unresolved' };
  return mergePlan(repo, current.base.commitId, current.head.commitId, method);
}

function wire(saved) {
  // The expected tree and the conflict list are journal evidence, not part of the original request.
  const { expectedTreeId, conflicts, conflictCount, ...original } = JSON.parse(saved.original), rejected = saved.phase === 'REJECTED';
  return { operationId: saved.operation_id, actorId: String(saved.actor_id), ...original, phase: 'STANDARD_PULL_MERGE_PHASE_' + saved.phase,
    mergeCommitId: saved.merge_commit_id, actualBaseCommitId: saved.actual_base_commit_id, failureCode: rejected ? 'preflight_refused' : '',
    ...(rejected ? { refusalCode: saved.detail, ...(conflicts ? { conflicts, conflictCount } : {}) } : {}),
    createdAt: saved.created_at, updatedAt: saved.updated_at, contract: 'golf.pull.standard-native-merge.v' + (original.sourceRepository ? 2 : 1) };
}

// An unknown outcome is settled only by reading the ref and the commit back. The pack is never sent again.
// Two minutes after it was sent, a merge whose branch does not hold its commit was not applied (the rule settleRefWrites uses for a
// push): it is refused and the repository released. Before that, a branch that has not moved yet stays unknown.
export const mergeSettleAfterMs = 120_000;
async function settle(db, env, person, row, saved, repo, providerFetch) {
  const git = await db.prepare('SELECT * FROM git_operations WHERE id=? AND repository_id=?').bind(saved.git_operation_id, row.id).first();
  if (!git) return;
  const observed = (await inventory(env, row, repo, providerFetch)).get(git.ref) || null;
  if (observed !== git.new_sha) {
    if (git.state !== 'DISPATCHED' || Date.now() - Date.parse(git.created_at) < (env.mergeSettleAfterMs ?? mergeSettleAfterMs)) return;
    const at = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE pull_merge_operations SET phase='REJECTED',detail=?,updated_at=? WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN'")
        .bind(observed === git.old_sha ? 'provider_refused' : 'pull_request_changed', at, saved.actor_id, saved.operation_id),
      db.prepare("INSERT OR IGNORE INTO git_ref_writes(operation_id,repository_id,ref,outcome,settled_at) SELECT ?,?,?,'NOT_APPLIED',? WHERE changes()=1").bind(git.id, row.id, git.ref, at),
      db.prepare('UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=?').bind(row.id, git.id),
    ]);
    return;
  }
  const commit = await repo.readCommit(git.new_sha), original = JSON.parse(saved.original), head = original.headCommitId;
  // A squash has the base as its only parent; a merge has base then head. Operations journaled with an expected tree
  // (every squash, and every merge since tree merges) must read back with exactly that tree.
  const parents = original.method === 'squash' ? [git.old_sha] : [git.old_sha, head];
  if (commit?.hash !== git.new_sha || commit.parents?.length !== parents.length || parents.some((parent, index) => commit.parents[index] !== parent) ||
      (original.expectedTreeId || original.method === 'squash') && commit.treeHash !== original.expectedTreeId) return;
  const pull = await db.prepare('SELECT discussion_id FROM pull_requests WHERE id=?').bind(saved.pull_request_id).first();
  const time = new Date().toISOString(), values = [saved.actor_id, saved.operation_id, time];
  const done = "EXISTS(SELECT 1 FROM pull_merge_operations WHERE actor_id=? AND operation_id=? AND phase='SUCCEEDED' AND updated_at=?)";
  // The journal, the push reservation, the pinned comparison and the closed discussion change together.
  await db.batch([
    db.prepare("UPDATE pull_merge_operations SET phase='SUCCEEDED',merge_commit_id=?,actual_base_commit_id=?,updated_at=? WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN'")
      .bind(git.new_sha, commit.parents[0], time, saved.actor_id, saved.operation_id),
    db.prepare(`UPDATE git_operations SET state='APPLIED' WHERE id=? AND state='DISPATCHED' AND ${done}`).bind(git.id, ...values),
    db.prepare(`UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=? AND ${done}`).bind(row.id, git.id, ...values),
    db.prepare(`UPDATE pull_requests SET base_commit=?,head_commit=? WHERE id=? AND ${done}`).bind(git.old_sha, head, saved.pull_request_id, ...values),
    db.prepare(`UPDATE discussions SET state='CLOSED',revision=revision+1,updated_at=? WHERE id=? AND ${done}`).bind(time, pull.discussion_id, ...values),
    ...discussionEvent(db, person, pull.discussion_id, time, 'merge_pull', {}, done, values),
  ]);
}

function intent(body, target, key) {
  const text = (value, limit, title) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || encoder.encode(value).length > limit || new TextDecoder().decode(encoder.encode(value)) !== value ||
        /\p{Cc}/u.test(title ? value : value.replace(/[\t\n\r]/g, '')) || title && value.trim() !== value) invalid('Use a trimmed merge title up to 255 bytes and a message up to 6,000 bytes.');
    return value;
  };
  if (!/^[a-f0-9]{64}$/.test(body.expectedPullRevision || '') || !sha(target.headCommitId) || !sha(target.baseCommitId)) invalid('Bind the original operation, revision and full head/base commits.');
  if (![body.sourceRef, body.targetRef].every(ref => typeof ref === 'string' && !ref.startsWith('refs/') && validRef('refs/heads/' + ref))) invalid('Select current named source and target branches.');
  if (![undefined, '', 'merge', 'squash'].includes(body.method)) invalid('Choose merge or squash; other integration methods are unavailable.');
  const title = text(body.commitTitle, 255, true), message = text(body.commitMessage, 6000), method = body.method || 'merge';
  const bound = body.sourceRepository !== undefined || Boolean(body.sourceRepositoryId) || Boolean(body.sourceOwnerId);
  if (bound && (!nameOK(body.sourceRepository?.owner) || !nameOK(body.sourceRepository?.name) || !idOK(body.sourceRepositoryId) || !idOK(body.sourceOwnerId))) invalid('Bind the exact source repository and owner identity.');
  if (body.sourceRef === body.targetRef && (!bound || body.sourceRepositoryId === target.repositoryId)) invalid('Choose different branches within the same repository.');
  const source = bound ? { sourceRepository: { owner: body.sourceRepository.owner, name: body.sourceRepository.name }, sourceRepositoryId: body.sourceRepositoryId, sourceOwnerId: body.sourceOwnerId } : {};
  // Receipt identity only; title and message exist in the fingerprint and the commit, not in D1.
  const original = { repository: key, repositoryId: target.repositoryId, ownerId: body.ownerId, pullRequestId: target.pullRequestId, number: target.number,
    expectedPullRevision: body.expectedPullRevision, headCommitId: target.headCommitId, observedBaseCommitId: target.baseCommitId, sourceRef: body.sourceRef, targetRef: body.targetRef, method, ...source };
  return { title, message, original, fingerprint: JSON.stringify(['native.standard-merge.v1', original, title, message]) };
}

// options (land-queue.mjs only): guard(idle) replaces the writer authority with the agentic mode policy's ({sql, values}), and author
// replaces the commit identity ({name, email}). Everything else, the journal, the reservation and the readback, is this same path.
export async function standardPullMerge(db, env, person, row, method, body, artifact, providerFetch, options = {}) {
  const authorize = idle => options.guard ? options.guard(idle) : authority(person, row, idle);
  const submit = method === 'SubmitStandardPullMerge', target = submit ? body.selection : body, key = { owner: ownerSlug(row, env), name: row.name };
  if (!target || !uuidOK(body.operationId) || !idOK(target.repositoryId) || !idOK(target.pullRequestId) || !idOK(body.ownerId) ||
      !Number.isInteger(target.number) || target.number < 1 || target.number > 4294967295) invalid('Select the original merge operation and exact pull request.');
  // Writer authority is rechecked for every submit and inspection; a lost grant reveals no receipt.
  if (!writable(row) || target.repositoryId !== String(row.id) || body.ownerId !== String(row.workspace_id) || target.repository?.owner !== key.owner || target.repository?.name !== key.name) deny();
  const requested = submit ? intent(body, target, key) : null, hash = requested && await digest(requested.fingerprint);
  const find = () => db.prepare('SELECT * FROM pull_merge_operations WHERE actor_id=? AND operation_id=?').bind(person.id, body.operationId).first();
  let saved = await find();
  if (saved) {
    if (saved.repository_id !== row.id || String(saved.pull_request_id) !== target.pullRequestId || JSON.parse(saved.original).number !== target.number) deny();
    if (submit && saved.input_hash !== hash) throw new Fault('failed_precondition', 412, 'The original merge operation has a different intent. Inspect its original outcome.');
    if (saved.phase === 'DISPATCH_UNKNOWN') await artifact(repo => settle(db, env, person, row, saved, repo, providerFetch));
  } else {
    if (!submit) deny();
    const { d, current } = await pullReviewContext(db, env, person, row, target, artifact);
    if (await db.prepare(`SELECT 1 FROM pull_merge_operations WHERE pull_request_id=? AND ${unresolved}`).bind(d.pull_id).first())
      throw new Fault('failed_precondition', 412, 'Inspect the original merge operation; an unresolved operation cannot be retried or replaced.');
    if (row.write_pending) conflict();
    const { original, title, message } = requested, ref = 'refs/heads/' + d.base_branch, time = new Date().toISOString(), guard = authorize(true);
    const journal = (evidence = {}) => [person.id, body.operationId, row.id, d.pull_id, hash, JSON.stringify({ ...original, ...evidence })];
    await artifact(async repo => {
      let plan, refusal = original.sourceRepository ? 'fork_source_unsupported'
        : body.expectedPullRevision !== current.revision || target.headCommitId !== current.head.commitId || target.baseCommitId !== current.base.commitId ||
          body.sourceRef !== d.head_branch || body.targetRef !== d.base_branch ? 'pull_request_changed' : '';
      if (!refusal) { plan = await mergeBlocker(db, row, d, current, repo, original.method); refusal = plan.blocker; }
      let rules;
      if (!refusal) try { rules = await enforceGitRules(db, row, person, ref); } catch (error) { if (error?.code !== 'permission_denied') throw error; refusal = 'target_locked'; }
      if (refusal) {
        // Nothing was sent. The refusal is a durable receipt under the same current writer authority.
        const evidence = plan?.conflicts ? { conflicts: plan.conflicts, conflictCount: plan.conflictCount } : {};
        const refused = await db.prepare(`INSERT INTO pull_merge_operations(${columns}) SELECT ?,?,?,?,?,?,'REJECTED',?,NULL,?,? WHERE ${guard.sql}`).bind(...journal(evidence), refusal, time, time, ...guard.values).run();
        if (refused.meta.changes !== 1) deny();
        return;
      }
      const clean = value => String(value || '').replace(/[<>\p{Cc}]/gu, '').trim(), login = clean(person.login).replace(/[\s@]/g, '');
      const subject = String(d.title || '').replace(/\p{Cc}+/gu, ' ').trim();
      const fallback = original.method !== 'squash' ? `Merge pull request #${d.number} from ${d.head_branch} into ${d.base_branch}`
        : subject ? `${subject} (#${d.number})` : `Squash pull request #${d.number} from ${d.head_branch} into ${d.base_branch}`;
      const commit = await mergeCommit({ tree: plan.tree, parents: plan.parents, name: options.author?.name || clean(person.full_name) || login,
        email: options.author?.email || `${login}@users.noreply.${new URL(env.PUBLIC_ORIGIN).hostname}`, time: Math.floor(Date.parse(time) / 1000),
        message: ((title || fallback) + (message ? '\n\n' + message : '')).replace(/\n+$/, '') + '\n' });
      // The commit plus the trees and line-merged blobs only a three-way merge creates; every other object already exists in the repository.
      const request = receiveRequest(current.base.commitId, commit.id, ref, await packObjects([commit, ...plan.objects]));
      // The same single-ref grammar, reservation and journal as a brokered push, plus the exact pull request revision.
      const command = receiveCommand(request), operation = crypto.randomUUID();
      const reserved = await db.batch([
        db.prepare(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) SELECT ?,?,?,?,?,?,'DISPATCHED',? WHERE ${guard.sql}
          AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=?),0)=?
          AND EXISTS(SELECT 1 FROM discussions WHERE id=? AND repository_id=? AND revision=? AND state='OPEN')
          AND NOT EXISTS(SELECT 1 FROM pull_merge_operations WHERE pull_request_id=? AND phase!='REJECTED')`)
          .bind(operation, row.id, person.id, command.ref, command.old, command.next, time, ...guard.values, row.id, rules, d.id, row.id, d.revision, d.pull_id),
        db.prepare('UPDATE repositories SET write_pending=? WHERE id=? AND write_pending IS NULL AND changes()=1 AND EXISTS(SELECT 1 FROM git_operations WHERE id=?)').bind(operation, row.id, operation),
        db.prepare(`INSERT INTO pull_merge_operations(${columns}) SELECT ?,?,?,?,?,?,'DISPATCH_UNKNOWN','',?,?,? WHERE EXISTS(SELECT 1 FROM repositories WHERE id=? AND write_pending=?)`)
          .bind(...journal({ expectedTreeId: plan.tree }), operation, time, time, row.id, operation),
      ]);
      if (reserved[2].meta.changes !== 1) conflict();
      // From here every failure is an unknown outcome: journaled, fenced like an unconfirmed push and never resent.
      let detail = 'provider_unavailable', reply;
      try { reply = (await gitRequest(env, repo, row.artifact_name, 'git-receive-pack', 'git-receive-pack', request, providerFetch)).bytes; detail = receiveStatus(reply, command.ref); if (detail) detail = 'provider_status: ' + detail; }
      catch (error) { if (error instanceof GitProviderError) detail = 'provider_error: ' + error.message; }
      try { await settle(db, env, person, row, await find(), repo, providerFetch); } catch { detail ||= 'readback_unavailable'; }
      // The provider refused this update (ng, typically because another merge moved the base first) and the branch does not hold the merge: nothing was
      // applied, so the receipt is a refusal like any other moved base and the repository is released at once, not left for maintenance.
      // So did a session the provider ended with Git's error packet before running any command (ERR, e.g. busy).
      if (reply && (refusedRef(reply, command.ref) || sessionRefused(reply)) && (await find())?.phase === 'DISPATCH_UNKNOWN') {
        let observed = null;
        try { observed = (await inventory(env, row, repo, providerFetch)).get(command.ref) || null; } catch { /* unknown stays unknown */ }
        if (observed && observed !== command.next) {
          const at = new Date().toISOString();
          await db.batch([
            // A moved base is an ordinary changed pull request; a refusal that left the base where it was is the provider's own.
            db.prepare("UPDATE pull_merge_operations SET phase='REJECTED',detail=?,updated_at=? WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN'").bind(observed === command.old ? 'provider_refused' : 'pull_request_changed', at, person.id, body.operationId),
            db.prepare("INSERT OR IGNORE INTO git_ref_writes(operation_id,repository_id,ref,outcome,settled_at) SELECT ?,?,?,'NOT_APPLIED',? WHERE changes()=1").bind(operation, row.id, command.ref, at),
            db.prepare('UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=?').bind(row.id, operation),
          ]);
          return;
        }
      }
      // The provider's own answer stays on the row as evidence, also when the readback then confirms the merge.
      await db.prepare("UPDATE pull_merge_operations SET detail=CASE WHEN ?='' AND phase='DISPATCH_UNKNOWN' THEN 'readback_unconfirmed' ELSE ? END WHERE actor_id=? AND operation_id=?").bind(detail, detail, person.id, body.operationId).run();
    });
  }
  saved = await find();
  const current = authorize(false);
  if (!saved || !await db.prepare(`SELECT 1 AS allowed WHERE ${current.sql}`).bind(...current.values).first()) deny();
  return { operation: wire(saved) };
}
