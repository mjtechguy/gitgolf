import { release, configuration, timings } from './telemetry.mjs';
import { performanceSample } from './performance.mjs';
import { bounded } from './git.mjs';
// Current assets are embedded; older hashes are retained in private R2 across releases.
const builtAssets = typeof GOLF_NATIVE_ASSETS === 'undefined' ? null : GOLF_NATIVE_ASSETS;
export const immutableAsset = path => /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|svg)$/.test(path);
export function embeddedAsset(request, assets) {
    const path = new URL(request.url).pathname;
    if (!Object.hasOwn(assets, path)) return new Response('Unavailable', { status: 404 });
    const { type, content } = assets[path];
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(content), c => c.charCodeAt(0)), { headers: { 'Content-Type': type, 'Cache-Control': immutableAsset(path) ? 'private, max-age=31536000, immutable' : 'no-store' } });
}
export async function publicFetch(request, env, ctx) {
    const start = performance.now(), requestId = crypto.randomUUID(), clock = timings();
    let response;
    try { response = await dispatch(request, env, ctx, clock); }
    catch { response = new Response('Temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    const headers = new Headers(response.headers);
    if (clock.header()) headers.append('Server-Timing', clock.header());
    if (env.OPERATIONS_OBSERVABILITY === 'true') console.log(JSON.stringify({ event: 'golf.request', requestId, release, status: response.status, durationMs: Math.round(performance.now() - start) }));
    headers.set('X-Request-ID', requestId);
    headers.set('X-Golf-Worker-Release', release);
    headers.set('X-Golf-Worker-Configuration', configuration);
    headers.append('Server-Timing', `worker;dur=${(performance.now() - start).toFixed(1)}`);
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    const sample = performanceSample(request, result, performance.now() - start);
    if (sample && env.OPERATIONS_OBSERVABILITY === 'true' && ctx.waitUntil && ctx.exports?.Workspace) {
      const owner = ctx.exports.Workspace.get(ctx.exports.Workspace.idFromName(env.WORKSPACE_SLUG));
      ctx.waitUntil(owner.recordPerformance(sample).catch(() => console.log(JSON.stringify({ event: 'golf.performance_record_failed' }))));
    }
    return result;
}
async function dispatch(request, env, ctx, clock) {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response('Unavailable', { status: 404 });
    // Configured Access is the outer gate for both people and machine callers.
    if (env.ACCESS_AUD && ctx.access?.aud !== env.ACCESS_AUD) return new Response('Access sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    if (env.ACCESS_AUD && immutableAsset(url.pathname) && ['GET', 'HEAD'].includes(request.method) && !url.search && url.href.length <= 8192 && !request.headers.has('Upgrade')) {
      let response;
      if (builtAssets && Object.hasOwn(builtAssets, url.pathname)) response = embeddedAsset(request, builtAssets);
      else if (env.EVIDENCE_BUCKET) {
        const key = `ui-assets${url.pathname}`;
        const object = await env.EVIDENCE_BUCKET.get(key);
        if (object && object.size <= 4 * 1024 * 1024 && ['text/javascript; charset=utf-8', 'text/css; charset=utf-8', 'font/woff', 'font/woff2', 'image/svg+xml'].includes(object.httpMetadata?.contentType))
          response = new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'Content-Type': object.httpMetadata.contentType, 'Cache-Control': 'private, max-age=31536000, immutable' } });
      }
      if (response) { const headers = new Headers(response.headers); headers.set('X-Content-Type-Options', 'nosniff'); return new Response(response.body, { status: response.status, headers }); }
      // An unknown hash is never interpreted as an application route.
      if (!env.ASSETS) return new Response('Unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const headers = new Headers(request.headers);
    headers.delete('X-Golf-Native-Access-Email');
    if (!headers.has('Authorization') && env.ACCESS_AUD && ctx.access?.aud === env.ACCESS_AUD) {
      const identity = await clock.measure('access', () => ctx.access.getIdentity());
      if (typeof identity?.email === 'string' && identity.email.length <= 254) headers.set('X-Golf-Native-Access-Email', identity.email);
    }
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    if ((builtAssets || env.ASSETS) && !url.pathname.startsWith('/native/') && !url.pathname.startsWith('/rpc/') && !url.pathname.startsWith('/git/') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) {
      if (!['GET', 'HEAD'].includes(request.method) || url.href.length > 8192 || /[\\]/.test(url.pathname) || request.headers.has('Upgrade')) return new Response('Unavailable', { status: 404 });
      const auth = await owner.fetch(new Request(env.PUBLIC_ORIGIN + '/rpc/golf.v1.SessionService/GetSession', {
        method: 'POST', headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }));
      if (!auth.ok) return auth;
      const screen = url.pathname === '/' || /^\/(?:account|admin|organizations)(?:\/|$)/.test(url.pathname) || ['/status', '/notifications', '/audit'].includes(url.pathname) || /^\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname) && !url.pathname.startsWith('/assets/');
      const assetRequest = new Request(env.PUBLIC_ORIGIN + (screen ? '/native.html' : url.pathname), { method: request.method });
      const response = builtAssets ? embeddedAsset(assetRequest, builtAssets) : await env.ASSETS.fetch(assetRequest);
      const outgoing = new Headers(response.headers);
      outgoing.set('Cache-Control', builtAssets ? response.headers.get('Cache-Control') || 'no-store' : 'no-store');
      // Reviewer form POSTs need the control Origin; disclose no path or query.
      outgoing.set('Referrer-Policy', 'strict-origin');
      outgoing.set('X-Content-Type-Options', 'nosniff');
      const appForms = env.APP_POLICY && env.PREVIEW_ORIGIN ? ' https://*.' + new URL(env.PREVIEW_ORIGIN).hostname : '';
      outgoing.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${env.PREVIEW_ORIGIN || ''}${appForms}`);
      return new Response(response.body, { status: response.status, headers: outgoing });
    }
    if (ctx.exports.RepositoryReads && request.method === 'POST' && /^\/rpc\/golf\.v1\.RepositoryService\/(GetRepository|GetRepositoryOverview|GetContents|GetRepositoryImage|ResolveRepositorySource|ListCommits|GetCommitDiff|GetRepositoryComparison)$/.test(url.pathname)) {
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await bounded(request.clone().body, 96 * 1024))); } catch { /* Core returns the usual validation error. */ }
      if (body?.repository?.owner === env.WORKSPACE_SLUG && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.repository.name || '')) {
        const reads = ctx.exports.RepositoryReads;
        return reads.get(reads.idFromName(`${env.WORKSPACE_SLUG}/${body.repository.name}`)).fetch(new Request(request, { headers }));
      }
    }
    return owner.fetch(new Request(request, { headers }));
}
