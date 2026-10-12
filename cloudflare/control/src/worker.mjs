// The bridge owns application authority until each native consumer qualifies.
const apiRoots = ['/rpc', '/api', '/auth', '/hooks', '/internal', '/notifications', '/healthz', '/readyz'];
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function validOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === value && !u.port && u.hostname.length <= 253 &&
      u.hostname.includes('.') && u.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

export function dynamicPath(path) {
  return apiRoots.some(root => path === root || path.startsWith(root + '/')) ||
    /^\/git\/[^/]+\/[^/]+\.git(?:\/|$)/.test(path) ||
    /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(path);
}

function failure(status) {
  return new Response('Golf unavailable', { status, headers: {
    ...security, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  } });
}

export async function handle(request, env, upstream = fetch) {
  if (!validOrigin(env.GOLF_PUBLIC_ORIGIN) || !validOrigin(env.GOLF_BRIDGE_ORIGIN) ||
      env.GOLF_PUBLIC_ORIGIN === env.GOLF_BRIDGE_ORIGIN ||
      !env.GOLF_ACCESS_CLIENT_ID || !env.GOLF_ACCESS_CLIENT_SECRET) return failure(503);
  const url = new URL(request.url);
  if (url.origin !== env.GOLF_PUBLIC_ORIGIN) return failure(404);
  if (/%(?:2f|5c|00)/i.test(url.pathname) || url.pathname.includes('\\')) return failure(400);
  if (request.headers.has('upgrade')) return failure(400);
  try {
    if (!dynamicPath(url.pathname)) {
      if (!['GET', 'HEAD'].includes(request.method)) return failure(405);
      // Frontend assets are public; never send session or API credentials to assets.
      const assetHeaders = new Headers();
      for (const name of ['accept', 'if-none-match', 'if-modified-since']) {
        if (request.headers.has(name)) assetHeaders.set(name, request.headers.get(name));
      }
      let response = await env.ASSETS.fetch(new Request(url, { method: request.method, headers: assetHeaders }));
      if (response.status === 404 && (url.pathname === '/' || (request.headers.get('accept') || '').includes('text/html'))) {
        response = await env.ASSETS.fetch(new Request(url.origin + '/index.html', { method: request.method }));
      }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(security)) headers.set(key, value);
      headers.set('Cache-Control', /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(url.pathname) && response.ok
        ? 'public, max-age=31536000, immutable' : 'no-cache');
      return new Response(response.body, { status: response.status, headers });
    }

    const headers = new Headers(request.headers);
    // The caller's Golf Authorization and Origin remain unchanged. Access is
    // transport authentication only and must never become a Golf identity.
    for (const key of [...headers.keys()]) {
      if (key.startsWith('cf-') || key.startsWith('x-forwarded-') ||
          ['forwarded', 'host', 'connection', 'proxy-authorization'].includes(key)) headers.delete(key);
    }
    const cookies = (headers.get('cookie') || '').split(';').filter(cookie =>
      !/^(?:CF_Authorization|CF_AppSession|CF_Binding)=/i.test(cookie.trim())).join(';');
    if (cookies.trim()) headers.set('cookie', cookies); else headers.delete('cookie');
    headers.set('CF-Access-Client-Id', env.GOLF_ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', env.GOLF_ACCESS_CLIENT_SECRET);
    const target = env.GOLF_BRIDGE_ORIGIN + url.pathname + url.search;
    const response = await upstream(target, {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', signal: request.signal, duplex: 'half',
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const outgoing = new Headers(response.headers);
    // Transport sessions cannot be stored on the public control hostname.
    outgoing.delete('set-cookie');
    const setCookies = typeof response.headers.getAll === 'function'
      ? response.headers.getAll('Set-Cookie') : response.headers.getSetCookie();
    for (const cookie of setCookies) {
      if (!/^(?:CF_Authorization|CF_AppSession|CF_Binding)=/i.test(cookie)) outgoing.append('set-cookie', cookie);
    }
    for (const key of [...outgoing.keys()]) if (key.startsWith('cf-access-')) outgoing.delete(key);
    const location = outgoing.get('location');
    if (location) {
      const redirect = new URL(location, target);
      // An Access login means the service credential/configuration failed.
      if (redirect.hostname.endsWith('.cloudflareaccess.com')) return failure(502);
      if (redirect.origin === env.GOLF_BRIDGE_ORIGIN) {
        outgoing.set('location', env.GOLF_PUBLIC_ORIGIN + redirect.pathname + redirect.search + redirect.hash);
      }
    }
    outgoing.set('Cache-Control', 'no-store');
    outgoing.set('CDN-Cache-Control', 'no-store');
    outgoing.set('Cloudflare-CDN-Cache-Control', 'no-store');
    // Preserve origin security headers, including the preview form's strict-origin policy.
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
  } catch { return failure(502); }
}

export default { fetch(request, env) { return handle(request, env); } };
