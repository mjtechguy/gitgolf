const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const encoder = new TextEncoder();

function reply(body, status) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function authorized(request, secret) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (!tokenPattern.test(token)) return false;
  const [expected, actual] = await Promise.all([secret, token].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(expected), right = new Uint8Array(actual);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function probe(operation) {
  let timer;
  try {
    // Binding RPCs have no AbortSignal interface. Bound the response wait; these
    // read-only calls may finish after the deadline and cannot create resources.
    return await Promise.race([
      operation(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'timeout' }), 5000); }),
    ]);
  } catch {
    return { state: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    if (!tokenPattern.test(env.GOLF_PROBE_TOKEN || '')) return reply({ state: 'unconfigured' }, 503);
    if (!(await authorized(request, env.GOLF_PROBE_TOKEN))) return reply({ state: 'denied' }, 401);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      return reply({ state: 'https_required' }, 400);
    }
    if (url.pathname !== '/inspect' || url.search) return reply({ state: 'not_found' }, 404);
    if (request.method !== 'GET') {
      const response = reply({ state: 'method_not_allowed' }, 405);
      response.headers.set('Allow', 'GET');
      return response;
    }

    const [r2, artifacts] = await Promise.all([
      probe(async () => {
        if (!env.EVIDENCE || !env.GOLF_PROBE_OBJECT_KEY) return { state: 'unconfigured' };
        const object = await env.EVIDENCE.head(env.GOLF_PROBE_OBJECT_KEY);
        if (object === null) return { state: 'not_found' };
        if (!object || !Number.isSafeInteger(object.size) || object.size < 0) return { state: 'invalid_response' };
        return { state: 'accessible' };
      }),
      probe(async () => {
        if (!env.ARTIFACTS) return { state: 'unconfigured' };
        const page = await env.ARTIFACTS.list({ limit: 1 });
        if (!page || !Array.isArray(page.repos) || page.repos.length > 1) return { state: 'invalid_response' };
        return { state: 'accessible' };
      }),
    ]);
    const observations = [
      { service: 'r2', scope: 'configured_object_metadata_only', ...r2 },
      { service: 'artifacts', scope: 'bound_namespace_repository_page_only', ...artifacts },
    ];
    return reply({ schema_version: 'golf.cloudflare.binding-inspection.v1', observations },
      observations.every(o => o.state === 'accessible') ? 200 : 503);
  },
};
