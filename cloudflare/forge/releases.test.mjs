import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concurrentRead } from './src/core.mjs';
import { objectFixture, proto, sha256, tokens, commit, tagObject, origin, repository } from './object-fixture.mjs';

const { create, toBinary, toJson, fromJson } = proto, Phase = proto.RepositoryReleasePublicationPhase, Kind = proto.RepositoryReleaseOperationKind;
const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/, hash = /^[a-f0-9]{64}$/, identity = /^[1-9][0-9]*$/;
const publish = 'RepositoryReleasePublicationService/SubmitRepositoryReleasePublication', publication = 'RepositoryReleasePublicationService/GetRepositoryReleasePublicationOperation';
const manage = 'RepositoryReleaseManagementService/SubmitRepositoryReleaseOperation', inspect = 'RepositoryReleaseManagementService/GetRepositoryReleaseOperation';
const scope = { repository, repositoryId: '1' }, denied = { status: 404, code: 'not_found' }, download = (release, asset) => `/api/repositories/alice/project/1/releases/${release}/assets/${asset}/download`;

// The conditions web/src/ReleasePublication.tsx verifies before it trusts a receipt, on the generated descriptors.
function publicationReceipt(json, request) {
  const v = fromJson(proto.RepositoryReleasePublicationOperationSchema, json);
  assert.equal(v.contract, 'golf.repository.release-publication.v1');
  assert.deepEqual([v.operationId, v.actorId, v.repository.owner, v.repository.name, v.repositoryId, v.ownerId, v.accessRevision, v.tagName, v.tagObjectId, v.commitId, v.prerelease, v.titleSha256, v.bodySha256],
    [request.operationId, '1', 'alice', 'project', '1', '1', request.accessRevision, request.tagName, request.tagObjectId, request.commitId, Boolean(request.prerelease), sha256(request.title), sha256(request.bodyMarkdown || '')]);
  assert.ok([Phase.SUCCEEDED, Phase.REJECTED].includes(v.phase));
  assert.match(v.createdAt, stamp); assert.match(v.updatedAt, stamp); assert.ok(Date.parse(v.updatedAt) >= Date.parse(v.createdAt));
  if (v.phase === Phase.SUCCEEDED) assert.match(v.releaseId, identity); else assert.equal(v.releaseId, '');
  assert.equal(v.failureCode, v.phase === Phase.REJECTED ? 'preflight_refused' : '');
  return v;
}
// web/src/ReleaseManagement.tsx hashes the binary request without its operation ID, then sends the same message as Connect JSON.
function change(release, access, draft) {
  const schema = proto.SubmitRepositoryReleaseOperationRequestSchema, operationId = crypto.randomUUID();
  const fields = { repository, repositoryId: '1', ownerId: '1', accessRevision: access.revision, releaseId: release.id, expectedRevision: release.revision, ...draft };
  return { json: toJson(schema, create(schema, { ...fields, operationId })),
    original: { operationId, kind: draft.kind, assetId: draft.assetId || '', releaseId: release.id, expectedRevision: release.revision, inputSha256: sha256(toBinary(schema, create(schema, fields))) } };
}
function operationReceipt(json, original) {
  const v = fromJson(proto.RepositoryReleaseOperationSchema, json);
  assert.equal(v.contract, 'golf.repository.release-operation.v1');
  assert.deepEqual([v.operationId, v.actorId, v.repositoryId, v.ownerId, v.repository.owner, v.repository.name, v.releaseId, v.kind, v.expectedRevision, v.inputSha256],
    [original.operationId, '1', '1', '1', 'alice', 'project', original.releaseId, original.kind, original.expectedRevision, original.inputSha256]);
  assert.ok([Phase.DISPATCH_UNKNOWN, Phase.SUCCEEDED, Phase.REJECTED].includes(v.phase));
  assert.equal(v.failureCode, v.phase === Phase.REJECTED ? 'preflight_refused' : '');
  if (original.kind !== Kind.UPLOAD_ASSET) assert.equal(v.assetId, original.assetId);
  else if (v.phase === Phase.SUCCEEDED) assert.match(v.assetId, identity); else assert.equal(v.assetId, '');
  return v;
}
async function published(f, extra = {}) {
  const request = { ...f.target, accessRevision: (await f.access()).revision, operationId: crypto.randomUUID(), tagName: 'v1.0', tagObjectId: tagObject, commitId: commit, title: 'First release', bodyMarkdown: '# Notes', ...extra };
  const json = await f.value(publish, request);
  return { request, json, receipt: publicationReceipt(json.operation, request) };
}
// The conditions web/src/RepositoryReleases.tsx applies to a release.
async function release(f, releaseId, token) {
  const json = await f.value('RepositoryService/GetRepositoryRelease', { ...scope, releaseId }, token);
  if (json.status) return json;
  const response = fromJson(proto.GetRepositoryReleaseResponseSchema, json), value = response.release;
  assert.deepEqual([response.repository.owner, response.repository.name, response.repositoryId, value.id], ['alice', 'project', '1', releaseId]);
  assert.match(value.revision, hash); assert.match(value.createdAt, stamp); assert.match(value.publishedAt, stamp);
  assert.equal(value.assetCount, String(value.assets.length)); assert.ok(value.assets.length <= 100);
  for (const asset of value.assets) { assert.match(asset.id, identity); assert.match(asset.sizeBytes, /^(0|[1-9][0-9]*)$/); assert.match(asset.downloadCount, /^(0|[1-9][0-9]*)$/); assert.match(asset.createdAt, stamp); }
  return value;
}
async function submit(f, current, draft) {
  const sent = change(current, await f.access(), draft), json = await f.value(manage, sent.json);
  return json.status ? json : { ...sent, receipt: operationReceipt(json.operation, sent.original) };
}
const bytes = (size, fill = 7) => new Uint8Array(size).fill(fill);
const upload = (f, current, name = 'tool.bin', content = bytes(1024)) => submit(f, current, { kind: Kind.UPLOAD_ASSET, assetName: name, assetContent: content });

test('an administrator publishes a release for an existing tag once; a replay returns the original receipt', async t => {
  const f = await objectFixture(t), first = await published(f);
  assert.equal(first.receipt.phase, Phase.SUCCEEDED);
  assert.deepEqual(await f.value(publish, first.request), first.json);
  assert.deepEqual(await f.value(publication, { ...f.target, operationId: first.request.operationId }), first.json);
  assert.deepEqual(await f.value(publish, { ...first.request, title: 'Another title' }), { status: 409, code: 'already_exists' });
  assert.equal(f.sql.prepare('SELECT count(*) AS total FROM repository_releases').get().total, 1);
  const value = await release(f, first.receipt.releaseId, tokens.reader);
  assert.deepEqual([value.title, value.tagName, value.targetCommitish, value.bodyMarkdown, value.draft, value.prerelease, value.author.id, value.author.login, value.author.fullName, value.assetCount],
    ['First release', 'v1.0', commit, '# Notes', false, false, '1', 'alice', 'Alice A', '0']);
  // A lightweight tag names its commit as the tag object.
  const light = await published(f, { tagName: 'light', tagObjectId: commit, prerelease: true, bodyMarkdown: '' });
  assert.equal(light.receipt.phase, Phase.SUCCEEDED);
  const page = fromJson(proto.ListRepositoryReleasesResponseSchema, await f.value('RepositoryService/ListRepositoryReleases', { ...scope, page: { page: 1, limit: 20 } }, tokens.reader));
  assert.deepEqual([page.repository.owner, page.repository.name, page.repositoryId, page.totalCount, page.page.nextPage, page.releases.map(r => r.tagName)], ['alice', 'project', '1', '2', 0, ['light', 'v1.0']]);
  assert.equal(page.releases[0].prerelease, true);
  for (const token of [tokens.outsider, null]) assert.deepEqual(await f.value('RepositoryService/ListRepositoryReleases', scope, token), token ? denied : { status: 401, code: 'unauthenticated' });
});

test('the release inventory pages exactly and hides drafts from readers', async t => {
  const f = await objectFixture(t), time = new Date().toISOString();
  const insert = f.sql.prepare('INSERT INTO repository_releases(repository_id,artifact_name,tag_name,tag_object_id,commit_id,title,body,draft,author_id,created_at,published_at) VALUES(1,?,?,?,?,?,?,?,1,?,?)');
  for (let index = 1; index <= 22; index++) insert.run('repo-' + 'b'.repeat(32), 'v' + index, commit, commit, 'Release ' + index, '', Number(index === 22), time, time);
  const list = async (page, token, limit = 20) => { const json = await f.value('RepositoryService/ListRepositoryReleases', { ...scope, page: { page, limit } }, token); return json.status ? json : fromJson(proto.ListRepositoryReleasesResponseSchema, json); };
  const first = await list(1, tokens.writer), second = await list(2, tokens.writer);
  assert.deepEqual([first.releases.length, first.page.nextPage, first.totalCount, first.releases[0].draft, second.releases.length, second.page.nextPage, second.totalCount], [20, 2, '22', true, 2, 0, '22']);
  assert.equal(new Set([...first.releases, ...second.releases].map(r => r.id)).size, 22);
  const reader = await list(1, tokens.reader), rest = await list(2, tokens.reader);
  assert.deepEqual([reader.totalCount, reader.releases.length, reader.releases.some(r => r.draft), rest.releases.length, rest.page.nextPage], ['21', 20, false, 1, 0]);
  assert.deepEqual(await release(f, '22', tokens.reader), denied);
  assert.equal((await release(f, '22', tokens.writer)).draft, true);
  assert.deepEqual(await list(1, tokens.admin, 51), { status: 400, code: 'invalid_argument' });
});

test('publication is refused when the tag moved, is missing, has a release, tag rules exist or the access observation is stale', async t => {
  const f = await objectFixture(t);
  const refused = async (extra, message) => { const result = await published(f, extra); assert.equal(result.receipt.phase, Phase.REJECTED, message); assert.deepEqual(await f.value(publish, result.request), result.json); };
  // The tag moved between the client's observation and the submit.
  f.refs.set('refs/tags/v1.0^{}', 'd'.repeat(40)); await refused({}, 'moved commit');
  f.refs.set('refs/tags/v1.0^{}', commit); f.refs.set('refs/tags/v1.0', 'e'.repeat(40)); await refused({}, 'moved tag object');
  f.refs.set('refs/tags/v1.0', tagObject);
  await refused({ tagName: 'v9.9' }, 'missing tag');
  await refused({ accessRevision: 'f'.repeat(64) }, 'stale access');
  f.sql.prepare("INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag) VALUES(1,?,1,'[]',?,2)").run('repo-' + 'b'.repeat(32), JSON.stringify([{ id: '1', namePattern: 'other*', allowedUsernames: ['alice'], allowedActors: [1] }]));
  await refused({}, 'tag rules');
  f.sql.exec("UPDATE repository_rules SET tags='[]',version=2");
  f.sql.exec("UPDATE repositories SET write_pending='unresolved'"); await refused({}, 'unresolved Git write'); f.sql.exec('UPDATE repositories SET write_pending=NULL');
  assert.equal(f.sql.prepare('SELECT count(*) AS total FROM repository_releases').get().total, 0);
  assert.equal((await published(f)).receipt.phase, Phase.SUCCEEDED);
  await refused({}, 'tag already released');
  assert.equal(f.sql.prepare('SELECT count(*) AS total FROM repository_releases').get().total, 1);
  // Writers, readers and outsiders hold no publication authority and leave no receipt.
  const request = { ...f.target, accessRevision: 'f'.repeat(64), operationId: crypto.randomUUID(), tagName: 'light', tagObjectId: commit, commitId: commit, title: 'Light' };
  for (const token of [tokens.writer, tokens.reader, tokens.outsider]) assert.deepEqual(await f.value(publish, { ...request, accessRevision: (await f.access(token))?.revision || 'f'.repeat(64) }, token), denied);
  assert.equal(f.sql.prepare("SELECT count(*) AS total FROM repository_release_operations WHERE actor_id!=1").get().total, 0);
  for (const invalid of [{ title: ' padded' }, { title: 'x'.repeat(256) }, { title: 'bad\ntitle' }, { bodyMarkdown: 'x'.repeat(16385) }, { tagName: 'refs/tags/light' }, { tagName: 'bad tag' }, { commitId: 'abc' }, { operationId: 'not-a-uuid' }, { prerelease: 'yes' }])
    assert.deepEqual(await f.value(publish, { ...request, accessRevision: (await f.access()).revision, ...invalid }), { status: 400, code: 'invalid_argument' }, JSON.stringify(invalid).slice(0, 40));
});

test('release edits, asset upload, rename and removal are revision-fenced and hash exactly as the web client does', async t => {
  const f = await objectFixture(t), { receipt } = await published(f);
  let current = await release(f, receipt.releaseId);
  const edited = await submit(f, current, { kind: Kind.EDIT, title: 'Edited', bodyMarkdown: 'Notes ✓', draft: true, prerelease: true });
  assert.equal(edited.receipt.phase, Phase.SUCCEEDED);
  // A replay returns the original receipt; the stale revision it carries cannot edit twice.
  assert.deepEqual(operationReceipt((await f.value(manage, edited.json)).operation, edited.original), edited.receipt);
  assert.deepEqual(operationReceipt((await f.value(inspect, { ...f.target, operationId: edited.original.operationId })).operation, edited.original), edited.receipt);
  assert.deepEqual(await f.value(manage, { ...edited.json, title: 'Different' }), { status: 409, code: 'already_exists' });
  assert.equal((await submit(f, current, { kind: Kind.EDIT, title: 'Stale' })).receipt.phase, Phase.REJECTED);
  const after = await release(f, receipt.releaseId);
  assert.deepEqual([after.title, after.bodyMarkdown, after.draft, after.prerelease], ['Edited', 'Notes ✓', true, true]); assert.notEqual(after.revision, current.revision);
  current = after;
  const content = bytes(256 * 1024, 200), stored = await upload(f, current, 'bundle ✓.tar.gz', content);
  assert.equal(stored.receipt.phase, Phase.SUCCEEDED);
  const [[key, object]] = [...f.objects];
  assert.match(key, new RegExp(`^releases/1/${receipt.releaseId}/[a-f0-9-]{36}$`)); assert.deepEqual(object.bytes, content); assert.equal(object.customMetadata.sha256, sha256(content));
  current = await release(f, receipt.releaseId);
  assert.deepEqual(current.assets.map(a => [a.id, a.name, a.sizeBytes, a.downloadCount]), [[stored.receipt.assetId, 'bundle ✓.tar.gz', String(256 * 1024), '0']]);
  assert.equal((await upload(f, current, 'bundle ✓.tar.gz')).receipt.phase, Phase.REJECTED, 'duplicate name');
  const second = await upload(f, current, 'empty', new Uint8Array()); assert.equal(second.receipt.phase, Phase.SUCCEEDED);
  assert.equal((await upload(f, current, 'stale.bin')).receipt.phase, Phase.REJECTED, 'the release changed since this revision was observed');
  current = await release(f, receipt.releaseId);
  assert.equal((await submit(f, current, { kind: Kind.RENAME_ASSET, assetId: second.receipt.assetId, assetName: 'bundle ✓.tar.gz' })).receipt.phase, Phase.REJECTED, 'rename onto a listed name');
  assert.equal((await submit(f, current, { kind: Kind.RENAME_ASSET, assetId: '999', assetName: 'ghost' })).receipt.phase, Phase.REJECTED, 'unknown asset');
  assert.equal((await submit(f, current, { kind: Kind.RENAME_ASSET, assetId: second.receipt.assetId, assetName: 'renamed.txt' })).receipt.phase, Phase.SUCCEEDED);
  current = await release(f, receipt.releaseId);
  assert.deepEqual(current.assets.map(a => a.name), ['bundle ✓.tar.gz', 'renamed.txt']);
  const removed = await submit(f, current, { kind: Kind.DELETE_ASSET, assetId: stored.receipt.assetId });
  assert.equal(removed.receipt.phase, Phase.SUCCEEDED); assert.equal(f.objects.has(key), false);
  assert.deepEqual(f.sql.prepare('SELECT deleted FROM repository_release_assets ORDER BY id').all().map(r => r.deleted), [2, 0]);
  current = await release(f, receipt.releaseId);
  assert.deepEqual(current.assets.map(a => a.name), ['renamed.txt']);
  const gone = await submit(f, current, { kind: Kind.DELETE });
  assert.equal(gone.receipt.phase, Phase.SUCCEEDED); assert.equal(f.objects.size, 0);
  assert.deepEqual(await release(f, receipt.releaseId), denied);
  assert.equal((await submit(f, current, { kind: Kind.EDIT, title: 'After deletion' })).receipt.phase, Phase.REJECTED);
  // The tag is free for a new release; the Git tag itself was never touched.
  assert.equal((await published(f)).receipt.phase, Phase.SUCCEEDED);
});

test('release changes are bounded: 256 KiB per asset, 25 assets, validated names and exactly one change per request', async t => {
  const f = await objectFixture(t), { receipt } = await published(f);
  let current = await release(f, receipt.releaseId);
  assert.deepEqual(await upload(f, current, 'large.bin', bytes(256 * 1024 + 1)), { status: 400, code: 'invalid_argument' });
  const oversized = change(current, await f.access(), { kind: Kind.UPLOAD_ASSET, assetName: 'huge.bin', assetContent: bytes(310 * 1024) });
  assert.deepEqual(await f.value(manage, oversized.json), { status: 429, code: 'resource_exhausted' });
  for (const name of ['', ' padded', '.', '..', 'a/b', 'a\\b', 'line\nbreak', 'x'.repeat(256)]) assert.deepEqual(await upload(f, current, name), { status: 400, code: 'invalid_argument' }, JSON.stringify(name).slice(0, 20));
  const base = { ...f.target, accessRevision: (await f.access()).revision, releaseId: current.id, expectedRevision: current.revision };
  for (const invalid of [{ kind: 0 }, { kind: 6 }, { kind: 'REPOSITORY_RELEASE_OPERATION_KIND_DELETE', title: 'Extra' }, { kind: 2, assetId: '1' }, { kind: 2, assetContent: 'AA==' }, { kind: 5 }, { kind: 4, assetId: '1' }, { kind: 3, assetName: 'a', assetContent: '***' },
    { kind: 1, title: '' }, { kind: 1, title: 'x'.repeat(256) }, { kind: 1, title: 'ok', bodyMarkdown: 'x'.repeat(16385) }, { kind: 1, title: 'ok', draft: 'yes' }, { kind: 2, releaseId: '0' }, { kind: 2, expectedRevision: 'short' }])
    assert.deepEqual(await f.value(manage, { ...base, operationId: crypto.randomUUID(), ...invalid }), { status: 400, code: 'invalid_argument' }, JSON.stringify(invalid).slice(0, 60));
  assert.equal(f.bucket.puts, 0); assert.equal(f.sql.prepare('SELECT count(*) AS total FROM repository_release_operations').get().total, 1);
  const insert = f.sql.prepare("INSERT INTO repository_release_assets(release_id,name,size,sha256,r2_key,created_at) VALUES(?,?,0,'',?,?)");
  for (let index = 0; index < 24; index++) insert.run(receipt.releaseId, 'asset-' + index, 'releases/1/seed-' + index, new Date().toISOString());
  assert.equal((await upload(f, current, 'twenty-fifth')).receipt.phase, Phase.SUCCEEDED);
  current = await release(f, receipt.releaseId); assert.equal(current.assetCount, '25');
  assert.equal((await upload(f, current, 'twenty-sixth')).receipt.phase, Phase.REJECTED);
  assert.equal(f.bucket.puts, 1);
});

test('an unacknowledged R2 write is settled by readback and never sent twice', async t => {
  const f = await objectFixture(t), { receipt } = await published(f);
  let current = await release(f, receipt.releaseId);
  // The object landed and the acknowledgement was lost: the immediate readback confirms it.
  f.bucket.loseAcknowledgement = true;
  assert.equal((await upload(f, current, 'confirmed.bin')).receipt.phase, Phase.SUCCEEDED);
  // The object landed, and R2 could not be read back either: the receipt stays unresolved.
  current = await release(f, receipt.releaseId); f.bucket.failHead = true;
  const unknown = await upload(f, current, 'unknown.bin');
  assert.equal(unknown.receipt.phase, Phase.DISPATCH_UNKNOWN);
  assert.deepEqual((await release(f, receipt.releaseId)).assets.map(a => a.name), ['confirmed.bin']);
  assert.equal(operationReceipt((await f.value(inspect, { ...f.target, operationId: unknown.original.operationId })).operation, unknown.original).phase, Phase.DISPATCH_UNKNOWN);
  f.bucket.failHead = false; f.bucket.loseAcknowledgement = false;
  const puts = f.bucket.puts, settled = operationReceipt((await f.value(inspect, { ...f.target, operationId: unknown.original.operationId })).operation, unknown.original);
  assert.equal(settled.phase, Phase.SUCCEEDED); assert.equal(f.bucket.puts, puts);
  current = await release(f, receipt.releaseId);
  assert.deepEqual(current.assets.map(a => [a.id, a.name]), [[current.assets[0].id, 'confirmed.bin'], [settled.assetId, 'unknown.bin']]);
  assert.deepEqual(operationReceipt((await f.value(manage, unknown.json)).operation, unknown.original), settled);
  // The write never arrived: inspection and replay observe R2, never upload again, and the name stays free.
  f.bucket.losePut = true;
  const lost = await upload(f, current, 'lost.bin');
  assert.equal(lost.receipt.phase, Phase.DISPATCH_UNKNOWN);
  f.bucket.losePut = false;
  const attempts = f.bucket.puts;
  for (const path of [inspect, manage]) assert.equal(operationReceipt((await f.value(path, path === inspect ? { ...f.target, operationId: lost.original.operationId } : lost.json)).operation, lost.original).phase, Phase.DISPATCH_UNKNOWN);
  assert.equal(f.bucket.puts, attempts); assert.equal(f.objects.size, 2);
  assert.equal((await upload(f, current, 'lost.bin')).receipt.phase, Phase.SUCCEEDED);
  // An object that arrives after its name was taken is not adopted.
  const late = JSON.parse(f.sql.prepare('SELECT object FROM repository_release_operations WHERE operation_id=?').get(lost.original.operationId).object);
  f.objects.set(late.key, { bytes: bytes(1024), customMetadata: { sha256: late.sha256 } });
  assert.equal(operationReceipt((await f.value(inspect, { ...f.target, operationId: lost.original.operationId })).operation, lost.original).phase, Phase.DISPATCH_UNKNOWN);
  assert.equal((await release(f, receipt.releaseId)).assetCount, '3');
});

test('a failed R2 deletion leaves the asset unlisted and its object is removed on the next release change', async t => {
  const f = await objectFixture(t), { receipt } = await published(f);
  let current = await release(f, receipt.releaseId);
  const stored = await upload(f, current); current = await release(f, receipt.releaseId);
  f.bucket.failDelete = true;
  assert.equal((await submit(f, current, { kind: Kind.DELETE_ASSET, assetId: stored.receipt.assetId })).receipt.phase, Phase.SUCCEEDED);
  current = await release(f, receipt.releaseId);
  assert.equal(current.assetCount, '0'); assert.equal(f.objects.size, 1);
  assert.equal((await f.browse(download(receipt.releaseId, stored.receipt.assetId))).status, 404);
  assert.equal(f.sql.prepare('SELECT deleted FROM repository_release_assets').get().deleted, 1);
  f.bucket.failDelete = false;
  assert.equal((await submit(f, current, { kind: Kind.EDIT, title: 'Next change' })).receipt.phase, Phase.SUCCEEDED);
  assert.equal(f.objects.size, 0); assert.equal(f.sql.prepare('SELECT deleted FROM repository_release_assets').get().deleted, 2);
});

test('assets download through the public Worker only with current repository access', async t => {
  const f = await objectFixture(t), { receipt } = await published(f);
  let current = await release(f, receipt.releaseId);
  const content = new TextEncoder().encode('<script>alert(1)</script>'), stored = await upload(f, current, 'report "final" ✓.html', content), path = download(receipt.releaseId, stored.receipt.assetId);
  for (const token of [tokens.admin, tokens.writer, tokens.reader]) {
    const response = await f.browse(path, token);
    assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
    assert.deepEqual(['Content-Type', 'Content-Length', 'Content-Disposition', 'X-Content-Type-Options', 'Content-Security-Policy', 'Cache-Control', 'Cross-Origin-Resource-Policy'].map(name => response.headers.get(name)),
      ['application/octet-stream', String(content.length), `attachment; filename="report _final_ _.html"; filename*=UTF-8''report%20%22final%22%20%E2%9C%93.html`, 'nosniff', "sandbox; default-src 'none'", 'no-store', 'same-origin']);
  }
  assert.equal((await release(f, receipt.releaseId)).assets[0].downloadCount, '3');
  assert.equal((await f.browse(path, tokens.outsider)).status, 404);
  assert.equal((await f.browse(path, null)).status, 401);
  assert.equal((await f.browse(path, tokens.reader, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  for (const [headers, method] of [[{ 'Sec-Fetch-Site': 'cross-site' }, 'GET'], [{ 'Sec-Fetch-Site': 'same-site' }, 'GET'], [{}, 'POST'], [{}, 'HEAD']]) assert.equal((await f.browse(path, tokens.reader, headers, method)).status, 404);
  for (const other of [path + '?inline=1', download(receipt.releaseId, '999'), download('999', stored.receipt.assetId), path.replace('/1/releases', '/2/releases'), path.replace('/project/', '/other/'), '/api/repositories/alice/project/1/releases', path + '/extra'])
    assert.equal((await f.browse(other, tokens.reader)).status, 404, other);
  assert.equal((await release(f, receipt.releaseId)).assets[0].downloadCount, '4');
  // A draft is withheld from readers, and a revoked grant ends downloads and receipt reads at once.
  current = await release(f, receipt.releaseId);
  assert.equal((await submit(f, current, { kind: Kind.EDIT, title: 'First release', draft: true })).receipt.phase, Phase.SUCCEEDED);
  assert.equal((await f.browse(path, tokens.reader)).status, 404); assert.equal((await f.browse(path, tokens.writer)).status, 200);
  f.sql.exec('DELETE FROM grants WHERE user_id=2');
  assert.equal((await f.browse(path, tokens.writer)).status, 404);
  // Bytes that no longer match the recorded object are refused, not served.
  const [[key, object]] = [...f.objects];
  f.objects.set(key, { ...object, customMetadata: { sha256: 'f'.repeat(64) } }); assert.equal((await f.browse(path)).status, 503);
  f.objects.delete(key); assert.equal((await f.browse(path)).status, 503);
  f.sql.exec("UPDATE grants SET role='write' WHERE user_id=1");
  for (const [method, body] of [[inspect, { ...f.target, operationId: stored.original.operationId }], [publication, { ...f.target, operationId: receipt.operationId }], [manage, stored.json]]) assert.deepEqual(await f.value(method, body), denied);
  f.sql.exec('DELETE FROM grants WHERE user_id=1');
  for (const [method, body] of [[inspect, { ...f.target, operationId: stored.original.operationId }], [publication, { ...f.target, operationId: receipt.operationId }]]) assert.deepEqual(await f.value(method, body), denied);
  assert.equal((await f.browse(path)).status, 404);
});

test('releases report DISABLED and refuse every procedure without the R2 bucket; reads overlap and changes serialize', async t => {
  const f = await objectFixture(t);
  assert.equal((await f.value('/native/diagnostics')).schema, 47);
  const capability = async () => (await f.value('CapabilityService/ListCapabilities')).capabilities.filter(c => c.id === 'repository.releases');
  let [row, ...rest] = await capability();
  assert.equal(rest.length, 0); assert.equal(row.state, 'CAPABILITY_STATE_READY'); assert.match(row.reason, /tags arrive by git push/); assert.match(row.reason, /25 assets of at most 256 KiB/);
  delete f.env.EVIDENCE_BUCKET;
  [row] = await capability();
  assert.equal(row.state, 'CAPABILITY_STATE_DISABLED'); assert.match(row.reason, /R2 bucket/);
  const unimplemented = { status: 501, code: 'unimplemented' };
  for (const path of ['RepositoryService/ListRepositoryReleases', 'RepositoryService/GetRepositoryRelease', publish, publication, manage, inspect, '/native/release-asset/read']) assert.deepEqual(await f.value(path, { ...f.target, operationId: crypto.randomUUID() }), unimplemented, path);
  assert.equal((await f.browse(download('1', '1'))).status, 404);
  for (const path of ['RepositoryReleasePublicationService/ListRepositoryReleases', 'RepositoryReleaseManagementService/SubmitRepositoryReleasePublication', 'RepositoryReleaseManagementService/Unknown']) assert.deepEqual(await f.value(path, f.target), unimplemented, path);
  const request = path => new Request(origin + path, { method: 'POST' });
  for (const path of ['/rpc/golf.v1.RepositoryService/ListRepositoryReleases', '/rpc/golf.v1.RepositoryService/GetRepositoryRelease', '/rpc/golf.v1.' + publication, '/native/release-asset/read']) assert.equal(concurrentRead(request(path)), true, path);
  // Inspecting an upload may settle it, so it queues with the other changes.
  for (const path of ['/rpc/golf.v1.' + publish, '/rpc/golf.v1.' + manage, '/rpc/golf.v1.' + inspect]) assert.equal(concurrentRead(request(path)), false, path);
});
