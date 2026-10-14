import { ownerSlug } from './owners.mjs';
import { discussionEvent } from './discussion-engagement.mjs';
import { discussionMetadata, metadataBatch, metadataFilter, metadataChange, resourceAuthority, authorityValues } from './discussion-resources.mjs';
import { digest, uuidOK, Fault, deny, invalid, unsupported, conflict, page, user } from './common.mjs';
import { advertisedRefs, gitRequest, sha, validRef } from './git.mjs';
import { comparison, diff } from './repository-diff.mjs';
import { wireCommit } from './repository-reads.mjs';

export const collaborationMethods = new Set([
  'CreateIssue', 'GetIssue', 'ListIssues', 'UpdateIssue', 'CreateIssueComment', 'ListIssueComments', 'GetIssueMutation',
  'CreatePullRequest', 'GetPullRequest', 'ListPullRequests', 'UpdatePullRequest', 'GetPullRequestDiscussion',
  'CreatePullRequestReview', 'GetPullRequestReviewMutation', 'ListPullRequestReviews', 'ListPullRequestChecks',
  'ListPullRequestCommits', 'GetPullRequestDiff',
]);
const idOK = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const issueKinds = ['UNSPECIFIED', 'OPEN', 'CLOSED', 'ALL'];
const reviewKinds = ['UNSPECIFIED', 'APPROVED', 'PENDING', 'COMMENT', 'REQUEST_CHANGES', 'REQUEST_REVIEW'];
const checkKinds = ['UNSPECIFIED', 'PENDING', 'SUCCESS', 'FAILURE', 'ERROR', 'WARNING', 'SKIPPED'];
const writable = row => ['write', 'admin'].includes(row.role);
const timestamp = () => new Date().toISOString();
const changed = () => { throw new Fault('failed_precondition', 412, 'The selected discussion or commits changed. Refresh before retrying.'); };
// At most one SUCCEEDED merge exists per pull request (pull_merge_one_success).
const pullColumns = 'p.id AS pull_id,p.base_branch,p.head_branch,p.base_commit,p.head_commit,p.draft,m.merge_commit_id,m.updated_at AS merged_at';
const pullJoin = "JOIN pull_requests p ON p.discussion_id=d.id LEFT JOIN pull_merge_operations m ON m.pull_request_id=p.id AND m.phase='SUCCEEDED'";

function enumeration(value, prefix, values, fallback) {
  if (value === undefined || value === 0 || value === prefix + 'UNSPECIFIED') return fallback;
  const result = typeof value === 'number' ? values[value] : typeof value === 'string' ? value.replace(prefix, '') : undefined;
  if (!values.includes(result) || result === 'UNSPECIFIED') invalid('Invalid state.');
  return result;
}
function text(value, limit, title = false) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit || value.includes('\0') ||
      new TextDecoder().decode(new TextEncoder().encode(value)) !== value ||
      title && (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))) invalid('Invalid text or text limit exceeded.');
  return value;
}
function number(value) {
  if (!Number.isInteger(value) || value < 1 || value > 4294967295) invalid('Use a positive discussion number.');
  return value;
}
function exactRepository(body, row) {
  if (!idOK(body.repositoryId) || body.repositoryId !== String(row.id)) deny();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
async function operation(db, person, row, method, body) {
  if (!uuidOK(body.idempotencyKey)) invalid('Use a canonical UUID v4 operation key.');
  const hash = await digest(JSON.stringify(stable(body)));
  const saved = await db.prepare('SELECT * FROM collaboration_operations WHERE user_id=? AND operation_key=?').bind(person.id, body.idempotencyKey).first();
  if (saved && (saved.repository_id !== row.id || saved.method !== method || saved.input_hash !== hash)) {
    throw new Fault('already_exists', 409, 'Operation key belongs to different inputs.');
  }
  return { saved, hash, id: crypto.randomUUID(), time: timestamp() };
}
function admission(db, person, row, method, body, op, kind, resultId, discussion) {
  // The receipt and all effects share a transaction; authority changes refuse the entire effect.
  const authority = resourceAuthority.replace("g.role='admin'", "g.role=?");
  const values = authorityValues(row, person); values.splice(3, 0, row.role);
  return db.prepare(`INSERT INTO collaboration_operations(id,user_id,repository_id,operation_key,method,input_hash,result_kind,result_id,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${authority}
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?
    ${person.credential_digest ? 'AND EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=? AND revoked=0 AND expires_at>unixepoch())' : ''}
    ${discussion ? 'AND EXISTS(SELECT 1 FROM discussions WHERE id=? AND repository_id=? AND revision=?)' : ''}`)
    .bind(op.id, person.id, row.id, body.idempotencyKey, method, op.hash, kind, resultId, op.time, ...values, person.id, person.identity_version,
      ...(person.credential_digest ? [person.credential_digest, person.id] : []), ...(discussion ? [discussion.id, row.id, discussion.revision] : []));
}
const admitted = 'EXISTS(SELECT 1 FROM collaboration_operations WHERE id=?)';
async function nextId(db, table) { return (await db.prepare(`SELECT max(COALESCE((SELECT max(id) FROM ${table}),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name=?),0))+1 AS id`).bind(table).first()).id; }
async function commitMutation(db, statements) {
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) changed();
}

export async function operationRepository(db, person, key) {
  if (!uuidOK(key)) invalid('Use the original operation key.');
  const row = await db.prepare(`SELECT r.*,g.role FROM collaboration_operations o JOIN repositories r ON r.id=o.repository_id
    JOIN grants g ON g.repository_id=r.id AND g.user_id=? WHERE o.user_id=? AND o.operation_key=? AND r.state='ACTIVE'`).bind(person.id, person.id, key).first();
  if (!row) deny();
  return row;
}
async function author(db, id) {
  const row = await db.prepare('SELECT u.id,u.login,u.email,COALESCE(p.full_name,u.full_name) AS full_name FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=?').bind(id).first();
  if (!row) throw Error('Missing discussion author');
  return user(row);
}
async function authorBatch(db, entries) {
  if (!entries.length) return new Map();
  const ids = JSON.stringify([...new Set(entries.map(row => row.author_id))]);
  const rows = await db.prepare(`SELECT u.id,u.login,u.email,COALESCE(p.full_name,u.full_name) AS full_name FROM users u
    LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id IN (SELECT value FROM json_each(?))`).bind(ids).all();
  return new Map(rows.results.map(row => [row.id, user(row)]));
}
async function discussion(db, repository, num, kind) {
  const row = await db.prepare('SELECT * FROM discussions WHERE repository_id=? AND number=? AND kind=?').bind(repository.id, number(num), kind).first();
  if (!row) deny();
  return row;
}
async function pullRow(db, repository, num) {
  const row = await db.prepare(`SELECT d.*,${pullColumns} FROM discussions d ${pullJoin} WHERE d.repository_id=? AND d.number=? AND d.kind='pull'`).bind(repository.id, number(num)).first();
  if (!row) deny();
  return row;
}
function url(env, repository, d) {
  return `${env.PUBLIC_ORIGIN}/${ownerSlug(repository,env)}/${repository.name}/${d.kind === 'pull' ? 'pull' : 'issues'}/${d.number}`;
}
async function issue(db, env, repository, d, metadata, authors) {
  const counts = d.comment_count === undefined ? await db.prepare('SELECT count(*) AS total FROM discussion_comments WHERE discussion_id=?').bind(d.id).first() : { total: d.comment_count };
  return { id: String(d.id), number: d.number, title: d.title, body: d.body, state: 'ISSUE_STATE_' + d.state,
    user: authors?.get(d.author_id) || await author(db, d.author_id), comments: counts.total, createdAt: d.created_at, updatedAt: d.updated_at,
    htmlUrl: url(env, repository, d), revision: await digest(JSON.stringify([d.id, d.revision])),
    metadata: metadata || await discussionMetadata(db, d) };
}
export async function inventory(env, row, repo, providerFetch) {
  return advertisedRefs((await gitRequest(env, repo, row.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, providerFetch)).bytes);
}
async function pull(db, env, repository, d, refs, metadata, authors) {
  // A merged proposal keeps the exact comparison pinned at merge time; its live base already contains the head.
  const merged = Boolean(d.merge_commit_id);
  const base = !merged && refs.get('refs/heads/' + d.base_branch), head = !merged && refs.get('refs/heads/' + d.head_branch);
  const baseCommit = base || d.base_commit, headCommit = head || d.head_commit;
  return { id: String(d.pull_id), number: d.number, title: d.title, body: d.body, state: 'ISSUE_STATE_' + d.state,
    user: authors?.get(d.author_id) || await author(db, d.author_id), createdAt: d.created_at, updatedAt: d.updated_at, htmlUrl: url(env, repository, d),
    draft: Boolean(d.draft), merged, ...(merged ? { mergedAt: d.merged_at, mergeCommitId: d.merge_commit_id } : {}),
    head: { repositoryId: String(repository.id), label: `${ownerSlug(repository,env)}:${d.head_branch}`, ref: d.head_branch, commitId: headCommit, retainedSnapshot: !head },
    base: { repositoryId: String(repository.id), label: `${ownerSlug(repository,env)}:${d.base_branch}`, ref: d.base_branch, commitId: baseCommit, retainedSnapshot: !base },
    revision: await digest(JSON.stringify([d.id, d.revision, baseCommit, headCommit, Boolean(d.draft)])),
    metadata: metadata || await discussionMetadata(db, d) };
}
async function comment(db, env, repository, d, c, person, authors) {
  return { id: String(c.id), user: authors?.get(c.author_id) || await author(db, c.author_id), body: c.body, createdAt: c.created_at, updatedAt: c.updated_at,
    htmlUrl: url(env, repository, d) + '#issuecomment-' + c.id, revision: await digest(JSON.stringify([c.id, c.revision])),
    canEdit: c.author_id === person.id || repository.role === 'admin', canDelete: c.author_id === person.id || repository.role === 'admin' };
}
export async function review(db, env, repository, d, r, current, authors) {
  const lifecycle = r.dismissed === undefined ? await db.prepare('SELECT dismissed,updated_at FROM pull_review_lifecycle WHERE review_id=?').bind(r.id).first() : r;
  return { id: String(r.id), user: authors?.get(r.author_id) || await author(db, r.author_id), body: r.body, state: 'PULL_REQUEST_REVIEW_STATE_' + (r.draft_status==='PENDING'?'PENDING':r.state),
    commitId: r.head_commit, stale: r.head_commit !== current.head.commitId || r.base_commit !== current.base.commitId || !current.merged && (current.head.retainedSnapshot || current.base.retainedSnapshot),
    dismissed: Boolean(lifecycle?.dismissed), official: false, submittedAt: r.draft_status==='PENDING'?'':r.created_at, updatedAt: [r.draft_updated_at,lifecycle?.updated_at,r.created_at].filter(Boolean).sort().at(-1),
    htmlUrl: url(env, repository, d) + '#pullreview-' + r.id, commentsCount: 0 };
}
async function check(db, c, authors) {
  return { id: String(c.id), context: c.context, state: 'REPORTED_CHECK_STATE_' + c.state, description: c.description,
    creator: authors?.get(c.author_id) || await author(db, c.author_id), createdAt: c.created_at, updatedAt: c.created_at, targetUrl: c.target_url };
}
async function result(db, env, person, repository, op, artifact) {
  const common = { id: op.id, idempotencyKey: op.operation_key, state: 'ISSUE_MUTATION_STATE_SUCCEEDED',
    repository: { owner: ownerSlug(repository,env), name: repository.name }, repositoryId: String(repository.id), createdAt: op.created_at, updatedAt: op.created_at };
  if (op.result_kind === 'check') {
    const c = await db.prepare('SELECT * FROM reported_checks WHERE id=? AND repository_id=?').bind(op.result_id, repository.id).first();
    if (!c) deny();
    return { operationId: op.id, check: await check(db, c) };
  }
  let d;
  if (op.result_kind === 'comment') {
    const c = await db.prepare('SELECT * FROM discussion_comments WHERE id=?').bind(op.result_id).first();
    if (!c) deny();
    d = await db.prepare('SELECT * FROM discussions WHERE id=? AND repository_id=?').bind(c.discussion_id, repository.id).first();
    if (!d) deny();
    return { mutation: { ...common, kind: 'ISSUE_MUTATION_KIND_CREATE_COMMENT', issueId: String(d.id), number: d.number, commentId: String(c.id) }, comment: await comment(db, env, repository, d, c, person) };
  }
  if (op.result_kind === 'review') {
    const r = await db.prepare('SELECT * FROM pull_reviews WHERE id=?').bind(op.result_id).first();
    if (!r) deny();
    d = await db.prepare(`SELECT d.*,${pullColumns} FROM discussions d ${pullJoin} WHERE p.id=? AND d.repository_id=?`).bind(r.pull_request_id, repository.id).first();
    if (!d) deny();
    const current = await artifact(async repo => pull(db, env, repository, d, await inventory(env, repository, repo)));
    return { mutation: { ...common, pullRequestId: String(d.pull_id), number: d.number, headCommitId: r.head_commit,
      reviewState: 'PULL_REQUEST_REVIEW_STATE_' + r.state, observedReviewId: String(r.id) }, review: await review(db, env, repository, d, r, current) };
  }
  const isPull = op.result_kind === 'pull';
  d = isPull ? await db.prepare(`SELECT d.*,${pullColumns} FROM discussions d ${pullJoin} WHERE p.id=? AND d.repository_id=?`).bind(op.result_id, repository.id).first()
    : await db.prepare("SELECT * FROM discussions WHERE id=? AND repository_id=? AND kind='issue'").bind(op.result_id, repository.id).first();
  if (!d) deny();
  const kind = ({ CreateIssue: 'CREATE_ISSUE', UpdateIssue: 'UPDATE_ISSUE', CreatePullRequest: 'CREATE_PULL', UpdatePullRequest: 'UPDATE_PULL' })[op.method];
  const mutation = { ...common, kind: 'ISSUE_MUTATION_KIND_' + kind, issueId: isPull ? '' : String(d.id), number: d.number,
    ...(isPull ? { pullRequestId: String(d.pull_id), observedResultId: String(d.pull_id), observedNumber: d.number } : {}) };
  return isPull ? { mutation, pullRequest: await artifact(async repo => pull(db, env, repository, d, await inventory(env, repository, repo))) }
    : { mutation, issue: await issue(db, env, repository, d) };
}
async function completed(db, env, person, row, key, artifact) {
  const op = await db.prepare('SELECT * FROM collaboration_operations WHERE user_id=? AND operation_key=? AND repository_id=?').bind(person.id, key, row.id).first();
  if (!op) deny();
  return result(db, env, person, row, op, artifact);
}
function query(body, kind, repository) {
  const state = enumeration(body.state, 'ISSUE_STATE_', issueKinds, 'OPEN'), clauses = ['d.repository_id=?', 'd.kind=?'], values = [repository.id, kind];
  if (state !== 'ALL') { clauses.push('d.state=?'); values.push(state); }
  const q = body.query || {};
  metadataFilter(q, clauses, values);
  if (q.author) { text(q.author, 63, true); clauses.push('u.login=?'); values.push(q.author); }
  if (q.search) {
    text(q.search, 200); clauses.push("(d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')");
    const pattern = '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%'; values.push(pattern, pattern);
  }
  return { clauses, values };
}
function edits(body, isPull) {
  if (body.labels || body.assignees || body.milestone) unsupported();
  const changes = [];
  if (Object.hasOwn(body, 'title')) changes.push(['title', text(body.title, 200, true)]);
  if (Object.hasOwn(body, 'body')) changes.push(['body', text(body.body, 12000)]);
  const state = enumeration(body.state, 'ISSUE_STATE_', issueKinds, undefined);
  if (state) { if (state === 'ALL') invalid('Use open or closed.'); changes.push(['state', state]); }
  if (Object.hasOwn(body, 'draft')) {
    if (!isPull || typeof body.draft !== 'boolean') invalid('Invalid draft flag.');
    changes.push(['draft', Number(body.draft)]);
  }
  if (changes.length !== 1) invalid('Change exactly one field.');
  return changes[0];
}

export async function collaboration(db, env, person, method, body, row, artifact) {
  if (method === 'GetIssueMutation' || method === 'GetPullRequestReviewMutation') {
    const op = await db.prepare('SELECT * FROM collaboration_operations WHERE user_id=? AND operation_key=? AND repository_id=?').bind(person.id, body.idempotencyKey, row.id).first();
    if (!op || (method === 'GetPullRequestReviewMutation') !== (op.result_kind === 'review') || op.result_kind === 'check') deny();
    return result(db, env, person, row, op, artifact);
  }
  if (method === 'GetIssue' || method === 'GetPullRequestDiscussion') {
    const d = await discussion(db, row, body.number, method === 'GetIssue' ? 'issue' : 'pull');
    return { issue: await issue(db, env, row, d) };
  }
  if (method === 'ListIssues' || method === 'ListPullRequests') {
    const isPull = method === 'ListPullRequests', paging = page(body), filter = query(body, isPull ? 'pull' : 'issue', row);
    const sort = body.sort || 'newest', orders = { newest: 'd.number DESC', oldest: 'd.number ASC', updated: 'd.updated_at DESC,d.number DESC', 'least-updated': 'd.updated_at ASC,d.number ASC' };
    if (isPull && !orders[sort]) invalid('Choose a supported PR ordering.');
    if (body.baseBranch) { if (!isPull) invalid('Base branch filters are for PRs.'); filter.clauses.push('p.base_branch=?'); filter.values.push(text(body.baseBranch, 200, true)); }
    const { results } = await db.prepare(`SELECT d.*,(SELECT count(*) FROM discussion_comments c WHERE c.discussion_id=d.id) AS comment_count${isPull ? ',' + pullColumns : ''}
      FROM discussions d JOIN users u ON u.id=d.author_id ${isPull ? pullJoin : ''}
      WHERE ${filter.clauses.join(' AND ')} ORDER BY ${isPull ? orders[sort] : 'd.number DESC'} LIMIT ? OFFSET ?`).bind(...filter.values, paging.limit + 1, paging.offset).all();
    const entries = [];
    const refs = isPull && results.length ? await artifact(repo => inventory(env, row, repo)) : null;
    const [metadata, authors] = await Promise.all([metadataBatch(db, results.slice(0, paging.limit)), authorBatch(db, results.slice(0, paging.limit))]);
    for (const d of results.slice(0, paging.limit)) entries.push(isPull ? await pull(db, env, row, d, refs, metadata.get(d.id), authors) : await issue(db, env, row, d, metadata.get(d.id), authors));
    return { [isPull ? 'pullRequests' : 'issues']: entries, page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  if (method === 'GetPullRequest') {
    const d = await pullRow(db, row, body.number);
    return { pullRequest: await artifact(async repo => {
      const current = await pull(db, env, row, d, await inventory(env, row, repo));
      if (current.merged || !current.base.retainedSnapshot && !current.head.retainedSnapshot) {
        try { current.mergeBaseCommitId = (await comparison(repo, current.base.commitId, current.head.commitId)).mergeBase; }
        catch (error) { if (!(error instanceof Fault) || !['resource_exhausted', 'unimplemented', 'failed_precondition'].includes(error.code)) throw error; }
      }
      return current;
    }) };
  }
  if (method === 'ListIssueComments') {
    exactRepository(body, row);
    const d = await discussion(db, row, body.number, body.pullRequest ? 'pull' : 'issue');
    if (!idOK(body.issueId) || body.issueId !== String(d.id)) deny();
    const paging = page(body);
    const { results } = await db.prepare('SELECT * FROM discussion_comments WHERE discussion_id=? ORDER BY id LIMIT ? OFFSET ?').bind(d.id, paging.limit + 1, paging.offset).all();
    const authors = await authorBatch(db, results.slice(0, paging.limit));
    const comments = []; for (const c of results.slice(0, paging.limit)) comments.push(await comment(db, env, row, d, c, person, authors));
    return { comments, page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  if (['ListPullRequestReviews', 'ListPullRequestChecks', 'ListPullRequestCommits', 'GetPullRequestDiff'].includes(method)) {
    const selection = ['ListPullRequestChecks', 'ListPullRequestCommits'].includes(method) ? body.selection : body;
    if (!selection) invalid('Use the displayed PR selection.');
    const d = await pullRow(db, row, selection.number);
    const current = await artifact(async repo => pull(db, env, row, d, await inventory(env, row, repo)));
    const paging = page(body);
    if (method === 'ListPullRequestReviews') {
      const { results } = await db.prepare(`SELECT r.*,COALESCE(l.dismissed,0) AS dismissed,l.updated_at,a.status AS draft_status,a.updated_at AS draft_updated_at FROM pull_reviews r LEFT JOIN pull_review_lifecycle l ON l.review_id=r.id LEFT JOIN pull_review_drafts a ON a.review_id=r.id WHERE r.pull_request_id=? AND (a.status IS NULL OR a.status='PUBLISHED' OR a.status='PENDING' AND r.author_id=?) ORDER BY r.id LIMIT ? OFFSET ?`).bind(d.pull_id, person.id, paging.limit + 1, paging.offset).all();
      const authors = await authorBatch(db, results.slice(0, paging.limit));
      const reviews = []; for (const r of results.slice(0, paging.limit)) reviews.push(await review(db, env, row, d, r, current, authors));
      return { reviews, page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
    }
    exactRepository(selection, row);
    if (selection.pullRequestId !== String(d.pull_id) || selection.baseCommitId !== current.base.commitId || selection.headCommitId !== current.head.commitId || !current.merged && (current.base.retainedSnapshot || current.head.retainedSnapshot)) changed();
    if (method === 'ListPullRequestCommits' || method === 'GetPullRequestDiff') return artifact(async repo => {
      const observed = await comparison(repo, selection.baseCommitId, selection.headCommitId);
      if (method === 'GetPullRequestDiff') return { repositoryId: String(row.id), pullRequestId: String(d.pull_id),
        baseCommitId: selection.baseCommitId, headCommitId: selection.headCommitId, mergeBaseCommitId: observed.mergeBase,
        ...await diff(repo, observed.mergeBase, selection.headCommitId) };
      // Keep children before parents, including merge commits; timestamp order is not ancestry.
      const entries = [], pending = [selection.headCommitId], remaining = new Map(observed.commits.map(c => [c.hash, c]));
      while (pending.length) {
        const hash = pending.pop(), commit = remaining.get(hash); if (!commit) continue;
        remaining.delete(hash); entries.push(wireCommit(commit)); pending.push(...commit.parents.toReversed());
      }
      return { selection, commits: entries.slice(paging.offset, paging.offset + paging.limit), page: { nextPage: entries.length > paging.offset + paging.limit ? paging.number + 1 : 0 } };
    });
    const { results } = await db.prepare(`SELECT c.* FROM reported_checks c WHERE c.repository_id=? AND c.commit_id=?
      AND c.id=(SELECT max(latest.id) FROM reported_checks latest WHERE latest.repository_id=c.repository_id AND latest.commit_id=c.commit_id AND latest.context=c.context)
      ORDER BY c.context LIMIT ? OFFSET ?`).bind(row.id, current.head.commitId, paging.limit + 1, paging.offset).all();
    const authors = await authorBatch(db, results.slice(0, paging.limit));
    const checks = []; for (const c of results.slice(0, paging.limit)) checks.push(await check(db, c, authors));
    return { selection, checks, page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
  }

  exactRepository(body, row);
  const op = await operation(db, person, row, method, body);
  if (op.saved) return result(db, env, person, row, op.saved, artifact);
  if (method === 'CreateIssue' || method === 'CreatePullRequest') {
    const isPull = method === 'CreatePullRequest';
    const title = text(body.title, 200, true), description = text(body.body ?? '', 12000);
    const discussionId = await nextId(db, 'discussions'), resultId = isPull ? await nextId(db, 'pull_requests') : discussionId;
    const statements = [admission(db, person, row, method, body, op, isPull ? 'pull' : 'issue', resultId),
      db.prepare(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at)
        SELECT ?,?,(SELECT COALESCE(max(number),0)+1 FROM discussions WHERE repository_id=?),?,?,?,?,'OPEN',?,? WHERE ${admitted}`)
        .bind(discussionId, row.id, row.id, isPull ? 'pull' : 'issue', person.id, title, description, op.time, op.time, op.id)];
    if (isPull) {
      if (!writable(row)) deny();
      if (row.write_pending) conflict();
      if (body.sourceRepositoryId !== String(row.id) || body.sourceRepository?.owner !== ownerSlug(row,env) || body.sourceRepository?.name !== row.name) unsupported();
      if (!validRef('refs/heads/' + body.baseBranch) || !validRef('refs/heads/' + body.headBranch) || body.baseBranch === body.headBranch ||
          !sha(body.baseCommitId) || !sha(body.headCommitId) || body.baseCommitId === body.headCommitId || body.draft !== undefined && typeof body.draft !== 'boolean') invalid('Use two different named branches and exact displayed commits.');
      const refs = await artifact(repo => inventory(env, row, repo));
      if (refs.get('refs/heads/' + body.baseBranch) !== body.baseCommitId || refs.get('refs/heads/' + body.headBranch) !== body.headCommitId) changed();
      if (await db.prepare(`SELECT p.id FROM pull_requests p JOIN discussions d ON d.id=p.discussion_id
        WHERE d.repository_id=? AND d.state='OPEN' AND p.base_branch=? AND p.head_branch=?`).bind(row.id, body.baseBranch, body.headBranch).first()) {
        throw new Fault('already_exists', 409, 'An open proposal already exists for these branches.');
      }
      statements.push(db.prepare(`INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) SELECT ?,?,?,?,?,?,? WHERE ${admitted}`)
        .bind(resultId, discussionId, body.baseBranch, body.headBranch, body.baseCommitId, body.headCommitId, Number(body.draft || false), op.id));
    }
    statements.push(...discussionEvent(db, person, discussionId, op.time, 'opened', {}, admitted, [op.id]));
    await commitMutation(db, statements);
  } else if (method === 'CreateIssueComment') {
    const d = await discussion(db, row, body.number, body.pullRequest ? 'pull' : 'issue');
    if (!idOK(body.issueId) || body.issueId !== String(d.id)) deny();
    const content = text(body.body, 12000); if (!content.trim()) invalid('Comment text is required.');
    const id = await nextId(db, 'discussion_comments');
    await commitMutation(db, [
      admission(db, person, row, method, body, op, 'comment', id, d),
      db.prepare(`INSERT INTO discussion_comments(id,discussion_id,author_id,body,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE ${admitted}`).bind(id, d.id, person.id, content, op.time, op.time, op.id),
      db.prepare(`UPDATE discussions SET revision=revision+1,updated_at=? WHERE id=? AND ${admitted}`).bind(op.time, d.id, op.id),
      ...discussionEvent(db, person, d.id, op.time, 'comment', {}, admitted, [op.id]),
    ]);
  } else if (method === 'UpdateIssue' || method === 'UpdatePullRequest') {
    const isPull = method === 'UpdatePullRequest', d = isPull ? await pullRow(db, row, body.number) : await discussion(db, row, body.number, 'issue');
    if ((isPull ? body.pullRequestId !== String(d.pull_id) : body.issueId !== String(d.id)) || !writable(row) && d.author_id !== person.id) deny();
    const current = isPull ? await artifact(async repo => pull(db, env, row, d, await inventory(env, row, repo))) : await issue(db, env, row, d);
    if (body.expectedRevision !== current.revision) changed();
    if (['labels', 'assignees', 'milestone'].some(key => Object.hasOwn(body, key))) {
      await metadataChange(db, person, row, d, body, op);
      return completed(db, env, person, row, body.idempotencyKey, artifact);
    }
    const [field, value] = edits(body, isPull);
    if (current.merged && ['state', 'draft'].includes(field)) throw new Fault('failed_precondition', 412, 'A merged pull request cannot be reopened or changed to a draft.');
    const statements = [admission(db, person, row, method, body, op, isPull ? 'pull' : 'issue', isPull ? d.pull_id : d.id, d)];
    if (field === 'draft') {
      statements.push(db.prepare(`UPDATE pull_requests SET draft=? WHERE id=? AND ${admitted}`).bind(value, d.pull_id, op.id));
      statements.push(db.prepare(`UPDATE discussions SET revision=revision+1,updated_at=? WHERE id=? AND ${admitted}`).bind(op.time, d.id, op.id));
    } else statements.push(db.prepare(`UPDATE discussions SET ${field}=?,revision=revision+1,updated_at=? WHERE id=? AND ${admitted}`).bind(value, op.time, d.id, op.id));
    const event = field === 'title' ? 'change_title' : field === 'state' ? value === 'CLOSED' ? 'close' : 'reopen' : field === 'draft' ? value ? 'converted_to_draft' : 'ready_for_review' : 'edited_description';
    statements.push(...discussionEvent(db, person, d.id, op.time, event, field === 'title' ? { oldTitle: d.title, newTitle: value } : {}, admitted, [op.id]));
    await commitMutation(db, statements);
  } else if (method === 'CreatePullRequestReview') {
    if (row.write_pending) conflict();
    const d = await pullRow(db, row, body.number);
    if (body.pullRequestId !== String(d.pull_id)) deny();
    const current = await artifact(async repo => pull(db, env, row, d, await inventory(env, row, repo)));
    if (d.state !== 'OPEN' || d.draft || current.head.retainedSnapshot || current.base.retainedSnapshot || body.expectedRevision !== current.revision ||
        body.baseCommitId !== current.base.commitId || body.headCommitId !== current.head.commitId) changed();
    const state = enumeration(body.state, 'PULL_REQUEST_REVIEW_STATE_', reviewKinds, undefined);
    if (!['APPROVED', 'COMMENT', 'REQUEST_CHANGES'].includes(state)) unsupported();
    if (state !== 'COMMENT' && d.author_id === person.id) throw new Fault('permission_denied', 403, 'Authors cannot approve or request changes on their own proposal.');
    const content = text(body.body ?? '', 6000);
    if (state !== 'APPROVED' && !content.trim()) invalid('Review text is required.');
    const id = await nextId(db, 'pull_reviews');
    await commitMutation(db, [
      admission(db, person, row, method, body, op, 'review', id, d),
      db.prepare(`INSERT INTO pull_reviews(id,pull_request_id,author_id,head_commit,base_commit,state,body,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${admitted}`)
        .bind(id, d.pull_id, person.id, current.head.commitId, current.base.commitId, state, content, op.time, op.id),
      ...completeReviewRequest(db,person,d.pull_id,admitted,[op.id]),
      ...discussionEvent(db, person, d.id, op.time, 'review_' + state.toLowerCase(), {}, admitted, [op.id]),
    ]);
  } else if (method === 'ReportCheck') {
    if (row.role !== 'admin') deny();
    if (!sha(body.commitId)) invalid('Use a full commit.');
    const context = text(body.context, 100, true), description = text(body.description ?? '', 2000);
    const state = enumeration(body.state, 'REPORTED_CHECK_STATE_', checkKinds, undefined);
    if (!state) invalid('Use an explicit reported check state.');
    const target = text(body.targetUrl ?? '', 2000);
    if (target) {
      let parsed; try { parsed = new URL(text(target, 2000)); } catch { invalid('Use an HTTPS check URL.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) invalid('Use an HTTPS check URL without credentials or a fragment.');
    }
    if (!await artifact(repo => repo.readCommit(body.commitId))) deny();
    const id = await nextId(db, 'reported_checks');
    await commitMutation(db, [
      admission(db, person, row, method, body, op, 'check', id),
      db.prepare(`INSERT INTO reported_checks(id,repository_id,commit_id,context,state,description,target_url,author_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${admitted}`)
        .bind(id, row.id, body.commitId, context, state, description, target, person.id, op.time, op.id),
    ]);
  } else unsupported();
  return completed(db, env, person, row, body.idempotencyKey, artifact);
}

export async function pullReviewContext(db, env, person, row, body, artifact) {
  exactRepository(body, row);
  if(body.repository?.owner!==ownerSlug(row,env)||body.repository?.name!==row.name) deny();
  const d = await pullRow(db, row, body.number);
  if (body.pullRequestId !== String(d.pull_id)) deny();
  const current = await artifact(async repo => pull(db, env, row, d, await inventory(env, row, repo)));
  return { d, current };
}

export function completeReviewRequest(db,person,pullId,guard,values) {
  return [db.prepare(`UPDATE pull_review_versions SET version=version+1 WHERE pull_request_id=? AND EXISTS(SELECT 1 FROM pull_review_requests WHERE pull_request_id=? AND user_id=?) AND ${guard}`).bind(pullId,pullId,person.id,...values),
    db.prepare(`DELETE FROM pull_review_requests WHERE pull_request_id=? AND user_id=? AND ${guard}`).bind(pullId,person.id,...values)];
}
