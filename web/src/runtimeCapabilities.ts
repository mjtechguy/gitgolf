export type RuntimeCapability = { id: string; state: number | string; reason: string };
export type RuntimeManifest = { runtimeProfile: string; capabilities: RuntimeCapability[] };
const profiles: Record<string, string> = { portable: 'Portable', local: 'Local', docker: 'Docker', kubernetes: 'Kubernetes', 'cloudflare-bridge': 'Cloudflare with a portable origin', 'cloudflare-native': 'Cloudflare native' };
export const runtimeLabel = (profile?: string) => profiles[profile || ''] || 'Unreported runtime';
export function settingAvailable(manifest: RuntimeManifest | undefined, id: string) {
  return Boolean(manifest && Object.hasOwn(profiles, manifest.runtimeProfile) && manifest.capabilities.some(c => c.id === id && (c.state === 3 || c.state === 'CAPABILITY_STATE_READY')));
}
export function runtimeFeature(manifest: RuntimeManifest | undefined, id: string) {
  return Boolean(manifest && Object.hasOwn(profiles, manifest.runtimeProfile) && (manifest.runtimeProfile !== 'cloudflare-native' || settingAvailable(manifest, id)));
}
// Native email is usable while degraded: that state only says the provider has not yet accepted a first message, and someone has to subscribe before it can.
export function emailNotificationsMounted(manifest: RuntimeManifest | undefined) {
  if (manifest?.runtimeProfile !== 'cloudflare-native') return runtimeFeature(manifest, 'repository.email-notifications');
  return manifest.capabilities.some(c => c.id === 'repository.email-notifications' && [3, 4, 'CAPABILITY_STATE_READY', 'CAPABILITY_STATE_DEGRADED'].includes(c.state));
}
export function settingForRoute(kind: string, view?: string, native = false) {
  if (native) {
    const repositoryRoutes: Record<string, string> = { 'repository-settings': 'general', 'repository-access-settings': 'access', 'repository-git': 'git', 'repository-rules': 'rules', 'repository-secrets': 'secrets', 'repository-environments': 'environments', 'repository-webhooks': 'webhooks', 'repository-workflows': 'workflows', 'repository-deletion': 'lifecycle' };
    if (repositoryRoutes[kind]) return 'settings.repository-' + repositoryRoutes[kind];
    // The native runtime has no adapter for these account services; an id it never reports keeps their routes honest.
    const account: Record<string, string> = { 'account-connections': 'settings.provider-connections', 'account-agents': 'settings.account-agents', 'api-credentials': 'settings.api-credentials', audit: 'settings.account-activity', 'organization-labels': 'settings.organization-labels', 'organization-secrets': 'settings.organization-secrets' };
    if (account[kind]) return account[kind];
  }
  if (native && kind === 'instance-settings') {
    const nativeAdmin: Record<string, string> = { operations: 'operations.dashboard', execution: 'settings.execution', organizations: 'settings.organization-creation', agents: 'settings.agents-admin', runners: 'settings.native-runners', audit: 'settings.installation-audit', 'ai-models': 'settings.ai-models', 'ai-usage': 'operations.ai-usage' };
    if (view && nativeAdmin[view]) return nativeAdmin[view];
  }
  // Feature policies: native installations report this; the portable server does not yet.
  if (kind === 'instance-settings' && view === 'features') return 'settings.feature-policy';
  if (kind === 'instance-settings') return view === 'audit' ? 'settings.installation-audit' : view === 'infrastructure' ? 'settings.infrastructure' : view === 'runners' ? 'settings.runners' : view === 'notifications' ? 'settings.notifications' : view === 'accounts' || !view ? 'settings.local-auth' : null;
  if (kind === 'repository-runners') return 'settings.runners';
  if (['account-security', 'sessions', 'ssh-keys'].includes(kind)) return 'settings.local-auth';
  return null;
}
// Installation capability and repository feature policy combined: a feature a policy turned off (not one the operator never allocated) is unavailable here.
export type FeatureState = { feature: string; effective: boolean; decidedBy: number };
export function repositoryFeature(manifest: RuntimeManifest | undefined, features: FeatureState[] | undefined, id: string, capability?: string) {
  return !features?.some(f => f.feature === id && !f.effective && f.decidedBy !== 1) && (!capability || runtimeFeature(manifest, capability));
}
