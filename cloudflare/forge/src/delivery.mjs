import { ownerSlug } from './owners.mjs';
import { digest, uuidOK, Fault, deny, invalid, reply } from './common.mjs';
import { collaboration } from './collaboration.mjs';
import { evidenceAPI } from './evidence.mjs';
import { agentPathOK } from './agent-policy.mjs';
import { sha, bounded } from './git.mjs';
import { testPolicy } from './test-policy.mjs';
import { appPolicy, appOrigin, appPolicyHash } from './app-policy.mjs';
import { appBundle, provisionApp, appDispatch, purgeApp } from './apps.mjs';
import { repositoryPackages } from './repository-settings.mjs';
import { previewEnvironment, previewEnvironmentGuard, branchAllowed, previewSlots } from './environments.mjs';

const now = () => new Date().toISOString();
const tokenOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const secret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8' };
export function previewPolicy(env) {
  try {
    const origin = new URL(env.PREVIEW_ORIGIN);
    return Boolean(env.EVIDENCE_BUCKET && agentPathOK(env.PREVIEW_PATH) && env.PREVIEW_ACCESS_AUD &&
      origin.origin === env.PREVIEW_ORIGIN && origin.protocol === 'https:' && !origin.port && !origin.username && !origin.password &&
      origin.origin !== env.PUBLIC_ORIGIN && Number.isInteger(Number(env.PREVIEW_TTL)) && Number(env.PREVIEW_TTL) >= 60 && Number(env.PREVIEW_TTL) <= 14400);
  } catch { return false; }
}
// Repository environments need both the preview allocation they govern and Access sign-in for their writes.
export const environmentPolicy = env => previewPolicy(env) && Boolean(env.ACCESS_AUD);
// Previews holding one of the repository's concurrent slots. Bind (repository id, current time).
const live = "(SELECT count(*) FROM previews WHERE repository_id=? AND purged=0 AND state IN ('PUBLISHING','READY') AND expires_at>?)";
const disallowed = () => { throw new Fault('failed_precondition', 412, 'The preview environment does not allow this pull request head branch.'); };
const occupied = limit => { throw new Fault('resource_exhausted', 429, `The preview environment allows ${limit} concurrent preview${limit === 1 ? '' : 's'} for this repository; revoke one or let it expire.`); };
const imageOf = row => row.selection ? JSON.parse(row.selection).imageDigest : undefined;
const wire = (row, env) => ({ id: row.id, jobId: row.job_id, state: row.state, commitId: row.commit_id, treeId: row.tree_id,
  kind: imageOf(row) ? 'IMAGE_STATIC' : row.kind || 'STATIC', ...(imageOf(row) ? { imageDigest: imageOf(row) } : {}), url: row.kind === 'WORKER' ? appOrigin(env, row.id) + '/' : `${env.PREVIEW_ORIGIN}/${row.id}/`, expiresAt: row.expires_at, createdAt: row.created_at, sha256: row.bundle_hash,
  bytes: row.bundle_bytes, sourcePath: row.source_path, purged: Boolean(row.purged),
  captureState: row.capture_state || 'NONE', captureSha256: row.capture_hash || '', captureBytes: row.capture_bytes || 0, browserMs: row.browser_ms });
const byteDigest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
async function storedBundle(env, preview) {
  const object = await env.EVIDENCE_BUCKET.get(preview.bundle_key);
  if (!object || object.size !== preview.bundle_bytes || object.size > 2 * 1024 * 1024) throw Error('Preview assets unavailable');
  const data = await object.text();
  if (await digest(data) !== preview.bundle_hash) throw Error('Preview assets changed');
  const bundle = JSON.parse(data);
  if (bundle.schema !== 'golf.native.static-preview.v1' || bundle.commitId !== preview.commit_id || bundle.treeId !== preview.tree_id || bundle.imageDigest !== imageOf(preview)) throw Error('Preview manifest differs');
  return bundle;
}

async function current(db, env, person, row, artifact, preview) {
  const p = preview.kind === 'WORKER' ? appPolicy(env) : null;
  if (preview.state !== 'READY' || preview.expires_at <= now() || row.write_pending ||
      (preview.kind === 'WORKER' ? !p || preview.source_path !== p.entry || preview.policy_hash !== await appPolicyHash(env) : preview.source_path !== env.PREVIEW_PATH)) deny();
  const selection = JSON.parse(preview.selection);
  const pr = (await collaboration(db, env, person, 'GetPullRequest', { repository: selection.repository, number: selection.number }, row, artifact)).pullRequest;
  if (pr.state !== 'ISSUE_STATE_OPEN' || pr.revision !== preview.pr_revision || pr.id !== selection.pullRequestId ||
      pr.head.commitId !== preview.commit_id || pr.base.commitId !== selection.baseCommitId || pr.head.retainedSnapshot || pr.base.retainedSnapshot) deny();
  if (selection.imageDigest) {
    if (!env.REGISTRY || !env.REGISTRY_ORIGIN) deny();
    const decision = await repositoryPackages(env, person, row, { repositoryId: String(row.id), action: 'policy', reference: selection.imageDigest });
    if (decision.digest !== selection.imageDigest || decision.allowed !== true) deny();
  }
  return pr;
}

async function imageBundle(env, person, row, image, canonical) {
  // shortcut: static assets live in a bounded OCI config label; extract image layers when general build and container deployment land.
  if (!env.REGISTRY || !env.REGISTRY_ORIGIN || image.registry !== env.REGISTRY_ORIGIN || image.repository !== `${ownerSlug(row,env)}/${row.name}` ||
      image.commitId !== canonical.commitId) throw new Fault('failed_precondition', 412, 'The tested image receipt does not match this repository and commit.');
  const input = { repositoryId: String(row.id), reference: image.digest };
  const decision = await repositoryPackages(env, person, row, { ...input, action: 'policy' });
  if (decision.digest !== image.digest || decision.allowed !== true) throw new Fault('failed_precondition', 412, 'The image does not satisfy the current registry scan and trust policy.');
  const config = await repositoryPackages(env, person, row, { ...input, action: 'downloadImageConfig' });
  if (config.subject !== image.digest || config.encoding !== 'base64' || !Number.isSafeInteger(config.size) || config.size > 2 * 1024 * 1024 ||
      typeof config.content !== 'string' || config.content.length > 3 * 1024 * 1024) throw Error('Registry image config receipt differs');
  let document, bundle;
  try {
    const raw = Uint8Array.from(atob(config.content), c => c.charCodeAt(0));
    if (raw.length !== config.size) throw Error();
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    bundle = JSON.parse(document.config.Labels['dev.golf.static-preview.v1']);
  } catch { throw new Fault('failed_precondition', 412, 'The image has no valid static preview bundle.'); }
  const expectedFiles = [...canonical.files].sort((a, b) => a.path.localeCompare(b.path));
  const sameFiles = Array.isArray(bundle.files) && bundle.files.length === expectedFiles.length &&
    bundle.files.every(file => file && typeof file.path === 'string' && typeof file.contentType === 'string' && typeof file.content === 'string') &&
    [...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).every((file, index) =>
      file.path === expectedFiles[index].path && file.contentType === expectedFiles[index].contentType && file.content === expectedFiles[index].content);
  if (document.config.Labels['org.opencontainers.image.revision'] !== canonical.commitId ||
      bundle.schema !== canonical.schema || bundle.commitId !== canonical.commitId || bundle.treeId !== canonical.treeId ||
      bundle.sourcePath !== canonical.sourcePath || !sameFiles) throw new Fault('failed_precondition', 412, 'Image preview assets differ from the tested Git commit.');
  return { schema: canonical.schema, commitId: canonical.commitId, treeId: canonical.treeId, sourcePath: canonical.sourcePath,
    files: bundle.files.map(file => ({ path: file.path, contentType: file.contentType, content: file.content })), imageDigest: image.digest };
}

export async function renewPreview(db, env, person, row, preview, body, authorize) {
  if (!['admin','write'].includes(row.role) || preview.repository_id !== row.id) deny();
  if (body.expectedExpiresAt !== preview.expires_at) throw new Fault('failed_precondition',412,'Preview expiry changed; inspect the current lease.');
  const ceiling = preview.kind === 'WORKER' ? appPolicy(env)?.ttl : Number(env.PREVIEW_TTL);
  if (!Number.isInteger(ceiling) || ceiling < 60 || ceiling > 14400) throw new Fault('failed_precondition',412,'An approved preview lifetime is required.');
  // The stored environment governs renewal too: head branch, lifetime under the operator ceiling and the repository's slots.
  const pr = await authorize(preview), governed = await previewEnvironment(db,row), limit = governed.policy?.maxConcurrency;
  if (governed.policy && !branchAllowed(governed.policy,pr?.head?.ref)) disallowed();
  if (limit && (await db.prepare(`SELECT ${live} AS total`).bind(row.id,now()).first()).total > limit) occupied(limit);
  const ttl = Math.min(ceiling,governed.policy?.previewTtlSeconds ?? ceiling);
  const deadline = env.DEMO_STOP_AT ? Date.parse(env.DEMO_STOP_AT) : Infinity;
  if (Number.isNaN(deadline) || deadline <= Date.now()) throw new Fault('failed_precondition',412,'The approved demo window is unavailable.');
  const expires = new Date(Math.min(Date.now()+ttl*1000,deadline)).toISOString();
  const result = await db.prepare(`UPDATE previews SET expires_at=? WHERE id=? AND repository_id=? AND expires_at=? AND state='READY' AND purged=0
    AND EXISTS(SELECT 1 FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=previews.repository_id AND g.role IN ('admin','write'))
    AND ${previewEnvironmentGuard}${limit ? ` AND ${live}<=?` : ''}`)
    .bind(expires,preview.id,row.id,body.expectedExpiresAt,person.id,row.id,governed.revision,...(limit ? [row.id,now(),limit] : [])).run();
  if (!result.meta.changes) throw new Fault('failed_precondition',412,'Preview expiry, writer authority or environment policy changed; inspect the current lease.');
  const renewed = {...preview,expires_at:expires};
  await authorize(renewed);
  return wire(renewed,env);
}

export async function previewBundle(repo, commitId, path) {
  const commit = await repo.readCommit(commitId);
  if (!sha(commit?.treeHash)) throw Error('Preview source unavailable');
  let tree = commit.treeHash;
  for (const part of path.split('/')) {
    const entries = await repo.readTree(tree);
    if (!Array.isArray(entries) || entries.length > 64) invalid('Preview directory exceeds its limit.');
    const entry = entries.find(e => e.name === part);
    if (entry?.type !== 'tree' || !sha(entry.hash)) invalid('Approved preview directory unavailable.');
    tree = entry.hash;
  }
  let bytes = 0, count = 0;
  const files = [];
  async function visit(hash, prefix = '', depth = 0) {
    if (depth > 8) invalid('Preview directory nesting exceeds its limit.');
    const entries = await repo.readTree(hash);
    if (!Array.isArray(entries) || entries.length > 64) invalid('Preview directory exceeds its limit.');
    const names = new Set();
    for (const entry of entries) {
      if (++count > 64 || !agentPathOK(entry.name) || entry.name.includes('/') || names.has(entry.name) || !sha(entry.hash)) invalid('Preview entries exceed the approved static policy.');
      names.add(entry.name);
      const name = prefix + entry.name;
      if (entry.type === 'tree') { await visit(entry.hash, name + '/', depth + 1); continue; }
      const extension = entry.name.split('.').at(-1), contentType = Object.hasOwn(types, extension) ? types[extension] : undefined;
      if (entry.type !== 'blob' || entry.mode !== '100644' || !contentType) invalid('Preview accepts regular HTML, CSS, JS, SVG, JSON and text files only.');
      const blob = await repo.readBlob(entry.hash);
      if (!blob || blob.size > 256 * 1024 || (bytes += blob.size) > 1024 * 1024) invalid('Preview assets exceed their size limit.');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()); } catch { invalid('Preview assets must be UTF-8 text.'); }
      if (content.includes('\0')) invalid('Binary preview assets are unsupported.');
      files.push({ path: name, contentType, content });
    }
  }
  await visit(tree);
  if (!files.some(f => f.path === 'index.html')) invalid('Approved preview directory needs index.html.');
  return { schema: 'golf.native.static-preview.v1', commitId, treeId: commit.treeHash, sourcePath: path, files };
}

export async function previewAPI(db, env, person, row, artifact, body) {
  if (!previewPolicy(env)) throw new Fault('failed_precondition', 412, 'An operator-approved protected preview allocation is required.');
  if (body.action === 'list') {
    const { results } = await db.prepare('SELECT * FROM previews WHERE repository_id=? ORDER BY created_at DESC,id DESC LIMIT 101').bind(row.id).all();
    return reply({ previews: results.slice(0, 100).map(p => wire(p, env)), truncated: results.length > 100 });
  }
  if (body.action === 'create') {
    if (!['admin', 'write'].includes(row.role)) deny();
    if (!uuidOK(body.jobId) || !uuidOK(body.idempotencyKey)) invalid('Use a completed test job and UUID v4 operation key.');
    const kind = body.kind || 'STATIC', p = kind === 'WORKER' ? appPolicy(env) : null;
    if (!['STATIC', 'WORKER', 'IMAGE_STATIC'].includes(kind) || kind === 'WORKER' && !p) throw new Fault('failed_precondition', 412, 'An operator-approved managed application allocation is required.');
    if (kind === 'IMAGE_STATIC' && (!env.REGISTRY || !/^sha256:[a-f0-9]{64}$/.test(body.imageDigest || ''))) invalid('Use an immutable tested image digest.');
    const sourcePath = p?.entry || env.PREVIEW_PATH, ttl = p?.ttl || Number(env.PREVIEW_TTL), policyHash = p ? await appPolicyHash(env) : null;
    const hash = await digest(JSON.stringify([row.id, body.jobId, sourcePath, String(ttl), env.PREVIEW_ORIGIN, ...(p ? [kind, policyHash] : kind === 'IMAGE_STATIC' ? [kind, body.imageDigest] : [])]));
    let saved = await db.prepare('SELECT * FROM previews WHERE user_id=? AND operation_key=?').bind(person.id, body.idempotencyKey).first();
    if (saved) {
      if (saved.repository_id !== row.id || saved.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to different inputs.');
      // A pending publication is inspected by original ID; never rebuilt on retry.
      return reply({ preview: wire(saved, env) });
    }
    // Checked again inside the insert below, which commits only under this observed policy revision.
    const governed = await previewEnvironment(db, row), limit = governed.policy?.maxConcurrency, lifetime = Math.min(ttl, governed.policy?.previewTtlSeconds ?? ttl);
    if (limit && (await db.prepare(`SELECT ${live} AS total`).bind(row.id, now()).first()).total >= limit) occupied(limit);
    // Installation policy may hold fewer than the deploy's slots (PREVIEW_SLOTS); never more.
    if ((await db.prepare("SELECT count(*) AS total FROM previews WHERE purged=0").first()).total >= Math.min(previewSlots, Number(env.PREVIEW_SLOTS) || previewSlots)) throw new Fault('resource_exhausted', 429, 'Clean up prior previews before allocating another.');
    const dailyLimit = Number(env.EVIDENCE_DAILY_LIMIT);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 50 ||
        (await db.prepare('SELECT count(*) AS total FROM previews WHERE created_at>=?').bind(now().slice(0, 10)).first()).total >= Math.min(dailyLimit, 20)) {
      throw new Fault('resource_exhausted', 429, 'The workspace daily preview allocation is used.');
    }
    const evidence = await (await evidenceAPI(db, env, person, row, artifact, { action: 'report', jobId: body.jobId })).json();
    if (!testPolicy(env) || evidence.job.stale || evidence.report.tests.state !== 'PASSED' || evidence.report.tests.commitId !== evidence.job.selection.headCommitId ||
        evidence.report.execution?.policySha256 !== env.TEST_POLICY_SHA256 || evidence.report.pullRequest.state !== 'ISSUE_STATE_OPEN' || row.write_pending) {
      throw new Fault('failed_precondition', 412, 'Preview requires current passing canonical PR tests under the approved test policy.');
    }
    // A pull request's head branch never changes; the report above was just proven current for this exact proposal.
    if (governed.policy && !branchAllowed(governed.policy, evidence.report.pullRequest.head?.ref)) disallowed();
    const canonical = await artifact(repo => p ? appBundle(repo, evidence.job.selection.headCommitId, p) : previewBundle(repo, evidence.job.selection.headCommitId, sourcePath));
    const image = evidence.report.tests.image;
    if (kind === 'IMAGE_STATIC' && (!image || image.digest !== body.imageDigest)) throw new Fault('failed_precondition', 412, 'The passing test job did not publish this image digest.');
    const bundle = kind === 'IMAGE_STATIC' ? await imageBundle(env, person, row, image, canonical) : canonical;
    const data = JSON.stringify(bundle), bytes = new TextEncoder().encode(data).length, bundleHash = await digest(data);
    if (bytes > 2 * 1024 * 1024) invalid('Serialized preview exceeds its limit.');
    const id = crypto.randomUUID(), key = `native-previews/${env.WORKSPACE_SLUG}/${id}/${bundleHash}.json`;
    saved = await db.prepare(`INSERT INTO previews(id,repository_id,user_id,job_id,operation_key,input_hash,selection,pr_revision,commit_id,tree_id,source_path,bundle_key,bundle_hash,bundle_bytes,state,created_at,expires_at,kind,policy_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PUBLISHING',?,?,?,? WHERE ${previewEnvironmentGuard}${limit ? ` AND ${live}<?` : ''} RETURNING *`).bind(id, row.id, person.id, body.jobId, body.idempotencyKey, hash,
        JSON.stringify({ ...evidence.job.selection, ...(kind === 'IMAGE_STATIC' ? { imageDigest: image.digest } : {}) }), evidence.report.pullRequest.revision, bundle.commitId, bundle.treeId, sourcePath, key, bundleHash, bytes, now(), new Date(Date.now() + lifetime * 1000).toISOString(), kind === 'IMAGE_STATIC' ? 'STATIC' : kind, policyHash,
        row.id, governed.revision, ...(limit ? [row.id, now(), limit] : [])).first();
    if (!saved) throw new Fault('failed_precondition', 412, 'The preview environment changed or its concurrent preview limit was reached; inspect current previews before publishing again.');
    await env.EVIDENCE_BUCKET.put(key, data, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: bundleHash } });
    const stored = await env.EVIDENCE_BUCKET.get(key);
    if (!stored || stored.size !== bytes || await digest(await stored.text()) !== bundleHash) throw Error('Preview publication unconfirmed');
    if (p) await provisionApp(db, env, saved, bundle, async () => {
      const writer = await db.prepare('SELECT u.* FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=? AND g.role IN (\'admin\',\'write\')').bind(person.id, row.id).first();
      if (!writer || saved.expires_at <= now()) deny();
      const pending = await db.prepare('SELECT state FROM previews WHERE id=?').bind(saved.id).first();
      if (pending?.state !== 'PUBLISHING') deny();
      await current(db, env, writer, row, artifact, { ...saved, state: 'READY' });
    });
    if (kind === 'IMAGE_STATIC') {
      const writer = await db.prepare("SELECT u.* FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=? AND g.role IN ('admin','write')").bind(person.id, row.id).first();
      if (!writer) deny();
      await current(db, env, writer, row, artifact, { ...saved, state: 'READY' });
    }
    await db.prepare("UPDATE previews SET state='READY' WHERE id=? AND state='PUBLISHING' AND EXISTS(SELECT 1 FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=previews.repository_id AND g.role IN ('admin','write'))")
      .bind(id, person.id).run();
    if ((await db.prepare('SELECT state FROM previews WHERE id=?').bind(id).first())?.state !== 'READY') deny();
    env.previewChanged?.(row.id);
    return reply({ preview: wire({ ...saved, state: 'READY' }, env) });
  }
  if (!uuidOK(body.previewId)) invalid('Use the original preview ID.');
  const preview = await db.prepare('SELECT * FROM previews WHERE id=? AND repository_id=?').bind(body.previewId, row.id).first();
  if (!preview) deny();
  if (body.action === 'renew') return reply({preview:await renewPreview(db,env,person,row,preview,body,next=>current(db,env,person,row,artifact,next))});
  if (body.action === 'revoke') {
    if (!['admin', 'write'].includes(row.role)) deny();
    await db.prepare("UPDATE previews SET state='REVOKED' WHERE id=?").bind(preview.id).run();
    await purge(db, env, { ...preview, state: 'REVOKED' });
    return reply({ preview: wire({ ...preview, state: 'REVOKED', purged: 1 }, env) });
  }
  if (body.action === 'capture' || body.action === 'screenshot') {
    if (preview.kind === 'WORKER') invalid('Browser snapshots currently accept static previews only.');
    await current(db, env, person, row, artifact, preview);
    if (body.action === 'screenshot') {
      if (preview.capture_state !== 'READY' || !preview.capture_key || preview.capture_bytes > 1024 * 1024) deny();
      const object = await env.EVIDENCE_BUCKET.get(preview.capture_key);
      if (!object || object.size !== preview.capture_bytes) throw Error('Snapshot unavailable');
      const bytes = await object.arrayBuffer();
      if (await byteDigest(bytes) !== preview.capture_hash) throw Error('Snapshot changed');
      await current(db, env, person, row, artifact, preview);
      return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (!['admin', 'write'].includes(row.role)) deny();
    if (!env.BROWSER || env.PREVIEW_BROWSER !== 'true') throw new Fault('failed_precondition', 412, 'An operator-approved Browser Run allocation is required.');
    if (preview.capture_state !== 'NONE') return reply({ preview: wire(preview, env) });
    const bundle = await storedBundle(env, preview), html = bundle.files.find(f => f.path === 'index.html')?.content;
    if (typeof html !== 'string') throw Error('Preview index unavailable');
    // Reserve before paid dispatch; ambiguous browser responses never re-render.
    const captureKey = `native-previews/${env.WORKSPACE_SLUG}/${preview.id}/snapshot.png`;
    await db.prepare("UPDATE previews SET capture_state='DISPATCHED',capture_key=? WHERE id=? AND capture_state='NONE'").bind(captureKey, preview.id).run();
    let timer;
    try {
      const response = await Promise.race([env.BROWSER.quickAction('screenshot', {
        html, setJavaScriptEnabled: false, rejectRequestPattern: ['.*'], cacheTTL: 0,
        viewport: { width: 1280, height: 800 }, screenshotOptions: { type: 'png', fullPage: false },
        gotoOptions: { timeout: 10000 }, actionTimeout: 10000,
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Browser deadline')), 25000); })]);
      if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') { await response.body?.cancel(); throw Error('Browser capture unconfirmed'); }
      const bytes = await bounded(response.body, 1024 * 1024);
      if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) throw Error('Invalid browser image');
      const hash = await byteDigest(bytes), measured = response.headers.get('X-Browser-Ms-Used');
      const browserMs = measured && /^[0-9]{1,7}$/.test(measured) ? Number(measured) : null;
      await db.prepare('UPDATE previews SET capture_hash=?,capture_bytes=?,browser_ms=? WHERE id=?').bind(hash, bytes.length, browserMs, preview.id).run();
      await env.EVIDENCE_BUCKET.put(captureKey, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/png' }, customMetadata: { sha256: hash } });
      const stored = await env.EVIDENCE_BUCKET.get(captureKey);
      if (!stored || stored.size !== bytes.length || await byteDigest(await stored.arrayBuffer()) !== hash) throw Error('Snapshot publication unconfirmed');
      await current(db, env, person, row, artifact, preview);
      await db.prepare("UPDATE previews SET capture_state='READY' WHERE id=? AND capture_state='DISPATCHED'").bind(preview.id).run();
    } catch {
      await db.prepare("UPDATE previews SET capture_state='UNKNOWN' WHERE id=? AND capture_state='DISPATCHED'").bind(preview.id).run();
    } finally { clearTimeout(timer); }
    return reply({ preview: wire(await db.prepare('SELECT * FROM previews WHERE id=?').bind(preview.id).first(), env) });
  }
  if (body.action !== 'grant') invalid('Use create, list, grant, revoke, capture or screenshot.');
  if (!person.email) throw new Fault('failed_precondition', 412, 'An Access email must be mapped to this Golf user.');
  await current(db, env, person, row, artifact, preview);
  const grant = secret();
  // Keep one outstanding admission per user/preview, without extending old sessions.
  await db.prepare("DELETE FROM preview_credentials WHERE preview_id=? AND user_id=? AND kind='grant'").bind(preview.id, person.id).run();
  await db.prepare("INSERT INTO preview_credentials(digest,preview_id,user_id,kind,expires_at) VALUES(?,?,?,'grant',?)")
    .bind(await digest(grant), preview.id, person.id, new Date(Date.now() + 60000).toISOString()).run();
  return reply({ grant, action: preview.kind === 'WORKER' ? `${appOrigin(env, preview.id)}/__golf/auth` : `${env.PREVIEW_ORIGIN}/${preview.id}/__golf/auth`, expiresIn: 60 });
}

export async function previewRequest(env, input, authority) {
  if (!previewPolicy(env) || !uuidOK(input?.previewId) || typeof input.email !== 'string' || input.email.length > 254 || !input.email ||
      !['GET', 'HEAD', 'POST'].includes(input.method) || typeof input.path !== 'string' || input.path.length > 1024) deny();
  const db = env.DB.withSession('first-primary');
  const person = await db.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(input.email).first();
  const preview = await db.prepare('SELECT * FROM previews WHERE id=?').bind(input.previewId).first();
  if (!person || !preview) deny();
  if (preview.kind === 'WORKER' ? input.app !== true || new URL(input.url).origin !== appOrigin(env, preview.id) : input.app === true) deny();
  const context = await authority(db, person, preview.repository_id);
  if (!context) deny();
  const { row, artifact } = context;
  await current(db, env, person, row, artifact, preview);
  const auth = input.path === '__golf/auth';
  if (auth ? input.method !== 'POST' || !tokenOK(input.grant) || input.origin !== env.PUBLIC_ORIGIN :
      !(preview.kind === 'WORKER' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD']).includes(input.method) || !tokenOK(input.credential)) deny();
  const value = auth ? input.grant : input.credential;
  const credential = await db.prepare('SELECT * FROM preview_credentials WHERE digest=? AND preview_id=? AND user_id=? AND kind=? AND expires_at>?')
    .bind(await digest(value), preview.id, person.id, auth ? 'grant' : 'session', now()).first();
  if (!credential) deny();
  if (auth) {
    const session = secret(), expires = new Date(Math.min(Date.parse(preview.expires_at), Date.now() + 300000)).toISOString();
    await db.batch([
      db.prepare('DELETE FROM preview_credentials WHERE digest=?').bind(credential.digest),
      db.prepare("DELETE FROM preview_credentials WHERE preview_id=? AND user_id=? AND kind='session'").bind(preview.id, person.id),
      db.prepare("INSERT INTO preview_credentials(digest,preview_id,user_id,kind,expires_at) VALUES(?,?,?,'session',?)").bind(await digest(session), preview.id, person.id, expires),
    ]);
    return { session, maxAge: Math.max(1, Math.floor((Date.parse(expires) - Date.now()) / 1000)) };
  }
  if (preview.kind === 'WORKER') return appDispatch(db, env, preview, input, async () => {
    const latest = await db.prepare('SELECT u.* FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=?').bind(person.id, row.id).first();
    const active = await db.prepare('SELECT * FROM previews WHERE id=?').bind(preview.id).first();
    if (!latest || !active || credential.expires_at <= now() || !await db.prepare('SELECT digest FROM preview_credentials WHERE digest=?').bind(credential.digest).first()) deny();
    await current(db, env, latest, row, artifact, active);
  });
  const bundle = await storedBundle(env, preview);
  const path = input.path || 'index.html';
  const file = bundle.files.find(f => f.path === path);
  if (!file || !agentPathOK(path) || !Object.values(types).includes(file.contentType)) deny();
  // A slow storage read must finish under current authority, not its initial grant.
  const latest = await db.prepare(`SELECT u.* FROM users u JOIN grants g ON g.user_id=u.id WHERE u.id=? AND u.active=1 AND g.repository_id=?`).bind(person.id, row.id).first();
  if (!latest || credential.expires_at <= now() || !await db.prepare('SELECT digest FROM preview_credentials WHERE digest=?').bind(credential.digest).first()) deny();
  await current(db, env, latest, row, artifact, preview);
  return { content: input.method === 'HEAD' ? null : file.content, contentType: file.contentType, commitId: preview.commit_id };
}

async function purge(db, env, preview) {
  await db.prepare('DELETE FROM preview_credentials WHERE preview_id=?').bind(preview.id).run();
  if (preview.kind === 'WORKER') await purgeApp(db, env, preview);
  // Keys written under an earlier workspace name stay this preview's own; only the preview id must match.
  const prefix = /^native-previews\/[a-z0-9][a-z0-9-]{0,38}\//.exec(preview.bundle_key || '')?.[0] + preview.id + '/';
  if (preview.bundle_key !== prefix + preview.bundle_hash + '.json') throw Error('Preview cleanup ownership differs');
  if (preview.capture_key) {
    if (preview.capture_key !== prefix + 'snapshot.png') throw Error('Snapshot cleanup ownership differs');
    await env.EVIDENCE_BUCKET.delete(preview.capture_key);
    if (await env.EVIDENCE_BUCKET.head(preview.capture_key)) throw Error('Snapshot removal unconfirmed');
  }
  await env.EVIDENCE_BUCKET.delete(preview.bundle_key);
  if (await env.EVIDENCE_BUCKET.head(preview.bundle_key)) throw Error('Preview removal unconfirmed');
  await db.prepare('UPDATE previews SET purged=1 WHERE id=?').bind(preview.id).run();
}
export async function cleanupPreviews(env) {
  if (!previewPolicy(env)) return { purged: 0 };
  const db = env.DB.withSession('first-primary');
  await db.prepare("UPDATE previews SET state='EXPIRED' WHERE expires_at<=? AND state IN ('READY','PUBLISHING')").bind(now()).run();
  const { results } = await db.prepare("SELECT * FROM previews WHERE purged=0 AND state IN ('REVOKED','EXPIRED') ORDER BY created_at LIMIT 20").all();
  let purged = 0, pending = 0;
  for (const preview of results) { try { await purge(db, env, preview); purged++; } catch { pending++; } }
  await db.prepare('DELETE FROM preview_credentials WHERE expires_at<=?').bind(now()).run();
  return { purged, ...(pending ? { pending } : {}) };
}
