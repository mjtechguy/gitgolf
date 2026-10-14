import { release, configuration, timings, builtAt } from './telemetry.mjs';
import { performanceSample } from './performance.mjs';
import { bounded } from './git.mjs';
import { accessContext, accessIssuedAt } from './access.mjs';
import { anonymousLimit } from './rate-limit.mjs';
import { releaseAssetDownload } from './asset-download.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { forgejoRunner, forgejoRunnerRoute, actionsGit, actionsGitRoute } from './forgejo-runner.mjs';
import { actionsArtifacts, artifactRoute } from './actions-artifacts.mjs';
import { machineTokenRoute } from './api-tokens.mjs';

// "appearance" or "appearance/layout", matching web/public/theme.js.
export const defaultAppearance = /^(classic(\/(primer|workbench|reader))?|golf(\/(refined|strokes|tiles))?|flare(\/(kumo|overview|console))?)$/;
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
    if (sample && env.OPERATIONS_OBSERVABILITY === 'true' && ctx.waitUntil && ctx.exports?.Workspace && !response.headers.has('X-Golf-Rate-Limited')) {
      const owner = ctx.exports.Workspace.get(ctx.exports.Workspace.idFromName(env.WORKSPACE_SLUG));
      ctx.waitUntil(owner.recordPerformance(sample).catch(() => console.log(JSON.stringify({ event: 'golf.performance_record_failed' }))));
    }
    return result;
}
async function dispatch(request, env, ctx, clock) {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response('Unavailable', { status: 404 });
    // Stock Forgejo Runner protocol, its artifacts and the job-token Git source: outside Access like /api/v4, each call checks
    // runner/job/repository/feature authority against D1 and never enters the workspace queue.
    if (pipelinePolicy(env)) {
      const pipelineEnv = () => ({ ...env, pipelineCoordinator: ctx.exports?.PipelineRun, waitUntil: promise => ctx.waitUntil(promise),
        notifyPipeline: id => ctx.waitUntil?.(ctx.exports.Workspace.get(ctx.exports.Workspace.idFromName(env.WORKSPACE_SLUG)).activityChanged(String(id), ['actions']).catch(() => {})) });
      if (forgejoRunnerRoute(url.pathname)) return forgejoRunner(request, pipelineEnv());
      if (artifactRoute(url.pathname)) return actionsArtifacts(request, pipelineEnv());
      if (actionsGitRoute(url.pathname) && (request.method === 'POST' || url.search === '?service=git-upload-pack')) return actionsGit(request, pipelineEnv(), (await import('./core.mjs')).withArtifact);
    }
    // Configured Access is the outer gate for people; machine routes (runners, agent hosts) check their own credentials against D1.
    // An API token (golf_pat_) on /mcp, /native/source/* or /git/* is one too; the same paths without one still need Access.
    const apiToken = machineTokenRoute(url.pathname, request.headers.get('Authorization'));
    const machineRoute = url.pathname.startsWith('/native/runner-machine/') || url.pathname.startsWith('/native/agent-host/') || url.pathname.startsWith('/api/v4/') || apiToken;
    const access = env.ACCESS_AUD && !machineRoute ? await clock.measure('access_auth', () => accessContext(request, env, ctx)) : null;
    const publicSite = env.PUBLIC_REPOSITORIES === 'true';
    if (env.ACCESS_AUD && !access && !machineRoute && !publicSite) return new Response('Access sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    // Optional throttle for credential-less public reads and clones, before they reach the workspace queue.
    const limited = await anonymousLimit(request, env, access);
    if (limited) return limited;
    if (publicSite && url.pathname === '/auth/login') {
      if (request.method !== 'GET' || !access || !(await access.getIdentity())?.email) return new Response('Access sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
      const target = url.searchParams.get('returnTo') || '/';
      const safe = target.startsWith('/') && !target.startsWith('//') && !/[\\\r\n]/.test(target) && target.length <= 4096;
      return new Response(null, { status: 303, headers: { Location: safe ? target : '/', 'Cache-Control': 'no-store' } });
    }
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
    for (const name of ['X-Golf-Native-Access-Email', 'X-Golf-Native-Access-Issued-At', 'X-Golf-Native-Access-Colo', 'X-Golf-Native-Access-Country']) headers.delete(name);
    // Always this edge's own build, never a caller's value: the workspace retires an instance older than the edge serving it.
    headers.set('X-Golf-Edge-Built-At', String(builtAt));
    // A token request is the token alone: no browser cookie travels with it, and no Access identity is added below.
    if (apiToken) headers.delete('Cookie');
    if (!headers.has('Authorization') && access) {
      const identity = await clock.measure('access', () => access.getIdentity());
      if (typeof identity?.email === 'string' && identity.email.length <= 254) headers.set('X-Golf-Native-Access-Email', identity.email);
      // Installation policy changes record when and from where the person signed in; only that route pays for the extra verification.
      if (url.pathname === '/native/installation' && headers.has('X-Golf-Native-Access-Email')) {
        const issued = await accessIssuedAt(request, env, access);
        if (issued) headers.set('X-Golf-Native-Access-Issued-At', String(issued));
      }
    }
    // Where a request came from, for audit rows (installation.mjs and audit.mjs). Removed above, so only Cloudflare's own values arrive.
    if (/^[A-Z]{3}$/.test(request.cf?.colo || '')) headers.set('X-Golf-Native-Access-Colo', request.cf.colo);
    if (/^[A-Z]{2}$/.test(request.cf?.country || '')) headers.set('X-Golf-Native-Access-Country', request.cf.country);
    const workspace = ctx.exports.Workspace;
    const owner = workspace.get(workspace.idFromName(env.WORKSPACE_SLUG));
    if (url.pathname.startsWith('/api/repositories/')) return releaseAssetDownload(request, env, owner, headers);
    if ((builtAssets || env.ASSETS) && url.pathname !== '/mcp' && !url.pathname.startsWith('/native/') && !url.pathname.startsWith('/rpc/') && !url.pathname.startsWith('/git/') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) {
      if (!['GET', 'HEAD'].includes(request.method) || url.href.length > 8192 || /[\\]/.test(url.pathname) || request.headers.has('Upgrade')) return new Response('Unavailable', { status: 404 });
      const auth = await owner.fetch(new Request(env.PUBLIC_ORIGIN + '/rpc/golf.v1.SessionService/GetSession', {
        method: 'POST', headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }));
      if (!auth.ok) return auth;
      const screen = publicSite && /^\/[a-z0-9][a-z0-9-]{0,38}$/.test(url.pathname) || url.pathname === '/' || /^\/(?:account|admin|organizations)(?:\/|$)/.test(url.pathname) || ['/status', '/notifications', '/audit'].includes(url.pathname) || /^\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname) && !url.pathname.startsWith('/assets/');
      const assetRequest = new Request(env.PUBLIC_ORIGIN + (screen ? '/native.html' : url.pathname), { method: request.method });
      const response = builtAssets ? embeddedAsset(assetRequest, builtAssets) : await env.ASSETS.fetch(assetRequest);
      const outgoing = new Headers(response.headers);
      outgoing.set('Cache-Control', builtAssets ? response.headers.get('Cache-Control') || 'no-store' : 'no-store');
      // Reviewer form POSTs need the control Origin; disclose no path or query.
      outgoing.set('Referrer-Policy', 'strict-origin');
      outgoing.set('X-Content-Type-Options', 'nosniff');
      const appForms = env.APP_POLICY && env.PREVIEW_ORIGIN ? ' https://*.' + new URL(env.PREVIEW_ORIGIN).hostname : '';
      outgoing.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${env.PREVIEW_ORIGIN || ''}${appForms}`);
      if (screen && request.method === 'GET' && response.ok) {
        // Reuse this request's fresh session; keep personalized HTML uncached.
        const session = JSON.stringify(await auth.json()).replace(/</g, '\\u003c');
        let html = (await response.text()).replace('<script id="golf-session" type="application/json">null</script>', () => `<script id="golf-session" type="application/json">${session}</script>`);
        if (publicSite) html = html.replace('<html', '<html data-golf-public="true"');
        // The operator's first-visit appearance and layout; web/public/theme.js applies it before paint.
        if (defaultAppearance.test(env.DEFAULT_APPEARANCE || '')) html = html.replace('<html', `<html data-golf-default-appearance="${env.DEFAULT_APPEARANCE}"`);
        outgoing.set('Cache-Control', 'no-store'); outgoing.delete('Content-Length');
        return new Response(html, { status: response.status, headers: outgoing });
      }
      return new Response(response.body, { status: response.status, headers: outgoing });
    }
    if (ctx.exports.RepositoryReads && request.method === 'POST' && /^\/rpc\/golf\.v1\.RepositoryService\/(GetRepository|GetRepositoryOverview|GetRepositoryFileIndex|GetContents|GetRepositoryImage|ResolveRepositorySource|ListCommits|GetCommitDiff|GetRepositoryComparison)$/.test(url.pathname)) {
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await bounded(request.clone().body, 96 * 1024))); } catch { /* Core returns the usual validation error. */ }
      if (/^[a-z0-9][a-z0-9-]{0,99}$/.test(body?.repository?.owner || '') && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.repository.name || '')) {
        const reads = ctx.exports.RepositoryReads;
        return reads.get(reads.idFromName(`${body.repository.owner}/${body.repository.name}`)).fetch(new Request(request, { headers }));
      }
    }
    return owner.fetch(new Request(request, { headers }));
}
