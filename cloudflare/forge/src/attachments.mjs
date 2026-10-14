import { settingsAuthority } from './repository-settings.mjs';
import { digest, uuidOK, deny, invalid, unsupported, Fault } from './common.mjs';
import { featureOff } from './feature-policy.mjs';
import { idOK, fileNameOK, decodeBytes, bytesDigest, storeObject, objectStored, uploadLimit } from './releases.mjs';

export const attachmentMethods = {
  DiscussionAttachmentService: new Set(['ListDiscussionAttachments', 'DownloadDiscussionAttachment']),
  DiscussionAttachmentUploadService: new Set(['GetDiscussionAttachmentUploadState', 'SubmitDiscussionAttachmentUpload', 'GetDiscussionAttachmentUploadOperation']),
};
const attachmentLimit = 100, hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const encodeBytes = bytes => { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(binary); };

async function target(db, row, value) {
  if (!value || value.repositoryId !== String(row.id) || !idOK(value.issueId) || !Number.isInteger(value.number) || value.number < 1 || value.number > 4294967295
    || value.pullRequest !== undefined && typeof value.pullRequest !== 'boolean' || value.commentId !== undefined && value.commentId !== '' && !idOK(value.commentId)) invalid('Select an exact discussion target.');
  const discussion = await db.prepare('SELECT * FROM discussions WHERE id=? AND repository_id=? AND number=? AND kind=?').bind(value.issueId, row.id, value.number, value.pullRequest ? 'pull' : 'issue').first();
  const comment = discussion && value.commentId ? await db.prepare('SELECT * FROM discussion_comments WHERE id=? AND discussion_id=?').bind(value.commentId, discussion.id).first() : null;
  if (!discussion || value.commentId && !comment) deny();
  return { discussion, comment, commentId: comment?.id || 0, wire: { repository: { owner: value.repository.owner, name: value.repository.name }, repositoryId: value.repositoryId, issueId: value.issueId, number: value.number,
    ...(value.pullRequest ? { pullRequest: true } : {}), ...(comment ? { commentId: value.commentId } : {}) } };
}
const revision = a => digest(JSON.stringify(['native.discussion-attachment.v1', a.id, a.discussion_id, a.comment_id, a.name, a.size, a.sha256, a.created_at]));
const attachment = async a => ({ id: String(a.id), name: a.name, sizeBytes: String(a.size), createdAt: a.created_at, revision: await revision(a) });
async function inventory(db, scope) {
  const { results } = await db.prepare('SELECT * FROM discussion_attachments WHERE discussion_id=? AND comment_id=? ORDER BY id LIMIT ?').bind(scope.discussion.id, scope.commentId, attachmentLimit).all();
  const attachments = await Promise.all(results.map(attachment));
  return { rows: results, attachments, revision: await digest(JSON.stringify(['native.discussion-attachments.v1', scope.discussion.id, scope.commentId, attachments.map(a => [a.id, a.revision])])) };
}
// The issue or pull request author or a current writer may attach to its description; a comment needs a writer who wrote it, or an administrator.
const allowed = (row, person, scope) => scope.comment ? ['write', 'admin'].includes(row.role) && (scope.comment.author_id === person.id || row.role === 'admin') : ['write', 'admin'].includes(row.role) || scope.discussion.author_id === person.id;
const targetRevision = (person, scope) => digest(JSON.stringify(['native.discussion-attachment-target.v1', scope.discussion.id, scope.discussion.number, scope.discussion.kind, scope.discussion.revision, scope.comment ? [scope.comment.id, scope.comment.revision] : null, person.id]));
const journal = (db, actor, operation) => db.prepare('SELECT * FROM discussion_attachment_operations WHERE actor_id=? AND operation_id=?').bind(actor, operation).first();
async function operationWire(db, saved) {
  const stored = saved.phase === 'SUCCEEDED' ? await db.prepare('SELECT * FROM discussion_attachments WHERE id=?').bind(saved.attachment_id).first() : null;
  return { contract: 'golf.discussion.attachment-upload.v1', original: JSON.parse(saved.original), actorId: String(saved.actor_id), phase: 'DISCUSSION_RESOURCE_OPERATION_PHASE_' + saved.phase,
    ...(stored ? { attachment: await attachment(stored) } : {}), createdAt: saved.created_at, updatedAt: saved.updated_at, failureCode: saved.phase === 'REJECTED' ? 'preflight_refused' : '' };
}

// Inspection never sends bytes again: it adopts the reserved object only when R2 reports exactly that upload.
async function settle(db, env, person, row, scope, saved) {
  if (saved.phase !== 'DISPATCH_UNKNOWN' || !allowed(row, person, scope)) return saved;
  const object = JSON.parse(saved.object), authority = settingsAuthority(person, row), time = new Date().toISOString();
  try { if (!await objectStored(env, object)) return saved; } catch { return saved; }
  await db.batch([
    db.prepare(`INSERT INTO discussion_attachments(repository_id,discussion_id,comment_id,name,size,sha256,r2_key,author_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${authority.sql}
      AND EXISTS(SELECT 1 FROM discussion_attachment_operations WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN')
      AND (?=0 OR EXISTS(SELECT 1 FROM discussion_comments WHERE id=? AND discussion_id=?))
      AND NOT EXISTS(SELECT 1 FROM discussion_attachments WHERE discussion_id=? AND comment_id=? AND name=?)
      AND (SELECT count(*) FROM discussion_attachments WHERE discussion_id=? AND comment_id=?)<?`)
      .bind(row.id, saved.discussion_id, saved.comment_id, object.name, object.size, object.sha256, object.key, person.id, time, ...authority.values, saved.actor_id, saved.operation_id,
        saved.comment_id, saved.comment_id, saved.discussion_id, saved.discussion_id, saved.comment_id, object.name, saved.discussion_id, saved.comment_id, attachmentLimit),
    db.prepare("UPDATE discussion_attachment_operations SET phase='SUCCEEDED',attachment_id=(SELECT id FROM discussion_attachments WHERE r2_key=?),updated_at=? WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN' AND changes()=1")
      .bind(object.key, time, saved.actor_id, saved.operation_id),
  ]);
  return journal(db, saved.actor_id, saved.operation_id);
}

async function upload(db, env, person, row, scope, body) {
  const size = typeof body.contentSizeBytes === 'number' ? body.contentSizeBytes : /^(0|[1-9][0-9]{0,6})$/.test(body.contentSizeBytes ?? '0') ? Number(body.contentSizeBytes ?? 0) : -1;
  if (!uuidOK(body.operationId) || !hashOK(body.expectedTargetRevision) || !hashOK(body.expectedAttachmentsRevision) || !fileNameOK(body.name) || !hashOK(body.contentSha256) || !Number.isSafeInteger(size) || size < 0 || size > uploadLimit)
    invalid('Bind the original target, attachment inventory, a file name of at most 255 bytes and exact bytes up to 256 KiB.');
  const content = decodeBytes(body.content);
  if (content.length !== size || await bytesDigest(content) !== body.contentSha256) invalid('The file bytes do not match the declared size and SHA-256.');
  const original = { target: scope.wire, expectedTargetRevision: body.expectedTargetRevision, expectedAttachmentsRevision: body.expectedAttachmentsRevision, operationId: body.operationId,
    name: body.name, contentSha256: body.contentSha256, contentSizeBytes: String(size) };
  const hash = await digest(JSON.stringify(['native.discussion-attachment-upload.v1', row.id, { ...original, operationId: '' }]));
  let saved = await journal(db, person.id, body.operationId);
  if (saved) {
    if (saved.repository_id !== row.id || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation ID belongs to a different attachment upload.');
    return { operation: await operationWire(db, await settle(db, env, person, row, scope, saved)) };
  }
  if (!allowed(row, person, scope)) deny();
  const list = await inventory(db, scope), time = new Date().toISOString(), authority = settingsAuthority(person, row);
  const admitted = body.expectedTargetRevision === await targetRevision(person, scope) && body.expectedAttachmentsRevision === list.revision && list.rows.length < attachmentLimit && !list.rows.some(a => a.name === body.name);
  const object = admitted ? { key: `attachments/${row.id}/${scope.discussion.id}/${crypto.randomUUID()}`, name: body.name, size, sha256: body.contentSha256 } : null;
  // The upload is reserved against the observed discussion before its bytes are dispatched; a refusal records that nothing was sent.
  const reserved = await db.prepare(`INSERT INTO discussion_attachment_operations(actor_id,operation_id,repository_id,discussion_id,comment_id,input_hash,original,phase,object,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,CASE WHEN ${admitted ? 'EXISTS(SELECT 1 FROM discussions WHERE id=? AND revision=?) AND (?=0 OR EXISTS(SELECT 1 FROM discussion_comments WHERE id=? AND revision=?))' : '0'} THEN 'DISPATCH_UNKNOWN' ELSE 'REJECTED' END,?,?,? WHERE ${authority.sql}`)
    .bind(person.id, body.operationId, row.id, scope.discussion.id, scope.commentId, hash, JSON.stringify(original), ...(admitted ? [scope.discussion.id, scope.discussion.revision, scope.commentId, scope.commentId, scope.comment?.revision || 0] : []),
      object && JSON.stringify(object), time, time, ...authority.values).run();
  if (reserved.meta.changes !== 1) deny();
  saved = await journal(db, person.id, body.operationId);
  if (saved.phase === 'DISPATCH_UNKNOWN') {
    try { await storeObject(env, object, content); } catch { /* The readback settles an unacknowledged write. */ }
    saved = await settle(db, env, person, row, scope, saved);
  }
  return { operation: await operationWire(db, saved) };
}

export async function discussionAttachments(db, env, person, row, method, body) {
  if (!env.EVIDENCE_BUCKET) unsupported();
  const scope = await target(db, row, body.target);
  if (method === 'SubmitDiscussionAttachmentUpload') return upload(db, env, person, row, scope, body);
  if (method === 'GetDiscussionAttachmentUploadOperation') {
    if (!uuidOK(body.operationId)) invalid('Inspect the original UUID v4 operation ID.');
    const saved = await journal(db, person.id, body.operationId);
    if (!saved || saved.repository_id !== row.id || saved.discussion_id !== scope.discussion.id || saved.comment_id !== scope.commentId) deny();
    return { operation: await operationWire(db, await settle(db, env, person, row, scope, saved)) };
  }
  const list = await inventory(db, scope);
  if (method === 'ListDiscussionAttachments') return { target: scope.wire, attachments: list.attachments, snapshotRevision: list.revision };
  if (method === 'GetDiscussionAttachmentUploadState') return { target: scope.wire, actorId: String(person.id), canUpload: allowed(row, person, scope) && list.rows.length < attachmentLimit && !await featureOff(db, env, row, 'attachments'),
    targetRevision: await targetRevision(person, scope), attachmentsRevision: list.revision, allowedTypes: '', maxSizeBytes: String(uploadLimit) };
  if (!idOK(body.attachmentId) || !hashOK(body.expectedRevision)) invalid('Select the attachment and its observed revision.');
  const index = list.rows.findIndex(a => String(a.id) === body.attachmentId);
  if (index < 0) deny();
  if (list.attachments[index].revision !== body.expectedRevision) throw new Fault('failed_precondition', 412, 'The attachment changed. Refresh before downloading.');
  const stored = list.rows[index], object = await env.EVIDENCE_BUCKET.get(stored.r2_key);
  // SHA-256 verified here and again by the client; a mismatch is never served.
  const bytes = object && object.size === stored.size ? new Uint8Array(await object.arrayBuffer()) : null, hash = bytes && await bytesDigest(bytes);
  if (!bytes || hash !== stored.sha256) throw Error('Attachment bytes could not be verified');
  return { target: scope.wire, attachment: list.attachments[index], content: encodeBytes(bytes), contentSha256: hash };
}
