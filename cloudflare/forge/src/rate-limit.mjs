import { publicReadRequest } from './public-repositories.mjs';

// Optional Workers rate limiting for the requests core admits without identity.
// The binding counts per Cloudflare location and is eventually consistent, so
// the configured number is an approximate throttle, never a quota or an audit.
const limitOK = value => Number.isInteger(value.limit) && value.limit >= 10 && value.limit <= 10000 && [10, 60].includes(value.period);
export function rateLimitBindings(settings) {
  const value = settings.anonymous_rate_limit;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['namespace', 'limit', 'period'].includes(key)) ||
      typeof value.namespace !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.namespace) || Number(value.namespace) > 2147483647 || !limitOK(value))
    throw Error('Anonymous rate limit needs a positive integer namespace, a limit of 10 to 10000 and a period of 10 or 60 seconds');
  return { ANONYMOUS_READS: { type: 'rate-limit', namespace: value.namespace, simple: { limit: value.limit, period: value.period } },
    ANONYMOUS_READ_LIMIT: { type: 'text', value: value.limit + '/' + value.period } };
}
// The binding does not report its own configuration; the text value mirrors it.
function installed(env) {
  const match = /^([1-9][0-9]{1,4})\/(10|60)$/.exec(env.ANONYMOUS_READ_LIMIT || '');
  const value = match && { limit: Number(match[1]), period: Number(match[2]) };
  return typeof env.ANONYMOUS_READS?.limit === 'function' && value && limitOK(value) ? value : null;
}
// Without public repositories nothing is admitted anonymously, so nothing is limited.
export const rateLimitPolicy = env => env.PUBLIC_REPOSITORIES === 'true' ? installed(env) : null;
// One counter per IPv4 address or IPv6 /64, which a single client can otherwise rotate through.
export function clientKey(address) {
  if (!address) return 'unknown';
  if (!address.includes(':')) return address;
  const [head, tail = ''] = address.toLowerCase().split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].slice(0, 4).join(':') + '::/64';
}
// access is the verified Access context. A presented credential is never
// counted, valid or not: the workspace authenticates it, as it does today.
export async function anonymousLimit(request, env, access) {
  const policy = rateLimitPolicy(env);
  if (!policy || access || request.headers.has('Authorization') || !publicReadRequest(request)) return null;
  try { if ((await env.ANONYMOUS_READS.limit({ key: clientKey(request.headers.get('CF-Connecting-IP')) })).success !== false) return null; }
  // An unavailable limiter must not take public reading down with it.
  catch { console.log(JSON.stringify({ event: 'golf.rate_limit_unavailable' })); return null; }
  const message = `Too many anonymous requests from this network. Retry after ${policy.period} seconds; signed-in and credentialed requests are not limited.`;
  const git = new URL(request.url).pathname.startsWith('/git/');
  return new Response(git ? message + '\n' : JSON.stringify({ code: 'resource_exhausted', message }), { status: 429, headers: {
    'Content-Type': git ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(policy.period), 'X-Content-Type-Options': 'nosniff',
    // Names this refusal apart from a busy workspace; public.mjs keeps it out of the workspace performance history.
    'X-Golf-Rate-Limited': 'anonymous' } });
}
export function rateLimitService(env) {
  const policy = rateLimitPolicy(env);
  return { id: 'rate-limit', label: 'Rate limiting · anonymous public reads', state: policy ? 'configured' : 'disabled', source: 'Installed binding / policy',
    detail: policy ? `About ${policy.limit} anonymous public read or clone requests per ${policy.period} seconds for each client network at each Cloudflare location. Counts are approximate and are not shared between locations. Signed-in, credentialed and runner requests are never counted. Refusals are not recorded here.`
      : env.PUBLIC_REPOSITORIES === 'true' ? 'No anonymous request limit is installed. Public reads and clones are not throttled per client.'
      : (installed(env) ? 'A limit is installed, but public' : 'Public') + ' repositories are not enabled, so there are no anonymous reads to limit.' };
}
