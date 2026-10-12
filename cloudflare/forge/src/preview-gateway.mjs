import { uuidOK } from './common.mjs';
import { bounded } from './git.mjs';
const headers = { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' };
const denied = () => new Response('Protected preview unavailable', { status: 404, headers });
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url), base = new URL(env.PREVIEW_ORIGIN), parts = url.pathname.split('/');
      const app = url.protocol === 'https:' && !url.port && url.hostname.endsWith('.' + base.hostname);
      const id = app ? url.hostname.slice(0, -base.hostname.length - 1) : parts[1], path = app ? url.pathname.slice(1) : parts.slice(2).join('/');
      if ((app ? env.APP_HOSTS !== 'true' : url.origin !== env.PREVIEW_ORIGIN || url.search) || url.href.length > 4096 || /[%\\]/.test(url.pathname) || !uuidOK(id) ||
          !ctx.access || ctx.access.aud !== env.ACCESS_AUD || request.headers.has('Authorization') || request.headers.has('Upgrade') ||
          request.headers.get('Sec-Fetch-Dest') === 'serviceworker' ||
          /(?:^|;\s*)(?:__Host-golf_session|golf_session)=/.test(request.headers.get('Cookie') || '')) return denied();
      const identity = await ctx.access.getIdentity();
      if (!identity?.email || typeof identity.email !== 'string') return denied();
      if (path === '__golf/enter') {
        if (url.search || request.method !== 'GET' || !env.PUBLIC_ORIGIN || new URL(env.PUBLIC_ORIGIN).origin !== env.PUBLIC_ORIGIN || !env.PUBLIC_ORIGIN.startsWith('https://')) return denied();
        // Access finishes its login before Golf issues a one-time POST grant.
        return new Response(null, { status: 303, headers: { ...headers, Location: `${env.PUBLIC_ORIGIN}/?preview=${id}` } });
      }
      const cookieName = '__Host-golf_preview_' + id;
      const input = { previewId: id, email: identity.email, method: request.method, path, origin: request.headers.get('Origin') || '', app, url: request.url };
      if (path === '__golf/auth') {
        if (url.search || request.method !== 'POST' || !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded') || Number(request.headers.get('Content-Length') || 0) > 256) return denied();
        const reader = request.body?.getReader(); if (!reader) return denied();
        let size = 0, chunks = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; if ((size += value.length) > 256) { await reader.cancel(); return denied(); } chunks.push(value); }
        const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(data));
        if ([...form].length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(form.get('grant') || '')) return denied();
        input.grant = form.get('grant');
      } else {
        if (!(app ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD']).includes(request.method) || path.startsWith('__golf') || path.split('/').some(p => p === '..' || p === '.')) return denied();
        const cookies = (request.headers.get('Cookie') || '').split(';').map(v => v.trim().split('=')).filter(v => v[0] === cookieName);
        if (cookies.length !== 1 || cookies[0].length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(cookies[0][1])) return denied();
        input.credential = cookies[0][1];
        if (app) {
          if (request.method === 'POST' && input.origin !== url.origin || request.headers.has('Content-Encoding')) return denied();
          input.headers = { Accept: request.headers.get('Accept') || '', 'Content-Type': request.headers.get('Content-Type') || '' };
          if (request.method === 'POST') input.body = await bounded(request.body, 64 * 1024);
        }
      }
      const response = await env.FORGE.preview(input);
      if (input.grant) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(response.session) || !Number.isInteger(response.maxAge) || response.maxAge < 1 || response.maxAge > 300) return denied();
        return new Response(null, { status: 303, headers: { ...headers, Location: app ? '/' : `/${id}/`,
          'Set-Cookie': `${cookieName}=${response.session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${response.maxAge}` } });
      }
      if (app !== Boolean(response.app)) return denied();
      const outgoing = { ...headers, 'Content-Type': response.contentType, 'X-Golf-Commit': response.commitId };
      if (app) outgoing['Content-Security-Policy'] = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; worker-src 'none'";
      return new Response(response.content, { status: response.status || 200, headers: outgoing });
    } catch { return denied(); }
  },
};
