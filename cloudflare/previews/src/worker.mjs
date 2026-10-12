const cookieName = '__Host-golf_preview';
const denied = () => new Response('Protected preview unavailable', { status: 404, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });

function cookie(request) {
  const values = (request.headers.get('Cookie') || '').split(';').map(v => v.trim().split('='));
  if (values.some(([name]) => name === '__Host-golf_session' || name === 'golf_session')) throw new Error('Control cookie');
  const matches = values.filter(([name]) => name === cookieName);
  if (matches.length !== 1 || matches[0].length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(matches[0][1])) throw new Error('Preview credential');
  return matches[0][1];
}

async function broker(env, input) {
  const response = await fetch(`${env.GOLF_ORIGIN}/internal/cloudflare/preview`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${env.GOLF_BROKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (response.status !== 200 && response.status !== 303) { await response.body?.cancel(); throw new Error('Authority unavailable'); }
  return response;
}

async function artifactObject(env) {
  const object = await env.PREVIEW_R2.get(`qualification/${env.ARCHIVE_SHA256}`);
  if (!object || object.size > 16 * 1024 * 1024) throw new Error('Artifact unavailable');
  const data = await object.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (digest !== env.ARCHIVE_SHA256) throw new Error('Artifact changed');
  return object;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if ((request.headers.get('Cookie') || '').split(';').some(v => ['__Host-golf_session', 'golf_session'].includes(v.trim().split('=')[0]))) return denied();
      if (url.origin !== env.PREVIEW_ORIGIN || url.search || url.pathname.includes('%') || url.pathname.startsWith('//') || request.headers.get('Sec-Fetch-Dest') === 'serviceworker' || !ctx.access || ctx.access.aud !== env.ACCESS_AUD) return denied();
      // The runtime supplies authenticated Access context. A caller's JWT header
      // or cookie alone never establishes this context.
      if (url.pathname === '/__golf/health') {
        if (request.method !== 'GET' || request.headers.get('Authorization') !== `Bearer ${env.GOLF_BROKER_SECRET}`) return denied();
        const row = await env.PREVIEW_DB.prepare('SELECT 1 AS ok').first();
        const object = await artifactObject(env);
        if (row?.ok !== 1) return denied();
        return Response.json({ fingerprint: env.TARGET_FINGERPRINT, archive: env.ARCHIVE_SHA256, commit: env.COMMIT_ID, d1: env.D1_ID, r2: env.R2_BUCKET }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.headers.has('Authorization')) return denied();
      const identity = await ctx.access.getIdentity();
      if (typeof identity?.email !== 'string' || !identity.email || identity.email.length > 254) return denied();
      if (url.pathname === '/__golf/enter') {
        if (request.method !== 'GET') return denied();
        return new Response(null, { status: 303, headers: { Location: `${env.GOLF_ORIGIN}/api/deployments/${env.DEPLOYMENT_ID}/resume`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      let input = { method: request.method, path: url.pathname, email: identity.email, origin: request.headers.get('Origin') || '', credential: '', grant: '' };
      if (url.pathname === '/__golf/auth') {
        if (request.method !== 'POST' || input.origin !== env.GOLF_ORIGIN || !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return denied();
        if (Number(request.headers.get('Content-Length') || 0) > 256) return denied();
        const reader = request.body?.getReader(); if (!reader) return denied();
        let size = 0; const chunks = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256) { await reader.cancel(); return denied(); } chunks.push(value); }
        const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        const values = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if ([...values].length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values.get('grant') || '')) return denied();
        input.grant = values.get('grant');
      } else {
        if (!['GET', 'HEAD'].includes(request.method) || url.pathname.startsWith('/__golf')) return denied();
        input.credential = cookie(request);
      }
      if (url.pathname === '/api/storage') {
        // Buffer the small result and repeat current authorization after binding
        // reads; a slow storage request cannot outlive a revoked reviewer grant.
        input = { ...input, method: 'HEAD', path: '/' };
        const first = await broker(env, input); await first.body?.cancel();
        const row = await env.PREVIEW_DB.prepare('SELECT 1 AS ok').first();
        const object = await artifactObject(env);
        if (row?.ok !== 1) return denied();
        const last = await broker(env, input); await last.body?.cancel();
        return Response.json({ database: 'ready', artifact: env.ARCHIVE_SHA256, objectBytes: object.size }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const response = await broker(env, input);
      const headers = new Headers(response.headers);
      if (response.status === 303 && headers.get('Location') !== '/') { await response.body?.cancel(); return denied(); }
      headers.delete('Server'); headers.delete('Via');
      return new Response(response.body, { status: response.status, headers });
    } catch { return denied(); }
  },
};
