import { ownerSlug } from './owners.mjs';
import { digest, deny, invalid, Fault, page, user } from './common.mjs';

export const engagementMethods = new Set(['GetDiscussionEngagement', 'ListDiscussionTimeline', 'ListOwnForgeNotifications']);
const contents = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'];
const idOK = v => typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v));

async function target(db, row, value) {
  if (!value || value.repositoryId !== String(row.id) || !idOK(value.issueId) || !Number.isInteger(value.number) || value.number < 1 || value.number > 4294967295 || value.pullRequest !== undefined && typeof value.pullRequest !== 'boolean' || value.commentId && !idOK(value.commentId)) invalid('Select an exact discussion target.');
  const d = await db.prepare('SELECT * FROM discussions WHERE id=? AND repository_id=? AND number=? AND kind=?')
    .bind(value.issueId, row.id, value.number, value.pullRequest ? 'pull' : 'issue').first();
  if (!d) deny();
  if (value.commentId && !await db.prepare('SELECT id FROM discussion_comments WHERE id=? AND discussion_id=?').bind(value.commentId, d.id).first()) deny();
  return d;
}
async function observation(db, person, d, commentId) {
  const [version, rows, subscription] = await Promise.all([
    db.prepare('SELECT version FROM discussion_engagement_versions WHERE discussion_id=? AND comment_id=?').bind(d.id, commentId).first(),
    db.prepare('SELECT content,count(*) AS total,max(user_id=?) AS reacted FROM discussion_reactions WHERE discussion_id=? AND comment_id=? GROUP BY content').bind(person.id, d.id, commentId).all(),
    db.prepare('SELECT 1 AS present FROM discussion_subscriptions WHERE discussion_id=? AND user_id=?').bind(d.id, person.id).first(),
  ]);
  const reactions = contents.map(content => { const r = rows.results.find(r => r.content === content); return { content, count: r?.total || 0, reacted: Boolean(r?.reacted) }; });
  const revision = await digest(JSON.stringify([d.id, commentId, person.id, person.identity_version, version?.version || 0]));
  return { reactions, subscribed: Boolean(subscription), revision, canReact: true, canSubscribe: !commentId, actorLogin: person.login, version: version?.version || 0 };
}
const notificationRevision = n => digest(JSON.stringify([n.id, n.user_id, n.discussion_id, n.revision]));
export async function engagement(db, env, person, row, method, body) {
  const paging = page(body);
  if (method === 'ListOwnForgeNotifications') {
    if (body.includeRead !== undefined && typeof body.includeRead !== 'boolean') invalid('Use an explicit read filter.');
    const rows = await db.prepare(`SELECT n.*,d.title,d.number,d.kind,r.id AS repository_id,r.name,o.slug AS owner_slug FROM discussion_notifications n
      JOIN discussions d ON d.id=n.discussion_id JOIN repositories r ON r.id=d.repository_id LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id JOIN grants g ON g.repository_id=r.id AND g.user_id=n.user_id
      WHERE n.user_id=? AND r.state='ACTIVE' ${body.includeRead ? '' : 'AND n.unread=1'} ORDER BY n.id DESC LIMIT ? OFFSET ?`)
      .bind(person.id, paging.limit + 1, paging.offset).all();
    return { notifications: await Promise.all(rows.results.slice(0, paging.limit).map(async n => ({ id: String(n.id), title: n.title, unread: Boolean(n.unread), pinned: false,
      updatedAt: n.created_at, revision: await notificationRevision(n), target: { repository: { owner: ownerSlug(n,env), name: n.name }, repositoryId: String(n.repository_id), issueId: String(n.discussion_id), number: n.number, pullRequest: n.kind === 'pull' } }))),
      page: { nextPage: rows.results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  const d = await target(db, row, body.target);
  if (method === 'GetDiscussionEngagement') {
    const { version, ...value } = await observation(db, person, d, Number(body.target.commentId || 0)); return value;
  }
  if (body.target.commentId) invalid('Timeline belongs to the whole discussion.');
  const rows = await db.prepare(`SELECT e.*,u.login,u.email,COALESCE(p.full_name,u.full_name) AS full_name FROM discussion_events e JOIN users u ON u.id=e.actor_id
    LEFT JOIN profiles p ON p.user_id=u.id WHERE e.discussion_id=? ORDER BY e.created_at,e.rowid LIMIT ? OFFSET ?`).bind(d.id, paging.limit + 1, paging.offset).all();
  return { events: rows.results.slice(0, paging.limit).map(e => ({ ...JSON.parse(e.payload), id: e.id, kind: e.kind, actor: user({ ...e, id: e.actor_id }), createdAt: e.created_at })),
    page: { nextPage: rows.results.length > paging.limit ? paging.number + 1 : 0 } };
}

// Called inside the same admitted mutation batch; no event or inbox entry after a refused write.
export function discussionEvent(db, person, discussionId, time, kind, payload, guard, values) {
  const id = crypto.randomUUID();
  return [
    db.prepare(`INSERT INTO discussion_events SELECT ?,?,?,?,?,? WHERE ${guard}`).bind(id, discussionId, person.id, kind, JSON.stringify(payload), time, ...values),
    db.prepare(`INSERT INTO discussion_notifications(user_id,discussion_id,event_id,created_at)
      SELECT s.user_id,s.discussion_id,e.id,e.created_at FROM discussion_subscriptions s JOIN discussion_events e ON e.discussion_id=s.discussion_id
      JOIN discussions d ON d.id=s.discussion_id JOIN grants g ON g.repository_id=d.repository_id AND g.user_id=s.user_id JOIN users u ON u.id=s.user_id
      WHERE e.id=? AND s.user_id!=? AND u.active=1`).bind(id, person.id),
  ];
}

export async function engagementChange(db, env, person, row, kind, body) {
  const react = kind.endsWith('REACTION'), mark = kind === 'MARK_NOTIFICATION_READ';
  if (!idOK(body.resourceId) || !/^[a-f0-9]{64}$/.test(body.expectedRevision || '') || body.reactionComment !== undefined && typeof body.reactionComment !== 'boolean' ||
      ['label', 'milestone', 'commentBody'].some(k => Object.hasOwn(body, k)) ||
      (react ? !contents.includes(body.reaction) || body.subscriptionLogin : Object.hasOwn(body, 'reaction') || body.reactionComment || (mark ? body.subscriptionLogin : body.subscriptionLogin !== person.login))) invalid('Use only the exact engagement change for your own identity.');
  if (!react && !mark && body.resourceId !== body.issueId || react && !body.reactionComment && body.resourceId !== body.issueId) invalid('Use the discussion identity.');
  const commentId = react && body.reactionComment ? Number(body.resourceId) : 0;
  const hash = await digest(JSON.stringify([row.id, kind, body.resourceId, body.issueId, body.number, !!body.pullRequest, !!body.reactionComment, body.expectedRevision, body.reaction || '', body.subscriptionLogin || '']));
  const saved = await db.prepare('SELECT * FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?').bind(person.id, body.operationId).first();
  if (saved) {
    if (saved.repository_id !== row.id || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to another engagement change.');
    return { operation: JSON.parse(saved.receipt) };
  }
  const d = await target(db, row, { ...body, commentId: commentId ? body.resourceId : '' });
  const observed = mark ? await db.prepare('SELECT * FROM discussion_notifications WHERE id=? AND user_id=? AND discussion_id=?').bind(body.resourceId, person.id, d.id).first() : await observation(db, person, d, commentId);
  if (!observed) deny();
  const time = new Date().toISOString(), operation = { operationId: body.operationId, kind: 'DISCUSSION_RESOURCE_OPERATION_KIND_' + kind, phase: 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED', repository: { owner: ownerSlug(row,env), name: row.name }, repositoryId: String(row.id), resourceId: body.resourceId, observedResourceId: body.resourceId, expectedRevision: body.expectedRevision, issueId: body.issueId, number: body.number, pullRequest: !!body.pullRequest, reactionComment: !!body.reactionComment, createdAt: time, updatedAt: time };
  const refuse = async () => {
    operation.phase = 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED'; operation.failureCode = 'preflight_refused'; operation.observedResourceId = '';
    await db.prepare('INSERT INTO discussion_resource_operations VALUES(?,?,?,?,?)').bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation)).run();
    return { operation };
  };
  if ((mark ? await notificationRevision(observed) : observed.revision) !== body.expectedRevision) return refuse();
  const record = db.prepare(`INSERT INTO discussion_resource_operations SELECT ?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
      WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND u.active=1)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?
    ${person.credential_digest ? 'AND EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=? AND revoked=0 AND expires_at>unixepoch())' : ''}
    AND EXISTS(SELECT 1 FROM discussions WHERE id=? AND revision=?)
    ${commentId ? 'AND EXISTS(SELECT 1 FROM discussion_comments WHERE id=? AND discussion_id=?)' : ''}
    ${mark ? 'AND EXISTS(SELECT 1 FROM discussion_notifications WHERE id=? AND user_id=? AND revision=?)' : 'AND COALESCE((SELECT version FROM discussion_engagement_versions WHERE discussion_id=? AND comment_id=?),0)=?'}
    ${kind === 'SUBSCRIBE' ? 'AND (SELECT count(*) FROM discussion_subscriptions WHERE discussion_id=?)<1000' : ''}`)
    .bind(person.id, body.operationId, row.id, hash, JSON.stringify(operation), row.id, row.artifact_name, person.id, row.id, row.access_version, person.id, person.identity_version,
      ...(person.credential_digest ? [person.credential_digest, person.id] : []), d.id, d.revision, ...(commentId ? [commentId, d.id] : []), ...(mark ? [observed.id, person.id, observed.revision] : [d.id, commentId, observed.version]), ...(kind === 'SUBSCRIBE' ? [d.id] : []));
  const guard = 'EXISTS(SELECT 1 FROM discussion_resource_operations WHERE actor_id=? AND operation_key=?)', values = [person.id, body.operationId];
  let change;
  if (react) change = kind === 'ADD_REACTION' ? db.prepare(`INSERT INTO discussion_reactions SELECT ?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(d.id, commentId, person.id, body.reaction, ...values)
    : db.prepare(`DELETE FROM discussion_reactions WHERE discussion_id=? AND comment_id=? AND user_id=? AND content=? AND ${guard}`).bind(d.id, commentId, person.id, body.reaction, ...values);
  else if (mark) change = db.prepare(`UPDATE discussion_notifications SET unread=0,revision=revision+1 WHERE id=? AND user_id=? AND ${guard}`).bind(observed.id, person.id, ...values);
  else change = kind === 'SUBSCRIBE' ? db.prepare(`INSERT INTO discussion_subscriptions SELECT ?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(d.id, person.id, ...values)
    : db.prepare(`DELETE FROM discussion_subscriptions WHERE discussion_id=? AND user_id=? AND ${guard}`).bind(d.id, person.id, ...values);
  const result = await db.batch([record, change]);
  if (result[0].meta.changes !== 1) return refuse();
  return { operation };
}
