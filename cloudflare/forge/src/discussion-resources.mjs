import { ownerSlug } from './owners.mjs';
import { engagementChange, discussionEvent } from './discussion-engagement.mjs';
import { digest, uuidOK, deny, invalid, unsupported, Fault, page, user } from './common.mjs';

export const resourceMethods = new Set(['ListRepositoryLabels', 'ListRepositoryMilestones', 'ListRepositoryAssignees', 'SubmitDiscussionResourceOperation', 'GetDiscussionResourceOperation']);
const kinds = ['UNSPECIFIED', 'CREATE_LABEL', 'UPDATE_LABEL', 'DELETE_LABEL', 'CREATE_MILESTONE', 'UPDATE_MILESTONE', 'DELETE_MILESTONE', 'UPDATE_COMMENT', 'DELETE_COMMENT', 'ADD_REACTION', 'REMOVE_REACTION', 'SUBSCRIBE', 'UNSUBSCRIBE', 'MARK_NOTIFICATION_READ'];
const stale = () => { throw new Fault('failed_precondition', 412, 'Discussion resources or authority changed. Refresh before editing.'); };
const idOK = v => typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v));
const text = (v, max, required = false) => {
  if (typeof v !== 'string' || new TextEncoder().encode(v).length > max || new TextDecoder().decode(new TextEncoder().encode(v)) !== v || /\p{Cc}/u.test(v.replace(/[\r\n\t]/g, '')) || required && (!v || v.trim() !== v || /[\r\n\t]/.test(v))) invalid('Invalid resource text.');
  return v;
};
const state = value => [undefined, 0, 1, 'ISSUE_STATE_UNSPECIFIED', 'ISSUE_STATE_OPEN'].includes(value) ? 'OPEN' : [2, 'ISSUE_STATE_CLOSED'].includes(value) ? 'CLOSED' : [3, 'ISSUE_STATE_ALL'].includes(value) ? 'ALL' : invalid('Choose an issue state.');
export const resourceAuthority = `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
  WHERE r.id=? AND r.state='ACTIVE' AND r.artifact_name=? AND g.user_id=? AND g.role='admin' AND u.active=1)
  AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?`;
export const authorityValues = (row, person) => [row.id, row.artifact_name, person.id, row.id, row.access_version];
const countSQL = `COALESCE((SELECT sum(d.state='OPEN') FROM discussion_milestones a JOIN discussions d ON d.id=a.discussion_id WHERE a.milestone_id=r.id),0) AS open_count, COALESCE((SELECT sum(d.state='CLOSED') FROM discussion_milestones a JOIN discussions d ON d.id=a.discussion_id WHERE a.milestone_id=r.id),0) AS closed_count`;
async function milestoneCounts(db, id) { return db.prepare(`SELECT ${countSQL} FROM discussion_resources r WHERE r.id=?`).bind(id).first(); }
const revision = r => digest(JSON.stringify([r.id, r.repository_id, r.kind, r.revision]));
async function wire(db, r) {
  const value = { ...JSON.parse(r.payload), id: String(r.id), revision: await revision(r) };
  if (r.kind === 'milestone') {
    const counts = r.open_count === undefined ? await milestoneCounts(db, r.id) : r;
    value.openIssues = String(counts.open_count); value.closedIssues = String(counts.closed_count);
  }
  return value;
}
export async function resourceOperation(db, person, operationId) {
  if (!uuidOK(operationId)) invalid('Use the original operation key.');
  const saved = await db.prepare(`SELECT o.* FROM discussion_resource_operations o JOIN repositories r ON r.id=o.repository_id
    JOIN grants g ON g.repository_id=r.id WHERE o.actor_id=? AND o.operation_key=? AND g.user_id=? AND r.state='ACTIVE'`).bind(person.id, operationId, person.id).first();
  if (!saved) deny();
  return { operation: JSON.parse(saved.receipt) };
}
export async function discussionResources(db, env, person, row, method, body) {
  if (body.repositoryId !== String(row.id)) deny();
  if (method === 'ListRepositoryAssignees') {
    const found = await db.prepare('SELECT u.* FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND u.active=1 ORDER BY u.id LIMIT 1001').bind(row.id).all();
    if (found.results.length > 1000) throw new Fault('resource_exhausted', 429, 'Assignee inventory exceeds the supported bound.');
    return { assignees: found.results.map(user), canEditAssignees: row.role === 'admin' };
  }
  if (method === 'ListRepositoryLabels' || method === 'ListRepositoryMilestones') {
    // Organization labels require their own ownership adapter; never pretend an empty inherited inventory.
    if (body.includeOrganizationLabels) unsupported();
    const kind = method === 'ListRepositoryLabels' ? 'label' : 'milestone', paging = page(body), selected = kind === 'milestone' ? state(body.state) : 'ALL';
    const found = await db.prepare(`SELECT r.*,${countSQL} FROM discussion_resources r WHERE repository_id=? AND kind=? AND deleted=0
      ${selected !== 'ALL' ? "AND json_extract(payload,'$.state')=?" : ''} ORDER BY id LIMIT ? OFFSET ?`).bind(row.id, kind, ...(selected !== 'ALL' ? ['ISSUE_STATE_' + selected] : []), paging.limit + 1, paging.offset).all();
    const entries = await Promise.all(found.results.slice(0, paging.limit).map(r => wire(db, r)));
    return { [kind === 'label' ? 'labels' : 'milestones']: entries, canManage: row.role === 'admin', [kind === 'label' ? 'canEditLabels' : 'canEditMilestone']: row.role === 'admin', page: { nextPage: found.results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  if (method !== 'SubmitDiscussionResourceOperation') unsupported();
  if (!uuidOK(body.operationId)) invalid('Use a UUID v4 operation key.');
  const kind = typeof body.kind === 'number' ? kinds[body.kind] : body.kind?.replace('DISCUSSION_RESOURCE_OPERATION_KIND_', '');
  if (!kinds.slice(1).includes(kind)) unsupported();
  if (kinds.indexOf(kind) >= 9) return engagementChange(db, env, person, row, kind, body);
  if (kind.endsWith('COMMENT')) return commentChange(db, env, person, row, kind, body);
  if (body.issueId || body.number || body.pullRequest || body.subscriptionLogin || body.reactionComment || Object.hasOwn(body, 'reaction') || Object.hasOwn(body, 'commentBody')) invalid('Select a repository label or milestone.');
  const create = kind.startsWith('CREATE'), remove = kind.startsWith('DELETE'), type = kind.endsWith('LABEL') ? 'label' : 'milestone';
  if (create ? body.resourceId || body.expectedRevision : !idOK(body.resourceId) || !/^[a-f0-9]{64}$/.test(body.expectedRevision || '')) invalid('Use the exact resource and revision.');
  if (Object.hasOwn(body, type === 'label' ? 'milestone' : 'label') || remove && Object.hasOwn(body, type)) invalid('Use only the selected resource change.');
  let payload;
  if (!remove) {
    const d = body[type]; if (!d || typeof d !== 'object' || Array.isArray(d)) invalid('Provide a resource draft.');
    if (type === 'label') {
      if (!/^[a-fA-F0-9]{6}$/.test(d.color || '') || ['exclusive', 'archived'].some(k => d[k] !== undefined && typeof d[k] !== 'boolean')) invalid('Use a six-digit label color and boolean flags.');
      payload = { name: text(d.name, 255, true), description: text(d.description || '', 2000), color: d.color.toLowerCase(), exclusive: d.exclusive || false, archived: d.archived || false, organizationOwned: false };
    } else {
      const status = state(d.state), due = d.dueDate || '';
      if (status === 'ALL' || due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) invalid('Use open or closed and a valid UTC calendar deadline.');
      payload = { title: text(d.title, 255, true), description: text(d.description || '', 2000), state: 'ISSUE_STATE_' + status, dueOn: due ? due + 'T00:00:00.000Z' : '' };
    }
  }
  const hash = await digest(JSON.stringify([row.id, kind, body.resourceId || '', body.expectedRevision || '', payload || null]));
  const saved = await db.prepare('SELECT * FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?').bind(person.id, body.operationId).first();
  if (saved) {
    if (saved.repository_id !== row.id || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to a different resource change.');
    return { operation: JSON.parse(saved.receipt) };
  }
  if (row.role !== 'admin') deny();
  const current = create ? null : await db.prepare('SELECT * FROM discussion_resources WHERE id=? AND repository_id=? AND kind=? AND deleted=0').bind(body.resourceId, row.id, type).first();
  const currentRevision = create || current && await revision(current) === body.expectedRevision;
  const id = current?.id || (await db.prepare('SELECT COALESCE(max(id),0)+1 AS id FROM discussion_resources').first()).id;
  const time = new Date().toISOString(), operation = { operationId: body.operationId, kind: 'DISCUSSION_RESOURCE_OPERATION_KIND_' + kind, phase: 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED', repository: { owner: ownerSlug(row,env), name: row.name }, repositoryId: String(row.id), resourceId: body.resourceId || '', observedResourceId: String(id), expectedRevision: body.expectedRevision || '', createdAt: time, updatedAt: time };
  const refuse = async () => {
    operation.phase = 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED'; operation.failureCode = 'preflight_refused'; operation.observedResourceId = '';
    await db.prepare('INSERT INTO discussion_resource_operations VALUES(?,?,?,?,?)').bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation)).run();
    return { operation };
  };
  if (!currentRevision) return refuse();
  const name = payload?.name || payload?.title || current.name;
  if (!remove && await db.prepare('SELECT id FROM discussion_resources WHERE repository_id=? AND kind=? AND name=? AND deleted=0 AND id!=?').bind(row.id, type, name, id).first()) return refuse();
  const record = db.prepare(`INSERT INTO discussion_resource_operations SELECT ?,?,?,?,? WHERE ${resourceAuthority}
    ${current ? 'AND EXISTS(SELECT 1 FROM discussion_resources WHERE id=? AND revision=? AND deleted=0)' : 'AND NOT EXISTS(SELECT 1 FROM discussion_resources WHERE id=?)'}`)
    .bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation), ...authorityValues(row, person), id, ...(current ? [current.revision] : []));
  const guard = 'EXISTS(SELECT 1 FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?)';
  const change = create ? db.prepare(`INSERT INTO discussion_resources(id,repository_id,kind,name,payload) SELECT ?,?,?,?,? WHERE ${guard}`).bind(id, row.id, type, name, JSON.stringify(payload), person.id, body.operationId)
    : db.prepare(`UPDATE discussion_resources SET name=?,payload=?,deleted=?,revision=revision+1 WHERE id=? AND ${guard}`).bind(name, remove ? current.payload : JSON.stringify(payload), Number(remove), id, person.id, body.operationId);
  const result = await db.batch([record, change]);
  if (result[0].meta.changes !== 1) return refuse();
  return { operation, ...(!remove ? { [type]: await wire(db, await db.prepare('SELECT * FROM discussion_resources WHERE id=?').bind(id).first()) } : {}) };
}
export async function metadataBatch(db, discussions) {
  const metadata = new Map(discussions.map(d => [d.id, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true, labels: [], assignees: [] }]));
  if (!discussions.length) return metadata;
  const ids = JSON.stringify(discussions.map(d => d.id));
  const [labels, assignees, milestones] = await Promise.all([
    db.prepare('SELECT a.discussion_id,r.* FROM discussion_labels a JOIN discussion_resources r ON r.id=a.label_id WHERE a.discussion_id IN (SELECT value FROM json_each(?)) AND r.deleted=0 ORDER BY r.id LIMIT 5001').bind(ids).all(),
    db.prepare('SELECT a.discussion_id,u.* FROM discussion_assignees a JOIN discussions d ON d.id=a.discussion_id JOIN users u ON u.id=a.user_id JOIN grants g ON g.user_id=u.id AND g.repository_id=d.repository_id WHERE a.discussion_id IN (SELECT value FROM json_each(?)) AND u.active=1 ORDER BY u.id').bind(ids).all(),
    db.prepare(`SELECT a.discussion_id,r.*,${countSQL} FROM discussion_milestones a JOIN discussion_resources r ON r.id=a.milestone_id WHERE a.discussion_id IN (SELECT value FROM json_each(?)) AND r.deleted=0`).bind(ids).all(),
  ]);
  if (labels.results.length > 5000 || [...labels.results, ...milestones.results].reduce((bytes, r) => bytes + new TextEncoder().encode(r.payload).length, 0) > 2 * 1024 * 1024) throw new Fault('resource_exhausted', 429, 'Discussion metadata exceeds the page bound. Select fewer discussions.');
  const labelValues = new Map();
  for (const r of labels.results) { if (!labelValues.has(r.id)) labelValues.set(r.id, await wire(db, r)); metadata.get(r.discussion_id).labels.push(labelValues.get(r.id)); }
  for (const r of assignees.results) metadata.get(r.discussion_id).assignees.push(user(r));
  for (const r of milestones.results) metadata.get(r.discussion_id).milestone = await wire(db, r);
  return metadata;
}
export async function discussionMetadata(db, d) { return (await metadataBatch(db, [d])).get(d.id); }
export function metadataFilter(q, clauses, values) {
  if (q.assignee) { text(q.assignee, 255, true); clauses.push('EXISTS(SELECT 1 FROM discussion_assignees a JOIN users t ON t.id=a.user_id JOIN grants g ON g.user_id=t.id AND g.repository_id=d.repository_id WHERE a.discussion_id=d.id AND t.active=1 AND t.login=?)'); values.push(q.assignee); }
  if (q.milestoneTitle) { text(q.milestoneTitle, 255, true); clauses.push("EXISTS(SELECT 1 FROM discussion_milestones m JOIN discussion_resources r ON r.id=m.milestone_id WHERE m.discussion_id=d.id AND r.deleted=0 AND r.name=?)"); values.push(q.milestoneTitle); }
  if (q.labelNames !== undefined && (!Array.isArray(q.labelNames) || q.labelNames.length > 20 || new Set(q.labelNames).size !== q.labelNames.length)) invalid('Use at most twenty unique label names.');
  for (const name of q.labelNames || []) { text(name, 255, true); clauses.push('EXISTS(SELECT 1 FROM discussion_labels l JOIN discussion_resources r ON r.id=l.label_id WHERE l.discussion_id=d.id AND r.deleted=0 AND r.name=?)'); values.push(name); }
}
export async function metadataChange(db, person, row, d, body, op) {
  const fields = ['labels', 'assignees', 'milestone'].filter(k => Object.hasOwn(body, k));
  if (fields.length !== 1 || ['title', 'body', 'draft'].some(k => Object.hasOwn(body, k)) || body.state && ![0, 'ISSUE_STATE_UNSPECIFIED'].includes(body.state)) invalid('Change exactly one discussion field.');
  if (row.role !== 'admin') deny();
  const field = fields[0], draft = body[field], current = await discussionMetadata(db, d);
  if (!draft || typeof draft !== 'object') invalid('Provide the reviewed metadata selection.');
  const ids = (values, max) => { if (!Array.isArray(values) || values.length > max || values.some((id, i) => !idOK(id) || i > 0 && BigInt(id) <= BigInt(values[i - 1]))) invalid('Use sorted unique resource identities.'); return values; };
  let selected, table, column, dependencies = [];
  if (field === 'labels') {
    if (JSON.stringify(ids(draft.expectedLabelIds || [], 256)) !== JSON.stringify(current.labels.map(r => r.id))) stale();
    selected = ids(draft.labelIds || [], 256); table = 'discussion_labels'; column = 'label_id';
    const found = await db.prepare("SELECT * FROM discussion_resources WHERE repository_id=? AND kind='label' AND deleted=0 AND id IN (SELECT value FROM json_each(?)) ORDER BY id").bind(row.id, JSON.stringify(selected)).all();
    if (found.results.length !== selected.length) deny();
    const exclusive = new Set();
    for (const r of found.results) {
      const p = JSON.parse(r.payload);
      if (p.archived && !current.labels.some(l => l.id === String(r.id))) stale();
      if (p.exclusive) { const split = p.name.lastIndexOf('/'); if (split > 0 && split < p.name.length - 1) { const group = p.name.slice(0, split); if (exclusive.has(group)) invalid('Choose one label per exclusive group.'); exclusive.add(group); } }
      dependencies.push({ id: r.id, version: r.revision });
    }
  } else if (field === 'assignees') {
    if (JSON.stringify(ids(draft.expectedAssigneeIds || [], 100)) !== JSON.stringify(current.assignees.map(r => r.id))) stale();
    if (!Array.isArray(draft.assignees ?? [])) invalid('Use account selections.');
    selected = ids((draft.assignees || []).map(u => u?.id), 100); table = 'discussion_assignees'; column = 'user_id';
    const found = await db.prepare('SELECT u.*,COALESCE(v.version,0) AS version FROM users u JOIN grants g ON g.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE g.repository_id=? AND u.active=1 AND u.id IN (SELECT value FROM json_each(?)) ORDER BY u.id').bind(row.id, JSON.stringify(selected)).all();
    if (found.results.length !== selected.length || found.results.some((u, i) => u.login !== draft.assignees[i].login)) deny();
    dependencies = found.results.map(u => ({ id: u.id, version: u.version }));
  } else {
    if (draft.expectedMilestoneId !== (current.milestone?.id || '0')) stale();
    if (draft.milestoneId !== '0' && !idOK(draft.milestoneId)) invalid('Select a milestone identity or zero to clear.');
    selected = draft.milestoneId === '0' ? [] : [draft.milestoneId]; table = 'discussion_milestones'; column = 'milestone_id';
    if (selected.length) {
      const found = await db.prepare("SELECT * FROM discussion_resources WHERE id=? AND repository_id=? AND kind='milestone' AND deleted=0").bind(selected[0], row.id).first();
      if (!found) deny();
      if (JSON.parse(found.payload).state !== 'ISSUE_STATE_OPEN' && current.milestone?.id !== selected[0]) stale();
      dependencies = [{ id: found.id, version: found.revision }];
    }
  }
  const isPull = d.kind === 'pull', guard = 'EXISTS(SELECT 1 FROM collaboration_operations WHERE user_id=? AND operation_key=?)';
  const dependencyGuard = field === 'assignees' ? `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN users u ON u.id=json_extract(j.value,'$.id') LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id IS NULL OR u.active!=1 OR COALESCE(v.version,0)!=json_extract(j.value,'$.version'))`
    : `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN discussion_resources r ON r.id=json_extract(j.value,'$.id') WHERE r.id IS NULL OR r.deleted!=0 OR r.revision!=json_extract(j.value,'$.version'))`;
  const record = db.prepare(`INSERT INTO collaboration_operations(id,user_id,repository_id,operation_key,method,input_hash,result_kind,result_id,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${resourceAuthority} AND EXISTS(SELECT 1 FROM discussions WHERE id=? AND revision=?) AND ${dependencyGuard}`)
    .bind(op.id, person.id, row.id, body.idempotencyKey, isPull ? 'UpdatePullRequest' : 'UpdateIssue', op.hash, isPull ? 'pull' : 'issue', isPull ? d.pull_id : d.id, op.time, ...authorityValues(row, person), d.id, d.revision, JSON.stringify(dependencies));
  const result = await db.batch([
    record,
    db.prepare(`DELETE FROM ${table} WHERE discussion_id=? AND ${guard}`).bind(d.id, person.id, body.idempotencyKey),
    db.prepare(`INSERT INTO ${table}(discussion_id,${column}) SELECT ?,value FROM json_each(?) WHERE ${guard}`).bind(d.id, JSON.stringify(selected), person.id, body.idempotencyKey),
    db.prepare(`UPDATE discussions SET revision=revision+1,updated_at=? WHERE id=? AND ${guard}`).bind(op.time, d.id, person.id, body.idempotencyKey),
    ...discussionEvent(db, person, d.id, op.time, field === 'labels' ? 'label' : field, {}, guard, [person.id, body.idempotencyKey]),
  ]);
  if (result[0].meta.changes !== 1) stale();
}

async function commentChange(db, env, person, row, kind, body) {
  if (!idOK(body.resourceId) || !idOK(body.issueId) || !Number.isInteger(body.number) || body.number < 1 || body.number > 4294967295 || !/^[a-f0-9]{64}$/.test(body.expectedRevision || '') || body.pullRequest !== undefined && typeof body.pullRequest !== 'boolean') invalid('Select the exact comment, discussion and revision.');
  if (body.label || body.milestone || body.reaction || body.reactionComment || body.subscriptionLogin) invalid('Use only a comment change.');
  const remove = kind === 'DELETE_COMMENT';
  if (remove && Object.hasOwn(body, 'commentBody')) invalid('Deletion does not include comment text.');
  const content = remove ? '' : text(body.commentBody, 12000);
  if (!remove && !content.trim()) invalid('Comment text is required.');
  const hash = await digest(JSON.stringify([row.id, kind, body.resourceId, body.issueId, body.number, !!body.pullRequest, body.expectedRevision, content]));
  const saved = await db.prepare('SELECT * FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?').bind(person.id, body.operationId).first();
  if (saved) {
    if (saved.repository_id !== row.id || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to a different comment change.');
    return { operation: JSON.parse(saved.receipt) };
  }
  const comment = await db.prepare(`SELECT c.* FROM discussion_comments c JOIN discussions d ON d.id=c.discussion_id
    WHERE c.id=? AND d.id=? AND d.repository_id=? AND d.number=? AND d.kind=?`).bind(body.resourceId, body.issueId, row.id, body.number, body.pullRequest ? 'pull' : 'issue').first();
  if (!comment || comment.author_id !== person.id && row.role !== 'admin') deny();
  const now = new Date().toISOString(), operation = { operationId: body.operationId, kind: 'DISCUSSION_RESOURCE_OPERATION_KIND_' + kind, phase: 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED', repository: { owner: ownerSlug(row,env), name: row.name }, repositoryId: String(row.id), resourceId: body.resourceId, observedResourceId: body.resourceId, expectedRevision: body.expectedRevision, issueId: body.issueId, number: body.number, pullRequest: !!body.pullRequest, createdAt: now, updatedAt: now };
  const refuse = async () => {
    operation.phase = 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED'; operation.failureCode = 'preflight_refused'; operation.observedResourceId = '';
    await db.prepare('INSERT INTO discussion_resource_operations VALUES(?,?,?,?,?)').bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation)).run();
    return { operation };
  };
  if (await digest(JSON.stringify([comment.id, comment.revision])) !== body.expectedRevision) return refuse();
  const record = db.prepare(`INSERT INTO discussion_resource_operations SELECT ?,?,?,?,? WHERE EXISTS(
    SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
      JOIN discussions d ON d.repository_id=r.id JOIN discussion_comments c ON c.discussion_id=d.id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND u.active=1
      AND (g.role='admin' OR c.author_id=u.id) AND c.id=? AND c.revision=? AND d.id=? AND d.number=? AND d.kind=?)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?`)
    .bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation), row.id, row.artifact_name, person.id, comment.id, comment.revision, comment.discussion_id, body.number, body.pullRequest ? 'pull' : 'issue', row.id, row.access_version);
  const guard = 'EXISTS(SELECT 1 FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?)';
  const change = remove ? db.prepare(`DELETE FROM discussion_comments WHERE id=? AND ${guard}`).bind(comment.id, person.id, body.operationId)
    : db.prepare(`UPDATE discussion_comments SET body=?,updated_at=?,revision=revision+1 WHERE id=? AND ${guard}`).bind(content, now, comment.id, person.id, body.operationId);
  const result = await db.batch([record, change, db.prepare(`UPDATE discussions SET revision=revision+1,updated_at=? WHERE id=? AND ${guard}`).bind(now, comment.discussion_id, person.id, body.operationId),
    ...discussionEvent(db, person, comment.discussion_id, now, remove ? 'deleted_comment' : 'edited_comment', {}, guard, [person.id, body.operationId])]);
  if (result[0].meta.changes !== 1) return refuse();
  return { operation };
}
