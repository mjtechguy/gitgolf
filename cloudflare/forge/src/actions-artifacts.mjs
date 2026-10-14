// GitHub Actions artifacts v4 (the Twirp ArtifactService that @actions/artifact 2.x talks to at ACTIONS_RESULTS_URL),
// stored in R2. Same flow as Forgejo: CreateArtifact → Azure-style block uploads to a signed URL → block list →
// FinalizeArtifact; ListArtifacts/GetSignedArtifactURL → signed download. Signed URLs are HMAC'd with the requesting
// job's stored token digest, so they die with the job token and never need a separate secret.
import { Fault } from './common.mjs';
import { bounded } from './git.mjs';
import { jobByToken, artifactPrefix, openArtifact } from './pipelines.mjs';

export const artifactBase = '/twirp/github.actions.results.api.v1.ArtifactService/';
const rpcMethods = new Set(['CreateArtifact', 'FinalizeArtifact', 'ListArtifacts', 'GetSignedArtifactURL', 'DeleteArtifact']);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const twirpError = (code, msg, status) => json({ code, msg }, status);
const now = () => new Date().toISOString();
const field = (body, camel, snake) => body[camel] ?? body[snake];
const wrapped = value => value && typeof value === 'object' && 'value' in value ? value.value : value;
const nameOK = name => typeof name === 'string' && /^[^\x00-\x1f\x7f"/\\:<>|*?]{1,255}$/.test(name) && name.trim() === name;
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const maxArtifact = 2 * 1024 * 1024 * 1024, maxBlock = 64 * 1024 * 1024;

async function sign(job, endpoint, artifactId, expires) {
  if (!job.token_digest) throw new Fault('permission_denied', 403, 'Job token ended.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(job.token_digest), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(['golf.actions-artifact.v1', endpoint, artifactId, job.id, expires].join('\n')))));
}
async function signedURL(env, job, endpoint, artifactId) {
  const expires = String(Date.now() + 60 * 60_000);
  return `${env.PUBLIC_ORIGIN}${artifactBase}${endpoint}?artifactID=${artifactId}&taskID=${job.id}&expires=${expires}&sig=${await sign(job, endpoint, artifactId, expires)}`;
}
async function verify(db, url, endpoint) {
  const artifactId = url.searchParams.get('artifactID'), taskId = url.searchParams.get('taskID'), expires = url.searchParams.get('expires'), sig = url.searchParams.get('sig');
  if (!/^\d{1,15}$/.test(artifactId || '') || !/^\d{1,15}$/.test(taskId || '') || !/^\d{13}$/.test(expires || '') || Number(expires) < Date.now() || !sig) throw new Fault('unauthenticated', 401, 'Signed URL invalid or expired.');
  const job = await db.prepare("SELECT * FROM pipeline_jobs WHERE id=? AND state='RUNNING'").bind(Number(taskId)).first();
  if (!job || await sign(job, endpoint, artifactId, expires) !== sig) throw new Fault('unauthenticated', 401, 'Signed URL invalid or expired.');
  const artifact = await db.prepare('SELECT * FROM pipeline_artifacts WHERE id=? AND run_id=?').bind(Number(artifactId), job.run_id).first();
  if (!artifact) throw new Fault('not_found', 404, 'Artifact unavailable.');
  return { job, artifact };
}

export const artifactRoute = pathname => pathname.startsWith(artifactBase) && /^[A-Za-z]+$/.test(pathname.slice(artifactBase.length));

export async function actionsArtifacts(request, env) {
  const url = new URL(request.url), method = url.pathname.slice(artifactBase.length), db = env.DB.withSession('first-primary');
  try {
    if (method === 'UploadArtifact') {
      if (request.method !== 'PUT') throw new Fault('invalid_argument', 400, 'Use PUT.');
      const { job, artifact } = await verify(db, url, 'UploadArtifact');
      if (artifact.job_id !== job.id || artifact.state !== 'UPLOADING') throw new Fault('failed_precondition', 412, 'Artifact is not being uploaded by this job.');
      const comp = url.searchParams.get('comp'), prefix = artifactPrefix(job.run_id, artifact.id);
      if (comp === 'block' || comp === 'appendBlock' || comp === null) {
        const blockId = url.searchParams.get('blockid') || 'single';
        if (blockId.length > 1024) throw new Fault('invalid_argument', 400, 'Block id too long.');
        const length = Number(request.headers.get('Content-Length'));
        if (!Number.isSafeInteger(length) || length < 0 || length > maxBlock) throw new Fault('invalid_argument', 400, 'Blocks need a Content-Length up to 64 MiB.');
        const key = prefix + 'block-' + b64url(new TextEncoder().encode(blockId));
        const stored = await env.PIPELINE_BUCKET.put(key, request.body && length ? request.body : new Uint8Array(), { httpMetadata: { contentType: 'application/octet-stream' } });
        if (comp === null) await db.prepare("UPDATE pipeline_artifacts SET blocks=?,size=? WHERE id=? AND state='UPLOADING'").bind(JSON.stringify([key]), stored?.size ?? length, artifact.id).run();
        return new Response(null, { status: 201, headers: { 'x-ms-request-id': crypto.randomUUID(), 'x-ms-version': '2023-11-03' } });
      }
      if (comp === 'blocklist') {
        const xml = new TextDecoder().decode(await bounded(request.body, 4 * 1024 * 1024));
        const ids = [...xml.matchAll(/<(?:Latest|Committed|Uncommitted)>([^<]*)<\/(?:Latest|Committed|Uncommitted)>/g)].map(match => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        if (ids.length > 50000) throw new Fault('invalid_argument', 400, 'Too many blocks.');
        const keys = ids.map(id => prefix + 'block-' + b64url(new TextEncoder().encode(id)));
        let size = 0;
        for (const key of keys) { const head = await env.PIPELINE_BUCKET.head(key); if (!head) throw new Fault('failed_precondition', 412, 'A listed block was not uploaded.'); size += head.size; }
        if (size > maxArtifact) throw new Fault('resource_exhausted', 429, 'Artifacts are limited to 2 GiB.');
        await db.prepare("UPDATE pipeline_artifacts SET blocks=?,size=? WHERE id=? AND state='UPLOADING'").bind(JSON.stringify(keys), size, artifact.id).run();
        return new Response(null, { status: 201, headers: { 'x-ms-request-id': crypto.randomUUID(), 'x-ms-version': '2023-11-03' } });
      }
      throw new Fault('invalid_argument', 400, 'Unsupported upload operation.');
    }
    if (method === 'DownloadArtifact') {
      if (!['GET', 'HEAD'].includes(request.method)) throw new Fault('invalid_argument', 400, 'Use GET.');
      const { artifact } = await verify(db, url, 'DownloadArtifact');
      if (artifact.state !== 'READY') throw new Fault('not_found', 404, 'Artifact unavailable.');
      const { row, body } = await openArtifact(db, env, artifact.id);
      return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': row.content_type, 'Content-Length': String(row.size), 'Content-Disposition': `attachment; filename="${row.name.replace(/[^A-Za-z0-9._-]/g, '_')}.zip"`, 'Cache-Control': 'no-store' } });
    }
    if (!rpcMethods.has(method)) return twirpError('bad_route', 'Unknown method.', 404);
    if (request.method !== 'POST' || !(request.headers.get('Content-Type') || '').startsWith('application/json')) return twirpError('malformed', 'Use JSON POST.', 400);
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return twirpError('unauthenticated', 'Job runtime token required.', 401);
    const { job, run } = await jobByToken(db, env, auth.slice(7));
    let body;
    try { body = JSON.parse(new TextDecoder().decode(await bounded(request.body, 65536))); } catch { return twirpError('malformed', 'Invalid JSON.', 400); }
    const runId = String(field(body, 'workflowRunBackendId', 'workflow_run_backend_id') ?? ''), jobId = String(field(body, 'workflowJobRunBackendId', 'workflow_job_run_backend_id') ?? '');
    if (runId !== String(run.id)) return twirpError('permission_denied', 'The token belongs to another run.', 403);
    if (['CreateArtifact', 'FinalizeArtifact'].includes(method) && jobId !== String(job.id)) return twirpError('permission_denied', 'The token belongs to another job.', 403);
    if (method === 'CreateArtifact') {
      const name = body.name;
      if (!nameOK(name)) return twirpError('invalid_argument', 'Invalid artifact name.', 400);
      const count = await db.prepare('SELECT COUNT(*) AS n FROM pipeline_artifacts WHERE run_id=?').bind(run.id).first();
      if (count.n >= 500) return twirpError('resource_exhausted', 'A run may keep at most 500 artifacts.', 429);
      const expiresAt = wrapped(field(body, 'expiresAt', 'expires_at'));
      const expires = expiresAt && Date.parse(expiresAt) > Date.now() ? new Date(Math.min(Date.parse(expiresAt), Date.now() + 90 * 86400_000)).toISOString() : new Date(Date.now() + 30 * 86400_000).toISOString();
      const created = await db.prepare(`INSERT INTO pipeline_artifacts(run_id,job_id,name,kind,state,size,content_type,created_at,expires_at) VALUES(?,?,?,'actions-v4','UPLOADING',0,'application/zip',?,?)
        ON CONFLICT(job_id,name) DO UPDATE SET state='UPLOADING',size=0,blocks='[]',sha256='',created_at=excluded.created_at,expires_at=excluded.expires_at RETURNING id`).bind(run.id, job.id, name, now(), expires).first();
      return json({ ok: true, signedUploadUrl: await signedURL(env, job, 'UploadArtifact', created.id) });
    }
    if (method === 'FinalizeArtifact') {
      const artifact = await db.prepare("SELECT * FROM pipeline_artifacts WHERE job_id=? AND name=? AND state='UPLOADING'").bind(job.id, body.name).first();
      if (!artifact) return twirpError('not_found', 'Artifact not being uploaded.', 404);
      const blocks = JSON.parse(artifact.blocks);
      if (!blocks.length) return twirpError('failed_precondition', 'No uploaded content.', 412);
      const size = Number(wrapped(body.size) ?? artifact.size), hash = String(wrapped(body.hash) || '');
      if (size !== artifact.size) return twirpError('failed_precondition', `Uploaded ${artifact.size} bytes, finalize reported ${size}.`, 412);
      await db.prepare("UPDATE pipeline_artifacts SET state='READY',sha256=?,finalized_at=? WHERE id=? AND state='UPLOADING'").bind(/^sha256:[a-f0-9]{64}$/.test(hash) ? 'reported:' + hash.slice(7) : '', now(), artifact.id).run();
      return json({ ok: true, artifactId: String(artifact.id) });
    }
    if (method === 'ListArtifacts' || method === 'GetSignedArtifactURL' || method === 'DeleteArtifact') {
      const { results } = await db.prepare("SELECT * FROM pipeline_artifacts WHERE run_id=? AND state='READY' AND kind='actions-v4' ORDER BY id DESC").bind(run.id).all();
      const latest = new Map();
      for (const row of results) if (!latest.has(row.name) && Date.parse(row.expires_at) > Date.now()) latest.set(row.name, row);
      if (method === 'ListArtifacts') {
        const nameFilter = wrapped(field(body, 'nameFilter', 'name_filter')), idFilter = wrapped(field(body, 'idFilter', 'id_filter'));
        const artifacts = [...latest.values()].filter(row => (nameFilter == null || row.name === nameFilter) && (idFilter == null || String(row.id) === String(idFilter)))
          .map(row => ({ workflowRunBackendId: String(run.id), workflowJobRunBackendId: String(row.job_id), databaseId: String(row.id), name: row.name, size: String(row.size), createdAt: row.created_at }));
        return json({ artifacts });
      }
      const row = latest.get(body.name);
      if (!row) return twirpError('not_found', 'Artifact not found.', 404);
      if (method === 'DeleteArtifact') {
        if (row.job_id !== job.id && !(await db.prepare('SELECT 1 AS ok FROM pipeline_jobs WHERE id=? AND run_id=?').bind(row.job_id, run.id).first())) return twirpError('permission_denied', 'Not this run.', 403);
        await db.prepare("UPDATE pipeline_artifacts SET state='DELETED' WHERE id=?").bind(row.id).run();
        return json({ ok: true, artifactId: String(row.id) });
      }
      return json({ signedUrl: await signedURL(env, job, 'DownloadArtifact', row.id) });
    }
  } catch (error) {
    if (error instanceof Fault) return twirpError(error.code, error.message, error.status === 412 ? 400 : error.status);
    console.log(JSON.stringify({ event: 'golf.actions_artifact_error', message: String(error?.message || error).slice(0, 300) }));
    return twirpError('internal', 'Artifact operation could not be confirmed.', 503);
  }
}
