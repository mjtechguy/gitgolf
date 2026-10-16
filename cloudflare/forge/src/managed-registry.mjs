import { Fault, deny, invalid, unsupported } from './common.mjs';
import { bounded } from './git.mjs';

export const managedOrigin = 'https://registry.cloudflare.com';
const digestOK = value => /^sha256:[a-f0-9]{64}$/.test(value || '');
const tagOK = value => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value || '');
const hash = async bytes => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const unavailable = () => { throw new Fault('unavailable', 503, 'Cloudflare registry is unavailable. Inspect the original job before retrying.'); };

export function registryBindings(settings) {
  const registry = settings.registry;
  if (!registry) return {};
  if (registry.ci !== undefined && typeof registry.ci !== 'boolean' || registry.ci && !settings.tests) throw Error('Registry CI publishing requires an explicit boolean and an approved test allocation');
  const env = { REGISTRY_CI_ENABLED: { type: 'text', value: String(registry.ci === true) } };
  if (registry.provider === 'cloudflare') {
    if (Object.keys(registry).some(key => !['provider', 'apiToken', 'ci'].includes(key)) || !/^[a-f0-9]{32}$/.test(registry.apiToken?.store || '') || !/^[A-Za-z0-9_-]{1,64}$/.test(registry.apiToken?.name || '')) throw Error('Managed registry requires a Secrets Store API token reference');
    return { ...env, REGISTRY_PROVIDER: { type: 'text', value: 'cloudflare' }, REGISTRY_ORIGIN: { type: 'text', value: managedOrigin },
      REGISTRY_ACCOUNT: { type: 'text', value: settings.account }, REGISTRY_REPOSITORY_PREFIX: { type: 'text', value: settings.account + '/' + settings.worker + '-r' },
      REGISTRY_API_TOKEN: { type: 'secrets-store-secret', storeId: registry.apiToken.store, secretName: registry.apiToken.name } };
  }
  const origin = new URL(registry.origin);
  if (registry.provider !== undefined || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(registry.worker) || registry.worker === settings.worker || origin.protocol !== 'https:' || origin.origin !== registry.origin || origin.origin === settings.origin) throw Error('Use a separate CFCR Worker and HTTPS registry origin');
  return { ...env, REGISTRY: { type: 'worker', worker: registry.worker, exportName: 'GolfRegistry' }, REGISTRY_ORIGIN: { type: 'text', value: registry.origin } };
}

export const registryRepository = (env, row) => env.REGISTRY_PROVIDER === 'cloudflare' ? env.REGISTRY_REPOSITORY_PREFIX + row.id : env.WORKSPACE_SLUG + '/' + row.name;
export function registryNameOK(env, name) {
  return env.REGISTRY_PROVIDER === 'cloudflare' ? /^([a-f0-9]{32})\/[a-z0-9-]+-r[1-9][0-9]*$/.test(name || '') && name.startsWith(env.REGISTRY_REPOSITORY_PREFIX) : new RegExp('^' + env.WORKSPACE_SLUG + '/[a-z0-9][a-z0-9._-]{0,99}$').test(name || '');
}

// Provider credentials never leave the trusted Worker, including in error bodies.
export async function managedFetch(env, path, options = {}, providerFetch = fetch) {
  if (env.REGISTRY_ORIGIN !== managedOrigin || !/^[a-f0-9]{32}$/.test(env.REGISTRY_ACCOUNT || '') || !path.startsWith('/v2/')) unavailable();
  const permissions = ['GET', 'HEAD'].includes(options.method || 'GET') ? ['pull'] : ['pull', 'push'];
  const key = permissions.join(','), cache = env.managedRegistryCredentials ||= new Map();
  let credential = cache.get(key);
  if (!credential || credential.expiresAt <= Date.now() + 10000) {
    const token = await env.REGISTRY_API_TOKEN.get();
    if (typeof token !== 'string' || !token || /[\s]/.test(token)) unavailable();
    const response = await providerFetch('https://api.cloudflare.com/client/v4/accounts/' + env.REGISTRY_ACCOUNT + '/containers/registries/registry.cloudflare.com/credentials', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiration_minutes: 5, permissions }) });
    if (!response.ok) { await response.body?.cancel(); unavailable(); }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await bounded(response.body, 32768))); } catch { unavailable(); }
    const result = data.result;
    if (!data.success || result?.account_id !== env.REGISTRY_ACCOUNT || result.registry_host !== 'registry.cloudflare.com' || ![result.username, result.password].every(v => typeof v === 'string' && /^[\x21-\x7e]{1,16384}$/.test(v)) || result.username.includes(':')) unavailable();
    credential = { authorization: 'Basic ' + btoa(result.username + ':' + result.password), expiresAt: Date.now() + 240000 };
    cache.set(key, credential);
  }
  const headers = new Headers({ Authorization: credential.authorization });
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Range', 'Accept']) if (options.headers?.has(name)) headers.set(name, options.headers.get(name));
  const { authorize, ...requestOptions } = options;
  await authorize?.();
  const response = await providerFetch(managedOrigin + path, { ...requestOptions, headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (response.status >= 300 && response.status !== 404 && response.status !== 416) {
    await response.body?.cancel(); if (response.status === 401) cache.delete(key); unavailable();
  }
  return response;
}

async function manifest(env, name, reference, providerFetch) {
  const response = await managedFetch(env, '/v2/' + name + '/manifests/' + reference, { headers: new Headers({ Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' }) }, providerFetch);
  if (response.status === 404) { await response.body?.cancel(); return null; }
  const bytes = await bounded(response.body, 1024 * 1024), digest = await hash(bytes);
  if (response.headers.get('Docker-Content-Digest') !== digest || digestOK(reference) && digest !== reference) unavailable();
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { unavailable(); }
  if (value.schemaVersion !== 2 || !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(value.mediaType)) unavailable();
  return { digest, mediaType: value.mediaType, size: bytes.length, platforms: (value.manifests || []).slice(0, 100).map(v => [v.platform?.os, v.platform?.architecture, v.platform?.variant].filter(Boolean).join('/')).filter(Boolean), publishedAt: '', scanStatus: 'not_configured' };
}

export function managedRegistry(env, authorize, providerFetch = fetch) {
  return { async manage(input) {
    if (!(await authorize(input)).read) deny();
    if (input.action !== 'status') unsupported();
    const name = registryRepository(env, { id: input.binding.repositoryId });
    // Cloudflare includes digest aliases in its tags list; display named tags only. Pages follow `last` until a 21st named tag
    // shows more exist or the list ends, at most 5 pages; a list that continues past them is also reported as truncated.
    const tags = [], seen = new Set();
    let last = '', more = false;
    for (let page = 0; page < 5 && tags.length <= 20; page++) {
      const response = await managedFetch(env, '/v2/' + name + '/tags/list?n=21' + (last ? '&last=' + encodeURIComponent(last) : ''), {}, providerFetch);
      if (response.status === 404) { await response.body?.cancel(); more = false; break; }
      let result; try { result = JSON.parse(new TextDecoder().decode(await bounded(response.body, 32768))); } catch { unavailable(); }
      if (result.name !== name || result.tags !== null && (!Array.isArray(result.tags) || result.tags.length > 1000 || result.tags.some(t => !tagOK(t) && !digestOK(t)))) unavailable();
      const list = (result.tags || []).filter(t => !seen.has(t));
      for (const t of list) { seen.add(t); if (tagOK(t)) tags.push(t); }
      more = (result.tags || []).length >= 21; last = list.at(-1);
      if (!more || !list.length) break;
    }
    const truncated = tags.length > 20 || more;
    const artifacts = [];
    for (const tag of tags.slice(0, 20)) { const item = await manifest(env, name, tag, providerFetch); if (item) artifacts.push({ ...item, tag }); }
    if (!(await authorize(input)).read) deny();
    return { enabled: true, provider: 'cloudflare', registry: managedOrigin, name: input.binding.name, imageRepository: name, artifacts, truncated };
  } };
}

export async function managedJobRequest(env, name, execution, request, providerFetch = fetch, authorize) {
  const url = new URL(request.url), base = '/v2/' + name + '/', tag = 'ci-' + execution.jobId;
  if (url.origin !== managedOrigin || url.username || url.password || url.hash || /[%\\]|\/\.\.?\//.test(url.pathname) || request.headers.has('Content-Encoding')) throw new Fault('permission_denied', 403, 'Registry request denied.');
  if (url.pathname === '/v2/' && request.method === 'GET' && !url.search) return new Response(null, { headers: { 'Docker-Distribution-Api-Version': 'registry/2.0', 'Cache-Control': 'no-store' } });
  if (!url.pathname.startsWith(base)) throw new Fault('permission_denied', 403, 'Registry request denied.');
  const suffix = url.pathname.slice(base.length), read = ['GET', 'HEAD'].includes(request.method);
  let body, upload, path = url.pathname;
  if (suffix.startsWith('manifests/')) {
    const reference = suffix.slice(10);
    if (url.search || !(reference === tag || read && digestOK(reference)) || !read && request.method !== 'PUT') throw new Fault('permission_denied', 403, 'Registry request denied.');
    if (!read) {
      body = await bounded(request.body, 1024 * 1024);
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { invalid('Use an OCI image manifest.'); }
      if (value.schemaVersion !== 2 || value.subject || !Array.isArray(value.layers) || !digestOK(value.config?.digest) || value.layers.some(layer => !digestOK(layer.digest) || layer.urls) || value.layers.length > 512) invalid('Publish one image manifest with repository-local layers.');
      const current = await manifest(env, name, tag, providerFetch);
      if (current) {
        if (current.digest !== await hash(body)) throw new Fault('permission_denied', 403, 'Registry request denied.');
        return new Response(null, { status: 201, headers: { 'Docker-Content-Digest': current.digest, 'Cache-Control': 'no-store' } });
      }
    }
  } else if (read && suffix.startsWith('blobs/') && digestOK(suffix.slice(6)) && !url.search) {
    // Reads remain limited to the repository selected by current job authority.
  } else if (suffix === 'blobs/uploads/' && request.method === 'POST' || /^blobs\/uploads\/[A-Za-z0-9_-]{1,128}$/.test(suffix) && ['PATCH', 'PUT'].includes(request.method)) {
    if (!env.registryUploadStore || [...url.searchParams.keys()].some(key => key !== 'digest') || url.searchParams.getAll('digest').length > 1 || url.search && !digestOK(url.searchParams.get('digest')) || request.method === 'PATCH' && url.search || request.method === 'PUT' && !url.search) throw new Fault('permission_denied', 403, 'Registry request denied.');
    if (suffix !== 'blobs/uploads/') {
      upload = await env.registryUploadStore.get('managed-upload:' + path);
      if (!upload || upload.jobId !== execution.jobId || upload.expiresAt <= Date.now()) throw new Fault('permission_denied', 403, 'Registry request denied.');
      path = upload.location + (url.search ? (upload.location.includes('?') ? '&' : '?') + url.searchParams.toString() : '');
    }
    body = await bounded(request.body, 32 * 1024 * 1024);
    if (url.search && request.method === 'POST') path += url.search;
  } else throw new Fault('permission_denied', 403, 'Registry request denied.');
  await authorize?.();
  if (suffix === 'blobs/uploads/' && request.method === 'POST') {
    const uploads = await env.registryUploadStore.list({ prefix: 'managed-upload:', limit: 65 });
    for (const [key, value] of uploads) if (value.expiresAt <= Date.now()) { await env.registryUploadStore.delete(key); uploads.delete(key); }
    if (uploads.size >= 64) throw new Fault('resource_exhausted', 429, 'Registry upload capacity reached.');
  }
  const response = await managedFetch(env, path, { method: request.method, headers: request.headers, body, authorize }, providerFetch);
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Docker-Distribution-Api-Version': 'registry/2.0' });
  for (const key of ['Content-Type', 'Content-Length', 'Content-Range', 'Range', 'Docker-Content-Digest', 'Docker-Upload-UUID']) if (response.headers.has(key)) headers.set(key, response.headers.get(key));
  if (response.status === 202) {
    const location = new URL(response.headers.get('Location'), managedOrigin);
    if (location.origin !== managedOrigin || location.username || location.password || location.hash || !location.pathname.startsWith(base + 'blobs/uploads/') || !/^blobs\/uploads\/[A-Za-z0-9_-]{1,128}$/.test(location.pathname.slice(base.length))) { await response.body?.cancel(); unavailable(); }
    await env.registryUploadStore.put('managed-upload:' + location.pathname, { jobId: execution.jobId, expiresAt: execution.expiresAt, location: location.pathname + location.search });
    // Upload continuation state stays in the broker, never in repository code.
    headers.set('Location', managedOrigin + location.pathname);
  } else if (upload && response.status === 201) await env.registryUploadStore.delete('managed-upload:' + url.pathname);
  await authorize?.();
  if (response.status >= 400) { await response.body?.cancel(); headers.delete('Content-Length'); return new Response(request.method === 'HEAD' ? null : 'Registry request could not be completed.', { status: response.status, headers }); }
  return new Response(response.body, { status: response.status, headers });
}
