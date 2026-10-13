import { createRemoteJWKSet, jwtVerify, errors } from '../../agents/node_modules/jose/dist/webapi/index.js';

const teamDomain = value => typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(value);
let keys;
export function accessBindings(settings) {
  if (settings.public_repositories !== undefined && typeof settings.public_repositories !== 'boolean') throw Error('Public repositories require an explicit boolean');
  if (settings.public_repositories && !settings.access_team_domain) throw Error('Public repositories require a configured Access issuer');
  if (settings.access_team_domain === undefined) return {};
  if (!teamDomain(settings.access_team_domain) || !settings.access_aud) throw Error('Use the configured Access team origin and audience');
  return { PUBLIC_REPOSITORIES: { type: 'text', value: String(settings.public_repositories === true) }, ACCESS_TEAM_DOMAIN: { type: 'text', value: settings.access_team_domain } };
}

export async function accessContext(request, env, ctx, keySet) {
  if (ctx.access) return ctx.access.aud === env.ACCESS_AUD ? ctx.access : null;
  // Some authenticated edge requests omit ctx.access; verify the signed assertion instead.
  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  // Public sites enter through a path-scoped Access login. Other paths verify
  // that application's signed cookie, with the same issuer/audience/expiry.
  if (!token && env.PUBLIC_REPOSITORIES === 'true') {
    const cookies = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith('CF_Authorization='));
    if (cookies.length === 1) token = cookies[0].slice('CF_Authorization='.length);
  }
  if (!env.ACCESS_AUD || !teamDomain(env.ACCESS_TEAM_DOMAIN) || !token || token.length > 16384) return null;
  if (!keySet) {
    if (keys?.issuer !== env.ACCESS_TEAM_DOMAIN) keys = { issuer: env.ACCESS_TEAM_DOMAIN,
      resolve: createRemoteJWKSet(new URL(env.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs'), { timeoutDuration: 5000, cacheMaxAge: 600000, cooldownDuration: 30000 }) };
    keySet = keys.resolve;
  }
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD,
      algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] });
    return { aud: env.ACCESS_AUD, getIdentity: async () => ({ email: payload.type === 'app' && typeof payload.email === 'string' ? payload.email : undefined }) };
  } catch (error) {
    if ([errors.JWTExpired, errors.JWTClaimValidationFailed, errors.JWTInvalid, errors.JWSInvalid, errors.JWSSignatureVerificationFailed, errors.JOSEAlgNotAllowed, errors.JOSENotSupported, errors.JWKSNoMatchingKey].some(type => error instanceof type)) return null;
    // Key-service outages are availability failures, not sign-outs.
    throw error;
  }
}
