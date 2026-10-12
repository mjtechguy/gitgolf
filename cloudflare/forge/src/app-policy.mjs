import { agentPathOK } from './agent-policy.mjs';
import { digest } from './common.mjs';

export function appPolicy(env) {
  try {
    const p = JSON.parse(env.APP_POLICY || 'null');
    const preview = new URL(env.PREVIEW_ORIGIN);
    if (!p || Object.keys(p).some(k => !['namespace', 'entry', 'migration', 'ttl', 'zone', 'gateway', 'outbound', 'secret'].includes(k)) ||
        ![p.namespace, p.gateway, p.outbound].every(n => typeof n === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)) ||
        !agentPathOK(p.entry) || !p.entry.endsWith('.mjs') || !agentPathOK(p.migration) || !p.migration.endsWith('.sql') ||
        !/^[a-f0-9]{32}$/.test(p.zone) || !Number.isInteger(p.ttl) || p.ttl < 60 || p.ttl > 14400 ||
        !env.APP_PROVISIONER?.get || !env.APP_DISPATCH?.get || !env.PREVIEW_ACCESS_AUD || preview.origin !== env.PREVIEW_ORIGIN ||
        preview.protocol !== 'https:' || preview.port || preview.username || preview.password || preview.origin === env.PUBLIC_ORIGIN) return null;
    if (p.secret && (Object.keys(p.secret).sort().join(',') !== 'name,store' || !/^[a-f0-9]{32}$/.test(p.secret.store) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(p.secret.name) || p.secret.name === env.APP_PROVISIONER_NAME)) return null;
    return p;
  } catch { return null; }
}

export const appOrigin = (env, id) => `https://${id}.${new URL(env.PREVIEW_ORIGIN).hostname}`;
export const appPolicyHash = env => digest(env.APP_POLICY);
