import { ownerSlug } from './owners.mjs';
import { repositoryAccess, settingsAuthority } from './repository-settings.mjs';
import { digest, uuidOK, deny, invalid, unsupported, Fault, page, user } from './common.mjs';
import { sha, validRef } from './git.mjs';
import { tagRuled } from './repository-rules.mjs';

export const releaseReadMethods = new Set(['ListRepositoryReleases', 'GetRepositoryRelease']);
export const releaseMethods = {
  RepositoryReleasePublicationService: new Set(['SubmitRepositoryReleasePublication', 'GetRepositoryReleasePublicationOperation']),
  RepositoryReleaseManagementService: new Set(['SubmitRepositoryReleaseOperation', 'GetRepositoryReleaseOperation']),
};
// Twenty releases of 25 assets fill the 500-asset page the web client accepts.
export const uploadLimit = 256 * 1024, assetLimit = 25;
const kinds = ['UNSPECIFIED', 'EDIT', 'DELETE', 'UPLOAD_ASSET', 'RENAME_ASSET', 'DELETE_ASSET'];
const encoder = new TextEncoder();
const plain = (value, max) => typeof value === 'string' && value.isWellFormed() && encoder.encode(value).length <= max;
const hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const idOK = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value);
const titleOK = value => plain(value, 255) && value !== '' && value.trim() === value && !/\p{Cc}/u.test(value);
const notesOK = value => plain(value, 16384) && !/\p{Cc}/u.test(value.replace(/[\t\n\r]/g, ''));
export const fileNameOK = value => plain(value, 255) && value !== '' && value.trim() === value && value !== '.' && value !== '..' && !/[/\\\p{Cc}]/u.test(value);
export const bytesDigest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// Connect JSON carries bytes as base64. The encoded length is bounded before decoding.
export function decodeBytes(value) {
  let binary = '';
  try {
    if (value !== undefined && (typeof value !== 'string' || value.length > Math.ceil(uploadLimit / 3) * 4)) throw Error('bound');
    binary = atob((value || '').replace(/-/g, '+').replace(/_/g, '/'));
  } catch { invalid('Uploads carry at most 256 KiB of base64 file bytes.'); }
  if (binary.length > uploadLimit) invalid('Uploads are limited to 256 KiB.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
// Conditional create under a key nothing else writes; R2 checks the bytes against the declared SHA-256.
export function storeObject(env, object, bytes) {
  return env.EVIDENCE_BUCKET.put(object.key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: object.sha256, httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { sha256: object.sha256 } });
}
// The readback settles a lost acknowledgement: only the reserved upload can have created this key.
export async function objectStored(env, object) {
  const found = await env.EVIDENCE_BUCKET.head(object.key);
  return Boolean(found) && found.size === object.size && found.customMetadata?.sha256 === object.sha256;
}

// The web client and the portable server derive input_sha256 from the deterministic proto3 encoding
// of the request without its operation ID; the same bytes are built here from the Connect JSON.
const varint = value => { const out = []; for (; value > 127; value = Math.floor(value / 128)) out.push(value % 128 | 128); out.push(value); return out; };
const join = parts => { const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes; };
const field = (number, value) => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; return bytes.length ? [new Uint8Array([number << 3 | 2, ...varint(bytes.length)]), bytes] : []; };
function fingerprint(body, kind, content) {
  const key = join([...field(1, body.repository.owner), ...field(2, body.repository.name)]);
  return bytesDigest(join([new Uint8Array([10, ...varint(key.length)]), key, ...field(2, body.repositoryId), ...field(3, body.ownerId), ...field(4, body.accessRevision), ...field(6, body.releaseId), ...field(7, body.expectedRevision),
    new Uint8Array([64, kind]), ...field(9, body.title || ''), ...field(10, body.bodyMarkdown || ''), ...(body.draft ? [new Uint8Array([88, 1])] : []), ...(body.prerelease ? [new Uint8Array([96, 1])] : []),
    ...field(13, body.assetId || ''), ...field(14, body.assetName || ''), ...field(15, content)]));
}

const revision = release => digest(JSON.stringify(['native.release.v1', release.id, release.repository_id, release.artifact_name, release.revision]));
const journal = (db, actor, operation) => db.prepare('SELECT * FROM repository_release_operations WHERE actor_id=? AND operation_id=?').bind(actor, operation).first();
const phase = value => 'REPOSITORY_RELEASE_PUBLICATION_PHASE_' + value;
function publicationWire(saved) {
  return { contract: 'golf.repository.release-publication.v1', ...JSON.parse(saved.receipt), phase: phase(saved.phase), releaseId: saved.phase === 'SUCCEEDED' ? String(saved.result_id) : '',
    updatedAt: saved.updated_at, failureCode: saved.phase === 'REJECTED' ? 'preflight_refused' : '' };
}
function managementWire(saved) {
  const receipt = JSON.parse(saved.receipt);
  return { contract: 'golf.repository.release-operation.v1', ...receipt, phase: phase(saved.phase), failureCode: saved.phase === 'REJECTED' ? 'preflight_refused' : '',
    assetId: saved.result_id ? String(saved.result_id) : receipt.assetId, updatedAt: saved.updated_at };
}

async function read(db, env, row, method, body) {
  const key = { owner: ownerSlug(row, env), name: row.name }, scope = [row.id, row.artifact_name, Number(['write', 'admin'].includes(row.role))];
  const author = 'SELECT r.*,u.login,COALESCE(p.full_name,u.full_name) AS full_name FROM repository_releases r JOIN users u ON u.id=r.author_id LEFT JOIN profiles p ON p.user_id=u.id';
  // Drafts are listed and downloadable only for current writers.
  const visible = 'r.repository_id=? AND r.artifact_name=? AND r.deleted=0 AND (r.draft=0 OR ?)';
  let rows, paging, total;
  if (method === 'GetRepositoryRelease') {
    if (!idOK(body.releaseId)) invalid('Select a release.');
    rows = (await db.prepare(`${author} WHERE r.id=? AND ${visible}`).bind(body.releaseId, ...scope).all()).results;
    if (!rows.length) deny();
  } else {
    paging = page(body);
    if (paging.limit > 50) invalid('Release page size must be at most 50.');
    total = (await db.prepare(`SELECT count(*) AS total FROM repository_releases r WHERE ${visible}`).bind(...scope).first()).total;
    rows = (await db.prepare(`${author} WHERE ${visible} ORDER BY r.id DESC LIMIT ? OFFSET ?`).bind(...scope, paging.limit, paging.offset).all()).results;
  }
  const { results: assets } = await db.prepare('SELECT * FROM repository_release_assets WHERE deleted=0 AND release_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(rows.map(r => r.id))).all();
  const releases = await Promise.all(rows.map(async r => {
    const own = assets.filter(asset => asset.release_id === r.id);
    return { id: String(r.id), title: r.title, tagName: r.tag_name, targetCommitish: r.commit_id, bodyMarkdown: r.body, draft: Boolean(r.draft), prerelease: Boolean(r.prerelease), createdAt: r.created_at, publishedAt: r.published_at,
      author: user({ id: r.author_id, login: r.login, full_name: r.full_name }), assetCount: String(own.length), revision: await revision(r),
      assets: own.map(asset => ({ id: String(asset.id), name: asset.name, sizeBytes: String(asset.size), downloadCount: String(asset.downloads), createdAt: asset.created_at })) };
  }));
  return method === 'GetRepositoryRelease' ? { repository: key, repositoryId: String(row.id), release: releases[0] }
    : { repository: key, repositoryId: String(row.id), releases, page: { nextPage: total > paging.offset + paging.limit ? paging.number + 1 : 0 }, totalCount: String(total) };
}

// A release names a tag that already exists; it never creates or moves one, and no tag rule may name it. Golf serializes its own
// Git writes with this request, so the observed tag cannot move underneath the publication.
async function publish(db, env, person, row, body, readRefs) {
  const name = body.tagName, notes = body.bodyMarkdown ?? '';
  if (!hashOK(body.accessRevision) || typeof name !== 'string' || name.startsWith('refs/') || !validRef('refs/tags/' + name) || !sha(body.tagObjectId) || !sha(body.commitId)) invalid('Bind the observed access revision and an existing tag with its object and full commit.');
  if (!titleOK(body.title) || !notesOK(notes) || body.prerelease !== undefined && typeof body.prerelease !== 'boolean') invalid('Provide a trimmed title of at most 255 bytes and notes of at most 16 KiB.');
  const hash = await digest(JSON.stringify(['native.release-publication.v1', row.id, row.artifact_name, body.ownerId, body.accessRevision, name, body.tagObjectId, body.commitId, body.title, notes, Boolean(body.prerelease)]));
  let saved = await journal(db, person.id, body.operationId);
  if (saved) {
    if (saved.repository_id !== row.id || saved.kind !== 'publication' || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation ID belongs to a different release publication.');
    return { operation: publicationWire(saved) };
  }
  const { access } = await repositoryAccess(db, env, person, row);
  const rules = await db.prepare('SELECT version,tags FROM repository_rules WHERE repository_id=?').bind(row.id).first();
  // Only a tag rule naming this tag refuses it; rules for other tags do not. The insert below is fenced on the rules version.
  let allowed = body.accessRevision === access.revision && !row.write_pending && !(rules && tagRuled(JSON.parse(rules.tags), name))
    && !await db.prepare('SELECT 1 AS present FROM repository_releases WHERE repository_id=? AND tag_name=? AND deleted=0').bind(row.id, name).first();
  if (allowed) {
    const refs = await readRefs(), ref = 'refs/tags/' + name;
    allowed = refs.get(ref) === body.tagObjectId && (refs.get(ref + '^{}') || refs.get(ref)) === body.commitId;
  }
  const time = new Date().toISOString(), authority = settingsAuthority(person, row), created = allowed ? 'changes()=1' : '0';
  const receipt = { operationId: body.operationId, actorId: String(person.id), repository: { owner: ownerSlug(row, env), name: row.name }, repositoryId: String(row.id), ownerId: String(row.workspace_id), accessRevision: body.accessRevision,
    tagName: name, tagObjectId: body.tagObjectId, commitId: body.commitId, titleSha256: await digest(body.title), bodySha256: await digest(notes), prerelease: Boolean(body.prerelease), createdAt: time };
  const results = await db.batch([
    ...(allowed ? [db.prepare(`INSERT INTO repository_releases(repository_id,artifact_name,tag_name,tag_object_id,commit_id,title,body,prerelease,author_id,created_at,published_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${authority.sql} AND EXISTS(SELECT 1 FROM repositories WHERE id=? AND write_pending IS NULL)
      AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM repository_releases WHERE repository_id=? AND tag_name=? AND deleted=0)`)
      .bind(row.id, row.artifact_name, name, body.tagObjectId, body.commitId, body.title, notes, Number(Boolean(body.prerelease)), person.id, time, time, ...authority.values, row.id, row.id, rules?.version || 0, row.id, name)] : []),
    // The release and its receipt commit together; a refusal records that nothing was published.
    db.prepare(`INSERT INTO repository_release_operations(actor_id,operation_id,repository_id,kind,input_hash,receipt,phase,result_id,updated_at)
      SELECT ?,?,?,'publication',?,?,CASE WHEN ${created} THEN 'SUCCEEDED' ELSE 'REJECTED' END,CASE WHEN ${created} THEN (SELECT id FROM repository_releases WHERE repository_id=? AND tag_name=? AND deleted=0) END,? WHERE ${authority.sql}`)
      .bind(person.id, body.operationId, row.id, hash, JSON.stringify(receipt), row.id, name, time, ...authority.values),
  ]);
  if (results.at(-1).meta.changes !== 1) deny();
  return { operation: publicationWire(await journal(db, person.id, body.operationId)) };
}

// Inspection never sends bytes again: it adopts the reserved object only when R2 reports exactly that upload.
async function settle(db, env, person, row, saved) {
  if (saved.phase !== 'DISPATCH_UNKNOWN') return saved;
  const object = JSON.parse(saved.object), release = JSON.parse(saved.receipt).releaseId, authority = settingsAuthority(person, row), time = new Date().toISOString();
  try { if (!await objectStored(env, object)) return saved; } catch { return saved; }
  await db.batch([
    db.prepare(`INSERT INTO repository_release_assets(release_id,name,size,sha256,r2_key,created_at) SELECT ?,?,?,?,?,? WHERE ${authority.sql}
      AND EXISTS(SELECT 1 FROM repository_release_operations WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN')
      AND EXISTS(SELECT 1 FROM repository_releases WHERE id=? AND repository_id=? AND deleted=0)
      AND NOT EXISTS(SELECT 1 FROM repository_release_assets WHERE release_id=? AND name=? AND deleted=0)
      AND (SELECT count(*) FROM repository_release_assets WHERE release_id=? AND deleted=0)<?`)
      .bind(release, object.name, object.size, object.sha256, object.key, time, ...authority.values, saved.actor_id, saved.operation_id, release, row.id, release, object.name, release, assetLimit),
    db.prepare("UPDATE repository_release_operations SET phase='SUCCEEDED',result_id=(SELECT id FROM repository_release_assets WHERE r2_key=?),updated_at=? WHERE actor_id=? AND operation_id=? AND phase='DISPATCH_UNKNOWN' AND changes()=1")
      .bind(object.key, time, saved.actor_id, saved.operation_id),
    db.prepare('UPDATE repository_releases SET revision=revision+1 WHERE id=? AND changes()=1').bind(release),
  ]);
  return journal(db, saved.actor_id, saved.operation_id);
}

// A removed asset stops being listed or downloadable at once. Its object leaves R2 here or on the next
// release change, and the row is marked purged only after R2 reports the key absent.
async function purge(db, env, row, rounds = 1) {
  for (let round = 0; round < rounds; round++) {
    const { results } = await db.prepare('SELECT a.id,a.r2_key FROM repository_release_assets a JOIN repository_releases r ON r.id=a.release_id WHERE a.deleted=1 AND r.repository_id=? ORDER BY a.id LIMIT 32').bind(row.id).all();
    if (!results.length) return;
    try {
      await env.EVIDENCE_BUCKET.delete(results.map(asset => asset.r2_key));
      const absent = (await Promise.all(results.map(async asset => await env.EVIDENCE_BUCKET.head(asset.r2_key) ? null : asset.id))).filter(Boolean);
      await db.prepare('UPDATE repository_release_assets SET deleted=2 WHERE deleted=1 AND id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(absent)).run();
      if (absent.length !== results.length) return;
    } catch { return; }
  }
}

async function manage(db, env, person, row, body) {
  const kind = typeof body.kind === 'number' ? body.kind : kinds.indexOf(String(body.kind || '').replace('REPOSITORY_RELEASE_OPERATION_KIND_', ''));
  if (!hashOK(body.accessRevision) || !idOK(body.releaseId) || !hashOK(body.expectedRevision) || !Number.isInteger(kind) || kind < 1 || kind > 5 || ['draft', 'prerelease'].some(flag => body[flag] !== undefined && typeof body[flag] !== 'boolean')) invalid('Bind the observed access revision, release revision and a supported release change.');
  if (kind === 1 ? !titleOK(body.title) || !notesOK(body.bodyMarkdown ?? '') : body.title || body.bodyMarkdown || body.draft || body.prerelease) invalid('Only a release edit carries a trimmed title of at most 255 bytes, notes of at most 16 KiB and release flags.');
  if (kind >= 4 ? !idOK(body.assetId) : body.assetId) invalid('Only a rename or removal names an existing asset.');
  if (kind === 3 || kind === 4 ? !fileNameOK(body.assetName) : body.assetName) invalid('Uploads and renames carry a file name of at most 255 bytes without path separators.');
  if (kind !== 3 && body.assetContent) invalid('Only uploads carry file bytes.');
  const content = kind === 3 ? decodeBytes(body.assetContent) : new Uint8Array(), hash = await fingerprint(body, kind, content), operation = [person.id, body.operationId];
  let saved = await journal(db, ...operation);
  if (saved) {
    if (saved.repository_id !== row.id || saved.kind !== 'management' || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation ID belongs to a different release change.');
    return { operation: managementWire(await settle(db, env, person, row, saved)) };
  }
  await purge(db, env, row);
  const release = await db.prepare('SELECT * FROM repository_releases WHERE id=? AND repository_id=? AND artifact_name=? AND deleted=0').bind(body.releaseId, row.id, row.artifact_name).first();
  const assets = release ? (await db.prepare('SELECT id,name FROM repository_release_assets WHERE release_id=? AND deleted=0').bind(release.id).all()).results : [];
  const { access } = await repositoryAccess(db, env, person, row);
  const allowed = Boolean(release) && body.accessRevision === access.revision && body.expectedRevision === await revision(release) && (kind < 4 || assets.some(asset => String(asset.id) === body.assetId))
    && !((kind === 3 || kind === 4) && assets.some(asset => asset.name === body.assetName && String(asset.id) !== body.assetId)) && !(kind === 3 && assets.length >= assetLimit);
  const time = new Date().toISOString(), authority = settingsAuthority(person, row), pin = [release?.id, release?.revision];
  const current = 'EXISTS(SELECT 1 FROM repository_releases WHERE id=? AND revision=? AND deleted=0)', done = "EXISTS(SELECT 1 FROM repository_release_operations WHERE actor_id=? AND operation_id=? AND phase='SUCCEEDED')";
  const object = kind === 3 && allowed ? { key: `releases/${row.id}/${release.id}/${crypto.randomUUID()}`, name: body.assetName, size: content.length, sha256: await bytesDigest(content) } : null;
  const receipt = { operationId: body.operationId, repository: { owner: ownerSlug(row, env), name: row.name }, repositoryId: String(row.id), ownerId: String(row.workspace_id), actorId: String(person.id), releaseId: body.releaseId,
    kind: 'REPOSITORY_RELEASE_OPERATION_KIND_' + kinds[kind], expectedRevision: body.expectedRevision, inputSha256: hash, assetId: body.assetId || '', createdAt: time };
  const effect = !allowed || kind === 3 ? null
    : kind === 1 ? db.prepare(`UPDATE repository_releases SET title=?,body=?,draft=?,prerelease=?,revision=revision+1 WHERE id=? AND revision=? AND deleted=0 AND ${authority.sql}`).bind(body.title, body.bodyMarkdown ?? '', Number(Boolean(body.draft)), Number(Boolean(body.prerelease)), ...pin, ...authority.values)
    : kind === 2 ? db.prepare(`UPDATE repository_releases SET deleted=1,revision=revision+1 WHERE id=? AND revision=? AND deleted=0 AND ${authority.sql}`).bind(...pin, ...authority.values)
    : db.prepare(`UPDATE repository_release_assets SET ${kind === 4 ? 'name=?' : 'deleted=?'} WHERE id=? AND release_id=? AND deleted=0 AND ${current} AND ${authority.sql}`).bind(kind === 4 ? body.assetName : 1, body.assetId, release.id, ...pin, ...authority.values);
  // An upload is reserved before its bytes are dispatched; every other change commits with its receipt.
  const outcome = !allowed ? "'REJECTED'" : kind === 3 ? `CASE WHEN ${current} THEN 'DISPATCH_UNKNOWN' ELSE 'REJECTED' END` : "CASE WHEN changes()=1 THEN 'SUCCEEDED' ELSE 'REJECTED' END";
  const results = await db.batch([
    ...(effect ? [effect] : []),
    db.prepare(`INSERT INTO repository_release_operations(actor_id,operation_id,repository_id,kind,input_hash,receipt,phase,object,updated_at) SELECT ?,?,?,'management',?,?,${outcome},?,? WHERE ${authority.sql}`)
      .bind(...operation, row.id, hash, JSON.stringify(receipt), ...(object ? pin : []), object && JSON.stringify(object), time, ...authority.values),
    ...(effect && kind === 2 ? [db.prepare(`UPDATE repository_release_assets SET deleted=1 WHERE release_id=? AND deleted=0 AND ${done}`).bind(release.id, ...operation)] : []),
    ...(effect && kind >= 4 ? [db.prepare(`UPDATE repository_releases SET revision=revision+1 WHERE id=? AND ${done}`).bind(release.id, ...operation)] : []),
  ]);
  if (results[effect ? 1 : 0].meta.changes !== 1) deny();
  saved = await journal(db, ...operation);
  if (saved.phase === 'DISPATCH_UNKNOWN') {
    try { await storeObject(env, object, content); } catch { /* The readback settles an unacknowledged write. */ }
    saved = await settle(db, env, person, row, saved);
  }
  if (effect && (kind === 2 || kind === 5)) await purge(db, env, row, 4);
  return { operation: managementWire(saved) };
}

export async function releases(db, env, person, row, method, body, readRefs) {
  if (!env.EVIDENCE_BUCKET) unsupported();
  if (body.repositoryId !== String(row.id)) deny();
  if (releaseReadMethods.has(method)) return read(db, env, row, method, body);
  // Current direct administration, as on the portable path; a revoked or reduced grant reads no receipt.
  if (row.role !== 'admin' || body.ownerId !== String(row.workspace_id)) deny();
  if (!uuidOK(body.operationId)) invalid('Use the original UUID v4 operation ID.');
  if (method === 'SubmitRepositoryReleasePublication') return publish(db, env, person, row, body, readRefs);
  if (method === 'SubmitRepositoryReleaseOperation') return manage(db, env, person, row, body);
  const management = method === 'GetRepositoryReleaseOperation', saved = await journal(db, person.id, body.operationId);
  if (!saved || saved.repository_id !== row.id || saved.kind !== (management ? 'management' : 'publication')) deny();
  return { operation: management ? managementWire(await settle(db, env, person, row, saved)) : publicationWire(saved) };
}

// Called by the stateless Worker before it streams the private object; counts authorized download requests.
export async function releaseAssetGrant(db, env, row, body) {
  if (!env.EVIDENCE_BUCKET) unsupported();
  if (body.repositoryId !== String(row.id) || !idOK(body.releaseId) || !idOK(body.assetId)) deny();
  const asset = await db.prepare(`UPDATE repository_release_assets SET downloads=downloads+1 WHERE id=? AND release_id=? AND deleted=0
    AND EXISTS(SELECT 1 FROM repository_releases WHERE id=? AND repository_id=? AND artifact_name=? AND deleted=0 AND (draft=0 OR ?)) RETURNING r2_key,name,size,sha256`)
    .bind(body.assetId, body.releaseId, body.releaseId, row.id, row.artifact_name, Number(['write', 'admin'].includes(row.role))).first();
  if (!asset) deny();
  return { key: asset.r2_key, name: asset.name, size: asset.size, sha256: asset.sha256 };
}
