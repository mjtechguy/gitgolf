import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concurrentRead } from './src/core.mjs';
import { objectFixture, proto, sha256, tokens, origin, repository } from './object-fixture.mjs';

const { create, toJson, fromJson, equals } = proto, Phase = proto.DiscussionResourceOperationPhase;
const hash = /^[a-f0-9]{64}$/, denied = { status: 404, code: 'not_found' }, users = { admin: '1', writer: '2', reader: '3', outsider: '4' };
const list = 'DiscussionAttachmentService/ListDiscussionAttachments', fetchBytes = 'DiscussionAttachmentService/DownloadDiscussionAttachment';
const state = 'DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadState', submit = 'DiscussionAttachmentUploadService/SubmitDiscussionAttachmentUpload', inspect = 'DiscussionAttachmentUploadService/GetDiscussionAttachmentUploadOperation';
// Issue 1 is carol's (a reader), pull request 2 alice's; comment 1 is bob's (a writer), comment 2 carol's.
const targets = { issue: { repository, repositoryId: '1', issueId: '1', number: 1 }, pull: { repository, repositoryId: '1', issueId: '2', number: 2, pullRequest: true },
  writerComment: { repository, repositoryId: '1', issueId: '1', number: 1, commentId: '1' }, readerComment: { repository, repositoryId: '1', issueId: '1', number: 1, commentId: '2' } };
async function fixture(t) {
  const f = await objectFixture(t), time = new Date().toISOString();
  f.sql.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'issue',3,'Issue','','OPEN',?,?),(2,1,2,'pull',1,'Pull','','OPEN',?,?)").run(time, time, time, time);
  f.sql.prepare('INSERT INTO discussion_comments(id,discussion_id,author_id,body,created_at,updated_at) VALUES(1,1,2,?,?,?),(2,1,3,?,?,?)').run('Writer', time, time, 'Reader', time, time);
  return f;
}
const target = value => create(proto.DiscussionTargetSchema, value);
// The checks web/src/DiscussionAttachmentUpload.tsx and DiscussionAttachments.tsx apply, on the generated descriptors.
async function uploadState(f, value, token = tokens.admin) {
  const json = await f.value(state, { target: value }, token);
  if (json.status) return json;
  const r = fromJson(proto.GetDiscussionAttachmentUploadStateResponseSchema, json);
  assert.ok(equals(proto.DiscussionTargetSchema, r.target, target(value))); assert.equal(r.actorId, users[Object.keys(tokens).find(k => tokens[k] === token)]);
  assert.match(r.targetRevision, hash); assert.match(r.attachmentsRevision, hash); assert.equal(r.maxSizeBytes, 256n * 1024n); assert.equal(typeof r.canUpload, 'boolean');
  return r;
}
async function inventory(f, value, token = tokens.admin) {
  const json = await f.value(list, { target: value }, token);
  if (json.status) return json;
  const r = fromJson(proto.ListDiscussionAttachmentsResponseSchema, json);
  assert.ok(equals(proto.DiscussionTargetSchema, r.target, target(value))); assert.match(r.snapshotRevision, hash); assert.ok(r.attachments.length <= 100);
  for (const a of r.attachments) { assert.match(a.id, /^[1-9][0-9]*$/); assert.ok(a.name); assert.match(a.revision, hash); assert.ok(Number.isFinite(Date.parse(a.createdAt))); }
  assert.equal(new Set(r.attachments.map(a => a.id)).size, r.attachments.length);
  return r;
}
async function upload(f, value, token = tokens.admin, content = new TextEncoder().encode('attached bytes'), name = 'notes.txt', change = draft => draft) {
  const current = await uploadState(f, value, token);
  const schema = proto.SubmitDiscussionAttachmentUploadRequestSchema, draft = change({ target: value, expectedTargetRevision: current.targetRevision || 'f'.repeat(64), expectedAttachmentsRevision: current.attachmentsRevision || 'f'.repeat(64),
    operationId: crypto.randomUUID(), name, content, contentSha256: sha256(content), contentSizeBytes: BigInt(content.length) });
  const message = create(schema, draft), json = await f.value(submit, toJson(schema, message), token);
  return { message, json, receipt: json.status ? json : receipt(json.operation, message, token) };
}
function receipt(json, message, token) {
  const r = fromJson(proto.DiscussionAttachmentUploadOperationSchema, json);
  assert.equal(r.contract, 'golf.discussion.attachment-upload.v1'); assert.equal(r.actorId, users[Object.keys(tokens).find(k => tokens[k] === token)]);
  assert.ok(equals(proto.SubmitDiscussionAttachmentUploadRequestSchema, r.original, create(proto.SubmitDiscussionAttachmentUploadRequestSchema, { ...message, content: new Uint8Array() })));
  assert.ok([Phase.DISPATCH_UNKNOWN, Phase.SUCCEEDED, Phase.REJECTED].includes(r.phase)); assert.equal(r.failureCode, r.phase === Phase.REJECTED ? 'preflight_refused' : '');
  assert.ok(Date.parse(r.updatedAt) >= Date.parse(r.createdAt));
  if (r.phase === Phase.SUCCEEDED) { assert.equal(r.attachment.name, message.name); assert.equal(r.attachment.sizeBytes, message.contentSizeBytes); assert.match(r.attachment.revision, hash); }
  else assert.equal(r.attachment, undefined);
  return r;
}
async function download(f, value, attachment, token = tokens.admin, expectedRevision = attachment.revision) {
  const json = await f.value(fetchBytes, { target: value, attachmentId: attachment.id, expectedRevision }, token);
  if (json.status) return json;
  const r = fromJson(proto.DownloadDiscussionAttachmentResponseSchema, json);
  assert.ok(equals(proto.DiscussionTargetSchema, r.target, target(value))); assert.ok(equals(proto.DiscussionAttachmentSchema, r.attachment, attachment));
  assert.equal(BigInt(r.content.length), attachment.sizeBytes); assert.equal(sha256(r.content), r.contentSha256);
  return r.content;
}
const inspected = async (f, value, sent, token = tokens.admin) => receipt((await f.value(inspect, { target: value, operationId: sent.message.operationId }, token)).operation, sent.message, token);

test('a reader who opened an issue attaches a file once; readers list it and download verified bytes', async t => {
  const f = await fixture(t), content = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 256);
  const before = await uploadState(f, targets.issue, tokens.reader);
  assert.equal(before.canUpload, true); assert.equal(before.allowedTypes, '');
  const sent = await upload(f, targets.issue, tokens.reader, content, 'trace ✓.bin');
  assert.equal(sent.receipt.phase, Phase.SUCCEEDED);
  const [[key, object]] = [...f.objects];
  assert.match(key, /^attachments\/1\/1\/[a-f0-9-]{36}$/); assert.deepEqual(object.bytes, content); assert.equal(object.customMetadata.sha256, sha256(content));
  // A replay or an inspection returns the original receipt and never writes again.
  assert.deepEqual(await f.value(submit, toJson(proto.SubmitDiscussionAttachmentUploadRequestSchema, sent.message), tokens.reader), sent.json);
  assert.deepEqual(await inspected(f, targets.issue, sent, tokens.reader), sent.receipt);
  assert.deepEqual(await f.value(submit, toJson(proto.SubmitDiscussionAttachmentUploadRequestSchema, create(proto.SubmitDiscussionAttachmentUploadRequestSchema, { ...sent.message, name: 'other.bin' })), tokens.reader), { status: 409, code: 'already_exists' });
  assert.equal(f.bucket.puts, 1);
  const listed = await inventory(f, targets.issue, tokens.writer);
  assert.deepEqual(listed.attachments.map(a => [a.id, a.name, a.sizeBytes]), [[sent.receipt.attachment.id, 'trace ✓.bin', 256n * 1024n]]);
  assert.ok(equals(proto.DiscussionAttachmentSchema, listed.attachments[0], sent.receipt.attachment));
  assert.notEqual((await uploadState(f, targets.issue, tokens.reader)).attachmentsRevision, before.attachmentsRevision);
  assert.deepEqual(await download(f, targets.issue, listed.attachments[0], tokens.reader), content);
  assert.deepEqual(await download(f, targets.issue, listed.attachments[0], tokens.reader, 'f'.repeat(64)), { status: 412, code: 'failed_precondition' });
  // Attachments belong to one description or comment.
  assert.deepEqual((await inventory(f, targets.writerComment)).attachments, []);
  assert.deepEqual(await download(f, targets.writerComment, listed.attachments[0]), denied);
  for (const other of [{ ...targets.issue, number: 2 }, { ...targets.issue, pullRequest: true }, { ...targets.issue, commentId: '9' }, { ...targets.issue, repositoryId: '2' }]) assert.equal((await f.value(list, { target: other })).status, 404, JSON.stringify(other));
  assert.deepEqual(await f.value(list, { target: { ...targets.issue, number: 0 } }), { status: 400, code: 'invalid_argument' });
});

test('upload authority follows the portable rule: description author or writer; comment author while a writer, or an administrator', async t => {
  const f = await fixture(t);
  const cases = [['issue', 'reader', true], ['issue', 'writer', true], ['issue', 'admin', true], ['pull', 'reader', false], ['pull', 'writer', true],
    ['writerComment', 'writer', true], ['writerComment', 'reader', false], ['writerComment', 'admin', true], ['readerComment', 'reader', false], ['readerComment', 'writer', false], ['readerComment', 'admin', true]];
  for (const [where, who, permitted] of cases) {
    const current = await uploadState(f, targets[where], tokens[who]);
    assert.equal(current.canUpload, permitted, `${who} on ${where}`);
    const sent = await upload(f, targets[where], tokens[who], new TextEncoder().encode(where + who), `${where}-${who}.txt`);
    if (permitted) assert.equal(sent.receipt.phase, Phase.SUCCEEDED, `${who} on ${where}`);
    else assert.deepEqual(sent.json, denied, `${who} on ${where}`);
  }
  for (const method of [state, list]) assert.deepEqual(await f.value(method, { target: targets.issue }, tokens.outsider), denied);
  assert.equal((await f.value(list, { target: targets.issue }, null)).status, 401);
  assert.equal(f.sql.prepare('SELECT count(*) AS total FROM discussion_attachment_operations').get().total, 7);
  assert.equal(f.objects.size, 7);
});

test('stale observations, duplicates and the 100-file bound are refused with a receipt; malformed bytes are refused outright', async t => {
  const f = await fixture(t);
  assert.equal((await upload(f, targets.issue, tokens.writer, undefined, 'first.txt')).receipt.phase, Phase.SUCCEEDED);
  const rejected = async (change, message) => { const sent = await upload(f, targets.issue, tokens.writer, undefined, 'next.txt', change); assert.equal(sent.receipt.phase, Phase.REJECTED, message); return sent; };
  await rejected(draft => ({ ...draft, name: 'first.txt' }), 'duplicate name');
  await rejected(draft => ({ ...draft, expectedTargetRevision: 'f'.repeat(64) }), 'stale target');
  await rejected(draft => ({ ...draft, expectedAttachmentsRevision: 'f'.repeat(64) }), 'stale inventory');
  // A discussion change between the observation and the submit.
  const observed = await uploadState(f, targets.issue, tokens.writer);
  f.sql.exec('UPDATE discussions SET revision=revision+1 WHERE id=1');
  await rejected(draft => ({ ...draft, expectedTargetRevision: observed.targetRevision }), 'discussion changed');
  const puts = f.bucket.puts, content = new TextEncoder().encode('exact');
  for (const [change, message] of [[draft => ({ ...draft, contentSha256: 'f'.repeat(64) }), 'hash mismatch'], [draft => ({ ...draft, contentSizeBytes: 4n }), 'size mismatch'],
    [draft => ({ ...draft, name: 'a/b' }), 'path separator'], [draft => ({ ...draft, name: ' padded' }), 'padded name'], [draft => ({ ...draft, operationId: 'original' }), 'operation ID'],
    [draft => ({ ...draft, content: new Uint8Array(256 * 1024 + 1), contentSizeBytes: BigInt(256 * 1024 + 1), contentSha256: sha256(new Uint8Array(256 * 1024 + 1)) }), 'over 256 KiB']])
    assert.deepEqual((await upload(f, targets.issue, tokens.writer, content, 'bad.txt', change)).json, { status: 400, code: 'invalid_argument' }, message);
  const oversized = await upload(f, targets.issue, tokens.writer, new Uint8Array(310 * 1024), 'huge.bin');
  assert.deepEqual(oversized.json, { status: 429, code: 'resource_exhausted' });
  assert.equal(f.bucket.puts, puts);
  const insert = f.sql.prepare("INSERT INTO discussion_attachments(repository_id,discussion_id,comment_id,name,size,sha256,r2_key,author_id,created_at) VALUES(1,1,0,?,0,'',?,2,?)");
  for (let index = 0; index < 98; index++) insert.run('seed-' + index, 'attachments/1/1/seed-' + index, new Date().toISOString());
  assert.equal((await upload(f, targets.issue, tokens.writer, undefined, 'hundredth.txt')).receipt.phase, Phase.SUCCEEDED);
  assert.equal((await inventory(f, targets.issue)).attachments.length, 100);
  assert.equal((await uploadState(f, targets.issue, tokens.writer)).canUpload, false);
  await rejected(draft => draft, 'over 100 files');
});

test('an unacknowledged attachment write settles by inspection and is never sent twice', async t => {
  const f = await fixture(t);
  f.bucket.loseAcknowledgement = true; f.bucket.failHead = true;
  const unknown = await upload(f, targets.issue, tokens.writer);
  assert.equal(unknown.receipt.phase, Phase.DISPATCH_UNKNOWN);
  assert.equal((await inventory(f, targets.issue)).attachments.length, 0);
  f.bucket.loseAcknowledgement = false; f.bucket.failHead = false;
  const puts = f.bucket.puts, settled = await inspected(f, targets.issue, unknown, tokens.writer);
  assert.equal(settled.phase, Phase.SUCCEEDED); assert.equal(f.bucket.puts, puts);
  assert.deepEqual((await inventory(f, targets.issue)).attachments.map(a => a.id), [settled.attachment.id]);
  assert.deepEqual(await inspected(f, { ...targets.issue }, unknown, tokens.writer), settled);
  assert.deepEqual(await f.value(inspect, { target: targets.writerComment, operationId: unknown.message.operationId }, tokens.writer), denied);
  assert.deepEqual(await f.value(inspect, { target: targets.issue, operationId: unknown.message.operationId }, tokens.admin), denied);
  // The write never arrived: inspection observes R2 only, and the name stays free for a new upload.
  f.bucket.losePut = true;
  const lost = await upload(f, targets.issue, tokens.writer, undefined, 'lost.txt');
  f.bucket.losePut = false;
  assert.equal(lost.receipt.phase, Phase.DISPATCH_UNKNOWN);
  const attempts = f.bucket.puts;
  assert.equal((await inspected(f, targets.issue, lost, tokens.writer)).phase, Phase.DISPATCH_UNKNOWN); assert.equal(f.bucket.puts, attempts);
  assert.equal((await upload(f, targets.issue, tokens.writer, undefined, 'lost.txt')).receipt.phase, Phase.SUCCEEDED);
});

test('a revoked grant ends listing, download and receipt reads; altered bytes are never served; no bucket means DISABLED', async t => {
  const f = await fixture(t), sent = await upload(f, targets.issue, tokens.writer), [attachment] = (await inventory(f, targets.issue, tokens.writer)).attachments;
  const [[key, object]] = [...f.objects];
  f.objects.set(key, { ...object, bytes: new TextEncoder().encode('ATTACHED BYTES') });
  assert.deepEqual(await download(f, targets.issue, attachment, tokens.writer), { status: 503, code: 'unavailable' });
  f.objects.delete(key);
  assert.deepEqual(await download(f, targets.issue, attachment, tokens.writer), { status: 503, code: 'unavailable' });
  f.sql.exec('DELETE FROM grants WHERE user_id=2');
  for (const [method, body] of [[list, { target: targets.issue }], [state, { target: targets.issue }], [fetchBytes, { target: targets.issue, attachmentId: attachment.id, expectedRevision: attachment.revision }], [inspect, { target: targets.issue, operationId: sent.message.operationId }]])
    assert.deepEqual(await f.value(method, body, tokens.writer), denied, method);
  const capability = async () => (await f.value('CapabilityService/ListCapabilities')).capabilities.find(c => c.id === 'discussion.attachments');
  assert.equal((await capability()).state, 'CAPABILITY_STATE_READY'); assert.match((await capability()).reason, /SHA-256 verified on download/);
  delete f.env.EVIDENCE_BUCKET;
  assert.equal((await capability()).state, 'CAPABILITY_STATE_DISABLED');
  for (const method of [list, fetchBytes, state, submit, inspect, 'DiscussionAttachmentService/SubmitDiscussionAttachmentUpload']) assert.deepEqual(await f.value(method, { target: targets.issue }), { status: 501, code: 'unimplemented' }, method);
  const request = path => new Request(origin + '/rpc/golf.v1.' + path, { method: 'POST' });
  for (const path of [list, fetchBytes, state]) assert.equal(concurrentRead(request(path)), true, path);
  for (const path of [submit, inspect]) assert.equal(concurrentRead(request(path)), false, path);
});
