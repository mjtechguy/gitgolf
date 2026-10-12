import { digest, deny, invalid, Fault } from './common.mjs';
import { appPolicy, appOrigin, appPolicyHash } from './app-policy.mjs';
import { bounded, sha } from './git.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const name = id => 'golf-pr-' + id.replaceAll('-', '');
const cleaner = `export default {async fetch(request,env){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/purge')return new Response('',{status:404});
  const batch=await env.FILES.list({limit:1000});
  if(batch.objects.length)await env.FILES.delete(batch.objects.map(o=>o.key));
  const next=await env.FILES.list({limit:1});
  return Response.json({empty:next.objects.length===0&&!next.truncated});
}}`;

// Only the operator's Secrets Store binding supplies management authority.
export async function provider(env, path, method = 'GET', body) {
  if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID) || !path.startsWith('/') || /[%?#\\]/.test(path)) throw Error('Invalid provider allocation');
  const token = await env.APP_PROVISIONER.get();
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('Management credential unavailable');
  const multipart = body instanceof FormData;
  const response = await (env.appProviderFetch || fetch)(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
  });
  if (method === 'GET' && response.status === 404) { await response.body?.cancel(); return null; }
  const data = await bounded(response.body, 256 * 1024);
  // Some deletion endpoints acknowledge with an empty body; callers still verify absence.
  if (method === 'DELETE' && response.ok && data.byteLength === 0) return null;
  let value;
  try { value = JSON.parse(new TextDecoder().decode(data)); } catch { throw Error('Provider result unconfirmed'); }
  if (!response.ok || value.success !== true) throw Error('Provider result unconfirmed', { cause: response.status });
  // Dispatch details return 200 with script:null when that script does not exist.
  if (method === 'GET' && /^\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/.test(path) && value.result?.script === null) return null;
  return value.result;
}

export async function appBundle(repo, commitId, policy) {
  const commit = await repo.readCommit(commitId);
  if (!sha(commit?.treeHash)) throw Error('Application source unavailable');
  const files = [];
  for (const path of [policy.entry, policy.migration]) {
    let hash = commit.treeHash, entry;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entries = await repo.readTree(hash);
      if (!Array.isArray(entries) || entries.length > 100 || entries.filter(e => e.name === parts[i]).length !== 1) invalid('Approved application source unavailable.');
      entry = entries.find(e => e.name === parts[i]);
      if (!sha(entry.hash) || (i < parts.length - 1 ? entry.type !== 'tree' : entry.type !== 'blob' || entry.mode !== '100644')) invalid('Application sources must be regular files.');
      hash = entry.hash;
    }
    const blob = await repo.readBlob(entry.hash);
    if (!blob || blob.size < 1 || blob.size > (path === policy.entry ? 256 : 32) * 1024) invalid('Application source exceeds the approved limit.');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()); } catch { invalid('Application sources must be UTF-8.'); }
    if (content.includes('\0')) invalid('Application sources must be text.');
    files.push({ path, content });
  }
  // shortcut: one prebundled ES module; add an isolated build stage before supporting package installs.
  return { schema: 'golf.native.worker-preview.v1', commitId, treeId: commit.treeHash, sourcePath: policy.entry, files };
}

async function reserve(db, id, kind, resourceName) {
  await db.prepare("INSERT INTO app_resources(preview_id,kind,name,state) VALUES(?,?,?,'DISPATCHED')").bind(id, kind, resourceName).run();
}
async function confirm(db, id, kind, providerId, identity) {
  await db.prepare("UPDATE app_resources SET state='READY',provider_id=?,identity=? WHERE preview_id=? AND kind=? AND state='DISPATCHED'")
    .bind(providerId, JSON.stringify(identity), id, kind).run();
}
const scriptPath = (p, n) => `/workers/dispatch/namespaces/${p.namespace}/scripts/${n}`;
const resource = (db, id, kind) => db.prepare('SELECT * FROM app_resources WHERE preview_id=? AND kind=?').bind(id, kind).first();
function scriptMatches(observed, n, identity) {
  return observed?.script?.id === n && observed.script.etag === identity.etag && observed.script.tags?.includes(identity.tag);
}
async function upload(db, env, preview, p, kind, n, source, bindings) {
  const path = scriptPath(p, n), tag = `golf:${preview.id}:${await digest(source)}`;
  if (await provider(env, path)) throw Error('Application script already exists');
  await reserve(db, preview.id, kind, n);
  const data = new FormData();
  data.set('metadata', JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-10-09',
    bindings, tags: [tag], logpush: false, observability: { enabled: false }, limits: { cpu_ms: 50 } }));
  data.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
  const uploaded = await provider(env, path, 'PUT', data);
  if (!uploaded?.etag || uploaded.id !== n) throw Error('Application script upload unconfirmed');
  // Persist the acknowledged identity before readback, so cleanup can recover a failed read.
  await confirm(db, preview.id, kind, n, { etag: uploaded.etag, tag });
  if (!scriptMatches(await provider(env, path), n, { etag: uploaded.etag, tag })) throw Error('Application script readback differs');
  const actual = await provider(env, path + '/bindings');
  if (!Array.isArray(actual) || actual.length !== bindings.length || bindings.some(wanted => !actual.some(b => Object.entries(wanted).every(([k, v]) => b[k] === v)))) throw Error('Application bindings differ');
}

export async function provisionApp(db, env, preview, bundle, authorize) {
  const p = appPolicy(env);
  if (!p || bundle.schema !== 'golf.native.worker-preview.v1') throw Error('Application policy unavailable');
  const n = name(preview.id);
  // Replaying the original preview never enters here; an uncertain effect stays fenced.
  await authorize();
  await reserve(db, preview.id, 'database', n);
  const database = await provider(env, '/d1/database', 'POST', { name: n });
  if (!uuid(database?.uuid) || database.name !== n) throw Error('Application database allocation unconfirmed');
  await confirm(db, preview.id, 'database', database.uuid, { name: n });
  if ((await provider(env, '/d1/database/' + database.uuid))?.name !== n) throw Error('Application database readback differs');
  await authorize();
  await reserve(db, preview.id, 'migration', n);
  const queries = await provider(env, `/d1/database/${database.uuid}/query`, 'POST', { sql: bundle.files.find(f => f.path === p.migration).content });
  if (!Array.isArray(queries) || !queries.length || queries.some(q => q.success !== true)) throw Error('Application schema unconfirmed');
  await confirm(db, preview.id, 'migration', database.uuid, { name: n });
  if (await provider(env, '/r2/buckets/' + n)) throw Error('Application bucket already exists');
  await authorize();
  await reserve(db, preview.id, 'bucket', n);
  const bucket = await provider(env, '/r2/buckets', 'POST', { name: n });
  if (bucket?.name !== n || !bucket.creation_date) throw Error('Application bucket allocation unconfirmed');
  await confirm(db, preview.id, 'bucket', n, { creationDate: bucket.creation_date });
  if ((await provider(env, '/r2/buckets/' + n))?.creation_date !== bucket.creation_date) throw Error('Application bucket readback differs');
  await authorize();
  await upload(db, env, preview, p, 'cleaner', n + '-cleanup', cleaner, [{ type: 'r2_bucket', name: 'FILES', bucket_name: n }]);
  await authorize();
  const bindings = [{ type: 'd1', name: 'DB', database_id: database.uuid }, { type: 'r2_bucket', name: 'FILES', bucket_name: n },
    { type: 'plain_text', name: 'GOLF_COMMIT', text: preview.commit_id }];
  if (p.secret) bindings.push({ type: 'secrets_store_secret', name: 'APP_SECRET', store_id: p.secret.store, secret_name: p.secret.name });
  await upload(db, env, preview, p, 'script', n, bundle.files.find(f => f.path === p.entry).content, bindings);
  await authorize();
  const hostname = new URL(appOrigin(env, preview.id)).hostname;
  const domains = await provider(env, '/workers/domains');
  if (!Array.isArray(domains) || domains.some(d => d.hostname === hostname)) throw Error('Application hostname already exists');
  await reserve(db, preview.id, 'domain', hostname);
  const domain = await provider(env, '/workers/domains', 'PUT', { hostname, service: p.gateway, environment: 'production', zone_id: p.zone });
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(domain?.id) || domain.hostname !== hostname || domain.service !== p.gateway || domain.zone_id !== p.zone) throw Error('Application domain allocation unconfirmed');
  await confirm(db, preview.id, 'domain', domain.id, { service: p.gateway, zone: p.zone });
  const observed = await provider(env, '/workers/domains/' + domain.id);
  if (observed?.hostname !== hostname || observed.service !== p.gateway || observed.zone_id !== p.zone) throw Error('Application domain readback differs');
  await authorize();
}

export async function appDispatch(db, env, preview, input, authorize) {
  const p = appPolicy(env), script = await resource(db, preview.id, 'script');
  if (!p || script?.state !== 'READY' || script.name !== name(preview.id)) deny();
  const original = new URL(input.url);
  if (original.href.length > 4096 || original.origin !== appOrigin(env, preview.id) || original.username || original.password || original.hash ||
      original.pathname.startsWith('/__golf') || /[%\\]/.test(original.pathname) || !['GET', 'HEAD', 'POST'].includes(input.method)) deny();
  if (input.method === 'POST' && input.origin !== original.origin) deny();
  if (input.body && (!(input.body instanceof Uint8Array) || input.body.byteLength > 64 * 1024)) deny();
  // An allowlist prevents Access, Golf, service credentials and spoofed identity reaching user code.
  const headers = new Headers();
  for (const key of ['Accept', 'Content-Type']) if (typeof input.headers?.[key] === 'string') headers.set(key, input.headers[key].slice(0, 256));
  const worker = env.APP_DISPATCH.get(script.name, {}, { limits: { cpuMs: 50, subRequests: 8 } });
  await authorize();
  const allocated = await db.prepare('INSERT INTO app_requests(day,total) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET total=total+1 WHERE total<2000 RETURNING total').bind(new Date().toISOString().slice(0, 10)).first();
  if (!allocated) throw new Fault('resource_exhausted', 429, 'The workspace daily application request allocation is used.');
  const controller = new AbortController(); let timer;
  let response, bytes;
  try {
    bytes = await Promise.race([(async () => {
      response = await worker.fetch(new Request(original, { method: input.method, headers, redirect: 'manual', signal: controller.signal,
        ...(['GET', 'HEAD'].includes(input.method) ? {} : { body: input.body }) }));
      if (response.status < 200 || response.status >= 300 || response.headers.has('Location')) { await response.body?.cancel(); deny(); }
      return bounded(response.body, 1024 * 1024);
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Application request deadline')); }, 15000); })]);
  } finally { clearTimeout(timer); controller.abort(); }
  await authorize();
  return { content: input.method === 'HEAD' || [204, 205].includes(response.status) ? null : bytes, contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    commitId: preview.commit_id, app: true, status: response.status };
}

export async function purgeApp(db, env, preview) {
  const p = appPolicy(env);
  if (!p || preview.policy_hash !== await appPolicyHash(env)) throw Error('Application cleanup policy differs');
  const n = name(preview.id);
  const { results } = await db.prepare('SELECT * FROM app_resources WHERE preview_id=?').bind(preview.id).all();
  for (const r of results) if (r.kind === 'domain' ? r.name !== new URL(appOrigin(env, preview.id)).hostname : r.name !== (r.kind === 'cleaner' ? n + '-cleanup' : n)) throw Error('Application cleanup ownership differs');
  // Lost create acknowledgements require operator reconciliation; never adopt by name.
  if (results.some(r => r.state === 'DISPATCHED' && r.kind !== 'migration')) throw Error('Reconcile the original uncertain application allocation before cleanup');
  for (const kind of ['domain', 'script', 'bucket', 'cleaner', 'database', 'migration']) {
    const r = results.find(r => r.kind === kind);
    if (!r || r.state === 'DELETED') continue;
    const identity = r.identity ? JSON.parse(r.identity) : null;
    let path;
    if (kind === 'migration') {
      const database = await resource(db, preview.id, 'database');
      if (database?.state !== 'DELETED') throw Error('Application database removal unconfirmed');
    } else {
      path = kind === 'domain' ? '/workers/domains/' + r.provider_id : kind === 'database' ? '/d1/database/' + r.provider_id :
        kind === 'bucket' ? '/r2/buckets/' + n : scriptPath(p, r.name);
      const observed = await provider(env, path);
      if (observed) {
        if (kind === 'domain' ? observed.hostname !== r.name || observed.service !== identity.service || observed.zone_id !== identity.zone :
            kind === 'database' ? !uuid(r.provider_id) || observed.uuid !== r.provider_id || observed.name !== n :
            kind === 'bucket' ? observed.name !== n || observed.creation_date !== identity.creationDate : !scriptMatches(observed, r.name, identity)) throw Error('Application cleanup identity differs');
        if (kind === 'bucket') {
          const maintenance = await resource(db, preview.id, 'cleaner');
          if (maintenance) {
            if (maintenance.state !== 'READY' || !scriptMatches(await provider(env, scriptPath(p, maintenance.name)), maintenance.name, JSON.parse(maintenance.identity))) throw Error('Application bucket cleaner unavailable');
            const result = await env.APP_DISPATCH.get(maintenance.name, {}, { limits: { cpuMs: 50, subRequests: 0 } }).fetch(new Request('https://cleanup.invalid/purge', { method: 'POST' }));
            if (!result.ok || (await result.json()).empty !== true) throw Error('Application bucket purge remains pending');
          }
        }
        await provider(env, path, 'DELETE');
        if (await provider(env, path)) throw Error('Application resource removal unconfirmed');
      }
    }
    await db.prepare("UPDATE app_resources SET state='DELETED' WHERE preview_id=? AND kind=?").bind(preview.id, kind).run();
  }
}
